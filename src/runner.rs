//! Building and running solutions.

use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use crate::language::{LanguageProfile, Puzzle};
use crate::process::{self, ProcessGroup};
use crate::template::{self, Vars};

/// Output beyond this is dropped, so a runaway print loop can't exhaust memory or the phone.
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
/// How long to wait for output after the program has ended. Only a process that escaped its
/// process group could keep the pipes open longer.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Build,
    Run,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Ending {
    Exited { code: Option<i32> },
    TimedOut,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunResult {
    /// The phase that produced this result: a failed build stops before running.
    pub phase: Phase,
    pub ending: Ending,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    /// Non-empty stdout lines; line N is the answer to part N.
    pub answers: Vec<String>,
}

#[cfg(test)]
impl RunResult {
    pub fn succeeded(&self) -> bool {
        self.phase == Phase::Run && self.ending == Ending::Exited { code: Some(0) }
    }
}

pub struct RunRequest<'a> {
    pub profile: &'a LanguageProfile,
    pub file: &'a Path,
    pub build_dir: &'a Path,
    pub puzzle: Puzzle,
    pub input: &'a str,
    pub timeout: Duration,
    pub cancel: &'a CancellationToken,
    /// Extra environment variables, such as where installed packages are.
    pub environment: &'a [(String, String)],
    /// The directory of the user's shared helpers, for the `{helpers}` placeholder.
    pub helpers: Option<&'a Path>,
}

pub async fn run(request: RunRequest<'_>) -> Result<RunResult> {
    let started = Instant::now();
    std::fs::create_dir_all(request.build_dir)
        .with_context(|| format!("creating {}", request.build_dir.display()))?;
    let dir = request
        .file
        .parent()
        .context("solution file has no parent directory")?;
    let mut vars = Vars::new()
        .set("file", request.file.to_string_lossy())
        .set("dir", dir.to_string_lossy())
        .set("build_dir", request.build_dir.to_string_lossy())
        .set("year", request.puzzle.year.to_string())
        .set("day", request.puzzle.day.to_string());
    if let Some(helpers) = request.helpers {
        vars = vars.set("helpers", helpers.to_string_lossy());
    }

    if let Some(build) = &request.profile.build {
        let args = template::render_all(build, &vars)?;
        let output = execute(
            &args,
            dir,
            request.environment,
            None,
            request.timeout,
            request.cancel,
        )
        .await?;
        if output.ending != (Ending::Exited { code: Some(0) }) {
            return Ok(RunResult {
                phase: Phase::Build,
                ending: output.ending,
                stdout: output.stdout,
                stderr: output.stderr,
                duration_ms: elapsed_ms(started),
                answers: Vec::new(),
            });
        }
    }

    let args = template::render_all(&request.profile.run, &vars)?;
    let output = execute(
        &args,
        dir,
        request.environment,
        Some(request.input),
        request.timeout,
        request.cancel,
    )
    .await?;
    let answers = output
        .stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect();
    Ok(RunResult {
        phase: Phase::Run,
        ending: output.ending,
        stdout: output.stdout,
        stderr: output.stderr,
        duration_ms: elapsed_ms(started),
        answers,
    })
}

pub struct Output {
    pub ending: Ending,
    pub stdout: String,
    pub stderr: String,
}

/// Runs a command in its own process group, with a time limit, keeping the start of its output.
pub async fn execute(
    args: &[String],
    dir: &Path,
    environment: &[(String, String)],
    stdin: Option<&str>,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<Output> {
    let (program, rest) = args.split_first().context("empty command")?;
    let mut child = process::command(program)
        .args(rest)
        .envs(environment.iter().map(|(k, v)| (k, v)))
        .current_dir(dir)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("starting `{program}`; is it installed and on your PATH?"))?;
    let group = ProcessGroup::of(&child);

    let stdin_task = match (child.stdin.take(), stdin) {
        (Some(mut pipe), Some(input)) => {
            let input = input.to_owned();
            Some(tokio::spawn(async move {
                // The program may exit without reading all its input, which is fine.
                let _ = pipe.write_all(input.as_bytes()).await;
            }))
        }
        _ => None,
    };
    let stdout = read_limited(child.stdout.take().context("stdout not captured")?);
    let stderr = read_limited(child.stderr.take().context("stderr not captured")?);
    let stdout = tokio::spawn(stdout);
    let stderr = tokio::spawn(stderr);

    let ending = tokio::select! {
        status = child.wait() => Ending::Exited { code: status?.code() },
        () = tokio::time::sleep(timeout) => Ending::TimedOut,
        () = cancel.cancelled() => Ending::Cancelled,
    };
    // Also stops anything the program left running in the background.
    group.kill();
    child.wait().await?;
    group.finish();
    if let Some(task) = stdin_task {
        task.abort();
    }
    Ok(Output {
        ending,
        stdout: drain(stdout).await?,
        stderr: drain(stderr).await?,
    })
}

async fn drain(task: tokio::task::JoinHandle<Result<String>>) -> Result<String> {
    let abort = task.abort_handle();
    match tokio::time::timeout(DRAIN_TIMEOUT, task).await {
        Ok(output) => output?,
        Err(_) => {
            abort.abort();
            Ok("… output cut off: a process the program started kept running".to_owned())
        }
    }
}

