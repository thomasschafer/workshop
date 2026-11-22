//! Design sessions' coach. While the learner finds out the requirements and the scale, it
//! answers their questions from the design prompt's brief, which only it sees, and makes up a
//! brief as a session starts for a prompt without one. At the later stages it asks follow-up
//! questions, holding the design to the brief. Where each session is, and its rules, are in the
//! sessions crate; timed rounds of design prompts answer from a brief in the same way, through
//! the examiner.

use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use workshop_pack::{Content, Item};
use workshop_provider::{CallSpec, ProviderRunner};
use workshop_sessions::brief::{Brief, BriefSource};
use workshop_sessions::design::{Session, Stage};

pub const TIMEOUT: Duration = Duration::from_secs(120);

/// The coach's instructions, with a pack's tutor add-on if it has one, as the coach is the
/// tutor's counterpart for design prompts.
pub fn coach_system_prompt(add_on: Option<&str>) -> String {
    crate::grader::with_add_on(include_str!("../prompts/coach.md"), add_on)
}

/// How the learner's questions are to be answered from a brief, by the coach or the examiner.
pub const ANSWERING: &str = "Answer as the person who knows the requirements, from the brief, which the learner can't see. Answer only what they asked, concisely, in a sentence or two. Don't volunteer anything else, and don't hint at how to design it. Give the figures they ask for, such as how many users there are or how often each does something, but leave working out what follows from them to the learner: if they ask for something that's theirs to estimate, such as the storage, requests per second or bandwidth the system needs, say so, and that they can ask for the figures it comes from. If the brief doesn't cover what they asked, answer as its writer would, plausibly and consistently with the brief and everything answered so far, and keep what you've settled, as a short statement of fact, in `settled`, so later answers keep to it. Otherwise `settled` is null.";

/// The shape of a reply to a question answered from a brief.
pub const ANSWER_SHAPE: &str = "Reply with JSON: {\"answer\": string, \"settled\": string or null}";

fn rubric_of(item: &Item) -> Result<&[String]> {
    match &item.content {
        Content::Design { rubric, .. } => Ok(rubric),
        _ => bail!("{} isn't a design prompt", item.label()),
    }
}

fn question_and_rubric(item: &Item) -> Result<String> {
    let mut out = format!(
        "<question>\n{}\n</question>\n\n<rubric>\n",
        item.prompt.trim()
    );
    for point in rubric_of(item)? {
        out.push_str(&format!("- {point}\n"));
    }
    out.push_str("</rubric>\n\n");
    Ok(out)
}

/// The coach's prompt for making up a brief, for a design prompt without one.
pub fn brief_prompt(item: &Item) -> Result<String> {
    let mut out = question_and_rubric(item)?;
    out.push_str("Write the brief for this design question. You'll answer the learner's questions from it, and they never see it, so make it complete and consistent, with definite numbers: who uses the system and for what; what it must do; its scale, with how much data it keeps, how often it's read and written, and how fast that grows; the latency, availability and consistency it needs; and what's out of scope. Make it fit the question and what the rubric looks for, without saying how to design it. Write it as a short Markdown list, a line or two for each, and reply with the brief alone.");
    Ok(out)
}

/// The brief a session or round of a design prompt starts with: the prompt's own, or one the
/// coach makes up for a prompt without one.
pub async fn brief_for(runner: &ProviderRunner, spec: &CallSpec, item: &Item) -> Result<Brief> {
    let Content::Design { brief, .. } = &item.content else {
        bail!("{} isn't a design prompt", item.label());
    };
    if let Some(brief) = brief {
        return Brief::new(brief, BriefSource::Pack)
            .with_context(|| format!("reading {}'s brief", item.label()));
    }
    let reply = runner
        .call_aside(spec, &brief_prompt(item)?, TIMEOUT)
        .await
        .context("asking the coach for a brief")?;
    Brief::new(&reply.text, BriefSource::Coach).context("the coach's brief was empty")
}

