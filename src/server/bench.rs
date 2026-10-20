//! Comparing Whisper's models on the user's own speech: recordings are kept per session, with
//! each phrase's results.

use anyhow::{Context, Result};
use axum::Json;
use axum::extract::{Query, State};
use serde::{Deserialize, Serialize};

use super::error::{ApiError, ApiResult, bad_request};
use super::state::{App, Shared};

#[derive(Serialize)]
pub(super) struct BenchInfo {
    whisper_installed: bool,
    /// The Whisper models downloaded, smallest first.
    models: Vec<String>,
    /// Where to put models: whisper.cpp's `ggml-<name>.bin` files.
    models_dir: String,
}

pub(super) async fn bench_info(State(app): State<Shared>) -> ApiResult<BenchInfo> {
    let whisper = crate::whisper::Whisper::find(&app.paths.cache_dir);
    Ok(Json(BenchInfo {
        whisper_installed: whisper.is_some(),
        models: whisper
            .map(|w| w.models.into_iter().map(|(name, _)| name).collect())
            .unwrap_or_default(),
        models_dir: crate::whisper::models_dir(&app.paths.cache_dir)
            .display()
            .to_string(),
    }))
}

/// A benchmark session's id, which names a directory, so only plain characters are allowed.
fn check_session(id: &str) -> Result<()> {
    let valid = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !valid {
        anyhow::bail!("{id:?} isn't a benchmark session id");
    }
    Ok(())
}

fn bench_dir(app: &App, session: &str) -> Result<std::path::PathBuf, ApiError> {
    check_session(session).map_err(|e| bad_request(format!("{e:#}")))?;
    let dir = app.paths.data_dir.join("bench").join(session);
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    Ok(dir)
}

#[derive(Deserialize)]
pub(super) struct BenchTranscribe {
    session: String,
    phrase: u32,
    /// What to prime Whisper with, such as the code's vocabulary.
    prompt: String,
}

/// Transcribes a recording with every Whisper model, with and without the prompt, keeping the
/// recording so it can be listened to and run again later.
pub(super) async fn bench_transcribe(
    State(app): State<Shared>,
    Query(query): Query<BenchTranscribe>,
    wav: axum::body::Bytes,
) -> ApiResult<Vec<crate::whisper::Transcript>> {
    if !wav.starts_with(b"RIFF") {
        return Err(bad_request("The recording should be a WAV file."));
    }
    let Some(whisper) = crate::whisper::Whisper::find(&app.paths.cache_dir) else {
        return Err(bad_request(crate::whisper::INSTALL_HINT));
    };
    let path = bench_dir(&app, &query.session)?.join(format!("{:02}.wav", query.phrase));
    crate::paths::write_atomic(&path, &wav)?;
    let mut transcripts = Vec::new();
    // One at a time, so the timings aren't skewed by models competing for the GPU.
    for (model, _) in &whisper.models {
        for prompt in [None, Some(query.prompt.as_str())] {
            // As each model hears it, without help telling speech from silence.
            transcripts.push(whisper.transcribe(&path, model, prompt, false).await?);
        }
    }
    Ok(Json(transcripts))
}

/// Appends a phrase's results to the session's file.
pub(super) async fn bench_result(
    State(app): State<Shared>,
    Json(result): Json<serde_json::Value>,
) -> ApiResult<()> {
    let session = result
        .get("session")
        .and_then(|s| s.as_str())
        .ok_or_else(|| bad_request("The result needs its session."))?;
    let path = bench_dir(&app, session)?.join("results.jsonl");
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .with_context(|| format!("opening {}", path.display()))?;
    writeln!(file, "{result}").with_context(|| format!("writing {}", path.display()))?;
    Ok(Json(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_plain_session_ids() {
        check_session("2026-10-13-1650").unwrap();
        for bad in ["", "../x", "a/b", "a b"] {
            assert!(check_session(bad).is_err(), "{bad}");
        }
    }
}
