use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use axum::body::Body;
use axum::extract::{Path, Query, Request, State, WebSocketUpgrade};
use axum::http::{HeaderMap, Method, StatusCode, Uri, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::aoc::{AocClient, Part, Problem, SubmitOutcome};
use crate::config::{Config, Snippet};
use crate::discuss::{self, Turn};
use crate::doctor;
use crate::edit::{self, EditOutcome};
use crate::language::Puzzle;
use crate::paths::Paths;
use crate::provider::{CallSpec, ProviderRunner};
use crate::runner::{self, RunResult};
use crate::workspace::{DayMeta, SaveError, UiState, VersionedFile, Workspace};

const TOKEN_COOKIE: &str = "workshop_token";
const EDIT_TIMEOUT: Duration = Duration::from_secs(60);
const DISCUSS_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(RustEmbed)]
#[folder = "frontend/dist"]
struct Assets;

pub struct App {
    config: Config,
    paths: Paths,
    token: String,
    workspace: Workspace,
    aoc: AocClient,
    edit_model: ProviderRunner,
    discuss_model: ProviderRunner,
    run_lock: Mutex<()>,
    /// Cancels the run in progress, if there is one.
    current_run: std::sync::Mutex<Option<CancellationToken>>,
}

type Shared = Arc<App>;

impl App {
    pub fn new(
        config: Config,
        paths: Paths,
        token: String,
        aoc_session: Option<String>,
    ) -> Result<Self> {
        let model_dir = paths.cache_dir.join("model-cwd");
        Ok(Self {
            workspace: Workspace::new(config.solutions_dir.clone(), paths.clone()),
            aoc: AocClient::new(aoc_session, &config.aoc.user_agent, paths.aoc_cache_dir())?,
            edit_model: ProviderRunner::new(
                config.providers[&config.models.edit.provider].clone(),
                model_dir.clone(),
            )?,
            discuss_model: ProviderRunner::new(
                config.providers[&config.models.discuss.provider].clone(),
                model_dir,
            )?,
            run_lock: Mutex::new(()),
            current_run: std::sync::Mutex::new(None),
            config,
            paths,
            token,
        })
    }

    fn edit_spec(&self) -> CallSpec {
        CallSpec {
            model: self.config.models.edit.model.clone(),
            system_prompt: edit::system_prompt(self.config.language()),
        }
    }

    pub async fn warm_up(&self) {
        if let Err(err) = self.workspace.ensure_repo().await {
            tracing::warn!("couldn't set up the solutions repo: {err:#}");
        }
        if let Err(err) = self.edit_model.warm(&self.edit_spec()).await {
            tracing::warn!("couldn't start the edit model: {err:#}");
        }
    }
}

pub fn router(app: Shared) -> Router {
    let api = Router::new()
        .route("/bootstrap", get(bootstrap))
        .route("/state", put(save_state))
        .route("/doctor", get(run_doctor))
        .route("/years/{year}/stars", get(stars))
        .route("/puzzles/{year}/{day}", get(open_puzzle))
        .route("/puzzles/{year}/{day}/code", put(save_code))
        .route("/puzzles/{year}/{day}/notes", put(save_notes))
        .route("/puzzles/{year}/{day}/meta", put(save_meta))
        .route("/puzzles/{year}/{day}/problem", get(problem))
        .route("/puzzles/{year}/{day}/input", get(input))
        .route("/puzzles/{year}/{day}/run", post(run))
        .route("/puzzles/{year}/{day}/submit", post(submit))
        .route("/run/cancel", post(cancel_run))
        .route("/edit", post(edit_code))
        .route("/discuss", post(discuss))
        .route("/git/sync", post(git_sync))
        .route("/log", post(client_log))
        .route("/lsp", get(lsp));
    Router::new()
        .nest("/api", api)
        .fallback(static_asset)
        .layer(middleware::from_fn_with_state(app.clone(), auth))
        .with_state(app)
}

