//! Follow-up questions on cards: the learner's answer in their own words, then the tutor's
//! questions about it, each saved as it's given, and the whole exchange marked by the grader at
//! the end, as the card's attempt.
//!
//! A phone's connection can drop a reply on its way back, so every request is safe to send
//! again: starting finds the exchange already started, each reply names the exchange and the
//! question it answers, so it's never filed under another, and marking it again gives the marks
//! already given rather than another attempt.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use workshop_learning::Attempt;
use workshop_pack::{Content, FollowUps, Item, Pack};
use workshop_provider::{CallSpec, ProviderRunner};

use super::error::{ApiError, ApiResult, bad_request};
use super::grading::{MarkedReply, due, find, packs};
use super::state::Shared;
use crate::follow_ups::{Exchange, ExchangeError, Next, TUTOR};
use crate::grader::{Answer, Marked, Work};
use crate::learning::now_ms;

/// A card in the packs, with its pack, its key and how many follow-up questions it offers.
fn card<'a>(
    packs: &'a [Pack],
    pack: &str,
    item: &str,
) -> Result<(&'a Pack, String, &'a Item, FollowUps), ApiError> {
    let (pack, item) = find(packs, pack, item)?;
    let Content::Card { follow_ups, .. } = &item.content else {
        return Err(bad_request(format!(
            "{} isn't a card, so it has no follow-up questions",
            item.label()
        )));
    };
    Ok((
        pack,
        format!("{}/{}", pack.manifest.id, item.id),
        item,
        *follow_ups,
    ))
}

/// Refuses something sent for follow-ups that aren't the card's any more, saying why, as a
/// conflict, so the app knows to look again at what's under way.
fn over(why: &str) -> ApiError {
    ApiError(StatusCode::CONFLICT, serde_json::json!({ "error": why }))
}

const SUPERSEDED: &str =
    "These follow-up questions are over, as the card's been answered another way since.";
const MARKED: &str = "These follow-up questions have been marked already.";

/// Refuses what an exchange can't take: as over, if it's been marked, and otherwise as a bad
/// request.
fn refused(err: ExchangeError) -> ApiError {
    match err {
        ExchangeError::Marked => over(MARKED),
        other => bad_request(other.to_string()),
    }
}

/// The exchange under way on a card with this id, refusing one that's over or marked.
fn under_way(app: &Shared, key: &str, id: &str) -> Result<Exchange, ApiError> {
    match app.learning.exchange(key)? {
        Some(exchange) if exchange.id == id && exchange.marked.is_some() => Err(over(MARKED)),
        Some(exchange) if exchange.id == id => Ok(exchange),
        _ => Err(over(SUPERSEDED)),
    }
}

/// An exchange as the app sees it, with what happens next.
#[derive(Serialize)]
pub(super) struct ExchangeView {
    id: String,
    limit: FollowUps,
    answer: crate::follow_ups::Said,
    questions: Vec<crate::follow_ups::Question>,
    started_at: i64,
    updated_at: i64,
    next: Next,
}

impl From<Exchange> for ExchangeView {
    fn from(exchange: Exchange) -> Self {
        let next = exchange.next();
        let Exchange {
            id,
            limit,
            answer,
            questions,
            attempts_before: _,
            started_at,
            updated_at,
            marked: _,
        } = exchange;
        Self {
            id,
            limit,
            answer,
            questions,
            started_at,
            updated_at,
            next,
        }
    }
}

#[derive(Serialize)]
pub(super) struct Opened {
    exchange: Option<ExchangeView>,
}

/// The follow-up questions under way on a card, if there are any.
pub(super) async fn open(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
) -> ApiResult<Opened> {
    let packs = packs(&app)?;
    let (_, key, _, _) = card(&packs, &pack, &item)?;
    Ok(Json(Opened {
        exchange: app.learning.follow_ups(&key)?.map(ExchangeView::from),
    }))
}

