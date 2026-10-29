//! Finding a part's worked example with the edit model, for puzzles whose example the page's
//! structure doesn't give away, such as one written inline rather than in a code block. What the
//! model proposes is only used if every value in it appears in the puzzle, in order, so it can't
//! invent a sample.

use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

const SAMPLE_PROMPT: &str = include_str!("../prompts/sample.md");

/// How much of the real input the model sees, to learn its format.
const INPUT_LINES: usize = 5;
const INPUT_LINE_CHARS: usize = 120;

/// Values of a sample can be spread over the puzzle's text, such as one per list item with its
/// explanation, but not further apart than this many words.
const MAX_GAP: usize = 40;

pub const TIMEOUT: Duration = Duration::from_secs(60);

pub fn system_prompt() -> &'static str {
    SAMPLE_PROMPT.trim_end()
}

/// A part's example: its input, as the real input would hold it, and the answer it gives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sample {
    pub input: String,
    pub answer: String,
}

/// What the model proposed for a part, before it's checked against the puzzle. This is what's
/// kept, so a proposal is checked again each time it's read and a better check applies to
/// proposals made before it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Proposal {
    input: Option<String>,
    answer: Option<String>,
}

/// What the model is asked about part `part` (1 or 2), given the text of each part up to it and
/// the real input.
pub fn user_prompt(part: u8, parts_text: &[String], input: &str) -> String {
    let puzzle = parts_text.join("\n\n");
    let start: Vec<String> = input
        .lines()
        .take(INPUT_LINES)
        .map(|line| {
            if line.chars().count() > INPUT_LINE_CHARS {
                format!(
                    "{}…",
                    line.chars().take(INPUT_LINE_CHARS).collect::<String>()
                )
            } else {
                line.to_owned()
            }
        })
        .collect();
    format!(
        "Find part {part}'s example.\n\nThe puzzle:\n```\n{}\n```\n\nThe real input starts:\n```\n{}\n```",
        puzzle.trim(),
        start.join("\n")
    )
}

/// The proposal in the model's reply.
pub fn read_reply(reply: &str) -> Result<Proposal> {
    let (Some(start), Some(end)) = (reply.find('{'), reply.rfind('}')) else {
        anyhow::bail!("the model's reply had no JSON object: {reply:?}");
    };
    serde_json::from_str(
        reply
            .get(start..=end)
            .context("the model's reply had no JSON object")?,
    )
    .context("reading the model's reply")
}

/// The sample the model proposed, if it gave one and it's all in the puzzle.
pub fn check(proposal: &Proposal, puzzle: &str) -> Option<Sample> {
    let (Some(input), Some(answer)) = (&proposal.input, &proposal.answer) else {
        return None;
    };
    let sample = Sample {
        input: format!("{}\n", input.trim_end_matches('\n')),
        answer: answer.trim().to_owned(),
    };
    if sample.answer.is_empty() || sample.answer.contains('\n') {
        return None;
    }
    let text = tokens(puzzle);
    let in_puzzle = appears_in_order(&tokens(&sample.input), &text, MAX_GAP)
        && appears_in_order(&tokens(&sample.answer), &text, 0);
    if !in_puzzle {
        tracing::info!("the model's sample isn't in the puzzle: {sample:?}");
        return None;
    }
    Some(sample)
}

/// The values in a text: what's between whitespace and commas, without the punctuation that
/// ends a sentence.
fn tokens(text: &str) -> Vec<&str> {
    text.split(|c: char| c.is_whitespace() || c == ',')
        .map(|t| t.trim_end_matches(['.', ';', ':', '!', '?']))
        .filter(|t| !t.is_empty())
        .collect()
}

/// Whether a value in the puzzle's text is `wanted`, as written or once the brackets and quotes
/// around it are removed, as in "(producing fgij.)". Only the puzzle's side is unwrapped, so a
/// value made of brackets, such as "(())", still has to match exactly.
fn is_value(token: &str, wanted: &str) -> bool {
    token == wanted
        || token
            .trim_start_matches(['(', '[', '"', '\''])
            .trim_end_matches(['.', ';', ':', '!', '?', ')', ']', '"', '\''])
            == wanted
}