// Authentication: the token arrives once in the URL printed by `workshop serve`, and is then
// kept in an HttpOnly cookie.
async fn auth(State(app): State<Shared>, request: Request, next: Next) -> Response {
    let query_token = request.uri().query().and_then(|q| {
        q.split('&')
            .filter_map(|pair| pair.split_once('='))
            .find(|(k, _)| *k == "token")
            .map(|(_, v)| v.to_owned())
    });
    if let Some(token) = query_token {
        if !constant_time_eq(token.as_bytes(), app.token.as_bytes()) {
            return unauthorised();
        }
        // Lax rather than Strict: links opened from outside the browser, such as a scanned QR
        // code, count as cross-site, and Strict cookies wouldn't be sent after the redirect.
        // Requests that change anything are protected by the origin check below.
        let cookie = format!(
            "{TOKEN_COOKIE}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000",
            app.token
        );
        let mut response = Redirect::to(request.uri().path()).into_response();
        if let Ok(value) = cookie.parse() {
            response.headers_mut().insert(header::SET_COOKIE, value);
        }
        return response;
    }

    let authorised = cookie_token(request.headers())
        .is_some_and(|t| constant_time_eq(t.as_bytes(), app.token.as_bytes()));
    if !authorised {
        return unauthorised();
    }
    let is_websocket = request.headers().contains_key(header::UPGRADE);
    if (request.method() != Method::GET || is_websocket) && !same_origin(request.headers()) {
        return (StatusCode::FORBIDDEN, "Cross-origin request refused").into_response();
    }
    next.run(request).await
}

fn cookie_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == TOKEN_COOKIE)
        .map(|(_, value)| value)
}

fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|o| o.to_str().ok()) else {
        // Non-browser clients don't send an Origin, and browsers always do on these requests.
        return true;
    };
    let Some(host) = headers.get(header::HOST).and_then(|h| h.to_str().ok()) else {
        return false;
    };
    let origin_host = origin.split_once("://").map_or(origin, |(_, rest)| rest);
    origin_host.eq_ignore_ascii_case(host)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn unauthorised() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        "<!doctype html><meta name=viewport content='width=device-width'><title>Workshop</title>\
         <body style='font-family:ui-monospace,monospace;padding:2rem;max-width:32rem'>\
         <p>Workshop needs the link with the access token. It was printed in the terminal \
         when the server started; run <code>workshop token</code> to see it again.</p>",
    )
        .into_response()
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

// Errors are shown to the user, so they carry the full context chain.
struct ApiError(StatusCode, serde_json::Value);

impl From<anyhow::Error> for ApiError {
    fn from(err: anyhow::Error) -> Self {
        tracing::warn!("{err:#}");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            serde_json::json!({ "error": format!("{err:#}") }),
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(self.1)).into_response()
    }
}

type ApiResult<T> = Result<Json<T>, ApiError>;

fn puzzle(year: u16, day: u8) -> Result<Puzzle, ApiError> {
    Puzzle::new(year, day).map_err(|err| {
        ApiError(
            StatusCode::BAD_REQUEST,
            serde_json::json!({ "error": err.to_string() }),
        )
    })
}

#[derive(Serialize)]
struct Bootstrap {
    state: UiState,
    language: LanguageInfo,
    snippets: Vec<Snippet>,
    discuss_models: Vec<String>,
    edit_model: String,
    has_aoc_session: bool,
}

#[derive(Serialize)]
struct LanguageInfo {
    id: String,
    name: String,
    editor_mode: String,
    lsp_language_id: String,
    has_lsp: bool,
    root_uri: String,
}

async fn bootstrap(State(app): State<Shared>) -> ApiResult<Bootstrap> {
    let language = app.config.language();
    let has_lsp = language
        .lsp
        .as_ref()
        .and_then(|c| c.first())
        .is_some_and(|p| doctor::find_program(p).is_some());
    Ok(Json(Bootstrap {
        state: app.workspace.load_ui_state()?,
        language: LanguageInfo {
            id: app.config.language_id.clone(),
            name: language.name.clone(),
            editor_mode: language.editor_mode.clone(),
            lsp_language_id: language.lsp_language_id.clone(),
            has_lsp,
            root_uri: file_uri(&app.config.solutions_dir),
        },
        snippets: app.config.snippets.clone(),
        discuss_models: app.config.models.discuss.models.clone(),
        edit_model: app.config.models.edit.model.clone(),
        has_aoc_session: app.aoc.has_session(),
    }))
}

