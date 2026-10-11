use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::template::{self, Vars};

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
}

const BUILTIN: &[(&str, &str)] = &[("claude", include_str!("../providers/claude.toml"))];

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
    pub fn validate(&self) -> Result<()> {
        if self.command.is_empty() {
            bail!("`command` must not be empty");
        }
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
            InputMode::Stdin | InputMode::ClaudeStreamJson if mentions_prompt => {
                bail!("{{prompt}} is only available with `input = \"argument\"`")
            }
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallSpec {
    pub model: String,
    pub system_prompt: String,
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
    child: Child,
}

/// Runs one provider, keeping a pre-started process ready when the provider supports it.
pub struct ProviderRunner {
    provider: ProviderConfig,
    working_dir: PathBuf,
    spare: Mutex<Option<Spare>>,
}

impl ProviderRunner {
    /// `working_dir` should be an empty directory so the CLI doesn't pick up project files.
    pub fn new(provider: ProviderConfig, working_dir: PathBuf) -> Result<Self> {
        provider.validate()?;
        Ok(Self {
            provider,
            working_dir,
            spare: Mutex::new(None),
        })
    }

    /// Starts a process for `spec` so the next `call` with the same spec skips start-up.
    pub async fn warm(&self, spec: &CallSpec) -> Result<()> {
        if !self.provider.prespawn {
            return Ok(());
        }
        let mut spare = self.spare.lock().await;
        if let Some(existing) = spare.as_mut()
            && existing.spec == *spec
            && existing.child.try_wait()?.is_none()
        {
            return Ok(());
        }
        *spare = Some(Spare {
            spec: spec.clone(),
            child: self.spawn(spec, None)?,
        });
        Ok(())
    }

    pub async fn call(&self, spec: &CallSpec, prompt: &str, timeout: Duration) -> Result<Reply> {
        let started = std::time::Instant::now();
        let child = match self.take_spare(spec).await? {
            Some(child) => child,
            None => self.spawn(spec, Some(prompt))?,
        };
        if self.provider.prespawn {
            // Failing to warm only costs latency on the next call, so it mustn't fail this one.
            if let Err(err) = self.warm(spec).await {
                tracing::warn!("could not start a spare model process: {err:#}");
            }
        }
        let result = tokio::time::timeout(timeout, self.communicate(child, prompt)).await;
        let (text, model) = match result {
            Ok(reply) => reply?,
            Err(_) => bail!("the model took longer than {}s to reply", timeout.as_secs()),
        };
        Ok(Reply {
            text,
            model,
            elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        })
    }

    async fn take_spare(&self, spec: &CallSpec) -> Result<Option<Child>> {
        let mut guard = self.spare.lock().await;
        let Some(mut spare) = guard.take() else {
            return Ok(None);
        };
        if spare.spec != *spec || spare.child.try_wait()?.is_some() {
            // Dropping the spare kills it (`kill_on_drop`).
            return Ok(None);
        }
        Ok(Some(spare.child))
    }

    fn spawn(&self, spec: &CallSpec, prompt: Option<&str>) -> Result<Child> {
        let mut vars = Vars::new()
            .set("model", spec.model.clone())
            .set("system_prompt", spec.system_prompt.clone());
        if self.provider.input == InputMode::Argument {
            let prompt = prompt.context("argument input needs the prompt at spawn time")?;
            vars = vars.set("prompt", prompt);
        }
        let args = template::render_all(&self.provider.command, &vars)?;
        let (program, rest) = args.split_first().context("empty provider command")?;
        std::fs::create_dir_all(&self.working_dir)
            .with_context(|| format!("creating {}", self.working_dir.display()))?;
        Command::new(program)
            .args(rest)
            .current_dir(&self.working_dir)
            .stdin(match self.provider.input {
                InputMode::Argument => Stdio::null(),
                InputMode::Stdin | InputMode::ClaudeStreamJson => Stdio::piped(),
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("starting `{program}`"))
    }

    async fn communicate(
        &self,
        mut child: Child,
        prompt: &str,
    ) -> Result<(String, Option<String>)> {
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
                        let _ = child.start_kill();
                        stderr_task.abort();
                        return Ok(reply);
                    }
                    Some(Err(err)) => Err(err),
                    None => Err(anyhow::anyhow!("model CLI exited without a result")),
                }
            }
        };

        let status = child.wait().await?;
        let stderr = stderr_task.await.unwrap_or_default();
        match parsed {
            Ok(reply) => Ok(reply),
            Err(err) if !status.success() => {
                Err(err.context(format!("model CLI exited with {status}: {}", stderr.trim())))
            }
            Err(err) => Err(err),
        }
    }
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

    #[test]
    fn validation_catches_inconsistent_input() {
        let mut provider = ProviderConfig {
            command: vec!["cli".into(), "{prompt}".into()],
            input: InputMode::Argument,
            output: OutputMode::Text,
            prespawn: false,
            version_command: None,
            auth_check_command: None,
            install_hint: None,
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
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runs_stdin_text_provider_with_prespawn() {
        let dir = tempfile::tempdir().unwrap();
        let provider = ProviderConfig {
            command: vec![
                "sh".into(),
                "-c".into(),
                "printf '%s|' \"$0\"; cat".into(),
                "{model}".into(),
            ],
            input: InputMode::Stdin,
            output: OutputMode::Text,
            prespawn: true,
            version_command: None,
            auth_check_command: None,
            install_hint: None,
        };
        let runner = ProviderRunner::new(provider, dir.path().to_owned()).unwrap();
        let spec = CallSpec {
            model: "m1".into(),
            system_prompt: "s".into(),
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
        };
        let reply = runner
            .call(&other, "third", Duration::from_secs(10))
            .await
            .unwrap();
        assert_eq!(reply.text, "m2|third");
    }
}
