//! Talking a puzzle through with the discussion model, with its reply streamed as it's written.

use std::time::Duration;

use axum::Json;
use axum::extract::State;
use axum::response::Response;
use serde::Deserialize;
use workshop_provider::{CallSpec, Role};

use super::error::{ApiError, bad_request};
use super::puzzles::puzzle;
use super::replies::Finished;
use super::state::Shared;
use crate::discuss::{self, Turn};
use crate::models;

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
    #[serde(default)]
    notes: String,
    /// What to keep the reply under, so it can be picked up again.
    #[serde(default)]
    reply_id: Option<String>,
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
            notes: &body.notes,
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

    stream_reply(app, provider, spec, prompt, body.reply_id)
}

/// The model's reply, as newline-delimited JSON: `{"delta": text}` as it's written, if the
/// model's CLI reports it, then `{"done": {text, model}}` or `{"error": message}`. Shared by
/// every coach the app talks to. The reply is kept under `id`, if the app gave one, so it can be
/// picked up again from `/replies/{id}` if the connection is lost.
pub(super) fn stream_reply(
    app: Shared,
    provider: String,
    spec: CallSpec,
    prompt: String,
    id: Option<String>,
) -> Result<Response, ApiError> {
    let id = id.unwrap_or_else(super::replies::Replies::unnamed);
    let writer = app.replies.start(&id)?;
    let following = app.replies.follow(&id)?;
    tokio::spawn(async move {
        let (partial, mut parts) = tokio::sync::mpsc::unbounded_channel::<String>();
        // Owns the sender, so the parts end with the call.
        let call = async move {
            app.runners[&provider]
                .call_streaming(&spec, &prompt, DISCUSS_TIMEOUT, Some(&partial))
                .await
        };
        let forward = async {
            while let Some(text) = parts.recv().await {
                writer.delta(&text);
            }
        };
        let (reply, ()) = tokio::join!(call, forward);
        writer.finish(match reply {
            Ok(reply) => Ok(Finished {
                text: reply.text,
                model: reply.model,
            }),
            Err(err) => {
                tracing::warn!("discussing: {err:#}");
                Err(format!("{err:#}"))
            }
        });
    });
    Ok(following)
}
