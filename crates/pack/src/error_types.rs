//! The kinds of mistake a learner makes, which the mistake log tags each mistake with: a small
//! built-in taxonomy, which a pack can add to in its `pack.toml`.

use serde::{Deserialize, Serialize};

/// A kind of mistake, such as an off-by-one error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ErrorType {
    /// Lowercase letters and digits, in words joined by hyphens.
    pub id: String,
    pub name: String,
    /// What it means, for the learner choosing a tag and for the grader.
    pub description: String,
}

/// The built-in kinds of mistake: (id, name, description).
const BUILT_IN: &[(&str, &str, &str)] = &[
    (
        "misread",
        "Misread",
        "Answered a different question from the one asked, such as by misreading a number or a condition",
    ),
    (
        "arithmetic-slip",
        "Arithmetic slip",
        "The method was right, and a calculation along the way went wrong",
    ),
    (
        "off-by-one",
        "Off by one",
        "Counted one too many or one too few, such as at the end of a range",
    ),
    (
        "missed-edge-case",
        "Missed edge case",
        "Right in general, and wrong for an unusual input, such as an empty one",
    ),
    (
        "wrong-approach",
        "Wrong approach",
        "Took a method that can't give the right answer",
    ),
    (
        "concept-gap",
        "Concept gap",
        "Didn't know or misunderstood an idea the question needs",
    ),
    (
        "missed-requirement",
        "Missed requirement",
        "Didn't find out something a design had to do or handle, or assumed it without asking",
    ),
    (
        "missed-defect",
        "Missed defect",
        "Reviewing a change, didn't find something wrong with it",
    ),
    (
        "too-slow",
        "Too slow",
        "Got there, or would have, but took too long, or the solution does",
    ),
];

/// The built-in kinds of mistake.
pub fn built_in() -> Vec<ErrorType> {
    BUILT_IN
        .iter()
        .map(|(id, name, description)| ErrorType {
            id: (*id).to_owned(),
            name: (*name).to_owned(),
            description: (*description).to_owned(),
        })
        .collect()
}

pub fn is_built_in(id: &str) -> bool {
    BUILT_IN.iter().any(|(built_in, _, _)| *built_in == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_ids_are_slugs_and_distinct() {
        let types = built_in();
        let mut ids: Vec<&str> = types.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.iter().all(|id| crate::manifest::is_slug(id)));
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), BUILT_IN.len());
        assert!(is_built_in("off-by-one"));
        assert!(is_built_in("missed-requirement"));
        assert!(!is_built_in("guessed"));
    }
}