async fn save_state(State(app): State<Shared>, Json(state): Json<UiState>) -> ApiResult<()> {
    app.workspace.save_ui_state(&state)?;
    Ok(Json(()))
}

async fn run_doctor(State(app): State<Shared>) -> ApiResult<Vec<doctor::Check>> {
    Ok(Json(
        doctor::run(&app.config, &app.paths, app.aoc.has_session()).await,
    ))
}

#[derive(Deserialize)]
struct RefreshQuery {
    #[serde(default)]
    refresh: bool,
}

async fn stars(
    State(app): State<Shared>,
    Path(year): Path<u16>,
    Query(query): Query<RefreshQuery>,
) -> ApiResult<BTreeMap<u8, u8>> {
    Ok(Json(app.aoc.stars(year, query.refresh).await?))
}

#[derive(Serialize)]
struct OpenPuzzle {
    code: VersionedFile,
    file_uri: String,
    notes: VersionedFile,
    meta: DayMeta,
}

async fn open_puzzle(
    State(app): State<Shared>,
    Path((year, day)): Path<(u16, u8)>,
) -> ApiResult<OpenPuzzle> {
    let puzzle = puzzle(year, day)?;
    app.workspace.ensure_repo().await?;
    let code = app.workspace.load_code(app.config.language(), puzzle)?;
    Ok(Json(OpenPuzzle {
        file_uri: file_uri(&code.path),
        code,
        notes: app.workspace.load_notes(puzzle)?,
        meta: app.workspace.load_day_meta(puzzle)?,
    }))
}

#[derive(Deserialize)]
struct SaveText {
    text: String,
    version: String,
}

async fn save_code(
    State(app): State<Shared>,
    Path((year, day)): Path<(u16, u8)>,
    Json(body): Json<SaveText>,
) -> ApiResult<VersionedFile> {
    let puzzle = puzzle(year, day)?;
    saved(
        app.workspace
            .save_code(app.config.language(), puzzle, &body.text, &body.version),
    )
}

async fn save_notes(
    State(app): State<Shared>,
    Path((year, day)): Path<(u16, u8)>,
    Json(body): Json<SaveText>,
) -> ApiResult<VersionedFile> {
    saved(
        app.workspace
            .save_notes(puzzle(year, day)?, &body.text, &body.version),
    )
}

/// A conflict is reported with the current file, so the editor can offer to load it.
fn saved(result: Result<VersionedFile, SaveError>) -> ApiResult<VersionedFile> {
    match result {
        Ok(file) => Ok(Json(file)),
        Err(SaveError::Conflict { current }) => Err(ApiError(
            StatusCode::CONFLICT,
            serde_json::json!({ "error": "The file changed on disk.", "current": current }),
        )),
        Err(SaveError::Other(err)) => Err(err.into()),
    }
}

async fn save_meta(
    State(app): State<Shared>,
    Path((year, day)): Path<(u16, u8)>,
    Json(meta): Json<DayMeta>,
) -> ApiResult<()> {
    app.workspace.save_day_meta(puzzle(year, day)?, &meta)?;
    Ok(Json(()))
}

async fn problem(
    State(app): State<Shared>,
    Path((year, day)): Path<(u16, u8)>,
    Query(query): Query<RefreshQuery>,
) -> ApiResult<Problem> {
    Ok(Json(
        app.aoc.problem(puzzle(year, day)?, query.refresh).await?,
    ))
}

#[derive(Serialize)]
struct PuzzleInput {
    text: String,
    lines: usize,
}

