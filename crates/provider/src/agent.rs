//! Running a model CLI as an agent, with tools, confined to one directory: only the author does,
//! to write a pack's items. Every other role runs with tools turned off (see `ProviderRunner`).
//!
//! How tightly a CLI can be confined is the CLI's to decide, so each provider's `[agent]` command
//! says it. The built-in ones give Claude Code only its file tools, in its restricted mode, which
//! keeps them to the working directory, with nothing that would ask permission allowed; and run
//! Codex in its workspace-write sandbox, with the directory as its workspace and no network.
//! SECURITY.md says what each guarantees, and what it doesn't.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use workshop_common::process::{self, GroupedChild};
use workshop_common::template::{self, Vars};

use crate::CallSpec;

/// How to run a provider's CLI as an agent, with tools confined to a directory.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AgentConfig {
    /// Placeholders: `{model}`, `{system_prompt}`, `{system_prompt_file}`, `{effort}`, and
    /// `{dir}`, the only directory it may change. It's started in `{dir}`, and must confine
    /// itself there, such as with the CLI's own sandbox. The prompt is written to stdin.
    pub command: Vec<String>,
    pub output: AgentOutput,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AgentOutput {
    /// All of stdout is the reply.
    Text,
    /// Claude Code's `--output-format json`.
    ClaudeJson,
    /// Codex's `exec --json` events, whose last message is the reply. Unlike a call without
    /// tools, using a tool doesn't stop it.
    CodexJson,
}

impl AgentConfig {
    pub fn validate(&self) -> Result<()> {
        if self.command.is_empty() {
            bail!("the agent's `command` must not be empty");
        }
        Ok(())
    }

    /// The command, with its placeholders filled in, for running in `dir`, with the system
    /// prompt in `prompt_dir` for CLIs that read it from a file.
    pub fn args(&self, spec: &CallSpec, dir: &Path, prompt_dir: &Path) -> Result<Vec<String>> {
        let mut vars = Vars::new()
            .set("model", spec.model.clone())
            .set("system_prompt", spec.system_prompt.clone())
            .set("dir", dir.to_string_lossy().into_owned());
        if self
            .command
            .iter()
            .any(|arg| arg.contains("{system_prompt_file"))
        {
            std::fs::create_dir_all(prompt_dir)
                .with_context(|| format!("creating {}", prompt_dir.display()))?;
            let file = prompt_dir.join(format!(
                "system-prompt-{}.md",
                workshop_common::files::version_of(&spec.system_prompt)
            ));
            workshop_common::files::write_atomic(&file, spec.system_prompt.as_bytes())?;
            vars = vars.set("system_prompt_file", file.to_string_lossy().into_owned());
        }
        if let Some(effort) = &spec.effort {
            vars = vars.set("effort", effort.clone());
        }
        template::render_all(&self.command, &vars)
    }

    /// Runs the agent in `dir` with `prompt`, and returns its final reply.
    pub async fn run(
        &self,
        spec: &CallSpec,
        dir: &Path,
        prompt_dir: &Path,
        prompt: &str,
        timeout: Duration,
    ) -> Result<String> {
        let args = self.args(spec, dir, prompt_dir)?;
        let (program, rest) = args.split_first().context("empty agent command")?;
        let mut child = GroupedChild::spawn(
            process::command(program)
                .args(rest)
                .current_dir(dir)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped()),
        )
        .with_context(|| format!("starting `{program}`"))?;
        let result = tokio::time::timeout(timeout, communicate(&mut child, self.output, prompt))
            .await
            .map_err(|_| anyhow::anyhow!("the model took longer than {}s", timeout.as_secs()));
        // Dropping the process group stops anything it started that's still running.
        match result {
            Ok(reply) => {
                child.finish();
                reply
            }
            Err(err) => {
                drop(child);
                Err(err)
            }
        }
    }
}

async fn communicate(
    child: &mut GroupedChild,
    output: AgentOutput,
    prompt: &str,
) -> Result<String> {
    let process = &mut child.child;
    if let Some(mut stdin) = process.stdin.take() {
        stdin.write_all(prompt.as_bytes()).await?;
        stdin.shutdown().await?;
    }
    let stdout = process.stdout.take().context("stdout wasn't captured")?;
    let mut stderr = process.stderr.take().context("stderr wasn't captured")?;
    let stderr = tokio::spawn(async move {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text).await;
        text
    });
    let mut lines = BufReader::new(stdout).lines();
    let mut out = String::new();
    while let Some(line) = lines.next_line().await? {
        out.push_str(&line);
        out.push('\n');
    }
    let status = process.wait().await?;
    let stderr = stderr.await.unwrap_or_default();
    let reply = match output {
        AgentOutput::Text => Ok(out.trim().to_owned()),
        AgentOutput::ClaudeJson => crate::parse_claude_result(&out).map(|(text, _)| text),
        AgentOutput::CodexJson => last_codex_message(&out),
    };
    match reply {
        Ok(reply) if status.success() => Ok(reply),
        Ok(_) => bail!("the model exited with {status}: {}", stderr.trim()),
        Err(err) => Err(err.context(format!("the model exited with {status}: {}", stderr.trim()))),
    }
}