/// The design prompt, its rubric and brief, the session so far, and the conversation at the
/// stage the learner's at, for the coach.
fn session_prompt(
    item: &Item,
    brief: Option<&Brief>,
    session: &Session,
    stage: Stage,
) -> Result<String> {
    let mut out = question_and_rubric(item)?;
    if let Some(brief) = brief {
        out.push_str(&format!("<brief>\n{}\n</brief>\n\n", brief.full()));
    }
    out.push_str(&format!(
        "<session>\n{}\n</session>\n\nThey're at the stage \"{}\": {}\n\n",
        session.transcript(),
        stage.name(),
        stage.task()
    ));
    let turns = session.turns(stage);
    if !turns.is_empty() {
        out.push_str(&format!(
            "<conversation>\n{}</conversation>\n\n",
            workshop_sessions::conversation(turns)
        ));
    }
    Ok(out)
}

/// The coach's prompt for follow-up questions, at the stages where it asks them.
pub fn coach_prompt(item: &Item, session: &Session, stage: Stage) -> Result<String> {
    let mut out = session_prompt(item, session.brief.as_ref(), session, stage)?;
    if session.brief.is_some() {
        out.push_str("The brief is what the learner's questions were answered from. Keep to it: if the design goes against a requirement in it that they found out, ask about that. Never tell them what's in it that they didn't ask about.\n\n");
    }
    out.push_str("Ask one or two follow-up questions about this stage.");
    Ok(out)
}

/// The coach's prompt for answering the learner's last question from the brief.
pub fn answer_prompt(
    item: &Item,
    brief: &Brief,
    session: &Session,
    stage: Stage,
) -> Result<String> {
    let mut out = session_prompt(item, Some(brief), session, stage)?;
    out.push_str(&format!(
        "{ANSWERING}\n\nAnswer their last question. {ANSWER_SHAPE}"
    ));
    Ok(out)
}

/// An answer to the learner's question, from the brief.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Answer {
    pub text: String,
    /// A detail the brief didn't cover, settled by the answer.
    pub settled: Option<String>,
}

/// Reads an answer from a brief, as [`ANSWER_SHAPE`] asks for it, from the coach or the
/// examiner, as `who`.
pub fn parse_answer(reply: &str, who: &str) -> Result<Answer> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Raw {
        answer: String,
        settled: Option<String>,
    }
    let json = crate::grader::json_in(reply)
        .with_context(|| format!("the {who}'s answer wasn't the JSON asked for: {reply}"))?;
    let raw: Raw = serde_json::from_str(json)
        .with_context(|| format!("the {who}'s answer isn't in the shape asked for: {reply}"))?;
    let text = raw.answer.trim();
    if text.is_empty() {
        bail!("the {who}'s answer was empty");
    }
    Ok(Answer {
        text: text.to_owned(),
        settled: raw
            .settled
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty()),
    })
}

/// Asks the coach to answer the learner's last question at a stage, from the brief.
pub async fn answer(
    runner: &ProviderRunner,
    spec: &CallSpec,
    item: &Item,
    brief: &Brief,
    session: &Session,
    stage: Stage,
) -> Result<Answer> {
    let prompt = answer_prompt(item, brief, session, stage)?;
    let reply = runner.call_aside(spec, &prompt, TIMEOUT).await?;
    parse_answer(&reply.text, "coach")
}

/// Asks the coach for its follow-up questions.
pub async fn ask_coach(
    runner: &ProviderRunner,
    spec: &CallSpec,
    item: &Item,
    session: &Session,
    stage: Stage,
) -> Result<String> {
    let prompt = coach_prompt(item, session, stage)?;
    let reply = runner.call_aside(spec, &prompt, TIMEOUT).await?;
    let text = reply.text.trim();
    if text.is_empty() {
        bail!("the coach's reply was empty");
    }
    Ok(text.to_owned())
}

#[cfg(test)]
mod tests {
    use workshop_pack::Pack;
    use workshop_sessions::Speaker;
    use workshop_sessions::design::Edit;

    use super::*;

    fn brief() -> Brief {
        Brief::new("- Links last five years", BriefSource::Pack).unwrap()
    }

