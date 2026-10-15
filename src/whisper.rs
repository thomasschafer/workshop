//! Whisper, from whisper.cpp, running on the server: for dictation, which it hears more
//! accurately than phones' own recognition, and for the benchmark page that compared them.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
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

/// A model to download, and where from.
pub struct ModelSource {
    /// Its file name, which whisper.cpp's models start with `ggml-`.
    pub file: &'static str,
    pub url: &'static str,
}

pub const DICTATION_SOURCE: ModelSource = ModelSource {
    file: "ggml-small.en.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
};

/// Silero's voice activity detection, which tells speech from other sound, so a recording of a
/// quiet room isn't heard as words: Whisper invents some, such as "Silence." or "Thank you.", for
/// sound that isn't speech. About 1 MB.
pub const VAD_SOURCE: ModelSource = ModelSource {
    file: "ggml-silero-v5.1.2.bin",
    url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin",
};

pub const INSTALL_HINT: &str = "Install whisper.cpp on the server, for its whisper-cli program: `brew install whisper-cpp` on macOS, or see https://github.com/ggml-org/whisper.cpp for other systems.";

/// Whisper on this machine: the program, and the models downloaded for it.
pub struct Whisper {
    program: PathBuf,
    /// Model names, such as `small.en`, with their files.
    pub models: Vec<(String, PathBuf)>,
    /// The voice activity detection model, if it's been downloaded.
    pub vad: Option<PathBuf>,
}

/// Where Whisper models live: `ggml-<name>.bin` files, as whisper.cpp names them.
pub fn models_dir(cache_dir: &Path) -> PathBuf {
    cache_dir.join("whisper")
}

impl Whisper {
    /// Whisper, if the program is installed; it may have no models yet.
    pub fn find(cache_dir: &Path) -> Option<Self> {
        Some(Self::with_program(
            crate::doctor::find_program(PROGRAM)?,
            cache_dir,
        ))
    }

    /// Whisper with a given program, and the models in the cache.
    fn with_program(program: PathBuf, cache_dir: &Path) -> Self {
        let mut models: Vec<(String, PathBuf)> = std::fs::read_dir(models_dir(cache_dir))
            .into_iter()
            .flatten()
            .filter_map(|entry| {
                let path = entry.ok()?.path();
                if path.file_name()? == VAD_SOURCE.file {
                    return None;
                }
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
        let vad = Some(models_dir(cache_dir).join(VAD_SOURCE.file)).filter(|p| p.is_file());
        Self {
            program,
            models,
            vad,
        }
    }

    /// The model dictation uses, if it's been downloaded.
    pub fn dictation_model(&self) -> Option<&str> {
        self.models
            .iter()
            .map(|(name, _)| name.as_str())
            .find(|name| *name == DICTATION_MODEL)
    }

    fn model_path(&self, name: &str) -> Option<&Path> {
        self.models
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, path)| path.as_path())
    }