async fn input(
    State(app): State<Shared>,
    Path((year, day)): Path<(u16, u8)>,
) -> ApiResult<PuzzleInput> {
    let text = app.aoc.input(puzzle(year, day)?).await?;
    Ok(Json(PuzzleInput {
        lines: text.lines().count(),
        text,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum InputKind {
    Sample,
    Real,
}

#[derive(Deserialize)]
struct RunBody {
    input: InputKind,
    /// Which part's sample to use.
    part: u8,
}

async fn run(
    State(app): State<Shared>,
    Path((year, day)): Path<(u16, u8)>,
    Json(body): Json<RunBody>,
) -> ApiResult<RunResult> {
    let puzzle = puzzle(year, day)?;
    let part = Part::from_number(body.part)?;
    let Ok(_guard) = app.run_lock.try_lock() else {
        return Err(ApiError(
            StatusCode::CONFLICT,
            serde_json::json!({ "error": "Something is already running." }),
        ));
    };
    // Registered before fetching the input, so a cancel while fetching isn't lost.
    let cancel = CancellationToken::new();
    *lock(&app.current_run) = Some(cancel.clone());
    let _clear = scopeguard(|| *lock(&app.current_run) = None);

    let input = match body.input {
        InputKind::Sample => app
            .workspace
            .load_day_meta(puzzle)?
            .sample_input(part)
            .context("no sample input is chosen yet; tap a code block in the puzzle to choose one")?
            .to_owned(),
        InputKind::Real => tokio::select! {
            input = app.aoc.input(puzzle) => input?,
            () = cancel.cancelled() => return Err(anyhow::anyhow!("Cancelled.").into()),
        },
    };
    let profile = app.config.language();
    let file = profile.solution_path(&app.config.solutions_dir, puzzle)?;
    let build_dir = app
        .paths
        .build_dir()
        .join(puzzle.year.to_string())
        .join(format!("{:02}", puzzle.day));
    let result = runner::run(runner::RunRequest {
        profile,
        file: &file,
        build_dir: &build_dir,
        puzzle,
        input: &input,
        timeout: Duration::from_secs(app.config.run.timeout_secs),
        cancel: &cancel,
    })
    .await?;
    Ok(Json(result))
}

async fn cancel_run(State(app): State<Shared>) -> ApiResult<()> {
    if let Some(cancel) = lock(&app.current_run).as_ref() {
        cancel.cancel();
    }
    Ok(Json(()))
}

/// Locks a mutex that guards plain data, which stays usable even if a holder panicked.
fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Runs `f` when dropped, however the enclosing scope is left.
fn scopeguard(f: impl FnOnce()) -> impl Drop {
    struct Guard<F: FnOnce()>(Option<F>);
    impl<F: FnOnce()> Drop for Guard<F> {
        fn drop(&mut self) {
            if let Some(f) = self.0.take() {
                f();
            }
        }
    }
    Guard(Some(f))
}

#[derive(Deserialize)]
struct SubmitBody {
    part: u8,
    answer: String,
}

#[derive(Serialize)]
struct Submitted {
    outcome: SubmitOutcome,
    /// The refreshed puzzle after a correct answer, which shows the next part.
    problem: Option<Problem>,
}

async fn submit(
    State(app): State<Shared>,
    Path((year, day)): Path<(u16, u8)>,
    Json(body): Json<SubmitBody>,
) -> ApiResult<Submitted> {
    let puzzle = puzzle(year, day)?;
    let part = Part::from_number(body.part)?;
    let outcome = app.aoc.submit(puzzle, part, &body.answer).await?;
    let problem = if outcome == SubmitOutcome::Correct {
        Some(app.aoc.problem(puzzle, true).await?)
    } else {
        None
    };
    Ok(Json(Submitted { outcome, problem }))
}

#[derive(Deserialize)]
struct EditBody {
    /// The document with the cursor marked by `‸`.
    doc: String,
    utterance: String,
    recent: Option<String>,
}

#[derive(Serialize)]
struct Edited {
    #[serde(flatten)]
    outcome: EditOutcome,
    model: Option<String>,
    elapsed_ms: u64,
}

async fn edit_code(State(app): State<Shared>, Json(body): Json<EditBody>) -> ApiResult<Edited> {
    let prompt = edit::user_prompt(&body.doc, &body.utterance, body.recent.as_deref());
    let reply = app
        .edit_model
        .call(&app.edit_spec(), &prompt, EDIT_TIMEOUT)
        .await?;
    let outcome = edit::parse_reply(&reply.text).and_then(|r| edit::apply(&body.doc, r));
    tracing::info!(
        utterance = %body.utterance,
        recent = ?body.recent,
        elapsed_ms = reply.elapsed_ms,
        reply = %reply.text,
        outcome = match &outcome {
            Ok(EditOutcome::Applied { .. }) => "applied",
            Ok(EditOutcome::Unsure { .. }) => "unsure",
            Err(_) => "rejected",
        },
        doc = %body.doc,
        "edit"
    );
    let outcome = outcome?;
    Ok(Json(Edited {
        outcome,
        model: reply.model,
        elapsed_ms: reply.elapsed_ms,
    }))
}

#[derive(Deserialize)]
struct DiscussBody {
    year: u16,
    day: u8,
    model: String,
    turns: Vec<Turn>,
    code: String,
    #[serde(default)]
    errors: String,
    #[serde(default)]
    last_run: String,
}

#[derive(Serialize)]
struct Discussed {
    text: String,
    model: Option<String>,
}

async fn discuss(State(app): State<Shared>, Json(body): Json<DiscussBody>) -> ApiResult<Discussed> {
    if !app.config.models.discuss.models.contains(&body.model) {
        return Err(anyhow::anyhow!(
            "{:?} isn't one of the configured discussion models",
            body.model
        )
        .into());
    }
    let puzzle = puzzle(body.year, body.day)?;
    // Only a cached puzzle is used; discussing shouldn't make requests to Advent of Code.
    let problem = app.aoc.cached_problem(puzzle)?;
    let prompt = discuss::prompt(
        &discuss::Context {
            language: &app.config.language().name,
            problem: problem.as_ref().map(|p| p.text.as_str()),
            code: &body.code,
            errors: &body.errors,
            last_run: &body.last_run,
        },
        &body.turns,
    );
    let spec = CallSpec {
        model: body.model,
        system_prompt: discuss::SYSTEM_PROMPT.to_owned(),
    };
    let reply = app
        .discuss_model
        .call(&spec, &prompt, DISCUSS_TIMEOUT)
        .await?;
    Ok(Json(Discussed {
        text: reply.text,
        model: reply.model,
    }))
}

#[derive(Deserialize)]
struct GitSyncBody {
    message: String,
}

#[derive(Serialize)]
struct GitSynced {
    summary: String,
}

async fn git_sync(
    State(app): State<Shared>,
    Json(body): Json<GitSyncBody>,
) -> ApiResult<GitSynced> {
    Ok(Json(GitSynced {
        summary: app.workspace.commit_and_push(&body.message).await?,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum ClientLogKind {
    Error,
    Command,
    Speech,
}

#[derive(Deserialize)]
struct ClientLog {
    kind: ClientLogKind,
    message: String,
}

/// Records what happened on the phone, which the server can't otherwise see, in the log file.
async fn client_log(Json(body): Json<ClientLog>) -> ApiResult<()> {
    let message: String = body.message.chars().take(4000).collect();
    match body.kind {
        ClientLogKind::Error => tracing::warn!(target: "workshop::client", "{message}"),
        ClientLogKind::Command => tracing::info!(target: "workshop::client", "command: {message}"),
        ClientLogKind::Speech => tracing::info!(target: "workshop::client", "speech: {message}"),
    }
    Ok(Json(()))
}

async fn lsp(State(app): State<Shared>, upgrade: WebSocketUpgrade) -> Response {
    let Some(command) = app.config.language().lsp.clone() else {
        return (StatusCode::NOT_FOUND, "No language server is configured").into_response();
    };
    upgrade.on_upgrade(move |socket| async move {
        if let Err(err) = crate::lsp::relay(socket, &command, &app.config.solutions_dir).await {
            tracing::warn!("language server: {err:#}");
        }
    })
}

fn file_uri(path: &std::path::Path) -> String {
    let path = path.to_string_lossy().replace('\\', "/");
    let encoded: Vec<String> = path
        .split('/')
        .map(|segment| urlencoding::encode(segment).into_owned())
        .collect();
    let joined = encoded.join("/");
    if joined.starts_with('/') {
        format!("file://{joined}")
    } else {
        format!("file:///{joined}")
    }
}

pub fn load_or_create_token(paths: &Paths) -> Result<String> {
    let file = paths.token_file();
    match std::fs::read_to_string(&file) {
        Ok(token) if !token.trim().is_empty() => return Ok(token.trim().to_owned()),
        Ok(_) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err).with_context(|| format!("reading {}", file.display())),
    }
    let token = format!(
        "{:032x}{:032x}",
        rand::random::<u128>(),
        rand::random::<u128>()
    );
    crate::paths::write_private(&file, token.as_bytes())?;
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_app() -> (tempfile::TempDir, Router) {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::parse("").unwrap();
        config.solutions_dir = dir.path().join("aoc");
        let app = App::new(config, Paths::under(dir.path()), "secret".into(), None).unwrap();
        (dir, router(Arc::new(app)))
    }

    async fn send(router: &Router, request: Request) -> Response {
        use tower::ServiceExt;
        router.clone().oneshot(request).await.unwrap()
    }

    #[tokio::test]
    async fn token_link_sets_a_cookie_that_works_after_the_redirect() {
        let (_dir, router) = test_app().await;
        let response = send(
            &router,
            Request::get("/?token=secret").body(Body::empty()).unwrap(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert_eq!(response.headers()[header::LOCATION], "/");
        let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap();
        assert!(cookie.contains("SameSite=Lax"), "{cookie}");
        assert!(cookie.contains("HttpOnly"), "{cookie}");

        let pair = cookie.split(';').next().unwrap().to_owned();
        let response = send(
            &router,
            Request::get("/api/bootstrap")
                .header(header::COOKIE, pair)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn rejects_missing_and_wrong_tokens() {
        let (_dir, router) = test_app().await;
        for request in [
            Request::get("/api/bootstrap").body(Body::empty()).unwrap(),
            Request::get("/?token=wrong").body(Body::empty()).unwrap(),
            Request::get("/api/bootstrap")
                .header(header::COOKIE, "workshop_token=wrong")
                .body(Body::empty())
                .unwrap(),
        ] {
            assert_eq!(
                send(&router, request).await.status(),
                StatusCode::UNAUTHORIZED
            );
        }
    }

    #[tokio::test]
    async fn rejects_cross_origin_writes() {
        let (_dir, router) = test_app().await;
        let request = Request::put("/api/state")
            .header(header::COOKIE, "workshop_token=secret")
            .header(header::HOST, "laptop.ts.net")
            .header(header::ORIGIN, "https://evil.example")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{}"))
            .unwrap();
        assert_eq!(send(&router, request).await.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn compares_tokens() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }

    #[test]
    fn reads_token_cookie() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            "a=1; workshop_token=xyz; b=2".parse().unwrap(),
        );
        assert_eq!(cookie_token(&headers), Some("xyz"));
    }

    #[test]
    fn checks_origin() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "box.tail.ts.net".parse().unwrap());
        assert!(same_origin(&headers));
        headers.insert(header::ORIGIN, "https://box.tail.ts.net".parse().unwrap());
        assert!(same_origin(&headers));
        headers.insert(header::ORIGIN, "https://evil.example".parse().unwrap());
        assert!(!same_origin(&headers));
    }

    #[test]
    fn makes_file_uris() {
        assert_eq!(
            file_uri(std::path::Path::new("/a b/Main.hs")),
            "file:///a%20b/Main.hs"
        );
    }
}
