//! The grader: marking work, written or explained aloud, and checking cards flagged as wrong,
//! with fixes for the learner to approve.

use anyhow::Context;
use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use workshop_learning::{Attempt, FlagChange};
use workshop_pack::{Content, Item, Pack};

use super::error::{ApiError, ApiResult, bad_request};
use super::state::Shared;
use crate::grader::{Answer, Fix, Marked, Proposed, Review, Verdict, Work};
use crate::learning::now_ms;

pub(super) fn packs(app: &Shared) -> Result<Vec<Pack>, ApiError> {
    Ok(crate::packs::load(&app.config.learning)?)
}

pub(super) fn find<'a>(
    packs: &'a [Pack],
    pack: &str,
    item: &str,
) -> Result<(&'a Pack, &'a Item), ApiError> {
    packs
        .iter()
        .find(|p| p.manifest.id == pack)
        .and_then(|p| p.item(item).map(|item| (p, item)))
        .ok_or_else(|| {
            ApiError(
                StatusCode::NOT_FOUND,
                serde_json::json!({ "error": format!("there's no item {pack}/{item}") }),
            )
        })
}

/// When an item comes back, as it's now scheduled, in milliseconds since 1970, if it's been
/// attempted.
pub(super) fn due(app: &Shared, key: &str) -> Result<Option<i64>, ApiError> {
    let store = app.learning.store();
    Ok(store.schedules()?.get(key).map(|schedule| {
        store
            .scheduler()
            .due(schedule, app.config.learning.desired_retention)
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct MarkBody {
    /// Made by the app, for the attempt this records, if it records one.
    id: String,
    work: Work,
    text: String,
    /// Whether it was explained aloud, so `text` is what was heard.
    #[serde(default)]
    spoken: bool,
}

#[derive(Serialize)]
pub(super) struct MarkedReply {
    pub(super) marked: Marked,
    /// The rubric's points, now it's been marked against them.
    pub(super) rubric: Vec<String>,
    /// When it comes back, for work that counts as an attempt, in milliseconds since 1970.
    pub(super) due: Option<i64>,
    /// The attempt it was recorded as, for work that counts as one, so the device can count it
    /// before its deck, which it fetches afterwards, has it.
    pub(super) attempt: Option<Attempt>,
}

/// Marks a piece of work, written or explained aloud, with the grader. What it finds goes in
/// the mistake log; a design or a card's answer also counts as an attempt, rated from the
/// score, which schedules the item and feeds mastery. A coding problem's plan and explanation
/// don't: its attempt is its own, when it's finished.
pub(super) async fn mark(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Json(body): Json<MarkBody>,
) -> ApiResult<MarkedReply> {
    let packs = packs(&app)?;
    let (pack, item) = find(&packs, &pack, &item)?;
    let key = format!("{}/{}", pack.manifest.id, item.id);
    if body.work == Work::FollowUps {
        return Err(bad_request(
            "A card's follow-ups are marked when they're finished, with what was said.",
        ));
    }
    if body.work == Work::Review {
        return Err(bad_request(
            "A review is marked when it's submitted, with its comments.",
        ));
    }
    // An explanation of a solution is marked with the solution it explains: its code, or in a
    // project, the learner's changes to it.
    let (code, changes) = if body.work == Work::Explanation {
        let found = crate::coding::find(&packs, &pack.manifest.id, &item.id)
            .map_err(|err| bad_request(format!("{err:#}")))?;
        let session = app
            .problems
            .session_for(&found)?
            .ok_or_else(|| bad_request("Start the problem before explaining it."))?;
        match found.coding.project() {
            Some(_) => (None, Some(app.problems.project_diff(&found, session.part)?)),
            None => {
                let draft = app.problems.draft(&found, session.language)?;
                (Some((session.language.name(), draft.text)), None)
            }
        }
    } else {
        (None, None)
    };
    // A plan for a problem in parts is for the part the learner is on.
    let part = match (body.work, &item.content) {
        (Work::Plan, Content::Coding(coding)) if coding.in_parts() => {
            let found = crate::coding::find(&packs, &pack.manifest.id, &item.id)
                .map_err(|err| bad_request(format!("{err:#}")))?;
            app.problems
                .session_for(&found)?
                .filter(|session| session.mode == crate::coding::Mode::Solve)
                .map(|session| session.part)
        }
        _ => None,
    };
    let answer = Answer {
        spoken: body.spoken,
        code: code.as_ref().map(|(name, text)| (*name, text.as_str())),
        changes: changes.as_deref(),
        part,
        ..Answer::written(&body.text)
    };
    let error_types = crate::mistakes::error_types(&packs);
    let (runner, spec) =
        app.grader_target(pack.prompt_add_ons.get("grader").map(String::as_str))?;
    let started = now_ms();
    let marked = crate::grader::mark(runner, &spec, item, body.work, answer, &error_types)
        .await
        .map_err(|err| bad_request(format!("{err:#}")))?;
    let now = now_ms();
    let findings = marked.mistakes(&body.id, &key, now);
    let (due, attempt) = if body.work.is_attempt() {
        let attempt = Attempt {
            id: body.id,
            item: key.clone(),
            answered_at: now,
            duration_ms: now - started,
            rating: marked.rating(),
            response: Some(body.text),
            seed: None,
        };
        app.learning
            .record_marked(attempt.clone(), &findings, now)?;
        (due(&app, &key)?, Some(attempt))
    } else {
        if body.work.logs_mistakes() {
            app.learning.store().record_mistakes(&findings)?;
        }
        (None, None)
    };
    if body.work == Work::Design {
        crate::tracks::done_long(
            &app.paths.data_dir,
            workshop_tracks::TrackId::SystemDesign,
            now,
        )?;
    }
    let rubric = match &item.content {
        Content::Design { rubric, .. } => rubric.clone(),
        _ => marked.points.iter().map(|p| p.point.clone()).collect(),
    };
    Ok(Json(MarkedReply {
        marked,
        rubric,
        due,
        attempt,
    }))
}

#[derive(Serialize)]
pub(super) struct Flagged {
    cards: Vec<FlaggedCard>,
}

#[derive(Serialize)]
pub(super) struct FlaggedCard {
    key: String,
    label: String,
    prompt: String,
    answer: String,
    explanation: Option<String>,
    note: Option<String>,
    at: i64,
    /// A fix the grader proposed, waiting for approval.
    proposed: Option<Proposed>,
}

/// Cards flagged as wrong, with any fixes the grader has proposed for them.
pub(super) async fn flagged(State(app): State<Shared>) -> ApiResult<Flagged> {
    let packs = packs(&app)?;
    let items = crate::mistakes::items_by_key(&packs);
    let mut proposals = app.card_fixes.all()?;
    let cards = app
        .learning
        .store()
        .flags()?
        .into_iter()
        .filter_map(|(key, flag)| {
            let item = items.get(&key)?;
            let Content::Card {
                answer,
                explanation,
                ..
            } = &item.content
            else {
                return None;
            };
            Some(FlaggedCard {
                label: item.label(),
                prompt: item.prompt.clone(),
                answer: answer.clone(),
                explanation: explanation.clone(),
                note: flag.note,
                at: flag.at,
                proposed: proposals.remove(&key),
                key,
            })
        })
        .collect();
    Ok(Json(Flagged { cards }))
}

#[derive(Serialize)]
pub(super) struct Reviewed {
    review: Review,
    /// Whether the card's flag was cleared, as the grader found it right.
    cleared: bool,
}

/// A flag change's id, made from the item and when, as flag changes need ids of their own.
fn flag_change_id(what: &str, key: &str, at: i64) -> String {
    // FNV-1a, so the same change always has the same id.
    let hash = key.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
    });
    format!("{what}-{hash:016x}-{at}")
}

/// Has the grader check a card. A flagged card it finds right has its flag cleared, and one it
/// finds wrong gets a proposed fix, waiting for the learner's approval.
pub(super) async fn review(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
) -> ApiResult<Reviewed> {
    let packs = packs(&app)?;
    let (pack, item) = find(&packs, &pack, &item)?;
    let key = format!("{}/{}", pack.manifest.id, item.id);
    let flag = app.learning.store().flags()?.remove(&key);
    let (runner, spec) =
        app.grader_target(pack.prompt_add_ons.get("grader").map(String::as_str))?;
    let review = crate::grader::review(
        runner,
        &spec,
        item,
        flag.as_ref().and_then(|f| f.note.as_deref()),
    )
    .await
    .map_err(|err| bad_request(format!("{err:#}")))?;
    let now = now_ms();
    let mut cleared = false;
    match review.verdict {
        Verdict::Correct => {
            app.card_fixes.remove(&key)?;
            if flag.is_some() {
                app.learning.store().record_flags(&[FlagChange {
                    id: flag_change_id("reviewed", &key, now),
                    item: key.clone(),
                    at: now,
                    flagged: false,
                    note: Some(format!("Checked by the grader: {}", review.explanation)),
                }])?;
                cleared = true;
            }
        }
        Verdict::Wrong => app.card_fixes.propose(
            &key,
            Proposed {
                review: review.clone(),
                at: now,
            },
        )?,
    }
    Ok(Json(Reviewed { review, cleared }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct FixBody {
    approve: bool,
}

#[derive(Serialize)]
pub(super) struct Fixed {
    /// The commit the fix was made in, if the pack is a git repo and it was approved.
    commit: Option<String>,
}

/// Approves the grader's fix for a card, which changes the card's file in the pack, commits it
/// if the pack is a git repo, and clears its flag; or turns the fix down.
pub(super) async fn fix(
    State(app): State<Shared>,
    Path((pack, item)): Path<(String, String)>,
    Json(body): Json<FixBody>,
) -> ApiResult<Fixed> {
    let key = format!("{pack}/{item}");
    let Some(proposed) = app.card_fixes.all()?.remove(&key) else {
        return Err(bad_request("There's no fix waiting for that card."));
    };
    if !body.approve {
        app.card_fixes.remove(&key)?;
        return Ok(Json(Fixed { commit: None }));
    }
    let fix: &Fix = proposed
        .review
        .fix
        .as_ref()
        .ok_or_else(|| bad_request("The grader proposed no fix for that card."))?;
    let dir = crate::pack_files::pack_dir(&app.config.learning, &pack)
        .map_err(|err| bad_request(format!("{err:#}")))?;
    let loaded = Pack::load(&dir)?;
    let card = loaded
        .item(&item)
        .ok_or_else(|| bad_request(format!("there's no item {key}")))?;
    let path = dir.join(&card.path);
    let before =
        std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    let after = crate::grader::apply_fix(&before, fix);
    workshop_common::files::write_atomic(&path, after.as_bytes())?;
    // A fix that leaves the card unreadable is undone, rather than losing the card.
    let reloaded = Pack::load(&dir)?;
    if reloaded.item(&item).is_none() {
        workshop_common::files::write_atomic(&path, before.as_bytes())?;
        let why = reloaded
            .problems
            .iter()
            .find(|p| p.path == card.path)
            .map_or_else(String::new, |p| format!(": {}", p.message));
        return Err(bad_request(format!(
            "The fix would have left the card unreadable, so it wasn't made{why}"
        )));
    }
    let commit = crate::pack_files::commit(
        &dir,
        std::slice::from_ref(&card.path),
        &format!("Fix the card \"{}\"", card.label()),
    )
    .await?;
    app.card_fixes.remove(&key)?;
    let now = now_ms();
    app.learning.store().record_flags(&[FlagChange {
        id: flag_change_id("fixed", &key, now),
        item: key,
        at: now,
        flagged: false,
        note: Some("Fixed as the grader proposed".to_owned()),
    }])?;
    Ok(Json(Fixed { commit }))
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

    const MARKED: &str = r#"{"score": 0.65, "points": [{"point": "Estimates", "met": "partly", "comment": "No storage estimate"}], "findings": [{"error_type": "missed-edge-case", "detail": "Says nothing of codes that collide"}], "feedback": "Size the store, and handle collisions."}"#;
    const SPOKEN: &str = r#"{"score": 0.9, "points": [{"point": "Gives the card's answer, in any words", "met": "yes", "comment": ""}], "findings": [], "feedback": "Right.", "clarity": {"score": 0.5, "feedback": "Lead with the answer."}}"#;
    const WRONG: &str = r#"{"verdict": "wrong", "explanation": "Removing the smallest is logarithmic.", "fix": {"answer": "O(log n), as the last item sinks from the root.", "explanation": null}}"#;
    const CORRECT: &str = r#"{"verdict": "correct", "explanation": "The card is right."}"#;

    /// A server learning from a copy of the sample pack, in a git repo, with a stand-in grader.
    fn app(dir: &std::path::Path) -> Router {
        let pack = dir.join("pack");
        crate::pack_files::testing::sample_pack_repo(&pack);
        for (file, text) in [
            ("spoken.json", SPOKEN),
            ("mark.json", MARKED),
            ("wrong.json", WRONG),
            ("correct.json", CORRECT),
        ] {
            std::fs::write(dir.join(file), text).unwrap();
        }
        let model = fake_discussion_model(
            dir,
            &[
                ("explained this aloud", "spoken.json"),
                ("<work>", "mark.json"),
                ("flagged this card as wrong, saying", "wrong.json"),
                ("Check this card", "correct.json"),
            ],
        );
        test_app_in(
            dir,
            &format!(
                "{model}\n[learning]\npacks = [{:?}]\n",
                pack.display().to_string()
            ),
        )
    }

    #[tokio::test]
    async fn marks_a_design_and_counts_it_as_an_attempt() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        let list =
            json(send(&router, request("GET", "/api/design?utc_offset=0", None)).await).await;
        let items = list["items"].as_array().unwrap();
        assert_eq!(items.len(), 4);
        assert_eq!(items[0]["status"], "new");
        let opened = json(
            send(
                &router,
                request("GET", "/api/design/sample/link-shortener", None),
            )
            .await,
        )
        .await;
        assert!(
            opened["prompt"]
                .as_str()
                .unwrap()
                .starts_with("Design a service")
        );
        // The rubric isn't shown before it's answered.
        assert!(opened.get("rubric").is_none());

        let body = serde_json::json!({
            "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a31",
            "work": "design",
            "text": "Hash the link into a code, and keep codes in a table.",
        });
        let marked = json(
            send(
                &router,
                request("POST", "/api/items/sample/link-shortener/mark", Some(body)),
            )
            .await,
        )
        .await;
        assert_eq!(marked["marked"]["score"], 0.65);
        assert_eq!(marked["rubric"].as_array().unwrap().len(), 5);
        assert!(marked["due"].as_i64().is_some());
        let log = json(send(&router, request("GET", "/api/mistakes", None)).await).await;
        assert_eq!(log["mistakes"][0]["source"], "grader");
        assert_eq!(log["mistakes"][0]["suggested"], "missed-edge-case");

        let list =
            json(send(&router, request("GET", "/api/design?utc_offset=0", None)).await).await;
        let shortener = list["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["key"] == "sample/link-shortener")
            .unwrap();
        assert_eq!(shortener["status"], "done");
        assert_eq!(shortener["last_score"], 0.7);
        let opened = json(
            send(
                &router,
                request("GET", "/api/design/sample/link-shortener", None),
            )
            .await,
        )
        .await;
        assert!(
            opened["previous"]
                .as_str()
                .unwrap()
                .starts_with("Hash the link")
        );

        // A coding plan is marked, and only its mistakes are kept: the problem's attempt comes
        // when it's finished.
        let plan = serde_json::json!({
            "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a32",
            "work": "plan",
            "text": "Look at each square, and fill each island I find",
        });
        let marked = json(
            send(
                &router,
                request("POST", "/api/items/sample/islands/mark", Some(plan)),
            )
            .await,
        )
        .await;
        assert_eq!(marked["due"], serde_json::Value::Null);
        assert_eq!(marked["attempt"], serde_json::Value::Null);
        let deck = json(send(&router, request("GET", "/api/learning/deck", None)).await).await;
        assert!(deck["schedules"].get("sample/islands").is_none());
        let log = json(send(&router, request("GET", "/api/mistakes", None)).await).await;
        assert_eq!(log["mistakes"].as_array().unwrap().len(), 2);

        let mismatched = serde_json::json!({ "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a33", "work": "design", "text": "x" });
        let response = send(
            &router,
            request("POST", "/api/items/sample/islands/mark", Some(mismatched)),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn marks_with_the_graders_own_model_if_one_is_chosen() {
        let dir = tempfile::tempdir().unwrap();
        let pack = dir.path().join("pack");
        crate::pack_files::testing::sample_pack_repo(&pack);
        std::fs::write(dir.path().join("mark.json"), MARKED).unwrap();
        let model = fake_discussion_model(dir.path(), &[("<work>", "mark.json")]);
        let graded = r#"{"score": 0.4, "points": [], "findings": [], "feedback": "From the grader's own model."}"#;
        std::fs::write(dir.path().join("graded.json"), graded).unwrap();
        let grader = dir.path().join("grader.sh");
        std::fs::write(
            &grader,
            format!(
                "cat > /dev/null\ncat {:?}\n",
                dir.path().join("graded.json").display().to_string()
            ),
        )
        .unwrap();
        let router = test_app_in(
            dir.path(),
            &format!(
                "{model}\n[providers.grader]\ncommand = [\"sh\", {:?}]\ninput = \"stdin\"\noutput = \"text\"\ndiscuss_models = [\"careful\"]\nedit_models = [\"careful\"]\n\n[models.grader]\nprovider = \"grader\"\n\n# Every model it uses is a fake, so saving the choice below needs no model CLI installed.\n[models.edit]\nprovider = \"grader\"\nmodel = \"careful\"\n\n[learning]\npacks = [{:?}]\n",
                grader.display().to_string(),
                pack.display().to_string()
            ),
        );
        let mark = |id: &str| {
            request(
                "POST",
                "/api/items/sample/link-shortener/mark",
                Some(
                    serde_json::json!({ "id": id, "work": "design", "text": "A table of codes." }),
                ),
            )
        };
        let models = json(send(&router, request("GET", "/api/models", None)).await).await;
        assert_eq!(
            models["grader"],
            serde_json::json!({ "provider": "grader", "model": "careful" })
        );
        let marked = json(send(&router, mark("5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a41")).await).await;
        assert_eq!(marked["marked"]["score"], 0.4);

        // Chosen in the app to mark as the discussion does.
        let mut settings = models["settings"].clone();
        settings["grader"] = serde_json::json!({ "kind": "discussion" });
        let models = json(send(&router, request("PUT", "/api/models", Some(settings))).await).await;
        assert_eq!(models["grader"], serde_json::Value::Null);
        let marked = json(send(&router, mark("5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a42")).await).await;
        assert_eq!(marked["marked"]["score"], 0.65);
    }

    #[tokio::test]
    async fn marks_what_was_explained_aloud_for_clarity_too() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        let card = serde_json::json!({
            "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a51",
            "work": "card",
            "text": "it's log n because the last item sinks down",
            "spoken": true,
        });
        let marked = json(
            send(
                &router,
                request(
                    "POST",
                    "/api/items/sample/binary-heap-costs/mark",
                    Some(card),
                ),
            )
            .await,
        )
        .await;
        assert_eq!(marked["marked"]["clarity"]["score"], 0.5);
        // It counts as an attempt, as a written answer does.
        assert!(marked["due"].as_i64().is_some());
        assert_eq!(
            marked["attempt"]["id"],
            "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a51"
        );
        assert_eq!(marked["attempt"]["rating"], "good");
        let deck = json(send(&router, request("GET", "/api/learning/deck", None)).await).await;
        assert_eq!(deck["schedules"]["sample/binary-heap-costs"]["reviews"], 1);

        // A solution is explained with the code it explains, once the problem's started.
        let explanation = serde_json::json!({
            "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a52",
            "work": "explanation",
            "text": "I flood each island from its first square",
            "spoken": true,
        });
        let early = send(
            &router,
            request(
                "POST",
                "/api/items/sample/islands/mark",
                Some(explanation.clone()),
            ),
        )
        .await;
        assert_eq!(early.status(), StatusCode::BAD_REQUEST);
        json(
            send(
                &router,
                request("POST", "/api/coding/items/sample/islands/open", None),
            )
            .await,
        )
        .await;
        let marked = json(
            send(
                &router,
                request("POST", "/api/items/sample/islands/mark", Some(explanation)),
            )
            .await,
        )
        .await;
        assert_eq!(
            marked["marked"]["clarity"]["feedback"],
            "Lead with the answer."
        );
        assert_eq!(marked["due"], serde_json::Value::Null);
        assert_eq!(marked["attempt"], serde_json::Value::Null);
        let deck = json(send(&router, request("GET", "/api/learning/deck", None)).await).await;
        assert!(deck["schedules"].get("sample/islands").is_none());
    }

    #[tokio::test]
    async fn fixes_a_flagged_card_once_the_fix_is_approved() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        let flag = |id: &str, item: &str, note: Option<&str>| {
            serde_json::json!({ "flags": [{
                "id": id, "item": item, "at": crate::learning::now_ms(), "flagged": true, "note": note,
            }] })
        };
        let body = flag(
            "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a41",
            "sample/binary-heap-costs",
            Some("Isn't it constant?"),
        );
        json(send(&router, request("POST", "/api/learning/sync", Some(body))).await).await;

        let reviewed = json(
            send(
                &router,
                request("POST", "/api/cards/sample/binary-heap-costs/review", None),
            )
            .await,
        )
        .await;
        assert_eq!(reviewed["review"]["verdict"], "wrong");
        assert_eq!(reviewed["cleared"], false);
        let flagged = json(send(&router, request("GET", "/api/cards/flagged", None)).await).await;
        let card = &flagged["cards"][0];
        assert_eq!(card["note"], "Isn't it constant?");
        assert!(
            card["proposed"]["review"]["fix"]["answer"]
                .as_str()
                .unwrap()
                .starts_with("O(log n)")
        );

        let approve = serde_json::json!({ "approve": true });
        let fixed = json(
            send(
                &router,
                request(
                    "POST",
                    "/api/cards/sample/binary-heap-costs/fix",
                    Some(approve.clone()),
                ),
            )
            .await,
        )
        .await;
        assert!(fixed["commit"].is_string());
        let pack = dir.path().join("pack");
        let text = std::fs::read_to_string(pack.join("items/cards/binary-heap-costs.md")).unwrap();
        assert!(text.contains("## Answer\n\nO(log n), as the last item sinks from the root.\n"));
        assert!(!text.contains("## Explanation"));
        assert_eq!(
            crate::pack_files::testing::log(&pack)[0],
            "Fix the card \"In a binary heap of n items, what…\""
        );
        let flagged = json(send(&router, request("GET", "/api/cards/flagged", None)).await).await;
        assert_eq!(flagged["cards"], serde_json::json!([]));
        // There's nothing left to approve.
        let again = send(
            &router,
            request(
                "POST",
                "/api/cards/sample/binary-heap-costs/fix",
                Some(approve),
            ),
        )
        .await;
        assert_eq!(again.status(), StatusCode::BAD_REQUEST);

        // A card the grader finds right has its flag cleared.
        let body = flag(
            "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a42",
            "sample/stable-sorting",
            None,
        );
        json(send(&router, request("POST", "/api/learning/sync", Some(body))).await).await;
        let reviewed = json(
            send(
                &router,
                request("POST", "/api/cards/sample/stable-sorting/review", None),
            )
            .await,
        )
        .await;
        assert_eq!(reviewed["cleared"], true);
        let deck = json(send(&router, request("GET", "/api/learning/deck", None)).await).await;
        assert_eq!(deck["flags"], serde_json::json!({}));
    }

    #[tokio::test]
    async fn marks_a_lesson_without_scheduling_or_logging_mistakes() {
        let dir = tempfile::tempdir().unwrap();
        let router = app(dir.path());
        let body = serde_json::json!({
            "id": "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a91",
            "work": "lesson",
            "text": "Because the tree is complete, children are at 2i+1 and 2i+2 and height is log n.",
        });
        let marked = json(
            send(
                &router,
                request("POST", "/api/items/sample/binary-heaps/mark", Some(body)),
            )
            .await,
        )
        .await;
        assert_eq!(marked["marked"]["score"], 0.65);
        assert_eq!(marked["due"], serde_json::Value::Null);
        assert_eq!(marked["attempt"], serde_json::Value::Null);
        let deck = json(send(&router, request("GET", "/api/learning/deck", None)).await).await;
        assert!(deck["schedules"].get("sample/binary-heaps").is_none());
        let log = json(send(&router, request("GET", "/api/mistakes", None)).await).await;
        assert_eq!(log["mistakes"], serde_json::json!([]));
    }
}
