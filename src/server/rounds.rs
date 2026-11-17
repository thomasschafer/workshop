//! Timed rounds with the examiner: starting one, keeping its clock while the app has it open,
//! talking with the examiner, and the grader marking it when it ends.

use axum::Json;
use axum::extract::{Path, Query, State};
use serde::{Deserialize, Serialize};
use workshop_learning::Attempt;
use workshop_pack::{Case, Content, ExaminerStyle, Item, Kind, Pack};
use workshop_sessions::Turn;
use workshop_sessions::round::{Clock, Ending, Round, minutes_for};
use workshop_tracks::Priority;

use super::error::{ApiError, ApiResult, bad_request};
use super::grading::{find, packs};
use super::learning::Where;
use super::state::Shared;
use crate::grader::{Answer, Marked, Work};
use crate::learning::now_ms;

#[derive(Serialize)]
pub(super) struct StyleInfo {
    id: String,
    name: String,
    description: String,
}

impl From<&ExaminerStyle> for StyleInfo {
    fn from(style: &ExaminerStyle) -> Self {
        Self {
            id: style.id.clone(),
            name: style.name.clone(),
            description: style.description.clone(),
        }
    }
}

#[derive(Serialize)]
pub(super) struct Overview {
    /// What Continue would start a round of, and why, if there's anything.
    suggested: Option<Suggested>,
    /// Rounds under way, or over and waiting to be marked.
    under_way: Vec<Listed>,
    /// Every item a round can be made of.
    items: Vec<Listed>,
}

#[derive(Serialize)]
struct Suggested {
    key: String,
    reason: String,
    priority: Priority,
}

#[derive(Serialize)]
struct Listed {
    key: String,
    label: String,
    kind: Kind,
    /// How long a round of it lasts.
    minutes: u32,
    /// For a round under way, how much of the clock is left, and how it ended if it has.
    remaining_ms: Option<i64>,
    ended: Option<Ending>,
}

fn listed(key: String, item: &Item, round: Option<&Round>, now: i64) -> Listed {
    Listed {
        label: item.label(),
        kind: item.kind,
        minutes: round.map_or_else(|| minutes_for(item.minutes), |r| r.minutes),
        remaining_ms: round.map(|r| r.clock().remaining_ms),
        ended: round.and_then(|r| r.ending_at(now)),
        key,
    }
}

/// The Timed rounds track: what a round could be made of, and the rounds under way.
pub(super) async fn overview(
    State(app): State<Shared>,
    Query(at): Query<Where>,
) -> ApiResult<Overview> {
    let planned = app.learning.planned(at.clock()?)?;
    let rounds = app.rounds.all()?;
    let items: Vec<(String, &Item)> = crate::rounds::items(&planned).collect();
    let now = now_ms();
    let under_way = items
        .iter()
        .filter_map(|(key, item)| Some(listed(key.clone(), item, Some(rounds.get(key)?), now)))
        .collect();
    Ok(Json(Overview {
        suggested: crate::rounds::suggest(&planned).map(|(key, priority, reason)| Suggested {
            key,
            reason,
            priority,
        }),
        under_way,
        items: items
            .into_iter()
            .map(|(key, item)| listed(key, item, None, now))
            .collect(),
    }))
}

#[derive(Serialize)]
pub(super) struct Opened {
    key: String,
    label: String,
    kind: Kind,
    /// In Markdown.
    prompt: String,
    source: Option<String>,
    /// A coding problem's examples, to work from.
    examples: Vec<Case>,
    /// How long a round of it lasts.
    minutes: u32,
    /// The styles the examiner can take, from the item's pack.
    styles: Vec<StyleInfo>,
    /// The round, if it's been started.
    round: Option<RoundView>,
}

#[derive(Serialize)]
struct RoundView {
    style: Option<StyleInfo>,
    clock: Clock,
    work: String,
    turns: Vec<Turn>,
    /// Whether the learner has come back after a gap, which the clock didn't count.
    returned: bool,
    ended: Option<Ending>,
}