    /// Hears a recording with a model. With `detect_speech`, and the voice activity detection
    /// model downloaded, only what's speech is heard.
    pub async fn transcribe(
        &self,
        wav: &Path,
        model: &str,
        prompt: Option<&str>,
        detect_speech: bool,
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
        if let Some(vad) = self.vad.as_ref().filter(|_| detect_speech) {
            command.arg("--vad").arg("--vad-model").arg(vad);
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
    source: &ModelSource,
    cancel: &CancellationToken,
    log: &InstallLog,
) -> Result<()> {
    let dir = models_dir(cache_dir);
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let file = dir.join(source.file);
    let partial = dir.join(format!("{}.part", source.file));
    let url = source.url;
    log.push(format!("Downloading {url}"));
    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        // Per read, rather than for the whole download, which takes minutes on a slow line.
        .read_timeout(Duration::from_secs(60))
        .build()?;
    let mut response = http
        .get(url)
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

/// whisper.cpp's server, which keeps a model loaded between recordings: about twice as quick
/// as starting whisper-cli for each one, and far quicker than a whisper-cli that has to read the
/// model from disk again after a while.
const SERVER_PROGRAM: &str = "whisper-server";

/// Stopped after this long without dictation, to give back the memory the model takes.
const SERVER_IDLE: Duration = Duration::from_secs(15 * 60);

/// Loading a model the first time can take a while, as it's read from disk.
const SERVER_START_TIMEOUT: Duration = Duration::from_secs(60);

/// Hears dictation with whisper-server, started when it's first needed and stopped when it's
/// been idle a while, or with whisper-cli where whisper-server isn't installed.
#[derive(Default)]
pub struct Dictation {
    server: tokio::sync::Mutex<Option<RunningServer>>,
    /// When dictation was last heard, for stopping the server once it's idle.
    last_used: std::sync::Mutex<Option<Instant>>,
    /// When the server last failed, after which whisper-cli is used for a while rather than
    /// trying the server again for every recording.
    server_failed: std::sync::Mutex<Option<Instant>>,
}

/// How long to use whisper-cli after the server fails, before trying the server again.
const SERVER_RETRY_AFTER: Duration = Duration::from_secs(10 * 60);

fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

struct RunningServer {
    process: process::GroupedChild,
    url: String,
    model: PathBuf,
    vad: Option<PathBuf>,
}

impl RunningServer {
    fn exited(&mut self) -> bool {
        !matches!(self.process.child.try_wait(), Ok(None))
    }
}

impl Dictation {
    /// Starts the server ahead of the first recording, if Whisper is ready, so that one is
    /// heard as quickly as the rest.
    pub async fn warm(self: &std::sync::Arc<Self>, cache_dir: &Path, http: &reqwest::Client) {
        let Some(whisper) = Whisper::find(cache_dir) else {
            return;
        };
        let Some(model) = whisper.model_path(DICTATION_MODEL) else {
            return;
        };
        // Small enough to fetch without asking, for installs that had the model before it.
        if whisper.vad.is_none() {
            let downloaded = download_model(
                cache_dir,
                &VAD_SOURCE,
                &CancellationToken::new(),
                &InstallLog::default(),
            )
            .await;
            match downloaded {
                Ok(()) => tracing::info!("downloaded the voice activity detection model"),
                Err(err) => {
                    tracing::warn!("couldn't download the voice activity detection model: {err:#}")
                }
            }
        }
        let vad = Some(models_dir(cache_dir).join(VAD_SOURCE.file)).filter(|p| p.is_file());
        if crate::doctor::find_program(SERVER_PROGRAM).is_none() || self.server_failed_lately() {
            return;
        }
        if let Err(err) = self.server_url(model, vad.as_deref(), http).await {
            *lock(&self.server_failed) = Some(Instant::now());
            tracing::warn!("couldn't start {SERVER_PROGRAM}: {err:#}");
        }
    }

    /// What was said in a WAV recording.
    pub async fn transcribe(
        self: &std::sync::Arc<Self>,
        whisper: &Whisper,
        wav: Vec<u8>,
        scratch: &Path,
        http: &reqwest::Client,
    ) -> Result<String> {
        *lock(&self.last_used) = Some(Instant::now());
        let model = whisper
            .model_path(DICTATION_MODEL)
            .with_context(|| format!("Whisper's {DICTATION_MODEL} model isn't downloaded yet"))?;
        if crate::doctor::find_program(SERVER_PROGRAM).is_some() && !self.server_failed_lately() {
            match self
                .transcribe_with_server(model, whisper.vad.as_deref(), &wav, http)
                .await
            {
                Ok(text) => return Ok(text),
                Err(err) => {
                    *lock(&self.server_failed) = Some(Instant::now());
                    tracing::warn!(
                        "{SERVER_PROGRAM} couldn't hear the recording, so {PROGRAM} will: {err:#}"
                    );
                }
            }
        }
        self.transcribe_with_cli(whisper, &wav, scratch).await
    }

    fn server_failed_lately(&self) -> bool {
        lock(&self.server_failed).is_some_and(|at| at.elapsed() < SERVER_RETRY_AFTER)
    }

    async fn transcribe_with_server(
        self: &std::sync::Arc<Self>,
        model: &Path,
        vad: Option<&Path>,
        wav: &[u8],
        http: &reqwest::Client,
    ) -> Result<String> {
        // Once more if the server had stopped, such as having crashed, since it was started.
        let mut last_error = None;
        for _ in 0..2 {
            let url = self.server_url(model, vad, http).await?;
            match ask_server(&url, wav, http).await {
                Ok(text) => return Ok(text),
                Err(err) => {
                    self.stop_if_exited().await;
                    last_error = Some(err);
                }
            }
        }
        Err(last_error.unwrap_or_else(|| anyhow::anyhow!("{SERVER_PROGRAM} didn't answer")))
    }

    async fn transcribe_with_cli(
        &self,
        whisper: &Whisper,
        wav: &[u8],
        scratch: &Path,
    ) -> Result<String> {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::fs::create_dir_all(scratch)
            .with_context(|| format!("creating {}", scratch.display()))?;
        let path = scratch.join(format!("{}-{n}.wav", std::process::id()));
        crate::paths::write_atomic(&path, wav)?;
        let transcript = whisper.transcribe(&path, DICTATION_MODEL, None, true).await;
        let _ = std::fs::remove_file(&path);
        Ok(transcript?.text)
    }

    async fn stop_if_exited(&self) {
        let mut server = self.server.lock().await;
        if server.as_mut().is_some_and(RunningServer::exited) {
            *server = None;
        }
    }

    /// The running server's address, starting it first if it isn't running.
    async fn server_url(
        self: &std::sync::Arc<Self>,
        model: &Path,
        vad: Option<&Path>,
        http: &reqwest::Client,
    ) -> Result<String> {
        let mut server = self.server.lock().await;
        if let Some(running) = server.as_mut()
            && !running.exited()
            && running.model == model
            && running.vad.as_deref() == vad
        {
            return Ok(running.url.clone());
        }
        *server = None;
        let running = start_server(model, vad, http).await?;
        let url = running.url.clone();
        *server = Some(running);
        drop(server);
        *lock(&self.last_used) = Some(Instant::now());
        self.stop_when_idle();
        Ok(url)
    }

    /// Stops the server once dictation has been idle a while.
    fn stop_when_idle(self: &std::sync::Arc<Self>) {
        let dictation = std::sync::Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let Some(dictation) = dictation.upgrade() else {
                    return;
                };
                let idle = lock(&dictation.last_used).is_none_or(|at| at.elapsed() >= SERVER_IDLE);
                let mut server = dictation.server.lock().await;
                if server.is_none() {
                    return;
                }
                if idle {
                    tracing::info!("stopping {SERVER_PROGRAM}, as dictation has been idle");
                    if let Some(running) = server.take() {
                        running.process.finish();
                    }
                    return;
                }
            }
        });
    }
}

