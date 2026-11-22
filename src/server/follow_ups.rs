//! Follow-up questions on cards: the learner's answer in their own words, then the tutor's
//! questions about it, each saved as it's given, and the whole exchange marked by the grader at
//! the end, as the card's attempt.

use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use workshop_learning::Attempt;
use workshop_pack::{Content, FollowUps, Item, Pack};
use workshop_provider::{CallSpec, ProviderRunner};

use super::error::{ApiError, ApiResult, bad_request};
use super::grading::{MarkedReply, due, find, packs};
use super::state::Shared;
use crate::follow_ups::{Exchange, Next, TUTOR};
use crate::grader::{Answer, Work};
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

/// An exchange as the app sees it, with what happens next.
#[derive(Serialize)]
pub(super) struct ExchangeView {
    #[serde(flatten)]
    exchange: Exchange,
    next: Next,
}

impl From<Exchange> for ExchangeView {
    fn from(exchange: Exchange) -> Self {
        Self {
            next: exchange.next(),
            exchange,
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct AnswerBody {
    /// The learner's answer to the card, which starts the exchange, or their reply to the
    /// question waiting. None asks the tutor again for a question it couldn't ask before.
    #[serde(default)]
    text: Option<String>,
    /// Whether it was explained aloud, so `text` is what was heard.
    #[serde(default)]
    spoken: bool,
}

/// Adds what the learner said, saving it: their answer to the card, which starts the exchange,
/// or their reply to the tutor's question. Then the tutor asks its next question, if it has one
/// to ask. If it can't be reached, what the learner said is kept, and asking again carries on.
pub(super) async fn answer(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Json(body): Json<AnswerBody>,
) -> ApiResult<ExchangeView> {
    let packs = packs(&app)?;
    let (pack, key, item, limit) = card(&packs, &pack, &item)?;
    // Without a tutor to ask, nothing's started.
    let (runner, spec) = tutor(&app, pack)?;
    let exchanges = app.learning.exchanges();
    let now = now_ms();
    let said = body
        .text
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty());
    let exchange = match (app.learning.follow_ups(&key)?, said) {
        (None, Some(text)) => {
            let started = Exchange::new(limit, text, body.spoken, now)
                .map_err(|err| bad_request(err.to_string()))?;
            exchanges.put_new(&key, started)?
        }
        (None, None) => return Err(bad_request("Answer the card before it's followed up.")),
        (Some(_), Some(text)) => {
            let (exchange, spent) = exchanges
                .change(&key, |exchange| {
                    let spent = workshop_sessions::spent(exchange.updated_at, now);
                    exchange.replied(text, body.spoken, now)?;
                    Ok(spent)
                })
                .map_err(|err| bad_request(format!("{err:#}")))?
                .ok_or_else(|| bad_request("The follow-ups ended before the answer was saved."))?;
            app.learning.store().record_time(&key, now, spent)?;
            exchange
        }
        (Some(exchange), None) => exchange,
    };
    if exchange.next() != Next::Ask {
        return Ok(Json(exchange.into()));
    }
    let question = crate::follow_ups::ask(runner, &spec, item, &exchange)
        .await
        .map_err(|err| bad_request(format!("{err:#}")))?;
    let (exchange, ()) = exchanges
        .change(&key, |exchange| Ok(exchange.asked(&question, now_ms())?))
        .map_err(|err| bad_request(format!("{err:#}")))?
        .ok_or_else(|| bad_request("The follow-ups ended while the tutor was asking."))?;
    Ok(Json(exchange.into()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct FinishBody {
    /// Made by the app, for the attempt this records.
    id: String,
}

/// Has the grader mark the whole exchange, against the card's answer and explanation, for how
/// deeply the learner understands it as well as whether they're right, and for clarity where
/// they explained aloud. It's the card's attempt, rated from the score, with what the grader
/// finds in the mistake log; then the exchange is over. It can be marked before every question's
/// been answered, which the grader is told.
pub(super) async fn finish(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Json(body): Json<FinishBody>,
) -> ApiResult<MarkedReply> {
    let packs = packs(&app)?;
    let (pack, key, item, _) = card(&packs, &pack, &item)?;
    if app
        .learning
        .store()
        .attempts(&key)?
        .iter()
        .any(|a| a.id == body.id)
    {
        return Err(bad_request("Those follow-ups have been marked already."));
    }
    let exchange = app
        .learning
        .follow_ups(&key)?
        .ok_or_else(|| bad_request("There are no follow-up questions under way on that card."))?;
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
    let now = now_ms();
    let findings = marked.mistakes(&body.id, &key, now);
    app.learning.record_marked(
        Attempt {
            id: body.id,
            item: key.clone(),
            answered_at: now,
            duration_ms: workshop_sessions::spent(exchange.updated_at, now),
            rating: marked.rating(),
            response: Some(transcript),
            seed: None,
        },
        &findings,
        now,
    )?;
    app.learning.exchanges().remove(&key)?;
    Ok(Json(MarkedReply {
        rubric: marked.points.iter().map(|p| p.point.clone()).collect(),
        due: due(&app, &key)?,
        marked,
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
  *'<work>'*) printf '%s' "$prompt" > '{graded}'; cat '{mark}' ;;
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

    #[tokio::test]
    async fn follows_up_a_card_then_marks_the_whole_exchange_as_its_attempt() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        let opened = json(send(&router, request("GET", BFS, None)).await).await;
        assert_eq!(opened["exchange"], serde_json::Value::Null);
        // There's nothing to follow up before the card's answered.
        let early = send(
            &router,
            request("POST", BFS, Some(serde_json::json!({ "text": " " }))),
        )
        .await;
        assert_eq!(early.status(), StatusCode::BAD_REQUEST);

        let started = post(
            &router,
            BFS,
            serde_json::json!({ "text": "It goes out a layer at a time" }),
        )
        .await;
        assert_eq!(started["limit"], 2);
        assert_eq!(started["answer"]["text"], "It goes out a layer at a time");
        assert_eq!(started["answer"]["spoken"], false);
        assert_eq!(started["questions"][0]["text"], "Question 1: why is that?");
        assert_eq!(started["next"], "reply");
        // Saved, so opened again, as after closing the app, it's where it was.
        let opened = json(send(&router, request("GET", BFS, None)).await).await;
        assert_eq!(opened["exchange"], started);
        // And the deck says so, for the app to carry on with it first.
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

        let replied = post(
            &router,
            BFS,
            serde_json::json!({ "text": "the queue keeps nearer ones first", "spoken": true }),
        )
        .await;
        assert_eq!(replied["questions"][0]["reply"]["spoken"], true);
        assert_eq!(replied["questions"][1]["text"], "Question 2: why is that?");
        let last = post(
            &router,
            BFS,
            serde_json::json!({ "text": "With weights it's Dijkstra's" }),
        )
        .await;
        // Two questions is all the card asks for, so it's ready to mark.
        assert_eq!(last["questions"].as_array().unwrap().len(), 2);
        assert_eq!(last["next"], "mark");
        let more = send(
            &router,
            request("POST", BFS, Some(serde_json::json!({ "text": "And more" }))),
        )
        .await;
        assert_eq!(more.status(), StatusCode::BAD_REQUEST);

        let id = "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a71";
        let marked = post(
            &router,
            &format!("{BFS}/finish"),
            serde_json::json!({ "id": id }),
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
        // And it's over.
        let opened = json(send(&router, request("GET", BFS, None)).await).await;
        assert_eq!(opened["exchange"], serde_json::Value::Null);
        let again = send(
            &router,
            request(
                "POST",
                &format!("{BFS}/finish"),
                Some(serde_json::json!({ "id": id })),
            ),
        )
        .await;
        assert_eq!(again.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn keeps_what_was_said_when_the_tutor_cant_be_reached() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        std::fs::write(dir.path().join("away"), "").unwrap();
        let away = send(
            &router,
            request(
                "POST",
                HEAP,
                Some(serde_json::json!({ "text": "Log n to add" })),
            ),
        )
        .await;
        assert_eq!(away.status(), StatusCode::BAD_REQUEST);
        let opened = json(send(&router, request("GET", HEAP, None)).await).await;
        assert_eq!(opened["exchange"]["answer"]["text"], "Log n to add");
        assert_eq!(opened["exchange"]["next"], "ask");
        // Asked again, it carries on.
        std::fs::remove_file(dir.path().join("away")).unwrap();
        let asked = post(&router, HEAP, serde_json::json!({})).await;
        assert_eq!(asked["questions"][0]["text"], "Question 1: why is that?");
        // The card asks for one question, so it can be marked once that's answered, or before.
        assert_eq!(asked["next"], "reply");
        let marked = post(
            &router,
            &format!("{HEAP}/finish"),
            serde_json::json!({ "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a72" }),
        )
        .await;
        assert_eq!(marked["marked"]["score"], 0.7);
        let graded = std::fs::read_to_string(dir.path().join("graded")).unwrap();
        assert!(graded.contains("Learner: (Not answered.)\n</work>"));
        // Written throughout, it's not marked for clarity.
        assert!(!graded.contains("aloud"));
    }

    #[tokio::test]
    async fn ends_follow_ups_once_the_card_is_answered_some_other_way() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        post(
            &router,
            BFS,
            serde_json::json!({ "text": "Layer by layer" }),
        )
        .await;
        // Rated by the learner instead, such as offline, the follow-ups are over.
        let attempt = serde_json::json!({ "attempts": [{
            "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a73",
            "item": "sample/breadth-first-shortest-paths",
            "answered_at": crate::learning::now_ms(),
            "duration_ms": 1000,
            "rating": "good",
        }] });
        let deck = post(&router, "/api/learning/sync", attempt).await;
        assert_eq!(deck["follow_ups"], serde_json::json!([]));
        let opened = json(send(&router, request("GET", BFS, None)).await).await;
        assert_eq!(opened["exchange"], serde_json::Value::Null);
        assert!(
            !dir.path()
                .join("data/follow-ups/sample/breadth-first-shortest-paths.json")
                .exists()
        );
    }

    #[tokio::test]
    async fn only_follows_up_cards_that_offer_it() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        let body = || Some(serde_json::json!({ "text": "Equal keys keep their order" }));
        let none = send(
            &router,
            request(
                "POST",
                "/api/cards/sample/stable-sorting/follow-ups",
                body(),
            ),
        )
        .await;
        assert_eq!(none.status(), StatusCode::BAD_REQUEST);
        let problem = send(
            &router,
            request("POST", "/api/cards/sample/islands/follow-ups", body()),
        )
        .await;
        assert_eq!(problem.status(), StatusCode::BAD_REQUEST);
        // Nor can follow-ups be marked as other work is, without what was said.
        let mark = send(
            &router,
            request(
                "POST",
                "/api/items/sample/stable-sorting/mark",
                Some(serde_json::json!({
                    "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a74",
                    "work": "follow_ups",
                    "text": "x",
                })),
            ),
        )
        .await;
        assert_eq!(mark.status(), StatusCode::BAD_REQUEST);
        assert!(!dir.path().join("asked").exists());
    }
}