/// The last message in Codex's `exec --json` events, or why the turn failed.
fn last_codex_message(out: &str) -> Result<String> {
    let mut last = None;
    for line in out.lines().filter(|l| !l.trim().is_empty()) {
        match crate::parse_codex_event(line)? {
            crate::CodexEvent::Message(text) => last = Some(text),
            crate::CodexEvent::Failed(message) => bail!("the model failed: {message}"),
            _ => {}
        }
    }
    last.context("the model finished without a reply")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> CallSpec {
        CallSpec {
            model: "a-model".to_owned(),
            system_prompt: "Write items.".to_owned(),
            effort: Some("high".to_owned()),
        }
    }

    fn agent(id: &str) -> AgentConfig {
        crate::builtin_providers()
            .unwrap()
            .into_iter()
            .find(|(provider, _)| provider == id)
            .and_then(|(_, provider)| provider.agent)
            .unwrap()
    }

    /// Whether `args` has `flag` followed by `value`.
    fn has(args: &[String], flag: &str, value: &str) -> bool {
        args.windows(2).any(|w| w[0] == flag && w[1] == value)
    }

    #[test]
    fn confines_claude_code_to_its_file_tools_in_the_directory() {
        let dir = tempfile::tempdir().unwrap();
        let args = agent("claude")
            .args(&spec(), &dir.path().join("pack"), dir.path())
            .unwrap();
        assert_eq!(args[0], "claude");
        assert!(args.contains(&"--restricted".to_owned()));
        assert!(has(&args, "--tools", "Read,Edit,Write,Glob,Grep"));
        assert!(has(&args, "--permission-mode", "acceptEdits"));
        assert!(has(&args, "--permission-prompts", "none"));
        assert!(has(&args, "--setting-sources", ""));
        assert!(has(&args, "--model", "a-model"));
        assert!(has(&args, "--output-format", "json"));
        for flag in [
            "--strict-mcp-config",
            "--disable-slash-commands",
            "--no-session-persistence",
        ] {
            assert!(args.contains(&flag.to_owned()), "{flag}");
        }
        // Nothing that would widen it.
        for flag in [
            "--add-dir",
            "--allowedTools",
            "--allowed-tools",
            "--dangerously-skip-permissions",
            "--mcp-config",
        ] {
            assert!(!args.contains(&flag.to_owned()), "{flag}");
        }
        assert!(!args.iter().any(|a| a.contains("Bash")));
    }

    #[test]
    fn runs_codex_in_its_workspace_write_sandbox_on_the_directory() {
        let dir = tempfile::tempdir().unwrap();
        let pack = dir.path().join("pack");
        let args = agent("codex").args(&spec(), &pack, dir.path()).unwrap();
        assert_eq!(&args[..2], ["codex", "exec"]);
        assert!(has(&args, "--sandbox", "workspace-write"));
        assert!(has(&args, "-C", &pack.to_string_lossy()));
        for setting in [
            "approval_policy=\"never\"",
            "sandbox_workspace_write.network_access=false",
            "sandbox_workspace_write.exclude_tmpdir_env_var=true",
            "sandbox_workspace_write.exclude_slash_tmp=true",
            "web_search=\"disabled\"",
            "features.multi_agent=false",
        ] {
            assert!(has(&args, "-c", setting), "{setting}");
        }
        for flag in [
            "--ignore-user-config",
            "--ignore-rules",
            "--ephemeral",
            "--skip-git-repo-check",
        ] {
            assert!(args.contains(&flag.to_owned()), "{flag}");
        }
        for flag in [
            "--add-dir",
            "--dangerously-bypass-approvals-and-sandbox",
            "--full-auto",
        ] {
            assert!(!args.contains(&flag.to_owned()), "{flag}");
        }
        // Its instructions are a file outside the directory it may change.
        let instructions = args
            .iter()
            .find_map(|a| a.strip_prefix("model_instructions_file="))
            .unwrap();
        assert!(!instructions.contains(&*pack.to_string_lossy()));
        assert!(instructions.contains(&*dir.path().to_string_lossy()));
    }

    #[test]
    fn refuses_an_agent_with_no_command() {
        let none = AgentConfig {
            command: Vec::new(),
            output: AgentOutput::Text,
        };
        assert!(none.validate().is_err());
    }

    #[test]
    fn reads_the_last_codex_message_past_its_tools() {
        let events = [
            r#"{"type":"item.started","item":{"type":"command_execution"}}"#,
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"Working on it"}}"#,
            r#"{"type":"item.started","item":{"type":"file_change"}}"#,
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"{\"items\":[]}"}}"#,
            r#"{"type":"turn.completed"}"#,
        ]
        .join("\n");
        assert_eq!(last_codex_message(&events).unwrap(), "{\"items\":[]}");
        assert!(
            last_codex_message(r#"{"type":"turn.failed","error":{"message":"quota"}}"#).is_err()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runs_in_the_directory_and_returns_the_reply() {
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        std::fs::create_dir_all(&work).unwrap();
        // A stand-in CLI that notes where it ran and what it was given, writes a file there,
        // and replies.
        let script = dir.path().join("fake-agent.sh");
        std::fs::write(
            &script,
            "pwd > ran-in\nprintf '%s\\n' \"$@\" > args\ncat > prompt\necho made > made.md\necho done\n",
        )
        .unwrap();
        let agent = AgentConfig {
            command: vec![
                "sh".to_owned(),
                script.to_string_lossy().into_owned(),
                "--dir".to_owned(),
                "{dir}".to_owned(),
            ],
            output: AgentOutput::Text,
        };
        let reply = agent
            .run(
                &spec(),
                &work,
                dir.path(),
                "Write one",
                Duration::from_secs(10),
            )
            .await
            .unwrap();
        assert_eq!(reply, "done");
        let ran_in = std::fs::read_to_string(work.join("ran-in")).unwrap();
        assert_eq!(
            std::path::Path::new(ran_in.trim()).canonicalize().unwrap(),
            work.canonicalize().unwrap()
        );
        assert_eq!(
            std::fs::read_to_string(work.join("prompt")).unwrap(),
            "Write one"
        );
        assert!(
            std::fs::read_to_string(work.join("args"))
                .unwrap()
                .contains(&*work.to_string_lossy())
        );
    }
}
