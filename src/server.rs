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
use crate::provider::{CallSpec, ProviderRunner, Role};
use crate::runner::RunResult;
use crate::settings::AppSettings;
use crate::solutions::Solutions;
use crate::toolchain::Toolchain;
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
    /// Held while anything is being installed, as packages need the toolchain.
    install_lock: Arc<Mutex<()>>,
    packages_install: Installs,
    /// Installing the language's programs with mise.
    toolchain_install: Installs,
    /// Downloading Whisper's model for dictation.
    speech_install: Installs,
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
            aoc: crate::solutions::aoc_client(&config, &paths, aoc_session)?,
            runners,
            settings: std::sync::RwLock::new(AppSettings::load(&config, &paths)),
            run_lock: Mutex::new(()),
            current_run: std::sync::Mutex::new(None),
            install_lock: Arc::new(Mutex::new(())),
            packages_install: Installs::default(),
            toolchain_install: Installs::default(),
            speech_install: Installs::default(),
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

    /// Solutions in the chosen language: their toolchain, packages, environment and how to run
    /// them.
    async fn solutions(&self) -> Result<Solutions<'_>> {
        Solutions::load(&self.config, &self.paths, self.settings().language).await
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
        .route("/ping", get(ping))
        .route("/state", put(save_state))
        .route("/doctor", get(run_doctor))
        .route("/models", get(get_models).put(set_models))
        .route("/setup", get(setup_state))
        .route("/themes", get(themes))
        .route("/theme", put(set_theme))
        .route("/solutions-repo", put(set_solutions_repo))
        .route("/setup/language", put(set_language))
        .route("/setup/aoc-session", post(set_aoc_session))
        .route("/setup/toolchain", post(install_toolchain))
        .route("/setup/toolchain/cancel", post(cancel_toolchain_install))
        .route("/packages", get(get_packages).put(save_packages))
        .route("/packages/install", post(install_packages))
        .route("/packages/add", post(add_package))
        .route("/packages/remove", post(remove_package))
        .route("/packages/cancel", post(cancel_install))
        .route("/packages/resolve", post(resolve_package))
        .route("/practice/reset", post(reset_practice))
        .route("/speech", get(get_speech))
        .route("/speech/download", post(download_speech_model))
        .route("/speech/download/cancel", post(cancel_speech_download))
        .route("/speech/transcribe", post(transcribe))
        .route("/bench", get(bench_info))
        .route("/bench/transcribe", post(bench_transcribe))
        .route("/bench/result", post(bench_result))
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
    commit_after_star: bool,
    /// Whether Whisper on the server is ready to hear dictation.
    server_dictation: bool,
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
    start_part_two: Option<crate::language::TextSwap>,
}

#[derive(Serialize)]
struct PackageHints {
    missing_module: Vec<String>,
    missing_package: Vec<String>,
}

async fn bootstrap(State(app): State<Shared>) -> ApiResult<Bootstrap> {
    let language = app.language();
    // A toolchain that can't be read shouldn't stop the app loading; the checks report it.
    let toolchain = match app.solutions().await {
        Ok(solutions) => solutions.toolchain,
        Err(err) => {
            tracing::warn!("{err:#}");
            Toolchain::default()
        }
    };
    let has_lsp = language
        .lsp
        .as_ref()
        .and_then(|c| c.first())
        .is_some_and(|p| toolchain.find_program(p).is_some());
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
            start_part_two: language.start_part_two.clone(),
        },
        snippets: app.config.snippets.clone(),
        models: models_state(&app),
        has_aoc_session: app.aoc.has_session(),
        theme_css: theme_css(&app),
        commit_after_star: app.settings().commit_after_star,
        server_dictation: speech_state(&app).ready,
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
    Ok(Json(
        app.solutions().await?.run(puzzle, &input, &cancel).await?,
    ))
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
    /// What committing and pushing the solutions repo did, if that's done after each star.
    committed: Option<Committed>,
}

#[derive(Serialize)]
struct Committed {
    succeeded: bool,
    summary: String,
}

