//! Talking a puzzle through with the discussion model, with its reply streamed as it's written.

use std::time::Duration;

use axum::Json;
use axum::body::Body;
use axum::extract::State;
use axum::http::header;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};

use super::error::{ApiError, bad_request};
use super::puzzles::puzzle;
use super::state::Shared;
use crate::discuss::{self, Turn};
use crate::models;
use crate::provider::Role;

const DISCUSS_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Deserialize)]
pub(super) struct DiscussBody {
    year: u16,
    day: u8,
    model: String,
    turns: Vec<Turn>,
    code: String,
    #[serde(default)]
    errors: String,
    #[serde(default)]
    last_run: String,
}

#[derive(Serialize)]
struct Discussed {
    text: String,
    model: Option<String>,
}

/// Replies to the discussion, as newline-delimited JSON: `{"delta": text}` as the reply is
/// written, if the model's CLI reports it, then `{"done": {text, model}}` or `{"error": message}`.
pub(super) async fn discuss(
    State(app): State<Shared>,
    Json(body): Json<DiscussBody>,
) -> Result<Response, ApiError> {
    let provider = app.model_settings().discuss_provider;
    if !models::discuss_models(&app.config, &provider).contains(&body.model) {
        return Err(bad_request(format!(
            "{:?} isn't one of the discussion models for {provider}",
            body.model
        )));
    }
    let puzzle = puzzle(body.year, body.day)?;
    // Only a cached puzzle is used; discussing shouldn't make requests to Advent of Code.
    let problem = app.aoc.cached_problem(puzzle)?;
    let language = app.language();
    let helpers = match &language.helpers {
        Some(helpers) => std::fs::read_to_string(app.config.solutions_dir.join(&helpers.file))
            .ok()
            .map(|text| (helpers.file.clone(), text)),
        None => None,
    };
    let packages = match app.solutions().await?.packages() {
        Some(packages) => packages.state()?.installed.unwrap_or_default(),
        None => Vec::new(),
    };
    let prompt = discuss::prompt(
        &discuss::Context {
            language: &language.name,
            problem: problem.as_ref().map(|p| p.text.as_str()),
            code: &body.code,
            errors: &body.errors,
            last_run: &body.last_run,
            helpers: helpers
                .as_ref()
                .map(|(path, text)| (path.as_str(), text.as_str())),
            packages: &packages,
        },
        &body.turns,
    );
    let spec = app.config.providers[&provider].spec(
        Role::Discuss,
        &body.model,
        discuss::SYSTEM_PROMPT.to_owned(),
    );

    let (lines, receiver) = tokio::sync::mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        let (partial, mut parts) = tokio::sync::mpsc::unbounded_channel::<String>();
        let forward = {
            let lines = lines.clone();
            tokio::spawn(async move {
                while let Some(text) = parts.recv().await {
                    // The phone may have gone; the reply is still finished, just not shown.
                    let _ = lines.send(serde_json::json!({ "delta": text }).to_string());
                }
            })
        };
        let reply = app.runners[&provider]
            .call_streaming(&spec, &prompt, DISCUSS_TIMEOUT, Some(&partial))
            .await;
        drop(partial);
        let _ = forward.await;
        let last = match reply {
            Ok(reply) => {
                serde_json::json!({ "done": Discussed { text: reply.text, model: reply.model } })
            }
            Err(err) => {
                tracing::warn!("discussing: {err:#}");
                serde_json::json!({ "error": format!("{err:#}") })
            }
        };
        let _ = lines.send(last.to_string());
    });
    let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
        let line = receiver.recv().await?;
        Some((
            Ok::<_, std::convert::Infallible>(format!("{line}\n")),
            receiver,
        ))
    });
    Ok((
        [
            (header::CONTENT_TYPE, "application/x-ndjson"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        Body::from_stream(stream),
    )
        .into_response())
}
