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
    /// Refuse to run on Windows, for a provider that relies on a Unix shell, such as for a hook
    /// its files set up.
    #[serde(default)]
    pub unix_only: bool,
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
    /// Antigravity `--output-format stream-json`. Antigravity can't run without tools, so the
    /// process is stopped, and the call fails, if a tool ever runs rather than being refused.
    AntigravityStreamJson,
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
            unix_only: false,
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

    /// Whether it can run here, on Windows or not.
    pub fn check_platform(&self, id: &str, windows: bool) -> Result<()> {
        if self.unix_only && windows {
            bail!(
                "{} doesn't work on Windows yet, so choose another provider in Settings",
                self.display_name(id)
            );
        }
        Ok(())
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
        // A process that has only just exited can briefly keep files open on some systems.
        for attempt in 1..=3 {
            match std::fs::remove_dir_all(&self.path) {
                Ok(()) => return,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => return,
                Err(err) if attempt == 3 => {
                    tracing::warn!("couldn't remove {}: {err}", self.path.display());
                }
                Err(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        }
    }
}

/// A call's process, with the directory of its own it runs in, if it has one. The directory is
/// removed only once the process has exited, however the call ends.
struct CallProcess {
    process: Option<GroupedChild>,
    dir: Option<CallDir>,
}

impl CallProcess {
    fn process(&mut self) -> &mut GroupedChild {
        self.process
            .as_mut()
            .expect("a call's process is only taken when it's stopped")
    }

    /// Stops the process and everything it started, waits for it to exit, then removes its
    /// directory. If this is cancelled while waiting, the drop cleans up instead.
    async fn stop(mut self) {
        if let Some(process) = self.process.as_mut() {
            process.kill();
            match tokio::time::timeout(EXIT_GRACE, process.child.wait()).await {
                Ok(Ok(_)) => {}
                Ok(Err(err)) => tracing::warn!("couldn't wait for the model CLI to exit: {err}"),
                Err(_) => tracing::error!(
                    "the model CLI was still running {}s after being killed; removing its directory anyway",
                    EXIT_GRACE.as_secs()
                ),
            }
        }
        if let Some(process) = self.process.take() {
            process.finish();
        }
        drop(self.dir.take());
    }
}

/// How long a call's process may take to exit after being killed, before its directory is
/// removed anyway.
const EXIT_GRACE: Duration = Duration::from_secs(5);

impl Drop for CallProcess {
    /// Only reached with the process still there when the call was cancelled, as `stop` didn't
    /// finish, and a drop can't wait.
    fn drop(&mut self) {
        let Some(mut process) = self.process.take() else {
            return;
        };
        process.kill();
        let Some(dir) = self.dir.take() else {
            return;
        };
        let leftover = Leftover { process, _dir: dir };
        // Waiting for the process here would hold up the thread, so a task waits, and the
        // leftover's own drop cleans up if the task can't run.
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn(async move {
                    let mut leftover = leftover;
                    let _ = tokio::time::timeout(EXIT_GRACE, leftover.process.child.wait()).await;
                });
            }
            Err(_) => drop(leftover),
        }
    }
}

/// A cancelled call's killed process, and the directory to remove once it has exited.
///
/// Its drop waits for the process, for at most `EXIT_GRACE`, then removes the directory. A task
/// that has already waited makes that wait instant; a task that never runs, as the runtime is
/// shutting down, is dropped with the runtime, so the drop still cleans up. Only a Workshop that
/// exits without running drops, such as when it's killed, leaves the directory behind.
struct Leftover {
    process: GroupedChild,
    /// Removed as this is dropped, once the process has exited.
    _dir: CallDir,
}