async fn submit(
    State(app): State<Shared>,
    Path((year, day)): Path<(u16, u8)>,
    Json(body): Json<SubmitBody>,
) -> ApiResult<Submitted> {
    let puzzle = puzzle(year, day)?;
    let part = Part::from_number(body.part)?;
    let outcome = app.aoc.submit(puzzle, part, &body.answer).await?;
    let correct = outcome == SubmitOutcome::Correct;
    let problem = if correct {
        Some(app.aoc.problem(puzzle, true).await?)
    } else {
        None
    };
    let committed = if correct && app.settings().commit_after_star {
        let message = format!("{}, part {}", puzzle.title(), part.number());
        // The star is earned either way, so a failed push is reported rather than an error.
        Some(match app.workspace.commit_and_push(&message).await {
            Ok(summary) => Committed {
                succeeded: true,
                summary,
            },
            Err(err) => Committed {
                succeeded: false,
                summary: format!("Couldn't commit and push: {err:#}"),
            },
        })
    } else {
        None
    };
    Ok(Json(Submitted {
        outcome,
        problem,
        committed,
    }))
}

#[derive(Deserialize)]
struct EditBody {
    /// The document with the cursor marked by `‸`.
    doc: String,
    utterance: String,
    /// The speech recogniser's pieces, when it revised what it heard.
    #[serde(default)]
    pieces: Vec<String>,
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
        edit::Utterance {
            text: &body.utterance,
            pieces: &body.pieces,
        },
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
        pieces = ?body.pieces,
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
    let packages = match app.solutions().await?.packages() {
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
    /// Whether mise is installed, to install a language's programs with.
    mise_installed: bool,
    /// Why the solutions directory's mise config couldn't be read, if it couldn't.
    toolchain_problem: Option<String>,
    /// Installing the chosen language's programs with mise.
    toolchain_install: InstallStatus,
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
    /// Whether setup can install its programs with mise.
    installable: bool,
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
    let (toolchain, toolchain_problem) = match Toolchain::load(&app.config.solutions_dir).await {
        Ok(toolchain) => (toolchain, None),
        Err(err) => (Toolchain::default(), Some(format!("{err:#}"))),
    };
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
                .filter(|p| toolchain.find_program(p).is_none())
                .map(str::to_owned)
                .collect(),
            missing_language_server: profile
                .lsp
                .as_ref()
                .and_then(|c| c.first())
                .filter(|p| toolchain.find_program(p).is_none())
                .cloned(),
            installable: profile.toolchain.is_some(),
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
        mise_installed: doctor::find_program("mise").is_some(),
        toolchain_problem,
        toolchain_install: app.toolchain_install.status(),
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
        let environment = match app.solutions().await.and_then(|s| s.environment()) {
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
    fn accepts_only_plain_session_ids() {
        check_session("2026-10-13-1650").unwrap();
        for bad in ["", "../x", "a/b", "a b"] {
            assert!(check_session(bad).is_err(), "{bad}");
        }
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

/// One kind of install, such as of packages, run one at a time in the background.
#[derive(Default)]
struct Installs {
    /// The install under way, to follow or cancel.
    running: std::sync::Mutex<Option<Arc<RunningInstall>>>,
    /// How the last install ended, and its output.
    last: std::sync::Mutex<Option<LastInstall>>,
}

#[derive(Serialize)]
struct InstallStatus {
    installing: bool,
    /// The installer's latest line of output, while installing.
    progress: Option<String>,
    last_install: Option<LastInstall>,
}

impl Installs {
    fn status(&self) -> InstallStatus {
        let running = lock(&self.running).clone();
        InstallStatus {
            installing: running.is_some(),
            progress: running.and_then(|r| r.log.last()),
            last_install: lock(&self.last).clone(),
        }
    }

    fn cancel(&self) {
        if let Some(running) = lock(&self.running).as_ref() {
            running.cancel.cancel();
        }
    }
}

/// What to restart once an install succeeds.
#[derive(Clone, Copy, PartialEq, Eq)]
enum AfterInstall {
    /// Language servers, so they see what was installed.
    RestartLanguageServers,
    Nothing,
}

/// Runs an install in its own task, so it finishes even if the phone disconnects while waiting.
async fn install_with<T, Job, Fut>(
    app: &Shared,
    installs: fn(&App) -> &Installs,
    after: AfterInstall,
    job: Job,
) -> Result<T, ApiError>
where
    Job: FnOnce(Shared, Arc<RunningInstall>) -> Fut,
    Fut: std::future::Future<Output = Result<T>> + Send + 'static,
    T: Send + 'static,
{
    let Ok(guard) = app.install_lock.clone().try_lock_owned() else {
        return Err(ApiError(
            StatusCode::CONFLICT,
            serde_json::json!({ "error": "Something is already being installed." }),
        ));
    };
    let running = Arc::new(RunningInstall {
        cancel: CancellationToken::new(),
        log: InstallLog::default(),
    });
    *lock(&installs(app).running) = Some(running.clone());
    let installing = job(app.clone(), running.clone());
    let app = app.clone();
    let task = tokio::spawn(async move {
        let _guard = guard;
        let result = installing.await;
        // The error itself already quotes the end of the output.
        if let Err(err) = &result {
            running
                .log
                .push(err.to_string().lines().next().unwrap_or_default());
        }
        let installs = installs(&app);
        *lock(&installs.last) = Some(LastInstall {
            succeeded: result.is_ok(),
            log: running.log.lines(),
        });
        *lock(&installs.running) = None;
        if result.is_ok() && after == AfterInstall::RestartLanguageServers {
            app.lsp_restarts.send_modify(|n| *n += 1);
        }
        result
    });
    Ok(task.await.context("the install stopped unexpectedly")??)
}

#[derive(Serialize)]
struct PackagesResponse {
    /// None when the language has no packages beyond its standard library.
    state: Option<PackagesState>,
    #[serde(flatten)]
    install: InstallStatus,
}

async fn packages_response(app: &App) -> Result<PackagesResponse> {
    Ok(PackagesResponse {
        state: app
            .solutions()
            .await?
            .packages()
            .map(|p| p.state())
            .transpose()?,
        install: app.packages_install.status(),
    })
}

async fn require_packages(app: &App) -> Result<Packages<'_>, ApiError> {
    app.solutions().await?.packages().ok_or_else(|| {
        bad_request(format!(
            "{} has no packages to install.",
            app.language().name
        ))
    })
}

async fn get_packages(State(app): State<Shared>) -> ApiResult<PackagesResponse> {
    Ok(Json(packages_response(&app).await?))
}

#[derive(Deserialize)]
struct ManifestBody {
    text: String,
}

async fn save_packages(
    State(app): State<Shared>,
    Json(body): Json<ManifestBody>,
) -> ApiResult<PackagesResponse> {
    require_packages(&app)
        .await?
        .save_manifest(&body.text)
        .map_err(|e| bad_request(format!("{e:#}")))?;
    Ok(Json(packages_response(&app).await?))
}

#[derive(Deserialize)]
struct PackageBody {
    package: String,
}

async fn add_package(
    State(app): State<Shared>,
    Json(body): Json<PackageBody>,
) -> ApiResult<PackagesResponse> {
    require_packages(&app)
        .await?
        .add(&body.package)
        .map_err(|e| bad_request(format!("{e:#}")))?;
    install_packages(State(app)).await
}

async fn remove_package(
    State(app): State<Shared>,
    Json(body): Json<PackageBody>,
) -> ApiResult<PackagesResponse> {
    require_packages(&app)
        .await?
        .remove(&body.package)
        .map_err(|e| bad_request(format!("{e:#}")))?;
    install_packages(State(app)).await
}

async fn cancel_install(State(app): State<Shared>) -> ApiResult<()> {
    app.packages_install.cancel();
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
    let resolution = require_packages(&app)
        .await?
        .resolve(&body.module, &app.http)
        .await?;
    lock(&app.resolutions).insert(key, resolution.clone());
    Ok(Json(resolution))
}

/// Installs the manifest's packages.
async fn install_packages(State(app): State<Shared>) -> ApiResult<PackagesResponse> {
    require_packages(&app).await?;
    let installed = install_with(
        &app,
        |app| &app.packages_install,
        AfterInstall::RestartLanguageServers,
        |app, running| async move {
            let packages = app
                .solutions()
                .await?
                .packages()
                .context("the language has no packages")?;
            packages.install(&running.cancel, &running.log).await
        },
    )
    .await?;
    tracing::info!("installed packages: {}", installed.join(" "));
    Ok(Json(packages_response(&app).await?))
}

/// Installs the chosen language's programs with mise, into the solutions directory.
async fn install_toolchain(State(app): State<Shared>) -> ApiResult<SetupState> {
    if app.language().toolchain.is_none() {
        return Err(bad_request(format!(
            "Workshop doesn't know how to install {} with mise.",
            app.language().name
        )));
    }
    install_with(
        &app,
        |app| &app.toolchain_install,
        AfterInstall::RestartLanguageServers,
        |app, running| async move {
            let profile = app
                .language()
                .toolchain
                .clone()
                .context("the language has no toolchain")?;
            crate::toolchain::install(
                &profile,
                &app.config.solutions_dir,
                &running.cancel,
                &running.log,
            )
            .await
        },
    )
    .await?;
    tracing::info!("installed {} with mise", app.language().name);
    setup_state(State(app)).await
}

async fn cancel_toolchain_install(State(app): State<Shared>) -> ApiResult<()> {
    app.toolchain_install.cancel();
    Ok(Json(()))
}

async fn reset_practice(State(app): State<Shared>) -> ApiResult<Problem> {
    app.aoc.reset_practice()?;
    Ok(Json(app.aoc.problem(Puzzle::PRACTICE, false).await?))
}

#[derive(Serialize)]
struct BenchInfo {
    whisper_installed: bool,
    /// The Whisper models downloaded, smallest first.
    models: Vec<String>,
    /// Where to put models: whisper.cpp's `ggml-<name>.bin` files.
    models_dir: String,
}

async fn bench_info(State(app): State<Shared>) -> ApiResult<BenchInfo> {
    let whisper = crate::whisper::Whisper::find(&app.paths.cache_dir);
    Ok(Json(BenchInfo {
        whisper_installed: whisper.is_some(),
        models: whisper
            .map(|w| w.models.into_iter().map(|(name, _)| name).collect())
            .unwrap_or_default(),
        models_dir: crate::whisper::models_dir(&app.paths.cache_dir)
            .display()
            .to_string(),
    }))
}

/// A benchmark session's id, which names a directory, so only plain characters are allowed.
fn check_session(id: &str) -> Result<()> {
    let valid = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !valid {
        anyhow::bail!("{id:?} isn't a benchmark session id");
    }
    Ok(())
}

fn bench_dir(app: &App, session: &str) -> Result<std::path::PathBuf, ApiError> {
    check_session(session).map_err(|e| bad_request(format!("{e:#}")))?;
    let dir = app.paths.data_dir.join("bench").join(session);
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    Ok(dir)
}

#[derive(Deserialize)]
struct BenchTranscribe {
    session: String,
    phrase: u32,
    /// What to prime Whisper with, such as the code's vocabulary.
    prompt: String,
}

/// Transcribes a recording with every Whisper model, with and without the prompt, keeping the
/// recording so it can be listened to and run again later.
async fn bench_transcribe(
    State(app): State<Shared>,
    Query(query): Query<BenchTranscribe>,
    wav: axum::body::Bytes,
) -> ApiResult<Vec<crate::whisper::Transcript>> {
    if !wav.starts_with(b"RIFF") {
        return Err(bad_request("The recording should be a WAV file."));
    }
    let Some(whisper) = crate::whisper::Whisper::find(&app.paths.cache_dir) else {
        return Err(bad_request(crate::whisper::INSTALL_HINT));
    };
    let path = bench_dir(&app, &query.session)?.join(format!("{:02}.wav", query.phrase));
    crate::paths::write_atomic(&path, &wav)?;
    let mut transcripts = Vec::new();
    // One at a time, so the timings aren't skewed by models competing for the GPU.
    for (model, _) in &whisper.models {
        for prompt in [None, Some(query.prompt.as_str())] {
            transcripts.push(whisper.transcribe(&path, model, prompt).await?);
        }
    }
    Ok(Json(transcripts))
}

/// Appends a phrase's results to the session's file.
async fn bench_result(
    State(app): State<Shared>,
    Json(result): Json<serde_json::Value>,
) -> ApiResult<()> {
    let session = result
        .get("session")
        .and_then(|s| s.as_str())
        .ok_or_else(|| bad_request("The result needs its session."))?;
    let path = bench_dir(&app, session)?.join("results.jsonl");
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .with_context(|| format!("opening {}", path.display()))?;
    writeln!(file, "{result}").with_context(|| format!("writing {}", path.display()))?;
    Ok(Json(()))
}

#[derive(Serialize)]
struct SpeechState {
    /// Whether dictation can use Whisper: the program and its model are both installed.
    ready: bool,
    whisper_installed: bool,
    model: &'static str,
    model_mb: u64,
    model_installed: bool,
    install_hint: &'static str,
    download: InstallStatus,
}

fn speech_state(app: &App) -> SpeechState {
    let whisper = crate::whisper::Whisper::find(&app.paths.cache_dir);
    let model_installed = crate::whisper::models_dir(&app.paths.cache_dir)
        .join(format!("ggml-{}.bin", crate::whisper::DICTATION_MODEL))
        .is_file();
    SpeechState {
        ready: whisper
            .as_ref()
            .is_some_and(|w| w.dictation_model().is_some()),
        whisper_installed: whisper.is_some(),
        model: crate::whisper::DICTATION_MODEL,
        model_mb: crate::whisper::DICTATION_MODEL_MB,
        model_installed,
        install_hint: crate::whisper::INSTALL_HINT,
        download: app.speech_install.status(),
    }
}

async fn get_speech(State(app): State<Shared>) -> ApiResult<SpeechState> {
    Ok(Json(speech_state(&app)))
}

/// Downloads Whisper's model for dictation.
async fn download_speech_model(State(app): State<Shared>) -> ApiResult<SpeechState> {
    install_with(
        &app,
        |app| &app.speech_install,
        AfterInstall::Nothing,
        |app, running| async move {
            crate::whisper::download_model(
                &app.paths.cache_dir,
                crate::whisper::DICTATION_MODEL,
                &running.cancel,
                &running.log,
            )
            .await
        },
    )
    .await?;
    Ok(Json(speech_state(&app)))
}

async fn cancel_speech_download(State(app): State<Shared>) -> ApiResult<()> {
    app.speech_install.cancel();
    Ok(Json(()))
}

#[derive(Serialize)]
struct Dictated {
    text: String,
}

/// Hears a recording of what was said, with Whisper.
async fn transcribe(State(app): State<Shared>, wav: axum::body::Bytes) -> ApiResult<Dictated> {
    if !wav.starts_with(b"RIFF") {
        return Err(bad_request("The recording should be a WAV file."));
    }
    let Some(whisper) = crate::whisper::Whisper::find(&app.paths.cache_dir) else {
        return Err(bad_request(crate::whisper::INSTALL_HINT));
    };
    let Some(model) = whisper.dictation_model() else {
        return Err(bad_request(format!(
            "Whisper's {} model isn't downloaded yet; download it in Settings, under Talking.",
            crate::whisper::DICTATION_MODEL
        )));
    };
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = app.paths.cache_dir.join("dictation");
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let path = dir.join(format!("{}-{n}.wav", std::process::id()));
    crate::paths::write_atomic(&path, &wav)?;
    let transcript = whisper.transcribe(&path, model, None).await;
    let _ = std::fs::remove_file(&path);
    let transcript = transcript?;
    tracing::info!(
        "dictation: heard {:?} in {}ms",
        transcript.text,
        transcript.wall_ms
    );
    Ok(Json(Dictated {
        text: crate::whisper::spoken_text(&transcript.text),
    }))
}

/// Lets the app check the server can be reached, such as after it was asleep.
async fn ping() -> ApiResult<()> {
    Ok(Json(()))
}

#[derive(Deserialize)]
struct SolutionsRepoBody {
    commit_after_star: bool,
}

async fn set_solutions_repo(
    State(app): State<Shared>,
    Json(body): Json<SolutionsRepoBody>,
) -> ApiResult<()> {
    app.update_settings(|s| s.commit_after_star = body.commit_after_star)?;
    Ok(Json(()))
}
