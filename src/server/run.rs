//! Running a solution on a puzzle's sample or real input, and submitting its answer.

use anyhow::Context;
use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use super::error::{ApiError, ApiResult};
use super::puzzles::puzzle;
use super::state::{Shared, lock};
use crate::aoc::{Part, Problem, SubmitOutcome};
use crate::runner::RunResult;

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum InputKind {
    Sample,
    Real,
}

#[derive(Deserialize)]
pub(super) struct RunBody {
    input: InputKind,
    /// Which part's sample to use.
    part: u8,
}

pub(super) async fn run(
    State(app): State<Shared>,
    Path((year, day)): Path<(u16, u8)>,
    Json(body): Json<RunBody>,
) -> ApiResult<RunResult> {
    let puzzle = puzzle(year, day)?;
    let part = Part::from_number(body.part)?;
    let Ok(_guard) = app.run_lock.try_lock() else {
        return Err(ApiError(
            StatusCode::CONFLICT,
            serde_json::json!({ "error": "Something is already running." }),
        ));
    };
    // Registered before fetching the input, so a cancel while fetching isn't lost.
    let cancel = CancellationToken::new();
    *lock(&app.current_run) = Some(cancel.clone());
    let _clear = scopeguard(|| *lock(&app.current_run) = None);

    let input = match body.input {
        InputKind::Sample => app
            .workspace
            .load_day_meta(puzzle)?
            .sample_input(part)
            .context("no sample input is chosen yet; tap a code block in the puzzle to choose one")?
            .to_owned(),
        InputKind::Real => tokio::select! {
            input = app.aoc.input(puzzle) => input?,
            () = cancel.cancelled() => return Err(anyhow::anyhow!("Cancelled.").into()),
        },
    };
    Ok(Json(
        app.solutions().await?.run(puzzle, &input, &cancel).await?,
    ))
}

pub(super) async fn cancel_run(State(app): State<Shared>) -> ApiResult<()> {
    if let Some(cancel) = lock(&app.current_run).as_ref() {
        cancel.cancel();
    }
    Ok(Json(()))
}

/// Runs `f` when dropped, however the enclosing scope is left.
fn scopeguard(f: impl FnOnce()) -> impl Drop {
    struct Guard<F: FnOnce()>(Option<F>);
    impl<F: FnOnce()> Drop for Guard<F> {
        fn drop(&mut self) {
            if let Some(f) = self.0.take() {
                f();
            }
        }
    }
    Guard(Some(f))
}

#[derive(Deserialize)]
pub(super) struct SubmitBody {
    part: u8,
    answer: String,
}

#[derive(Serialize)]
pub(super) struct Submitted {
    outcome: SubmitOutcome,
    /// The refreshed puzzle after a correct answer, which shows the next part.
    problem: Option<Problem>,
    /// What committing and pushing the solutions repo did, if that's done after each star.
    committed: Option<Committed>,
}

#[derive(Serialize)]
struct Committed {
    succeeded: bool,
    summary: String,
}

pub(super) async fn submit(
    State(app): State<Shared>,
    Path((year, day)): Path<(u16, u8)>,
    Json(body): Json<SubmitBody>,
) -> ApiResult<Submitted> {
    let puzzle = puzzle(year, day)?;
    let part = Part::from_number(body.part)?;
    let outcome = app.aoc.submit(puzzle, part, &body.answer).await?;
    let correct = outcome == SubmitOutcome::Correct;
    let problem = if outcome.shows_progress() {
        Some(app.aoc.problem(puzzle, true).await?)
    } else {
        None
    };
    let committed = if correct && app.settings().commit_after_star(&app.config) {
        let message = format!("{}, part {}", puzzle.title(), part.number());
        // The star is earned either way, so a failed push is reported rather than an error.
        Some(
            match app
                .workspace
                .commit_and_push(app.language(), &message)
                .await
            {
                Ok(summary) => Committed {
                    succeeded: true,
                    summary,
                },
                Err(err) => Committed {
                    succeeded: false,
                    summary: format!("Couldn't commit and push: {err:#}"),
                },
            },
        )
    } else {
        None
    };
    Ok(Json(Submitted {
        outcome,
        problem,
        committed,
    }))
}