impl Drop for Leftover {
    fn drop(&mut self) {
        let deadline = std::time::Instant::now() + EXIT_GRACE;
        while matches!(self.process.child.try_wait(), Ok(None)) {
            if std::time::Instant::now() >= deadline {
                tracing::error!(
                    "the model CLI was still running {}s after being killed; removing its directory anyway",
                    EXIT_GRACE.as_secs()
                );
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        self.process.reaped();
        // The directory is removed as the fields are dropped, after this.
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
        let program = &self.provider.command[0];
        self.provider.check_platform(program, cfg!(windows))?;
        let started = std::time::Instant::now();
        let spec = &self.resolve(spec).await;
        let dir = if self.provider.files.is_empty() {
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
                dir.as_ref().map_or(&self.working_dir, |dir| &dir.path),
            )?,
        };
        let mut call = CallProcess {
            process: Some(process),
            dir,
        };
        if self.provider.prespawn && spares == Spares::Use {
            // Failing to warm only costs latency on the next call, so it mustn't fail this one.
            if let Err(err) = self.warm(spec).await {
                tracing::warn!("could not start a spare model process: {err:#}");
            }
        }
        let result = tokio::time::timeout(
            timeout,
            self.communicate(call.process(), spec, prompt, partial),
        )
        .await;
        call.stop().await;
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

    /// Gives the process the prompt and reads its reply. Whoever started it stops it afterwards,
    /// as some CLIs carry on after replying; this only stops it early, as soon as it uses a tool.
    async fn communicate(
        &self,
        process: &mut GroupedChild,
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
            OutputMode::AntigravityStreamJson => {
                let mut lines = BufReader::new(stdout).lines();
                let mut model = None;
                // Tool steps asked for and not yet refused, by step, with the tool's name.
                let mut asked = std::collections::BTreeMap::new();
                let mut outcome = None;
                while let Some(line) = lines.next_line().await? {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let event = match parse_antigravity_event(&line) {
                        Ok(event) => event,
                        // Read on, so what it says on stderr and how it exits explain it, such
                        // as not being logged in, while a tool would still stop it.
                        Err(err) => {
                            outcome.get_or_insert(Err(err));
                            continue;
                        }
                    };
                    let stop = |message: String| {
                        tracing::error!("{message}");
                        anyhow::anyhow!(message)
                    };
                    match event {
                        AntigravityEvent::Init { model: m } => model = m.or(model),
                        AntigravityEvent::Delta(text) => {
                            // Nobody listening any more only means the reply isn't shown early.
                            if let Some(partial) = partial {
                                let _ = partial.send(text);
                            }
                        }
                        AntigravityEvent::Tool { step, name, state } => match state {
                            ToolState::Asked => {
                                asked.insert(step, name);
                            }
                            ToolState::Refused => {
                                asked.remove(&step);
                            }
                            ToolState::Ran(state) => {
                                stderr_task.abort();
                                process.kill();
                                return Err(stop(format!(
                                    "the model used a tool ({name}, which ended {state}) although tools are turned off, so it was stopped, and its reply isn't used"
                                )));
                            }
                        },
                        AntigravityEvent::Unrecognised(what) => {
                            stderr_task.abort();
                            process.kill();
                            return Err(stop(format!(
                                "Antigravity reported {what}, which Workshop doesn't recognise, so it was stopped in case it was a tool; a newer `agy` may need a newer Workshop"
                            )));
                        }
                        AntigravityEvent::Result(result) if outcome.is_none() => match result {
                            Ok(text) => {
                                if let Some(name) = asked.values().next() {
                                    stderr_task.abort();
                                    process.kill();
                                    return Err(stop(format!(
                                        "the model asked for a tool ({name}) that was never refused, although tools are turned off, so its reply isn't used"
                                    )));
                                }
                                stderr_task.abort();
                                return Ok((text, model));
                            }
                            Err(err) => outcome = Some(Err(anyhow::anyhow!(err))),
                        },
                        AntigravityEvent::Result(_) | AntigravityEvent::Other => {}
                    }
                }
                outcome.unwrap_or_else(|| Err(anyhow::anyhow!("model CLI exited without a result")))
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
                            stderr_task.abort();
                            process.kill();
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
                        return Ok((text, None));
                    }
                    Some(Err(err)) => Err(err),
                    None => Err(anyhow::anyhow!("model CLI exited without a reply")),
                }
            }
        };