/// Whether `wanted` appears in `text` in order, with at most `gap` other values between each,
/// starting anywhere.
fn appears_in_order(wanted: &[&str], text: &[&str], gap: usize) -> bool {
    let Some((first, rest)) = wanted.split_first() else {
        return false;
    };
    text.iter().enumerate().any(|(start, token)| {
        if !is_value(token, first) {
            return false;
        }
        let mut at = start;
        rest.iter().all(|want| {
            let window = text.iter().enumerate().skip(at + 1).take(gap + 1);
            match window.into_iter().find(|(_, t)| is_value(t, want)) {
                Some((i, _)) => {
                    at = i;
                    true
                }
                None => false,
            }
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Invented, in the style of an older puzzle that gives its example inline.
    const PUZZLE: &str = "A dial starts at zero. For example, if the turns are +2, -5, +4, then \
        the dial goes to 2, then -3, then 1. In this example, the dial ends at 1.";

    fn sample(reply: &str, puzzle: &str) -> Option<Sample> {
        check(&read_reply(reply).unwrap(), puzzle)
    }

    #[test]
    fn keeps_a_sample_from_the_puzzle_rewritten_one_value_per_line() {
        assert_eq!(
            sample(r#"{"input":"+2\n-5\n+4","answer":"1"}"#, PUZZLE),
            Some(Sample {
                input: "+2\n-5\n+4\n".into(),
                answer: "1".into()
            })
        );
    }

    #[test]
    fn rejects_a_sample_that_isnt_in_the_puzzle() {
        for reply in [
            r#"{"input":"+2\n-5\n+7","answer":"1"}"#,
            r#"{"input":"+4\n-5\n+2","answer":"1"}"#,
            r#"{"input":"+2\n-5\n+4","answer":"4"}"#,
            r#"{"input":"+2\n-5\n+4","answer":"1\n2"}"#,
        ] {
            assert_eq!(sample(reply, PUZZLE), None, "{reply}");
        }
    }

    #[test]
    fn reads_that_there_is_no_sample() {
        assert_eq!(sample(r#"{"input":null,"answer":null}"#, PUZZLE), None);
        assert!(read_reply("I couldn't find one.").is_err());
    }

    #[test]
    fn reads_an_answer_wrapped_in_punctuation() {
        let puzzle = "For example, given ab and ac. (This is found by removing the differing \
            character, producing a.)";
        assert!(sample(r#"{"input":"ab\nac","answer":"a"}"#, puzzle).is_some());
    }

    #[test]
    fn matches_a_value_made_of_brackets_exactly() {
        let puzzle = "For example, (()) and ()() both result in floor 0.";
        assert!(sample(r#"{"input":"(())","answer":"0"}"#, puzzle).is_some());
        assert_eq!(sample(r#"{"input":"())","answer":"0"}"#, puzzle), None);
    }

    #[test]
    fn allows_values_spread_over_a_list() {
        let puzzle =
            "Some examples:\n- 12 has mass 2.\n- 14 has mass 2 as well.\n- 1969 has mass 654.";
        assert!(sample(r#"{"input":"12\n14\n1969","answer":"654"}"#, puzzle).is_some());
    }

    #[test]
    fn shows_the_model_the_start_of_the_input() {
        let long = "x".repeat(200);
        let prompt = user_prompt(
            2,
            &["Part one".into(), "Part two".into()],
            &format!("{long}\n2\n3\n4\n5\n6\n7\n"),
        );
        assert!(prompt.starts_with("Find part 2's example."));
        assert!(prompt.contains("Part one\n\nPart two"));
        assert!(prompt.contains(&format!("{}…\n2\n3\n4\n5\n```", "x".repeat(120))));
        assert!(!prompt.contains("\n6\n"));
    }
}
