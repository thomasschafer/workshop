//! The deck of short items the app practises with, offline too, and syncing what was done.

use axum::Json;
use axum::extract::{Query, State};
use serde::Deserialize;
use workshop_learning::Clock;

use super::error::{ApiResult, bad_request};
use super::state::Shared;
use crate::learning::{Deck, SyncRequest, now_ms};

/// Where the learner is in the world, for when their days and weeks begin.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Where {
    /// Minutes ahead of UTC, such as 60 in Paris in winter.
    pub(super) utc_offset: Option<i32>,
}

impl Where {
    pub(super) fn clock(&self) -> Result<Clock, super::error::ApiError> {
        let utc_offset_minutes = self.utc_offset.unwrap_or(0);
        // The furthest any time zone is from UTC.
        if !(-14 * 60..=14 * 60).contains(&utc_offset_minutes) {
            return Err(bad_request(format!(
                "{utc_offset_minutes} minutes isn't an offset from UTC any time zone has"
            )));
        }
        Ok(Clock {
            now: now_ms(),
            utc_offset_minutes,
        })
    }
}

pub(super) async fn deck(State(app): State<Shared>, Query(at): Query<Where>) -> ApiResult<Deck> {
    let clock = at.clock()?;
    Ok(Json(app.learning.deck(clock)?))
}

pub(super) async fn sync(
    State(app): State<Shared>,
    Query(at): Query<Where>,
    Json(request): Json<SyncRequest>,
) -> ApiResult<Deck> {
    let clock = at.clock()?;
    Ok(Json(app.learning.sync(&request, clock)?))
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

    fn sync_request(body: &serde_json::Value) -> Request {
        Request::post("/api/learning/sync?utc_offset=60")
            .header(header::COOKIE, "workshop_token=secret")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    #[tokio::test]
    async fn deals_the_deck_and_takes_attempts_more_than_once() {
        let (_dir, router) = test_app().await;
        let request = Request::get("/api/learning/deck?utc_offset=-300")
            .header(header::COOKIE, "workshop_token=secret")
            .body(Body::empty())
            .unwrap();
        let response = send(&router, request).await;
        assert_eq!(response.status(), StatusCode::OK);
        let deck = json(response).await;
        assert_eq!(deck["items"].as_array().unwrap().len(), 51);
        assert_eq!(deck["lessons"].as_array().unwrap().len(), 1);
        assert_eq!(deck["lessons"][0]["key"], "sample/binary-heaps");
        assert_eq!(
            deck["lessons"][0]["images"]["heap-array.svg"]["kind"],
            "svg"
        );
        assert_eq!(deck["limits"]["daily_reviews"], 40);
        assert_eq!(deck["limits"]["daily_new"], 10);
        assert_eq!(deck["progress"]["new_today"], 0);

        let now = crate::learning::now_ms();
        let body = serde_json::json!({
            "attempts": [{
                "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a11",
                "item": "sample/binary-heap-costs",
                "answered_at": now,
                "duration_ms": 12000,
                "rating": "good",
            }],
        });
        let first = json(send(&router, sync_request(&body)).await).await;
        assert_eq!(first["schedules"]["sample/binary-heap-costs"]["reviews"], 1);
        // Sent again, as when the reply to the first was lost.
        let again = send(&router, sync_request(&body)).await;
        assert_eq!(again.status(), StatusCode::OK);
        let again = json(again).await;
        assert_eq!(again["schedules"]["sample/binary-heap-costs"]["reviews"], 1);

        let completion = serde_json::json!({
            "lesson_completions": [{
                "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a22",
                "lesson": "sample/binary-heaps",
                "completed_at": now,
            }],
        });
        let done = json(send(&router, sync_request(&completion)).await).await;
        assert_eq!(
            done["lesson_completions"]["sample/binary-heaps"],
            serde_json::json!([now])
        );
        // Sent again, it's recorded once.
        let done_again = json(send(&router, sync_request(&completion)).await).await;
        assert_eq!(
            done_again["lesson_completions"]["sample/binary-heaps"],
            serde_json::json!([now])
        );
    }

    #[tokio::test]
    async fn retires_code_to_read_from_a_sync_until_its_brought_back() {
        let (_dir, router) = test_app().await;
        let now = crate::learning::now_ms();
        let id = "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a71";
        let body = serde_json::json!({
            "attempts": [{
                "id": id,
                "item": "sample/negative-division",
                "answered_at": now,
                "duration_ms": 9000,
                "rating": "easy",
                "response": "-3 -1",
            }],
            "retirements": [{
                "id": id,
                "item": "sample/negative-division",
                "at": now,
                "retired": true,
            }],
        });
        let deck = json(send(&router, sync_request(&body)).await).await;
        assert_eq!(
            deck["retirements"]["sample/negative-division"],
            serde_json::json!({ "state": "retired", "at": now })
        );
        // Sent again, as when the reply was lost, it's the same.
        let again = send(&router, sync_request(&body)).await;
        assert_eq!(again.status(), StatusCode::OK);
        let again = json(again).await;
        assert_eq!(again["retirements"], deck["retirements"]);
        assert_eq!(again["schedules"]["sample/negative-division"]["reviews"], 1);

        let overview = || async {
            let request = Request::get("/api/coding?utc_offset=60")
                .header(header::COOKIE, "workshop_token=secret")
                .body(Body::empty())
                .unwrap();
            let overview = json(send(&router, request).await).await;
            overview["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["key"] == "sample/negative-division")
                .unwrap()["status"]
                .clone()
        };
        assert_eq!(overview().await, "retired");
        // Brought back, from the outbox as it was retired, it's due straight away.
        let back = serde_json::json!({
            "retirements": [{
                "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a72",
                "item": "sample/negative-division",
                "at": now + 1,
                "retired": false,
            }],
        });
        let deck = json(send(&router, sync_request(&back)).await).await;
        assert_eq!(
            deck["retirements"]["sample/negative-division"],
            serde_json::json!({ "state": "brought_back", "at": now + 1 })
        );
        assert_eq!(overview().await, "due");

        // A card can't be retired this way, and nothing sent with it is kept.
        let card = serde_json::json!({
            "attempts": [{
                "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a73",
                "item": "sample/binary-heap-costs",
                "answered_at": now,
                "duration_ms": 9000,
                "rating": "easy",
            }],
            "retirements": [{
                "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a73",
                "item": "sample/binary-heap-costs",
                "at": now,
                "retired": true,
            }],
        });
        let refused = send(&router, sync_request(&card)).await;
        assert!(!refused.status().is_success());
        let error = json(refused).await;
        assert!(
            error["error"].as_str().unwrap().contains("no fixed answer"),
            "{error}"
        );
        let deck = json(send(&router, sync_request(&serde_json::json!({}))).await).await;
        assert!(deck["schedules"]["sample/binary-heap-costs"].is_null());
    }

    #[tokio::test]
    async fn refuses_an_offset_no_time_zone_has() {
        let (_dir, router) = test_app().await;
        let request = Request::get("/api/learning/deck?utc_offset=9999")
            .header(header::COOKIE, "workshop_token=secret")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            send(&router, request).await.status(),
            StatusCode::BAD_REQUEST
        );
    }
}
