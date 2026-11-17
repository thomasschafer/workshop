//! The author in the app: topping up a pack, items waiting for approval, and the author's
//! questions.

use std::sync::atomic::Ordering;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

use super::error::{ApiError, ApiResult, bad_request};
use super::state::Shared;
use crate::author::{LastRun, Question, Queued};

/// When the server runs the author by itself.
#[derive(Serialize)]
struct Schedule {
    /// How often, such as "every 7 days".
    every: String,
    /// The time of day it waits for, such as "02:00", if it waits for one.
    after: Option<String>,
    /// When the next run is due, in milliseconds since 1970.
    next_at: i64,
}

#[derive(Serialize)]
pub(super) struct AuthorStatus {
    running: bool,
    /// When it runs by itself, if it's scheduled to.
    schedule: Option<Schedule>,
    /// Why the author can't run, if it can't, such as with only the sample pack.
    unavailable: Option<String>,
    writer: String,
    reviewer: String,
    /// Why the reviewer is the one it is, such as there being no other provider to use.
    reviewer_reason: String,
    /// Whether the reviewer uses the writer's own provider.
    reviewer_shares_provider: bool,
    max_items: usize,
    last: Option<LastRun>,
    queue: Vec<Queued>,
    /// Questions it's asked that haven't yet gone to a run with their answer.
    questions: Vec<Question>,
}

async fn status(app: &Shared) -> Result<AuthorStatus, ApiError> {
    let reviewer = app.author_reviewer().await;
    let running = app.author_running.load(Ordering::SeqCst) || app.author.try_lock()?.is_none();
    let author = &app.config.author;
    let named = |model| crate::author::reviewer::named(&app.config, model);
    let next = crate::author::schedule::next_scheduled(
        &app.config,
        &app.author,
        crate::learning::now_ms(),
    )?;
    let schedule = next.zip(author.every).map(|(next_at, every)| Schedule {
        every: every.describe(),
        after: author.after.map(|after| after.to_string()),
        next_at,
    });
    Ok(AuthorStatus {
        running,
        schedule,
        unavailable: app.config.learning.packs.is_empty().then(|| {
            "The author writes for a pack of your own, and the sample pack is built in: list your pack under [learning] in your config.".to_owned()
        }),
        writer: named(&author.writer),
        reviewer: named(&reviewer.model),
        reviewer_reason: reviewer.reason(&app.config),
        reviewer_shares_provider: reviewer.shares_provider(&app.config),
        max_items: author.max_items,
        last: app.author.last_run()?,
        queue: app.author.queue()?,
        questions: app
            .author
            .questions()?
            .into_iter()
            .filter(|q| !q.told)
            .collect(),
    })
}

pub(super) async fn author(State(app): State<Shared>) -> ApiResult<AuthorStatus> {
    Ok(Json(status(&app).await?))
}

/// Starts a run, which carries on in the background; the app asks how it's going.
pub(super) async fn top_up(State(app): State<Shared>) -> ApiResult<AuthorStatus> {
    if app.author_running.swap(true, Ordering::SeqCst) {
        return Err(ApiError(
            StatusCode::CONFLICT,
            serde_json::json!({ "error": "The author is already running." }),
        ));
    }
    let running = app.clone();
    tokio::spawn(async move {
        let app = running;
        let result = crate::author::run(
            &app.config,
            &app.paths,
            &app.learning,
            &app.author,
            app.notifier.clone(),
            None,
        )
        .await;
        if let Err(err) = result {
            tracing::warn!("the author: {err:#}");
        }
        app.author_running.store(false, Ordering::SeqCst);
    });
    let mut shown = status(&app).await?;
    shown.running = true;
    Ok(Json(shown))
}

/// Runs the author by itself when the config schedules it, for as long as the server runs.
pub async fn run_on_schedule(app: Shared) {
    crate::author::schedule::Scheduler {
        config: &app.config,
        paths: &app.paths,
        learning: &app.learning,
        desk: &app.author,
        notifier: app.notifier.clone(),
        running: &app.author_running,
    }
    .run_forever()
    .await;
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Decision {
    approve: bool,
}

#[derive(Serialize)]
pub(super) struct Decided {
    commit: Option<String>,
    status: AuthorStatus,
}

/// Approves an item waiting for approval, which adds it to the pack if it still passes its
/// check, or turns it down.
pub(super) async fn decide(
    State(app): State<Shared>,
    Path(id): Path<String>,
    Json(decision): Json<Decision>,
) -> ApiResult<Decided> {
    let commit = if decision.approve {
        crate::author::approve(&app.config, &app.paths, &app.author, &id)
            .await
            .map_err(|err| bad_request(format!("{err:#}")))?
    } else {
        app.author
            .take(&id)
            .map_err(|err| bad_request(format!("{err:#}")))?;
        None
    };
    Ok(Json(Decided {
        commit,
        status: status(&app).await?,
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Answer {
    answer: String,
}

/// Answers one of the author's questions, for its next run.
pub(super) async fn answer(
    State(app): State<Shared>,
    Path(id): Path<String>,
    Json(body): Json<Answer>,
) -> ApiResult<AuthorStatus> {
    app.author
        .answer(&id, &body.answer)
        .map_err(|err| bad_request(format!("{err:#}")))?;
    Ok(Json(status(&app).await?))
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::{StatusCode, header};

    use crate::server::testing::{send, test_app_in};

    fn request(method: &str, path: &str, body: Option<serde_json::Value>) -> Request {
        Request::builder()
            .method(method)
            .uri(path)
            .header(header::COOKIE, "workshop_token=secret")
            .header(header::CONTENT_TYPE, "application/json")
            .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
            .unwrap()
    }

    async fn json(response: axum::response::Response) -> serde_json::Value {
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    #[tokio::test]
    async fn says_why_it_cant_top_up_the_sample_pack() {
        // Codex stands in, logged out, so the reviewer is the writer's own provider's.
        let dir = tempfile::tempdir().unwrap();
        let router = test_app_in(
            dir.path(),
            "[providers.codex]\nname = \"Codex\"\ncommand = [\"sh\"]\ninput = \"stdin\"\noutput = \"text\"\nauth_check_command = [\"sh\", \"-c\", \"exit 1\"]\n",
        );
        let status = json(send(&router, request("GET", "/api/author", None)).await).await;
        assert_eq!(status["running"], false);
        assert!(
            status["unavailable"]
                .as_str()
                .unwrap()
                .contains("pack of your own")
        );
        assert_eq!(status["writer"], "opus with Claude Code");
        assert_eq!(status["reviewer"], "opus with Claude Code");
        assert_eq!(status["reviewer_shares_provider"], true);
        let reason = status["reviewer_reason"].as_str().unwrap();
        assert!(reason.contains("install and log in to Codex"), "{reason}");
        let started = json(send(&router, request("POST", "/api/author/run", None)).await).await;
        assert_eq!(started["running"], true);
        let mut last = serde_json::Value::Null;
        for _ in 0..100 {
            let status = json(send(&router, request("GET", "/api/author", None)).await).await;
            if status["running"] == false {
                last = status["last"].clone();
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(
            last["error"].as_str().unwrap().contains("pack of your own"),
            "{last}"
        );
        let missing = send(
            &router,
            request(
                "POST",
                "/api/author/queue/nothing",
                Some(serde_json::json!({ "approve": false })),
            ),
        )
        .await;
        assert_eq!(missing.status(), StatusCode::BAD_REQUEST);
    }
}
