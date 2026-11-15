//! Twists: when a coding problem solved before comes due, its review is a short follow-up on it
//! rather than solving it again. The tutor poses the twist, given the problem, how it's meant to
//! be solved and the learner's own solution: a new constraint, a far larger scale, a streaming
//! version, a better complexity target, or a change to the edge cases. The learner answers in a
//! few minutes, by explaining how they'd change their approach, typed or aloud, or by changing
//! their code, and the grader marks it, which is the review's rating.
//!
//! Each review's twist is kept once it's posed, so opening the problem again doesn't ask for
//! another, and every twist posed is kept, so the next isn't the same.

use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use workshop_provider::{CallSpec, ProviderRunner};

/// How long the tutor may take to pose a twist.
pub const TIMEOUT: Duration = Duration::from_secs(120);

/// The sort of change a twist makes, taken in turn, so reviews don't keep asking the same.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Constraint,
    Scale,
    Streaming,
    Complexity,
    EdgeCase,
}

impl Kind {
    pub const ALL: [Self; 5] = [
        Self::Constraint,
        Self::Scale,
        Self::Streaming,
        Self::Complexity,
        Self::EdgeCase,
    ];

    /// The kind for a problem's next twist, after the ones posed before.
    pub fn next(posed: &[Twist]) -> Self {
        Self::ALL[posed.len() % Self::ALL.len()]
    }

    fn ask(self) -> &'static str {
        match self {
            Self::Constraint => {
                "a new constraint, such as a limit on memory, values that can now be negative, or a further rule the answer must follow"
            }
            Self::Scale => {
                "a far larger scale, such as input too big to fit in memory, or a great many queries on the same data"
            }
            Self::Streaming => {
                "a streaming or online version, where the input arrives a piece at a time and an answer is wanted after each piece"
            }
            Self::Complexity => {
                "a better complexity target than the approach's, in time or extra space, or, if none is possible, why not"
            }
            Self::EdgeCase => {
                "a change to the edge cases, such as empty input, repeated values, ties or overflow, and what the approach must do about it"
            }
        }
    }
}

/// A twist posed for a review, and how it went once it's answered.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Twist {
    /// When the review's session started, in milliseconds since 1970, which says which
    /// review it's for.
    pub session: i64,
    pub kind: Kind,
    /// The follow-up, in Markdown.
    pub prompt: String,
    /// What a good answer covers, for the grader, which the learner sees once they've answered.
    pub notes: String,
    pub posed_at: i64,
    /// What the learner answered, once they have.
    #[serde(default)]
    pub answered: Option<Answered>,
}

/// An answer to a twist, and how the grader marked it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Answered {
    /// The attempt it was recorded as.
    pub attempt: String,
    pub text: String,
    pub marked: crate::grader::Marked,
}

/// Every twist posed for a problem, oldest first.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Posed {
    pub twists: Vec<Twist>,
}

impl Posed {
    /// The twist for the review whose session started at `session`, if one's been posed.
    pub fn for_session(&self, session: i64) -> Option<&Twist> {
        self.twists.iter().rev().find(|t| t.session == session)
    }
}

/// What the tutor is given to pose a twist.
pub struct Asking<'a> {
    pub problem: &'a str,
    pub approach: &'a str,
    /// The learner's solution from last time, with its language's name, if there is one.
    pub solution: Option<(&'a str, &'a str)>,
    pub kind: Kind,
    pub posed: &'a [Twist],
}

