//! Progress through a year's puzzles: stars, when they were earned, the chosen private
//! leaderboard, and saving a year's puzzles for offline use.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::extract::{Path, Query, State};
use serde::Serialize;
use workshop_common::files::version_of;

use super::error::{ApiResult, bad_request};
use super::lsp::file_uri;
use super::puzzles::{RefreshQuery, puzzle};
use super::state::{Shared, lock};
use crate::aoc::Problem;
use crate::language::{LanguageProfile, Puzzle};
use crate::workspace::{DayMeta, VersionedFile};

/// The chosen private leaderboard for a year, or nothing if none is chosen.
pub(super) async fn leaderboard(
    State(app): State<Shared>,
    Path(year): Path<u16>,
) -> ApiResult<Option<Vec<crate::aoc::LeaderboardMember>>> {
    let Some(id) = app.settings().leaderboard else {
        return Ok(Json(None));
    };
    Ok(Json(Some(app.aoc.leaderboard(year, &id).await?)))
}

pub(super) async fn times(
    State(app): State<Shared>,
    Path(year): Path<u16>,
    Query(query): Query<RefreshQuery>,
) -> ApiResult<BTreeMap<u8, crate::aoc::StarTimes>> {
    Ok(Json(app.aoc.times(year, query.refresh).await?))
}

pub(super) async fn stars(
    State(app): State<Shared>,
    Path(year): Path<u16>,
    Query(query): Query<RefreshQuery>,
) -> ApiResult<BTreeMap<u8, u8>> {
    Ok(Json(app.aoc.stars(year, query.refresh).await?))
}

#[derive(Serialize)]
pub(super) struct OfflinePuzzle {
    day: u8,
    problem: Option<Problem>,
    input: Option<String>,
    code: Option<VersionedFile>,
    notes: Option<VersionedFile>,
    file_uri: String,
    meta: DayMeta,
}

#[derive(Serialize)]
pub(super) struct OfflineYear {
    year: u16,
    caching: bool,
    cached_days: usize,
    total_unlocked: usize,
    error: Option<String>,
    /// The active language's starter template, so unstarted days can be opened offline without
    /// creating untracked files in the solutions repo.
    template: String,
    /// The `VersionedFile.version` of a not-yet-created file, so offline edits sync cleanly.
    empty_version: String,
    puzzles: Vec<OfflinePuzzle>,
}

#[derive(Serialize)]
pub(super) struct OfflineDay {
    year: u16,
    day: u8,
    template: String,
    empty_version: String,
    puzzle: OfflinePuzzle,
}

