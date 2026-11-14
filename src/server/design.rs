//! The System design track: its prompts, each worked through as a design session in stages,
//! with the coach's follow-up questions, and marked as a whole by the grader at the end.

use axum::Json;
use axum::extract::{Path, Query, State};
use serde::{Deserialize, Serialize};
use workshop_learning::Attempt;
use workshop_pack::{Content, Item, Kind, Pack};
use workshop_sessions::Speaker;
use workshop_sessions::design::{Edit, Session, Stage};

use super::error::{ApiError, ApiResult, bad_request};
use super::grading::{MarkedReply, find, packs};
use super::learning::Where;
use super::state::Shared;
use crate::grader::{Answer, Work};
use crate::learning::{Week, now_ms};

#[derive(Serialize)]
pub(super) struct DesignList {
    items: Vec<DesignListed>,
    week: Week,
}

#[derive(Serialize)]
pub(super) struct DesignListed {
    key: String,
    label: String,
    skills: Vec<String>,
    minutes: u32,
    /// "in_progress", "due", "new" or "done".
    status: &'static str,
    /// The stage it's at, if it's in progress.
    stage: Option<Stage>,
    /// The grader's last score, from 0 to 1, if it's been answered.
    last_score: Option<f64>,
}

/// The System design track: its prompts, and where each one is.
pub(super) async fn list(
    State(app): State<Shared>,
    Query(at): Query<Where>,
) -> ApiResult<DesignList> {
    let clock = at.clock()?;
    let planned = app.learning.planned(clock)?;
    let plan = planned.plans.get(&workshop_tracks::TrackId::SystemDesign);
    let sessions = app.design_sessions.all()?;
    let items = planned
        .packs
        .iter()
        .flat_map(|pack| {
            pack.items
                .iter()
                .filter(|item| item.kind == Kind::Design)
                .map(move |item| (format!("{}/{}", pack.manifest.id, item.id), item))
        })
        .map(|(key, item)| {
            let session = sessions.get(&key);
            let status = if session.is_some() {
                "in_progress"
            } else if plan.is_some_and(|p| p.due.contains(&key)) {
                "due"
            } else if plan.is_some_and(|p| p.new.contains(&key)) {
                "new"
            } else {
                "done"
            };
            let last_score = app
                .learning
                .store()
                .attempts(&key)
                .ok()
                .and_then(|attempts| attempts.last().map(|a| score_of(a.rating)));
            Ok(DesignListed {
                label: item.label(),
                skills: item.skills.clone(),
                minutes: item.minutes,
                status,
                stage: session.map(|s| s.stage),
                last_score,
                key,
            })
        })
        .collect::<Result<_, ApiError>>()?;
    Ok(Json(DesignList {
        items,
        week: planned.week,
    }))
}

/// Roughly the score an attempt's rating stands for, for showing how the last one went.
fn score_of(rating: workshop_learning::Rating) -> f64 {
    match rating {
        workshop_learning::Rating::Again => 0.3,
        workshop_learning::Rating::Hard => 0.7,
        workshop_learning::Rating::Good => 0.9,
        workshop_learning::Rating::Easy => 1.0,
    }
}

#[derive(Serialize)]
struct StageInfo {
    id: Stage,
    name: &'static str,
    task: &'static str,
}

#[derive(Serialize)]
pub(super) struct DesignOpened {
    key: String,
    label: String,
    /// In Markdown.
    prompt: String,
    skills: Vec<String>,
    minutes: u32,
    source: Option<String>,
    /// The stages of a session, in order.
    stages: Vec<StageInfo>,
    /// Where the learner is, if they've started.
    session: Option<Session>,
    /// What the learner did last time, if they've done it before.
    previous: Option<String>,
}

/// A design prompt in the packs, with its pack and its key.
fn design<'a>(
    packs: &'a [Pack],
    pack: &str,
    item: &str,
) -> Result<(&'a Pack, String, &'a Item), ApiError> {
    let (pack, item) = find(packs, pack, item)?;
    if item.kind != Kind::Design {
        return Err(bad_request(format!(
            "{} isn't a design prompt",
            item.label()
        )));
    }
    Ok((pack, format!("{}/{}", pack.manifest.id, item.id), item))
}

