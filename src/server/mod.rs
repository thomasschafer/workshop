//! The HTTP server the app talks to: its API, the language server relay, and the built frontend.
//!
//! Every route is listed in `router`; the handlers live in the module for their area.

mod author;
mod bench;
mod client;
mod coding;
mod design;
mod discuss;
mod edit;
mod error;
mod follow_ups;
mod git;
mod grading;
mod home;
mod install;
mod learning;
mod lsp;
mod mistakes;
mod notifications;
mod on_device;
mod packages;
mod packs;
mod puzzles;
mod replies;
mod rounds;
mod run;
mod settings;
mod setup;
mod speech;
mod state;
mod sync;
mod years;

use axum::Router;
use axum::body::Body;
use axum::extract::DefaultBodyLimit;
use axum::http::{StatusCode, Uri, header};
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{any, delete, get, post, put};
use rust_embed::RustEmbed;
use tower_http::compression::CompressionLayer;
use tower_http::compression::predicate::{DefaultPredicate, NotForContentType, Predicate};

pub use author::run_on_schedule as run_author_on_schedule;
pub(crate) use lsp::file_uri;
pub use state::App;
use state::Shared;

#[derive(RustEmbed)]
#[folder = "frontend/dist"]
struct Assets;

pub fn router(app: Shared) -> Router {
    let api = Router::new()
        .route("/bootstrap", get(client::bootstrap))
        .route("/ping", get(client::ping))
        .route("/home", get(home::home))
        .route("/learning/deck", get(learning::deck))
        .route("/learning/sync", post(learning::sync))
        .route("/sync", post(sync::sync))
        .route("/mistakes", get(mistakes::mistakes))
        .route("/goals", get(mistakes::goals))
        .route("/design", get(design::list))
        .route("/design/{pack}/{item}", get(design::open))
        .route("/design/{pack}/{item}/start", post(design::start))
        .route("/design/{pack}/{item}/session", put(design::save))
        .route("/design/{pack}/{item}/coach", post(design::coach_turn))
        .route("/design/{pack}/{item}/finish", post(design::finish))
        .route("/rounds", get(rounds::overview))
        .route("/rounds/{pack}/{item}/open", post(rounds::open))
        .route("/rounds/{pack}/{item}/start", post(rounds::start))
        .route("/rounds/{pack}/{item}/beat", post(rounds::beat))
        .route("/rounds/{pack}/{item}/say", post(rounds::say))
        .route("/rounds/{pack}/{item}/end", post(rounds::end))
        .route("/items/{pack}/{item}/mark", post(grading::mark))
        .route("/cards/flagged", get(grading::flagged))
        .route("/packs", get(packs::packs))
        .route("/packs/import", post(packs::import))
        .route("/author", get(author::author))
        .route("/author/run", post(author::top_up))
        .route("/author/queue/{id}", post(author::decide))
        .route("/author/questions/{id}", post(author::answer))
        .route("/cards/{pack}/{item}/review", post(grading::review))
        .route("/cards/{pack}/{item}/fix", post(grading::fix))
        .route("/cards/{pack}/{item}/follow-ups", get(follow_ups::open))
        .route(
            "/cards/{pack}/{item}/follow-ups/start",
            post(follow_ups::start),
        )
        .route(
            "/cards/{pack}/{item}/follow-ups/reply",
            post(follow_ups::reply),
        )
        .route("/cards/{pack}/{item}/follow-ups/ask", post(follow_ups::ask))
        .route(
            "/cards/{pack}/{item}/follow-ups/finish",
            post(follow_ups::finish),
        )
        .route("/mistakes/tag", put(mistakes::tag))
        .route("/coding", get(coding::overview))
        .route("/coding/offline-bundle", get(coding::offline_bundle))
        .route("/coding/items/{pack}/{item}/open", post(coding::open))
        .route(
            "/coding/items/{pack}/{item}/session",
            put(coding::save_session),
        )
        .route(
            "/coding/items/{pack}/{item}/code/{language}",
            put(coding::save_code),
        )
        .route(
            "/coding/items/{pack}/{item}/files/{file}",
            put(coding::save_file),
        )
        .route(
            "/coding/reviews/{pack}/{item}/session",
            put(coding::save_review),
        )
        .route(
            "/coding/reviews/{pack}/{item}/submit",
            post(coding::submit_review),
        )
        .route("/coding/items/{pack}/{item}/run", post(coding::run))
        .route("/coding/items/{pack}/{item}/submit", post(coding::submit))
        .route("/coding/items/{pack}/{item}/finish", post(coding::finish))
        .route(
            "/coding/items/{pack}/{item}/bring-back",
            post(coding::bring_back),
        )
        .route("/coding/items/{pack}/{item}/tutor", post(coding::tutor))
        .route("/coding/items/{pack}/{item}/twist", post(coding::twist))
        .route(
            "/coding/items/{pack}/{item}/twist/answer",
            post(coding::answer_twist),
        )
        .route("/coding/lsp/{language}", get(coding::lsp))
        .route(
            "/coding/toolchain/{language}",
            get(coding::toolchain).post(coding::install_toolchain),
        )
        .route(
            "/coding/toolchain/{language}/cancel",
            post(coding::cancel_toolchain_install),
        )
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
        .route("/on-device/bundles", get(on_device::get_bundles))
        .route(
            "/on-device/bundles/{id}/download",
            post(on_device::download_bundle),
        )
        .route(
            "/on-device/bundles/cancel",
            post(on_device::cancel_download),
        )
        .route("/on-device/bundles/{id}", delete(on_device::delete_bundle))
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
        .route("/years/{year}/offline", get(years::offline))
        .route("/years/{year}/offline/{day}", get(years::offline_day))
        .route(
            "/years/{year}/cache",
            get(years::cache_status).post(years::cache),
        )
        .route("/helpers", get(puzzles::helpers))
        .route("/leaderboard", put(settings::set_leaderboard))
        .route("/puzzles/{year}/{day}", get(puzzles::open_puzzle))
        .route("/puzzles/{year}/{day}/code", put(puzzles::save_code))
        .route("/puzzles/{year}/{day}/notes", put(puzzles::save_notes))
        .route("/puzzles/{year}/{day}/meta", put(puzzles::save_meta))
        .route("/puzzles/{year}/{day}/problem", get(puzzles::problem))
        .route("/puzzles/{year}/{day}/input", get(puzzles::input))
        .route("/puzzles/{year}/{day}/run", post(run::run))
        .route("/puzzles/{year}/{day}/format", post(run::format))
        .route("/puzzles/{year}/{day}/submit", post(run::submit))
        .route(
            "/puzzles/{year}/{day}/sample/{part}",
            post(puzzles::find_sample),
        )
        .route("/run/cancel", post(run::cancel_run))
        .route("/edit", post(edit::edit_code))
        .route("/discuss", post(discuss::discuss))
        .route("/replies/{id}", get(replies::reply))
        .route("/git/sync", post(git::git_sync))
        .route("/log", post(client::client_log))
        .route("/lsp", get(lsp::lsp))
        .route("/lsp/restart", post(lsp::restart));
    let static_service = any(static_asset).layer(
        CompressionLayer::new().compress_when(
            DefaultPredicate::new()
                .and(NotForContentType::new("font/woff2"))
                .and(NotForContentType::new("application/font-woff2"))
                .and(NotForContentType::new("application/gzip"))
                .and(NotForContentType::new("application/zstd")),
        ),
    );
    Router::new()
        .nest("/api", api)
        .route("/on-device/{bundle}/{file}", get(on_device::serve_file))
        .fallback_service(static_service)
        .layer(middleware::from_fn_with_state(
            app.gate.clone(),
            workshop_auth::require_token,
        ))
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
        let router = test_app_in(dir.path(), "");
        (dir, router)
    }

    /// A server with its data in `dir`, and this config.
    pub fn test_app_in(dir: &std::path::Path, config: &str) -> Router {
        router(test_state_in(dir, config))
    }

    /// The state of a server with its data in `dir`, and this config, for tests that look at it.
    pub fn test_state_in(dir: &std::path::Path, config: &str) -> Arc<App> {
        let mut config = Config::parse(config).unwrap();
        config.solutions_dir = dir.join("aoc");
        Arc::new(App::new(config, Paths::under(dir), "secret".into(), None).unwrap())
    }

    /// Config for a stand-in discussion model, a shell script in `dir` that replies with the
    /// file named by the first pattern the prompt matches, of `replies`: (pattern, file name).
    #[cfg(unix)]
    pub fn fake_discussion_model(dir: &std::path::Path, replies: &[(&str, &str)]) -> String {
        let mut script = String::from("prompt=$(cat)\ncase \"$prompt\" in\n");
        for (pattern, file) in replies {
            let file = dir.join(file);
            script.push_str(&format!("  *'{pattern}'*) cat '{}' ;;\n", file.display()));
        }
        script.push_str(
            "  *) echo 'The fake model has no reply for this prompt' >&2; exit 1 ;;\nesac\n",
        );
        fake_script_model(dir, &script)
    }

    /// Config for a stand-in discussion model that's a shell script of a test's own, in `dir`,
    /// given the prompt on stdin.
    #[cfg(unix)]
    pub fn fake_script_model(dir: &std::path::Path, script: &str) -> String {
        let path = dir.join("fake-model.sh");
        std::fs::write(&path, script).unwrap();
        format!(
            "[providers.fake]\ncommand = [\"sh\", {path:?}]\ninput = \"stdin\"\noutput = \"text\"\ndiscuss_models = [\"fake\"]\n\n[models.discuss]\nprovider = \"fake\"\nmodels = [\"fake\"]\n",
            path = path.display().to_string()
        )
    }

    pub async fn send(router: &Router, request: Request) -> Response {
        use tower::ServiceExt;
        router.clone().oneshot(request).await.unwrap()
    }
}