#[derive(Serialize)]
pub(super) struct YearCacheStatus {
    year: u16,
    caching: bool,
    cached_days: usize,
    total_unlocked: usize,
    error: Option<String>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn unlocked_days(year: u16) -> Vec<u8> {
    let now = now_secs();
    (1..=crate::calendar::days_in(year))
        .filter(|&day| crate::calendar::is_unlocked(year, day, now))
        .collect()
}

fn count_cached_days(app: &Shared, year: u16, unlocked: &[u8]) -> Result<usize, anyhow::Error> {
    let mut cached = 0;
    for &day in unlocked {
        let p = Puzzle::new(year, day)?;
        if app.aoc.cached_problem(p)?.is_some() && app.aoc.cached_input(p)?.is_some() {
            cached += 1;
        }
    }
    Ok(cached)
}

fn load_offline_puzzle(
    app: &Shared,
    profile: &LanguageProfile,
    p: Puzzle,
) -> Result<(Option<OfflinePuzzle>, bool), anyhow::Error> {
    let problem = app.aoc.cached_problem(p)?;
    let input = app.aoc.cached_input(p)?;
    let code = app.workspace.load_existing_code(profile, p)?;
    let loaded_notes = app.workspace.load_notes(p)?;
    let notes = (!loaded_notes.text.is_empty()).then_some(loaded_notes);
    let fully_cached = problem.is_some() && input.is_some();
    if problem.is_some() || input.is_some() || code.is_some() || notes.is_some() {
        let path = profile.solution_path(&app.workspace.solutions_dir, p)?;
        let meta = app.workspace.load_day_meta(p)?;
        return Ok((
            Some(OfflinePuzzle {
                day: p.day,
                problem,
                input,
                code,
                notes,
                file_uri: file_uri(&path),
                meta,
            }),
            fully_cached,
        ));
    }
    Ok((None, false))
}

/// Returns everything already cached on the server for a year's unlocked puzzles without making
/// any network requests to Advent of Code.
pub(super) async fn offline(
    State(app): State<Shared>,
    Path(year): Path<u16>,
) -> ApiResult<OfflineYear> {
    puzzle(year, 1)?;
    let profile = app.language();
    let unlocked = unlocked_days(year);
    let mut puzzles = Vec::new();
    let mut cached_days = 0;

    for &day in &unlocked {
        let p = Puzzle::new(year, day)?;
        let (offline_puzzle, fully_cached) = load_offline_puzzle(&app, profile, p)?;
        if fully_cached {
            cached_days += 1;
        }
        if let Some(item) = offline_puzzle {
            puzzles.push(item);
        }
    }

    let state = lock(&app.year_cache)
        .get(&year)
        .cloned()
        .unwrap_or_default();
    Ok(Json(OfflineYear {
        year,
        caching: state.caching,
        cached_days,
        total_unlocked: unlocked.len(),
        error: state.error,
        template: profile.template.clone(),
        empty_version: version_of(""),
        puzzles,
    }))
}

/// Fetches (if needed, through the throttled AoC client) and returns a single unlocked day's
/// offline bundle so clients can download a year incrementally and resume after interruptions.
pub(super) async fn offline_day(
    State(app): State<Shared>,
    Path((year, day)): Path<(u16, u8)>,
) -> ApiResult<OfflineDay> {
    let p = puzzle(year, day)?;
    if !crate::calendar::is_unlocked(year, day, now_secs()) {
        return Err(bad_request(format!(
            "Day {day} of {year} hasn't unlocked yet."
        )));
    }
    let already_cached = app.aoc.cached_problem(p)?.is_some() && app.aoc.cached_input(p)?.is_some();
    if !already_cached {
        if !app.aoc.has_session() {
            return Err(anyhow::Error::from(crate::aoc::NeedsLogin(
                "Log in to Advent of Code before saving puzzles for offline use.",
            ))
            .into());
        }
        app.aoc.prefetch_puzzle_background(p).await?;
    }
    let profile = app.language();
    let path = profile.solution_path(&app.workspace.solutions_dir, p)?;
    let (loaded, _) = load_offline_puzzle(&app, profile, p)?;
    let item = loaded.unwrap_or(OfflinePuzzle {
        day,
        problem: None,
        input: None,
        code: None,
        notes: None,
        file_uri: file_uri(&path),
        meta: app.workspace.load_day_meta(p)?,
    });
    Ok(Json(OfflineDay {
        year,
        day,
        template: profile.template.clone(),
        empty_version: version_of(""),
        puzzle: item,
    }))
}

/// Lightweight status of a year's offline cache prefetch, for polling without re-sending puzzle
/// bodies and inputs.
pub(super) async fn cache_status(
    State(app): State<Shared>,
    Path(year): Path<u16>,
) -> ApiResult<YearCacheStatus> {
    puzzle(year, 1)?;
    let unlocked = unlocked_days(year);
    let cached_days = count_cached_days(&app, year, &unlocked)?;
    let state = lock(&app.year_cache)
        .get(&year)
        .cloned()
        .unwrap_or_default();
    Ok(Json(YearCacheStatus {
        year,
        caching: state.caching,
        cached_days,
        total_unlocked: unlocked.len(),
        error: state.error,
    }))
}

/// Starts a background prefetch of a year's unlocked puzzles and inputs through the throttled
/// Advent of Code client. Returns immediately with the current cache status.
pub(super) async fn cache(
    State(app): State<Shared>,
    Path(year): Path<u16>,
) -> ApiResult<YearCacheStatus> {
    puzzle(year, 1)?;
    if !app.aoc.has_session() {
        return Err(anyhow::Error::from(crate::aoc::NeedsLogin(
            "Log in to Advent of Code before saving puzzles for offline use.",
        ))
        .into());
    }
    let unlocked = unlocked_days(year);
    let cached_days = count_cached_days(&app, year, &unlocked)?;

    let should_start = {
        let mut map = lock(&app.year_cache);
        let entry = map.entry(year).or_default();
        if entry.caching {
            false
        } else {
            entry.caching = true;
            entry.error = None;
            true
        }
    };

    if should_start {
        let bg = Arc::clone(&app);
        let days = unlocked.clone();
        tokio::spawn(async move {
            let mut err_msg = None;
            for day in days {
                let Ok(p) = Puzzle::new(year, day) else {
                    continue;
                };
                if let Err(err) = bg.aoc.prefetch_puzzle_background(p).await {
                    err_msg = Some(format!("{err:#}"));
                    break;
                }
            }
            let mut map = lock(&bg.year_cache);
            let entry = map.entry(year).or_default();
            entry.caching = false;
            entry.error = err_msg;
        });
    }

    let state = lock(&app.year_cache)
        .get(&year)
        .cloned()
        .unwrap_or_default();
    Ok(Json(YearCacheStatus {
        year,
        caching: state.caching,
        cached_days,
        total_unlocked: unlocked.len(),
        error: state.error,
    }))
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::{StatusCode, header};

    use crate::server::testing::{send, test_app};

    #[tokio::test]
    async fn offline_year_and_helpers_work_without_network() {
        let (_dir, router) = test_app().await;
        let helpers_req = Request::get("/api/helpers")
            .header(header::COOKIE, "workshop_token=secret")
            .body(Body::empty())
            .unwrap();
        let helpers_res = send(&router, helpers_req).await;
        assert_eq!(helpers_res.status(), StatusCode::OK);
        let body = axum::body::to_bytes(helpers_res.into_body(), usize::MAX)
            .await
            .unwrap();
        let helpers: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(helpers["file"].is_string());
        assert!(helpers["text"].is_string());

        let offline_req = Request::get("/api/years/2017/offline")
            .header(header::COOKIE, "workshop_token=secret")
            .body(Body::empty())
            .unwrap();
        let offline_res = send(&router, offline_req).await;
        assert_eq!(offline_res.status(), StatusCode::OK);
        let body = axum::body::to_bytes(offline_res.into_body(), usize::MAX)
            .await
            .unwrap();
        let year: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(year["year"], 2017);
        assert_eq!(year["total_unlocked"], 25);
        assert_eq!(year["cached_days"], 0);
        assert!(year["template"].is_string());
        assert!(year["empty_version"].is_string());

        // Starting cache without a session asks to log in rather than failing silently.
        let cache_req = Request::post("/api/years/2017/cache")
            .header(header::COOKIE, "workshop_token=secret")
            .body(Body::empty())
            .unwrap();
        let cache_res = send(&router, cache_req).await;
        assert_eq!(cache_res.status(), StatusCode::BAD_REQUEST);

        // Requesting a single uncached day without a session also asks to log in.
        let day_req = Request::get("/api/years/2017/offline/1")
            .header(header::COOKIE, "workshop_token=secret")
            .body(Body::empty())
            .unwrap();
        let day_res = send(&router, day_req).await;
        assert_eq!(day_res.status(), StatusCode::BAD_REQUEST);
    }
}
