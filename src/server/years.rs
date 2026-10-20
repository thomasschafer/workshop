//! Progress through a year's puzzles: stars, when they were earned, and the chosen private
//! leaderboard.

use std::collections::BTreeMap;

use axum::Json;
use axum::extract::{Path, Query, State};

use super::error::ApiResult;
use super::puzzles::RefreshQuery;
use super::state::Shared;

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