fn opened(app: &Shared, key: String, item: &Item) -> ApiResult<DesignOpened> {
    let previous = app
        .learning
        .store()
        .attempts(&key)?
        .into_iter()
        .rev()
        .find_map(|attempt| attempt.response);
    Ok(Json(DesignOpened {
        session: app.design_sessions.get(&key)?,
        label: item.label(),
        prompt: item.prompt.clone(),
        skills: item.skills.clone(),
        minutes: item.minutes,
        source: item.source.clone(),
        stages: Stage::ALL
            .into_iter()
            .map(|stage| StageInfo {
                id: stage,
                name: stage.name(),
                task: stage.task(),
            })
            .collect(),
        previous,
        key,
    }))
}

/// A design prompt, and the learner's session with it, if they've started one. The rubric
/// isn't shown until it's been marked.
pub(super) async fn open(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
) -> ApiResult<DesignOpened> {
    let packs = packs(&app)?;
    let (_, key, item) = design(&packs, &pack, &item)?;
    opened(&app, key, item)
}

/// Starts a session with a design prompt, or carries on with the one started.
pub(super) async fn start(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
) -> ApiResult<DesignOpened> {
    let packs = packs(&app)?;
    let (_, key, item) = design(&packs, &pack, &item)?;
    if app.design_sessions.get(&key)?.is_none() {
        app.design_sessions.put(&key, &Session::new(now_ms()))?;
    }
    opened(&app, key, item)
}

