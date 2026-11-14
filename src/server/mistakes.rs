//! The mistake log, browsing it and confirming or changing the kind of each mistake, and the
//! progress towards each goal that the mistakes are part of.

use axum::Json;
use axum::extract::{Query, State};
use serde::Deserialize;

use super::error::{ApiResult, bad_request};
use super::learning::Where;
use super::state::Shared;
use crate::mistakes::Log;

pub(super) async fn mistakes(State(app): State<Shared>, Query(at): Query<Where>) -> ApiResult<Log> {
    let clock = at.clock()?;
    let packs = crate::packs::load(&app.config.learning)?;
    let mistakes = app.learning.store().mistakes(0)?;
    Ok(Json(crate::mistakes::log(&packs, mistakes, clock.now)))
}

#[derive(serde::Serialize)]
pub(super) struct Goals {
    goals: Vec<crate::goals::GoalProgress>,
}

pub(super) async fn goals(State(app): State<Shared>, Query(at): Query<Where>) -> ApiResult<Goals> {
    let clock = at.clock()?;
    Ok(Json(Goals {
        goals: app.learning.goals(clock.now)?,
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Tag {
    id: String,
    /// The kind of mistake it was, or null to go back to the one suggested.
    error_type: Option<String>,
}

pub(super) async fn tag(
    State(app): State<Shared>,
    Query(at): Query<Where>,
    Json(tag): Json<Tag>,
) -> ApiResult<Log> {
    let packs = crate::packs::load(&app.config.learning)?;
    if let Some(error_type) = &tag.error_type
        && !crate::mistakes::error_types(&packs)
            .iter()
            .any(|t| t.id == *error_type)
    {
        return Err(bad_request(format!(
            "{error_type:?} isn't a kind of mistake built in or in your packs"
        )));
    }
    app.learning
        .store()
        .tag_mistake(&tag.id, tag.error_type.as_deref())
        .map_err(|err| bad_request(format!("{err:#}")))?;
    mistakes(State(app), Query(at)).await
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

    fn request(method: &str, path: &str, body: serde_json::Value) -> Request {
        Request::builder()
            .method(method)
            .uri(path)
            .header(header::COOKIE, "workshop_token=secret")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    #[tokio::test]
    async fn logs_wrong_answers_and_takes_the_learners_tag() {
        let (_dir, router) = test_app().await;
        let now = crate::learning::now_ms();
        let sync = serde_json::json!({
            "attempts": [{
                "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a21",
                "item": "sample/two-dice-seven",
                "answered_at": now,
                "duration_ms": 12000,
                "rating": "again",
                "response": "1/12",
            }, {
                "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a22",
                "item": "sample/binary-heap-costs",
                "answered_at": now,
                "duration_ms": 12000,
                "rating": "good",
            }],
        });
        let deck =
            json(send(&router, request("POST", "/api/learning/sync", sync.clone())).await).await;
        assert_eq!(deck["focus"], serde_json::json!(["probability.counting"]));
        // Synced again, as after a lost reply, it's still one mistake.
        send(&router, request("POST", "/api/learning/sync", sync)).await;
        let get = Request::get("/api/mistakes")
            .header(header::COOKIE, "workshop_token=secret")
            .body(Body::empty())
            .unwrap();
        let log = json(send(&router, get).await).await;
        let mistakes = log["mistakes"].as_array().unwrap();
        assert_eq!(mistakes.len(), 1);
        let mistake = &mistakes[0];
        assert_eq!(mistake["item"], "sample/two-dice-seven");
        assert_eq!(mistake["source"], "answer");
        assert_eq!(mistake["suggested"], "concept-gap");
        assert_eq!(mistake["confirmed"], serde_json::Value::Null);
        assert_eq!(mistake["skills"][0], "probability.counting");
        assert_eq!(log["common"][0]["error_type"], "concept-gap");

        let tag = serde_json::json!({ "id": mistake["id"], "error_type": "misread" });
        let log = json(send(&router, request("PUT", "/api/mistakes/tag", tag)).await).await;
        assert_eq!(log["mistakes"][0]["confirmed"], "misread");
        assert_eq!(log["common"][0]["error_type"], "misread");

        let unknown = serde_json::json!({ "id": mistake["id"], "error_type": "guessed" });
        let response = send(&router, request("PUT", "/api/mistakes/tag", unknown)).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let missing = serde_json::json!({ "id": "nothing-here", "error_type": "misread" });
        let response = send(&router, request("PUT", "/api/mistakes/tag", missing)).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let get = Request::get("/api/goals?utc_offset=0")
            .header(header::COOKIE, "workshop_token=secret")
            .body(Body::empty())
            .unwrap();
        let goals = json(send(&router, get).await).await;
        let probability = &goals["goals"][1];
        assert_eq!(probability["id"], "probability-foundations");
        assert_eq!(probability["target"], 0.7);
        assert_eq!(probability["mistakes"][0]["error_type"], "misread");
        assert_eq!(probability["skills"][0]["id"], "probability.counting");
        assert_eq!(probability["skills"][0]["name"], "Counting outcomes");
    }
}
