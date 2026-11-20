//! Running a solution on a puzzle's sample or real input, and submitting its answer.

use anyhow::Context;
use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use super::error::{ApiError, ApiResult, optional_json};
use super::puzzles::puzzle;
use super::state::{ActiveRun, Shared, lock};
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
    /// Identifies this run so a late cancel from an earlier timed-out request can't stop it.
    #[serde(default)]
    run_id: Option<String>,
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
    *lock(&app.current_run) = Some(ActiveRun {
        id: body.run_id,
        cancel: cancel.clone(),
    });
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

#[derive(Deserialize)]
pub(super) struct FormatBody {
    code: String,
}

#[derive(Serialize)]
pub(super) struct Formatted {
    code: String,
}

/// Formats a solution with the language's formatter, for languages whose server doesn't.
pub(super) async fn format(
    State(app): State<Shared>,
    Path((year, day)): Path<(u16, u8)>,
    Json(body): Json<FormatBody>,
) -> ApiResult<Formatted> {
    let puzzle = puzzle(year, day)?;
    let code = app.solutions().await?.format(puzzle, &body.code).await?;
    Ok(Json(Formatted { code }))
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub(super) struct CancelBody {
    /// When set, cancels only if the active run carries this ID, so a late cancel can't stop a
    /// newer run.
    #[serde(default)]
    run_id: Option<String>,
}

pub(super) async fn cancel_run(
    State(app): State<Shared>,
    body: axum::body::Bytes,
) -> ApiResult<()> {
    let wanted = optional_json::<CancelBody>(body)?.run_id;
    if let Some(active) = lock(&app.current_run).as_ref()
        && (wanted.is_none() || active.id == wanted)
    {
        active.cancel.cancel();
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

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::{StatusCode, header};
    use tokio_util::sync::CancellationToken;

    use crate::server::state::{ActiveRun, lock};
    use crate::server::testing::{send, test_state_in};

    fn cancel_request(body: Option<&str>) -> Request {
        let mut builder =
            Request::post("/api/run/cancel").header(header::COOKIE, "workshop_token=secret");
        if let Some(json) = body {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            builder.body(Body::from(json.to_owned())).unwrap()
        } else {
            builder.body(Body::empty()).unwrap()
        }
    }

    #[tokio::test]
    async fn cancel_respects_run_id_so_late_cancels_cannot_stop_a_newer_run() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state_in(dir.path(), "");
        let router = crate::server::router(state.clone());

        let token = CancellationToken::new();
        *lock(&state.current_run) = Some(ActiveRun {
            id: Some("run-2".into()),
            cancel: token.clone(),
        });

        // A late cancel for an earlier run leaves the newer one alone.
        let response = send(&router, cancel_request(Some(r#"{"run_id":"run-1"}"#))).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!token.is_cancelled());

        // Matching run_id cancels it.
        let response = send(&router, cancel_request(Some(r#"{"run_id":"run-2"}"#))).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(token.is_cancelled());

        // An unscoped cancel (no body) cancels whatever is running.
        let next = CancellationToken::new();
        *lock(&state.current_run) = Some(ActiveRun {
            id: Some("run-3".into()),
            cancel: next.clone(),
        });
        let response = send(&router, cancel_request(None)).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(next.is_cancelled());
    }
}
