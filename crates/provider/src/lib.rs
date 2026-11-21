//! Model CLIs, such as Claude Code and Codex: how to start each, give it a prompt and read its
//! reply, with every tool turned off.

mod agent;

use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{Mutex, mpsc};
use workshop_common::process::{self, GroupedChild};
use workshop_common::template::{self, Vars};

pub use agent::{AgentConfig, AgentOutput};

/// A model CLI: how to start it, how to give it a prompt and how to read its reply.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderConfig {
    /// Placeholders: `{model}`, `{system_prompt}`, and `{prompt}` when `input = "argument"`.
    pub command: Vec<String>,
    pub input: InputMode,
    pub output: OutputMode,
    /// Start the next process before it is needed, hiding CLI start-up time. Requires the
    /// prompt to be sent on stdin.
    #[serde(default)]
    pub prespawn: bool,
    #[serde(default)]
    pub version_command: Option<Vec<String>>,
    /// Exits successfully only if the CLI is logged in.
    #[serde(default)]
    pub auth_check_command: Option<Vec<String>>,
    #[serde(default)]
    pub install_hint: Option<String>,
    /// Prints the CLI's model catalog as JSON (`{"models": [{"slug": …}]}`), so a family name
    /// such as "luna" can be resolved to the newest model in that family.
    #[serde(default)]
    pub model_catalog: Option<Vec<String>>,
    /// Shown when choosing a provider in the app.
    #[serde(default)]
    pub name: Option<String>,
    /// Models offered in the app for editing and for discussion, best first.
    #[serde(default)]
    pub edit_models: Vec<String>,
    #[serde(default)]
    pub discuss_models: Vec<String>,
    /// Fills an `{effort}` placeholder: how hard the model thinks for each kind of request.
    #[serde(default)]
    pub effort: Option<Effort>,
    /// How to run it as an agent with tools confined to one directory, for the author, the only
    /// role that has tools.
    #[serde(default)]
    pub agent: Option<AgentConfig>,
    /// Files written into the directory the CLI runs in, for CLIs that read instructions or
    /// settings from there. With any, each call runs in a fresh directory of its own, removed
    /// when the call ends, as calls can run at once with different system prompts.
    #[serde(default)]
    pub files: Vec<CallFile>,
}

/// A file written into a call's directory.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CallFile {
    /// Relative to the call's directory, such as `.agents/hooks.json`, and staying inside it.
    pub path: String,
    /// Placeholders: `{model}`, `{system_prompt}` and `{effort}`. `{{` and `}}` are literal
    /// braces.
    pub contents: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Effort {
    pub edit: String,
    pub discuss: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Edit,
    Discuss,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum InputMode {
    /// The prompt is substituted into the `{prompt}` placeholder.
    Argument,
    /// The prompt is written to stdin, which is then closed.
    Stdin,
    /// One Claude Code `stream-json` user message is written to stdin.
    ClaudeStreamJson,
    /// An Ollama `/api/chat` request body is written to stdin, for a command such as `curl`.
    OllamaChat,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum OutputMode {
    /// The whole of stdout is the reply.
    Text,
    /// Claude Code `--output-format json`.
    ClaudeJson,
    /// Claude Code `--output-format stream-json`.
    ClaudeStreamJson,
    /// Codex `exec --json`. Codex can't run without tools, so the process is stopped, and the
    /// call fails, as soon as it starts using one.
    CodexJson,
    /// An Ollama `/api/chat` response.
    OllamaChat,
    /// Antigravity `--output-format json`.
    AntigravityJson,
}

const BUILTIN: &[(&str, &str)] = &[
    ("claude", include_str!("../providers/claude.toml")),
    ("codex", include_str!("../providers/codex.toml")),
    ("antigravity", include_str!("../providers/antigravity.toml")),
];

pub fn builtin_providers() -> Result<Vec<(String, ProviderConfig)>> {
    BUILTIN
        .iter()
        .map(|(id, source)| {
            let provider: ProviderConfig = toml::from_str(source)
                .with_context(|| format!("parsing built-in provider {id}"))?;
            provider
                .validate()
                .with_context(|| format!("built-in provider {id}"))?;
            Ok(((*id).to_owned(), provider))
        })
        .collect()
}

impl ProviderConfig {
    /// A provider with just a command and how to talk to it, such as a stand-in for tests.
    pub fn with_command(command: Vec<String>, input: InputMode, output: OutputMode) -> Self {
        Self {
            command,
            input,
            output,
            prespawn: false,
            version_command: None,
            auth_check_command: None,
            install_hint: None,
            model_catalog: None,
            name: None,
            edit_models: Vec::new(),
            discuss_models: Vec::new(),
            effort: None,
            agent: None,
            files: Vec::new(),
        }
    }

    pub fn spec(&self, role: Role, model: &str, system_prompt: String) -> CallSpec {
        CallSpec {
            model: model.to_owned(),
            system_prompt,
            effort: self.effort.as_ref().map(|e| match role {
                Role::Edit => e.edit.clone(),
                Role::Discuss => e.discuss.clone(),
            }),
        }
    }

    pub fn display_name<'a>(&'a self, id: &'a str) -> &'a str {
        self.name.as_deref().unwrap_or(id)
    }

    pub fn validate(&self) -> Result<()> {
        if self.command.is_empty() {
            bail!("`command` must not be empty");
        }
        if let Some(agent) = &self.agent {
            agent.validate()?;
            if agent.command.iter().any(|arg| arg.contains("{effort")) && self.effort.is_none() {
                bail!("the agent's `command` uses {{effort}}, so `effort` needs setting");
            }
        }
        if self.command.iter().any(|arg| arg.contains("{effort")) && self.effort.is_none() {
            bail!("`command` uses {{effort}}, so `effort` needs setting for edit and discuss");
        }
        self.validate_files()?;
        let mentions_prompt = self.command.iter().any(|arg| arg.contains("{prompt}"));
        match self.input {
            InputMode::Argument if !mentions_prompt => {
                bail!("`input = \"argument\"` needs a {{prompt}} placeholder in `command`")
            }
            InputMode::Argument if self.prespawn => {
                bail!(
                    "`prespawn` needs the prompt on stdin, so it can't be used with `input = \"argument\"`"
                )
            }
            InputMode::Stdin | InputMode::ClaudeStreamJson | InputMode::OllamaChat
                if mentions_prompt =>
            {
                bail!("{{prompt}} is only available with `input = \"argument\"`")
            }
            _ => Ok(()),
        }
    }

    fn validate_files(&self) -> Result<()> {
        if !self.files.is_empty() && self.prespawn {
            bail!(
                "`prespawn` can't be used with `files`, as each call's files are written when it starts"
            );
        }
        // Rendered with stand-in values, so an unknown placeholder fails when the config is read.
        let stand_in = CallSpec {
            model: String::new(),
            system_prompt: String::new(),
            effort: self.effort.as_ref().map(|e| e.edit.clone()),
        };
        let vars = call_vars(&stand_in);
        // Each file's path as its components, ignoring case, as some file systems do.
        let mut paths: Vec<(&str, Vec<String>)> = Vec::new();
        for file in &self.files {
            let path = Path::new(&file.path);
            let inside = path.components().next().is_some()
                && path.components().all(|c| matches!(c, Component::Normal(_)));
            if !inside {
                bail!(
                    "the file {:?} must be a relative path inside the call's directory, such as \".agents/hooks.json\", with no `..`",
                    file.path
                );
            }
            if file.path.ends_with('/') || file.path.ends_with('\\') {
                bail!("the file {:?} must not end in a slash", file.path);
            }
            let components: Vec<String> = path
                .components()
                .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
                .collect();
            for (other, theirs) in &paths {
                if *theirs == components {
                    bail!(
                        "the files {other:?} and {:?} are the same file, ignoring case",
                        file.path
                    );
                }
                if theirs.starts_with(&components) || components.starts_with(theirs) {
                    bail!(
                        "the files {other:?} and {:?} can't both be written, as one would be the other's directory",
                        file.path
                    );
                }
            }
            paths.push((&file.path, components));
            template::render(&file.contents, &vars)
                .with_context(|| format!("in the contents of {:?}", file.path))?;
        }
        Ok(())
    }
}

/// The placeholders that describe a call, for its command and its files.
fn call_vars(spec: &CallSpec) -> Vars<'static> {
    let vars = Vars::new()
        .set("model", spec.model.clone())
        .set("system_prompt", spec.system_prompt.clone());
    match &spec.effort {
        Some(effort) => vars.set("effort", effort.clone()),
        None => vars,
    }
}

/// A directory of one call's own, holding the provider's files, and removed when it's dropped,
/// so also when the call fails, times out or is cancelled.
struct CallDir {
    path: PathBuf,
}

impl CallDir {
    fn create(working_dir: &Path, files: &[CallFile], spec: &CallSpec) -> Result<Self> {
        let dir = Self {
            path: tempfile::Builder::new()
                .prefix("call-")
                .tempdir_in(working_dir)
                .with_context(|| format!("creating a directory in {}", working_dir.display()))?
                .keep(),
        };
        let vars = call_vars(spec);
        for file in files {
            let path = dir.path.join(&file.path);
            let contents = template::render(&file.contents, &vars)
                .with_context(|| format!("in the contents of {:?}", file.path))?;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("creating {}", parent.display()))?;
            }
            std::fs::write(&path, contents)
                .with_context(|| format!("writing {}", path.display()))?;
        }
        Ok(dir)
    }
}

