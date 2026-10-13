//! Comparing speech recognition, for the benchmark page: the phone's own recognition against
//! Whisper running on this machine, on the same recordings.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use serde::Serialize;
use tokio::io::AsyncReadExt;

use crate::process::{self, ProcessGroup};

/// The Whisper command-line program, from whisper.cpp.
const PROGRAM: &str = "whisper-cli";
const TIMEOUT: Duration = Duration::from_secs(120);

/// Whisper on this machine: the program, and the models downloaded for it.
pub struct Whisper {
    program: PathBuf,
    /// Model names, such as `small.en`, with their files.
    pub models: Vec<(String, PathBuf)>,
}

/// Where Whisper models live: `ggml-<name>.bin` files, as whisper.cpp names them.
pub fn models_dir(cache_dir: &Path) -> PathBuf {
    cache_dir.join("whisper")
}

impl Whisper {
    /// Whisper, if the program is installed; it may have no models yet.
    pub fn find(cache_dir: &Path) -> Option<Self> {
        let program = crate::doctor::find_program(PROGRAM)?;
        let mut models: Vec<(String, PathBuf)> = std::fs::read_dir(models_dir(cache_dir))
            .into_iter()
            .flatten()
            .filter_map(|entry| {
                let path = entry.ok()?.path();
                let name = path
                    .file_name()?
                    .to_str()?
                    .strip_prefix("ggml-")?
                    .strip_suffix(".bin")?
                    .to_owned();
                Some((name, path))
            })
            .collect();
        // Smallest first, so results read from fastest to most capable.
        models.sort_by_key(|(_, path)| std::fs::metadata(path).map(|m| m.len()).unwrap_or(0));
        Some(Self { program, models })
    }

    pub async fn transcribe(
        &self,
        wav: &Path,
        model: &str,
        prompt: Option<&str>,
    ) -> Result<Transcript> {
        let (name, path) = self
            .models
            .iter()
            .find(|(name, _)| name == model)
            .with_context(|| format!("no Whisper model called {model}"))?;
        let mut command = process::command(&self.program);
        command
            .arg("--model")
            .arg(path)
            .arg("--file")
            .arg(wav)
            .arg("--no-timestamps")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(prompt) = prompt {
            command.arg("--prompt").arg(prompt);
        }
        let started = Instant::now();
        let mut child = command
            .spawn()
            .with_context(|| format!("starting {PROGRAM}"))?;
        let group = ProcessGroup::of(&child);
        let mut stdout = child.stdout.take().context("stdout not captured")?;
        let mut stderr = child.stderr.take().context("stderr not captured")?;
        let read = async {
            let (mut out, mut err) = (String::new(), String::new());
            let (a, b) = tokio::join!(
                stdout.read_to_string(&mut out),
                stderr.read_to_string(&mut err)
            );
            a?;
            b?;
            anyhow::Ok((out, err))
        };
        let ((out, err), status) = match tokio::time::timeout(TIMEOUT, async {
            let output = read.await?;
            anyhow::Ok((output, child.wait().await?))
        })
        .await
        {
            Ok(result) => result?,
            Err(_) => {
                group.kill();
                bail!("{PROGRAM} took longer than {}s", TIMEOUT.as_secs());
            }
        };
        group.finish();
        if !status.success() {
            bail!("{PROGRAM} failed ({status}): {}", last_line(&err));
        }
        let wall_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        Ok(Transcript {
            model: name.clone(),
            prompted: prompt.is_some(),
            text: out.split_whitespace().collect::<Vec<_>>().join(" "),
            wall_ms,
            load_ms: timing(&err, "load time"),
            total_ms: timing(&err, "total time"),
        })
    }
}

/// What one model heard, and how long it took.
#[derive(Debug, Serialize)]
pub struct Transcript {
    pub model: String,
    /// Whether it was primed with the code's vocabulary.
    pub prompted: bool,
    pub text: String,
    /// From starting the program to its answer, model loading included.
    pub wall_ms: u64,
    /// Loading the model, which a long-running Whisper would do once rather than every time.
    pub load_ms: Option<u64>,
    /// Whisper's own total, model loading included.
    pub total_ms: Option<u64>,
}

/// A timing from whisper.cpp's summary, such as `whisper_print_timings: load time = 109.22 ms`.
fn timing(stderr: &str, name: &str) -> Option<u64> {
    stderr.lines().find_map(|line| {
        let (_, rest) = line.split_once(&format!("{name} ="))?;
        let ms: f64 = rest.split_whitespace().next()?.parse().ok()?;
        // Rounded to a whole millisecond; fractions are noise here.
        Some(ms.round() as u64)
    })
}

fn last_line(text: &str) -> &str {
    text.lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
}

/// A benchmark session's id, which names a directory, so only plain characters are allowed.
pub fn check_session(id: &str) -> Result<()> {
    let valid = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !valid {
        bail!("{id:?} isn't a benchmark session id");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_whisper_timings() {
        let stderr = "whisper_print_timings:     load time =   109.22 ms\nwhisper_print_timings:    total time =   696.05 ms\n";
        assert_eq!(timing(stderr, "load time"), Some(109));
        assert_eq!(timing(stderr, "total time"), Some(696));
        assert_eq!(timing(stderr, "encode time"), None);
    }

    #[test]
    fn accepts_only_plain_session_ids() {
        check_session("2026-10-13-1650").unwrap();
        for bad in ["", "../x", "a/b", "a b"] {
            assert!(check_session(bad).is_err(), "{bad}");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn transcribes_with_a_stand_in_whisper() {
        let dir = tempfile::tempdir().unwrap();
        // Prints what it was asked, as whisper-cli prints its transcript and timings.
        let program = dir.path().join("whisper-cli");
        std::fs::write(
            &program,
            "#!/bin/sh\necho \" heard $*\"\necho 'whisper_print_timings:     load time =   12.40 ms' >&2\n",
        )
        .unwrap();
        std::fs::set_permissions(
            &program,
            std::os::unix::fs::PermissionsExt::from_mode(0o755),
        )
        .unwrap();
        let whisper = Whisper {
            program,
            models: vec![("tiny".into(), dir.path().join("ggml-tiny.bin"))],
        };
        let transcript = whisper
            .transcribe(Path::new("a.wav"), "tiny", Some("names: part1"))
            .await
            .unwrap();
        assert!(
            transcript.text.starts_with("heard --model"),
            "{}",
            transcript.text
        );
        assert!(
            transcript.text.ends_with("--prompt names: part1"),
            "{}",
            transcript.text
        );
        assert!(transcript.prompted);
        assert_eq!(transcript.load_ms, Some(12));
        assert!(
            whisper
                .transcribe(Path::new("a.wav"), "huge", None)
                .await
                .is_err()
        );
    }
}