        let status = process.child.wait().await?;
        // Anything it started could still hold stderr open, and keep the call waiting.
        process.reaped();
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

#[derive(Debug, PartialEq, Eq)]
enum AntigravityEvent {
    Init {
        model: Option<String>,
    },
    /// Part of the reply's text, as it's written.
    Delta(String),
    Tool {
        step: u64,
        name: String,
        state: ToolState,
    },
    /// An event or kind of step Workshop doesn't know, which could be a tool, described.
    Unrecognised(String),
    /// The reply, or why the call failed.
    Result(Result<String, String>),
    Other,
}

#[derive(Debug, PartialEq, Eq)]
enum ToolState {
    /// Asked for, and not yet refused: the hook decides between this and what comes next.
    Asked,
    /// Refused by the hook, so it never ran.
    Refused,
    /// Anything else, such as `DONE`, or an error other than the hook's refusal, which means it
    /// ran.
    Ran(String),
}

/// Steps that aren't tools. A kind of step that isn't one of these or a tool stops the call, as
/// it could be a new kind of tool.
const ANTIGRAVITY_SAFE_STEPS: &[&str] = &["user_input", "agent_response"];

/// How Antigravity reports a tool call refused by the built-in preset's hook, whose reason is
/// the last part.
const ANTIGRAVITY_REFUSAL: &str = "tool call denied by pre-tool hook: Tools are turned off.";

/// Reads one line of Antigravity's `--output-format stream-json`, failing only if it isn't JSON.
/// Event types it doesn't know aren't skipped, as one could report a tool being used.
fn parse_antigravity_event(line: &str) -> Result<AntigravityEvent> {
    let event: serde_json::Value = serde_json::from_str(line)
        .with_context(|| format!("model CLI printed a line that isn't JSON: {line}"))?;
    let string = |v: Option<&serde_json::Value>| v.and_then(|v| v.as_str()).map(str::to_owned);
    let kind = string(event.get("event"));
    Ok(match kind.as_deref() {
        Some("init") => AntigravityEvent::Init {
            model: string(event.pointer("/init/model")),
        },
        Some("step_update") => {
            let step = event.get("step_update");
            let field = |key: &str| string(step.and_then(|s| s.get(key)));
            let kind = field("step_type").unwrap_or_default();
            let index = step
                .and_then(|s| s.get("step_index"))
                .and_then(|i| i.as_u64());
            match (kind.as_str(), index) {
                (safe, _) if ANTIGRAVITY_SAFE_STEPS.contains(&safe) => match field("text_delta") {
                    Some(text) if kind == "agent_response" => AntigravityEvent::Delta(text),
                    _ => AntigravityEvent::Other,
                },
                ("tool", Some(index)) => {
                    let info = step.and_then(|s| s.get("tool_info"));
                    let refused = info.is_some_and(|i| i.get("output").is_none())
                        && string(info.and_then(|i| i.pointer("/error/message"))).as_deref()
                            == Some(ANTIGRAVITY_REFUSAL);
                    let state = field("state").unwrap_or_default();
                    AntigravityEvent::Tool {
                        step: index,
                        name: field("tool_name").unwrap_or_else(|| "an unnamed tool".to_owned()),
                        state: match state.as_str() {
                            "ACTIVE" => ToolState::Asked,
                            "ERROR" if refused => ToolState::Refused,
                            _ => ToolState::Ran(state),
                        },
                    }
                }
                ("tool", None) => {
                    AntigravityEvent::Unrecognised("a tool step with no index".to_owned())
                }
                (other, _) => AntigravityEvent::Unrecognised(format!("a {other:?} step")),
            }
        }
        Some("result") => AntigravityEvent::Result(
            event
                .get("result")
                .context("the result event has no result")
                .and_then(antigravity_reply)
                .map_err(|e| format!("{e:#}")),
        ),
        Some(other) => AntigravityEvent::Unrecognised(format!("a {other:?} event")),
        None => AntigravityEvent::Unrecognised(format!("an event with no type ({line})")),
    })
}

/// The reply in an Antigravity result, or why the call failed.
fn antigravity_reply(result: &serde_json::Value) -> Result<String> {
    let string = |key: &str| result.get(key).and_then(|v| v.as_str());
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
printf '{"event":"init","conversation_id":"c","init":{"model":"gemini-4-neon-low","cwd":"/tmp/c","tools":["read_file","run_command"]}}\n'
printf '{"event":"step_update","step_update":{"conversation_id":"c","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"{\\"edits\\": "}}\n'
printf '{"event":"step_update","step_update":{"conversation_id":"c","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"[]}\\n"}}\n'
printf '{"event":"result","result":{"conversation_id":"c","status":"SUCCESS","response":"{\\"edits\\": []}\\n","num_turns":1}}\n'
"#,
        )
        .unwrap();
        let mut provider = builtin("antigravity");
        assert!(provider.agent.is_none());
        assert_eq!(provider.output, OutputMode::AntigravityStreamJson);
        assert!(provider.unix_only);
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
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let reply = runner
            .call_streaming(
                &spec,
                "Make no edits.",
                Duration::from_secs(10),
                Some(&sender),
            )
            .await
            .unwrap();
        assert_eq!(reply.text, "{\"edits\": []}");
        assert_eq!(reply.model.as_deref(), Some("gemini-4-neon-low"));
        drop(sender);
        let mut parts = Vec::new();
        while let Some(part) = receiver.recv().await {
            parts.push(part);
        }
        assert_eq!(parts, ["{\"edits\": ", "[]}\n"]);
        let read = |name: &str| std::fs::read_to_string(copy.join(name)).unwrap();
        assert_eq!(read("prompt"), "Make no edits.");
        assert_eq!(read("AGENTS.md"), spec.system_prompt);
        // A repository's root of its own, so no rules are read from directories above it.
        assert!(copy.join(".git").is_file());
        assert_eq!(read(".git"), "gitdir: /nonexistent\n");
        let args: Vec<String> = read("args").lines().map(str::to_owned).collect();
        assert!(
            args.windows(2)
                .any(|w| w == ["--model", "gemini-4-neon-low"])
        );
        assert!(
            args.windows(2)
                .any(|w| w == ["--output-format", "stream-json"])
        );
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
        // It's how a refusal is told apart from a tool that ran and failed.
        let reason = decision["reason"].as_str().unwrap();
        assert!(ANTIGRAVITY_REFUSAL.ends_with(&format!(": {reason}")));
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
    fn checks_where_a_provider_can_run() {
        let antigravity = builtin("antigravity");
        antigravity.check_platform("antigravity", false).unwrap();
        let err = antigravity
            .check_platform("antigravity", true)
            .unwrap_err()
            .to_string();
        assert!(
            err.starts_with("Antigravity doesn't work on Windows"),
            "{err}"
        );
        builtin("claude").check_platform("claude", true).unwrap();
    }