/// A roundable item in the packs, with its pack and key.
fn roundable<'a>(
    packs: &'a [Pack],
    pack: &str,
    item: &str,
) -> Result<(&'a Pack, String, &'a Item), ApiError> {
    let (pack, item) = find(packs, pack, item)?;
    if !crate::examiner::can_round(item) {
        return Err(bad_request(format!(
            "{} can't be a timed round: only coding problems, probability questions and design prompts can",
            item.label()
        )));
    }
    Ok((pack, format!("{}/{}", pack.manifest.id, item.id), item))
}

fn style<'a>(pack: &'a Pack, round: &Round) -> Option<&'a ExaminerStyle> {
    let id = round.style.as_deref()?;
    pack.examiner_styles.iter().find(|s| s.id == id)
}

fn opened(pack: &Pack, key: String, item: &Item, round: Option<Round>) -> Opened {
    let examples = match &item.content {
        Content::Coding(coding) => coding.examples.clone(),
        _ => Vec::new(),
    };
    Opened {
        label: item.label(),
        kind: item.kind,
        prompt: item.prompt.clone(),
        source: item.source.clone(),
        examples,
        minutes: round
            .as_ref()
            .map_or_else(|| minutes_for(item.minutes), |r| r.minutes),
        styles: pack.examiner_styles.iter().map(StyleInfo::from).collect(),
        round: round.map(|round| RoundView {
            style: style(pack, &round).map(StyleInfo::from),
            clock: round.clock(),
            work: round.work,
            turns: round.turns,
            returned: round.returned,
            ended: round.ended,
        }),
        key,
    }
}

/// Notes that the app has a round open, running its clock, and counts the time towards the
/// week. Returns the round as it now is.
fn seen(
    app: &Shared,
    key: &str,
    change: impl FnOnce(&mut Round, i64) -> anyhow::Result<()>,
) -> Result<Option<Round>, ApiError> {
    let now = now_ms();
    let changed = app
        .rounds
        .change(key, |round| {
            let before = round.used_ms;
            round.seen(now);
            change(round, now)?;
            Ok(round.used_ms - before)
        })
        .map_err(|err| bad_request(format!("{err:#}")))?;
    let Some((round, spent)) = changed else {
        return Ok(None);
    };
    if spent > 0 {
        app.learning.store().record_time(key, now, spent)?;
    }
    Ok(Some(round))
}

