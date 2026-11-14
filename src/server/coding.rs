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

use super::error::{ApiError, ApiResult, bad_request};
use super::learning::Where;
use super::puzzles::{SaveText, saved};
use super::state::{Shared, lock};
use crate::coding::{Found, Opened, Overview, SUBMIT_RANDOM_INPUTS, Session, StepName, find};
use crate::discuss::{self, Turn};
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

/// Starts a problem, or carries on with it where it was left.
pub(super) async fn open(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Query(query): Query<OpenQuery>,
) -> ApiResult<Opened> {
    let packs = packs(&app)?;
    let found = found(&packs, &pack, &item)?;
    let attempts = app.learning.store().attempts(&found.key())?;
    let session = app
        .problems
        .start(&found, &attempts, query.solve, now_ms())?;
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
    let (mut session, code) = current(&app, &found)?;
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
    session.runs += 1;
    app.problems
        .save_session(&found, session, now_ms())
        .context("saving the session")?;
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
    session.submissions += 1;
    if passed {
        session.passed = true;
        session.step = StepName::Review;
    }
    let (session, _) = app
        .problems
        .save_session(&found, session, now_ms())
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
    /// When it comes back, in milliseconds since 1970.
    due: Option<i64>,
}

/// Records how the problem went, which schedules it, and ends its session.
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
        store.record(
            &[Attempt {
                id: body.id,
                item: key.clone(),
                answered_at: now,
                duration_ms: spent,
                rating: body.rating,
                response: Some(session.plan.clone()),
                seed: None,
            }],
            now,
        )?;
        app.problems.finish(&key)?;
    }
    let due = store.schedules()?.get(&key).map(|schedule| {
        store
            .scheduler()
            .due(schedule, app.config.learning.desired_retention)
    });
    Ok(Json(Finished { due }))
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
    let mut session = app
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
    session.hints += 1;
    app.problems
        .save_session(&found, session, now_ms())
        .context("saving the session")?;
    Ok(super::discuss::stream_reply(
        app.clone(),
        provider,
        spec,
        prompt,
    ))
}

/// The editor's connection to a language's server, for the drafts of coding problems.
pub(super) async fn lsp(
    State(app): State<Shared>,
    Path(id): Path<String>,
    upgrade: WebSocketUpgrade,
) -> Response {
    let Some(language) = Language::from_id(&id).filter(|l| l.is_writable()) else {
        return (StatusCode::NOT_FOUND, "There's no such language").into_response();
    };
    let Some(command) = app
        .config
        .languages
        .get(language.id())
        .and_then(|profile| profile.lsp.clone())
    else {
        return (StatusCode::NOT_FOUND, "No language server is configured").into_response();
    };
    upgrade.on_upgrade(move |socket| async move {
        let root = app.problems.root(language);
        if let Err(err) = std::fs::create_dir_all(&root) {
            tracing::warn!("language server: creating {}: {err}", root.display());
        }
        let environment = match crate::coding::runtime(&app.config, &app.paths).await {
            Ok(runtime) => runtime.environment,
            Err(err) => {
                tracing::warn!("language server: {err:#}");
                Vec::new()
            }
        };
        let restart = app.lsp_restarts.subscribe();
        let relayed = app
            .lsp_servers
            .relay(socket, &command, &root, &environment, restart);
        if let Err(err) = relayed.await {
            tracing::warn!("language server: {err:#}");
        }
    })
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
        assert_eq!(overview["items"].as_array().unwrap().len(), 11);

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
        assert_eq!(submitted["opened"]["session"]["submissions"], 1);

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

        // Opened again, it's recalled, with the plan from last time.
        let opened =
            json(send(&router, request("POST", &format!("{item}/open"), None)).await).await;
        assert_eq!(opened["session"]["mode"], "recall");
        assert_eq!(opened["session"]["step"], "plan");
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
