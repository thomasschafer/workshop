//! The Coding track: its problems, their steps and code, running them, and the tutor.

use std::hash::{Hash, Hasher};
use std::sync::Arc;

use anyhow::Context;
use axum::Json;
use axum::extract::{Path, Query, State, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use workshop_coding::{CaseResult, Graded, Oracle};
use workshop_learning::{Attempt, Rating};
use workshop_pack::{Language, Pack};
use workshop_provider::Role;
use workshop_toolchain::toolchain::Toolchain;

use super::error::{ApiError, ApiResult, bad_request};
use super::install::InstallStatus;
use super::learning::Where;
use super::puzzles::{SaveText, saved};
use super::setup::{Needs, install_programs};
use super::state::{Shared, lock};
use crate::coding::{Found, Mode, Opened, Overview, SUBMIT_RANDOM_INPUTS, Session, StepName, find};
use crate::discuss::{self, Turn};
use crate::language::LanguageProfile;
use crate::learning::now_ms;
use crate::workspace::VersionedFile;

fn packs(app: &Shared) -> Result<Vec<Pack>, ApiError> {
    Ok(crate::packs::load(&app.config.learning)?)
}

fn found<'a>(packs: &'a [Pack], pack: &str, item: &str) -> Result<Found<'a>, ApiError> {
    find(packs, pack, item).map_err(|err| {
        ApiError(
            StatusCode::NOT_FOUND,
            serde_json::json!({ "error": format!("{err:#}") }),
        )
    })
}

fn language(id: &str) -> Result<Language, ApiError> {
    Language::from_id(id).ok_or_else(|| bad_request(format!("there's no language {id:?}")))
}

pub(super) async fn overview(
    State(app): State<Shared>,
    Query(at): Query<Where>,
) -> ApiResult<Overview> {
    let clock = at.clock()?;
    let planned = app.learning.planned(clock)?;
    Ok(Json(crate::coding::overview(
        &planned,
        &app.problems.sessions()?,
        &app.learning.store().flags()?,
    )))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct OpenQuery {
    /// Solve it, even if it would otherwise be recalled.
    #[serde(default)]
    solve: bool,
}

/// Starts a problem, or carries on with it where it was left. A review is a twist, if there's
/// a model to pose one, which the app then asks for.
pub(super) async fn open(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Query(query): Query<OpenQuery>,
) -> ApiResult<Opened> {
    let packs = packs(&app)?;
    let found = found(&packs, &pack, &item)?;
    let attempts = app.learning.store().attempts(&found.key())?;
    let no_twist = app.twist_target(None).err().map(|err| {
        format!("There's no model to pose a twist ({err:#}), so recall how to solve it instead.")
    });
    let session = app
        .problems
        .start(&found, &attempts, query.solve, no_twist, now_ms())?;
    Ok(Json(app.problems.open(
        &app.config,
        &found,
        session,
        &attempts,
    )?))
}

pub(super) async fn save_session(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Json(session): Json<Session>,
) -> ApiResult<Opened> {
    let packs = packs(&app)?;
    let found = found(&packs, &pack, &item)?;
    let now = now_ms();
    let (session, spent) = app
        .problems
        .save_session(&found, session, now)
        .map_err(|err| bad_request(format!("{err:#}")))?;
    app.learning.store().record_time(&found.key(), now, spent)?;
    let attempts = app.learning.store().attempts(&found.key())?;
    Ok(Json(app.problems.open(
        &app.config,
        &found,
        session,
        &attempts,
    )?))
}

pub(super) async fn save_code(
    State(app): State<Shared>,
    Path((pack, item, id)): Path<(String, String, String)>,
    Json(body): Json<SaveText>,
) -> ApiResult<VersionedFile> {
    let packs = packs(&app)?;
    let found = found(&packs, &pack, &item)?;
    let language = language(&id)?;
    let saved = saved(
        app.problems
            .save_draft(&found, language, &body.text, &body.version),
    )?;
    let now = now_ms();
    let spent = app.problems.touch(&found.key(), now)?;
    app.learning.store().record_time(&found.key(), now, spent)?;
    Ok(saved)
}

/// Holds the run lock, and the cancel button's token, for as long as it's kept.
struct Running<'a> {
    app: &'a Shared,
    _guard: tokio::sync::MutexGuard<'a, ()>,
    cancel: CancellationToken,
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        *lock(&self.app.current_run) = None;
    }
}

fn start_running(app: &Shared) -> Result<Running<'_>, ApiError> {
    let Ok(guard) = app.run_lock.try_lock() else {
        return Err(ApiError(
            StatusCode::CONFLICT,
            serde_json::json!({ "error": "Something is already running." }),
        ));
    };
    let cancel = CancellationToken::new();
    *lock(&app.current_run) = Some(cancel.clone());
    Ok(Running {
        app,
        _guard: guard,
        cancel,
    })
}

/// The draft being worked on, and the session it's for.
fn current(app: &Shared, found: &Found<'_>) -> Result<(Session, VersionedFile), ApiError> {
    let session = app
        .problems
        .session(&found.key())?
        .ok_or_else(|| bad_request("Start the problem before running it."))?;
    let code = app.problems.draft(found, session.language)?;
    Ok((session, code))
}

