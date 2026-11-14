//! Design sessions: the System design track's prompts, worked through in stages with a coach
//! asking follow-up questions at each, and marked as a whole by the grader at the end. Where
//! each session is, and its rules, are in the sessions crate; this is the coach.

use std::time::Duration;

use anyhow::{Result, bail};
use workshop_pack::{Content, Item};
use workshop_provider::{CallSpec, ProviderRunner};
use workshop_sessions::design::{Session, Stage};

pub const TIMEOUT: Duration = Duration::from_secs(120);

/// The coach's instructions, with a pack's tutor add-on if it has one, as the coach is the
/// tutor's counterpart for design prompts.
pub fn coach_system_prompt(add_on: Option<&str>) -> String {
    let base = include_str!("../prompts/coach.md").trim_end();
    match add_on {
        Some(add_on) if !add_on.trim().is_empty() => {
            format!("{base}\n\nThe pack adds:\n\n{}", add_on.trim())
        }
        _ => base.to_owned(),
    }
}

/// The coach's prompt: the design prompt, its rubric for steering, the session so far, and the
/// conversation at the stage the learner's at.
pub fn coach_prompt(item: &Item, session: &Session, stage: Stage) -> Result<String> {
    let Content::Design { rubric, .. } = &item.content else {
        bail!("{} isn't a design prompt", item.label());
    };
    let mut out = format!(
        "<question>\n{}\n</question>\n\n<rubric>\n",
        item.prompt.trim()
    );
    for point in rubric {
        out.push_str(&format!("- {point}\n"));
    }
    out.push_str(&format!(
        "</rubric>\n\n<session>\n{}\n</session>\n\nThey're at the stage \"{}\": {}\n\n",
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
    out.push_str("Ask one or two follow-up questions about this stage.");
    Ok(out)
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

    use super::*;

    #[test]
    fn asks_about_the_stage_the_learner_is_at() {
        let pack = Pack::sample();
        let item = pack.item("link-shortener").unwrap();
        let mut session = Session::new(1);
        session
            .say(Stage::Requirements, Speaker::Coach, "Do links expire?", 2)
            .unwrap();
        session
            .say(Stage::Requirements, Speaker::Learner, "After a year", 3)
            .unwrap();
        let prompt = coach_prompt(item, &session, Stage::Requirements).unwrap();
        assert!(prompt.starts_with("<question>\nDesign a service that turns long links"));
        assert!(prompt.contains("- Says what happens when the store is unavailable\n"));
        assert!(prompt.contains("<session>\n## Clarify the requirements\n"));
        assert!(prompt.contains("They're at the stage \"Clarify the requirements\": Say what"));
        assert!(prompt.contains(
            "<conversation>\nYou: Do links expire?\nLearner: After a year\n</conversation>"
        ));
        assert!(prompt.ends_with("Ask one or two follow-up questions about this stage."));
        // A stage with nothing said yet has no conversation.
        assert!(
            !coach_prompt(item, &session, Stage::Scale)
                .unwrap()
                .contains("<conversation>")
        );
        assert!(coach_prompt(pack.item("islands").unwrap(), &session, Stage::Scale).is_err());

        let system = coach_system_prompt(Some("Keep it brief."));
        assert!(system.starts_with("You are a coach"));
        assert!(system.ends_with("The pack adds:\n\nKeep it brief."));
        assert!(!coach_system_prompt(None).contains("The pack adds"));
    }
}
