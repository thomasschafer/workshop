//! The home screen: what to continue with, and the tracks.

use axum::Json;
use axum::extract::State;
use workshop_tracks::Home;

use super::error::ApiResult;
use super::state::Shared;
use crate::tracks::{AdventOfCode, Destination};

pub(super) async fn home(State(app): State<Shared>) -> ApiResult<Home<Destination>> {
    let advent_of_code = AdventOfCode {
        last: app.workspace.load_ui_state()?.puzzle,
        has_session: app.aoc.has_session(),
        now: crate::notify::now_secs(),
        // Only what's cached, so the home screen never waits on Advent of Code.
        stars: |puzzle| match app.aoc.cached_problem(puzzle) {
            Ok(problem) => problem.map(|p| p.stars),
            Err(err) => {
                tracing::warn!("reading {puzzle}: {err:#}");
                None
            }
        },
    };
    let home = Home::new([Some(advent_of_code.track())]).map_err(anyhow::Error::from)?;
    Ok(Json(home))
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::{StatusCode, header};

    use crate::server::testing::{send, test_app};

    #[tokio::test]
    async fn lists_advent_of_code_and_what_to_continue_with() {
        let (_dir, router) = test_app().await;
        let request = Request::get("/api/home")
            .header(header::COOKIE, "workshop_token=secret")
            .body(Body::empty())
            .unwrap();
        let response = send(&router, request).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let home: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(home["tracks"].as_array().unwrap().len(), 1);
        assert_eq!(home["tracks"][0]["id"], "advent-of-code");
        assert_eq!(home["tracks"][0]["name"], "Advent of Code");
        // With no Advent of Code login and nothing opened yet, the practice puzzle.
        assert_eq!(home["continue"]["track"], "advent-of-code");
        assert_eq!(
            home["continue"]["destination"],
            serde_json::json!({ "kind": "puzzle", "puzzle": { "year": 0, "day": 1 } })
        );
    }
}
