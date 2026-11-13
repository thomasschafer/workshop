//! Building and running programs: each in its own process group, with a time limit, keeping the
//! start of what it prints. Also formatting code with a formatter that reads it on stdin.

use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use workshop_common::process::{self, ProcessGroup};
use workshop_common::template::{self, Vars};

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

/// A program to build, if it needs building, and then run on some input.
pub struct Job<'a> {
    /// The build command, as templates of its arguments, if there's a build step.
    pub build: Option<&'a [String]>,
    /// The run command, as templates of its arguments.
    pub run: &'a [String],
    /// The values the commands' `{placeholder}`s are filled with.
    pub vars: &'a Vars<'a>,
    /// Where both commands run.
    pub dir: &'a Path,
    /// What the program reads on stdin.
    pub input: &'a str,
    /// For each command separately.
    pub timeout: Duration,
    pub cancel: &'a CancellationToken,
    /// Extra environment variables, such as where installed packages are.
    pub environment: &'a [(String, String)],
}

/// How a job went: how its build went if that failed, or else how the program ran.
#[derive(Debug, Clone)]
pub struct Outcome {
    /// The phase that produced this outcome: a failed build stops before running.
    pub phase: Phase,
    pub ending: Ending,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
}

impl Outcome {
    pub fn succeeded(&self) -> bool {
        self.phase == Phase::Run && self.ending == Ending::Exited { code: Some(0) }
    }
}

/// Builds the program if it has a build step, then runs it unless the build failed.
pub async fn build_and_run(job: Job<'_>) -> Result<Outcome> {
    let started = Instant::now();
    if let Some(build) = job.build {
        let args = template::render_all(build, job.vars)?;
        let output = execute(
            &args,
            job.dir,
            job.environment,
            None,
            job.timeout,
            job.cancel,
        )
        .await?;
        if output.ending != (Ending::Exited { code: Some(0) }) {
            return Ok(Outcome {
                phase: Phase::Build,
                ending: output.ending,
                stdout: output.stdout,
                stderr: output.stderr,
                duration_ms: elapsed_ms(started),
            });
        }
    }
    let args = template::render_all(job.run, job.vars)?;
    let output = execute(
        &args,
        job.dir,
        job.environment,
        Some(job.input),
        job.timeout,
        job.cancel,
    )
    .await?;
    Ok(Outcome {
        phase: Phase::Run,
        ending: output.ending,
        stdout: output.stdout,
        stderr: output.stderr,
        duration_ms: elapsed_ms(started),
    })
}

/// How long a formatter has, which only takes long if something's wrong.
const FORMAT_TIMEOUT: Duration = Duration::from_secs(10);

