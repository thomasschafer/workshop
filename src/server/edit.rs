//! Making a spoken or typed change to the code with the edit model.

use std::time::Duration;

use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};

use super::error::ApiResult;
use super::state::Shared;
use crate::edit::{self, EditOutcome};

const EDIT_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Deserialize)]
pub(super) struct EditBody {
    /// The document with the cursor marked by `‸`.
    doc: String,
    utterance: String,
    /// The speech recogniser's pieces, when it revised what it heard.
    #[serde(default)]
    pieces: Vec<String>,
    recent: Option<String>,
    /// Questions the model asked about earlier utterances, which this one answers.
    #[serde(default)]
    earlier: Vec<edit::Exchange>,
}

#[derive(Serialize)]
pub(super) struct Edited {
    #[serde(flatten)]
    outcome: EditOutcome,
    model: Option<String>,
    elapsed_ms: u64,
}

pub(super) async fn edit_code(
    State(app): State<Shared>,
    Json(body): Json<EditBody>,
) -> ApiResult<Edited> {
    let language = app.language();
    // Without them the edit still works, just without knowing to import a helper.
    let helper_definitions = match &language.helpers {
        Some(helpers) => helpers
            .definitions(&app.config.solutions_dir)
            .unwrap_or_else(|err| {
                tracing::warn!("reading the helpers: {err:#}");
                Vec::new()
            }),
        None => Vec::new(),
    };
    let prompt = edit::user_prompt(
        &body.doc,
        edit::Utterance {
            text: &body.utterance,
            pieces: &body.pieces,
        },
        body.recent.as_deref(),
        &body.earlier,
        language.helpers.as_ref().map(|h| edit::Helpers {
            file: &h.file,
            definitions: &helper_definitions,
        }),
    );
    let (runner, spec) = app.edit_target();
    let result = edit::request(runner, &spec, &body.doc, &prompt, EDIT_TIMEOUT).await;
    let (outcome, replies, elapsed_ms) = match &result {
        Ok(r) => (
            match r.outcome {
                EditOutcome::Applied { .. } => "applied",
                EditOutcome::Unsure { .. } => "unsure",
            },
            &r.replies,
            r.elapsed_ms,
        ),
        Err(failed) => ("rejected", &failed.replies, 0),
    };
    tracing::info!(
        utterance = %body.utterance,
        pieces = ?body.pieces,
        recent = ?body.recent,
        earlier = ?body.earlier,
        elapsed_ms,
        reply = %replies.join("\n--- retry ---\n"),
        outcome,
        doc = %body.doc,
        "edit"
    );
    let response = result.map_err(|e| anyhow::anyhow!(e.message))?;
    Ok(Json(Edited {
        outcome: response.outcome,
        model: response.model,
        elapsed_ms: response.elapsed_ms,
    }))
}
