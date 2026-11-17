//! The System design track: its prompts, each worked through as a design session in stages,
//! with the coach answering the learner's questions from the prompt's brief and then asking
//! follow-up questions, and marked as a whole by the grader at the end. The brief is never
//! sent to the app until the session's been marked.

use axum::Json;
use axum::extract::{Path, Query, State};
use serde::{Deserialize, Serialize};
use workshop_learning::Attempt;
use workshop_pack::{Content, Item, Kind, Pack};
use workshop_provider::{CallSpec, ProviderRunner};
use workshop_sessions::Speaker;
use workshop_sessions::brief::Brief;
use workshop_sessions::design::{Component, Edit, Session, Stage, StageWork};

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
            } else if plan.is_some_and(|p| p.is_new(&key)) {
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
    /// Whether the learner asks the coach at this stage, rather than the coach asking them.
    learner_asks: bool,
}

/// A session as the app sees it: everything but the brief, which the learner finds out by
/// asking.
#[derive(Serialize)]
pub(super) struct SessionView {
    stage: Stage,
    reached: Stage,
    work: std::collections::BTreeMap<Stage, StageWork>,
    components: Vec<Component>,
    deep_dive: Option<String>,
    started_at: i64,
    updated_at: i64,
}

impl From<Session> for SessionView {
    fn from(session: Session) -> Self {
        let Session {
            stage,
            reached,
            work,
            components,
            deep_dive,
            brief: _,
            started_at,
            updated_at,
        } = session;
        Self {
            stage,
            reached,
            work,
            components,
            deep_dive,
            started_at,
            updated_at,
        }
    }
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
    session: Option<SessionView>,
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
        session: app.design_sessions.get(&key)?.map(SessionView::from),
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
                learner_asks: stage.learner_asks(),
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

/// The coach, with the pack's tutor add-on.
fn coach<'a>(app: &'a Shared, pack: &Pack) -> Result<(&'a ProviderRunner, CallSpec), ApiError> {
    let system =
        crate::design::coach_system_prompt(pack.prompt_add_ons.get("tutor").map(String::as_str));
    Ok(app.coach_target(system)?)
}

/// Starts a session with a design prompt, with its brief, made up by the coach if the prompt
/// has none, or carries on with the one started.
pub(super) async fn start(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
) -> ApiResult<DesignOpened> {
    let packs = packs(&app)?;
    let (pack, key, item) = design(&packs, &pack, &item)?;
    if app.design_sessions.get(&key)?.is_none() {
        let brief = new_brief(&app, pack, item).await?;
        app.design_sessions
            .put_new(&key, Session::new(brief, now_ms()))?;
    }
    opened(&app, key, item)
}

/// A brief for a new session or round of a design prompt: its own, or one the coach makes up.
pub(super) async fn new_brief(app: &Shared, pack: &Pack, item: &Item) -> Result<Brief, ApiError> {
    let (runner, spec) = coach(app, pack)?;
    crate::design::brief_for(runner, &spec, item)
        .await
        .map_err(|err| bad_request(format!("{err:#}")))
}

/// Gives a session started before design prompts had briefs one, for the coach to answer from.
async fn ensure_brief(app: &Shared, pack: &Pack, key: &str, item: &Item) -> Result<(), ApiError> {
    let session = app
        .design_sessions
        .get(key)?
        .ok_or_else(|| bad_request("Start the session before asking the coach."))?;
    if session.brief.is_some() {
        return Ok(());
    }
    let brief = new_brief(app, pack, item).await?;
    app.design_sessions.change(key, |session| {
        session.brief.get_or_insert(brief);
        Ok(())
    })?;
    Ok(())
}

