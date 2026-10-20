//! Choices made in the app's settings: the models, the colours, committing after each star and
//! which private leaderboard to show.

use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};

use super::error::{ApiResult, bad_request};
use super::state::{App, Shared};
use crate::models::{self, ModelSettings, ProviderOption};

/// The model choices, with what each provider offers.
#[derive(Serialize)]
pub(super) struct ModelsState {
    providers: Vec<ProviderOption>,
    settings: ModelSettings,
    /// The models to choose between in the Discuss tab.
    discuss_models: Vec<String>,
}

pub(super) fn models_state(app: &App) -> ModelsState {
    let settings = app.model_settings();
    ModelsState {
        providers: models::options(&app.config),
        discuss_models: models::discuss_models(&app.config, &settings.discuss_provider),
        settings,
    }
}

pub(super) async fn get_models(State(app): State<Shared>) -> ApiResult<ModelsState> {
    Ok(Json(models_state(&app)))
}

pub(super) async fn set_models(
    State(app): State<Shared>,
    Json(settings): Json<ModelSettings>,
) -> ApiResult<ModelsState> {
    settings
        .validate(&app.config)
        .map_err(|e| bad_request(format!("{e:#}")))?;
    let options = models::options(&app.config);
    for provider in [&settings.edit.provider, &settings.discuss_provider] {
        if let Some(reason) = options
            .iter()
            .find(|o| &o.id == provider)
            .and_then(|o| o.unavailable.clone())
        {
            return Err(bad_request(reason));
        }
    }
    app.update_settings(|s| s.models = settings)?;
    // Start the newly chosen edit model now, so the first edit with it is quick.
    let warm = app.clone();
    tokio::spawn(async move { warm.warm_edit_model().await });
    Ok(Json(models_state(&app)))
}

/// The stylesheet for the chosen themes. A theme that's gone missing shouldn't stop the app
/// loading, so it falls back to Workshop's colours.
pub(super) fn theme_css(app: &App) -> Option<String> {
    crate::theme::stylesheet(&app.paths, &app.settings().theme).unwrap_or_else(|err| {
        tracing::warn!("using the default colours: {err:#}");
        None
    })
}

#[derive(Serialize)]
pub(super) struct ThemesState {
    names: Vec<String>,
    /// The light and dark themes Ghostty uses, if its config sets one.
    ghostty: Option<(String, String)>,
    settings: crate::theme::ThemeSettings,
}

pub(super) async fn themes(State(app): State<Shared>) -> ApiResult<ThemesState> {
    Ok(Json(ThemesState {
        names: crate::theme::available(&app.paths),
        ghostty: crate::theme::ghostty_themes(),
        settings: app.settings().theme,
    }))
}

#[derive(Serialize)]
pub(super) struct ThemeApplied {
    css: Option<String>,
}

pub(super) async fn set_theme(
    State(app): State<Shared>,
    Json(theme): Json<crate::theme::ThemeSettings>,
) -> ApiResult<ThemeApplied> {
    // Checks the themes can be loaded before saving the choice.
    let css =
        crate::theme::stylesheet(&app.paths, &theme).map_err(|e| bad_request(format!("{e:#}")))?;
    app.update_settings(|s| s.theme = theme)?;
    Ok(Json(ThemeApplied { css }))
}

#[derive(Deserialize)]
pub(super) struct SolutionsRepoBody {
    commit_after_star: bool,
}

pub(super) async fn set_solutions_repo(
    State(app): State<Shared>,
    Json(body): Json<SolutionsRepoBody>,
) -> ApiResult<()> {
    app.update_settings(|s| s.commit_after_star = Some(body.commit_after_star))?;
    Ok(Json(()))
}

#[derive(Deserialize)]
pub(super) struct LeaderboardBody {
    /// The ID, or nothing to stop showing one.
    id: Option<String>,
}

pub(super) async fn set_leaderboard(
    State(app): State<Shared>,
    Json(body): Json<LeaderboardBody>,
) -> ApiResult<()> {
    let id = body
        .id
        .map(crate::aoc::LeaderboardId::try_from)
        .transpose()
        .map_err(|e| bad_request(format!("{e:#}")))?;
    app.update_settings(|s| s.leaderboard = id)?;
    Ok(Json(()))
}
