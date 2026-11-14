//! The mistake log: what went wrong, from wrong answers, failed coding submissions and the
//! grader's findings, each tagged with a kind of mistake, such as an off-by-one error.
//!
//! A tag is suggested when the mistake is recorded, from what can be told mechanically or from
//! the grader, and the learner can confirm it or choose another. The kinds are the pack's to
//! define (see `workshop_pack::error_types`); here they're only ids.

use serde::{Deserialize, Serialize};

/// Where a mistake was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MistakeSource {
    /// A wrong answer to a question, or a card the learner forgot.
    Answer,
    /// A coding submission that failed a test.
    Submission,
    /// The grader's marking of written work, such as a plan or a design.
    Grader,
}

impl MistakeSource {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Answer => "answer",
            Self::Submission => "submission",
            Self::Grader => "grader",
        }
    }

    pub(crate) fn parse(text: &str) -> Option<Self> {
        match text {
            "answer" => Some(Self::Answer),
            "submission" => Some(Self::Submission),
            "grader" => Some(Self::Grader),
            _ => None,
        }
    }
}

/// A mistake, as it's recorded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewMistake {
    /// Made from what it came from, such as the attempt's id, so recording it again changes
    /// nothing.
    pub id: String,
    /// The item, as `pack/item`.
    pub item: String,
    /// When it was made, in milliseconds since 1970.
    pub at: i64,
    pub source: MistakeSource,
    /// The attempt it was made in, if it was one.
    pub attempt: Option<String>,
    /// What went wrong, in words, such as "Answered 132; it's 123".
    pub detail: String,
    /// The kind of mistake it looks like, if that can be told.
    pub suggested: Option<String>,
}

/// A mistake in the log, with the learner's tag if they've given one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Mistake {
    #[serde(flatten)]
    pub mistake: NewMistake,
    /// The kind the learner confirmed or chose, which wins over the suggestion.
    pub confirmed: Option<String>,
}

impl Mistake {
    /// Its kind: the learner's, or else the one suggested.
    pub fn error_type(&self) -> Option<&str> {
        self.confirmed
            .as_deref()
            .or(self.mistake.suggested.as_deref())
    }
}

/// The kind of mistake a wrong numeric answer looks like, if it can be told from the numbers:
/// one away from an integer answer is off by one; the same digits in another order, or a power
/// of ten out, is a misreading; and close to the answer is a slip in the arithmetic. Otherwise
/// it's `otherwise`, such as a concept gap for a probability question.
pub fn suggest_for_number(expected: f64, given: f64, otherwise: &'static str) -> &'static str {
    let integers = expected.fract() == 0.0 && given.fract() == 0.0;
    if integers && (expected - given).abs() == 1.0 {
        return "off-by-one";
    }
    if integers && expected != given && same_digits(expected, given) {
        return "misread";
    }
    if expected != 0.0 && given != 0.0 {
        let ratio = (given / expected).abs().log10();
        if ratio.abs() >= 0.999 && (ratio - ratio.round()).abs() < 1e-9 {
            return "misread";
        }
        if ((given - expected) / expected).abs() < 0.1 {
            return "arithmetic-slip";
        }
    }
    otherwise
}

fn same_digits(a: f64, b: f64) -> bool {
    let digits = |n: f64| {
        let mut digits: Vec<char> = format!("{}", n.abs() as i64).chars().collect();
        digits.sort_unstable();
        digits
    };
    a.signum() == b.signum() && digits(a) == digits(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_kinds_of_mistake_from_the_numbers() {
        assert_eq!(suggest_for_number(42.0, 41.0, "concept-gap"), "off-by-one");
        assert_eq!(suggest_for_number(123.0, 132.0, "concept-gap"), "misread");
        assert_eq!(suggest_for_number(250.0, 2500.0, "concept-gap"), "misread");
        assert_eq!(suggest_for_number(0.25, 0.025, "concept-gap"), "misread");
        assert_eq!(
            suggest_for_number(408.0, 418.0, "concept-gap"),
            "arithmetic-slip"
        );
        assert_eq!(suggest_for_number(0.5, 0.25, "concept-gap"), "concept-gap");
        assert_eq!(
            suggest_for_number(0.0, 3.0, "wrong-approach"),
            "wrong-approach"
        );
    }
}
