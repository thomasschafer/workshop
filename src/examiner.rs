//! The examiner: a coach that runs timed rounds, with follow-up questions that extend or
//! change the problem as a live session would. In a round of a design prompt, it answers the
//! learner's questions about the requirements from the prompt's brief, as the design session's
//! coach does. A pack's examiner add-on, and the style the learner chose, shape how it goes.
//! Where each round is, and its clock, are in the sessions crate.

use std::time::Duration;

use anyhow::{Context, Result, bail};
use workshop_pack::{Content, ExaminerStyle, Item, Kind};
use workshop_provider::{CallSpec, ProviderRunner};
use workshop_sessions::round::Round;

pub const TIMEOUT: Duration = Duration::from_secs(120);

/// Whether a round can be made of an item: a coding problem, a probability question or a
/// design prompt.
pub fn can_round(item: &Item) -> bool {
    matches!(item.kind, Kind::Coding | Kind::Probability | Kind::Design)
}

/// The examiner's instructions: its own, then the pack's add-on, then the chosen style's.
pub fn system_prompt(add_on: Option<&str>, style: Option<&ExaminerStyle>) -> String {
    let mut out = include_str!("../prompts/examiner.md").trim_end().to_owned();
    if let Some(add_on) = add_on.map(str::trim).filter(|a| !a.is_empty()) {
        out.push_str(&format!("\n\nThe pack adds:\n\n{add_on}"));
    }
    if let Some(style) = style.filter(|s| !s.prompt.trim().is_empty()) {
        out.push_str(&format!(
            "\n\nYour style for this round is \"{}\":\n\n{}",
            style.name,
            style.prompt.trim()
        ));
    }
    out
}

/// What the examiner judges the learner's working by, which they mustn't see.
fn reference(item: &Item) -> Result<String> {
    Ok(match &item.content {
        Content::Coding(coding) => coding.approach.trim().to_owned(),
        Content::Probability(probability) => format!(
            "The answer is {}.\n\n{}",
            probability.answer_text,
            probability.solution.trim()
        ),
        Content::Design { rubric, notes, .. } => {
            let mut out: String = rubric.iter().map(|point| format!("- {point}\n")).collect();
            if let Some(notes) = notes {
                out.push_str(&format!("\n{}", notes.trim()));
            }
            out.trim_end().to_owned()
        }
        _ => bail!("{} can't be a timed round", item.label()),
    })
}

/// How a round's clock is put, such as "6 of 20 minutes used, 14 left".
pub fn clock_text(round: &Round) -> String {
    let clock = round.clock();
    let used = clock.used_ms / 60_000;
    let left = (clock.remaining_ms + 59_999) / 60_000;
    format!("{used} of {} minutes used, {left} left", round.minutes)
}

/// The examiner's prompt: the problem, the reference, a design prompt's brief, the clock, the
/// learner's working and the conversation so far.
pub fn prompt(item: &Item, round: &Round) -> Result<String> {
    // A round is of the whole problem, every part of one in parts.
    let problem = match &item.content {
        Content::Coding(coding) => coding.statement(coding.last()),
        _ => item.prompt.clone(),
    };
    let mut out = format!(
        "<problem>\n{}\n</problem>\n\n<reference>\n{}\n</reference>\n\n",
        problem.trim(),
        reference(item)?
    );
    let brief = match (item.kind, &round.brief) {
        (Kind::Design, Some(brief)) => Some(brief),
        (Kind::Design, None) => bail!("a round of a design prompt needs its brief"),
        (_, Some(_)) => bail!("only a round of a design prompt has a brief"),
        (_, None) => None,
    };
    if let Some(brief) = brief {
        out.push_str(&format!("<brief>\n{}\n</brief>\n\n", brief.full()));
    }
    out.push_str(&format!("The clock: {}.\n", clock_text(round)));
    if round.returned {
        out.push_str("They've just come back to the round after a break; the clock was stopped while they were away.\n");
    }
    out.push('\n');
    match round.work.trim() {
        "" => out.push_str("<working>\n(nothing written yet)\n</working>\n\n"),
        work => out.push_str(&format!("<working>\n{work}\n</working>\n\n")),
    }
    out.push_str(&format!(
        "<conversation>\n{}</conversation>\n\nReply to their last message as the examiner.",
        workshop_sessions::conversation(&round.turns)
    ));
    if brief.is_some() {
        out.push_str(&format!(
            " If they asked about the requirements or the numbers, answer from the brief. {}\n\nFor anything else, reply as the examiner, with `settled` null. {}",
            crate::design::ANSWERING,
            crate::design::ANSWER_SHAPE
        ));
    }
    Ok(out)
}