impl Drop for CallDir {
    fn drop(&mut self) {
        if let Err(err) = std::fs::remove_dir_all(&self.path) {
            tracing::warn!("couldn't remove {}: {err}", self.path.display());
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallSpec {
    pub model: String,
    pub system_prompt: String,
    pub effort: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Reply {
    pub text: String,
    /// The concrete model that answered, when the CLI reports it.
    pub model: Option<String>,
    pub elapsed_ms: u64,
}

struct Spare {
    spec: CallSpec,
    process: GroupedChild,
}

/// Runs one provider, keeping a pre-started process ready when the provider supports it.
/// Whether a call uses the process kept ready for the next call, and readies another.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Spares {
    Use,
    Leave,
}

pub struct ProviderRunner {
    provider: ProviderConfig,
    working_dir: PathBuf,
    spare: Mutex<Option<Spare>>,
    /// Family names already resolved to concrete models.
    resolved: Mutex<std::collections::HashMap<String, String>>,
}

impl ProviderRunner {
    /// `working_dir` should be an empty directory so the CLI doesn't pick up project files.
    pub fn new(provider: ProviderConfig, working_dir: PathBuf) -> Result<Self> {
        provider.validate()?;
        Ok(Self {
            provider,
            working_dir,
            spare: Mutex::new(None),
            resolved: Mutex::new(std::collections::HashMap::new()),
        })
    }

    /// Writes the system prompt to a file, for CLIs that read their instructions from one. The
    /// name is derived from the contents, so concurrent calls never see a half-written file.
    fn system_prompt_file(&self, spec: &CallSpec) -> Result<String> {
        let name = format!(
            "system-prompt-{}.md",
            workshop_common::files::version_of(&spec.system_prompt)
        );
        let path = self.working_dir.join(name);
        if !path.exists() {
            workshop_common::files::write_atomic(&path, spec.system_prompt.as_bytes())?;
        }
        Ok(path.to_string_lossy().into_owned())
    }

    fn ensure_working_dir(&self) -> Result<()> {
        std::fs::create_dir_all(&self.working_dir)
            .with_context(|| format!("creating {}", self.working_dir.display()))
    }

    /// Resolves a model family name, such as "luna", to the newest model in that family.
    async fn resolve(&self, spec: &CallSpec) -> CallSpec {
        let Some(command) = &self.provider.model_catalog else {
            return spec.clone();
        };
        let mut resolved = self.resolved.lock().await;
        if let Some(model) = resolved.get(&spec.model) {
            return CallSpec {
                model: model.clone(),
                ..spec.clone()
            };
        }
        let model = match self.catalog(command).await {
            Ok(slugs) => {
                newest_in_family(&slugs, &spec.model).unwrap_or_else(|| spec.model.clone())
            }
            Err(err) => {
                tracing::warn!("couldn't list models to resolve {:?}: {err:#}", spec.model);
                return spec.clone();
            }
        };
        if model != spec.model {
            tracing::info!("using {model} for {:?}", spec.model);
        }
        resolved.insert(spec.model.clone(), model.clone());
        CallSpec {
            model,
            ..spec.clone()
        }
    }

    async fn catalog(&self, command: &[String]) -> Result<Vec<String>> {
        let (program, args) = command
            .split_first()
            .context("empty model catalog command")?;
        self.ensure_working_dir()?;
        let output = tokio::time::timeout(
            Duration::from_secs(30),
            process::command(program)
                .args(args)
                .current_dir(&self.working_dir)
                .stdin(Stdio::null())
                .output(),
        )
        .await
        .context("listing models timed out")??;
        if !output.status.success() {
            bail!("`{}` failed", command.join(" "));
        }
        parse_model_catalog(&String::from_utf8_lossy(&output.stdout))
    }

    /// The call with its model resolved, as a family name such as "sol" is to the newest model in
    /// the family, for running the model some other way, such as as an agent.
    pub async fn resolved(&self, spec: &CallSpec) -> CallSpec {
        self.resolve(spec).await
    }

    /// Starts a process for `spec` so the next `call` with the same spec skips start-up.
    pub async fn warm(&self, spec: &CallSpec) -> Result<()> {
        if !self.provider.prespawn {
            return Ok(());
        }
        let spec = &self.resolve(spec).await;
        let mut spare = self.spare.lock().await;
        if let Some(existing) = spare.as_mut()
            && existing.spec == *spec
            && existing.process.child.try_wait()?.is_none()
        {
            return Ok(());
        }
        *spare = Some(Spare {
            spec: spec.clone(),
            process: self.spawn(spec, None, &self.working_dir)?,
        });
        Ok(())
    }

    pub async fn call(&self, spec: &CallSpec, prompt: &str, timeout: Duration) -> Result<Reply> {
        self.call_streaming(spec, prompt, timeout, None).await
    }

    /// Like `call`, also sending the reply's text to `partial` as it arrives, for providers
    /// whose output includes it. The whole reply is still returned at the end.
    pub async fn call_streaming(
        &self,
        spec: &CallSpec,
        prompt: &str,
        timeout: Duration,
        partial: Option<&mpsc::UnboundedSender<String>>,
    ) -> Result<Reply> {
        self.call_with(spec, prompt, timeout, partial, Spares::Use)
            .await
    }

    /// Like `call`, for an occasional request with its own instructions: it leaves the process
    /// kept ready for the usual ones alone, rather than replacing it with one for this.
    pub async fn call_aside(
        &self,
        spec: &CallSpec,
        prompt: &str,
        timeout: Duration,
    ) -> Result<Reply> {
        self.call_with(spec, prompt, timeout, None, Spares::Leave)
            .await
    }

    async fn call_with(
        &self,
        spec: &CallSpec,
        prompt: &str,
        timeout: Duration,
        partial: Option<&mpsc::UnboundedSender<String>>,
        spares: Spares,
    ) -> Result<Reply> {
        let started = std::time::Instant::now();
        let spec = &self.resolve(spec).await;
        // Declared before the process, so it's removed after the process is stopped.
        let call_dir = if self.provider.files.is_empty() {
            None
        } else {
            self.ensure_working_dir()?;
            Some(CallDir::create(
                &self.working_dir,
                &self.provider.files,
                spec,
            )?)
        };
        let spare = match spares {
            Spares::Use => self.take_spare(spec).await?,
            Spares::Leave => None,
        };
        let process = match spare {
            Some(process) => process,
            None => self.spawn(
                spec,
                Some(prompt),
                call_dir.as_ref().map_or(&self.working_dir, |dir| &dir.path),
            )?,
        };
        if self.provider.prespawn && spares == Spares::Use {
            // Failing to warm only costs latency on the next call, so it mustn't fail this one.
            if let Err(err) = self.warm(spec).await {
                tracing::warn!("could not start a spare model process: {err:#}");
            }
        }
        let result =
            tokio::time::timeout(timeout, self.communicate(process, spec, prompt, partial)).await;
        let (text, model) = match result {
            Ok(reply) => reply?,
            Err(_) => bail!("the model took longer than {}s to reply", timeout.as_secs()),
        };
        Ok(Reply {
            text,
            model: model.or_else(|| Some(spec.model.clone())),
            elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        })
    }

    async fn take_spare(&self, spec: &CallSpec) -> Result<Option<GroupedChild>> {
        let mut guard = self.spare.lock().await;
        let Some(mut spare) = guard.take() else {
            return Ok(None);
        };
        if spare.spec != *spec || spare.process.child.try_wait()?.is_some() {
            // Dropping the spare kills it.
            return Ok(None);
        }
        Ok(Some(spare.process))
    }

    fn spawn(&self, spec: &CallSpec, prompt: Option<&str>, dir: &Path) -> Result<GroupedChild> {
        self.ensure_working_dir()?;
        let mut vars = call_vars(spec);
        if self
            .provider
            .command
            .iter()
            .any(|arg| arg.contains("{system_prompt_file"))
        {
            vars = vars.set("system_prompt_file", self.system_prompt_file(spec)?);
        }
        if self.provider.input == InputMode::Argument {
            let prompt = prompt.context("argument input needs the prompt at spawn time")?;
            vars = vars.set("prompt", prompt);
        }
        let args = template::render_all(&self.provider.command, &vars)?;
        let (program, rest) = args.split_first().context("empty provider command")?;
        GroupedChild::spawn(
            process::command(program)
                .args(rest)
                .current_dir(dir)
                .stdin(match self.provider.input {
                    InputMode::Argument => Stdio::null(),
                    InputMode::Stdin | InputMode::ClaudeStreamJson | InputMode::OllamaChat => {
                        Stdio::piped()
                    }
                })
                .stdout(Stdio::piped())
                .stderr(Stdio::piped()),
        )
        .with_context(|| format!("starting `{program}`"))
    }

    async fn communicate(
        &self,
        mut process: GroupedChild,
        spec: &CallSpec,
        prompt: &str,
        partial: Option<&mpsc::UnboundedSender<String>>,
    ) -> Result<(String, Option<String>)> {
        let child = &mut process.child;
        if let Some(mut stdin) = child.stdin.take() {
            let payload = match self.provider.input {
                InputMode::Argument => String::new(),
                InputMode::Stdin => prompt.to_owned(),
                InputMode::ClaudeStreamJson => {
                    let message = serde_json::json!({
                        "type": "user",
                        "message": {"role": "user", "content": prompt},
                    });
                    format!("{message}\n")
                }
                // Deterministic, and constrained to JSON, which is what Workshop's prompts ask for.
                InputMode::OllamaChat => serde_json::json!({
                    "model": spec.model,
                    "messages": [
                        {"role": "system", "content": spec.system_prompt},
                        {"role": "user", "content": prompt},
                    ],
                    "stream": false,
                    "format": "json",
                    "options": {"temperature": 0},
                })
                .to_string(),
            };
            stdin.write_all(payload.as_bytes()).await?;
            stdin.shutdown().await?;
        }
        let stdout = child
            .stdout
            .take()
            .context("model stdout was not captured")?;
        let mut stderr = child
            .stderr
            .take()
            .context("model stderr was not captured")?;
        let stderr_task = tokio::spawn(async move {
            let mut buf = String::new();
            let _ = stderr.read_to_string(&mut buf).await;
            buf
        });

        let parsed = match self.provider.output {
            OutputMode::Text => {
                let mut out = String::new();
                BufReader::new(stdout).read_to_string(&mut out).await?;
                Ok((out.trim().to_owned(), None))
            }
            OutputMode::ClaudeJson => {
                let mut out = String::new();
                BufReader::new(stdout).read_to_string(&mut out).await?;
                parse_claude_result(&out)
            }
            OutputMode::ClaudeStreamJson => {
                let mut lines = BufReader::new(stdout).lines();
                let mut model = None;
                let mut reply = None;
                while let Some(line) = lines.next_line().await? {
                    match parse_stream_event(&line)? {
                        StreamEvent::Init { model: m } => model = m.or(model),
                        StreamEvent::Delta(text) => {
                            // Nobody listening any more only means the reply isn't shown early.
                            if let Some(partial) = partial {
                                let _ = partial.send(text);
                            }
                        }
                        StreamEvent::Text { text, model: m } => {
                            reply = Some(Ok((text, m.or(model.take()))));
                            break;
                        }
                        StreamEvent::Result(result) => {
                            reply = Some(result.map(|(text, m)| (text, m.or(model.take()))));
                            break;
                        }
                        StreamEvent::Other => {}
                    }
                }
                let reply = reply.map(|r| r.map_err(|e| anyhow::anyhow!(e)));
                match reply {
                    // The CLI does more work after the answer, such as summarising the turn,
                    // which only adds latency here, so it is stopped rather than awaited.
                    Some(Ok(reply)) => {
                        stderr_task.abort();
                        drop(process);
                        return Ok(reply);
                    }
                    Some(Err(err)) => Err(err),
                    None => Err(anyhow::anyhow!("model CLI exited without a result")),
                }
            }
            OutputMode::OllamaChat => {
                let mut out = String::new();
                BufReader::new(stdout).read_to_string(&mut out).await?;
                parse_ollama_reply(&out).map(|text| (text, Some(spec.model.clone())))
            }
            OutputMode::AntigravityJson => {
                let mut out = String::new();
                BufReader::new(stdout).read_to_string(&mut out).await?;
                parse_antigravity_result(&out).map(|text| (text, None))
            }
            OutputMode::CodexJson => {
                let mut lines = BufReader::new(stdout).lines();
                let mut outcome = None;
                while let Some(line) = lines.next_line().await? {
                    match parse_codex_event(&line)? {
                        CodexEvent::Message(text) => {
                            outcome = Some(Ok(text));
                            break;
                        }
                        CodexEvent::Tool(kind) => {
                            // Dropping the process kills it along with anything it started.
                            stderr_task.abort();
                            drop(process);
                            tracing::warn!("the model tried to use a tool ({kind}); stopped it");
                            bail!(
                                "the model tried to use a tool ({kind}), which Workshop doesn't allow, so it was stopped and nothing changed"
                            );
                        }
                        CodexEvent::Failed(message) => {
                            outcome = Some(Err(anyhow::anyhow!("the model failed: {message}")));
                            break;
                        }
                        CodexEvent::Notice(message) => {
                            tracing::debug!("codex: {message}");
                        }
                        CodexEvent::Other => {}
                    }
                }
                match outcome {
                    Some(Ok(text)) => {
                        stderr_task.abort();
                        drop(process);
                        return Ok((text, None));
                    }
                    Some(Err(err)) => Err(err),
                    None => Err(anyhow::anyhow!("model CLI exited without a reply")),
                }
            }
        };

        let status = child.wait().await?;
        process.finish();
        let stderr = stderr_task.await.unwrap_or_default();
        let Err(err) = parsed else {
            return parsed;
        };
        let program = &self.provider.command[0];
        let name = self.provider.name.as_deref().unwrap_or(program);
        if let Some(explained) = explain_failure(name, program, &format!("{err:#}\n{stderr}")) {
            return Err(anyhow::anyhow!(explained));
        }
        if status.success() {
            Err(err)
        } else {
            Err(err.context(format!("{name} exited with {status}: {}", stderr.trim())))
        }
    }
}

/// What went wrong with a model CLI, as what to do about it, for failures that can be
/// recognised from what it said.
fn explain_failure(name: &str, program: &str, said: &str) -> Option<String> {
    let lower = said.to_lowercase();
    let mentions = |words: &[&str]| words.iter().any(|w| lower.contains(w));
    let first_line = said
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_default();
    if mentions(&[
        "not logged in",
        "please run /login",
        "log in",
        "invalid api key",
        "authenticat",
        "unauthorized",
    ]) {
        return Some(format!(
            "{name} isn't logged in. On the server, run `{program}` and log in, then try again."
        ));
    }
    if mentions(&[
        "usage limit",
        "rate limit",
        "quota",
        "too many requests",
        "limit reached",
    ]) {
        return Some(format!(
            "{name} has reached its usage limit for now, so try again later, or choose another model in Settings. It said: {first_line}"
        ));
    }
    if mentions(&["overloaded", "529", "503 service unavailable"]) {
        return Some(format!("{name} is busy right now; try again in a moment."));
    }
    None
}

#[derive(Debug, PartialEq, Eq)]
enum CodexEvent {
    /// The model's reply.
    Message(String),
    /// The model started using a tool, which must stop the call.
    Tool(String),
    Failed(String),
    Notice(String),
    Other,
}

/// Item types that aren't tools. Anything else Codex reports starting is treated as a tool, so
/// new kinds of tool are refused rather than allowed by default.
const CODEX_SAFE_ITEMS: &[&str] = &["agent_message", "reasoning", "error"];

fn parse_codex_event(line: &str) -> Result<CodexEvent> {
    let event: serde_json::Value = serde_json::from_str(line)
        .with_context(|| format!("model CLI printed a line that isn't JSON: {line}"))?;
    let string =
        |v: Option<&serde_json::Value>| v.and_then(|v| v.as_str()).unwrap_or_default().to_owned();
    let kind = event
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or_default();
    Ok(match kind {
        "item.started" | "item.updated" | "item.completed" => {
            let item = event.get("item");
            let item_type = string(item.and_then(|i| i.get("type")));
            match item_type.as_str() {
                "agent_message" if kind == "item.completed" => {
                    CodexEvent::Message(string(item.and_then(|i| i.get("text"))))
                }
                "error" => CodexEvent::Notice(string(item.and_then(|i| i.get("message")))),
                t if CODEX_SAFE_ITEMS.contains(&t) => CodexEvent::Other,
                _ => CodexEvent::Tool(item_type),
            }
        }
        "turn.failed" => {
            CodexEvent::Failed(string(event.get("error").and_then(|e| e.get("message"))))
        }
        "error" => CodexEvent::Failed(string(event.get("message"))),
        _ => CodexEvent::Other,
    })
}

fn parse_ollama_reply(json: &str) -> Result<String> {
    let value: serde_json::Value = serde_json::from_str(json.trim())
        .with_context(|| format!("Ollama's reply isn't valid JSON: {json}"))?;
    if let Some(error) = value.get("error").and_then(|e| e.as_str()) {
        bail!("Ollama reported an error: {error}");
    }
    value
        .pointer("/message/content")
        .and_then(|c| c.as_str())
        .map(str::to_owned)
        .context("Ollama's reply has no message")
}

/// The reply in Antigravity's `--output-format json` result, or why the call failed.
fn parse_antigravity_result(json: &str) -> Result<String> {
    let value: serde_json::Value = serde_json::from_str(json.trim())
        .with_context(|| format!("model CLI output isn't valid JSON: {json}"))?;
    let string = |key: &str| value.get(key).and_then(|v| v.as_str());
    match string("status") {
        Some("SUCCESS") => string("response")
            .map(|text| text.trim().to_owned())
            .context("model CLI output has no `response`"),
        status => {
            let status = status.unwrap_or("no status");
            match string("error").filter(|e| !e.trim().is_empty()) {
                Some(error) => bail!("model CLI reported an error ({status}): {error}"),
                None => bail!("model CLI reported an error ({status})"),
            }
        }
    }
}

fn parse_model_catalog(json: &str) -> Result<Vec<String>> {
    let value: serde_json::Value =
        serde_json::from_str(json).context("the model catalog isn't valid JSON")?;
    let models = value
        .get("models")
        .and_then(|m| m.as_array())
        .context("the model catalog has no `models` list")?;
    Ok(models
        .iter()
        .filter(|m| m.get("visibility").and_then(|v| v.as_str()) != Some("hide"))
        .filter_map(|m| m.get("slug").and_then(|s| s.as_str()).map(str::to_owned))
        .collect())
}

/// The newest model whose name ends in `-{family}`, comparing the version numbers in the names,
/// or `family` itself if it's already a model's full name.
fn newest_in_family(slugs: &[String], family: &str) -> Option<String> {
    if slugs.iter().any(|s| s == family) {
        return Some(family.to_owned());
    }
    let suffix = format!("-{family}");
    let version = |slug: &str| -> Vec<u32> {
        slug.split(|c: char| !c.is_ascii_digit())
            .filter(|part| !part.is_empty())
            .filter_map(|part| part.parse().ok())
            .collect()
    };
    slugs
        .iter()
        .filter(|s| s.ends_with(&suffix))
        .max_by_key(|s| version(s))
        .cloned()
}

#[derive(Debug, PartialEq, Eq)]
enum StreamEvent {
    Init {
        model: Option<String>,
    },
    /// The model's complete answer. With tools disabled there is exactly one per turn.
    Text {
        text: String,
        model: Option<String>,
    },
    /// Part of the reply's text, as it's written.
    Delta(String),
    Result(Result<(String, Option<String>), String>),
    Other,
}

fn parse_stream_event(line: &str) -> Result<StreamEvent> {
    let event: serde_json::Value = serde_json::from_str(line)
        .with_context(|| format!("model CLI printed a line that isn't JSON: {line}"))?;
    let string = |v: Option<&serde_json::Value>| v.and_then(|v| v.as_str()).map(str::to_owned);
    Ok(match event.get("type").and_then(|t| t.as_str()) {
        Some("system") if event.get("subtype").and_then(|s| s.as_str()) == Some("init") => {
            StreamEvent::Init {
                model: string(event.get("model")),
            }
        }
        Some("assistant") => {
            let message = event.get("message");
            let model = string(message.and_then(|m| m.get("model")));
            let text: String = message
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
                .into_iter()
                .flatten()
                .filter(|block| block.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|block| block.get("text").and_then(|t| t.as_str()))
                .collect();
            if text.is_empty() {
                StreamEvent::Other
            } else if model.as_deref() == Some("<synthetic>") {
                // The CLI reports failures such as API errors as messages from a synthetic model.
                StreamEvent::Result(Err(text))
            } else {
                StreamEvent::Text { text, model }
            }
        }
        Some("result") => {
            StreamEvent::Result(parse_claude_result(line).map_err(|e| format!("{e:#}")))
        }
        Some("stream_event") => {
            let delta = event.get("event").and_then(|e| e.get("delta"));
            match delta {
                Some(delta) if delta.get("type").and_then(|t| t.as_str()) == Some("text_delta") => {
                    string(delta.get("text")).map_or(StreamEvent::Other, StreamEvent::Delta)
                }
                _ => StreamEvent::Other,
            }
        }
        _ => StreamEvent::Other,
    })
}

/// Parses a Claude Code `result` object, from either `json` output or the final `stream-json` line.
fn parse_claude_result(json: &str) -> Result<(String, Option<String>)> {
    let value: serde_json::Value =
        serde_json::from_str(json.trim()).context("model CLI output isn't valid JSON")?;
    let text = value
        .get("result")
        .and_then(|r| r.as_str())
        .unwrap_or_default()
        .to_owned();
    if value.get("is_error").and_then(|e| e.as_bool()) == Some(true) {
        bail!("model CLI reported an error: {text}");
    }
    let model = value
        .get("modelUsage")
        .and_then(|u| u.as_object())
        .and_then(|u| u.keys().next().cloned());
    Ok((text, model))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explains_common_failures() {
        let logged_out = explain_failure(
            "Claude Code",
            "claude",
            "Invalid API key · Please run /login",
        )
        .unwrap();
        assert!(
            logged_out.contains("run `claude` and log in"),
            "{logged_out}"
        );
        let limited = explain_failure(
            "Codex",
            "codex",
            "\nYou've hit your usage limit. Try again at 3pm.",
        )
        .unwrap();
        assert!(limited.contains("usage limit"), "{limited}");
        assert!(
            limited.ends_with("You've hit your usage limit. Try again at 3pm."),
            "{limited}"
        );
        assert_eq!(
            explain_failure("Codex", "codex", "segmentation fault"),
            None
        );
    }

    #[test]
    fn builtin_providers_are_valid() {
        let providers = builtin_providers().unwrap();
        let (_, claude) = providers.iter().find(|(id, _)| id == "claude").unwrap();
        assert!(claude.prespawn);
        assert!(
            claude
                .command
                .windows(2)
                .any(|w| w[0] == "--tools" && w[1].is_empty()),
            "the Claude preset must disable tools"
        );
    }

    fn builtin(id: &str) -> ProviderConfig {
        builtin_providers()
            .unwrap()
            .into_iter()
            .find(|(provider, _)| provider == id)
            .map(|(_, provider)| provider)
            .unwrap()
    }

    /// Runs Antigravity's preset with a stand-in for `agy` that copies the files in the
    /// directory it runs in to `copy`, and replies as `agy` does.
    #[cfg(unix)]
    #[tokio::test]
    async fn gives_antigravity_its_instructions_and_a_hook_refusing_every_tool() {
        let root = tempfile::tempdir().unwrap();
        let copy = root.path().join("copy");
        let script = root.path().join("fake-agy.sh");
        std::fs::write(
            &script,
            r#"copy=$1; shift
printf '%s\n' "$@" > args
cp -R . "$copy"
cat > "$copy/prompt"
printf '{"conversation_id":"c","status":"SUCCESS","response":"{\\"edits\\": []}\\n","num_turns":1}\n'
"#,
        )
        .unwrap();
        let mut provider = builtin("antigravity");
        assert!(provider.agent.is_none());
        assert_eq!(provider.input, InputMode::Stdin);
        assert!(!provider.prespawn);
        assert_eq!(provider.command[0], "agy");
        provider.command.splice(
            0..1,
            [
                "sh".to_owned(),
                script.to_string_lossy().into_owned(),
                copy.to_string_lossy().into_owned(),
            ],
        );
        let runner = ProviderRunner::new(provider, root.path().join("work")).unwrap();
        let spec = CallSpec {
            model: "gemini-4-neon-low".into(),
            system_prompt: "Reply with JSON {\"edits\": []}.".into(),
            effort: None,
        };
        let reply = runner
            .call(&spec, "Make no edits.", Duration::from_secs(10))
            .await
            .unwrap();
        assert_eq!(reply.text, "{\"edits\": []}");
        assert_eq!(reply.model.as_deref(), Some("gemini-4-neon-low"));
        let read = |name: &str| std::fs::read_to_string(copy.join(name)).unwrap();
        assert_eq!(read("prompt"), "Make no edits.");
        assert_eq!(read("AGENTS.md"), spec.system_prompt);
        let args: Vec<String> = read("args").lines().map(str::to_owned).collect();
        assert!(
            args.windows(2)
                .any(|w| w == ["--model", "gemini-4-neon-low"])
        );
        assert!(args.windows(2).any(|w| w == ["--output-format", "json"]));
        assert!(args.contains(&"--disable-slash-commands".to_owned()));
        assert!(!args.contains(&"-p".to_owned()));
        assert!(!args.contains(&"--dangerously-skip-permissions".to_owned()));

        // The hook matches every tool, and refuses it.
        let hooks: serde_json::Value = serde_json::from_str(&read(".agents/hooks.json")).unwrap();
        let groups = hooks["no-tools"]["PreToolUse"].as_array().unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0]["matcher"], "*");
        let hook = &groups[0]["hooks"][0];
        assert_eq!(hook["type"], "command");
        let output = std::process::Command::new("sh")
            .args(["-c", hook["command"].as_str().unwrap()])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(output.status.success());
        let decision: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(decision["decision"], "deny");
    }

    #[test]
    fn validation_catches_inconsistent_input() {
        let mut provider = ProviderConfig {
            prespawn: false,
            ..ProviderConfig::with_command(
                vec!["cli".into(), "{prompt}".into()],
                InputMode::Argument,
                OutputMode::Text,
            )
        };
        provider.validate().unwrap();
        provider.prespawn = true;
        assert!(provider.validate().is_err());
        provider.prespawn = false;
        provider.input = InputMode::Stdin;
        assert!(provider.validate().is_err());
        provider.command = vec!["cli".into()];
        provider.validate().unwrap();
        provider.input = InputMode::Argument;
        assert!(provider.validate().is_err());
    }

    #[test]
    fn validation_checks_call_files() {
        let with_files = |files: &[(&str, &str)]| ProviderConfig {
            files: files
                .iter()
                .map(|(path, contents)| CallFile {
                    path: (*path).to_owned(),
                    contents: (*contents).to_owned(),
                })
                .collect(),
            ..ProviderConfig::with_command(vec!["cli".into()], InputMode::Stdin, OutputMode::Text)
        };
        with_files(&[
            ("AGENTS.md", "{system_prompt}"),
            (".agents/hooks.json", "{{\"model\": \"{model}\"}}"),
        ])
        .validate()
        .unwrap();
        for path in [
            "",
            "/etc/hosts",
            "../AGENTS.md",
            "a/../../b",
            "a/..",
            "./AGENTS.md",
        ] {
            let err = with_files(&[(path, "")]).validate().unwrap_err();
            assert!(err.to_string().contains("relative path"), "{path}: {err}");
        }
        for path in ["AGENTS.md/", ".agents/"] {
            let err = with_files(&[(path, "")]).validate().unwrap_err();
            assert!(err.to_string().contains("slash"), "{path}: {err}");
        }
        for pair in [("a/b", "a//b"), ("AGENTS.md", "agents.md")] {
            let err = with_files(&[(pair.0, ""), (pair.1, "")])
                .validate()
                .unwrap_err();
            assert!(err.to_string().contains("same file"), "{pair:?}: {err}");
        }
        for pair in [("a", "a/b"), ("a/b/c", "a/b"), ("A/b", "a")] {
            let err = with_files(&[(pair.0, ""), (pair.1, "")])
                .validate()
                .unwrap_err();
            assert!(
                err.to_string().contains("the other's directory"),
                "{pair:?}: {err}"
            );
        }
        with_files(&[("a/b", ""), ("a/c", ""), ("ab", "")])
            .validate()
            .unwrap();
        let err = format!(
            "{:#}",
            with_files(&[("AGENTS.md", "{system_promt}")])
                .validate()
                .unwrap_err()
        );
        assert!(err.contains("unknown placeholder {system_promt}"), "{err}");
        assert!(with_files(&[("AGENTS.md", "{effort}")]).validate().is_err());
        ProviderConfig {
            effort: Some(Effort {
                edit: "low".into(),
                discuss: "high".into(),
            }),
            ..with_files(&[("AGENTS.md", "{effort}")])
        }
        .validate()
        .unwrap();
        let prespawned = ProviderConfig {
            prespawn: true,
            ..with_files(&[("AGENTS.md", "{system_prompt}")])
        };
        assert!(prespawned.validate().is_err());
    }

    #[test]
    fn parses_antigravity_results() {
        // As `agy --output-format json` prints them.
        let ok = r#"{"conversation_id":"b49e8b36-f224-41d5-b5d4-0a1cdb92a71f","status":"SUCCESS","response":"pong\n","duration_seconds":3.027478,"num_turns":1,"usage":{"input_tokens":11037,"output_tokens":23,"thinking_tokens":21,"cache_read_tokens":0,"total_tokens":11060}}"#;
        assert_eq!(
            parse_antigravity_result(&format!("{ok}\n")).unwrap(),
            "pong"
        );
        let bad_model = r#"{"conversation_id":"","status":"ERROR","response":"","error":"invalid model selection (--model \"no-such-model\" --effort \"\"): model no-such-model is not recognized as a known model or custom model in settings","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0},"finished_reason":"error"}"#;
        let err = parse_antigravity_result(bad_model).unwrap_err().to_string();
        assert!(err.contains("(ERROR)"), "{err}");
        assert!(
            err.contains("model no-such-model is not recognized"),
            "{err}"
        );
        let unexplained = parse_antigravity_result(r#"{"status":"CANCELLED","response":"half"}"#)
            .unwrap_err()
            .to_string();
        assert!(unexplained.contains("(CANCELLED)"), "{unexplained}");
        assert!(parse_antigravity_result(r#"{"response":"no status"}"#).is_err());
        assert!(parse_antigravity_result(r#"{"status":"SUCCESS"}"#).is_err());
        assert!(parse_antigravity_result("Error: something broke").is_err());
        assert!(parse_antigravity_result("").is_err());
    }

    #[test]
    fn parses_claude_results() {
        let ok = r#"{"type":"result","is_error":false,"result":"hi","modelUsage":{"claude-haiku-x":{}}}"#;
        assert_eq!(
            parse_claude_result(ok).unwrap(),
            ("hi".to_owned(), Some("claude-haiku-x".to_owned()))
        );
        let err = r#"{"type":"result","is_error":true,"result":"Not logged in"}"#;
        assert!(
            parse_claude_result(err)
                .unwrap_err()
                .to_string()
                .contains("Not logged in")
        );
    }

    #[test]
    fn stops_codex_at_any_tool() {
        let event = |t: &str, item: &str| format!(r#"{{"type":"{t}","item":{item}}}"#);
        assert_eq!(
            parse_codex_event(&event(
                "item.completed",
                r#"{"type":"agent_message","text":"{}"}"#
            ))
            .unwrap(),
            CodexEvent::Message("{}".into())
        );
        for tool in [
            "command_execution",
            "file_change",
            "mcp_tool_call",
            "collab_tool_call",
            "something_new",
        ] {
            assert_eq!(
                parse_codex_event(&event("item.started", &format!(r#"{{"type":"{tool}"}}"#)))
                    .unwrap(),
                CodexEvent::Tool(tool.into()),
                "{tool}"
            );
        }
        assert_eq!(
            parse_codex_event(&event("item.started", r#"{"type":"reasoning"}"#)).unwrap(),
            CodexEvent::Other
        );
        assert_eq!(
            parse_codex_event(&event(
                "item.completed",
                r#"{"type":"error","message":"note"}"#
            ))
            .unwrap(),
            CodexEvent::Notice("note".into())
        );
        assert_eq!(
            parse_codex_event(r#"{"type":"turn.failed","error":{"message":"quota"}}"#).unwrap(),
            CodexEvent::Failed("quota".into())
        );
        assert_eq!(
            parse_codex_event(r#"{"type":"turn.started"}"#).unwrap(),
            CodexEvent::Other
        );
    }

    #[test]
    fn parses_ollama_replies() {
        assert_eq!(
            parse_ollama_reply(r#"{"message":{"role":"assistant","content":"{}"},"done":true}"#)
                .unwrap(),
            "{}"
        );
        assert!(
            parse_ollama_reply(r#"{"error":"model not found"}"#)
                .unwrap_err()
                .to_string()
                .contains("model not found")
        );
    }

    #[test]
    fn resolves_model_families_to_the_newest() {
        let slugs = parse_model_catalog(
            r#"{"models":[{"slug":"gpt-6-luna","visibility":"list"},{"slug":"gpt-6.1-sol","visibility":"list"},{"slug":"gpt-6-sol","visibility":"list"},{"slug":"gpt-7-luna","visibility":"hide"},{"slug":"gpt-5.6-luna","visibility":"list"}]}"#,
        )
        .unwrap();
        assert_eq!(
            newest_in_family(&slugs, "luna").as_deref(),
            Some("gpt-6-luna")
        );
        assert_eq!(
            newest_in_family(&slugs, "sol").as_deref(),
            Some("gpt-6.1-sol")
        );
        assert_eq!(
            newest_in_family(&slugs, "gpt-6-sol").as_deref(),
            Some("gpt-6-sol")
        );
        assert_eq!(newest_in_family(&slugs, "astra"), None);
    }

    #[test]
    fn parses_stream_events() {
        assert_eq!(
            parse_stream_event(r#"{"type":"system","subtype":"init","model":"claude-haiku-x"}"#)
                .unwrap(),
            StreamEvent::Init {
                model: Some("claude-haiku-x".into())
            }
        );
        assert_eq!(
            parse_stream_event(r#"{"type":"assistant","message":{"model":"m","content":[{"type":"thinking","thinking":""}]}}"#).unwrap(),
            StreamEvent::Other
        );
        assert_eq!(
            parse_stream_event(r#"{"type":"assistant","message":{"model":"m","content":[{"type":"text","text":"{}"}]}}"#).unwrap(),
            StreamEvent::Text {
                text: "{}".into(),
                model: Some("m".into())
            }
        );
        assert!(matches!(
            parse_stream_event(r#"{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"API Error"}]}}"#).unwrap(),
            StreamEvent::Result(Err(e)) if e == "API Error"
        ));
        assert!(matches!(
            parse_stream_event(r#"{"type":"result","is_error":true,"result":"Not logged in"}"#)
                .unwrap(),
            StreamEvent::Result(Err(_))
        ));
        assert!(parse_stream_event("not json").is_err());
        assert_eq!(
            parse_stream_event(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"one two"}}}"#).unwrap(),
            StreamEvent::Delta("one two".into())
        );
        assert_eq!(
            parse_stream_event(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}}"#).unwrap(),
            StreamEvent::Other
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn streams_partial_text_as_it_arrives() {
        let dir = tempfile::tempdir().unwrap();
        // A stand-in for Claude Code's stream-json output with partial messages.
        let script = r#"cat > /dev/null
delta() { printf '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"%s"}}}\n' "$1"; }
delta "Try "
delta "a map."
printf '{"type":"assistant","message":{"model":"m","content":[{"type":"text","text":"Try a map."}]}}\n'"#;
        // In a file, as command arguments are templates, where braces mean placeholders.
        let script_file = dir.path().join("fake-claude.sh");
        std::fs::write(&script_file, script).unwrap();
        let provider = ProviderConfig::with_command(
            vec!["sh".into(), script_file.to_string_lossy().into_owned()],
            InputMode::ClaudeStreamJson,
            OutputMode::ClaudeStreamJson,
        );
        let runner = ProviderRunner::new(provider, dir.path().to_owned()).unwrap();
        let spec = CallSpec {
            model: "m".into(),
            system_prompt: "s".into(),
            effort: None,
        };
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let reply = runner
            .call_streaming(&spec, "hi", Duration::from_secs(10), Some(&sender))
            .await
            .unwrap();
        assert_eq!(reply.text, "Try a map.");
        drop(sender);
        let mut parts = Vec::new();
        while let Some(part) = receiver.recv().await {
            parts.push(part);
        }
        assert_eq!(parts, ["Try ", "a map."]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runs_stdin_text_provider_with_prespawn() {
        let dir = tempfile::tempdir().unwrap();
        let provider = ProviderConfig {
            prespawn: true,
            ..ProviderConfig::with_command(
                vec![
                    "sh".into(),
                    "-c".into(),
                    "printf '%s|' \"$0\"; cat".into(),
                    "{model}".into(),
                ],
                InputMode::Stdin,
                OutputMode::Text,
            )
        };
        let runner = ProviderRunner::new(provider, dir.path().to_owned()).unwrap();
        let spec = CallSpec {
            model: "m1".into(),
            system_prompt: "s".into(),
            effort: None,
        };
        runner.warm(&spec).await.unwrap();
        for prompt in ["first", "second"] {
            let reply = runner
                .call(&spec, prompt, Duration::from_secs(10))
                .await
                .unwrap();
            assert_eq!(reply.text, format!("m1|{prompt}"));
        }
        let other = CallSpec {
            model: "m2".into(),
            system_prompt: "s".into(),
            effort: None,
        };
        let reply = runner
            .call(&other, "third", Duration::from_secs(10))
            .await
            .unwrap();
        assert_eq!(reply.text, "m2|third");
    }

    /// The `call-` directories in `dir`.
    #[cfg(unix)]
    fn call_dirs(dir: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with("call-"))
            })
            .collect()
    }

    /// A runner whose stand-in CLI notes each directory it runs in under `record`, then replies
    /// with the files written there, fails or hangs, as the prompt asks.
    #[cfg(unix)]
    fn runner_with_files(root: &Path, output: OutputMode) -> (ProviderRunner, PathBuf, PathBuf) {
        let record = root.join("record");
        let working_dir = root.join("work");
        std::fs::create_dir_all(&record).unwrap();
        let script = root.join("fake-cli.sh");
        std::fs::write(
            &script,
            r#"pwd >> "$1/dirs"
prompt=$(cat)
case "$prompt" in
  fail) printf '{"type":"result","is_error":true,"result":"it broke"}'; exit 1;;
  hang) sleep 30;;
esac
printf '%s|%s|%s' "$prompt" "$(cat AGENTS.md)" "$(cat .agents/hooks.json)"
"#,
        )
        .unwrap();
        let provider = ProviderConfig {
            files: vec![
                CallFile {
                    path: "AGENTS.md".into(),
                    contents: "{system_prompt}".into(),
                },
                CallFile {
                    path: ".agents/hooks.json".into(),
                    contents: "{{\"model\": \"{model}\"}}".into(),
                },
            ],
            ..ProviderConfig::with_command(
                vec![
                    "sh".into(),
                    script.to_string_lossy().into_owned(),
                    record.to_string_lossy().into_owned(),
                ],
                InputMode::Stdin,
                output,
            )
        };
        let runner = ProviderRunner::new(provider, working_dir.clone()).unwrap();
        (runner, working_dir, record.join("dirs"))
    }

    #[cfg(unix)]
    fn recorded_dirs(file: &Path) -> Vec<PathBuf> {
        std::fs::read_to_string(file)
            .unwrap_or_default()
            .lines()
            .map(PathBuf::from)
            .collect()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runs_each_call_in_a_fresh_directory_with_its_files() {
        let root = tempfile::tempdir().unwrap();
        let (runner, working_dir, dirs) = runner_with_files(root.path(), OutputMode::Text);
        let spec = |system_prompt: &str| CallSpec {
            model: "m1".into(),
            system_prompt: system_prompt.into(),
            effort: None,
        };
        let (first, second) = (spec("Be brief."), spec("Be thorough."));
        let timeout = Duration::from_secs(10);
        let (one, two) = tokio::join!(
            runner.call(&first, "one", timeout),
            runner.call_aside(&second, "two", timeout),
        );
        assert_eq!(one.unwrap().text, r#"one|Be brief.|{"model": "m1"}"#);
        assert_eq!(two.unwrap().text, r#"two|Be thorough.|{"model": "m1"}"#);
        let ran_in = recorded_dirs(&dirs);
        assert_eq!(ran_in.len(), 2);
        assert_ne!(ran_in[0], ran_in[1]);
        for dir in &ran_in {
            assert!(
                dir.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("call-"),
                "{}",
                dir.display()
            );
            assert!(!dir.exists(), "{} wasn't removed", dir.display());
        }
        assert_eq!(call_dirs(&working_dir), Vec::<PathBuf>::new());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn removes_a_calls_directory_when_it_fails_times_out_or_is_cancelled() {
        let root = tempfile::tempdir().unwrap();
        let (runner, working_dir, dirs) = runner_with_files(root.path(), OutputMode::ClaudeJson);
        let spec = CallSpec {
            model: "m".into(),
            system_prompt: "s".into(),
            effort: None,
        };
        let err = runner
            .call(&spec, "fail", Duration::from_secs(10))
            .await
            .unwrap_err();
        assert!(format!("{err:#}").contains("it broke"), "{err:#}");
        let err = runner
            .call(&spec, "hang", Duration::from_millis(500))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("longer than"), "{err}");
        // Dropped mid-call, once it's running in its directory.
        let call = runner.call(&spec, "hang", Duration::from_secs(30));
        let started = async {
            while recorded_dirs(&dirs).len() < 3 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        };
        tokio::select! {
            _ = call => panic!("the hanging call finished"),
            () = started => {}
        }
        let ran_in = recorded_dirs(&dirs);
        assert_eq!(ran_in.len(), 3);
        for dir in &ran_in {
            assert!(!dir.exists(), "{} wasn't removed", dir.display());
        }
        assert_eq!(call_dirs(&working_dir), Vec::<PathBuf>::new());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runs_providers_without_files_in_the_working_directory() {
        let root = tempfile::tempdir().unwrap();
        let provider = ProviderConfig::with_command(
            vec!["sh".into(), "-c".into(), "cat > /dev/null; pwd".into()],
            InputMode::Stdin,
            OutputMode::Text,
        );
        let runner = ProviderRunner::new(provider, root.path().to_owned()).unwrap();
        let spec = CallSpec {
            model: "m".into(),
            system_prompt: "s".into(),
            effort: None,
        };
        let reply = runner
            .call(&spec, "hi", Duration::from_secs(10))
            .await
            .unwrap();
        assert_eq!(
            Path::new(&reply.text).canonicalize().unwrap(),
            root.path().canonicalize().unwrap()
        );
    }
}