/// An item to make a round of, and the round under way, if there is one, which opening runs
/// the clock of.
pub(super) async fn open(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
) -> ApiResult<Opened> {
    let packs = packs(&app)?;
    let (pack, key, item) = roundable(&packs, &pack, &item)?;
    let round = seen(&app, &key, |_, _| Ok(()))?;
    Ok(Json(opened(pack, key, item, round)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct StartBody {
    /// The examiner's style, from the item's pack.
    #[serde(default)]
    style: Option<String>,
}

/// Starts a round, with the clock running from now, or carries on with the one under way.
pub(super) async fn start(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Json(body): Json<StartBody>,
) -> ApiResult<Opened> {
    let packs = packs(&app)?;
    let (pack, key, item) = roundable(&packs, &pack, &item)?;
    if let Some(id) = &body.style
        && !pack.examiner_styles.iter().any(|s| s.id == *id)
    {
        return Err(bad_request(format!(
            "{} has no examiner style {id:?}",
            pack.manifest.name
        )));
    }
    let round = match seen(&app, &key, |_, _| Ok(()))? {
        Some(round) => round,
        None => {
            let round = Round::new(item.minutes, body.style, now_ms());
            app.rounds.put(&key, &round)?;
            round
        }
    };
    Ok(Json(opened(pack, key, item, Some(round))))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct BeatBody {
    /// The learner's working as it is now.
    work: String,
}

#[derive(Serialize)]
pub(super) struct Beat {
    clock: Clock,
    ended: Option<Ending>,
}

/// The app saying the round is still open, every few seconds, with the learner's working. Once
/// the round's over, the working is no longer saved.
pub(super) async fn beat(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Json(body): Json<BeatBody>,
) -> ApiResult<Beat> {
    let packs = packs(&app)?;
    let (_, key, _) = roundable(&packs, &pack, &item)?;
    let round = seen(&app, &key, |round, now| {
        if round.ended.is_none() {
            round.save_work(&body.work, now)?;
        }
        Ok(())
    })?
    .ok_or_else(|| bad_request("There's no round of that under way."))?;
    Ok(Json(Beat {
        clock: round.clock(),
        ended: round.ended,
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SayBody {
    text: String,
    work: String,
}

/// Says something to the examiner, with the working as it is, and gets its reply. Both are
/// saved in the round.
pub(super) async fn say(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Json(body): Json<SayBody>,
) -> ApiResult<Opened> {
    if body.text.trim().is_empty() {
        return Err(bad_request("Say something to the examiner first."));
    }
    let packs = packs(&app)?;
    let (pack, key, item) = roundable(&packs, &pack, &item)?;
    let round = seen(&app, &key, |round, now| {
        round.save_work(&body.work, now)?;
        round.say(&body.text, now)?;
        Ok(())
    })?
    .ok_or_else(|| bad_request("There's no round of that under way."))?;
    let system = crate::examiner::system_prompt(
        pack.prompt_add_ons.get("examiner").map(String::as_str),
        style(pack, &round),
    );
    let (runner, spec) = app.coach_target(system)?;
    let reply = crate::examiner::reply(runner, &spec, item, &round)
        .await
        .map_err(|err| bad_request(format!("{err:#}")))?;
    let (round, ()) = app
        .rounds
        .change(&key, |round| {
            round.examiner_said(&reply, now_ms());
            Ok(())
        })?
        .ok_or_else(|| bad_request("The round was marked while the examiner was replying."))?;
    Ok(Json(opened(pack, key, item, Some(round))))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct EndBody {
    /// Made by the app, for the attempt this records, if it records one.
    id: String,
    /// The learner's working as it is now, saved if the round is still on.
    #[serde(default)]
    work: Option<String>,
}

#[derive(Serialize)]
pub(super) struct Ended {
    ending: Ending,
    marked: Marked,
    /// The rubric's points, now it's been marked against them.
    rubric: Vec<String>,
    /// When the item comes back, if the round counted as an attempt.
    due: Option<i64>,
}

/// What the grader is told about how a round went.
fn note(round: &Round, ending: Ending) -> String {
    let used = round.clock().used_ms / 60_000;
    let of = round.minutes;
    match ending {
        Ending::TimeUp => format!("This was a timed round of {of} minutes, which ran out."),
        Ending::Finished => {
            format!("This was a timed round of {of} minutes, which the learner ended after {used}.")
        }
        Ending::Interrupted => format!(
            "This was a timed round of {of} minutes, cut short after {used} when the learner was called away. Mark what they did, and don't count what they didn't reach as a mistake."
        ),
    }
}

/// Ends a round, if it's still on, and has the grader mark it against the item's rubric. What
/// it finds goes in the mistake log, and the round counts as an attempt, rated from the score,
/// unless it was cut short by an interruption. Then the round's gone.
pub(super) async fn end(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Json(body): Json<EndBody>,
) -> ApiResult<Ended> {
    let packs = packs(&app)?;
    let (pack, key, item) = roundable(&packs, &pack, &item)?;
    let store = app.learning.store();
    if store.attempts(&key)?.iter().any(|a| a.id == body.id) {
        return Err(bad_request("That round has been marked already."));
    }
    let round = seen(&app, &key, |round, now| {
        if let Some(work) = &body.work
            && round.ended.is_none()
        {
            round.save_work(work, now)?;
        }
        round.finish(now);
        Ok(())
    })?
    .ok_or_else(|| bad_request("There's no round of that to mark."))?;
    let ending = round.ended.expect("finish always ends the round");
    let transcript = round.transcript();
    let note = note(&round, ending);
    let marked = if round.has_work() {
        let error_types = crate::mistakes::error_types(&packs);
        let (runner, spec) =
            app.grader_target(pack.prompt_add_ons.get("grader").map(String::as_str))?;
        let answer = Answer {
            note: Some(&note),
            ..Answer::written(&transcript)
        };
        crate::grader::mark(runner, &spec, item, Work::Round, answer, &error_types)
            .await
            .map_err(|err| bad_request(format!("{err:#}")))?
    } else {
        // Nothing to mark: no need to ask the grader that it's worth nothing.
        Marked {
            score: 0.0,
            points: Vec::new(),
            findings: Vec::new(),
            feedback: "Nothing was written or said in the round, so there was nothing to mark."
                .to_owned(),
            clarity: None,
            questioning: None,
        }
    };
    let now = now_ms();
    store.record_mistakes(&marked.mistakes(&body.id, &key, now))?;
    let due = if ending.is_attempt() && round.has_work() {
        // The grader's findings are the round's mistakes: the transcript isn't an answer to
        // check, as a probability question's would be, so the attempt is recorded as it is.
        store.record(
            &[Attempt {
                id: body.id,
                item: key.clone(),
                answered_at: now,
                duration_ms: 0,
                rating: marked.rating(),
                response: Some(transcript),
                seed: None,
            }],
            now,
        )?;
        store.schedules()?.get(&key).map(|schedule| {
            store
                .scheduler()
                .due(schedule, app.config.learning.desired_retention)
        })
    } else {
        None
    };
    app.rounds.remove(&key)?;
    crate::tracks::done_long(&app.paths.data_dir, workshop_tracks::TrackId::Rounds, now)?;
    let rubric = marked.points.iter().map(|p| p.point.clone()).collect();
    Ok(Json(Ended {
        ending,
        marked,
        rubric,
        due,
    }))
}

#[cfg(all(test, unix))]
mod tests {
    use axum::Router;
    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::{StatusCode, header};
    use workshop_sessions::round::{AWAY_MS, Round};

    use crate::learning::now_ms;
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

    async fn post(router: &Router, path: &str, body: serde_json::Value) -> serde_json::Value {
        json(send(router, request("POST", path, Some(body))).await).await
    }

    const MARKED: &str = r#"{"score": 0.4, "points": [], "findings": [{"error_type": "wrong-model", "detail": "Counted ordered pairs twice"}], "feedback": "Close."}"#;

    fn app(dir: &std::path::Path) -> Router {
        std::fs::write(
            dir.join("examiner.txt"),
            "Good. Now what if there were three dice?",
        )
        .unwrap();
        std::fs::write(dir.join("mark.json"), MARKED).unwrap();
        let model = fake_discussion_model(
            dir,
            &[("as the examiner", "examiner.txt"), ("<work>", "mark.json")],
        );
        test_app_in(dir, &model)
    }

    const ITEM: &str = "/api/rounds/sample/two-dice-seven";

    /// Changes the round as it's saved, as if time had passed.
    fn rewind(dir: &std::path::Path, change: impl FnOnce(&mut Round)) {
        let path = dir.join("data/rounds/sample/two-dice-seven.json");
        let mut round: Round =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        change(&mut round);
        std::fs::write(&path, serde_json::to_string(&round).unwrap()).unwrap();
    }

    async fn scheduled(router: &Router) -> bool {
        let deck = json(send(router, request("GET", "/api/learning/deck", None)).await).await;
        deck["schedules"].get("sample/two-dice-seven").is_some()
    }

    #[tokio::test]
    async fn runs_a_round_with_the_examiner_then_marks_it() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        let overview =
            json(send(&router, request("GET", "/api/rounds?utc_offset=0", None)).await).await;
        assert_eq!(overview["under_way"], serde_json::json!([]));
        assert!(
            overview["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|i| i["key"] == "sample/two-dice-seven" && i["minutes"] == 10)
        );
        let opened = post(&router, &format!("{ITEM}/open"), serde_json::json!({})).await;
        assert_eq!(opened["round"], serde_json::Value::Null);
        assert_eq!(opened["minutes"], 10);
        let styles: Vec<&str> = opened["styles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].as_str().unwrap())
            .collect();
        assert_eq!(styles, ["steady", "probing"]);

        let started = post(
            &router,
            &format!("{ITEM}/start"),
            serde_json::json!({ "style": "probing" }),
        )
        .await;
        assert_eq!(started["round"]["style"]["name"], "Probing");
        assert_eq!(started["round"]["clock"]["remaining_ms"], 600_000);
        // Starting again carries on with the round under way.
        let again = post(&router, &format!("{ITEM}/start"), serde_json::json!({})).await;
        assert_eq!(again["round"]["style"]["id"], "probing");

        let beat = post(
            &router,
            &format!("{ITEM}/beat"),
            serde_json::json!({ "work": "6 of 36" }),
        )
        .await;
        assert_eq!(beat["ended"], serde_json::Value::Null);
        let said = post(
            &router,
            &format!("{ITEM}/say"),
            serde_json::json!({ "text": "Is it 1/6?", "work": "6 of 36 pairs" }),
        )
        .await;
        let turns = said["round"]["turns"].as_array().unwrap();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0]["speaker"], "learner");
        assert_eq!(turns[1]["speaker"], "coach");
        assert_eq!(turns[1]["text"], "Good. Now what if there were three dice?");
        assert_eq!(said["round"]["work"], "6 of 36 pairs");
        let empty = send(
            &router,
            request(
                "POST",
                &format!("{ITEM}/say"),
                Some(serde_json::json!({ "text": " ", "work": "" })),
            ),
        )
        .await;
        assert_eq!(empty.status(), StatusCode::BAD_REQUEST);

        // Under way, it's what Continue offers when there's a while.
        let home = json(
            send(
                &router,
                request("GET", "/api/home?utc_offset=0&time=a_while", None),
            )
            .await,
        )
        .await;
        assert_eq!(home["continue"]["track"], "rounds");
        assert_eq!(home["continue"]["priority"], "unfinished");
        assert_eq!(
            home["continue"]["destination"],
            serde_json::json!({ "kind": "round", "item": "sample/two-dice-seven" })
        );
        assert_eq!(
            home["continue"]["reason"],
            "Where you left off, 10 minutes left"
        );

        let id = "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a71";
        let ended = post(
            &router,
            &format!("{ITEM}/end"),
            serde_json::json!({ "id": id, "work": "6 of 36 pairs, so 1/6" }),
        )
        .await;
        assert_eq!(ended["ending"], "finished");
        assert_eq!(ended["marked"]["score"], 0.4);
        assert!(ended["due"].as_i64().is_some());
        assert!(scheduled(&router).await);
        let log = json(send(&router, request("GET", "/api/mistakes", None)).await).await;
        assert_eq!(log["mistakes"][0]["detail"], "Counted ordered pairs twice");
        // The round's over.
        let opened = post(&router, &format!("{ITEM}/open"), serde_json::json!({})).await;
        assert_eq!(opened["round"], serde_json::Value::Null);
        let again = send(
            &router,
            request(
                "POST",
                &format!("{ITEM}/end"),
                Some(serde_json::json!({ "id": id })),
            ),
        )
        .await;
        assert_eq!(again.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn ends_when_time_runs_out_and_marks_it_as_an_attempt() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        post(&router, &format!("{ITEM}/start"), serde_json::json!({})).await;
        post(
            &router,
            &format!("{ITEM}/beat"),
            serde_json::json!({ "work": "1/6" }),
        )
        .await;
        rewind(dir.path(), |round| round.used_ms = round.limit_ms() - 1);
        let beat = post(
            &router,
            &format!("{ITEM}/beat"),
            serde_json::json!({ "work": "1/6, as 6 of 36" }),
        )
        .await;
        assert_eq!(beat["ended"], "time_up");
        assert_eq!(beat["clock"]["remaining_ms"], 0);
        // Once it's over, nothing more can be said, and the working stays as it was.
        let late = send(
            &router,
            request(
                "POST",
                &format!("{ITEM}/say"),
                Some(serde_json::json!({ "text": "One more thing", "work": "late" })),
            ),
        )
        .await;
        assert_eq!(late.status(), StatusCode::BAD_REQUEST);
        let ended = post(
            &router,
            &format!("{ITEM}/end"),
            serde_json::json!({ "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a72", "work": "late" }),
        )
        .await;
        assert_eq!(ended["ending"], "time_up");
        assert!(ended["due"].as_i64().is_some());
        let deck = json(send(&router, request("GET", "/api/learning/deck", None)).await).await;
        assert_eq!(deck["schedules"]["sample/two-dice-seven"]["reviews"], 1);
    }

    #[tokio::test]
    async fn carries_on_after_a_short_break_and_ends_fairly_after_a_long_one() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        post(&router, &format!("{ITEM}/start"), serde_json::json!({})).await;
        post(
            &router,
            &format!("{ITEM}/beat"),
            serde_json::json!({ "work": "6 of 36" }),
        )
        .await;
        // The app closed for five minutes: the clock carries on where it was.
        rewind(dir.path(), |round| {
            round.used_ms = 120_000;
            round.seen_at = now_ms() - 5 * 60_000;
        });
        let opened = post(&router, &format!("{ITEM}/open"), serde_json::json!({})).await;
        let used = opened["round"]["clock"]["used_ms"].as_i64().unwrap();
        assert!((120_000..=140_000).contains(&used), "{used}");
        assert_eq!(opened["round"]["returned"], true);
        assert_eq!(opened["round"]["ended"], serde_json::Value::Null);
        assert_eq!(opened["round"]["work"], "6 of 36");

        // Away for longer than a sitting: the round ended when they left.
        rewind(dir.path(), |round| {
            round.seen_at = now_ms() - AWAY_MS - 60_000
        });
        let home = json(
            send(
                &router,
                request("GET", "/api/home?utc_offset=0&time=a_while", None),
            )
            .await,
        )
        .await;
        assert_eq!(
            home["continue"]["reason"],
            "Ended while you were away, to be marked"
        );
        let opened = post(&router, &format!("{ITEM}/open"), serde_json::json!({})).await;
        assert_eq!(opened["round"]["ended"], "interrupted");
        assert_eq!(opened["round"]["clock"]["used_ms"], used);
        let ended = post(
            &router,
            &format!("{ITEM}/end"),
            serde_json::json!({ "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a73" }),
        )
        .await;
        // Marked, with its mistakes kept, but not counted as an attempt.
        assert_eq!(ended["ending"], "interrupted");
        assert_eq!(ended["due"], serde_json::Value::Null);
        assert!(!scheduled(&router).await);
        let log = json(send(&router, request("GET", "/api/mistakes", None)).await).await;
        assert_eq!(log["mistakes"][0]["item"], "sample/two-dice-seven");
    }

    #[tokio::test]
    async fn refuses_what_isnt_a_round() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        let status = |path: &str, body: serde_json::Value| {
            let router = router.clone();
            let path = path.to_owned();
            async move {
                send(&router, request("POST", &path, Some(body)))
                    .await
                    .status()
            }
        };
        assert_eq!(
            status(&format!("{ITEM}/beat"), serde_json::json!({ "work": "" })).await,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            status(
                &format!("{ITEM}/start"),
                serde_json::json!({ "style": "gentle" })
            )
            .await,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            status(
                "/api/rounds/sample/binary-heap-costs/start",
                serde_json::json!({})
            )
            .await,
            StatusCode::BAD_REQUEST
        );
        // A round with nothing in it ends without asking the grader.
        post(&router, &format!("{ITEM}/start"), serde_json::json!({})).await;
        let ended = post(
            &router,
            &format!("{ITEM}/end"),
            serde_json::json!({ "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a74" }),
        )
        .await;
        assert_eq!(ended["marked"]["score"], 0.0);
        assert_eq!(ended["due"], serde_json::Value::Null);
        assert!(!scheduled(&router).await);
    }
}