/// Saves the learner's changes to a session, as they're made, and counts the time spent.
pub(super) async fn save(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Json(edit): Json<Edit>,
) -> ApiResult<SessionView> {
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
    Ok(Json(session.into()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CoachBody {
    stage: Stage,
    /// At a stage where the learner asks, their question. At the others, their answer to the
    /// coach's last questions, if they gave one.
    #[serde(default)]
    reply: Option<String>,
}

/// Talks with the coach at a stage, saving what both said in the session. Where the learner
/// asks, the coach answers their question from the brief, or the one left unanswered if they
/// didn't ask another. At the other stages, it asks follow-up questions, after the learner's
/// reply to its last ones, if they gave one.
pub(super) async fn coach_turn(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Json(body): Json<CoachBody>,
) -> ApiResult<SessionView> {
    let packs = packs(&app)?;
    let (pack, key, item) = design(&packs, &pack, &item)?;
    let stage = body.stage;
    let said = body
        .reply
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty());
    if stage.learner_asks() {
        ensure_brief(&app, pack, &key, item).await?;
    }
    let now = now_ms();
    let (session, ()) = app
        .design_sessions
        .change(&key, |session| {
            if stage > session.reached {
                Err(workshop_sessions::design::DesignError::NotReached(stage))?;
            }
            if let Some(said) = said {
                session.say(stage, Speaker::Learner, said, now)?;
            } else if stage.learner_asks()
                && !session
                    .turns(stage)
                    .last()
                    .is_some_and(|turn| turn.speaker == Speaker::Learner)
            {
                anyhow::bail!("Ask the coach something first.");
            }
            Ok(())
        })
        .map_err(|err| bad_request(format!("{err:#}")))?
        .ok_or_else(|| bad_request("Start the session before asking the coach."))?;
    let (runner, spec) = coach(&app, pack)?;
    let session = if stage.learner_asks() {
        let brief = session
            .brief
            .as_ref()
            .ok_or_else(|| bad_request("The session has no brief to answer from."))?;
        let answer = crate::design::answer(runner, &spec, item, brief, &session, stage)
            .await
            .map_err(|err| bad_request(format!("{err:#}")))?;
        app.design_sessions.change(&key, |session| {
            session.answered(stage, &answer.text, answer.settled.as_deref(), now_ms())?;
            Ok(())
        })?
    } else {
        let question = crate::design::ask_coach(runner, &spec, item, &session, stage)
            .await
            .map_err(|err| bad_request(format!("{err:#}")))?;
        app.design_sessions.change(&key, |session| {
            session.say(stage, Speaker::Coach, &question, now_ms())?;
            Ok(())
        })?
    };
    let (session, ()) =
        session.ok_or_else(|| bad_request("The session ended while the coach was replying."))?;
    Ok(Json(session.into()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct FinishBody {
    /// Made by the app, for the attempt this records.
    id: String,
}

#[derive(Serialize)]
pub(super) struct DesignMarked {
    #[serde(flatten)]
    marked: MarkedReply,
    /// The brief the learner's questions were answered from, with what was settled along the
    /// way, now it can be shown.
    brief: Option<String>,
}

/// Has the grader mark the whole session against the prompt's rubric, and on what the learner
/// asked, against the brief. It counts as an attempt, rated from the score, with what it finds,
/// and the requirements missed, in the mistake log; then the session ends.
pub(super) async fn finish(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Json(body): Json<FinishBody>,
) -> ApiResult<DesignMarked> {
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
    let brief = session.brief.as_ref().map(Brief::full);
    let error_types = crate::mistakes::error_types(&packs);
    let (runner, spec) =
        app.grader_target(pack.prompt_add_ons.get("grader").map(String::as_str))?;
    let marked = crate::grader::mark(
        runner,
        &spec,
        item,
        Work::Design,
        Answer {
            brief: brief.as_deref(),
            ..Answer::written(&transcript)
        },
        &error_types,
    )
    .await
    .map_err(|err| bad_request(format!("{err:#}")))?;
    let now = now_ms();
    let findings = marked.mistakes(&body.id, &key, now);
    app.learning.record_marked(
        Attempt {
            id: body.id,
            item: key.clone(),
            answered_at: now,
            duration_ms: workshop_sessions::spent(session.updated_at, now),
            rating: marked.rating(),
            response: Some(transcript),
            seed: None,
        },
        &findings,
        now,
    )?;
    app.design_sessions.remove(&key)?;
    crate::tracks::done_long(
        &app.paths.data_dir,
        workshop_tracks::TrackId::SystemDesign,
        now,
    )?;
    let due = store.schedules()?.get(&key).map(|schedule| {
        store
            .scheduler()
            .due(schedule, app.config.learning.desired_retention)
    });
    let Content::Design { rubric, .. } = &item.content else {
        unreachable!("design() only finds design prompts");
    };
    Ok(Json(DesignMarked {
        marked: MarkedReply {
            rubric: rubric.clone(),
            marked,
            due,
        },
        brief,
    }))
}

#[cfg(all(test, unix))]
mod tests {
    use axum::Router;
    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::{StatusCode, header};
    use workshop_sessions::brief::BriefSource;
    use workshop_sessions::design::Session;

    use crate::server::testing::{fake_script_model, send, test_app_in};

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

    async fn post(router: &Router, path: &str, body: serde_json::Value) -> serde_json::Value {
        json(send(router, request("POST", path, Some(body))).await).await
    }

    /// Marked with the brief, the grader says what the learner missed finding out.
    const MARKED: &str = r#"{"score": 0.9, "points": [], "findings": [{"error_type": "missed-edge-case", "detail": "Nothing on expiry"}], "feedback": "Good.", "questioning": {"found": ["How long links are kept"], "missed": ["Links reported as malware must stop working"], "assumed": []}}"#;

    /// A server learning from a copy of the sample pack, whose rate limiter has no brief of its
    /// own, with a stand-in coach and grader. The coach makes up a brief whose peak is a
    /// thousand requests a second for each brief it's made, and answers a question with the
    /// first line of the brief holding its last word, or settles what it doesn't cover.
    fn app(dir: &std::path::Path) -> Router {
        let pack = dir.join("pack");
        crate::pack_files::testing::sample_pack_copy(&pack);
        let limiter = pack.join("items/design/rate-limiter.md");
        let text = std::fs::read_to_string(&limiter).unwrap();
        let (without, _) = text.split_once("\n## Brief\n").unwrap();
        std::fs::write(&limiter, format!("{without}\n")).unwrap();
        std::fs::write(dir.join("mark.json"), MARKED).unwrap();
        let briefs = dir.join("briefs");
        let mark = dir.join("mark.json");
        let script = format!(
            r#"prompt=$(cat)
last=$(printf '%s\n' "$prompt" | grep '^Learner: ' | tail -n 1)
case "$prompt" in
  *'Write the brief for this design question.'*)
    echo brief >> '{briefs}'
    n=$(wc -l < '{briefs}' | tr -d ' ')
    printf -- '- Who uses it: shops selling online\n- Peak: %s000 requests a second\n' "$n" ;;
  *'Answer their last question.'*)
    word=${{last##* }}
    word=${{word%\?}}
    line=$(printf '%s\n' "$prompt" | sed -n '/^<brief>$/,/^<\/brief>$/p' | grep -m 1 -F -- "$word")
    if [ -n "$line" ]; then
      printf '{{"answer": "%s", "settled": null}}' "$line"
    else
      printf '{{"answer": "They are blue.", "settled": "Codes are shown in blue."}}'
    fi ;;
  *'follow-up questions'*) echo 'What happens when a code is reused?' ;;
  *'<brief>'*'<work>'*) cat '{mark}' ;;
  *) echo 'The fake model has no reply for this prompt' >&2; exit 1 ;;
esac
"#,
            briefs = briefs.display(),
            mark = mark.display(),
        );
        let model = fake_script_model(dir, &script);
        test_app_in(
            dir,
            &format!(
                "{model}\n[learning]\npacks = [{:?}]\n",
                pack.display().to_string()
            ),
        )
    }

    const ITEM: &str = "/api/design/sample/link-shortener";
    const LIMITER: &str = "/api/design/sample/rate-limiter";

    /// A part of the link shortener's brief that's never asked about.
    const UNASKED: &str = "malware";

    fn session_on_disk(dir: &std::path::Path, item: &str) -> Session {
        let path = dir.join(format!("data/design/sessions/sample/{item}.json"));
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[tokio::test]
    async fn works_through_a_design_in_stages_with_the_coach_then_marks_it() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        let opened = json(send(&router, request("GET", ITEM, None)).await).await;
        assert_eq!(opened["session"], serde_json::Value::Null);
        assert_eq!(opened["stages"].as_array().unwrap().len(), 5);
        assert_eq!(opened["stages"][0]["name"], "Clarify the requirements");
        // The learner asks while finding out the requirements and the scale, then the coach.
        let asks: Vec<bool> = opened["stages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|stage| stage["learner_asks"].as_bool().unwrap())
            .collect();
        assert_eq!(asks, [true, true, false, false, false]);
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

        let started = post(&router, &format!("{ITEM}/start"), serde_json::json!({})).await;
        assert_eq!(started["session"]["stage"], "requirements");
        // The brief is kept with the session, and never sent to the app.
        assert!(!started.to_string().contains(UNASKED));
        assert!(started["session"].get("brief").is_none());
        assert_eq!(
            session_on_disk(dir.path(), "link-shortener")
                .brief
                .unwrap()
                .source,
            BriefSource::Pack
        );
        let edit = serde_json::json!({
            "stage": "requirements",
            "notes": { "requirements": "Shorten links; open them fast." },
        });
        let saved = json(
            send(
                &router,
                request("PUT", &format!("{ITEM}/session"), Some(edit)),
            )
            .await,
        )
        .await;
        assert!(!saved.to_string().contains(UNASKED));
        // Here the learner asks, so there must be a question.
        let unasked = send(
            &router,
            request(
                "POST",
                &format!("{ITEM}/coach"),
                Some(serde_json::json!({ "stage": "requirements" })),
            ),
        )
        .await;
        assert_eq!(unasked.status(), StatusCode::BAD_REQUEST);
        let answered = post(
            &router,
            &format!("{ITEM}/coach"),
            serde_json::json!({ "stage": "requirements", "reply": "How long are links kept?" }),
        )
        .await;
        let turns = &answered["work"]["requirements"]["turns"];
        assert_eq!(turns[0]["speaker"], "learner");
        assert_eq!(turns[0]["text"], "How long are links kept?");
        assert_eq!(turns[1]["speaker"], "coach");
        let answer = turns[1]["text"].as_str().unwrap();
        assert!(answer.contains("Links are kept for five years"), "{answer}");
        assert!(!answered.to_string().contains(UNASKED));

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

        let notes = serde_json::json!({ "requirements": "Shorten links; open them fast.", "scale": "100 opens a second" });
        for stage in ["scale", "outline"] {
            let edit = serde_json::json!({
                "stage": stage,
                "notes": notes,
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
        }
        // From the outline, the coach asks the learner, and follows up on their answer.
        let coached = post(
            &router,
            &format!("{ITEM}/coach"),
            serde_json::json!({ "stage": "outline" }),
        )
        .await;
        let turns = &coached["work"]["outline"]["turns"];
        assert_eq!(turns[0]["speaker"], "coach");
        assert_eq!(turns[0]["text"], "What happens when a code is reused?");
        let replied = post(
            &router,
            &format!("{ITEM}/coach"),
            serde_json::json!({ "stage": "outline", "reply": "Codes never are." }),
        )
        .await;
        let turns = replied["work"]["outline"]["turns"].as_array().unwrap();
        assert_eq!(turns.len(), 3);
        assert_eq!(turns[1]["speaker"], "learner");

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
            "Where you left off: outline the design"
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
        assert_eq!(listed["stage"], "outline");
        let reopened = json(send(&router, request("GET", ITEM, None)).await).await;
        assert!(!reopened.to_string().contains(UNASKED));

        let id = "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a61";
        let marked = post(
            &router,
            &format!("{ITEM}/finish"),
            serde_json::json!({ "id": id }),
        )
        .await;
        assert_eq!(marked["marked"]["score"], 0.9);
        // The rubric is the prompt's own; what was asked is marked besides.
        assert_eq!(marked["rubric"].as_array().unwrap().len(), 5);
        assert_eq!(
            marked["marked"]["questioning"]["missed"][0],
            "Links reported as malware must stop working"
        );
        assert!(marked["due"].as_i64().is_some());
        // Once it's marked, the brief is shown.
        assert!(marked["brief"].as_str().unwrap().contains(UNASKED));
        // The session's over, and what was done is kept with the attempt.
        let opened = json(send(&router, request("GET", ITEM, None)).await).await;
        assert_eq!(opened["session"], serde_json::Value::Null);
        let previous = opened["previous"].as_str().unwrap();
        assert!(previous.contains("Learner: How long are links kept?\nCoach: - Storage:"));
        assert!(
            previous
                .contains("Coach: What happens when a code is reused?\nLearner: Codes never are.")
        );
        assert!(previous.contains("## Estimate the scale\n\n100 opens a second"));
        let log = json(send(&router, request("GET", "/api/mistakes", None)).await).await;
        let mistakes = log["mistakes"].as_array().unwrap();
        assert!(mistakes.iter().any(|m| m["detail"] == "Nothing on expiry"));
        // The requirement missed is in the log as one.
        let missed = mistakes
            .iter()
            .find(|m| m["detail"] == "Didn't find out: Links reported as malware must stop working")
            .unwrap();
        assert_eq!(missed["suggested"], "missed-requirement");
        // Long items take turns: after a design session, a timed round.
        let home = json(
            send(
                &router,
                request("GET", "/api/home?utc_offset=0&time=a_while", None),
            )
            .await,
        )
        .await;
        assert_eq!(home["continue"]["track"], "rounds");
        assert_eq!(home["continue"]["long"], true);
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
    async fn makes_up_a_brief_for_a_prompt_without_one_and_keeps_it() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        let briefs = || {
            std::fs::read_to_string(dir.path().join("briefs"))
                .map_or(0, |text| text.lines().count())
        };
        let started = post(&router, &format!("{LIMITER}/start"), serde_json::json!({})).await;
        assert_eq!(briefs(), 1);
        assert!(!started.to_string().contains("Peak"));
        let kept = session_on_disk(dir.path(), "rate-limiter").brief.unwrap();
        assert_eq!(kept.source, BriefSource::Coach);
        assert!(kept.text.contains("- Peak: 1000 requests a second"));
        // Opened or started again, as after a reload, it's the same brief.
        json(send(&router, request("GET", LIMITER, None)).await).await;
        post(&router, &format!("{LIMITER}/start"), serde_json::json!({})).await;
        let ask = |question: &'static str| {
            let router = router.clone();
            async move {
                let session = post(
                    &router,
                    &format!("{LIMITER}/coach"),
                    serde_json::json!({ "stage": "requirements", "reply": question }),
                )
                .await;
                let turns = session["work"]["requirements"]["turns"].as_array().unwrap();
                turns.last().unwrap()["text"].as_str().unwrap().to_owned()
            }
        };
        assert_eq!(
            ask("What's the Peak").await,
            "- Peak: 1000 requests a second"
        );
        assert_eq!(ask("And the Peak").await, "- Peak: 1000 requests a second");
        assert_eq!(briefs(), 1);
        // What the brief doesn't cover is settled, and kept with it for the rest of the session.
        assert_eq!(ask("What colour are the codes").await, "They are blue.");
        let kept = session_on_disk(dir.path(), "rate-limiter").brief.unwrap();
        assert_eq!(kept.added, ["Codes are shown in blue."]);
        assert!(kept.text.contains("1000"));

        // A session started before prompts had briefs is given one when the learner first asks.
        let path = dir
            .path()
            .join("data/design/sessions/sample/rate-limiter.json");
        let mut saved: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        saved.as_object_mut().unwrap().remove("brief");
        std::fs::write(&path, saved.to_string()).unwrap();
        assert_eq!(
            ask("Now what's the Peak").await,
            "- Peak: 2000 requests a second"
        );
        assert_eq!(briefs(), 2);
    }

    #[tokio::test]
    async fn wont_mark_a_session_with_nothing_in_it() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        post(&router, &format!("{ITEM}/start"), serde_json::json!({})).await;
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
