//! Dictation with Whisper on the server: whether it's ready, downloading its model, and hearing a
//! recording.

use axum::Json;
use axum::extract::State;
use serde::Serialize;

use super::error::{ApiResult, bad_request};
use super::install::{AfterInstall, InstallStatus, install_with};
use super::state::{App, Shared};

#[derive(Serialize)]
pub(super) struct SpeechState {
    /// Whether dictation can use Whisper: the program and its model are both installed.
    pub(super) ready: bool,
    whisper_installed: bool,
    model: &'static str,
    model_mb: u64,
    model_installed: bool,
    install_hint: &'static str,
    download: InstallStatus,
}

pub(super) fn speech_state(app: &App) -> SpeechState {
    let whisper = crate::whisper::Whisper::find(&app.paths.cache_dir);
    let model_installed = crate::whisper::models_dir(&app.paths.cache_dir)
        .join(format!("ggml-{}.bin", crate::whisper::DICTATION_MODEL))
        .is_file();
    SpeechState {
        ready: whisper
            .as_ref()
            .is_some_and(|w| w.dictation_model().is_some()),
        whisper_installed: whisper.is_some(),
        model: crate::whisper::DICTATION_MODEL,
        model_mb: crate::whisper::DICTATION_MODEL_MB,
        model_installed,
        install_hint: crate::whisper::INSTALL_HINT,
        download: app.speech_install.status(),
    }
}

pub(super) async fn get_speech(State(app): State<Shared>) -> ApiResult<SpeechState> {
    Ok(Json(speech_state(&app)))
}

/// Downloads Whisper's model for dictation.
pub(super) async fn download_speech_model(State(app): State<Shared>) -> ApiResult<SpeechState> {
    install_with(
        &app,
        |app| &app.speech_install,
        AfterInstall::Nothing,
        |app, running| async move {
            for source in [
                &crate::whisper::DICTATION_SOURCE,
                &crate::whisper::VAD_SOURCE,
            ] {
                crate::whisper::download_model(
                    &app.paths.cache_dir,
                    source,
                    &running.cancel,
                    &running.log,
                )
                .await?;
            }
            anyhow::Ok(())
        },
    )
    .await?;
    Ok(Json(speech_state(&app)))
}

pub(super) async fn cancel_speech_download(State(app): State<Shared>) -> ApiResult<()> {
    app.speech_install.cancel();
    Ok(Json(()))
}

/// The largest recording accepted: about eight minutes, at the 32 kB a second the app sends.
pub(super) const RECORDING_LIMIT: usize = 16 * 1024 * 1024;

#[derive(Serialize)]
pub(super) struct Dictated {
    text: String,
}

/// Hears a recording of what was said, with Whisper.
pub(super) async fn transcribe(
    State(app): State<Shared>,
    wav: axum::body::Bytes,
) -> ApiResult<Dictated> {
    if !wav.starts_with(b"RIFF") {
        return Err(bad_request("The recording should be a WAV file."));
    }
    let Some(whisper) = crate::whisper::Whisper::find(&app.paths.cache_dir) else {
        return Err(bad_request(crate::whisper::INSTALL_HINT));
    };
    if whisper.dictation_model().is_none() {
        return Err(bad_request(format!(
            "Whisper's {} model isn't downloaded yet; download it in Settings, under Talking.",
            crate::whisper::DICTATION_MODEL
        )));
    }
    let started = std::time::Instant::now();
    let text = app
        .dictation
        .transcribe(
            &whisper,
            wav.to_vec(),
            &app.paths.cache_dir.join("dictation"),
            &app.http,
        )
        .await?;
    tracing::info!(
        "dictation: heard {text:?} in {}ms",
        started.elapsed().as_millis()
    );
    Ok(Json(Dictated {
        text: crate::whisper::spoken_text(&text),
    }))
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::{StatusCode, header};

    use crate::server::testing::{send, test_app};

    #[tokio::test]
    async fn takes_recordings_of_several_minutes() {
        let (_dir, router) = test_app().await;
        // Four minutes at 16 kHz, 16-bit mono.
        let mut wav = b"RIFF".to_vec();
        wav.resize(4 * 60 * 32_000, 0);
        let request = Request::post("/api/speech/transcribe")
            .header(header::COOKIE, "workshop_token=secret")
            .body(Body::from(wav))
            .unwrap();
        let status = send(&router, request).await.status();
        // Refused for want of Whisper's model, not for its size.
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
}