    #[test]
    fn parses_antigravity_events() {
        // As `agy --output-format stream-json` prints them, shortened.
        let event = |line: &str| parse_antigravity_event(line).unwrap();
        assert_eq!(
            event(
                r#"{"event":"init","conversation_id":"c","init":{"model":"gemini-4-neon-low","cwd":"/tmp/call","tools":["read_file","run_command"]}}"#
            ),
            AntigravityEvent::Init {
                model: Some("gemini-4-neon-low".into())
            }
        );
        assert_eq!(
            event(
                r#"{"event":"step_update","step_update":{"conversation_id":"c","step_index":0,"state":"DONE","step_type":"user_input"}}"#
            ),
            AntigravityEvent::Other
        );
        assert_eq!(
            event(
                r#"{"event":"step_update","step_update":{"conversation_id":"c","step_index":1,"state":"DONE","step_type":"agent_response","duration_seconds":3.8}}"#
            ),
            AntigravityEvent::Other
        );
        assert_eq!(
            event(
                r#"{"event":"step_update","step_update":{"conversation_id":"c","step_index":4,"state":"ACTIVE","step_type":"agent_response","text_delta":"I couldn't run `echo hi`"}}"#
            ),
            AntigravityEvent::Delta("I couldn't run `echo hi`".into())
        );
        let tool = |step: u64, name: &str, state: ToolState| AntigravityEvent::Tool {
            step,
            name: name.into(),
            state,
        };
        assert_eq!(
            event(
                r#"{"event":"step_update","step_update":{"conversation_id":"c","step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hi"}}}}"#
            ),
            tool(3, "run_command", ToolState::Asked)
        );
        assert_eq!(
            event(
                r#"{"event":"step_update","step_update":{"conversation_id":"c","step_index":3,"state":"ERROR","step_type":"tool","tool_name":"run_command","duration_seconds":0.15,"tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hi"},"error":{"type":"TOOL_ERROR","message":"tool call denied by pre-tool hook: Tools are turned off."}}}}"#
            ),
            tool(3, "run_command", ToolState::Refused)
        );
        // As it reports a file read that wasn't refused.
        assert_eq!(
            event(
                r#"{"event":"step_update","step_update":{"conversation_id":"c","step_index":2,"state":"DONE","step_type":"tool","tool_name":"read_file","duration_seconds":0.02,"tool_info":{"name":"read_file","parameters":{"Path":"/tmp/call/notes.txt"},"output":"1 lines, 18 bytes"}}}"#
            ),
            tool(2, "read_file", ToolState::Ran("DONE".into()))
        );
        // As it reports a tool that ran and failed, such as reading a file that isn't there.
        assert_eq!(
            event(
                r#"{"event":"step_update","step_update":{"conversation_id":"c","step_index":2,"state":"ERROR","step_type":"tool","tool_name":"read_file","duration_seconds":0.15,"tool_info":{"name":"read_file","parameters":{"Path":"/tmp/call/missing.txt"},"error":{"type":"TOOL_ERROR","message":"file does not exist"}}}}"#
            ),
            tool(2, "read_file", ToolState::Ran("ERROR".into()))
        );
        // Only the hook's own refusal, with nothing from the tool, is a refusal.
        for info in [
            r#"{"error":{"message":"tool call denied by pre-tool hook: Some other reason."}}"#,
            r#"{"error":{"message":"tool call denied by pre-tool hook: Tools are turned off."},"output":"hi"}"#,
            r#"{"error":{"message":"Tools are turned off."}}"#,
            r#"{}"#,
        ] {
            assert_eq!(
                event(&format!(
                    r#"{{"event":"step_update","step_update":{{"step_index":2,"state":"ERROR","step_type":"tool","tool_name":"run_command","tool_info":{info}}}}}"#
                )),
                tool(2, "run_command", ToolState::Ran("ERROR".into())),
                "{info}"
            );
        }
        // A kind of step Workshop doesn't know, whatever its state, as it could be a tool.
        for state in ["ACTIVE", "DONE"] {
            assert_eq!(
                event(&format!(
                    r#"{{"event":"step_update","step_update":{{"step_index":5,"state":"{state}","step_type":"browser_subagent"}}}}"#
                )),
                AntigravityEvent::Unrecognised("a \"browser_subagent\" step".into())
            );
        }
        assert_eq!(
            event(r#"{"event":"step_update","step_update":{"state":"DONE","step_type":"tool"}}"#),
            AntigravityEvent::Unrecognised("a tool step with no index".into())
        );

        assert_eq!(
            event(
                r#"{"event":"result","result":{"conversation_id":"c","status":"SUCCESS","response":"pong\n","duration_seconds":2.35,"num_turns":1}}"#
            ),
            AntigravityEvent::Result(Ok("pong".into()))
        );
        let AntigravityEvent::Result(Err(bad_model)) = event(
            r#"{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"invalid model selection (--model \"no-such-model\" --effort \"\"): model no-such-model is not recognized as a known model or custom model in settings","duration_seconds":0,"num_turns":0,"finished_reason":"error"}}"#,
        ) else {
            panic!("an error status isn't a failure");
        };
        assert!(bad_model.contains("(ERROR)"), "{bad_model}");
        assert!(
            bad_model.contains("model no-such-model is not recognized"),
            "{bad_model}"
        );
        for result in [
            r#"{"status":"CANCELLED","response":"half"}"#,
            r#"{"response":"no status"}"#,
            r#"{"status":"SUCCESS"}"#,
        ] {
            assert!(
                matches!(
                    event(&format!(r#"{{"event":"result","result":{result}}}"#)),
                    AntigravityEvent::Result(Err(_))
                ),
                "{result}"
            );
        }
        assert!(matches!(
            event(r#"{"event":"result"}"#),
            AntigravityEvent::Result(Err(_))
        ));
        // Events it doesn't know aren't skipped, as they could report a tool.
        assert_eq!(
            event(r#"{"event":"subagent_update","subagent":{}}"#),
            AntigravityEvent::Unrecognised("a \"subagent_update\" event".into())
        );
        assert!(parse_antigravity_event("Error: something broke").is_err());
        assert!(parse_antigravity_event("").is_err());
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
echo $$ >> "$1/pids"
prompt=$(cat)
case "$prompt" in
  fail) printf '{"type":"result","is_error":true,"result":"it broke"}'; exit 1;;
  hang) sleep 30 & wait;;
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

    /// Whether the processes the stand-in CLI noted beside `dirs` are still there, unreaped or
    /// running.
    #[cfg(unix)]
    fn still_there(dirs: &Path) -> Vec<String> {
        std::fs::read_to_string(dirs.with_file_name("pids"))
            .unwrap_or_default()
            .lines()
            .filter(|pid| {
                std::process::Command::new("kill")
                    .args(["-0", pid])
                    .stderr(Stdio::null())
                    .status()
                    .unwrap()
                    .success()
            })
            .map(str::to_owned)
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
        assert_eq!(still_there(&dirs), Vec::<String>::new());
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
        // Each process has exited, and been waited for, by the time its call returns, and only
        // then is its directory removed.
        assert_eq!(still_there(&dirs), Vec::<String>::new());
        for dir in recorded_dirs(&dirs) {
            assert!(!dir.exists(), "{} wasn't removed", dir.display());
        }
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
        // A drop can't wait, so the process is killed straight away, and its directory removed
        // once it has exited.
        let ran_in = recorded_dirs(&dirs);
        assert_eq!(ran_in.len(), 3);
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while ran_in[2].exists() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        for dir in &ran_in {
            assert!(!dir.exists(), "{} wasn't removed", dir.display());
        }
        assert_eq!(call_dirs(&working_dir), Vec::<PathBuf>::new());
        assert_eq!(still_there(&dirs), Vec::<String>::new());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn removes_a_calls_directory_when_its_files_or_process_cant_be_made() {
        let root = tempfile::tempdir().unwrap();
        let spec = CallSpec {
            model: "m".into(),
            system_prompt: "s".into(),
            effort: None,
        };
        // A file where the next needs a directory, which validation would refuse, so that
        // writing the second fails after the first is written.
        let clashing = [
            CallFile {
                path: "x".into(),
                contents: "a file".into(),
            },
            CallFile {
                path: "x/y".into(),
                contents: "".into(),
            },
        ];
        assert!(CallDir::create(root.path(), &clashing, &spec).is_err());
        assert_eq!(call_dirs(root.path()), Vec::<PathBuf>::new());

        let provider = ProviderConfig {
            files: vec![CallFile {
                path: "AGENTS.md".into(),
                contents: "{system_prompt}".into(),
            }],
            ..ProviderConfig::with_command(
                vec!["no-such-model-cli".into()],
                InputMode::Stdin,
                OutputMode::Text,
            )
        };
        let runner = ProviderRunner::new(provider, root.path().to_owned()).unwrap();
        let err = runner
            .call(&spec, "hi", Duration::from_secs(10))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("no-such-model-cli"), "{err}");
        assert_eq!(call_dirs(root.path()), Vec::<PathBuf>::new());
    }

    /// Antigravity's preset, run by a stand-in for `agy` that prints `events` and exits with
    /// `exit`, or hangs once it has printed them if `exit` is `None`.
    #[cfg(unix)]
    fn antigravity_stand_in(
        root: &Path,
        events: &[&str],
        stderr: &str,
        exit: Option<u8>,
    ) -> (ProviderRunner, PathBuf) {
        let events_file = root.join("events.jsonl");
        std::fs::write(&events_file, events.join("\n") + "\n").unwrap();
        let end = match exit {
            Some(code) => format!("exit {code}"),
            None => "sleep 30 & wait".to_owned(),
        };
        let script = root.join("fake-agy.sh");
        std::fs::write(
            &script,
            format!(
                "cat > /dev/null\necho $$ > '{pids}'\ncat '{events}'\nprintf '%s' '{stderr}' >&2\n{end}\n",
                pids = root.join("pids").display(),
                events = events_file.display(),
            ),
        )
        .unwrap();
        let mut provider = builtin("antigravity");
        provider.command.splice(
            0..1,
            ["sh".to_owned(), script.to_string_lossy().into_owned()],
        );
        let working_dir = root.join("work");
        (
            ProviderRunner::new(provider, working_dir.clone()).unwrap(),
            working_dir,
        )
    }

    #[cfg(unix)]
    const ASKS_FOR_A_SHELL: &str = r#"{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hi"}}}}"#;

    #[cfg(unix)]
    const REPLIES: &str = r#"{"event":"result","result":{"status":"SUCCESS","response":"I couldn't run it.\n","num_turns":1}}"#;

    #[cfg(unix)]
    #[tokio::test]
    async fn carries_on_when_antigravity_is_refused_a_tool() {
        let root = tempfile::tempdir().unwrap();
        let refused = r#"{"event":"step_update","step_update":{"step_index":2,"state":"ERROR","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","error":{"type":"TOOL_ERROR","message":"tool call denied by pre-tool hook: Tools are turned off."}}}}"#;
        let (runner, _) = antigravity_stand_in(
            root.path(),
            &[ASKS_FOR_A_SHELL, refused, REPLIES],
            "",
            Some(0),
        );
        let reply = runner
            .call(
                &spec_for("gemini-4-neon-low"),
                "Run echo hi",
                Duration::from_secs(10),
            )
            .await
            .unwrap();
        assert_eq!(reply.text, "I couldn't run it.");
    }

    #[cfg(unix)]
    fn spec_for(model: &str) -> CallSpec {
        CallSpec {
            model: model.into(),
            system_prompt: "s".into(),
            effort: None,
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stops_antigravity_as_soon_as_a_tool_runs() {
        let root = tempfile::tempdir().unwrap();
        let ran = r#"{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","output":"hi"}}}"#;
        // It would hang after the tool, so the call only ends promptly if it's stopped.
        let (runner, working_dir) =
            antigravity_stand_in(root.path(), &[ASKS_FOR_A_SHELL, ran], "", None);
        let started = std::time::Instant::now();
        let err = runner
            .call(
                &spec_for("gemini-4-neon-low"),
                "Run echo hi",
                Duration::from_secs(20),
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(
            err.contains(
                "used a tool (run_command, which ended DONE) although tools are turned off"
            ),
            "{err}"
        );
        assert_eq!(still_there(&root.path().join("dirs")), Vec::<String>::new());
        assert_eq!(call_dirs(&working_dir), Vec::<PathBuf>::new());

        // Asked for and never refused is as bad, as there's no knowing it didn't run.
        let (runner, _) =
            antigravity_stand_in(root.path(), &[ASKS_FOR_A_SHELL, REPLIES], "", Some(0));
        let err = runner
            .call(
                &spec_for("gemini-4-neon-low"),
                "Run echo hi",
                Duration::from_secs(10),
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("never refused"), "{err}");

        // As is an event it doesn't know.
        let (runner, _) = antigravity_stand_in(
            root.path(),
            &[r#"{"event":"subagent_update"}"#, REPLIES],
            "",
            Some(0),
        );
        let err = runner
            .call(
                &spec_for("gemini-4-neon-low"),
                "hi",
                Duration::from_secs(10),
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(
            err.starts_with(
                "Antigravity reported a \"subagent_update\" event, which Workshop doesn't recognise, so it was stopped"
            ),
            "{err}"
        );

        // A tool that ran and failed ended as a refused one does, but isn't one.
        let failed = r#"{"event":"step_update","step_update":{"step_index":2,"state":"ERROR","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","output":"","error":{"type":"TOOL_ERROR","message":"exit status 1"}}}}"#;
        let (runner, _) = antigravity_stand_in(root.path(), &[ASKS_FOR_A_SHELL, failed], "", None);
        let err = runner
            .call(
                &spec_for("gemini-4-neon-low"),
                "Run false",
                Duration::from_secs(20),
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("(run_command, which ended ERROR)"), "{err}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reads_antigravity_past_blank_lines_and_explains_what_it_cant_read() {
        let root = tempfile::tempdir().unwrap();
        let (runner, _) = antigravity_stand_in(root.path(), &["", REPLIES, ""], "", Some(0));
        let reply = runner
            .call(
                &spec_for("gemini-4-neon-low"),
                "hi",
                Duration::from_secs(10),
            )
            .await
            .unwrap();
        assert_eq!(reply.text, "I couldn't run it.");

        // Something that isn't an event is explained by what it says on stderr, if it can be.
        let (runner, _) = antigravity_stand_in(
            root.path(),
            &["Authentication required.", REPLIES],
            "Error: authentication required. Run 'agy' to log in, then retry.",
            Some(1),
        );
        let err = runner
            .call(
                &spec_for("gemini-4-neon-low"),
                "hi",
                Duration::from_secs(10),
            )
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(
            err,
            "Antigravity isn't logged in. On the server, run `sh` and log in, then try again."
        );
        // And otherwise is a failure, even if a reply follows.
        let (runner, _) =
            antigravity_stand_in(root.path(), &["Something odd.", REPLIES], "", Some(0));
        let err = runner
            .call(
                &spec_for("gemini-4-neon-low"),
                "hi",
                Duration::from_secs(10),
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("isn't JSON: Something odd."), "{err}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn doesnt_wait_for_what_a_finished_cli_left_running() {
        let root = tempfile::tempdir().unwrap();
        // Something it started holds stderr open after it has exited.
        let provider = ProviderConfig::with_command(
            vec![
                "sh".into(),
                "-c".into(),
                "cat > /dev/null; sleep 30 > /dev/null & echo done".into(),
            ],
            InputMode::Stdin,
            OutputMode::Text,
        );
        let runner = ProviderRunner::new(provider, root.path().to_owned()).unwrap();
        let started = std::time::Instant::now();
        let reply = runner
            .call(&spec_for("m"), "hi", Duration::from_secs(20))
            .await
            .unwrap();
        assert_eq!(reply.text, "done");
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[cfg(unix)]
    #[test]
    fn removes_a_cancelled_calls_directory_as_the_runtime_shuts_down() {
        let root = tempfile::tempdir().unwrap();
        let (runner, working_dir, dirs) = runner_with_files(root.path(), OutputMode::Text);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let spec = spec_for("m");
            let call = runner.call(&spec, "hang", Duration::from_secs(30));
            let started = async {
                while recorded_dirs(&dirs).is_empty() {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            };
            tokio::select! {
                _ = call => panic!("the hanging call finished"),
                () = started => {}
            }
        });
        // The task left to wait for the process never gets to run.
        drop(runtime);
        assert_eq!(call_dirs(&working_dir), Vec::<PathBuf>::new());
        assert_eq!(still_there(&dirs), Vec::<String>::new());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn says_why_antigravity_failed() {
        let root = tempfile::tempdir().unwrap();
        let failed = r#"{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"invalid model selection (--model \"gemini-0\" --effort \"\"): model gemini-0 is not recognized as a known model or custom model in settings","duration_seconds":0,"num_turns":0,"finished_reason":"error"}}"#;
        let (runner, working_dir) = antigravity_stand_in(
            root.path(),
            &[failed],
            "error: invalid model selection (--model gemini-0)",
            Some(1),
        );
        let err = runner
            .call(&spec_for("gemini-0"), "hi", Duration::from_secs(10))
            .await
            .unwrap_err();
        let err = format!("{err:#}");
        assert!(
            err.starts_with(
                "Antigravity exited with exit status: 1: error: invalid model selection (--model gemini-0): "
            ),
            "{err}"
        );
        assert!(
            err.contains("model CLI reported an error (ERROR): invalid model selection"),
            "{err}"
        );
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