/// Runs the code saved on the examples.
pub(super) async fn run(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
) -> ApiResult<Graded> {
    let packs = packs(&app)?;
    let found = found(&packs, &pack, &item)?;
    let (session, code) = current(&app, &found)?;
    let running = start_running(&app)?;
    let runtime = crate::coding::runtime(&app.config, &app.paths).await?;
    let graded = workshop_coding::run_examples(
        &runtime,
        found.coding,
        session.language,
        &code.text,
        &running.cancel,
    )
    .await?;
    Ok(Json(graded))
}

/// How a submission went: everything it ran on, up to the first case it got wrong.
#[derive(Serialize)]
pub(super) struct Submitted {
    passed: bool,
    /// What was wrong, in words, if anything was.
    problem: Option<String>,
    /// The first case it got wrong, if it ran.
    failure: Option<CaseResult>,
    /// How many cases it passed, of how many there are.
    ran: usize,
    total: usize,
    opened: Opened,
}

/// The most of a failing case's text that's sent: a hidden test can be far bigger than a phone
/// can usefully show.
const SHOWN_CHARS: usize = 4000;

fn shortened(text: &str) -> String {
    match text.char_indices().nth(SHOWN_CHARS) {
        Some((end, _)) => format!(
            "{}\n… and {} more characters",
            &text[..end],
            text.chars().count() - SHOWN_CHARS
        ),
        None => text.to_owned(),
    }
}

/// The problem's brute force and inputs program, built, kept while they don't change.
async fn oracle(
    app: &Shared,
    found: &Found<'_>,
    runtime: &workshop_coding::Runtime,
    cancel: &CancellationToken,
) -> Result<Arc<Oracle>, ApiError> {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    (&found.coding.brute_force.text, &found.coding.inputs.text).hash(&mut hasher);
    let key = format!("{}#{:x}", found.key(), hasher.finish());
    let mut oracles = app.oracles.lock().await;
    if let Some(oracle) = oracles.get(&key) {
        return Ok(oracle.clone());
    }
    let oracle = Oracle::build(runtime, found.coding, cancel)
        .await?
        .map_err(|problem| {
            anyhow::anyhow!("the problem's own programs can't be run here: {problem}")
        })?;
    let oracle = Arc::new(oracle);
    oracles.retain(|other, _| !other.starts_with(&format!("{}#", found.key())));
    oracles.insert(key, oracle.clone());
    Ok(oracle)
}

