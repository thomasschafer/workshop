//! Whisper, from whisper.cpp, running on the server: for dictation, which it hears more
//! accurately than phones' own recognition, and for the benchmark page that compared them.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use serde::Serialize;
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

use crate::packages::InstallLog;
use crate::process::{self, ProcessGroup};

/// The Whisper command-line program, from whisper.cpp.
const PROGRAM: &str = "whisper-cli";
const TIMEOUT: Duration = Duration::from_secs(120);

/// The model dictation uses. In the benchmark it heard code best for its speed: about half a
/// second for a sentence on a laptop.
pub const DICTATION_MODEL: &str = "small.en";

/// Its size, for saying how big the download is.
pub const DICTATION_MODEL_MB: u64 = 488;

/// Where whisper.cpp's models are published.
const MODELS_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

pub const INSTALL_HINT: &str = "Install whisper.cpp on the server, for its whisper-cli program: `brew install whisper-cpp` on macOS, or see https://github.com/ggml-org/whisper.cpp for other systems.";

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

    /// The model dictation uses, if it's been downloaded.
    pub fn dictation_model(&self) -> Option<&str> {
        self.models
            .iter()
            .map(|(name, _)| name.as_str())
            .find(|name| *name == DICTATION_MODEL)
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

/// What was said, without Whisper's notes on what it heard: tags such as `[BLANK_AUDIO]`, and a
/// transcript that's only a description, such as `(keyboard clicking)`. Brackets in what was
/// said, such as `(x:xs)`, are kept.
pub fn spoken_text(transcript: &str) -> String {
    let words: Vec<&str> = transcript
        .split_whitespace()
        .filter(|word| {
            let tag = word.strip_prefix('[').and_then(|w| w.strip_suffix(']'));
            !tag.is_some_and(|t| t.chars().all(|c| c.is_ascii_uppercase() || c == '_'))
        })
        .collect();
    let text = words.join(" ");
    // Descriptions are words alone, unlike code.
    let description = text
        .strip_prefix('(')
        .and_then(|t| t.strip_suffix(')'))
        .or_else(|| text.strip_prefix('*').and_then(|t| t.strip_suffix('*')));
    if description.is_some_and(|d| d.len() > 1 && d.chars().all(|c| c.is_alphabetic() || c == ' '))
    {
        return String::new();
    }
    text
}

/// Downloads a model into the models directory, logging progress, and only puts it in place
/// once it's complete.
pub async fn download_model(
    cache_dir: &Path,
    name: &str,
    cancel: &CancellationToken,
    log: &InstallLog,
) -> Result<()> {
    let dir = models_dir(cache_dir);
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let file = dir.join(format!("ggml-{name}.bin"));
    let partial = dir.join(format!("ggml-{name}.bin.part"));
    let url = format!("{MODELS_URL}/ggml-{name}.bin");
    log.push(format!("Downloading {url}"));
    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        // Per read, rather than for the whole download, which takes minutes on a slow line.
        .read_timeout(Duration::from_secs(60))
        .build()?;
    let mut response = http
        .get(&url)
        .send()
        .await
        .context("couldn't reach Hugging Face to download the model")?
        .error_for_status()
        .context("Hugging Face couldn't send the model")?;
    let total = response.content_length();
    let mut out = tokio::fs::File::create(&partial)
        .await
        .with_context(|| format!("creating {}", partial.display()))?;
    let mut received: u64 = 0;
    let mut reported_mb = 0;
    let downloaded = async {
        while let Some(chunk) = response.chunk().await.context("downloading the model")? {
            tokio::io::AsyncWriteExt::write_all(&mut out, &chunk).await?;
            received += chunk.len() as u64;
            let mb = received / 1_000_000;
            if mb >= reported_mb + 10 {
                reported_mb = mb;
                log.push(match total {
                    Some(total) => format!("Downloaded {mb} of {} MB", total / 1_000_000),
                    None => format!("Downloaded {mb} MB"),
                });
            }
        }
        tokio::io::AsyncWriteExt::flush(&mut out).await?;
        anyhow::Ok(())
    };
    let result = tokio::select! {
        result = downloaded => result,
        () = cancel.cancelled() => Err(anyhow::anyhow!("Downloading was cancelled.")),
    };
    drop(out);
    let checked = result.and_then(|()| check_model(&partial, total));
    if let Err(err) = checked {
        let _ = std::fs::remove_file(&partial);
        return Err(err);
    }
    std::fs::rename(&partial, &file)
        .with_context(|| format!("moving the model to {}", file.display()))?;
    log.push(format!("Saved {}", file.display()));
    Ok(())
}

/// Checks a download is whole, and is a whisper.cpp model rather than, say, an error page.
fn check_model(path: &Path, expected_len: Option<u64>) -> Result<()> {
    let len = std::fs::metadata(path)?.len();
    if let Some(expected) = expected_len
        && len != expected
    {
        bail!("the download stopped early, at {len} of {expected} bytes");
    }
    let mut magic = [0u8; 4];
    std::io::Read::read_exact(&mut std::fs::File::open(path)?, &mut magic)
        .context("the download is empty")?;
    // GGML files start with "ggml" as a little-endian number.
    if magic != *b"lmgg" {
        bail!("the download isn't a Whisper model");
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_what_was_said() {
        assert_eq!(spoken_text("[BLANK_AUDIO]"), "");
        assert_eq!(spoken_text(" (keyboard clicking)"), "");
        assert_eq!(
            spoken_text("new line return x [MUSIC]"),
            "new line return x"
        );
        assert_eq!(spoken_text("solve (x:xs) equals"), "solve (x:xs) equals");
        assert_eq!(spoken_text("(x:xs)"), "(x:xs)");
    }

    #[test]
    fn checks_downloaded_models() {
        let dir = tempfile::tempdir().unwrap();
        let model = dir.path().join("ggml-tiny.bin");
        std::fs::write(&model, b"lmgg and the rest").unwrap();
        check_model(&model, Some(17)).unwrap();
        assert!(check_model(&model, Some(18)).is_err());
        std::fs::write(&model, b"<html>Not found</html>").unwrap();
        assert!(check_model(&model, None).is_err());
    }

    #[test]
    fn reads_whisper_timings() {
        let stderr = "whisper_print_timings:     load time =   109.22 ms\nwhisper_print_timings:    total time =   696.05 ms\n";
        assert_eq!(timing(stderr, "load time"), Some(109));
        assert_eq!(timing(stderr, "total time"), Some(696));
        assert_eq!(timing(stderr, "encode time"), None);
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