/// The tutor's prompt for posing a twist.
pub fn prompt(context: &Asking<'_>) -> String {
    let mut out = format!(
        "<problem>\n{}\n</problem>\n\n<approach>\n{}\n</approach>\n\n",
        context.problem.trim(),
        context.approach.trim()
    );
    if let Some((language, code)) = context.solution {
        out.push_str(&format!(
            "<solution language=\"{language}\">\n{}\n</solution>\n\n",
            code.trim_end()
        ));
    }
    out.push_str(
        "The learner has solved this problem before. The approach is how it's meant to be solved, and the solution, if there is one, is theirs from last time. Pose a twist on it for their review: a short follow-up that takes the same problem further, which they can answer in a few minutes by explaining how they'd change their approach and what it would cost, without writing a whole new solution. Make it concrete, with numbers where they help, and answerable from what they know of this problem.\n\n",
    );
    out.push_str(&format!("This time, make it {}.\n\n", context.kind.ask()));
    if !context.posed.is_empty() {
        out.push_str("Twists posed before, not to repeat:\n");
        for twist in context.posed {
            out.push_str(&format!("- {}\n", one_line(&twist.prompt)));
        }
        out.push('\n');
    }
    out.push_str(
        "Reply with JSON: {\"twist\": the follow-up, in Markdown, in a few sentences, \"notes\": what a good answer covers, for the grader to mark against, which the learner sees only once they've answered}",
    );
    out
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Reads the tutor's twist, checking it has one.
pub fn parse(reply: &str) -> Result<(String, String)> {
    #[derive(Deserialize)]
    struct Raw {
        twist: String,
        notes: String,
    }
    let raw: Raw = serde_json::from_str(crate::grader::json_in(reply)?)
        .with_context(|| format!("the tutor's twist isn't in the shape asked for: {reply}"))?;
    if raw.twist.trim().is_empty() || raw.notes.trim().is_empty() {
        bail!("the tutor's twist is missing what it asks, or what a good answer covers: {reply}");
    }
    Ok((raw.twist.trim().to_owned(), raw.notes.trim().to_owned()))
}

/// Has the tutor pose a twist.
pub async fn pose(
    runner: &ProviderRunner,
    spec: &CallSpec,
    context: &Asking<'_>,
) -> Result<(String, String)> {
    let reply = runner.call_aside(spec, &prompt(context), TIMEOUT).await?;
    parse(&reply.text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn posed(prompt: &str) -> Twist {
        Twist {
            session: 1,
            kind: Kind::Constraint,
            prompt: prompt.to_owned(),
            notes: "Notes".to_owned(),
            posed_at: 1,
            answered: None,
        }
    }

    #[test]
    fn asks_for_each_kind_of_twist_in_turn_without_repeating_any() {
        assert_eq!(Kind::next(&[]), Kind::Constraint);
        let before = [
            posed("What if the\nnumbers were negative?"),
            posed("At scale?"),
        ];
        assert_eq!(Kind::next(&before), Kind::Streaming);
        let prompt = prompt(&Asking {
            problem: "Count the pairs.",
            approach: "A map of counts.",
            solution: Some(("Python", "print(0)\n")),
            kind: Kind::Streaming,
            posed: &before,
        });
        assert!(prompt.contains("<approach>\nA map of counts.\n</approach>"));
        assert!(prompt.contains("<solution language=\"Python\">\nprint(0)\n</solution>"));
        assert!(prompt.contains("This time, make it a streaming or online version"));
        assert!(prompt.contains("- What if the numbers were negative?\n"));
        let first = super::prompt(&Asking {
            problem: "Count the pairs.",
            approach: "A map of counts.",
            solution: None,
            kind: Kind::Constraint,
            posed: &[],
        });
        assert!(!first.contains("<solution"));
        assert!(!first.contains("not to repeat"));
    }

    #[test]
    fn reads_the_tutors_twist() {
        let (twist, notes) = parse(
            "Here it is:\n```json\n{\"twist\": \"Now the list streams in.\", \"notes\": \"Keep the map as you go.\"}\n```",
        )
        .unwrap();
        assert_eq!(twist, "Now the list streams in.");
        assert_eq!(notes, "Keep the map as you go.");
        assert!(parse("No twist today.").is_err());
        assert!(parse("{\"twist\": \"\", \"notes\": \"x\"}").is_err());
        assert!(parse("{\"twist\": \"x\"}").is_err());
    }
}
