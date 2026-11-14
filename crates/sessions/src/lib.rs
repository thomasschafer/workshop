//! Long items, done in a sitting rather than a few minutes at a time: guided design sessions,
//! and timed rounds with the examiner. Each is saved as it goes, so the learner can stop and
//! carry on later, on any device.
//!
//! This crate keeps where each one is and the rules it follows. Talking to the coach, the
//! examiner and the grader, and recording the attempt at the end, are up to the app.

pub mod design;
pub mod round;
mod saved;

use serde::{Deserialize, Serialize};

pub use saved::Saved;

/// Who said something in a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Speaker {
    Learner,
    /// The coach of a design session, or the examiner of a round.
    Coach,
}

/// Something said in a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Turn {
    pub speaker: Speaker,
    pub text: String,
    /// When, in milliseconds since 1970.
    pub at: i64,
}

/// A conversation as a coach's prompt shows it, one line per turn.
pub fn conversation(turns: &[Turn]) -> String {
    turns
        .iter()
        .map(|turn| {
            let who = match turn.speaker {
                Speaker::Learner => "Learner",
                Speaker::Coach => "You",
            };
            format!("{who}: {}\n", turn.text.trim())
        })
        .collect()
}
