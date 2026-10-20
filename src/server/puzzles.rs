//! A puzzle and what's kept for it: its page and input from Advent of Code, and the code, notes
//! and choices saved in the solutions repo.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

use super::error::{ApiError, ApiResult, bad_request};
use super::lsp::file_uri;
use super::state::Shared;
use crate::aoc::{Part, Problem};
use crate::language::Puzzle;
use crate::provider::Role;
use crate::workspace::{DayMeta, SaveError, VersionedFile};

/// Asks the edit model for a part's example, for when the page's structure doesn't give it away.
/// What it finds, or that it found nothing, is kept, so each part is only asked about once.
pub(super) async fn find_sample(
    State(app): State<Shared>,
    Path((year, day, part)): Path<(u16, u8, u8)>,
) -> ApiResult<Option<crate::samples::Sample>> {
    let puzzle = puzzle(year, day)?;
    let part = Part::from_number(part).map_err(|e| bad_request(e.to_string()))?;
    let path = app.aoc.sample_path(puzzle, part);
    if let Ok(text) = std::fs::read_to_string(&path) {
        match serde_json::from_str(&text) {
            Ok(found) => return Ok(Json(found)),
            Err(err) => tracing::warn!("reading {}: {err}", path.display()),
        }
    }
    let problem = app.aoc.problem(puzzle, false).await?;
    let shown = usize::from(part.number());
    if problem.parts_text.len() < shown {
        return Err(bad_request(format!(
            "Part {} isn't open yet.",
            part.number()
        )));
    }
    let input = app.aoc.input(puzzle).await?;
    let choice = app.model_settings().edit;
    let spec = app.config.providers[&choice.provider].spec(
        Role::Edit,
        &choice.model,
        crate::samples::system_prompt().to_owned(),
    );
    let prompt = crate::samples::user_prompt(part.number(), &problem.parts_text[..shown], &input);
    let reply = app.runners[&choice.provider]
        .call_aside(&spec, &prompt, crate::samples::TIMEOUT)
        .await?;
    let found = crate::samples::read_reply(&reply.text, &problem.text)?;
    tracing::info!(
        "sample for {puzzle} part {}: {found:?} in {}ms",
        part.number(),
        reply.elapsed_ms
    );
    let json = serde_json::to_string(&found).map_err(anyhow::Error::from)?;
    crate::paths::write_atomic(&path, json.as_bytes())?;
    Ok(Json(found))
}

pub(super) fn puzzle(year: u16, day: u8) -> Result<Puzzle, ApiError> {
    Puzzle::new(year, day).map_err(|err| bad_request(err.to_string()))
}

#[derive(Deserialize)]
pub(super) struct RefreshQuery {
    #[serde(default)]
    pub(super) refresh: bool,
}

#[derive(Serialize)]
pub(super) struct OpenPuzzle {
    code: VersionedFile,
    file_uri: String,
    notes: VersionedFile,
    meta: DayMeta,
}

pub(super) async fn open_puzzle(
    State(app): State<Shared>,
    Path((year, day)): Path<(u16, u8)>,
) -> ApiResult<OpenPuzzle> {
    let puzzle = puzzle(year, day)?;
    app.workspace.ensure_repo().await?;
    let code = app.workspace.load_code(app.language(), puzzle)?;
    Ok(Json(OpenPuzzle {
        file_uri: file_uri(&code.path),
        code,
        notes: app.workspace.load_notes(puzzle)?,
        meta: app.workspace.load_day_meta(puzzle)?,
    }))
}

#[derive(Deserialize)]
pub(super) struct SaveText {
    text: String,
    version: String,
}

pub(super) async fn save_code(
    State(app): State<Shared>,
    Path((year, day)): Path<(u16, u8)>,
    Json(body): Json<SaveText>,
) -> ApiResult<VersionedFile> {
    let puzzle = puzzle(year, day)?;
    saved(
        app.workspace
            .save_code(app.language(), puzzle, &body.text, &body.version),
    )
}

pub(super) async fn save_notes(
    State(app): State<Shared>,
    Path((year, day)): Path<(u16, u8)>,
    Json(body): Json<SaveText>,
) -> ApiResult<VersionedFile> {
    saved(
        app.workspace
            .save_notes(puzzle(year, day)?, &body.text, &body.version),
    )
}

/// A conflict is reported with the current file, so the editor can offer to load it.
fn saved(result: Result<VersionedFile, SaveError>) -> ApiResult<VersionedFile> {
    match result {
        Ok(file) => Ok(Json(file)),
        Err(SaveError::Conflict { current }) => Err(ApiError(
            StatusCode::CONFLICT,
            serde_json::json!({ "error": "The file changed on disk.", "current": current }),
        )),
        Err(SaveError::Other(err)) => Err(err.into()),
    }
}

pub(super) async fn save_meta(
    State(app): State<Shared>,
    Path((year, day)): Path<(u16, u8)>,
    Json(meta): Json<DayMeta>,
) -> ApiResult<()> {
    app.workspace.save_day_meta(puzzle(year, day)?, &meta)?;
    Ok(Json(()))
}

pub(super) async fn problem(
    State(app): State<Shared>,
    Path((year, day)): Path<(u16, u8)>,
    Query(query): Query<RefreshQuery>,
) -> ApiResult<Problem> {
    Ok(Json(
        app.aoc.problem(puzzle(year, day)?, query.refresh).await?,
    ))
}

#[derive(Serialize)]
pub(super) struct PuzzleInput {
    text: String,
    lines: usize,
}

pub(super) async fn input(
    State(app): State<Shared>,
    Path((year, day)): Path<(u16, u8)>,
) -> ApiResult<PuzzleInput> {
    let text = app.aoc.input(puzzle(year, day)?).await?;
    Ok(Json(PuzzleInput {
        lines: text.lines().count(),
        text,
    }))
}

pub(super) async fn reset_practice(State(app): State<Shared>) -> ApiResult<Problem> {
    app.aoc.reset_practice()?;
    Ok(Json(app.aoc.problem(Puzzle::PRACTICE, false).await?))
}
