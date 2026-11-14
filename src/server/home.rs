//! The home screen: what to continue with, and the tracks.

use axum::Json;
use axum::extract::{Query, State};
use serde::Serialize;
use workshop_tracks::Home;

use super::error::ApiResult;
use super::learning::Where;
use super::state::Shared;
use crate::learning::Week;
use crate::tracks::{AdventOfCode, Destination};

#[derive(Serialize)]
pub(super) struct HomeScreen {
    #[serde(flatten)]
    home: Home<Destination>,
    /// Practice this week, towards the week's target.
    week: Option<Week>,
    /// What's wrong with the packs, if anything, such as items that couldn't be read.
    problems: Vec<String>,
}

pub(super) async fn home(
    State(app): State<Shared>,
    Query(at): Query<Where>,
) -> ApiResult<HomeScreen> {
    let clock = at.clock()?;
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
    // Advent of Code stays usable whatever is wrong with the packs.
    let (learning, week, problems) = match app.learning.tracks(clock) {
        Ok(learning) => (learning.tracks, Some(learning.week), learning.problems),
        Err(err) => {
            tracing::warn!("reading the packs: {err:#}");
            (Vec::new(), None, vec![format!("{err:#}")])
        }
    };
    let tracks = std::iter::once(advent_of_code.track())
        .chain(learning)
        .map(Some);
    let home = Home::new(tracks).map_err(anyhow::Error::from)?;
    Ok(Json(HomeScreen {
        home,
        week,
        problems,
    }))
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::{StatusCode, header};

    use crate::server::testing::{send, test_app};

    #[tokio::test]
    async fn lists_the_tracks_and_what_to_continue_with() {
        let (_dir, router) = test_app().await;
        let request = Request::get("/api/home?utc_offset=0")
            .header(header::COOKIE, "workshop_token=secret")
            .body(Body::empty())
            .unwrap();
        let response = send(&router, request).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let home: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let ids: Vec<&str> = home["tracks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|track| track["id"].as_str().unwrap())
            .collect();
        // Advent of Code, then the sample pack's tracks.
        assert_eq!(
            ids,
            [
                "advent-of-code",
                "probability",
                "mental-maths",
                "review",
                "pack:estimation"
            ]
        );
        assert_eq!(home["tracks"][0]["name"], "Advent of Code");
        assert_eq!(
            home["week"],
            serde_json::json!({ "minutes": 0, "target": 90 })
        );
        assert_eq!(home["problems"], serde_json::json!([]));
        // With no Advent of Code login and nothing opened yet, the practice puzzle.
        assert_eq!(home["continue"]["track"], "advent-of-code");
        assert_eq!(
            home["continue"]["destination"],
            serde_json::json!({ "kind": "puzzle", "puzzle": { "year": 0, "day": 1 } })
        );
    }
}
