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
use crate::language::{LanguageProfile, Puzzle};
use crate::models::{self, ModelSettings, ProviderOption};
use crate::packages::{InstallLog, Packages, PackagesState, Resolution};
use crate::paths::Paths;
use crate::practice::Practice;
use crate::provider::{CallSpec, ProviderRunner, Role};
use crate::runner::{self, RunResult};
use crate::settings::AppSettings;
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
    /// One per provider, each keeping its own process ready.
    runners: BTreeMap<String, ProviderRunner>,
    settings: std::sync::RwLock<AppSettings>,
    run_lock: Mutex<()>,
    /// Cancels the run in progress, if there is one.
    current_run: std::sync::Mutex<Option<CancellationToken>>,
    /// Held while packages are being installed.
    install_lock: Arc<Mutex<()>>,
    /// The install under way, to follow or cancel.
    install: std::sync::Mutex<Option<Arc<RunningInstall>>>,
    /// How the last install ended, and its output.
    last_install: std::sync::Mutex<Option<LastInstall>>,
    /// Packages already found for missing modules, by language and module.
    resolutions: std::sync::Mutex<BTreeMap<(String, String), Resolution>>,
    http: reqwest::Client,
    /// Changed to restart language servers, such as after installing packages.
    lsp_restarts: tokio::sync::watch::Sender<u64>,
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
        let runners = config
            .providers
            .iter()
            .map(|(id, provider)| {
                Ok((
                    id.clone(),
                    ProviderRunner::new(provider.clone(), model_dir.clone())?,
                ))
            })
            .collect::<Result<_>>()?;
        Ok(Self {
            workspace: Workspace::new(config.solutions_dir.clone(), paths.clone()),
            aoc: AocClient::with_base_url(
                aoc_session,
                &config.aoc.user_agent,
                paths.aoc_cache_dir(),
                config.aoc.base_url.clone(),
            )?
            .with_practice(Practice::new(paths.data_dir.join("practice.json"))),
            runners,
            settings: std::sync::RwLock::new(AppSettings::load(&config, &paths)),
            run_lock: Mutex::new(()),
            current_run: std::sync::Mutex::new(None),
            install_lock: Arc::new(Mutex::new(())),
            install: std::sync::Mutex::new(None),
            last_install: std::sync::Mutex::new(None),
            resolutions: std::sync::Mutex::new(BTreeMap::new()),
            http: reqwest::Client::builder()
                .user_agent(&config.aoc.user_agent)
                .timeout(Duration::from_secs(15))
                .build()?,
            lsp_restarts: tokio::sync::watch::Sender::new(0),
            config,
            paths,
            token,
        })
    }

    fn settings(&self) -> AppSettings {
        self.settings
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn model_settings(&self) -> ModelSettings {
        self.settings().models
    }

    /// The language chosen in the app, or the config's.
    fn language(&self) -> &LanguageProfile {
        &self.config.languages[&self.settings().language]
    }

    /// The chosen language's packages, if it has any.
    fn packages(&self) -> Option<Packages<'_>> {
        let id = self.settings().language;
        let language = &self.config.languages[&id];
        language.packages.as_ref().map(|profile| Packages {
            profile,
            language_name: &language.name,
            solutions_dir: &self.config.solutions_dir,
            dir: self.paths.packages_dir(&id),
        })
    }

    /// Environment variables for building, running and the language server: where the user's
    /// helpers and installed packages are. A variable both set, such as a search path, gets
    /// both values.
    fn solution_environment(&self) -> Result<Vec<(String, String)>> {
        let mut environment: Vec<(String, String)> = Vec::new();
        let helpers = match &self.language().helpers {
            Some(helpers) => helpers.environment(&self.config.solutions_dir)?,
            None => Vec::new(),
        };
        let packages = match self.packages() {
            Some(packages) => packages.environment()?,
            None => Vec::new(),
        };
        for (name, value) in helpers.into_iter().chain(packages) {
            match environment.iter_mut().find(|(n, _)| *n == name) {
                Some((_, existing)) => {
                    existing.push(':');
                    existing.push_str(&value);
                }
                None => environment.push((name, value)),
            }
        }
        Ok(environment)
    }

    fn helpers_dir(&self) -> Result<Option<std::path::PathBuf>> {
        self.language()
            .helpers
            .as_ref()
            .map(|h| h.dir(&self.config.solutions_dir))
            .transpose()
    }

    fn update_settings(&self, change: impl FnOnce(&mut AppSettings)) -> Result<()> {
        let mut settings = self
            .settings
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut next = settings.clone();
        change(&mut next);
        next.validate(&self.config)?;
        next.save(&self.paths)?;
        *settings = next;
        Ok(())
    }

    /// The runner and call for the chosen edit model.
    fn edit_target(&self) -> (&ProviderRunner, CallSpec) {
        let choice = self.model_settings().edit;
        let spec = self.config.providers[&choice.provider].spec(
            Role::Edit,
            &choice.model,
            edit::system_prompt(self.language()),
        );
        (&self.runners[&choice.provider], spec)
    }

    async fn warm_edit_model(&self) {
        let (runner, spec) = self.edit_target();
        if let Err(err) = runner.warm(&spec).await {
            tracing::warn!("couldn't start the edit model: {err:#}");
        }
    }

    pub async fn warm_up(&self) {
        if let Err(err) = self.workspace.ensure_repo().await {
            tracing::warn!("couldn't set up the solutions repo: {err:#}");
        }
        self.warm_edit_model().await;
    }
}

