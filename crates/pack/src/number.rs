//! Numeric answers: reading what an item says the answer is, and what the learner typed, and
//! whether the two agree.
//!
//! The app grades answers on the phone too, so it can say straight away whether one was right
//! while offline. `tests/grading.json` holds cases both must agree on.

use serde::{Deserialize, Serialize};

/// How far a learner's answer may be from the exact one and still be right: within any of the
/// bounds is enough.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Tolerance {
    pub absolute: f64,
    /// As a fraction of the exact answer, such as 0.005 for half a percent.
    pub relative: f64,
    /// For an answer only the magnitude of matters: how many times bigger or smaller than the
    /// exact answer it may be, such as 2 for anything from half to twice it. Always above 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub factor: Option<f64>,
}

impl Tolerance {
    pub const EXACT: Self = Self {
        absolute: 1e-9,
        relative: 0.0,
        factor: None,
    };

    pub fn allows(&self, expected: f64, given: f64) -> bool {
        let close = (given - expected).abs() <= self.absolute.max(self.relative * expected.abs());
        let same_magnitude = self.factor.is_some_and(|factor| {
            // Of the same sign, and neither zero, so the ratio says how far apart they are.
            let ratio = given / expected;
            ratio > 0.0 && ratio <= factor && ratio >= 1.0 / factor
        });
        close || same_magnitude
    }
}

/// Reads a number as a learner or an item writes it: an integer, a decimal, a fraction such as
/// `5/36`, or a percentage such as `12.5%`. Spaces and thousands separators are ignored.
pub fn parse(text: &str) -> Option<f64> {
    let text: String = text
        .chars()
        .filter(|c| !c.is_whitespace() && *c != ',' && *c != '_')
        .map(|c| if c == '−' { '-' } else { c })
        .collect();
    if text.is_empty() {
        return None;
    }
    let value = if let Some(percent) = text.strip_suffix('%') {
        decimal(percent)? / 100.0
    } else if let Some((numerator, denominator)) = text.split_once('/') {
        let denominator = decimal(denominator)?;
        if denominator == 0.0 {
            return None;
        }
        decimal(numerator)? / denominator
    } else {
        decimal(&text)?
    };
    value.is_finite().then_some(value)
}

/// A plain decimal, without the exponents, infinities and NaNs Rust's parser also accepts.
fn decimal(text: &str) -> Option<f64> {
    let digits = text.strip_prefix(['-', '+']).unwrap_or(text);
    let valid = !digits.is_empty()
        && digits.chars().all(|c| c.is_ascii_digit() || c == '.')
        && digits.chars().filter(|&c| c == '.').count() <= 1
        && digits != ".";
    if valid { text.parse().ok() } else { None }
}

/// Whether `response` is a right answer, or None if it can't be read as a number at all.
pub fn grade(expected: f64, tolerance: Tolerance, response: &str) -> Option<bool> {
    parse(response).map(|given| tolerance.allows(expected, given))
}

/// A number as the app shows it: integers without a decimal point, and other numbers to at most
/// six decimal places, without trailing zeros.
pub fn display(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        return format!("{}", value as i64);
    }
    let text = format!("{value:.6}");
    text.trim_end_matches('0').trim_end_matches('.').to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Case {
        expected: f64,
        tolerance: Tolerance,
        response: String,
        /// Null when the response isn't a number.
        correct: Option<bool>,
    }

    #[test]
    fn grades_as_the_app_does() {
        let cases: Vec<Case> = serde_json::from_str(include_str!("../tests/grading.json")).unwrap();
        assert!(cases.len() > 10);
        for case in cases {
            assert_eq!(
                grade(case.expected, case.tolerance, &case.response),
                case.correct,
                "{:?} against {}",
                case.response,
                case.expected
            );
        }
    }

    #[test]
    fn reads_numbers_written_in_different_ways() {
        assert_eq!(parse("5/36"), Some(5.0 / 36.0));
        assert_eq!(parse(" 1,234 "), Some(1234.0));
        assert_eq!(parse("12.5%"), Some(0.125));
        assert_eq!(parse("−3"), Some(-3.0));
        assert_eq!(parse(".5"), Some(0.5));
        for bad in ["", "abc", "1/0", "1e5", "inf", "NaN", "1.2.3", ".", "1/2/3"] {
            assert_eq!(parse(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn shows_numbers_without_needless_digits() {
        assert_eq!(display(42.0), "42");
        assert_eq!(display(-7.0), "-7");
        assert_eq!(display(0.125), "0.125");
        assert_eq!(display(1.0 / 3.0), "0.333333");
        assert_eq!(display(2.5000001), "2.5");
    }
}
