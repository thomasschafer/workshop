//! A design prompt's brief: who uses the system, what it must do, its scale and the qualities
//! it needs. The learner finds it out by asking, and the coach or the examiner answers from it,
//! so it's kept with the session or round, and never changes during one, except for the details
//! settled when the learner asks something it doesn't cover.

use serde::{Deserialize, Serialize};

/// Where a brief came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BriefSource {
    /// The design prompt's own, from its pack.
    Pack,
    /// Made up by the coach as the session started, for a prompt without one.
    Coach,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Brief {
    pub text: String,
    pub source: BriefSource,
    /// Details the brief didn't cover, settled by the coach's answers when the learner asked,
    /// in the order they were.
    #[serde(default)]
    pub added: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("a design prompt's brief can't be empty")]
pub struct EmptyBrief;

impl Brief {
    pub fn new(text: &str, source: BriefSource) -> Result<Self, EmptyBrief> {
        let text = text.trim();
        if text.is_empty() {
            return Err(EmptyBrief);
        }
        Ok(Self {
            text: text.to_owned(),
            source,
            added: Vec::new(),
        })
    }

    /// Keeps a detail settled by an answer, so later answers, and the grader, agree with it.
    pub fn add(&mut self, detail: &str) {
        let detail = detail.trim();
        if !detail.is_empty() {
            self.added.push(detail.to_owned());
        }
    }

    /// The brief as the coach, the examiner and the grader read it, and the learner once it's
    /// marked: its text, then what was settled along the way.
    pub fn full(&self) -> String {
        if self.added.is_empty() {
            return self.text.clone();
        }
        let added: String = self
            .added
            .iter()
            .map(|detail| format!("- {detail}\n"))
            .collect();
        format!(
            "{}\n\nSettled when the learner asked:\n{}",
            self.text,
            added.trim_end()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_what_was_settled_after_the_brief() {
        assert_eq!(Brief::new(" \n", BriefSource::Pack), Err(EmptyBrief));
        let mut brief = Brief::new("- 100 users\n", BriefSource::Coach).unwrap();
        assert_eq!(brief.full(), "- 100 users");
        brief.add("  ");
        brief.add(" Links never expire. ");
        brief.add("Codes are 7 characters.");
        assert_eq!(
            brief.full(),
            "- 100 users\n\nSettled when the learner asked:\n- Links never expire.\n- Codes are 7 characters."
        );
    }
}
