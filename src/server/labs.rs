//! Labs: hands-on exercises the learner carries out on a machine of their own, a step at a
//! time, recording what they ran and saw, saved as it's written, and marked by the grader as a
//! whole at the end against what each step should show. What each step should show, and what a
//! good answer to the question at the end covers, are never sent to the app until it's marked.

use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use workshop_learning::Attempt;
use workshop_pack::{Content, Item, Lab, Pack};
use workshop_sessions::lab::{Edit, Session};

use super::error::{ApiError, ApiResult, bad_request};
use super::grading::{MarkedReply, due, find, packs};
use super::state::Shared;
use crate::grader::{Answer, Point, Work};
use crate::learning::now_ms;

/// A lab in the packs, with its pack, its key and its steps.
fn lab<'a>(
    packs: &'a [Pack],
    pack: &str,
    item: &str,
) -> Result<(&'a Pack, String, &'a Item, &'a Lab), ApiError> {
    let (pack, item) = find(packs, pack, item)?;
    let Content::Lab(lab) = &item.content else {
        return Err(bad_request(format!("{} isn't a lab", item.label())));
    };
    Ok((pack, format!("{}/{}", pack.manifest.id, item.id), item, lab))
}

#[derive(Serialize)]
struct StepView {
    title: String,
    /// In Markdown.
    body: String,
}

#[derive(Serialize)]
struct SourceView {
    title: String,
    url: String,
}

/// The lesson a lab asks to be done first.
#[derive(Serialize)]
struct LessonFirst {
    key: String,
    title: String,
    done: bool,
}

/// A lab session as the app sees it.
#[derive(Serialize)]
pub(super) struct SessionView {
    #[serde(flatten)]
    session: Session,
    /// Whether the lab's steps have changed since it was started, so what was recorded no
    /// longer fits them, and it has to be started again.
    stale: bool,
}

impl SessionView {
    fn new(session: Session, lab: &Lab) -> Self {
        Self {
            stale: session.steps() != lab.steps.len(),
            session,
        }
    }
}

#[derive(Serialize)]
pub(super) struct LabOpened {
    key: String,
    label: String,
    /// In Markdown.
    prompt: String,
    skills: Vec<String>,
    minutes: u32,
    source: Option<String>,
    setup: String,
    /// Each step, without what it should show, which is the grader's until it's marked.
    steps: Vec<StepView>,
    /// The question at the end.
    explain: String,
    lesson: Option<LessonFirst>,
    /// Where the learner is, if they've started.
    session: Option<SessionView>,
    /// What the learner recorded last time, if they've done it before.
    previous: Option<String>,
}

fn opened(app: &Shared, pack: &Pack, key: String, item: &Item, lab: &Lab) -> ApiResult<LabOpened> {
    let store = app.learning.store();
    let previous = store
        .attempts(&key)?
        .into_iter()
        .rev()
        .find_map(|attempt| attempt.response);
    let lesson = match &lab.lesson {
        Some(id) => {
            let lesson_key = format!("{}/{id}", pack.manifest.id);
            let done = store
                .lesson_completions_by_lesson()?
                .get(&lesson_key)
                .is_some_and(|done| !done.is_empty());
            let title = pack.item(id).map_or_else(|| id.clone(), Item::label);
            Some(LessonFirst {
                key: lesson_key,
                title,
                done,
            })
        }
        None => None,
    };
    Ok(Json(LabOpened {
        session: app
            .lab_sessions
            .get(&key)?
            .map(|session| SessionView::new(session, lab)),
        label: item.label(),
        prompt: item.prompt.clone(),
        skills: item.skills.clone(),
        minutes: item.minutes,
        source: item.source.clone(),
        setup: lab.setup.clone(),
        steps: lab
            .steps
            .iter()
            .map(|step| StepView {
                title: step.title.clone(),
                body: step.body.clone(),
            })
            .collect(),
        explain: lab.explain.clone(),
        lesson,
        previous,
        key,
    }))
}