    #[test]
    fn answers_the_learners_questions_from_the_brief() {
        let pack = Pack::sample();
        let item = pack.item("link-shortener").unwrap();
        let mut session = Session::new(brief(), 1);
        session
            .say(Stage::Requirements, Speaker::Learner, "Do links expire?", 2)
            .unwrap();
        session
            .answered(
                Stage::Requirements,
                "After five years.",
                Some("Expired links show a page saying so."),
                3,
            )
            .unwrap();
        session
            .say(Stage::Requirements, Speaker::Learner, "Who makes them?", 4)
            .unwrap();
        let brief = session.brief.clone().unwrap();
        let prompt = answer_prompt(item, &brief, &session, Stage::Requirements).unwrap();
        assert!(prompt.starts_with("<question>\nDesign a service that turns long links"));
        assert!(prompt.contains("- Says what happens when the store is unavailable\n"));
        // The brief, with what's been settled so far, so answers keep to it.
        assert!(prompt.contains("<brief>\n- Links last five years\n\nSettled when the learner asked:\n- Expired links show a page saying so.\n</brief>"));
        assert!(
            prompt.contains("They're at the stage \"Clarify the requirements\": Ask the coach")
        );
        assert!(prompt.contains(
            "<conversation>\nLearner: Do links expire?\nYou: After five years.\nLearner: Who makes them?\n</conversation>"
        ));
        assert!(prompt.contains("Answer only what they asked"));
        assert!(prompt.ends_with(&format!("Answer their last question. {ANSWER_SHAPE}")));

        let answer = parse_answer(
            "```json\n{\"answer\": \" Organisations, mostly. \", \"settled\": \" \"}\n```",
            "coach",
        )
        .unwrap();
        assert_eq!(
            answer,
            Answer {
                text: "Organisations, mostly.".to_owned(),
                settled: None
            }
        );
        let settled = parse_answer(
            r#"{"answer": "No.", "settled": "Codes are never reused."}"#,
            "coach",
        )
        .unwrap();
        assert_eq!(settled.settled.as_deref(), Some("Codes are never reused."));
        assert!(parse_answer("Organisations, mostly.", "coach").is_err());
        assert!(parse_answer(r#"{"answer": "", "settled": null}"#, "coach").is_err());
    }

    #[test]
    fn asks_follow_up_questions_holding_the_design_to_the_brief() {
        let pack = Pack::sample();
        let item = pack.item("link-shortener").unwrap();
        let mut session = Session::new(brief(), 1);
        for stage in [Stage::Scale, Stage::Outline] {
            session
                .edit(
                    Edit {
                        stage,
                        notes: Default::default(),
                        components: Vec::new(),
                        deep_dive: None,
                    },
                    2,
                )
                .unwrap();
        }
        session
            .say(Stage::Outline, Speaker::Coach, "Where are codes kept?", 3)
            .unwrap();
        session
            .say(Stage::Outline, Speaker::Learner, "In one database", 4)
            .unwrap();
        let prompt = coach_prompt(item, &session, Stage::Outline).unwrap();
        assert!(prompt.contains("<brief>\n- Links last five years\n</brief>"));
        assert!(prompt.contains("Keep to it"));
        assert!(prompt.contains(
            "<conversation>\nYou: Where are codes kept?\nLearner: In one database\n</conversation>"
        ));
        assert!(prompt.ends_with("Ask one or two follow-up questions about this stage."));
        // A stage with nothing said yet has no conversation.
        assert!(
            !coach_prompt(item, &session, Stage::Scale)
                .unwrap()
                .contains("<conversation>")
        );
        // A session from before briefs is coached as before.
        session.brief = None;
        let unbriefed = coach_prompt(item, &session, Stage::Outline).unwrap();
        assert!(!unbriefed.contains("<brief>") && !unbriefed.contains("Keep to it"));
        assert!(coach_prompt(pack.item("islands").unwrap(), &session, Stage::Scale).is_err());

        let system = coach_system_prompt(Some("Keep it brief."));
        assert!(system.starts_with("You are a coach"));
        assert!(system.ends_with("The pack adds:\n\nKeep it brief."));
        assert!(!coach_system_prompt(None).contains("The pack adds"));
    }

    #[test]
    fn asks_for_a_brief_only_for_a_prompt_without_one() {
        let pack = Pack::sample();
        let item = pack.item("rate-limiter").unwrap();
        let prompt = brief_prompt(item).unwrap();
        assert!(prompt.starts_with("<question>\nDesign a rate limiter"));
        assert!(prompt.contains("- Says what a client is told when it's limited\n"));
        assert!(prompt.contains("Write the brief for this design question."));
        assert!(brief_prompt(pack.item("islands").unwrap()).is_err());
    }
}