/// Formats `code` with a formatter that reads it on stdin and writes it to stdout, failing with
/// what the formatter says if it can't, as for code that doesn't parse.
pub async fn format(
    args: &[String],
    dir: &Path,
    environment: &[(String, String)],
    code: &str,
) -> Result<String> {
    let (program, rest) = args.split_first().context("empty formatter command")?;
    let mut command = process::command(program);
    command
        .args(rest)
        .envs(environment.iter().map(|(k, v)| (k, v)))
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = process::GroupedChild::spawn(&mut command)
        .with_context(|| format!("starting `{program}`; is it installed and on your PATH?"))?;
    let mut stdin = child.child.stdin.take().context("stdin not captured")?;
    let mut stdout = child.child.stdout.take().context("stdout not captured")?;
    let mut stderr = child.child.stderr.take().context("stderr not captured")?;
    let (mut formatted, mut complaint) = (String::new(), String::new());
    let finished = tokio::time::timeout(FORMAT_TIMEOUT, async {
        let write = async {
            stdin.write_all(code.as_bytes()).await?;
            // Closing stdin tells the formatter the code's all there.
            drop(stdin);
            std::io::Result::Ok(())
        };
        tokio::try_join!(
            write,
            stdout.read_to_string(&mut formatted),
            stderr.read_to_string(&mut complaint),
        )?;
        child.child.wait().await
    })
    .await;
    let status = match finished {
        Ok(status) => status.with_context(|| format!("running `{program}`"))?,
        Err(_) => {
            child.finish();
            bail!("`{program}` took longer than {}s", FORMAT_TIMEOUT.as_secs());
        }
    };
    child.finish();
    if !status.success() {
        bail!("`{program}` couldn't format the code: {}", complaint.trim());
    }
    Ok(formatted)
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
    // Otherwise starting fails as though the program were missing.
    if !dir.is_dir() {
        bail!("{} doesn't exist", dir.display());
    }
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

    async fn run_script(build: Option<&[&str]>, script: &str, timeout: Duration) -> Outcome {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("program.sh");
        std::fs::write(&file, script).unwrap();
        let build: Option<Vec<String>> = build.map(|b| b.iter().map(|s| (*s).to_owned()).collect());
        let run = vec!["sh".to_owned(), "{file}".to_owned()];
        let vars = Vars::new().set("file", file.to_string_lossy());
        let cancel = CancellationToken::new();
        build_and_run(Job {
            build: build.as_deref(),
            run: &run,
            vars: &vars,
            dir: dir.path(),
            input: "7\n",
            timeout,
            cancel: &cancel,
            environment: &[(
                "WORKSHOP_TEST".to_owned(),
                "from the environment".to_owned(),
            )],
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn passes_input_and_the_environment() {
        let outcome = run_script(
            Some(&[
                "sh",
                "-c",
                "test \"$WORKSHOP_TEST\" = 'from the environment'",
            ]),
            "read a; echo \"$a $WORKSHOP_TEST\"; echo oops >&2",
            Duration::from_secs(10),
        )
        .await;
        assert!(outcome.succeeded(), "{outcome:?}");
        assert_eq!(outcome.stdout, "7 from the environment\n");
        assert_eq!(outcome.stderr.trim(), "oops");
    }

    #[tokio::test]
    async fn stops_at_failed_build() {
        let outcome = run_script(
            Some(&["sh", "-c", "echo bad >&2; exit 3"]),
            "echo 1",
            Duration::from_secs(10),
        )
        .await;
        assert_eq!(outcome.phase, Phase::Build);
        assert_eq!(outcome.ending, Ending::Exited { code: Some(3) });
        assert_eq!(outcome.stderr.trim(), "bad");
        assert!(outcome.stdout.is_empty());
    }

    #[tokio::test]
    async fn times_out_promptly_even_with_background_processes() {
        let started = Instant::now();
        let outcome = run_script(None, "sleep 30 & sleep 30", Duration::from_millis(200)).await;
        assert_eq!(outcome.ending, Ending::TimedOut);
        assert!(!outcome.succeeded());
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn cancellation_before_starting_still_cancels() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let output = execute(
            &["sh".to_owned(), "-c".to_owned(), "sleep 30".to_owned()],
            dir.path(),
            &[],
            None,
            Duration::from_secs(30),
            &cancel,
        )
        .await
        .unwrap();
        assert_eq!(output.ending, Ending::Cancelled);
    }

    #[tokio::test]
    async fn truncates_huge_output() {
        let outcome = run_script(None, "yes | head -c 200000", Duration::from_secs(10)).await;
        assert!(outcome.stdout.ends_with("output truncated"));
        assert!(outcome.stdout.len() < MAX_OUTPUT_BYTES + 100);
    }

    #[tokio::test]
    async fn says_when_the_directory_is_missing_rather_than_the_program() {
        let err = execute(
            &["sh".to_owned(), "-c".to_owned(), "true".to_owned()],
            Path::new("/definitely/not/a/dir"),
            &[],
            None,
            Duration::from_secs(5),
            &CancellationToken::new(),
        )
        .await
        .err()
        .expect("running in a missing directory should fail")
        .to_string();
        assert!(err.contains("/definitely/not/a/dir doesn't exist"), "{err}");
    }

    #[tokio::test]
    async fn reports_missing_programs() {
        let dir = tempfile::tempdir().unwrap();
        let err = execute(
            &["definitely-not-a-real-program-xyz".to_owned()],
            dir.path(),
            &[],
            None,
            Duration::from_secs(1),
            &CancellationToken::new(),
        )
        .await
        .err()
        .expect("a missing program should fail");
        assert!(format!("{err:#}").contains("is it installed"));
    }

    #[tokio::test]
    async fn formats_code_through_stdin_and_stdout_in_full() {
        let dir = tempfile::tempdir().unwrap();
        // Longer than a run's output is cut to, which formatted code mustn't be.
        let code = "x = 1\n".repeat(20_000);
        let args = ["tr", "x", "y"].map(str::to_owned);
        let formatted = format(&args, dir.path(), &[], &code).await.unwrap();
        assert_eq!(formatted, code.replace('x', "y"));
    }

    #[tokio::test]
    async fn says_why_code_could_not_be_formatted() {
        let dir = tempfile::tempdir().unwrap();
        let args = [
            "sh",
            "-c",
            "cat >/dev/null; echo 'line 3: unexpected indent' >&2; exit 2",
        ]
        .map(str::to_owned);
        let err = format(&args, dir.path(), &[], "x").await.unwrap_err();
        assert!(
            format!("{err:#}").contains("line 3: unexpected indent"),
            "{err:#}"
        );
    }

    #[tokio::test]
    async fn says_when_a_formatter_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let args = ["workshop-no-such-formatter".to_owned()];
        let err = format(&args, dir.path(), &[], "x").await.unwrap_err();
        assert!(format!("{err:#}").contains("is it installed"), "{err:#}");
    }
}