/// A lab, and the learner's session with it, if they've started one.
pub(super) async fn open(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
) -> ApiResult<LabOpened> {
    let packs = packs(&app)?;
    let (pack, key, item, lab) = lab(&packs, &pack, &item)?;
    opened(&app, pack, key, item, lab)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct StartBody {
    /// Starts afresh, leaving out what was recorded so far, as when the lab's steps have
    /// changed since it was started.
    #[serde(default)]
    again: bool,
}

/// Starts a lab, or carries on with the one started.
pub(super) async fn start(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Json(StartBody { again }): Json<StartBody>,
) -> ApiResult<LabOpened> {
    let packs = packs(&app)?;
    let (pack, key, item, lab) = lab(&packs, &pack, &item)?;
    if again {
        app.lab_sessions.remove(&key)?;
    }
    app.lab_sessions
        .put_new(&key, Session::new(lab.steps.len(), now_ms()))?;
    opened(&app, pack, key, item, lab)
}

/// Saves what the learner's recorded, as they write it, and counts the time spent.
pub(super) async fn save(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Json(edit): Json<Edit>,
) -> ApiResult<SessionView> {
    let packs = packs(&app)?;
    let (_, key, _, lab) = lab(&packs, &pack, &item)?;
    let now = now_ms();
    let (session, spent) = app
        .lab_sessions
        .change(&key, |session| {
            let spent = workshop_sessions::spent(session.updated_at, now);
            session.edit(edit, now)?;
            Ok(spent)
        })
        .map_err(|err| bad_request(format!("{err:#}")))?
        .ok_or_else(|| bad_request("Start the lab before saving it."))?;
    app.learning.store().record_time(&key, now, spent)?;
    Ok(Json(SessionView::new(session, lab)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct FinishBody {
    /// Made by the app, for the attempt this records.
    id: String,
}

/// A step, marked: what it should have shown beside what the learner recorded.
#[derive(Serialize)]
struct StepMarked {
    title: String,
    expected: String,
    recorded: String,
    point: Point,
}

/// The question at the end, marked: what a good answer covers beside the learner's.
#[derive(Serialize)]
struct ExplainMarked {
    question: String,
    answer: String,
    given: String,
    point: Point,
}

#[derive(Serialize)]
pub(super) struct LabMarked {
    #[serde(flatten)]
    marked: MarkedReply,
    steps: Vec<StepMarked>,
    explain: ExplainMarked,
    /// Where the lab's facts come from, as further reading.
    sources: Vec<SourceView>,
}

/// Has the grader mark the whole lab against what each step should show and what a good answer
/// to its question covers. It counts as an attempt, rated from the score, with what it finds in
/// the mistake log; then the session ends.
pub(super) async fn finish(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Json(body): Json<FinishBody>,
) -> ApiResult<LabMarked> {
    let packs = packs(&app)?;
    let (pack, key, item, lab) = lab(&packs, &pack, &item)?;
    let store = app.learning.store();
    if store.attempts(&key)?.iter().any(|a| a.id == body.id) {
        return Err(bad_request("That lab has been marked already."));
    }
    let session = app
        .lab_sessions
        .get(&key)?
        .ok_or_else(|| bad_request("There's no lab under way to mark."))?;
    session
        .check_markable()
        .map_err(|err| bad_request(err.to_string()))?;
    let titles: Vec<&str> = lab.steps.iter().map(|step| step.title.as_str()).collect();
    let transcript = session.transcript(&titles, &lab.explain).map_err(|_| {
        bad_request("The lab's steps have changed since you started it, so start it again.")
    })?;
    let error_types = crate::mistakes::error_types(&packs);
    let (runner, spec) =
        app.grader_target(pack.prompt_add_ons.get("grader").map(String::as_str))?;
    let marked = crate::grader::mark(
        runner,
        &spec,
        item,
        Work::Lab,
        Answer::written(&transcript),
        &error_types,
    )
    .await
    .map_err(|err| bad_request(format!("{err:#}")))?;
    let now = now_ms();
    let findings = marked.mistakes(&body.id, &key, now);
    let attempt = Attempt {
        id: body.id,
        item: key.clone(),
        answered_at: now,
        duration_ms: workshop_sessions::spent(session.updated_at, now),
        rating: marked.rating(),
        response: Some(transcript),
        seed: None,
    };
    app.learning
        .record_marked(attempt.clone(), &findings, now)?;
    app.lab_sessions.remove(&key)?;
    crate::tracks::done_long(&app.paths.data_dir, item.track.clone(), now)?;
    // The grader's points come in the lab's order, a step's each then the question's.
    let mut points = marked.points.iter().cloned();
    let steps = lab
        .steps
        .iter()
        .zip(&session.records)
        .map(|(step, recorded)| StepMarked {
            title: step.title.clone(),
            expected: step.expected.clone(),
            recorded: recorded.trim().to_owned(),
            point: points.next().expect("a point for each step"),
        })
        .collect();
    let explain = ExplainMarked {
        question: lab.explain.clone(),
        answer: lab.explain_answer.clone(),
        given: session.explanation.trim().to_owned(),
        point: points.next().expect("a point for the question at the end"),
    };
    let due = due(&app, &key)?;
    Ok(Json(LabMarked {
        marked: MarkedReply {
            rubric: marked.points.iter().map(|p| p.point.clone()).collect(),
            marked,
            due,
            attempt: Some(attempt),
        },
        steps,
        explain,
        sources: lab
            .sources
            .iter()
            .map(|source| SourceView {
                title: source.title.clone(),
                url: source.url.clone(),
            })
            .collect(),
    }))
}

#[cfg(all(test, unix))]
mod tests {
    use axum::Router;
    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::{StatusCode, header};

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

    async fn call(router: &Router, method: &str, path: &str, body: serde_json::Value) -> Response {
        Response(send(router, request(method, path, Some(body))).await)
    }

    struct Response(axum::response::Response);

    impl Response {
        async fn ok(self) -> serde_json::Value {
            json(self.0).await
        }

        fn status(&self) -> StatusCode {
            self.0.status()
        }
    }

    /// The grader's marks for the sample lab, given back out of order: two of its three steps
    /// met, and the question at the end partly answered.
    const MARKED: &str = r#"{"score": 0.7, "points": [{"point": "[E] Answers", "met": "partly", "comment": "Say when a list wins."}, {"point": "[S3] Look", "met": "no", "comment": "Nothing recorded."}, {"point": "[S1] Time", "met": "yes", "comment": ""}, {"point": "[S2] Grow", "met": "yes", "comment": ""}], "findings": [{"error_type": "concept-gap", "detail": "Thinks a miss in a dict scans it"}], "feedback": "Try the miss too."}"#;

    /// A server learning from a copy of the sample pack, whose lab asks for its binary heaps
    /// lesson to be done first, with a stand-in grader.
    fn app(dir: &std::path::Path) -> Router {
        let pack = dir.join("pack");
        crate::pack_files::testing::sample_pack_copy(&pack);
        let lab = pack.join("items/labs/dict-and-list-lookups.md");
        let text = std::fs::read_to_string(&lab).unwrap();
        let text = text.replacen(
            "minutes = 20\n",
            "minutes = 20\nlesson = \"binary-heaps\"\n",
            1,
        );
        std::fs::write(&lab, text).unwrap();
        std::fs::write(dir.join("mark.json"), MARKED).unwrap();
        let script = format!(
            "prompt=$(cat)\ncase \"$prompt\" in\n  *'<lab>'*'<work>'*) cat '{}' ;;\n  *) echo 'The fake model has no reply for this prompt' >&2; exit 1 ;;\nesac\n",
            dir.join("mark.json").display()
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

    const LAB: &str = "/api/labs/sample/dict-and-list-lookups";
    const KEY: &str = "sample/dict-and-list-lookups";

    /// What the first step should show, which is never sent before it's marked.
    const EXPECTED: &str = "a hundred times or more";

    fn edit(at: usize, records: [&str; 3], explanation: &str) -> serde_json::Value {
        serde_json::json!({ "at": at, "records": records, "explanation": explanation })
    }

    async fn home(router: &Router) -> serde_json::Value {
        json(
            send(
                router,
                request("GET", "/api/home?utc_offset=0&time=a_while", None),
            )
            .await,
        )
        .await
    }

    fn review_track(home: &serde_json::Value) -> &serde_json::Value {
        home["tracks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|track| track["id"] == "review")
            .unwrap()
    }

    #[tokio::test]
    async fn works_through_a_lab_a_step_at_a_time_then_marks_it() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        let opened = json(send(&router, request("GET", LAB, None)).await).await;
        assert_eq!(opened["session"], serde_json::Value::Null);
        assert_eq!(opened["steps"].as_array().unwrap().len(), 3);
        assert_eq!(
            opened["steps"][0]["title"],
            "Time a lookup in a list and a dict"
        );
        assert!(
            opened["setup"]
                .as_str()
                .unwrap()
                .starts_with("Any computer")
        );
        assert_eq!(opened["lesson"]["key"], "sample/binary-heaps");
        assert_eq!(opened["lesson"]["done"], false);
        // What each step should show, and the explain answer, are the grader's until it's marked.
        assert!(!opened.to_string().contains(EXPECTED), "{opened}");
        assert!(!opened.to_string().contains("Explain answer"), "{opened}");
        // Listed in its track, from the deck, as not done.
        let deck = json(
            send(
                &router,
                request("GET", "/api/learning/deck?utc_offset=0", None),
            )
            .await,
        )
        .await;
        let listed = deck["labs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|lab| lab["key"] == KEY)
            .unwrap();
        assert_eq!(listed["track"], "review");
        assert_eq!(listed["minutes"], 20);
        assert_eq!(listed["lesson"], "sample/binary-heaps");
        assert_eq!(listed["done"], false);
        // Its lesson isn't done, so Continue doesn't offer it, even with a while.
        assert_eq!(
            review_track(&home(&router).await)["long"],
            serde_json::Value::Null
        );

        // Nothing to save before it's started.
        let early = call(
            &router,
            "PUT",
            &format!("{LAB}/session"),
            edit(1, ["", "", ""], ""),
        )
        .await;
        assert_eq!(early.status(), StatusCode::BAD_REQUEST);
        let started = call(
            &router,
            "POST",
            &format!("{LAB}/start"),
            serde_json::json!({}),
        )
        .await
        .ok()
        .await;
        assert_eq!(started["session"]["at"], 0);
        assert_eq!(started["session"]["stale"], false);
        let saved = call(
            &router,
            "PUT",
            &format!("{LAB}/session"),
            edit(1, ["7 usec and 19 nsec", "", ""], ""),
        )
        .await
        .ok()
        .await;
        assert_eq!(
            (saved["at"].clone(), saved["reached"].clone()),
            (1.into(), 1.into())
        );
        // A step can't be skipped.
        let skipped = call(
            &router,
            "PUT",
            &format!("{LAB}/session"),
            edit(3, ["7 usec and 19 nsec", "", ""], ""),
        )
        .await;
        assert_eq!(skipped.status(), StatusCode::BAD_REQUEST);
        // Nor marked before the question at the end is answered.
        let unexplained = call(
            &router,
            "POST",
            &format!("{LAB}/finish"),
            serde_json::json!({ "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a70" }),
        )
        .await;
        assert_eq!(unexplained.status(), StatusCode::BAD_REQUEST);
        let records = [
            "7 usec and 19 nsec",
            "70 usec, 700 usec; 19 nsec each time",
            "",
        ];
        for at in 2..=4 {
            let explanation = if at == 4 { "A list is scanned." } else { "" };
            call(
                &router,
                "PUT",
                &format!("{LAB}/session"),
                edit(at, records, explanation),
            )
            .await
            .ok()
            .await;
        }
        // Started again elsewhere, it carries on where it was.
        let again = call(
            &router,
            "POST",
            &format!("{LAB}/start"),
            serde_json::json!({}),
        )
        .await
        .ok()
        .await;
        assert_eq!(again["session"]["at"], 4);
        assert_eq!(again["session"]["records"][1], records[1]);
        // Under way, it's what Continue offers when there's a while, lesson or not.
        let continued = home(&router).await;
        assert_eq!(continued["continue"]["priority"], "unfinished");
        assert_eq!(continued["continue"]["long"], true);
        assert_eq!(
            continued["continue"]["reason"],
            "Where you left off: the question at the end"
        );
        assert_eq!(continued["continue"]["destination"]["kind"], "lab");
        assert_eq!(continued["continue"]["destination"]["item"], KEY);

        let id = "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a71";
        let marked = call(
            &router,
            "POST",
            &format!("{LAB}/finish"),
            serde_json::json!({ "id": id }),
        )
        .await
        .ok()
        .await;
        assert_eq!(marked["marked"]["score"], 0.7);
        assert_eq!(marked["attempt"]["id"], id);
        assert_eq!(marked["attempt"]["rating"], "hard");
        assert!(marked["due"].as_i64().is_some());
        // Each step's expected result beside what was recorded, with how the grader marked it,
        // in the lab's order whatever the grader's.
        let steps = marked["steps"].as_array().unwrap();
        assert_eq!(steps.len(), 3);
        assert!(steps[0]["expected"].as_str().unwrap().contains(EXPECTED));
        assert_eq!(steps[0]["recorded"], records[0]);
        assert_eq!(steps[0]["point"]["met"], "yes");
        assert_eq!(steps[2]["point"]["met"], "no");
        assert_eq!(steps[2]["recorded"], "");
        assert_eq!(marked["explain"]["given"], "A list is scanned.");
        assert_eq!(marked["explain"]["point"]["met"], "partly");
        assert!(
            marked["explain"]["answer"]
                .as_str()
                .unwrap()
                .contains("O(n)")
        );
        assert_eq!(
            marked["sources"][0]["url"],
            "https://docs.python.org/3/library/timeit.html"
        );
        // What was found is in the mistake log.
        let log = json(send(&router, request("GET", "/api/mistakes", None)).await).await;
        assert!(
            log["mistakes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["detail"] == "Thinks a miss in a dict scans it")
        );
        // The lab's over, what was recorded is kept with the attempt, and it's done.
        let opened = json(send(&router, request("GET", LAB, None)).await).await;
        assert_eq!(opened["session"], serde_json::Value::Null);
        let previous = opened["previous"].as_str().unwrap();
        assert!(
            previous
                .starts_with("## Step 1: Time a lookup in a list and a dict\n\n7 usec and 19 nsec"),
            "{previous}"
        );
        assert!(
            previous.contains("## Step 3: Look up a value that isn't there\n\n(Nothing recorded.)")
        );
        let deck = json(
            send(
                &router,
                request("GET", "/api/learning/deck?utc_offset=0", None),
            )
            .await,
        )
        .await;
        let listed = deck["labs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|lab| lab["key"] == KEY)
            .unwrap();
        assert_eq!(listed["done"], true);
        let twice = call(
            &router,
            "POST",
            &format!("{LAB}/finish"),
            serde_json::json!({ "id": id }),
        )
        .await;
        assert_eq!(twice.status(), StatusCode::BAD_REQUEST);
        // It can be done again.
        let restarted = call(
            &router,
            "POST",
            &format!("{LAB}/start"),
            serde_json::json!({}),
        )
        .await
        .ok()
        .await;
        assert_eq!(restarted["session"]["at"], 0);
        assert_eq!(restarted["session"]["records"][0], "");
    }

    #[tokio::test]
    async fn offers_a_lab_with_a_while_once_its_lesson_is_done() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        assert_eq!(
            review_track(&home(&router).await)["long"],
            serde_json::Value::Null
        );
        let sync = serde_json::json!({
            "lesson_completions": [{
                "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a72",
                "lesson": "sample/binary-heaps",
                "completed_at": crate::learning::now_ms(),
                "duration_ms": 180000,
            }],
        });
        call(&router, "POST", "/api/learning/sync?utc_offset=0", sync)
            .await
            .ok()
            .await;
        let home = home(&router).await;
        let long = &review_track(&home)["long"];
        assert_eq!(long["destination"]["kind"], "lab");
        assert_eq!(long["destination"]["item"], KEY);
        assert_eq!(long["priority"], "new");
        assert_eq!(long["reason"], "Lab · something new");
        // Without a while, Continue doesn't take it.
        let short = json(send(&router, request("GET", "/api/home?utc_offset=0", None)).await).await;
        assert_ne!(short["continue"]["destination"]["kind"], "lab");
    }

    #[tokio::test]
    async fn starts_a_lab_again_once_its_steps_have_changed() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        call(
            &router,
            "POST",
            &format!("{LAB}/start"),
            serde_json::json!({}),
        )
        .await
        .ok()
        .await;
        call(
            &router,
            "PUT",
            &format!("{LAB}/session"),
            edit(1, ["7 usec", "", ""], ""),
        )
        .await
        .ok()
        .await;
        // The pack's lab loses its last step.
        let path = dir.path().join("pack/items/labs/dict-and-list-lookups.md");
        let text = std::fs::read_to_string(&path).unwrap();
        let start = text.find("## Look up a value that isn't there").unwrap();
        let end = text.find("## Explain\n").unwrap();
        std::fs::write(&path, format!("{}{}", &text[..start], &text[end..])).unwrap();
        let opened = json(send(&router, request("GET", LAB, None)).await).await;
        assert_eq!(opened["steps"].as_array().unwrap().len(), 2);
        assert_eq!(opened["session"]["stale"], true);
        // Carrying on doesn't fix it; starting again does.
        let carried = call(
            &router,
            "POST",
            &format!("{LAB}/start"),
            serde_json::json!({}),
        )
        .await
        .ok()
        .await;
        assert_eq!(carried["session"]["stale"], true);
        let again = call(
            &router,
            "POST",
            &format!("{LAB}/start"),
            serde_json::json!({ "again": true }),
        )
        .await
        .ok()
        .await;
        assert_eq!(again["session"]["stale"], false);
        assert_eq!(again["session"]["records"].as_array().unwrap().len(), 2);
        // Something that isn't a lab isn't opened as one.
        let card = send(
            &router,
            request("GET", "/api/labs/sample/binary-heap-costs", None),
        )
        .await;
        assert_eq!(card.status(), StatusCode::BAD_REQUEST);
    }
}
