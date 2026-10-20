//! What the app itself needs from the server: everything it starts with, remembering where the
//! user is, checking the server can be reached, and recording what happened on the phone.

use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};

use super::error::ApiResult;
use super::lsp::file_uri;
use super::settings::{ModelsState, models_state, theme_css};
use super::speech::speech_state;
use super::state::Shared;
use crate::config::Snippet;
use crate::models;
use crate::toolchain::Toolchain;
use crate::workspace::UiState;

#[derive(Serialize)]
pub(super) struct Bootstrap {
    state: UiState,
    language: LanguageInfo,
    snippets: Vec<Snippet>,
    models: ModelsState,
    has_aoc_session: bool,
    /// Whether to show setup straight away, because something essential is missing.
    needs_setup: bool,
    /// Overrides Workshop's colours with the chosen terminal themes.
    theme_css: Option<String>,
    commit_after_star: bool,
    /// Whether Whisper on the server is ready to hear dictation.
    server_dictation: bool,
    /// Where solutions are saved, as shown to the user.
    solutions_dir: String,
    /// The private leaderboard shown, if one is chosen.
    leaderboard: Option<crate::aoc::LeaderboardId>,
    /// A newer release, if one is out.
    update: Option<crate::updates::Update>,
}

#[derive(Serialize)]
struct LanguageInfo {
    id: String,
    name: String,
    editor_mode: String,
    lsp_language_id: String,
    has_lsp: bool,
    root_uri: String,
    lsp_options: Option<serde_json::Value>,
    /// For recognising a missing package in errors, if the language has packages.
    packages: Option<PackageHints>,
    start_part_two: Option<crate::language::TextSwap>,
}

#[derive(Serialize)]
struct PackageHints {
    missing_module: Vec<String>,
    missing_package: Vec<String>,
}

pub(super) async fn bootstrap(State(app): State<Shared>) -> ApiResult<Bootstrap> {
    let language = app.language();
    // A toolchain that can't be read shouldn't stop the app loading; the checks report it.
    let toolchain = match app.solutions().await {
        Ok(solutions) => solutions.toolchain,
        Err(err) => {
            tracing::warn!("{err:#}");
            Toolchain::default()
        }
    };
    let has_lsp = language
        .lsp
        .as_ref()
        .and_then(|c| c.first())
        .is_some_and(|p| toolchain.find_program(p).is_some());
    Ok(Json(Bootstrap {
        state: app.workspace.load_ui_state()?,
        language: LanguageInfo {
            id: app.settings().language,
            name: language.name.clone(),
            editor_mode: language.editor_mode.clone(),
            lsp_language_id: language.lsp_language_id.clone(),
            has_lsp,
            root_uri: file_uri(&app.config.solutions_dir),
            lsp_options: language.lsp_options.clone(),
            packages: language.packages.as_ref().map(|p| PackageHints {
                missing_module: p.missing_module.clone(),
                missing_package: p.missing_package.clone(),
            }),
            start_part_two: language.start_part_two.clone(),
        },
        snippets: app.config.snippets.clone(),
        models: models_state(&app),
        has_aoc_session: app.aoc.has_session(),
        theme_css: theme_css(&app),
        commit_after_star: app.settings().commit_after_star(&app.config),
        solutions_dir: crate::paths::display_path(&app.config.solutions_dir),
        leaderboard: app.settings().leaderboard,
        update: app.updates.available(),
        server_dictation: {
            let ready = speech_state(&app).ready;
            if ready {
                // So the first thing said is heard as quickly as the rest.
                let app = app.clone();
                tokio::spawn(async move {
                    app.dictation.warm(&app.paths.cache_dir, &app.http).await;
                });
            }
            ready
        },
        needs_setup: !app.aoc.has_session()
            || models::options(&app.config)
                .iter()
                .all(|o| o.unavailable.is_some()),
    }))
}

pub(super) async fn save_state(
    State(app): State<Shared>,
    Json(state): Json<UiState>,
) -> ApiResult<()> {
    app.workspace.save_ui_state(&state)?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum ClientLogKind {
    Error,
    Command,
    Speech,
}

#[derive(Deserialize)]
pub(super) struct ClientLog {
    kind: ClientLogKind,
    message: String,
}

/// Records what happened on the phone, which the server can't otherwise see, in the log file.
pub(super) async fn client_log(Json(body): Json<ClientLog>) -> ApiResult<()> {
    let message: String = body.message.chars().take(4000).collect();
    match body.kind {
        ClientLogKind::Error => tracing::warn!(target: "workshop::client", "{message}"),
        ClientLogKind::Command => tracing::info!(target: "workshop::client", "command: {message}"),
        ClientLogKind::Speech => tracing::info!(target: "workshop::client", "speech: {message}"),
    }
    Ok(Json(()))
}

/// Lets the app check the server can be reached, such as after it was asleep.
pub(super) async fn ping() -> ApiResult<()> {
    Ok(Json(()))
}