async fn read_limited(mut reader: impl AsyncReadExt + Unpin) -> Result<String> {
    let mut kept = Vec::new();
    let mut buf = [0u8; 8192];
    let mut truncated = false;
    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        let room = MAX_OUTPUT_BYTES.saturating_sub(kept.len());
        kept.extend_from_slice(&buf[..n.min(room)]);
        truncated |= n > room;
    }
    let mut text = String::from_utf8_lossy(&kept).into_owned();
    if truncated {
        text.push_str("\n… output truncated");
    }
    Ok(text)
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn profile(build: Option<&[&str]>, run: &[&str]) -> LanguageProfile {
        LanguageProfile {
            name: "Shell".into(),
            editor_mode: "shell".into(),
            lsp_language_id: "shellscript".into(),
            file: "{year}/{day}.sh".into(),
            build: build.map(|b| b.iter().map(|s| (*s).to_owned()).collect()),
            run: run.iter().map(|s| (*s).to_owned()).collect(),
            lsp: None,
            template: String::new(),
            dictation_hints: String::new(),
            packages: None,
            helpers: None,
            start_part_two: None,
            toolchain: None,
        }
    }

    async fn run_with(
        profile: &LanguageProfile,
        script: &str,
        input: &str,
        timeout: Duration,
    ) -> RunResult {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("solution.sh");
        std::fs::write(&file, script).unwrap();
        let cancel = CancellationToken::new();
        run(RunRequest {
            profile,
            file: &file,
            build_dir: &dir.path().join("build"),
            puzzle: Puzzle::new(2017, 1).unwrap(),
            input,
            timeout,
            cancel: &cancel,
            environment: &[(
                "WORKSHOP_TEST".to_owned(),
                "from the environment".to_owned(),
            )],
            helpers: None,
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn passes_input_and_reads_answers() {
        let profile = profile(None, &["sh", "{file}"]);
        let result = run_with(
            &profile,
            "read a; echo \"$a\"; echo; echo 42; echo oops >&2",
            "7\n",
            Duration::from_secs(10),
        )
        .await;
        assert!(result.succeeded());
        assert_eq!(result.answers, vec!["7", "42"]);
        assert_eq!(result.stderr.trim(), "oops");
    }

    #[tokio::test]
    async fn builds_and_runs_with_the_given_environment() {
        let profile = profile(
            Some(&[
                "sh",
                "-c",
                "test \"$WORKSHOP_TEST\" = 'from the environment'",
            ]),
            &["sh", "{file}"],
        );
        let result = run_with(
            &profile,
            "echo \"$WORKSHOP_TEST\"",
            "",
            Duration::from_secs(10),
        )
        .await;
        assert!(result.succeeded(), "{result:?}");
        assert_eq!(result.answers, vec!["from the environment"]);
    }

    #[tokio::test]
    async fn stops_at_failed_build() {
        let profile = profile(
            Some(&["sh", "-c", "echo bad >&2; exit 3"]),
            &["sh", "{file}"],
        );
        let result = run_with(&profile, "echo 1", "", Duration::from_secs(10)).await;
        assert_eq!(result.phase, Phase::Build);
        assert_eq!(result.ending, Ending::Exited { code: Some(3) });
        assert_eq!(result.stderr.trim(), "bad");
        assert!(result.answers.is_empty());
    }

    #[tokio::test]
    async fn times_out_promptly_even_with_background_processes() {
        let profile = profile(None, &["sh", "{file}"]);
        let started = Instant::now();
        let result = run_with(
            &profile,
            "sleep 30 & sleep 30",
            "",
            Duration::from_millis(200),
        )
        .await;
        assert_eq!(result.ending, Ending::TimedOut);
        assert!(!result.succeeded());
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn cancellation_before_starting_still_cancels() {
        let profile = profile(None, &["sh", "{file}"]);
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("solution.sh");
        std::fs::write(&file, "sleep 30").unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let result = run(RunRequest {
            profile: &profile,
            file: &file,
            build_dir: &dir.path().join("build"),
            puzzle: Puzzle::new(2017, 1).unwrap(),
            input: "",
            timeout: Duration::from_secs(30),
            cancel: &cancel,
            environment: &[],
            helpers: None,
        })
        .await
        .unwrap();
        assert_eq!(result.ending, Ending::Cancelled);
    }

    #[tokio::test]
    async fn truncates_huge_output() {
        let profile = profile(None, &["sh", "{file}"]);
        let result = run_with(
            &profile,
            "yes | head -c 200000",
            "",
            Duration::from_secs(10),
        )
        .await;
        assert!(result.stdout.ends_with("output truncated"));
        assert!(result.stdout.len() < MAX_OUTPUT_BYTES + 100);
    }

    #[tokio::test]
    async fn reports_missing_programs() {
        let profile = profile(None, &["definitely-not-a-real-program-xyz"]);
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("s");
        std::fs::write(&file, "").unwrap();
        let cancel = CancellationToken::new();
        let err = run(RunRequest {
            profile: &profile,
            file: &file,
            build_dir: dir.path(),
            puzzle: Puzzle::new(2017, 1).unwrap(),
            input: "",
            timeout: Duration::from_secs(1),
            cancel: &cancel,
            environment: &[],
            helpers: None,
        })
        .await
        .unwrap_err();
        assert!(format!("{err:#}").contains("is it installed"));
    }
}
