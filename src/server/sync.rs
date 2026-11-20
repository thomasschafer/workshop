//! Unified idempotent offline sync: short-item attempts/flags/retirements, coding session
//! events, and mistake tags in a single request.

use axum::Json;
use axum::extract::{Query, State};
use serde::{Deserialize, Serialize};

use super::error::ApiResult;
use super::learning::Where;
use super::state::Shared;
use crate::coding::{CodingEvent, CodingEventOutcome};
use crate::learning::{Deck, SyncRequest};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct MistakeTagChange {
    pub(super) id: String,
    pub(super) mistake_id: String,
    pub(super) error_type: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(super) struct UnifiedSyncRequest {
    pub(super) attempts: Vec<workshop_learning::Attempt>,
    pub(super) flags: Vec<workshop_learning::FlagChange>,
    pub(super) retirements: Vec<workshop_learning::RetirementChange>,
    pub(super) coding_events: Vec<CodingEvent>,
    pub(super) mistake_tags: Vec<MistakeTagChange>,
}

#[derive(Debug, Serialize)]
pub(super) struct MistakeTagOutcome {
    id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
pub(super) struct UnifiedSyncResponse {
    deck: Deck,
    coding_results: Vec<CodingEventOutcome>,
    mistake_tag_results: Vec<MistakeTagOutcome>,
}

pub(super) async fn sync(
    State(app): State<Shared>,
    Query(at): Query<Where>,
    Json(request): Json<UnifiedSyncRequest>,
) -> ApiResult<UnifiedSyncResponse> {
    let clock = at.clock()?;
    let mut coding_results = Vec::with_capacity(request.coding_events.len());
    if !request.coding_events.is_empty() {
        let packs = crate::packs::load(&app.config.learning)?;
        for event in request.coding_events {
            coding_results.push(app.problems.apply_event(&packs, &app.learning, event));
        }
    }

    let mut mistake_tag_results = Vec::with_capacity(request.mistake_tags.len());
    for tag in request.mistake_tags {
        match app
            .learning
            .store()
            .tag_mistake(&tag.mistake_id, tag.error_type.as_deref())
        {
            Ok(()) => mistake_tag_results.push(MistakeTagOutcome {
                id: tag.id,
                ok: true,
                error: None,
            }),
            Err(err) => mistake_tag_results.push(MistakeTagOutcome {
                id: tag.id,
                ok: false,
                error: Some(format!("{err:#}")),
            }),
        }
    }

    let deck = app.learning.sync(
        &SyncRequest {
            attempts: request.attempts,
            flags: request.flags,
            retirements: request.retirements,
        },
        clock,
    )?;

    Ok(Json(UnifiedSyncResponse {
        deck,
        coding_results,
        mistake_tag_results,
    }))
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::{StatusCode, header};

    use crate::server::testing::{send, test_app};

    async fn json(response: axum::response::Response) -> serde_json::Value {
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    fn post_json(path: &str, body: &serde_json::Value) -> Request {
        Request::post(path)
            .header(header::COOKIE, "workshop_token=secret")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    #[tokio::test]
    async fn unified_sync_applies_learning_coding_and_mistake_tags_idempotently() {
        let (_dir, router) = test_app().await;
        let now = crate::learning::now_ms();

        // First sync: learning attempt (wrong answer -> creates mistake) + offline coding open & finish.
        let body = serde_json::json!({
            "attempts": [{
                "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8b01",
                "item": "sample/binary-heap-costs",
                "answered_at": now,
                "duration_ms": 8000,
                "rating": "again",
            }],
            "coding_events": [
                {
                    "kind": "session_opened",
                    "id": "ev-open-1",
                    "item": "sample/first-repeat",
                    "mode": "solve",
                    "language": "python",
                    "started_at": now,
                },
                {
                    "kind": "finished",
                    "id": "ev-fin-1",
                    "item": "sample/first-repeat",
                    "base_version": 1,
                    "rating": "good",
                    "plan": "Track seen elements in a set.",
                    "duration_ms": 12000,
                    "answered_at": now + 12000,
                }
            ],
            "mistake_tags": [
                {
                    "id": "tag-1",
                    "mistake_id": "nonexistent",
                    "error_type": "concept-gap",
                }
            ]
        });
        let res = send(&router, post_json("/api/sync?utc_offset=0", &body)).await;
        assert_eq!(res.status(), StatusCode::OK);
        let synced = json(res).await;
        assert_eq!(
            synced["deck"]["schedules"]["sample/binary-heap-costs"]["reviews"],
            1
        );
        assert_eq!(synced["coding_results"][0]["status"], "applied");
        assert_eq!(synced["coding_results"][1]["status"], "applied");
        assert_eq!(synced["mistake_tag_results"][0]["ok"], false);

        // Replaying the exact same payload is idempotent.
        let replay = send(&router, post_json("/api/sync?utc_offset=0", &body)).await;
        assert_eq!(replay.status(), StatusCode::OK);
        let replayed = json(replay).await;
        assert_eq!(replayed["coding_results"][0]["status"], "duplicate");
        assert_eq!(replayed["coding_results"][1]["status"], "duplicate");

        // Offline coding bundle returns items without blocking.
        let bundle_req = Request::get("/api/coding/offline-bundle?precompute=false")
            .header(header::COOKIE, "workshop_token=secret")
            .body(Body::empty())
            .unwrap();
        let bundle_res = send(&router, bundle_req).await;
        assert_eq!(bundle_res.status(), StatusCode::OK);
        let bundle = json(bundle_res).await;
        assert!(!bundle["items"].as_array().unwrap().is_empty());
        assert!(bundle["empty_version"].is_string());
    }
}
