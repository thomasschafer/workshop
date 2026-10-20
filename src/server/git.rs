//! Committing and pushing the solutions repo when asked.

use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};

use super::error::ApiResult;
use super::state::Shared;

#[derive(Deserialize)]
pub(super) struct GitSyncBody {
    message: String,
}

#[derive(Serialize)]
pub(super) struct GitSynced {
    summary: String,
}

pub(super) async fn git_sync(
    State(app): State<Shared>,
    Json(body): Json<GitSyncBody>,
) -> ApiResult<GitSynced> {
    Ok(Json(GitSynced {
        summary: app.workspace.commit_and_push(&body.message).await?,
    }))
}
