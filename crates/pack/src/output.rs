//! Comparing what a program printed, or what a learner typed, with what was expected.
//!
//! Output is compared line by line, ignoring whitespace at the ends of lines and blank lines at
//! the start and end, which programs and phones' keyboards add without meaning anything by it.
//! The app compares typed answers the same way, and `tests/output.json` holds cases both must
//! agree on.

/// What's compared of some output: its lines, with the whitespace that doesn't count removed.
pub fn normalise(text: &str) -> String {
    let lines: Vec<&str> = text.lines().map(str::trim_end).collect();
    let start = lines.iter().position(|line| !line.is_empty());
    let end = lines.iter().rposition(|line| !line.is_empty());
    match (start, end) {
        (Some(start), Some(end)) => lines[start..=end].join("\n"),
        _ => String::new(),
    }
}

/// Whether two outputs are the same, as far as what's compared goes.
pub fn same(expected: &str, actual: &str) -> bool {
    normalise(expected) == normalise(actual)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Case {
        expected: String,
        actual: String,
        same: bool,
    }

    #[test]
    fn compares_as_the_app_does() {
        let cases: Vec<Case> = serde_json::from_str(include_str!("../tests/output.json")).unwrap();
        assert!(cases.len() > 5);
        for case in cases {
            assert_eq!(
                same(&case.expected, &case.actual),
                case.same,
                "{:?} against {:?}",
                case.actual,
                case.expected
            );
        }
    }
}
