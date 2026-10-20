//! The HTTP server the app talks to: its API, the language server relay, and the built frontend.
//!
//! Every route is listed in `router`; the handlers live in the module for their area.

mod auth;
mod bench;
mod client;
mod discuss;
mod edit;
mod error;
mod git;
mod install;
mod lsp;
mod notifications;
mod packages;
mod puzzles;
mod run;
mod settings;
mod setup;
mod speech;
mod state;
mod years;

use axum::Router;
use axum::body::Body;
use axum::extract::DefaultBodyLimit;
use axum::http::{StatusCode, Uri, header};
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use rust_embed::RustEmbed;

pub use auth::load_or_create_token;
pub use state::App;
use state::Shared;

#[derive(RustEmbed)]
#[folder = "frontend/dist"]
struct Assets;

pub fn router(app: Shared) -> Router {
    let api = Router::new()
        .route("/bootstrap", get(client::bootstrap))
        .route("/ping", get(client::ping))
        .route("/state", put(client::save_state))
        .route("/doctor", get(setup::run_doctor))
        .route(
            "/models",
            get(settings::get_models).put(settings::set_models),
        )
        .route("/setup", get(setup::setup_state))
        .route("/themes", get(settings::themes))
        .route("/theme", put(settings::set_theme))
        .route("/solutions-repo", put(settings::set_solutions_repo))
        .route("/setup/language", put(setup::set_language))
        .route("/setup/aoc-session", post(setup::set_aoc_session))
        .route("/setup/toolchain", post(setup::install_toolchain))
        .route(
            "/setup/toolchain/cancel",
            post(setup::cancel_toolchain_install),
        )
        .route(
            "/packages",
            get(packages::get_packages).put(packages::save_packages),
        )
        .route("/packages/install", post(packages::install_packages))
        .route("/packages/add", post(packages::add_package))
        .route("/packages/remove", post(packages::remove_package))
        .route("/packages/cancel", post(packages::cancel_install))
        .route("/packages/resolve", post(packages::resolve_package))
        .route("/practice/reset", post(puzzles::reset_practice))
        .route("/notifications", get(notifications::notifications))
        .route(
            "/notifications/subscribed",
            post(notifications::notifications_subscribed),
        )
        .route(
            "/notifications/subscribe",
            post(notifications::subscribe_notifications),
        )
        .route(
            "/notifications/unsubscribe",
            post(notifications::unsubscribe_notifications),
        )
        .route(
            "/notifications/test",
            post(notifications::test_notification),
        )
        .route("/speech", get(speech::get_speech))
        .route("/speech/download", post(speech::download_speech_model))
        .route(
            "/speech/download/cancel",
            post(speech::cancel_speech_download),
        )
        .route(
            "/speech/transcribe",
            post(speech::transcribe).layer(DefaultBodyLimit::max(speech::RECORDING_LIMIT)),
        )
        .route("/bench", get(bench::bench_info))
        .route(
            "/bench/transcribe",
            post(bench::bench_transcribe).layer(DefaultBodyLimit::max(speech::RECORDING_LIMIT)),
        )
        .route("/bench/result", post(bench::bench_result))
        .route("/years/{year}/stars", get(years::stars))
        .route("/years/{year}/times", get(years::times))
        .route("/years/{year}/leaderboard", get(years::leaderboard))
        .route("/leaderboard", put(settings::set_leaderboard))
        .route("/puzzles/{year}/{day}", get(puzzles::open_puzzle))
        .route("/puzzles/{year}/{day}/code", put(puzzles::save_code))
        .route("/puzzles/{year}/{day}/notes", put(puzzles::save_notes))
        .route("/puzzles/{year}/{day}/meta", put(puzzles::save_meta))
        .route("/puzzles/{year}/{day}/problem", get(puzzles::problem))
        .route("/puzzles/{year}/{day}/input", get(puzzles::input))
        .route("/puzzles/{year}/{day}/run", post(run::run))
        .route("/puzzles/{year}/{day}/submit", post(run::submit))
        .route(
            "/puzzles/{year}/{day}/sample/{part}",
            post(puzzles::find_sample),
        )
        .route("/run/cancel", post(run::cancel_run))
        .route("/edit", post(edit::edit_code))
        .route("/discuss", post(discuss::discuss))
        .route("/git/sync", post(git::git_sync))
        .route("/log", post(client::client_log))
        .route("/lsp", get(lsp::lsp));
    Router::new()
        .nest("/api", api)
        .fallback(static_asset)
        .layer(middleware::from_fn_with_state(app.clone(), auth::auth))
        .with_state(app)
}

async fn static_asset(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let (path, asset) = match Assets::get(path) {
        Some(asset) => (path, asset),
        None => match Assets::get("index.html") {
            Some(asset) => ("index.html", asset),
            None => {
                return (
                    StatusCode::NOT_FOUND,
                    "The frontend hasn't been built. Run `mise run build-frontend`.",
                )
                    .into_response();
            }
        },
    };
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    // Only Vite's hashed build output can be cached forever; anything else may change.
    let cache = if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    (
        [
            (header::CONTENT_TYPE, mime.as_ref().to_owned()),
            (header::CACHE_CONTROL, cache.to_owned()),
        ],
        Body::from(asset.data.into_owned()),
    )
        .into_response()
}

/// A server for the tests, with the token `secret`, and a way to send it requests.
#[cfg(test)]
mod testing {
    use std::sync::Arc;

    use axum::Router;
    use axum::extract::Request;
    use axum::response::Response;

    use super::{App, router};
    use crate::config::Config;
    use crate::paths::Paths;

    pub async fn test_app() -> (tempfile::TempDir, Router) {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::parse("").unwrap();
        config.solutions_dir = dir.path().join("aoc");
        let app = App::new(config, Paths::under(dir.path()), "secret".into(), None).unwrap();
        (dir, router(Arc::new(app)))
    }

    pub async fn send(router: &Router, request: Request) -> Response {
        use tower::ServiceExt;
        router.clone().oneshot(request).await.unwrap()
    }
}