/// Starts whisper-server on a free port, and waits until it's ready.
async fn start_server(
    model: &Path,
    vad: Option<&Path>,
    http: &reqwest::Client,
) -> Result<RunningServer> {
    let program = crate::doctor::find_program(SERVER_PROGRAM)
        .with_context(|| format!("{SERVER_PROGRAM} isn't installed"))?;
    let port = std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .context("finding a free port for Whisper")?
        .port();
    let started = Instant::now();
    let mut command = process::command(&program);
    if let Some(vad) = vad {
        command.arg("--vad").arg("--vad-model").arg(vad);
    }
    let mut process = process::GroupedChild::spawn(
        command
            .arg("--model")
            .arg(model)
            .args([
                "--host",
                "127.0.0.1",
                "--port",
                &port.to_string(),
                "--no-timestamps",
            ])
            // As whisper-cli decodes by default, which the benchmark measured, rather than the
            // server's quicker but less accurate greedy decoding.
            .args(["--beam-size", "5", "--best-of", "5"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null()),
    )
    .with_context(|| format!("starting {SERVER_PROGRAM}"))?;
    let url = format!("http://127.0.0.1:{port}");
    loop {
        if let Ok(Some(status)) = process.child.try_wait() {
            bail!("{SERVER_PROGRAM} exited as it started ({status})");
        }
        if started.elapsed() > SERVER_START_TIMEOUT {
            bail!(
                "{SERVER_PROGRAM} took longer than {}s to start",
                SERVER_START_TIMEOUT.as_secs()
            );
        }
        if http
            .get(&url)
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
        {
            tracing::info!(
                "started {SERVER_PROGRAM} in {}ms",
                started.elapsed().as_millis()
            );
            return Ok(RunningServer {
                process,
                url,
                model: model.to_owned(),
                vad: vad.map(Path::to_owned),
            });
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn ask_server(url: &str, wav: &[u8], http: &reqwest::Client) -> Result<String> {
    #[derive(Deserialize)]
    struct Answer {
        text: String,
    }
    let form = reqwest::multipart::Form::new()
        .part(
            "file",
            reqwest::multipart::Part::bytes(wav.to_vec())
                .file_name("dictation.wav")
                .mime_str("audio/wav")?,
        )
        .text("response_format", "json");
    let body = http
        .post(format!("{url}/inference"))
        .multipart(form)
        .timeout(TIMEOUT)
        .send()
        .await
        .with_context(|| format!("couldn't reach {SERVER_PROGRAM}"))?
        .error_for_status()
        .with_context(|| format!("{SERVER_PROGRAM} couldn't hear the recording"))?
        .bytes()
        .await?;
    let answer: Answer = serde_json::from_slice(&body)
        .with_context(|| format!("reading {SERVER_PROGRAM}'s answer"))?;
    Ok(answer.text)
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
    fn keeps_the_speech_detection_model_apart_from_whisper_models() {
        let dir = tempfile::tempdir().unwrap();
        let models = models_dir(dir.path());
        std::fs::create_dir_all(&models).unwrap();
        std::fs::write(models.join("ggml-small.en.bin"), "lmgg").unwrap();
        std::fs::write(models.join(VAD_SOURCE.file), "lmgg").unwrap();
        let whisper = Whisper::with_program(PROGRAM.into(), dir.path());
        assert_eq!(whisper.models.len(), 1);
        assert_eq!(whisper.vad, Some(models.join(VAD_SOURCE.file)));
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
            vad: Some(dir.path().join("vad.bin")),
        };
        let transcript = whisper
            .transcribe(Path::new("a.wav"), "tiny", Some("names: part1"), false)
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
        let detecting = whisper
            .transcribe(Path::new("a.wav"), "tiny", None, true)
            .await
            .unwrap();
        assert!(
            detecting.text.contains("--vad --vad-model"),
            "{}",
            detecting.text
        );
        assert!(!transcript.text.contains("--vad"), "{}", transcript.text);
        assert!(
            whisper
                .transcribe(Path::new("a.wav"), "huge", None, false)
                .await
                .is_err()
        );
    }
}