pub fn router(app: Shared) -> Router {
    let api = Router::new()
        .route("/bootstrap", get(bootstrap))
        .route("/state", put(save_state))
        .route("/doctor", get(run_doctor))
        .route("/models", get(get_models).put(set_models))
        .route("/setup", get(setup_state))
        .route("/themes", get(themes))
        .route("/theme", put(set_theme))
        .route("/setup/language", put(set_language))
        .route("/setup/aoc-session", post(set_aoc_session))
        .route("/packages", get(get_packages).put(save_packages))
        .route("/packages/install", post(install_packages))
        .route("/packages/add", post(add_package))
        .route("/packages/remove", post(remove_package))
        .route("/packages/cancel", post(cancel_install))
        .route("/packages/resolve", post(resolve_package))
        .route("/practice/reset", post(reset_practice))
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

/// A request that can't be carried out as asked, with a reason to show the user.
fn bad_request(message: impl Into<String>) -> ApiError {
    ApiError(
        StatusCode::BAD_REQUEST,
        serde_json::json!({ "error": message.into() }),
    )
}

fn puzzle(year: u16, day: u8) -> Result<Puzzle, ApiError> {
    Puzzle::new(year, day).map_err(|err| bad_request(err.to_string()))
}

#[derive(Serialize)]
struct Bootstrap {
    state: UiState,
    language: LanguageInfo,
    snippets: Vec<Snippet>,
    models: ModelsState,
    has_aoc_session: bool,
    /// Whether to show setup straight away, because something essential is missing.
    needs_setup: bool,
    /// Overrides Workshop's colours with the chosen terminal themes.
    theme_css: Option<String>,
}

#[derive(Serialize)]
struct LanguageInfo {
    id: String,
    name: String,
    editor_mode: String,
    lsp_language_id: String,
    has_lsp: bool,
    root_uri: String,
    /// For recognising a missing package in errors, if the language has packages.
    packages: Option<PackageHints>,
}

#[derive(Serialize)]
struct PackageHints {
    missing_module: Vec<String>,
    missing_package: Vec<String>,
}

async fn bootstrap(State(app): State<Shared>) -> ApiResult<Bootstrap> {
    let language = app.language();
    let has_lsp = language
        .lsp
        .as_ref()
        .and_then(|c| c.first())
        .is_some_and(|p| doctor::find_program(p).is_some());
    Ok(Json(Bootstrap {
        state: app.workspace.load_ui_state()?,
        language: LanguageInfo {
            id: app.settings().language,
            name: language.name.clone(),
            editor_mode: language.editor_mode.clone(),
            lsp_language_id: language.lsp_language_id.clone(),
            has_lsp,
            root_uri: file_uri(&app.config.solutions_dir),
            packages: language.packages.as_ref().map(|p| PackageHints {
                missing_module: p.missing_module.clone(),
                missing_package: p.missing_package.clone(),
            }),
        },
        snippets: app.config.snippets.clone(),
        models: models_state(&app),
        has_aoc_session: app.aoc.has_session(),
        theme_css: theme_css(&app),
        needs_setup: !app.aoc.has_session()
            || models::options(&app.config)
                .iter()
                .all(|o| o.unavailable.is_some()),
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
    let code = app.workspace.load_code(app.language(), puzzle)?;
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
            .save_code(app.language(), puzzle, &body.text, &body.version),
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
    let profile = app.language();
    let file = profile.solution_path(&app.config.solutions_dir, puzzle)?;
    let build_dir = app
        .paths
        .build_dir()
        .join(puzzle.year_label())
        .join(format!("{:02}", puzzle.day));
    let result = runner::run(runner::RunRequest {
        profile,
        file: &file,
        build_dir: &build_dir,
        puzzle,
        input: &input,
        timeout: Duration::from_secs(app.config.run.timeout_secs),
        cancel: &cancel,
        environment: &app.solution_environment()?,
        helpers: app.helpers_dir()?.as_deref(),
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
    /// Questions the model asked about earlier utterances, which this one answers.
    #[serde(default)]
    earlier: Vec<edit::Exchange>,
}

#[derive(Serialize)]
struct Edited {
    #[serde(flatten)]
    outcome: EditOutcome,
    model: Option<String>,
    elapsed_ms: u64,
}

async fn edit_code(State(app): State<Shared>, Json(body): Json<EditBody>) -> ApiResult<Edited> {
    let prompt = edit::user_prompt(
        &body.doc,
        &body.utterance,
        body.recent.as_deref(),
        &body.earlier,
    );
    let (runner, spec) = app.edit_target();
    let result = edit::request(runner, &spec, &body.doc, &prompt, EDIT_TIMEOUT).await;
    let (outcome, replies, elapsed_ms) = match &result {
        Ok(r) => (
            match r.outcome {
                EditOutcome::Applied { .. } => "applied",
                EditOutcome::Unsure { .. } => "unsure",
            },
            &r.replies,
            r.elapsed_ms,
        ),
        Err(failed) => ("rejected", &failed.replies, 0),
    };
    tracing::info!(
        utterance = %body.utterance,
        recent = ?body.recent,
        earlier = ?body.earlier,
        elapsed_ms,
        reply = %replies.join("\n--- retry ---\n"),
        outcome,
        doc = %body.doc,
        "edit"
    );
    let response = result.map_err(|e| anyhow::anyhow!(e.message))?;
    Ok(Json(Edited {
        outcome: response.outcome,
        model: response.model,
        elapsed_ms: response.elapsed_ms,
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

/// Replies to the discussion, as newline-delimited JSON: `{"delta": text}` as the reply is
/// written, if the model's CLI reports it, then `{"done": {text, model}}` or `{"error": message}`.
async fn discuss(
    State(app): State<Shared>,
    Json(body): Json<DiscussBody>,
) -> Result<Response, ApiError> {
    let provider = app.model_settings().discuss_provider;
    if !models::discuss_models(&app.config, &provider).contains(&body.model) {
        return Err(bad_request(format!(
            "{:?} isn't one of the discussion models for {provider}",
            body.model
        )));
    }
    let puzzle = puzzle(body.year, body.day)?;
    // Only a cached puzzle is used; discussing shouldn't make requests to Advent of Code.
    let problem = app.aoc.cached_problem(puzzle)?;
    let language = app.language();
    let helpers = match &language.helpers {
        Some(helpers) => std::fs::read_to_string(app.config.solutions_dir.join(&helpers.file))
            .ok()
            .map(|text| (helpers.file.clone(), text)),
        None => None,
    };
    let packages = match app.packages() {
        Some(packages) => packages.state()?.installed.unwrap_or_default(),
        None => Vec::new(),
    };
    let prompt = discuss::prompt(
        &discuss::Context {
            language: &language.name,
            problem: problem.as_ref().map(|p| p.text.as_str()),
            code: &body.code,
            errors: &body.errors,
            last_run: &body.last_run,
            helpers: helpers
                .as_ref()
                .map(|(path, text)| (path.as_str(), text.as_str())),
            packages: &packages,
        },
        &body.turns,
    );
    let spec = app.config.providers[&provider].spec(
        Role::Discuss,
        &body.model,
        discuss::SYSTEM_PROMPT.to_owned(),
    );

    let (lines, receiver) = tokio::sync::mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        let (partial, mut parts) = tokio::sync::mpsc::unbounded_channel::<String>();
        let forward = {
            let lines = lines.clone();
            tokio::spawn(async move {
                while let Some(text) = parts.recv().await {
                    // The phone may have gone; the reply is still finished, just not shown.
                    let _ = lines.send(serde_json::json!({ "delta": text }).to_string());
                }
            })
        };
        let reply = app.runners[&provider]
            .call_streaming(&spec, &prompt, DISCUSS_TIMEOUT, Some(&partial))
            .await;
        drop(partial);
        let _ = forward.await;
        let last = match reply {
            Ok(reply) => {
                serde_json::json!({ "done": Discussed { text: reply.text, model: reply.model } })
            }
            Err(err) => {
                tracing::warn!("discussing: {err:#}");
                serde_json::json!({ "error": format!("{err:#}") })
            }
        };
        let _ = lines.send(last.to_string());
    });
    let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
        let line = receiver.recv().await?;
        Some((
            Ok::<_, std::convert::Infallible>(format!("{line}\n")),
            receiver,
        ))
    });
    Ok((
        [
            (header::CONTENT_TYPE, "application/x-ndjson"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        Body::from_stream(stream),
    )
        .into_response())
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

#[derive(Serialize)]
struct SetupState {
    languages: Vec<LanguageOption>,
    language: String,
    has_aoc_session: bool,
    providers: Vec<ProviderStatus>,
    tailscale_installed: bool,
    /// The address to open on a phone, with the token, if Tailscale is serving Workshop.
    phone_url: Option<String>,
    /// `phone_url` as a QR code, in SVG.
    phone_qr_svg: Option<String>,
    port: u16,
}

#[derive(Serialize)]
struct LanguageOption {
    id: String,
    name: String,
    /// Programs it needs that aren't installed.
    missing: Vec<String>,
    /// The language server, if it isn't installed. Workshop works without it.
    missing_language_server: Option<String>,
}

#[derive(Serialize)]
struct ProviderStatus {
    id: String,
    name: String,
    installed: bool,
    /// Unknown if the provider has no way to check.
    logged_in: Option<bool>,
    install_hint: Option<String>,
}

async fn setup_state(State(app): State<Shared>) -> ApiResult<SetupState> {
    let languages = app
        .config
        .languages
        .iter()
        .map(|(id, profile)| LanguageOption {
            id: id.clone(),
            name: profile.name.clone(),
            missing: profile
                .required_programs()
                .into_iter()
                .filter(|p| doctor::find_program(p).is_none())
                .map(str::to_owned)
                .collect(),
            missing_language_server: profile
                .lsp
                .as_ref()
                .and_then(|c| c.first())
                .filter(|p| doctor::find_program(p).is_none())
                .cloned(),
        })
        .collect();
    let providers =
        futures_util::future::join_all(models::options(&app.config).into_iter().map(|option| {
            let provider = &app.config.providers[&option.id];
            async move {
                let installed = option.unavailable.is_none();
                let logged_in = match (&provider.auth_check_command, installed) {
                    (Some(command), true) => doctor::output(command).await.map(|(ok, _)| ok),
                    _ => None,
                };
                ProviderStatus {
                    id: option.id,
                    name: option.name,
                    installed,
                    logged_in,
                    install_hint: provider.install_hint.clone(),
                }
            }
        }))
        .await;
    let port = app.config.server.bind.port();
    let phone_url = crate::tailscale::serving_url(port)
        .await
        .map(|base| format!("{base}/?token={}", app.token));
    let phone_qr_svg = phone_url.as_deref().map(qr_svg).transpose()?;
    Ok(Json(SetupState {
        languages,
        language: app.settings().language,
        has_aoc_session: app.aoc.has_session(),
        providers,
        tailscale_installed: doctor::find_program("tailscale").is_some(),
        phone_url,
        phone_qr_svg,
        port,
    }))
}

fn qr_svg(text: &str) -> Result<String> {
    let code = qrcode::QrCode::new(text.as_bytes()).context("making a QR code")?;
    Ok(code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(220, 220)
        .quiet_zone(true)
        .build())
}

/// The stylesheet for the chosen themes. A theme that's gone missing shouldn't stop the app
/// loading, so it falls back to Workshop's colours.
fn theme_css(app: &App) -> Option<String> {
    crate::theme::stylesheet(&app.paths, &app.settings().theme).unwrap_or_else(|err| {
        tracing::warn!("using the default colours: {err:#}");
        None
    })
}

#[derive(Serialize)]
struct ThemesState {
    names: Vec<String>,
    /// The light and dark themes Ghostty uses, if its config sets one.
    ghostty: Option<(String, String)>,
    settings: crate::theme::ThemeSettings,
}

async fn themes(State(app): State<Shared>) -> ApiResult<ThemesState> {
    Ok(Json(ThemesState {
        names: crate::theme::available(&app.paths),
        ghostty: crate::theme::ghostty_themes(),
        settings: app.settings().theme,
    }))
}

#[derive(Serialize)]
struct ThemeApplied {
    css: Option<String>,
}

async fn set_theme(
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
struct LanguageBody {
    language: String,
}

/// Changes the language. The page reloads afterwards, as the editor and language server depend
/// on it.
async fn set_language(State(app): State<Shared>, Json(body): Json<LanguageBody>) -> ApiResult<()> {
    app.update_settings(|s| s.language = body.language)
        .map_err(|e| bad_request(format!("{e:#}")))?;
    let warm = app.clone();
    tokio::spawn(async move { warm.warm_edit_model().await });
    Ok(Json(()))
}

#[derive(Deserialize)]
struct SessionBody {
    session: String,
}

/// Checks a pasted Advent of Code session cookie, then saves it where only the user can read it.
async fn set_aoc_session(
    State(app): State<Shared>,
    Json(body): Json<SessionBody>,
) -> ApiResult<()> {
    let session = body
        .session
        .trim()
        .trim_start_matches("session=")
        .to_owned();
    if session.is_empty() || session.contains(char::is_whitespace) {
        return Err(bad_request(
            "Paste just the cookie's value, a long string of letters and numbers.",
        ));
    }
    app.aoc.check_session(&session).await?;
    crate::paths::write_private(&app.paths.aoc_session_file(), session.as_bytes())?;
    app.aoc.set_session(session);
    Ok(Json(()))
}

/// The model choices, with what each provider offers.
#[derive(Serialize)]
struct ModelsState {
    providers: Vec<ProviderOption>,
    settings: ModelSettings,
    /// The models to choose between in the Discuss tab.
    discuss_models: Vec<String>,
}

fn models_state(app: &App) -> ModelsState {
    let settings = app.model_settings();
    ModelsState {
        providers: models::options(&app.config),
        discuss_models: models::discuss_models(&app.config, &settings.discuss_provider),
        settings,
    }
}

async fn get_models(State(app): State<Shared>) -> ApiResult<ModelsState> {
    Ok(Json(models_state(&app)))
}

async fn set_models(
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

async fn lsp(State(app): State<Shared>, upgrade: WebSocketUpgrade) -> Response {
    let Some(command) = app.language().lsp.clone() else {
        return (StatusCode::NOT_FOUND, "No language server is configured").into_response();
    };
    upgrade.on_upgrade(move |socket| async move {
        let environment = match app.solution_environment() {
            Ok(environment) => environment,
            Err(err) => {
                tracing::warn!("language server: {err:#}");
                Vec::new()
            }
        };
        let restart = app.lsp_restarts.subscribe();
        if let Err(err) = crate::lsp::relay(
            socket,
            &command,
            &app.config.solutions_dir,
            &environment,
            restart,
        )
        .await
        {
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

struct RunningInstall {
    cancel: CancellationToken,
    log: InstallLog,
}

#[derive(Clone, Serialize)]
struct LastInstall {
    succeeded: bool,
    log: Vec<String>,
}

#[derive(Serialize)]
struct PackagesResponse {
    /// None when the language has no packages beyond its standard library.
    state: Option<PackagesState>,
    installing: bool,
    /// The installer's latest line of output, while installing.
    progress: Option<String>,
    last_install: Option<LastInstall>,
}

fn packages_response(app: &App) -> Result<PackagesResponse> {
    let running = lock(&app.install).clone();
    Ok(PackagesResponse {
        state: app.packages().map(|p| p.state()).transpose()?,
        installing: running.is_some(),
        progress: running.and_then(|r| r.log.last()),
        last_install: lock(&app.last_install).clone(),
    })
}

fn require_packages(app: &App) -> Result<Packages<'_>, ApiError> {
    app.packages().ok_or_else(|| {
        bad_request(format!(
            "{} has no packages to install.",
            app.language().name
        ))
    })
}

async fn get_packages(State(app): State<Shared>) -> ApiResult<PackagesResponse> {
    Ok(Json(packages_response(&app)?))
}

#[derive(Deserialize)]
struct ManifestBody {
    text: String,
}

async fn save_packages(
    State(app): State<Shared>,
    Json(body): Json<ManifestBody>,
) -> ApiResult<PackagesResponse> {
    require_packages(&app)?
        .save_manifest(&body.text)
        .map_err(|e| bad_request(format!("{e:#}")))?;
    Ok(Json(packages_response(&app)?))
}

#[derive(Deserialize)]
struct PackageBody {
    package: String,
}

async fn add_package(
    State(app): State<Shared>,
    Json(body): Json<PackageBody>,
) -> ApiResult<PackagesResponse> {
    require_packages(&app)?
        .add(&body.package)
        .map_err(|e| bad_request(format!("{e:#}")))?;
    install_packages(State(app)).await
}

async fn remove_package(
    State(app): State<Shared>,
    Json(body): Json<PackageBody>,
) -> ApiResult<PackagesResponse> {
    require_packages(&app)?
        .remove(&body.package)
        .map_err(|e| bad_request(format!("{e:#}")))?;
    install_packages(State(app)).await
}

async fn cancel_install(State(app): State<Shared>) -> ApiResult<()> {
    if let Some(running) = lock(&app.install).as_ref() {
        running.cancel.cancel();
    }
    Ok(Json(()))
}

#[derive(Deserialize)]
struct ResolveBody {
    module: String,
}

/// Finds the package for a missing module, looking it up online if the language says how.
async fn resolve_package(
    State(app): State<Shared>,
    Json(body): Json<ResolveBody>,
) -> ApiResult<Resolution> {
    let key = (app.settings().language, body.module.clone());
    if let Some(found) = lock(&app.resolutions).get(&key) {
        return Ok(Json(found.clone()));
    }
    let resolution = require_packages(&app)?
        .resolve(&body.module, &app.http)
        .await?;
    lock(&app.resolutions).insert(key, resolution.clone());
    Ok(Json(resolution))
}

/// Installs the manifest's packages, then restarts language servers so they see them.
async fn install_packages(State(app): State<Shared>) -> ApiResult<PackagesResponse> {
    require_packages(&app)?;
    let Ok(guard) = app.install_lock.clone().try_lock_owned() else {
        return Err(ApiError(
            StatusCode::CONFLICT,
            serde_json::json!({ "error": "Packages are already being installed." }),
        ));
    };
    let running = Arc::new(RunningInstall {
        cancel: CancellationToken::new(),
        log: InstallLog::default(),
    });
    *lock(&app.install) = Some(running.clone());
    // Its own task, so the install finishes even if the phone disconnects while waiting.
    let task = {
        let app = app.clone();
        tokio::spawn(async move {
            let _guard = guard;
            let installed = match app.packages() {
                Some(packages) => packages.install(&running.cancel, &running.log).await,
                None => Err(anyhow::anyhow!("the language has no packages")),
            };
            // The error itself already quotes the end of the output.
            if let Err(err) = &installed {
                running
                    .log
                    .push(err.to_string().lines().next().unwrap_or_default());
            }
            *lock(&app.last_install) = Some(LastInstall {
                succeeded: installed.is_ok(),
                log: running.log.lines(),
            });
            *lock(&app.install) = None;
            if installed.is_ok() {
                app.lsp_restarts.send_modify(|n| *n += 1);
            }
            installed
        })
    };
    let installed = task.await.context("the install stopped unexpectedly")?;
    match installed {
        Ok(packages) => tracing::info!("installed packages: {}", packages.join(" ")),
        Err(err) => {
            tracing::warn!("installing packages: {err:#}");
            return Err(err.into());
        }
    }
    Ok(Json(packages_response(&app)?))
}

async fn reset_practice(State(app): State<Shared>) -> ApiResult<Problem> {
    app.aoc.reset_practice()?;
    Ok(Json(app.aoc.problem(Puzzle::PRACTICE, false).await?))
}