/// Saves the learner's changes to a session, as they're made, and counts the time spent.
pub(super) async fn save(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Json(edit): Json<Edit>,
) -> ApiResult<Session> {
    let packs = packs(&app)?;
    let (_, key, _) = design(&packs, &pack, &item)?;
    let now = now_ms();
    let (session, spent) = app
        .design_sessions
        .change(&key, |session| {
            let spent = workshop_sessions::spent(session.updated_at, now);
            session.edit(edit, now)?;
            Ok(spent)
        })
        .map_err(|err| bad_request(format!("{err:#}")))?
        .ok_or_else(|| bad_request("Start the session before saving it."))?;
    app.learning.store().record_time(&key, now, spent)?;
    Ok(Json(session))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CoachBody {
    stage: Stage,
    /// The learner's answer to the coach's last questions, if they gave one.
    #[serde(default)]
    reply: Option<String>,
}

/// Has the coach ask follow-up questions about a stage, after the learner's reply to its last
/// ones, if they gave one. Both are saved in the session.
pub(super) async fn coach(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Json(body): Json<CoachBody>,
) -> ApiResult<Session> {
    let packs = packs(&app)?;
    let (pack, key, item) = design(&packs, &pack, &item)?;
    let now = now_ms();
    let reply = body
        .reply
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty());
    let (session, ()) = app
        .design_sessions
        .change(&key, |session| {
            if let Some(reply) = reply {
                session.say(body.stage, Speaker::Learner, reply, now)?;
            } else if body.stage > session.reached {
                Err(workshop_sessions::design::DesignError::NotReached(
                    body.stage,
                ))?;
            }
            Ok(())
        })
        .map_err(|err| bad_request(format!("{err:#}")))?
        .ok_or_else(|| bad_request("Start the session before asking the coach."))?;
    let system =
        crate::design::coach_system_prompt(pack.prompt_add_ons.get("tutor").map(String::as_str));
    let (runner, spec) = app.coach_target(system)?;
    let question = crate::design::ask_coach(runner, &spec, item, &session, body.stage)
        .await
        .map_err(|err| bad_request(format!("{err:#}")))?;
    let (session, ()) = app
        .design_sessions
        .change(&key, |session| {
            session.say(body.stage, Speaker::Coach, &question, now_ms())?;
            Ok(())
        })?
        .ok_or_else(|| bad_request("The session ended while the coach was asking."))?;
    Ok(Json(session))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct FinishBody {
    /// Made by the app, for the attempt this records.
    id: String,
}

/// Has the grader mark the whole session against the prompt's rubric, which counts as an
/// attempt, rated from the score, with what it finds in the mistake log; then ends the session.
pub(super) async fn finish(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Json(body): Json<FinishBody>,
) -> ApiResult<MarkedReply> {
    let packs = packs(&app)?;
    let (pack, key, item) = design(&packs, &pack, &item)?;
    let store = app.learning.store();
    if store.attempts(&key)?.iter().any(|a| a.id == body.id) {
        return Err(bad_request("That session has been marked already."));
    }
    let session = app
        .design_sessions
        .get(&key)?
        .ok_or_else(|| bad_request("There's no session to mark."))?;
    session
        .check_markable()
        .map_err(|err| bad_request(err.to_string()))?;
    let transcript = session.transcript();
    let error_types = crate::mistakes::error_types(&packs);
    let (runner, spec) =
        app.grader_target(pack.prompt_add_ons.get("grader").map(String::as_str))?;
    let marked = crate::grader::mark(
        runner,
        &spec,
        item,
        Work::Design,
        Answer::written(&transcript),
        &error_types,
    )
    .await
    .map_err(|err| bad_request(format!("{err:#}")))?;
    let now = now_ms();
    store.record_mistakes(&marked.mistakes(&body.id, &key, now))?;
    app.learning.record(
        &[Attempt {
            id: body.id,
            item: key.clone(),
            answered_at: now,
            duration_ms: workshop_sessions::spent(session.updated_at, now),
            rating: marked.rating(),
            response: Some(transcript),
            seed: None,
        }],
        now,
    )?;
    app.design_sessions.remove(&key)?;
    let due = store.schedules()?.get(&key).map(|schedule| {
        store
            .scheduler()
            .due(schedule, app.config.learning.desired_retention)
    });
    let Content::Design { rubric, .. } = &item.content else {
        unreachable!("design() only finds design prompts");
    };
    Ok(Json(MarkedReply {
        rubric: rubric.clone(),
        marked,
        due,
    }))
}

#[cfg(all(test, unix))]
mod tests {
    use axum::Router;
    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::{StatusCode, header};

    use crate::server::testing::{fake_discussion_model, send, test_app_in};

    async fn json(response: axum::response::Response) -> serde_json::Value {
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(status.is_success(), "{status}: {value}");
        value
    }

    fn request(method: &str, path: &str, body: Option<serde_json::Value>) -> Request {
        Request::builder()
            .method(method)
            .uri(path)
            .header(header::COOKIE, "workshop_token=secret")
            .header(header::CONTENT_TYPE, "application/json")
            .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
            .unwrap()
    }

    const MARKED: &str = r#"{"score": 0.9, "points": [], "findings": [{"error_type": "missed-edge-case", "detail": "Nothing on expiry"}], "feedback": "Good."}"#;

    fn app(dir: &std::path::Path) -> Router {
        std::fs::write(dir.join("coach.txt"), "What happens when a code is reused?").unwrap();
        std::fs::write(dir.join("mark.json"), MARKED).unwrap();
        let model = fake_discussion_model(
            dir,
            &[
                ("follow-up questions", "coach.txt"),
                ("<work>", "mark.json"),
            ],
        );
        test_app_in(dir, &model)
    }

    const ITEM: &str = "/api/design/sample/link-shortener";

    #[tokio::test]
    async fn works_through_a_design_in_stages_with_the_coach_then_marks_it() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        let opened = json(send(&router, request("GET", ITEM, None)).await).await;
        assert_eq!(opened["session"], serde_json::Value::Null);
        assert_eq!(opened["stages"].as_array().unwrap().len(), 5);
        assert_eq!(opened["stages"][0]["name"], "Clarify the requirements");
        // Nothing to save, or ask about, before it's started.
        let early = send(
            &router,
            request(
                "PUT",
                &format!("{ITEM}/session"),
                Some(serde_json::json!({ "stage": "requirements" })),
            ),
        )
        .await;
        assert_eq!(early.status(), StatusCode::BAD_REQUEST);

        let started =
            json(send(&router, request("POST", &format!("{ITEM}/start"), None)).await).await;
        assert_eq!(started["session"]["stage"], "requirements");
        let edit = serde_json::json!({
            "stage": "requirements",
            "notes": { "requirements": "Shorten links; open them fast." },
        });
        json(
            send(
                &router,
                request("PUT", &format!("{ITEM}/session"), Some(edit)),
            )
            .await,
        )
        .await;
        let coached = json(
            send(
                &router,
                request(
                    "POST",
                    &format!("{ITEM}/coach"),
                    Some(serde_json::json!({ "stage": "requirements" })),
                ),
            )
            .await,
        )
        .await;
        let turns = &coached["work"]["requirements"]["turns"];
        assert_eq!(turns[0]["speaker"], "coach");
        assert_eq!(turns[0]["text"], "What happens when a code is reused?");
        let replied = json(
            send(
                &router,
                request(
                    "POST",
                    &format!("{ITEM}/coach"),
                    Some(
                        serde_json::json!({ "stage": "requirements", "reply": "Codes never are." }),
                    ),
                ),
            )
            .await,
        )
        .await;
        let turns = replied["work"]["requirements"]["turns"].as_array().unwrap();
        assert_eq!(turns.len(), 3);
        assert_eq!(turns[1]["speaker"], "learner");

        // A stage can't be skipped, or asked about before it's reached.
        let skipped = send(
            &router,
            request(
                "PUT",
                &format!("{ITEM}/session"),
                Some(serde_json::json!({ "stage": "outline" })),
            ),
        )
        .await;
        assert_eq!(skipped.status(), StatusCode::BAD_REQUEST);
        let ahead = send(
            &router,
            request(
                "POST",
                &format!("{ITEM}/coach"),
                Some(serde_json::json!({ "stage": "trade_offs" })),
            ),
        )
        .await;
        assert_eq!(ahead.status(), StatusCode::BAD_REQUEST);

        let edit = serde_json::json!({
            "stage": "outline",
            "notes": { "requirements": "Shorten links; open them fast.", "scale": "100 opens a second" },
            "components": [{ "name": "Store", "role": "Keeps codes" }],
        });
        let saved = send(
            &router,
            request("PUT", &format!("{ITEM}/session"), Some(edit)),
        )
        .await;
        assert_eq!(saved.status(), StatusCode::BAD_REQUEST);
        let edit = serde_json::json!({
            "stage": "scale",
            "notes": { "requirements": "Shorten links; open them fast.", "scale": "100 opens a second" },
            "components": [{ "name": "Store", "role": "Keeps codes" }],
        });
        json(
            send(
                &router,
                request("PUT", &format!("{ITEM}/session"), Some(edit)),
            )
            .await,
        )
        .await;

        // Left part-way through, it's what Continue offers when there's a while.
        let home = json(
            send(
                &router,
                request("GET", "/api/home?utc_offset=0&time=a_while", None),
            )
            .await,
        )
        .await;
        assert_eq!(home["continue"]["priority"], "unfinished");
        assert_eq!(
            home["continue"]["reason"],
            "Where you left off: estimate the scale"
        );
        let list =
            json(send(&router, request("GET", "/api/design?utc_offset=0", None)).await).await;
        let listed = list["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["key"] == "sample/link-shortener")
            .unwrap();
        assert_eq!(listed["status"], "in_progress");
        assert_eq!(listed["stage"], "scale");

        let id = "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a61";
        let marked = json(
            send(
                &router,
                request(
                    "POST",
                    &format!("{ITEM}/finish"),
                    Some(serde_json::json!({ "id": id })),
                ),
            )
            .await,
        )
        .await;
        assert_eq!(marked["marked"]["score"], 0.9);
        assert_eq!(marked["rubric"].as_array().unwrap().len(), 5);
        assert!(marked["due"].as_i64().is_some());
        // The session's over, and what was done is kept with the attempt.
        let opened = json(send(&router, request("GET", ITEM, None)).await).await;
        assert_eq!(opened["session"], serde_json::Value::Null);
        let previous = opened["previous"].as_str().unwrap();
        assert!(
            previous
                .contains("Coach: What happens when a code is reused?\nLearner: Codes never are.")
        );
        assert!(previous.contains("## Estimate the scale\n\n100 opens a second"));
        let log = json(send(&router, request("GET", "/api/mistakes", None)).await).await;
        assert_eq!(log["mistakes"][0]["detail"], "Nothing on expiry");
        let again = send(
            &router,
            request(
                "POST",
                &format!("{ITEM}/finish"),
                Some(serde_json::json!({ "id": id })),
            ),
        )
        .await;
        assert_eq!(again.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn wont_mark_a_session_with_nothing_in_it() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        json(send(&router, request("POST", &format!("{ITEM}/start"), None)).await).await;
        let empty = send(
            &router,
            request(
                "POST",
                &format!("{ITEM}/finish"),
                Some(serde_json::json!({ "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a62" })),
            ),
        )
        .await;
        assert_eq!(empty.status(), StatusCode::BAD_REQUEST);
        let islands = send(&router, request("GET", "/api/design/sample/islands", None)).await;
        assert_eq!(islands.status(), StatusCode::BAD_REQUEST);
    }
}