/// Asks the examiner for its reply, with what it settled that a design prompt's brief didn't
/// cover.
pub async fn reply(
    runner: &ProviderRunner,
    spec: &CallSpec,
    item: &Item,
    round: &Round,
) -> Result<crate::design::Answer> {
    let prompt = prompt(item, round)?;
    let reply = runner.call_aside(spec, &prompt, TIMEOUT).await?;
    if round.brief.is_some() {
        return crate::design::parse_answer(&reply.text, "examiner")
            .context("reading the examiner's reply");
    }
    let text = reply.text.trim();
    if text.is_empty() {
        bail!("the examiner's reply was empty");
    }
    Ok(crate::design::Answer {
        text: text.to_owned(),
        settled: None,
    })
}

#[cfg(test)]
mod tests {
    use workshop_pack::Pack;
    use workshop_sessions::brief::{Brief, BriefSource};

    use super::*;

    const START: i64 = 1_790_000_000_000;

    #[test]
    fn tells_the_examiner_the_clock_and_what_to_judge_by() {
        let pack = Pack::sample();
        let item = pack.item("two-dice-seven").unwrap();
        let mut round = Round::new(item.minutes, None, START);
        round.say("Is it 1/6?", START + 10_000).unwrap();
        for second in (20..=340).step_by(10) {
            round.seen(START + second * 1000);
        }
        // Back after a break, which counts for no more than a short gap.
        round.seen(START + 1_200_000);
        round.save_work("6 of 36 pairs", START + 1_205_000).unwrap();
        let prompt = prompt(item, &round).unwrap();
        assert!(prompt.starts_with("<problem>\nTwo fair dice are rolled."));
        assert!(
            prompt.contains("<reference>\nThe answer is 1/6.\n\nOf the 36 equally likely pairs")
        );
        assert!(prompt.contains("The clock: 6 of 10 minutes used, 4 left.\n"));
        assert!(prompt.contains("just come back"));
        assert!(prompt.contains("<working>\n6 of 36 pairs\n</working>"));
        assert!(prompt.contains("<conversation>\nLearner: Is it 1/6?\n</conversation>"));
        assert!(prompt.ends_with("Reply to their last message as the examiner."));

        assert!(!prompt.contains("<brief>"));

        let design = pack.item("link-shortener").unwrap();
        round.examiner_said("Go on.", START + 1_206_000);
        // A round of a design prompt answers from its brief, which it must have.
        assert!(super::prompt(design, &round).is_err());
        let mut brief = Brief::new("- Links last five years", BriefSource::Pack).unwrap();
        brief.add("Codes are 7 characters.");
        round.brief = Some(brief);
        let design_prompt = super::prompt(design, &round).unwrap();
        assert!(design_prompt.contains("- Says what happens when the store is unavailable\n"));
        assert!(design_prompt.contains("<brief>\n- Links last five years\n\nSettled when the learner asked:\n- Codes are 7 characters.\n</brief>"));
        assert!(
            design_prompt
                .contains("answer from the brief. Answer as the person who knows the requirements")
        );
        assert!(design_prompt.ends_with(crate::design::ANSWER_SHAPE));
        assert!(!design_prompt.contains("just come back"));
        // Only a design prompt's round has one.
        assert!(super::prompt(item, &round).is_err());
        assert!(super::prompt(pack.item("binary-heap-costs").unwrap(), &round).is_err());
        assert!(can_round(design));
        assert!(!can_round(pack.item("negative-division").unwrap()));
    }

    #[test]
    fn shapes_the_examiner_with_the_pack_and_the_style() {
        let pack = Pack::sample();
        let style = &pack.examiner_styles[1];
        let system = system_prompt(Some("Use metric units."), Some(style));
        assert!(system.starts_with("You are an examiner"));
        assert!(system.contains("The pack adds:\n\nUse metric units.\n\nYour style for this round is \"Probing\":\n\nBe exacting"));
        let plain = system_prompt(None, None);
        assert!(!plain.contains("The pack adds"));
        assert!(!plain.contains("Your style"));
    }
}
