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
/// model's CLI reports it, then `{"done": {text, model}}`, `{"cancelled": true}` or
/// `{"error": message}`. Shared by every coach the app talks to. The reply is kept under `id`, if
/// the app gave one, so it can be picked up again from `/replies/{id}` if the connection is lost.
pub(super) fn stream_reply(
    app: Shared,
    provider: String,
    spec: CallSpec,
    prompt: String,
    id: Option<String>,
) -> Result<Response, ApiError> {
    let id = id.unwrap_or_else(super::replies::Replies::unnamed);
    let (writer, cancel) = app.replies.start(&id)?;
    let following = app.replies.follow(&id)?;
    tokio::spawn(async move {
        let (partial, mut parts) = tokio::sync::mpsc::unbounded_channel::<String>();
        // Owns the sender, so the parts end with the call.
        let call = async move {
            app.runners[&provider]
                .call_streaming(&spec, &prompt, DISCUSS_TIMEOUT, Some(&partial))
                .await
        };
        let outcome = tokio::select! {
            biased;
            () = cancel.cancelled() => None,
            (reply, ()) = async {
                let forward = async {
                    while let Some(text) = parts.recv().await {
                        writer.delta(&text);
                    }
                };
                tokio::join!(call, forward)
            } => Some(match reply {
                Ok(reply) => Ok(Finished {
                    text: reply.text,
                    model: reply.model,
                }),
                Err(err) => {
                    tracing::warn!("discussing: {err:#}");
                    Err(format!("{err:#}"))
                }
            }),
        };
        match outcome {
            Some(end) => writer.finish(end),
            None => writer.cancel(),
        }
    });
    Ok(following)
}

#[cfg(all(test, unix))]
mod tests {
    use std::process::Command;
    use std::time::{Duration, Instant};

    use axum::body::{Body, to_bytes};
    use axum::extract::Request;
    use axum::http::{StatusCode, header};

    use crate::server::testing::{fake_script_model, send, test_app_in};

    fn pid_alive(pid: &str) -> bool {
        Command::new("kill")
            .args(["-0", pid])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    #[tokio::test]
    async fn cancelling_a_reply_stops_the_model_process_and_notifies_followers() {
        let dir = tempfile::tempdir().unwrap();
        let pids_file = dir.path().join("pids");
        let script = format!(
            "sleep 60 &\nchild=$!\nprintf '%s %s\\n' \"$$\" \"$child\" > '{}'\nwait \"$child\"\n",
            pids_file.display()
        );
        let config = fake_script_model(dir.path(), &script);
        let router = test_app_in(dir.path(), &config);

        let body = serde_json::json!({
            "year": 2024,
            "day": 1,
            "model": "fake",
            "turns": [{ "speaker": "user", "text": "help" }],
            "code": "",
            "reply_id": "slow-reply-1",
        });
        let discuss_req = Request::post("/api/discuss")
            .header(header::COOKIE, "workshop_token=secret")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let discuss_res = send(&router, discuss_req).await;
        assert_eq!(discuss_res.status(), StatusCode::OK);

        // Wait for the fake model script and its child sleep to start and record their PIDs.
        let deadline = Instant::now() + Duration::from_secs(5);
        let pids: Vec<String> = loop {
            if let Ok(text) = std::fs::read_to_string(&pids_file) {
                let parts: Vec<String> = text.split_whitespace().map(str::to_owned).collect();
                if parts.len() == 2 {
                    break parts;
                }
            }
            assert!(
                Instant::now() < deadline,
                "fake model did not start in time"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        };

        // Cancel the in-flight reply.
        let cancel_req = Request::post("/api/replies/slow-reply-1/cancel")
            .header(header::COOKIE, "workshop_token=secret")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            send(&router, cancel_req).await.status(),
            StatusCode::NO_CONTENT
        );

        // The streaming response ends promptly with a cancelled event.
        let bytes = tokio::time::timeout(
            Duration::from_secs(5),
            to_bytes(discuss_res.into_body(), usize::MAX),
        )
        .await
        .expect("stream did not close after cancel")
        .unwrap();
        let events: Vec<serde_json::Value> = String::from_utf8(bytes.to_vec())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            events.last(),
            Some(&serde_json::json!({ "cancelled": true }))
        );

        // Both the script and its child process in the process group are gone.
        let kill_deadline = Instant::now() + Duration::from_secs(5);
        while pids.iter().any(|pid| pid_alive(pid)) {
            assert!(
                Instant::now() < kill_deadline,
                "model process group still alive after cancel: {pids:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        // Cancelling an already-finished or unknown reply is a harmless 204.
        for id in ["slow-reply-1", "does-not-exist"] {
            let req = Request::post(format!("/api/replies/{id}/cancel"))
                .header(header::COOKIE, "workshop_token=secret")
                .body(Body::empty())
                .unwrap();
            assert_eq!(send(&router, req).await.status(), StatusCode::NO_CONTENT);
        }
    }
}