#[cfg(test)]
mod tests {
    use axum::body::{Body, to_bytes};
    use axum::extract::Request;
    use axum::http::{StatusCode, header};

    use super::Assets;
    use super::testing::{send, test_app};

    #[tokio::test]
    async fn asks_for_the_token_except_for_what_installing_needs() {
        let (_dir, router) = test_app().await;
        let request = Request::get("/api/bootstrap").body(Body::empty()).unwrap();
        assert_eq!(
            send(&router, request).await.status(),
            StatusCode::UNAUTHORIZED
        );
        let request = Request::get("/api/bootstrap")
            .header(header::COOKIE, "workshop_token=secret")
            .body(Body::empty())
            .unwrap();
        assert_eq!(send(&router, request).await.status(), StatusCode::OK);
        let request = Request::get("/manifest.webmanifest")
            .body(Body::empty())
            .unwrap();
        assert_eq!(send(&router, request).await.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn compresses_wasm_assets_and_skips_already_compressed_fonts() {
        let wasm_path = Assets::iter()
            .find(|p| p.ends_with(".wasm") && p.contains("haskell"))
            .expect("embedded frontend should include the Haskell tree-sitter wasm asset");
        let raw_len = Assets::get(&wasm_path).unwrap().data.len();

        let (_dir, router) = test_app().await;

        let gzip_req = Request::get(format!("/{wasm_path}"))
            .header(header::COOKIE, "workshop_token=secret")
            .header(header::ACCEPT_ENCODING, "gzip")
            .body(Body::empty())
            .unwrap();
        let gzip_res = send(&router, gzip_req).await;
        assert_eq!(gzip_res.status(), StatusCode::OK);
        assert_eq!(
            gzip_res.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/wasm"
        );
        assert_eq!(
            gzip_res.headers().get(header::CONTENT_ENCODING).unwrap(),
            "gzip"
        );
        let gzip_body = to_bytes(gzip_res.into_body(), usize::MAX).await.unwrap();
        assert!(
            gzip_body.len() < raw_len / 2,
            "expected gzipped wasm ({}) to be much smaller than raw ({raw_len})",
            gzip_body.len()
        );

        let br_req = Request::get(format!("/{wasm_path}"))
            .header(header::COOKIE, "workshop_token=secret")
            .header(header::ACCEPT_ENCODING, "br")
            .body(Body::empty())
            .unwrap();
        let br_res = send(&router, br_req).await;
        assert_eq!(br_res.status(), StatusCode::OK);
        assert_eq!(
            br_res.headers().get(header::CONTENT_ENCODING).unwrap(),
            "br"
        );

        if let Some(woff2_path) = Assets::iter().find(|p| p.ends_with(".woff2")) {
            let font_req = Request::get(format!("/{woff2_path}"))
                .header(header::COOKIE, "workshop_token=secret")
                .header(header::ACCEPT_ENCODING, "gzip, br")
                .body(Body::empty())
                .unwrap();
            let font_res = send(&router, font_req).await;
            assert_eq!(font_res.status(), StatusCode::OK);
            assert!(
                font_res.headers().get(header::CONTENT_ENCODING).is_none(),
                "woff2 fonts are already compressed and should not be re-compressed"
            );
        }
    }
}