/// Runs the code saved on everything: the examples, random inputs compared with the brute
/// force, and the hidden tests. Passing moves the problem on to being reviewed.
pub(super) async fn submit(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
) -> ApiResult<Submitted> {
    let packs = packs(&app)?;
    let found = found(&packs, &pack, &item)?;
    let (mut session, code) = current(&app, &found)?;
    let running = start_running(&app)?;
    let runtime = crate::coding::runtime(&app.config, &app.paths).await?;
    let oracle = oracle(&app, &found, &runtime, &running.cancel).await?;
    let graded = workshop_coding::grade(
        &runtime,
        found.coding,
        &oracle,
        session.language,
        &code.text,
        SUBMIT_RANDOM_INPUTS.min(found.coding.random_inputs),
        &running.cancel,
    )
    .await?
    .map_err(|problem| anyhow::anyhow!("the problem's own programs went wrong: {problem}"))?;
    drop(running);
    let passed = graded.passed();
    let now = now_ms();
    // One per submission: the session's start and its count of submissions say which.
    let id = format!(
        "submission-{}-{}-{}",
        found.key(),
        session.started_at,
        session.submissions + 1
    );
    if let Some(mistake) = crate::mistakes::from_submission(&found.key(), id, now, &graded) {
        app.learning.store().record_mistakes(&[mistake])?;
    }
    session.submissions += 1;
    session.passed = passed;
    session.step = if passed {
        StepName::Review
    } else {
        StepName::Test
    };
    let (session, _) = app
        .problems
        .save_session(&found, session, now)
        .context("saving the session")?;
    let (ran, total) = match &graded {
        Graded::Ran { results, total } => (
            results.iter().filter(|result| result.passed).count(),
            *total,
        ),
        _ => (0, 0),
    };
    let failure = graded.failure().cloned().map(|mut failure| {
        failure.input = shortened(&failure.input);
        failure.expected = shortened(&failure.expected);
        failure.run.stdout = shortened(&failure.run.stdout);
        failure.run.stderr = shortened(&failure.run.stderr);
        failure
    });
    let attempts = app.learning.store().attempts(&found.key())?;
    Ok(Json(Submitted {
        passed,
        problem: graded.problem().map(|problem| shortened(&problem)),
        failure,
        ran,
        total,
        opened: app.problems.open(&app.config, &found, session, &attempts)?,
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct FinishBody {
    /// Made by the app, so finishing twice, such as after a lost reply, records one attempt.
    id: String,
    rating: Rating,
}

#[derive(Serialize)]
pub(super) struct Finished {
    /// When it comes back, in milliseconds since 1970, unless it's retired.
    due: Option<i64>,
    /// Whether it's retired, as rating it easy does, so it never comes back.
    retired: bool,
}

/// Records how the problem went, which schedules it, or retires it if it was easy, and ends
/// its session.
pub(super) async fn finish(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Json(body): Json<FinishBody>,
) -> ApiResult<Finished> {
    let packs = packs(&app)?;
    let found = found(&packs, &pack, &item)?;
    let key = found.key();
    let store = app.learning.store();
    let already = store.attempts(&key)?.iter().any(|a| a.id == body.id);
    if !already {
        let session = app
            .problems
            .session(&key)?
            .ok_or_else(|| bad_request("The problem hasn't been started."))?;
        let now = now_ms();
        let spent = app.problems.touch(&key, now)?;
        app.learning.record_problem(
            Attempt {
                id: body.id,
                item: key.clone(),
                answered_at: now,
                duration_ms: spent,
                rating: body.rating,
                response: Some(session.plan.clone()),
                seed: None,
            },
            &[],
            now,
        )?;
        app.problems.finish(&key)?;
    }
    Ok(Json(finished(&app, &key)?))
}

/// How a problem stands once it's finished: when it's due, or that it's retired.
fn finished(app: &Shared, key: &str) -> Result<Finished, ApiError> {
    let store = app.learning.store();
    let retirement = store.retirements()?.get(key).copied();
    let due = store.schedules()?.get(key).and_then(|schedule| {
        workshop_learning::due(
            schedule,
            retirement,
            store.scheduler(),
            app.config.learning.desired_retention,
        )
    });
    Ok(Finished {
        due,
        retired: retirement.is_some_and(|r| r.is_retired()),
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct BringBackBody {
    /// Made by the app, so bringing it back twice, such as after a lost reply, is one change.
    id: String,
}

/// Brings a retired problem back, due straight away.
pub(super) async fn bring_back(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Json(body): Json<BringBackBody>,
) -> ApiResult<Finished> {
    let packs = packs(&app)?;
    let found = found(&packs, &pack, &item)?;
    let key = found.key();
    app.learning
        .bring_back(&key, &body.id, now_ms())
        .map_err(|err| bad_request(format!("{err:#}")))?;
    Ok(Json(finished(&app, &key)?))
}

/// The most of why posing a twist failed that's shown, as a model CLI can say a great deal.
const WHY_CHARS: usize = 300;

/// Poses the twist for a review, once: asked again, such as after a reload, it's the same one.
/// If the tutor can't pose one, the review becomes a recall, saying why.
pub(super) async fn twist(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
) -> ApiResult<Opened> {
    let packs = packs(&app)?;
    let found = found(&packs, &pack, &item)?;
    let key = found.key();
    let posing = app.posing_twist.lock().await;
    let session = app
        .problems
        .session(&key)?
        .ok_or_else(|| bad_request("Start the problem before asking for a twist on it."))?;
    let posed = app.problems.twists(&key)?;
    let session = if session.mode == Mode::Twist && posed.for_session(session.started_at).is_none()
    {
        match pose(&app, &found, &session, &posed).await {
            Ok(twist) => {
                app.problems.keep_twist(&key, twist)?;
                session
            }
            Err(err) => {
                tracing::warn!("posing a twist on {key}: {err:#}");
                let why = format!("{err:#}");
                let why = match why.char_indices().nth(WHY_CHARS) {
                    Some((end, _)) => format!("{}…", &why[..end]),
                    None => why,
                };
                let now = now_ms();
                let (session, spent) = app.problems.save_session(
                    &found,
                    session.recall_instead(format!(
                        "The tutor couldn't pose a twist ({why}), so recall how to solve it instead."
                    )),
                    now,
                )?;
                app.learning.store().record_time(&key, now, spent)?;
                session
            }
        }
    } else {
        session
    };
    drop(posing);
    let attempts = app.learning.store().attempts(&key)?;
    Ok(Json(app.problems.open(
        &app.config,
        &found,
        session,
        &attempts,
    )?))
}

async fn pose(
    app: &Shared,
    found: &Found<'_>,
    session: &Session,
    posed: &crate::twist::Posed,
) -> anyhow::Result<crate::twist::Twist> {
    let (runner, spec) =
        app.twist_target(found.pack.prompt_add_ons.get("tutor").map(String::as_str))?;
    let solution = app.problems.last_draft(found)?;
    let kind = crate::twist::Kind::next(&posed.twists);
    let (prompt, notes) = crate::twist::pose(
        runner,
        &spec,
        &crate::twist::Asking {
            problem: &found.item.prompt,
            approach: &found.coding.approach,
            solution: solution
                .as_ref()
                .map(|(language, code)| (language.name(), code.as_str())),
            kind,
            posed: &posed.twists,
        },
    )
    .await?;
    Ok(crate::twist::Twist {
        session: session.started_at,
        kind,
        prompt,
        notes,
        posed_at: now_ms(),
        answered: None,
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TwistAnswerBody {
    /// Made by the app, for the attempt it records, so answering twice records one.
    id: String,
    text: String,
    /// Whether it was explained aloud, so `text` is what was heard.
    #[serde(default)]
    spoken: bool,
    /// Whether the answer is in the code too, which the grader is then shown.
    #[serde(default)]
    with_code: bool,
}

#[derive(Serialize)]
pub(super) struct TwistMarked {
    marked: crate::grader::Marked,
    rubric: Vec<String>,
    /// What a good answer covers, now it's been answered.
    notes: String,
    /// How the original problem is solved.
    approach: String,
    #[serde(flatten)]
    finished: Finished,
}

/// Marks an answer to a review's twist with the grader. Its mark is the review's rating, which
/// schedules the problem and feeds mastery, or retires it, if it was answered fully; what it
/// finds goes in the mistake log; and the review is over.
pub(super) async fn answer_twist(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Json(body): Json<TwistAnswerBody>,
) -> ApiResult<TwistMarked> {
    let packs = packs(&app)?;
    let found = found(&packs, &pack, &item)?;
    let key = found.key();
    let reply = |twist: &crate::twist::Twist, marked: crate::grader::Marked| {
        Ok::<_, ApiError>(Json(TwistMarked {
            rubric: marked.points.iter().map(|p| p.point.clone()).collect(),
            marked,
            notes: twist.notes.clone(),
            approach: found.coding.approach.clone(),
            finished: finished(&app, &key)?,
        }))
    };
    // Sent again, as after a lost reply, it's the answer already marked.
    let posed = app.problems.twists(&key)?;
    if let Some((twist, answered)) = posed.twists.iter().find_map(|twist| {
        twist
            .answered
            .as_ref()
            .filter(|a| a.attempt == body.id)
            .map(|a| (twist, a))
    }) {
        return reply(twist, answered.marked.clone());
    }
    let session = app
        .problems
        .session(&key)?
        .filter(|session| session.mode == Mode::Twist)
        .ok_or_else(|| bad_request("There's no twist being answered on this problem."))?;
    let twist = posed
        .for_session(session.started_at)
        .filter(|twist| twist.answered.is_none())
        .cloned()
        .ok_or_else(|| bad_request("The twist hasn't been posed yet."))?;
    let code = if body.with_code {
        Some(app.problems.draft(&found, session.language)?.text)
    } else {
        None
    };
    let answer = crate::grader::Answer {
        spoken: body.spoken,
        code: code.as_deref().map(|text| (session.language.name(), text)),
        twist: Some((&twist.prompt, &twist.notes)),
        ..crate::grader::Answer::written(&body.text)
    };
    let error_types = crate::mistakes::error_types(&packs);
    let (runner, spec) =
        app.grader_target(found.pack.prompt_add_ons.get("grader").map(String::as_str))?;
    let marked = crate::grader::mark(
        runner,
        &spec,
        found.item,
        crate::grader::Work::Twist,
        answer,
        &error_types,
    )
    .await
    .map_err(|err| bad_request(format!("{err:#}")))?;
    let now = now_ms();
    let spent = app.problems.touch(&key, now)?;
    app.learning.record_problem(
        Attempt {
            id: body.id.clone(),
            item: key.clone(),
            answered_at: now,
            duration_ms: spent,
            rating: marked.twist_rating(),
            // The answer is kept with its twist, so it isn't taken for a plan to recall.
            response: None,
            seed: None,
        },
        &marked.mistakes(&body.id, &key, now),
        now,
    )?;
    let twist = crate::twist::Twist {
        answered: Some(crate::twist::Answered {
            attempt: body.id,
            text: body.text,
            marked: marked.clone(),
        }),
        ..twist
    };
    app.problems.keep_twist(&key, twist.clone())?;
    app.problems.finish(&key)?;
    reply(&twist, marked)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TutorBody {
    model: String,
    turns: Vec<Turn>,
    #[serde(default)]
    code: String,
    #[serde(default)]
    errors: String,
    #[serde(default)]
    last_run: String,
}

/// Asks the tutor for a hint, streamed as it's written, as the discussion coach's replies are.
pub(super) async fn tutor(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Json(body): Json<TutorBody>,
) -> Result<Response, ApiError> {
    let provider = app.model_settings().discuss_provider;
    if !crate::models::discuss_models(&app.config, &provider).contains(&body.model) {
        return Err(bad_request(format!(
            "{:?} isn't one of the discussion models for {provider}",
            body.model
        )));
    }
    let packs = packs(&app)?;
    let found = found(&packs, &pack, &item)?;
    let key = found.key();
    let session = app
        .problems
        .session(&key)?
        .ok_or_else(|| bad_request("Start the problem before asking about it."))?;
    let step = format!("{:?}", session.step).to_lowercase();
    let prompt = discuss::tutor_prompt(
        &discuss::TutorContext {
            problem: &found.item.prompt,
            step: &step,
            language: session.language.name(),
            plan: &session.plan,
            code: &body.code,
            errors: &body.errors,
            last_run: &body.last_run,
        },
        &body.turns,
    );
    let system =
        discuss::tutor_system_prompt(found.pack.prompt_add_ons.get("tutor").map(String::as_str));
    let spec = app.config.providers[&provider].spec(Role::Discuss, &body.model, system);
    Ok(super::discuss::stream_reply(
        app.clone(),
        provider,
        spec,
        prompt,
    ))
}

/// A language the learner writes code in, with its profile, which says how to install its
/// programs and which language server to start.
fn writable(app: &Shared, id: &str) -> Result<(Language, LanguageProfile), ApiError> {
    let language = Language::from_id(id)
        .filter(|l| l.is_writable())
        .ok_or_else(|| {
            ApiError(
                StatusCode::NOT_FOUND,
                serde_json::json!({ "error": format!("there's no language {id:?} to write code in") }),
            )
        })?;
    let profile = app
        .config
        .languages
        .get(language.id())
        .cloned()
        .ok_or_else(|| bad_request(format!("{} has no language profile", language.name())))?;
    Ok((language, profile))
}

/// The editor's connection to a language's server, for the drafts of coding problems.
pub(super) async fn lsp(
    State(app): State<Shared>,
    Path(id): Path<String>,
    upgrade: WebSocketUpgrade,
) -> Response {
    let (language, profile) = match writable(&app, &id) {
        Ok(found) => found,
        Err(err) => return err.into_response(),
    };
    let Some(command) = profile.lsp.clone() else {
        return (StatusCode::NOT_FOUND, "No language server is configured").into_response();
    };
    upgrade.on_upgrade(move |socket| async move {
        let root = app.problems.root(language);
        if let Err(err) = std::fs::create_dir_all(&root) {
            tracing::warn!("language server: creating {}: {err}", root.display());
        }
        let environment = match crate::coding::toolchain(&app.paths, language).await {
            Ok(toolchain) => toolchain.variables().to_vec(),
            Err(err) => {
                tracing::warn!("language server: {err:#}");
                Vec::new()
            }
        };
        let restart = app.lsp_restarts.subscribe();
        let help = super::lsp::install_help(&profile, "Workshop", " for the Coding track");
        let relayed = app
            .lsp_servers
            .relay(socket, &command, &root, &environment, &help, restart);
        if let Err(err) = relayed.await {
            tracing::warn!("language server: {err:#}");
        }
    })
}

/// Whether the Coding track has what it needs to build, run and check code in a language, and
/// installing it.
#[derive(Serialize)]
pub(super) struct ToolchainState {
    name: String,
    #[serde(flatten)]
    needs: Needs,
    /// Whether mise is installed, to install the language's programs with.
    mise_installed: bool,
    /// Why the language's mise config couldn't be read, if it couldn't.
    problem: Option<String>,
    install: InstallStatus,
}

pub(super) async fn toolchain(
    State(app): State<Shared>,
    Path(id): Path<String>,
) -> ApiResult<ToolchainState> {
    let (language, profile) = writable(&app, &id)?;
    let (toolchain, problem) = match crate::coding::toolchain(&app.paths, language).await {
        Ok(toolchain) => (toolchain, None),
        Err(err) => (Toolchain::default(), Some(format!("{err:#}"))),
    };
    Ok(Json(ToolchainState {
        name: profile.name.clone(),
        needs: Needs::of(&profile, &[workshop_coding::needs(language)], &toolchain),
        mise_installed: workshop_common::programs::find_program("mise").is_some(),
        problem,
        install: app.coding_toolchain_installs[&language].status(),
    }))
}

/// Installs a language's programs with mise, for the Coding track only, into the directory its
/// drafts are in.
pub(super) async fn install_toolchain(
    State(app): State<Shared>,
    Path(id): Path<String>,
) -> ApiResult<ToolchainState> {
    let (language, profile) = writable(&app, &id)?;
    let Some(toolchain) = profile.toolchain.clone() else {
        return Err(bad_request(format!(
            "Workshop doesn't know how to install {} with mise.",
            profile.name
        )));
    };
    install_programs(
        &app,
        move |app| &app.coding_toolchain_installs[&language],
        toolchain,
        app.problems.root(language),
    )
    .await?;
    tracing::info!("installed {} for the Coding track with mise", profile.name);
    self::toolchain(State(app), Path(id)).await
}

pub(super) async fn cancel_toolchain_install(
    State(app): State<Shared>,
    Path(id): Path<String>,
) -> ApiResult<()> {
    let (language, _) = writable(&app, &id)?;
    app.coding_toolchain_installs[&language].cancel();
    Ok(Json(()))
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::{StatusCode, header};

    use crate::server::testing::{send, test_app};

    async fn json(response: axum::response::Response) -> serde_json::Value {
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    fn request(method: &str, path: &str, body: Option<serde_json::Value>) -> Request {
        let builder = Request::builder()
            .method(method)
            .uri(path)
            .header(header::COOKIE, "workshop_token=secret")
            .header(header::CONTENT_TYPE, "application/json");
        match body {
            Some(body) => builder.body(Body::from(body.to_string())).unwrap(),
            None => builder.body(Body::empty()).unwrap(),
        }
    }

    #[tokio::test]
    async fn works_through_a_problem_and_schedules_it() {
        let (_dir, router) = test_app().await;
        let item = "/api/coding/items/sample/first-repeat";
        let overview =
            json(send(&router, request("GET", "/api/coding?utc_offset=0", None)).await).await;
        assert_eq!(overview["items"].as_array().unwrap().len(), 21);

        let opened = send(&router, request("POST", &format!("{item}/open"), None)).await;
        assert_eq!(opened.status(), StatusCode::OK);
        let opened = json(opened).await;
        assert_eq!(opened["session"]["step"], "understand");
        assert_eq!(opened["solution"], serde_json::Value::Null);
        // The hidden tests are never sent.
        assert!(opened.get("tests").is_none());
        let python = &opened["languages"][0];
        assert_eq!(python["id"], "python");

        // A step done is saved.
        let mut session = opened["session"].clone();
        session["step"] = "code".into();
        session["plan"] = "Remember the words I've seen".into();
        let saved = json(
            send(
                &router,
                request("PUT", &format!("{item}/session"), Some(session.clone())),
            )
            .await,
        )
        .await;
        assert_eq!(saved["session"]["plan"], "Remember the words I've seen");

        // A wrong solution fails on a small input, and says which.
        let wrong = "print(\"none\")\n";
        let body = serde_json::json!({ "text": wrong, "version": python["code"]["version"] });
        let code = json(
            send(
                &router,
                request("PUT", &format!("{item}/code/python"), Some(body)),
            )
            .await,
        )
        .await;
        let ran = json(send(&router, request("POST", &format!("{item}/run"), None)).await).await;
        assert_eq!(ran["outcome"], "ran");
        assert_eq!(ran["results"][0]["passed"], false);
        let submitted =
            json(send(&router, request("POST", &format!("{item}/submit"), None)).await).await;
        assert_eq!(submitted["passed"], false);
        assert_eq!(submitted["failure"]["case"]["kind"], "example");
        assert_eq!(submitted["opened"]["session"]["step"], "test");
        assert_eq!(submitted["opened"]["session"]["submissions"], 1);
        // It's in the mistake log, as a misreading, since an example it could see failed.
        let log = json(send(&router, request("GET", "/api/mistakes", None)).await).await;
        let logged = &log["mistakes"][0];
        assert_eq!(logged["source"], "submission");
        assert_eq!(logged["item"], "sample/first-repeat");
        assert_eq!(logged["suggested"], "misread");
        assert!(
            logged["detail"].as_str().unwrap().contains("example 1"),
            "{logged}"
        );

        let right = "import sys\nseen = set()\nfor w in sys.stdin.read().split():\n    if w in seen:\n        print(w)\n        break\n    seen.add(w)\nelse:\n    print('none')\n";
        let body = serde_json::json!({ "text": right, "version": code["version"] });
        send(
            &router,
            request("PUT", &format!("{item}/code/python"), Some(body)),
        )
        .await;
        let submitted =
            json(send(&router, request("POST", &format!("{item}/submit"), None)).await).await;
        assert_eq!(submitted["passed"], true, "{submitted}");
        assert_eq!(submitted["ran"], submitted["total"]);
        assert_eq!(submitted["opened"]["session"]["step"], "review");
        assert!(
            submitted["opened"]["solution"]["approach"]
                .as_str()
                .unwrap()
                .contains("set")
        );

        let finish =
            serde_json::json!({ "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a12", "rating": "good" });
        let finished = json(
            send(
                &router,
                request("POST", &format!("{item}/finish"), Some(finish.clone())),
            )
            .await,
        )
        .await;
        assert!(finished["due"].as_i64().unwrap() > crate::learning::now_ms());
        // Sent again, as when the reply was lost, it's the same attempt.
        let again = send(
            &router,
            request("POST", &format!("{item}/finish"), Some(finish)),
        )
        .await;
        assert_eq!(again.status(), StatusCode::OK);
        let overview =
            json(send(&router, request("GET", "/api/coding?utc_offset=0", None)).await).await;
        let listed = overview["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["key"] == "sample/first-repeat")
            .unwrap();
        assert_eq!(listed["status"], "done");

        // Opened again, it's reviewed with a twist, for the app to ask for, with the plan from
        // last time.
        let opened =
            json(send(&router, request("POST", &format!("{item}/open"), None)).await).await;
        assert_eq!(opened["session"]["mode"], "twist");
        assert_eq!(opened["session"]["step"], "twist");
        assert_eq!(opened["twist"], serde_json::Value::Null);
        assert_eq!(opened["previous_plan"], "Remember the words I've seen");
        let solve = json(
            send(
                &router,
                request("POST", &format!("{item}/open?solve=true"), None),
            )
            .await,
        )
        .await;
        assert_eq!(solve["session"]["mode"], "solve");
    }

    #[tokio::test]
    async fn retires_a_problem_rated_easy_until_its_brought_back() {
        let (_dir, router) = test_app().await;
        let item = "/api/coding/items/sample/islands";
        let status = |overview: &serde_json::Value| {
            overview["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["key"] == "sample/islands")
                .unwrap()["status"]
                .clone()
        };
        let overview = || async {
            json(send(&router, request("GET", "/api/coding?utc_offset=0", None)).await).await
        };
        send(&router, request("POST", &format!("{item}/open"), None)).await;
        let finish =
            serde_json::json!({ "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a61", "rating": "easy" });
        let finished = json(
            send(
                &router,
                request("POST", &format!("{item}/finish"), Some(finish.clone())),
            )
            .await,
        )
        .await;
        assert_eq!(finished["retired"], true);
        assert_eq!(finished["due"], serde_json::Value::Null);
        // Sent again, it's the same attempt and the same retirement.
        let again = json(
            send(
                &router,
                request("POST", &format!("{item}/finish"), Some(finish)),
            )
            .await,
        )
        .await;
        assert_eq!(again["retired"], true);
        assert_eq!(status(&overview().await), "retired");
        // It's never offered, even as the only thing left to do.
        let home = json(send(&router, request("GET", "/api/home?utc_offset=0", None)).await).await;
        assert!(!home.to_string().contains("Count the islands"), "{home}");
        // It still counts towards its skill, as known for good.
        let goals =
            json(send(&router, request("GET", "/api/goals?utc_offset=0", None)).await).await;
        let graphs = goals["goals"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|goal| goal["skills"].as_array().unwrap())
            .find(|skill| skill["id"] == "algorithms.graphs")
            .unwrap();
        let items = graphs["items"].as_f64().unwrap();
        assert_eq!(graphs["mastery"].as_f64().unwrap(), 1.0 / items, "{graphs}");

        let back = serde_json::json!({ "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a62" });
        let brought = json(
            send(
                &router,
                request("POST", &format!("{item}/bring-back"), Some(back.clone())),
            )
            .await,
        )
        .await;
        assert_eq!(brought["retired"], false);
        assert!(brought["due"].as_i64().unwrap() <= crate::learning::now_ms());
        assert_eq!(status(&overview().await), "due");
        // Twice is once, and an item that isn't retired can't be brought back.
        let twice = send(
            &router,
            request("POST", &format!("{item}/bring-back"), Some(back)),
        )
        .await;
        assert_eq!(twice.status(), StatusCode::OK);
        let other = serde_json::json!({ "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a63" });
        let refused = send(
            &router,
            request("POST", &format!("{item}/bring-back"), Some(other)),
        )
        .await;
        assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
    }

    const TWIST: &str = r#"{"twist": "Now the words stream in, a billion of them.", "notes": "Keep a set as they arrive, and stop at the first repeat."}"#;
    const TWIST_MARKED: &str = r#"{"score": 0.7, "points": [{"point": "Says what has to change", "met": "partly", "comment": "Memory?"}], "findings": [{"error_type": "missed-edge-case", "detail": "Says nothing of running out of memory"}], "feedback": "Think about memory."}"#;

    /// A server with a stand-in tutor and grader, which pose and mark twists, or with `posing`
    /// false, a tutor that can't pose them.
    #[cfg(unix)]
    fn twisting_app(dir: &std::path::Path, posing: bool) -> axum::Router {
        std::fs::write(dir.join("twist.json"), TWIST).unwrap();
        std::fs::write(dir.join("twist-marked.json"), TWIST_MARKED).unwrap();
        let mut replies = vec![("<twist>", "twist-marked.json")];
        if posing {
            replies.push(("Pose a twist on it", "twist.json"));
        }
        let model = crate::server::testing::fake_discussion_model(dir, &replies);
        crate::server::testing::test_app_in(dir, &model)
    }

    /// Solves a problem, rated good, then opens it again for its review.
    async fn solve_then_review(router: &axum::Router, item: &str) -> serde_json::Value {
        send(router, request("POST", &format!("{item}/open"), None)).await;
        let finish =
            serde_json::json!({ "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a71", "rating": "good" });
        json(
            send(
                router,
                request("POST", &format!("{item}/finish"), Some(finish)),
            )
            .await,
        )
        .await;
        json(send(router, request("POST", &format!("{item}/open"), None)).await).await
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reviews_a_problem_with_a_twist_the_grader_marks() {
        let dir = tempfile::tempdir().unwrap();
        let router = twisting_app(dir.path(), true);
        let item = "/api/coding/items/sample/first-repeat";
        let opened = solve_then_review(&router, item).await;
        assert_eq!(opened["session"]["mode"], "twist");

        let posed =
            json(send(&router, request("POST", &format!("{item}/twist"), None)).await).await;
        assert_eq!(posed["twist"]["kind"], "constraint");
        assert_eq!(
            posed["twist"]["prompt"],
            "Now the words stream in, a billion of them."
        );
        // What a good answer covers isn't sent until it's answered.
        assert!(!posed.to_string().contains("Keep a set as they arrive"));
        // Asked again, or opened again, as after a reload, it's the same twist.
        std::fs::write(dir.path().join("twist.json"), "not a twist").unwrap();
        let again =
            json(send(&router, request("POST", &format!("{item}/twist"), None)).await).await;
        assert_eq!(again["twist"], posed["twist"]);
        let reopened =
            json(send(&router, request("POST", &format!("{item}/open"), None)).await).await;
        assert_eq!(reopened["twist"], posed["twist"]);

        let answer = serde_json::json!({
            "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a72",
            "text": "Keep a set of the words seen, and stop at the first one already in it",
        });
        let marked = json(
            send(
                &router,
                request(
                    "POST",
                    &format!("{item}/twist/answer"),
                    Some(answer.clone()),
                ),
            )
            .await,
        )
        .await;
        assert_eq!(marked["marked"]["score"], 0.7);
        assert!(marked["notes"].as_str().unwrap().contains("Keep a set"));
        assert!(marked["approach"].as_str().unwrap().contains("set"));
        // Its mark is the review's rating: hard, so it's due again, and not retired.
        assert_eq!(marked["retired"], false);
        assert!(marked["due"].as_i64().unwrap() > crate::learning::now_ms());
        let log = json(send(&router, request("GET", "/api/mistakes", None)).await).await;
        assert!(
            log["mistakes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["detail"] == "Says nothing of running out of memory"),
            "{log}"
        );
        // Sent again, as after a lost reply, it's the same answer, marked once.
        let resent = json(
            send(
                &router,
                request("POST", &format!("{item}/twist/answer"), Some(answer)),
            )
            .await,
        )
        .await;
        assert_eq!(resent["marked"], marked["marked"]);
        let overview =
            json(send(&router, request("GET", "/api/coding?utc_offset=0", None)).await).await;
        let listed = overview["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["key"] == "sample/first-repeat")
            .unwrap();
        assert_eq!(listed["status"], "done");

        // The next review's twist is of another kind, told not to repeat this one.
        std::fs::write(dir.path().join("twist.json"), TWIST).unwrap();
        json(send(&router, request("POST", &format!("{item}/open"), None)).await).await;
        let next = json(send(&router, request("POST", &format!("{item}/twist"), None)).await).await;
        assert_eq!(next["twist"]["kind"], "scale");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn recalls_the_approach_instead_when_the_tutor_cant_pose_a_twist() {
        let dir = tempfile::tempdir().unwrap();
        let router = twisting_app(dir.path(), false);
        let item = "/api/coding/items/sample/first-repeat";
        solve_then_review(&router, item).await;
        let opened =
            json(send(&router, request("POST", &format!("{item}/twist"), None)).await).await;
        assert_eq!(opened["session"]["mode"], "recall");
        assert_eq!(opened["session"]["step"], "plan");
        assert_eq!(opened["twist"], serde_json::Value::Null);
        let why = opened["session"]["no_twist"].as_str().unwrap();
        assert!(
            why.starts_with("The tutor couldn't pose a twist ("),
            "{why}"
        );
        assert!(why.ends_with("so recall how to solve it instead."), "{why}");
        // It stays a recall, rather than asking again.
        let reopened =
            json(send(&router, request("POST", &format!("{item}/open"), None)).await).await;
        assert_eq!(reopened["session"]["mode"], "recall");
        // And there's no twist to answer.
        let answer =
            serde_json::json!({ "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a73", "text": "x" });
        let refused = send(
            &router,
            request("POST", &format!("{item}/twist/answer"), Some(answer)),
        )
        .await;
        assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
    }

    /// A server whose Python language server isn't installed anywhere.
    fn without_a_language_server(dir: &std::path::Path) -> std::sync::Arc<crate::server::App> {
        let mut config = crate::config::Config::parse("").unwrap();
        config.solutions_dir = dir.join("aoc");
        config.languages.get_mut("python").unwrap().lsp =
            Some(vec!["workshop-no-such-language-server".to_owned()]);
        std::sync::Arc::new(
            crate::server::App::new(
                config,
                crate::paths::Paths::under(dir),
                "secret".into(),
                None,
            )
            .unwrap(),
        )
    }

    /// A language server that isn't installed is reported to the editor, with why and how to
    /// install it, rather than the connection just closing for the editor to try again.
    #[tokio::test]
    async fn says_why_a_language_server_cant_start() {
        use futures_util::StreamExt;
        use tokio_tungstenite::tungstenite::Message;
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;

        let dir = tempfile::tempdir().unwrap();
        let app = without_a_language_server(dir.path());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, crate::server::router(app)).await });

        let mut request = format!("ws://{address}/api/coding/lsp/python")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert(header::COOKIE, "workshop_token=secret".parse().unwrap());
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        let notice = socket.next().await.unwrap().unwrap();
        let notice: serde_json::Value = serde_json::from_str(notice.to_text().unwrap()).unwrap();
        assert_eq!(notice["method"], workshop_lsp::UNAVAILABLE);
        let reason = notice["params"]["reason"].as_str().unwrap();
        assert!(
            reason.contains("`workshop-no-such-language-server`, isn't installed"),
            "{reason}"
        );
        let help = notice["params"]["help"].as_str().unwrap();
        assert!(help.contains("can install it with mise"), "{help}");
        assert!(matches!(
            socket.next().await,
            Some(Ok(Message::Close(_))) | None
        ));
    }

    /// What the Coding track needs for a language, and that it can install it with mise, for
    /// the languages learners write code in.
    #[tokio::test]
    async fn says_what_a_language_needs_and_that_it_can_install_it() {
        let dir = tempfile::tempdir().unwrap();
        let router = crate::server::router(without_a_language_server(dir.path()));
        let response = send(
            &router,
            request("GET", "/api/coding/toolchain/python", None),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let state = json(response).await;
        assert_eq!(state["name"], "Python");
        assert_eq!(
            state["missing_language_server"],
            "workshop-no-such-language-server"
        );
        assert_eq!(state["installable"], true);
        assert_eq!(state["install"]["installing"], false);
        for language in ["cpp", "cobol"] {
            let path = format!("/api/coding/toolchain/{language}");
            let response = send(&router, request("GET", &path, None)).await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{language}");
        }
    }

    #[tokio::test]
    async fn says_what_isnt_a_problem() {
        let (_dir, router) = test_app().await;
        let missing = send(
            &router,
            request("POST", "/api/coding/items/sample/nothing/open", None),
        )
        .await;
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        let card = send(
            &router,
            request("POST", "/api/coding/items/sample/stable-sorting/open", None),
        )
        .await;
        assert_eq!(card.status(), StatusCode::NOT_FOUND);
        let unstarted = send(
            &router,
            request("POST", "/api/coding/items/sample/islands/run", None),
        )
        .await;
        assert_eq!(unstarted.status(), StatusCode::BAD_REQUEST);
    }
}