/// The tutor asking follow-up questions on cards, with the pack's tutor add-on.
fn tutor<'a>(app: &'a Shared, pack: &Pack) -> Result<(&'a ProviderRunner, CallSpec), ApiError> {
    let system =
        crate::follow_ups::system_prompt(pack.prompt_add_ons.get("tutor").map(String::as_str));
    Ok(app.coach_target(system)?)
}

/// Has the tutor ask its next question, if it has one to ask, and keeps it. Called with the
/// card's follow-ups held.
async fn ask_if_due(
    app: &Shared,
    (runner, spec): (&ProviderRunner, CallSpec),
    key: &str,
    item: &Item,
    mut exchange: Exchange,
) -> ApiResult<ExchangeView> {
    if exchange.next() != Next::Ask {
        return Ok(Json(exchange.into()));
    }
    let question = crate::follow_ups::ask(runner, &spec, item, &exchange)
        .await
        .map_err(|err| bad_request(format!("{err:#}")))?;
    exchange.asked(&question, now_ms()).map_err(refused)?;
    app.learning.exchanges().put(key, &exchange)?;
    Ok(Json(exchange.into()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct StartBody {
    /// Made by the app, and the same each time it's sent, for the exchange and its attempt.
    id: String,
    /// The learner's answer to the card.
    text: String,
    /// Whether it was explained aloud, so `text` is what was heard.
    #[serde(default)]
    spoken: bool,
}

/// Starts follow-up questions on a card with the learner's answer, saving it, and has the tutor
/// ask its first question. If the card has follow-ups under way already, such as these, sent
/// again after a lost reply, or ones started on another device, it's those, as they were, and
/// the answer sent now isn't taken.
pub(super) async fn start(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Json(body): Json<StartBody>,
) -> ApiResult<ExchangeView> {
    let packs = packs(&app)?;
    let (pack, key, item, limit) = card(&packs, &pack, &item)?;
    workshop_learning::store::validate_id(&body.id)
        .map_err(|err| bad_request(format!("{err:#}")))?;
    // Without a tutor to ask, nothing's started.
    let tutor = tutor(&app, pack)?;
    let _card = app.follow_ups_lock(&key).await;
    let store = app.learning.store();
    if store.flags()?.contains_key(&key) {
        return Err(bad_request(
            "This card's flagged as wrong, so it isn't practised until it's fixed.",
        ));
    }
    let exchange = match app.learning.exchange(&key)? {
        Some(kept) if kept.marked.is_none() => kept,
        Some(kept) if kept.id == body.id => return Err(over(MARKED)),
        // Any kept is over, or marked, and kept only for marking it again to find, so the
        // new one replaces it.
        _ => {
            let attempts = store.attempts(&key)?.len() as u64;
            let started =
                Exchange::new(&body.id, limit, attempts, &body.text, body.spoken, now_ms())
                    .map_err(refused)?;
            app.learning.exchanges().put(&key, &started)?;
            started
        }
    };
    ask_if_due(&app, tutor, &key, item, exchange).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ReplyBody {
    /// The exchange it's for, by its id.
    exchange: String,
    /// The question it answers, counting from 0.
    question: usize,
    text: String,
    /// Whether it was explained aloud, so `text` is what was heard.
    #[serde(default)]
    spoken: bool,
    /// Whether the tutor then asks its next question, if it has one; not when the learner's
    /// about to have it marked.
    #[serde(default = "yes")]
    ask: bool,
}

fn yes() -> bool {
    true
}

/// Saves the learner's reply to the question it names, then has the tutor ask its next
/// question, if it has one. The same reply sent again, as after a lost reply, is taken as
/// given already. If the tutor can't be reached, the reply's kept, and asking again carries on.
pub(super) async fn reply(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Json(body): Json<ReplyBody>,
) -> ApiResult<ExchangeView> {
    let packs = packs(&app)?;
    let (pack, key, item, _) = card(&packs, &pack, &item)?;
    let tutor = tutor(&app, pack)?;
    let _card = app.follow_ups_lock(&key).await;
    let mut exchange = under_way(&app, &key, &body.exchange)?;
    let now = now_ms();
    let spent = workshop_sessions::spent(exchange.updated_at, now);
    if exchange
        .replied(body.question, &body.text, body.spoken, now)
        .map_err(refused)?
    {
        app.learning.exchanges().put(&key, &exchange)?;
        app.learning.store().record_time(&key, now, spent)?;
    }
    if !body.ask {
        return Ok(Json(exchange.into()));
    }
    ask_if_due(&app, tutor, &key, item, exchange).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ExchangeBody {
    /// The exchange it's for, by its id.
    exchange: String,
}

/// Has the tutor ask the question it couldn't before, such as when it couldn't be reached.
pub(super) async fn ask(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Json(body): Json<ExchangeBody>,
) -> ApiResult<ExchangeView> {
    let packs = packs(&app)?;
    let (pack, key, item, _) = card(&packs, &pack, &item)?;
    let tutor = tutor(&app, pack)?;
    let _card = app.follow_ups_lock(&key).await;
    let exchange = under_way(&app, &key, &body.exchange)?;
    ask_if_due(&app, tutor, &key, item, exchange).await
}

/// Has the grader mark the whole exchange, against the card's answer and explanation, for how
/// deeply the learner understands it as well as whether they're right, and for clarity where
/// they explained aloud. It's the card's attempt, with the exchange's id, rated from the score,
/// with what the grader finds in the mistake log; then the exchange is over, and kept with its
/// marks, so marking it again, as after a lost reply, gives those. It can be marked before every
/// question's been answered, which the grader is told.
pub(super) async fn finish(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Json(body): Json<ExchangeBody>,
) -> ApiResult<MarkedReply> {
    let packs = packs(&app)?;
    let (pack, key, item, _) = card(&packs, &pack, &item)?;
    // Held while the grader marks it too, so nothing's said to it meanwhile, and it's marked once.
    let _card = app.follow_ups_lock(&key).await;
    let marked_reply = |marked: Marked| -> ApiResult<MarkedReply> {
        Ok(Json(MarkedReply {
            rubric: marked.points.iter().map(|p| p.point.clone()).collect(),
            due: due(&app, &key)?,
            marked,
        }))
    };
    let mut exchange = match app.learning.exchange(&key)? {
        Some(exchange) if exchange.id == body.exchange => exchange,
        _ => return Err(over(SUPERSEDED)),
    };
    if let Some(marked) = exchange.marked {
        return marked_reply(marked);
    }
    let transcript = exchange.transcript(TUTOR);
    let error_types = crate::mistakes::error_types(&packs);
    let (runner, spec) =
        app.grader_target(pack.prompt_add_ons.get("grader").map(String::as_str))?;
    let marked = crate::grader::mark(
        runner,
        &spec,
        item,
        Work::FollowUps,
        Answer {
            spoken: exchange.spoken(),
            ..Answer::written(&transcript)
        },
        &error_types,
    )
    .await
    .map_err(|err| bad_request(format!("{err:#}")))?;
    // The card may have been answered another way, or flagged, by another device while the
    // grader was marking, which ends these without an attempt of their own.
    if app.learning.follow_ups(&key)?.is_none() {
        return Err(over(SUPERSEDED));
    }
    let now = now_ms();
    app.learning.record_marked(
        Attempt {
            id: exchange.id.clone(),
            item: key.clone(),
            answered_at: now,
            duration_ms: workshop_sessions::spent(exchange.updated_at, now),
            rating: marked.rating(),
            response: Some(transcript),
            seed: None,
        },
        &marked.mistakes(&exchange.id, &key, now),
        now,
    )?;
    exchange.mark(marked.clone()).map_err(refused)?;
    app.learning.exchanges().put(&key, &exchange)?;
    marked_reply(marked)
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

    async fn post(router: &Router, path: &str, body: serde_json::Value) -> serde_json::Value {
        json(send(router, request("POST", path, Some(body))).await).await
    }

    /// The grader's marking of an exchange: what it was given is kept, to look at.
    const MARKED: &str = r#"{"score": 0.7, "points": [{"point": "Answers each follow-up question soundly", "met": "partly", "comment": "Unsure why"}], "findings": [{"error_type": "concept-gap", "detail": "Couldn't say why removing is logarithmic"}], "feedback": "Say why it's one path.", "clarity": {"score": 0.6, "feedback": "Lead with the cost."}}"#;

    /// A server learning from a copy of the sample pack, in which the heap card offers one
    /// follow-up question and the stable sorting card none, with a stand-in tutor and grader.
    /// The tutor's question counts the questions it's asked, and it can't be reached while a
    /// file says so.
    fn app(dir: &std::path::Path) -> Router {
        let pack = dir.join("pack");
        crate::pack_files::testing::sample_pack_copy(&pack);
        for (card, follow_ups) in [("binary-heap-costs", 1), ("stable-sorting", 0)] {
            let path = pack.join(format!("items/cards/{card}.md"));
            let text = std::fs::read_to_string(&path).unwrap();
            let text = text.replacen(
                "kind = \"card\"\n",
                &format!("kind = \"card\"\nfollow_ups = {follow_ups}\n"),
                1,
            );
            std::fs::write(&path, text).unwrap();
        }
        std::fs::write(dir.join("mark.json"), MARKED).unwrap();
        let script = format!(
            r#"prompt=$(cat)
case "$prompt" in
  *'Ask follow-up question'*)
    if [ -e '{away}' ]; then echo 'The tutor is away' >&2; exit 1; fi
    echo asked >> '{asked}'
    n=$(wc -l < '{asked}' | tr -d ' ')
    printf 'Question %s: why is that?' "$n" ;;
  *'<work>'*) printf '%s' "$prompt" > '{graded}'; echo graded >> '{graded}-times'; sleep 0.2; cat '{mark}' ;;
  *) echo 'The fake model has no reply for this prompt' >&2; exit 1 ;;
esac
"#,
            away = dir.join("away").display(),
            asked = dir.join("asked").display(),
            graded = dir.join("graded").display(),
            mark = dir.join("mark.json").display(),
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

    const HEAP: &str = "/api/cards/sample/binary-heap-costs/follow-ups";
    const BFS: &str = "/api/cards/sample/breadth-first-shortest-paths/follow-ups";
    const ID: &str = "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a71";

    async fn status(router: &Router, path: &str, body: serde_json::Value) -> StatusCode {
        send(router, request("POST", path, Some(body)))
            .await
            .status()
    }

    async fn start(router: &Router, card: &str, id: &str, text: &str) -> serde_json::Value {
        post(
            router,
            &format!("{card}/start"),
            serde_json::json!({ "id": id, "text": text }),
        )
        .await
    }

    async fn reply(
        router: &Router,
        card: &str,
        question: usize,
        text: &str,
        spoken: bool,
    ) -> serde_json::Value {
        post(
            router,
            &format!("{card}/reply"),
            serde_json::json!({ "exchange": ID, "question": question, "text": text, "spoken": spoken }),
        )
        .await
    }

    fn asked(dir: &std::path::Path) -> usize {
        std::fs::read_to_string(dir.join("asked")).map_or(0, |text| text.lines().count())
    }

    #[tokio::test]
    async fn follows_up_a_card_then_marks_the_whole_exchange_as_its_attempt() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        let opened = json(send(&router, request("GET", BFS, None)).await).await;
        assert_eq!(opened["exchange"], serde_json::Value::Null);
        // There's nothing to follow up without an answer.
        let empty = serde_json::json!({ "id": ID, "text": " " });
        assert_eq!(
            status(&router, &format!("{BFS}/start"), empty).await,
            StatusCode::BAD_REQUEST
        );

        let started = start(&router, BFS, ID, "It goes out a layer at a time").await;
        assert_eq!(started["id"], ID);
        assert_eq!(started["limit"], 2);
        assert_eq!(started["answer"]["text"], "It goes out a layer at a time");
        assert_eq!(started["answer"]["spoken"], false);
        assert_eq!(started["questions"][0]["text"], "Question 1: why is that?");
        assert_eq!(started["next"], "reply");
        // Saved, so opened again, as after closing the app, it's where it was.
        let opened = json(send(&router, request("GET", BFS, None)).await).await;
        assert_eq!(opened["exchange"], started);
        // And the deck says so, for the app to carry on with it first, as does home.
        let deck = json(send(&router, request("GET", "/api/learning/deck", None)).await).await;
        assert_eq!(
            deck["follow_ups"],
            serde_json::json!(["sample/breadth-first-shortest-paths"])
        );
        let card = deck["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["key"] == "sample/breadth-first-shortest-paths")
            .unwrap();
        assert_eq!(card["follow_ups"], 2);
        let home = json(send(&router, request("GET", "/api/home?utc_offset=0", None)).await).await;
        let review = home["tracks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|track| track["id"] == "review")
            .unwrap();
        // It's counted once, apart from what's new, and spends none of today's new items.
        assert_eq!(review["summary"], "1 being followed up · 9 new");
        assert_eq!(review["next"]["priority"], "unfinished");
        assert_eq!(
            review["next"]["reason"],
            "Where you left off: its follow-up questions"
        );

        let replied = reply(&router, BFS, 0, "the queue keeps nearer ones first", true).await;
        assert_eq!(replied["questions"][0]["reply"]["spoken"], true);
        assert_eq!(replied["questions"][1]["text"], "Question 2: why is that?");
        let last = reply(&router, BFS, 1, "With weights it's Dijkstra's", false).await;
        // Two questions is all the card asks for, so it's ready to mark.
        assert_eq!(last["questions"].as_array().unwrap().len(), 2);
        assert_eq!(last["next"], "mark");
        assert_eq!(asked(dir.path()), 2);

        let marked = post(
            &router,
            &format!("{BFS}/finish"),
            serde_json::json!({ "exchange": ID }),
        )
        .await;
        assert_eq!(marked["marked"]["score"], 0.7);
        assert_eq!(marked["marked"]["clarity"]["score"], 0.6);
        assert!(marked["due"].as_i64().is_some());
        let graded = std::fs::read_to_string(dir.path().join("graded")).unwrap();
        assert!(graded.contains(
            "<work>\nLearner: It goes out a layer at a time\nTutor: Question 1: why is that?\nLearner (aloud): the queue keeps nearer ones first\nTutor: Question 2: why is that?\nLearner: With weights it's Dijkstra's\n</work>"
        ));
        assert!(graded.contains("- Answers each follow-up question soundly\n"));
        assert!(graded.contains("explained this aloud in part"));
        assert!(graded.contains("<reference>\nIt visits nodes in order of their distance"));

        // It's the card's attempt, with what the grader found in the mistake log.
        let deck = json(send(&router, request("GET", "/api/learning/deck", None)).await).await;
        assert_eq!(
            deck["schedules"]["sample/breadth-first-shortest-paths"]["reviews"],
            1
        );
        assert_eq!(deck["follow_ups"], serde_json::json!([]));
        let log = json(send(&router, request("GET", "/api/mistakes", None)).await).await;
        let found = log["mistakes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["detail"] == "Couldn't say why removing is logarithmic")
            .unwrap();
        assert_eq!(found["source"], "grader");
        assert_eq!(found["suggested"], "concept-gap");
        // And it's over: nothing more can be said, and it's not under way.
        let opened = json(send(&router, request("GET", BFS, None)).await).await;
        assert_eq!(opened["exchange"], serde_json::Value::Null);
        let late = serde_json::json!({ "exchange": ID, "question": 1, "text": "More" });
        assert_eq!(
            status(&router, &format!("{BFS}/reply"), late).await,
            StatusCode::CONFLICT
        );
    }

    #[tokio::test]
    async fn takes_what_was_sent_again_after_a_lost_reply_once() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        let started = start(&router, BFS, ID, "Layer by layer").await;
        // Started again with the same id, as after its reply was lost, it's the same exchange,
        // with no new question.
        assert_eq!(start(&router, BFS, ID, "Layer by layer").await, started);
        // As it is from another device, or a second tap, with an answer of its own, which
        // isn't taken as a reply to a question it never saw.
        let elsewhere = start(
            &router,
            BFS,
            "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a79",
            "Something else",
        )
        .await;
        assert_eq!(elsewhere, started);
        assert_eq!(asked(dir.path()), 1);

        let replied = reply(&router, BFS, 0, "Nearer first", false).await;
        assert_eq!(replied["questions"][1]["text"], "Question 2: why is that?");
        // The first reply sent again, as after its reply was lost, isn't filed under the
        // second question.
        let again = reply(&router, BFS, 0, "Nearer first", false).await;
        assert_eq!(again, replied);
        assert_eq!(asked(dir.path()), 2);
        // Nor is anything else said to a question answered already, or not asked yet.
        for (question, text) in [(0, "Something else"), (2, "Too soon")] {
            let wrong = serde_json::json!({ "exchange": ID, "question": question, "text": text });
            assert_eq!(
                status(&router, &format!("{BFS}/reply"), wrong).await,
                StatusCode::BAD_REQUEST
            );
        }
        // Nor anything for another exchange.
        let other = serde_json::json!({ "exchange": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a79", "question": 1, "text": "Mine" });
        assert_eq!(
            status(&router, &format!("{BFS}/reply"), other).await,
            StatusCode::CONFLICT
        );
        let opened = json(send(&router, request("GET", BFS, None)).await).await;
        assert_eq!(opened["exchange"], replied);

        // Marked twice, as after its reply was lost, it's marked once, with the same marks.
        let finish = || async {
            post(
                &router,
                &format!("{BFS}/finish"),
                serde_json::json!({ "exchange": ID }),
            )
            .await
        };
        let (first, second) = tokio::join!(finish(), finish());
        assert_eq!(first["marked"], second["marked"]);
        assert_eq!(finish().await["marked"], first["marked"]);
        let graded = std::fs::read_to_string(dir.path().join("graded-times")).unwrap();
        assert_eq!(graded.lines().count(), 1);
        let deck = json(send(&router, request("GET", "/api/learning/deck", None)).await).await;
        assert_eq!(
            deck["schedules"]["sample/breadth-first-shortest-paths"]["reviews"],
            1
        );
        let log = json(send(&router, request("GET", "/api/mistakes", None)).await).await;
        assert_eq!(log["mistakes"].as_array().unwrap().len(), 1);
        // Started again with the id of the exchange marked, it's refused rather than started
        // afresh; with a new id, it starts afresh.
        let restart = serde_json::json!({ "id": ID, "text": "Layer by layer" });
        assert_eq!(
            status(&router, &format!("{BFS}/start"), restart).await,
            StatusCode::CONFLICT
        );
        let fresh = start(
            &router,
            BFS,
            "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a7a",
            "Again",
        )
        .await;
        assert_eq!(fresh["answer"]["text"], "Again");
    }

    #[tokio::test]
    async fn keeps_what_was_said_when_the_tutor_cant_be_reached() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        std::fs::write(dir.path().join("away"), "").unwrap();
        let body = serde_json::json!({ "id": ID, "text": "Log n to add" });
        assert_eq!(
            status(&router, &format!("{HEAP}/start"), body).await,
            StatusCode::BAD_REQUEST
        );
        let opened = json(send(&router, request("GET", HEAP, None)).await).await;
        assert_eq!(opened["exchange"]["answer"]["text"], "Log n to add");
        assert_eq!(opened["exchange"]["next"], "ask");
        // Asked again, it carries on.
        std::fs::remove_file(dir.path().join("away")).unwrap();
        let asked = post(
            &router,
            &format!("{HEAP}/ask"),
            serde_json::json!({ "exchange": ID }),
        )
        .await;
        assert_eq!(asked["questions"][0]["text"], "Question 1: why is that?");
        // The card asks for one question. A reply the learner hasn't sent is sent before it's
        // marked, without the tutor being asked for another.
        let sent = post(
            &router,
            &format!("{HEAP}/reply"),
            serde_json::json!({ "exchange": ID, "question": 0, "text": "One path", "ask": false }),
        )
        .await;
        assert_eq!(sent["next"], "mark");
        let marked = post(
            &router,
            &format!("{HEAP}/finish"),
            serde_json::json!({ "exchange": ID }),
        )
        .await;
        assert_eq!(marked["marked"]["score"], 0.7);
        let graded = std::fs::read_to_string(dir.path().join("graded")).unwrap();
        assert!(graded.contains("Learner: One path\n</work>"));
        // Written throughout, it's not marked for clarity.
        assert!(!graded.contains("aloud"));
    }

    #[tokio::test]
    async fn can_be_marked_before_every_question_is_answered() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        start(&router, BFS, ID, "Layer by layer").await;
        post(
            &router,
            &format!("{BFS}/finish"),
            serde_json::json!({ "exchange": ID }),
        )
        .await;
        let graded = std::fs::read_to_string(dir.path().join("graded")).unwrap();
        assert!(graded.contains("Learner: (Not answered.)\n</work>"));
    }

    #[tokio::test]
    async fn ends_follow_ups_once_the_card_is_answered_or_flagged_whatever_its_clock() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        let sync = |body: serde_json::Value| {
            let router = router.clone();
            async move { post(&router, "/api/learning/sync", body).await }
        };
        // An attempt made before they started, offline, on a phone whose clock is ahead, and
        // sent only now, doesn't end them: it had been made by the time they started.
        let early = serde_json::json!({ "attempts": [{
            "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a73",
            "item": "sample/breadth-first-shortest-paths",
            "answered_at": crate::learning::now_ms() + 3_600_000,
            "duration_ms": 1000,
            "rating": "good",
        }] });
        sync(early).await;
        start(&router, BFS, ID, "Layer by layer").await;
        let deck = json(send(&router, request("GET", "/api/learning/deck", None)).await).await;
        assert_eq!(
            deck["follow_ups"],
            serde_json::json!(["sample/breadth-first-shortest-paths"])
        );
        // Rated by the learner instead, on a phone whose clock is behind, they're over.
        let rated = serde_json::json!({ "attempts": [{
            "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a74",
            "item": "sample/breadth-first-shortest-paths",
            "answered_at": crate::learning::now_ms() - 7_200_000,
            "duration_ms": 1000,
            "rating": "good",
        }] });
        let deck = sync(rated).await;
        assert_eq!(deck["follow_ups"], serde_json::json!([]));
        let opened = json(send(&router, request("GET", BFS, None)).await).await;
        assert_eq!(opened["exchange"], serde_json::Value::Null);
        // A reply sent now says they're over, rather than starting them again.
        let late = serde_json::json!({ "exchange": ID, "question": 0, "text": "Nearer first" });
        assert_eq!(
            status(&router, &format!("{BFS}/reply"), late).await,
            StatusCode::CONFLICT
        );
        assert_eq!(
            json(send(&router, request("GET", BFS, None)).await).await["exchange"],
            serde_json::Value::Null
        );

        // Flagged as wrong, which records no attempt, they're over too.
        start(&router, HEAP, ID, "Log n").await;
        let flag = serde_json::json!({ "flags": [{
            "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a75",
            "item": "sample/binary-heap-costs",
            "at": crate::learning::now_ms() - 7_200_000,
            "flagged": true,
        }] });
        let deck = sync(flag).await;
        assert_eq!(deck["follow_ups"], serde_json::json!([]));
        let finish = serde_json::json!({ "exchange": ID });
        assert_eq!(
            status(&router, &format!("{HEAP}/finish"), finish).await,
            StatusCode::CONFLICT
        );
    }

    #[tokio::test]
    async fn records_no_attempt_for_follow_ups_ended_while_they_were_marked() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        start(&router, BFS, ID, "Layer by layer").await;
        // Rated on another device while the grader's marking, the card's answered already.
        let rated = serde_json::json!({ "attempts": [{
            "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a77",
            "item": "sample/breadth-first-shortest-paths",
            "answered_at": crate::learning::now_ms(),
            "duration_ms": 1000,
            "rating": "good",
        }] });
        let path = format!("{BFS}/finish");
        let finish = status(&router, &path, serde_json::json!({ "exchange": ID }));
        let rate = async {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            post(&router, "/api/learning/sync", rated).await
        };
        let (finished, _) = tokio::join!(finish, rate);
        assert_eq!(finished, StatusCode::CONFLICT);
        let deck = json(send(&router, request("GET", "/api/learning/deck", None)).await).await;
        assert_eq!(
            deck["schedules"]["sample/breadth-first-shortest-paths"]["reviews"],
            1
        );
        let log = json(send(&router, request("GET", "/api/mistakes", None)).await).await;
        assert_eq!(log["mistakes"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn keeps_marks_to_give_again_until_follow_ups_start_afresh() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        start(&router, HEAP, ID, "Log n").await;
        let finish = serde_json::json!({ "exchange": ID });
        let marked = post(&router, &format!("{HEAP}/finish"), finish.clone()).await;
        // A start that can't be taken, with nothing in it, or an id that isn't one, leaves the
        // marks to give again.
        for body in [
            serde_json::json!({ "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a78", "text": " " }),
            serde_json::json!({ "id": "../x", "text": "Log n" }),
        ] {
            assert_eq!(
                status(&router, &format!("{HEAP}/start"), body).await,
                StatusCode::BAD_REQUEST
            );
        }
        let again = post(&router, &format!("{HEAP}/finish"), finish).await;
        assert_eq!(again["marked"], marked["marked"]);
        // Nor can follow-ups start on a card flagged as wrong.
        let flag = serde_json::json!({ "flags": [{
            "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a79",
            "item": "sample/breadth-first-shortest-paths",
            "at": crate::learning::now_ms(),
            "flagged": true,
        }] });
        post(&router, "/api/learning/sync", flag).await;
        let flagged = serde_json::json!({ "id": ID, "text": "Layer by layer" });
        assert_eq!(
            status(&router, &format!("{BFS}/start"), flagged).await,
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn only_follows_up_cards_that_offer_it() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        let body = || serde_json::json!({ "id": ID, "text": "Equal keys keep their order" });
        assert_eq!(
            status(
                &router,
                "/api/cards/sample/stable-sorting/follow-ups/start",
                body()
            )
            .await,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            status(
                &router,
                "/api/cards/sample/islands/follow-ups/start",
                body()
            )
            .await,
            StatusCode::BAD_REQUEST
        );
        // Nor can follow-ups be marked as other work is, without what was said.
        let mark = serde_json::json!({
            "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a76",
            "work": "follow_ups",
            "text": "x",
        });
        assert_eq!(
            status(&router, "/api/items/sample/stable-sorting/mark", mark).await,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(asked(dir.path()), 0);
    }
}
