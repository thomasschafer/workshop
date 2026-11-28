//! Labs: hands-on exercises the learner carries out on a machine of their own, a step at a
//! time, recording what they ran and saw at each, then answering a question about what the lab
//! showed. Everything's saved as it's written, so a lab can be stopped part-way and carried on
//! later, on any device; at the end the grader marks the whole lab against what each step
//! should show.
//!
//! The learner moves through screens: the setup, each step, then the explain question.

use serde::{Deserialize, Serialize};

/// Where the learner is with a lab, saved as it goes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Session {
    /// The screen they're on: 0 is the setup, then each step from 1, then the explain question.
    pub at: usize,
    /// The furthest screen they've reached; they can go back to any up to it.
    pub reached: usize,
    /// What they recorded at each step, one for each of the lab's steps.
    pub records: Vec<String>,
    /// Their answer to the explain question.
    #[serde(default)]
    pub explanation: String,
    /// When it was started, and last changed, in milliseconds since 1970.
    pub started_at: i64,
    pub updated_at: i64,
}

/// The learner's changes to a session.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Edit {
    pub at: usize,
    pub records: Vec<String>,
    #[serde(default)]
    pub explanation: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LabError {
    #[error("you haven't reached that part of the lab yet")]
    NotReached,
    #[error("the lab has {steps} steps, so there's no screen {at}")]
    NoSuchScreen { at: usize, steps: usize },
    #[error("the lab has {steps} steps, but {records} were recorded")]
    WrongSteps { steps: usize, records: usize },
    #[error("record what you ran and saw in at least one step before it's marked")]
    NothingRecorded,
    #[error("answer the question at the end before it's marked")]
    NotExplained,
}

impl Session {
    /// A session with a lab of `steps` steps, at its setup.
    pub fn new(steps: usize, now: i64) -> Self {
        Self {
            at: 0,
            reached: 0,
            records: vec![String::new(); steps],
            explanation: String::new(),
            started_at: now,
            updated_at: now,
        }
    }

    /// How many steps the lab had when the session started.
    pub fn steps(&self) -> usize {
        self.records.len()
    }

    /// The screen of the explain question, the last.
    pub fn explain_at(&self) -> usize {
        self.steps() + 1
    }

    /// Applies the learner's changes. They can move on one screen at a time, and back to any
    /// they've reached.
    pub fn edit(&mut self, edit: Edit, now: i64) -> Result<(), LabError> {
        if edit.records.len() != self.steps() {
            return Err(LabError::WrongSteps {
                steps: self.steps(),
                records: edit.records.len(),
            });
        }
        if edit.at > self.explain_at() {
            return Err(LabError::NoSuchScreen {
                at: edit.at,
                steps: self.steps(),
            });
        }
        if edit.at > self.reached + 1 {
            return Err(LabError::NotReached);
        }
        // Nothing is recorded at a step not reached, nor explained before the end.
        let furthest = self.reached.max(edit.at);
        let recorded_ahead = edit
            .records
            .iter()
            .enumerate()
            .any(|(i, record)| i + 1 > furthest && !record.trim().is_empty());
        if recorded_ahead || (furthest < self.explain_at() && !edit.explanation.trim().is_empty()) {
            return Err(LabError::NotReached);
        }
        self.at = edit.at;
        self.reached = furthest;
        self.records = edit.records;
        self.explanation = edit.explanation;
        self.updated_at = now;
        Ok(())
    }

    /// Whether there's enough to mark: something recorded, and the question at the end answered.
    pub fn check_markable(&self) -> Result<(), LabError> {
        if self.records.iter().all(|record| record.trim().is_empty()) {
            return Err(LabError::NothingRecorded);
        }
        if self.explanation.trim().is_empty() {
            return Err(LabError::NotExplained);
        }
        Ok(())
    }

    /// What the learner did, as the grader reads it and as it's kept with the attempt: each
    /// step, by `titles`, with what they recorded, then their answer to `explain`.
    pub fn transcript(&self, titles: &[&str], explain: &str) -> Result<String, LabError> {
        if titles.len() != self.steps() {
            return Err(LabError::WrongSteps {
                steps: titles.len(),
                records: self.steps(),
            });
        }
        let mut out = String::new();
        for (n, (title, record)) in titles.iter().zip(&self.records).enumerate() {
            let record = record.trim();
            out.push_str(&format!(
                "## Step {}: {title}\n\n{}\n\n",
                n + 1,
                if record.is_empty() {
                    "(Nothing recorded.)"
                } else {
                    record
                }
            ));
        }
        out.push_str(&format!(
            "## Explain: {}\n\n{}",
            explain.trim(),
            self.explanation.trim()
        ));
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(at: usize, records: &[&str], explanation: &str) -> Edit {
        Edit {
            at,
            records: records.iter().map(|&r| r.to_owned()).collect(),
            explanation: explanation.to_owned(),
        }
    }

    #[test]
    fn moves_through_a_lab_a_screen_at_a_time_and_back() {
        let mut session = Session::new(2, 1000);
        assert_eq!((session.at, session.reached, session.steps()), (0, 0, 2));
        // From the setup, only the first step can be reached.
        assert_eq!(
            session.edit(edit(2, &["", ""], ""), 2000),
            Err(LabError::NotReached)
        );
        session.edit(edit(1, &["ran it", ""], ""), 2000).unwrap();
        assert_eq!((session.at, session.reached), (1, 1));
        // Nothing can be recorded ahead of where the learner's been, nor explained.
        assert_eq!(
            session.edit(edit(1, &["ran it", "saw it"], ""), 2500),
            Err(LabError::NotReached)
        );
        assert_eq!(
            session.edit(edit(2, &["ran it", ""], "Because."), 2500),
            Err(LabError::NotReached)
        );
        session
            .edit(edit(2, &["ran it", "saw it"], ""), 3000)
            .unwrap();
        session
            .edit(edit(3, &["ran it", "saw it"], "Because."), 4000)
            .unwrap();
        assert_eq!((session.at, session.reached), (3, 3));
        // Going back keeps how far they'd got.
        session
            .edit(edit(1, &["ran it again", "saw it"], "Because."), 5000)
            .unwrap();
        assert_eq!((session.at, session.reached), (1, 3));
        assert_eq!(session.updated_at, 5000);
        assert_eq!(
            session.edit(edit(4, &["", ""], ""), 6000),
            Err(LabError::NoSuchScreen { at: 4, steps: 2 })
        );
        assert_eq!(
            session.edit(edit(1, &[""], ""), 6000),
            Err(LabError::WrongSteps {
                steps: 2,
                records: 1
            })
        );
        // A failed edit changes nothing.
        assert_eq!(session.records[0], "ran it again");
    }

    #[test]
    fn marks_only_a_lab_with_something_recorded_and_explained() {
        let mut session = Session::new(2, 0);
        assert_eq!(session.check_markable(), Err(LabError::NothingRecorded));
        session.edit(edit(1, &["  ", ""], ""), 1).unwrap();
        assert_eq!(session.check_markable(), Err(LabError::NothingRecorded));
        session.edit(edit(1, &["12 faults", ""], ""), 2).unwrap();
        assert_eq!(session.check_markable(), Err(LabError::NotExplained));
        session.edit(edit(2, &["12 faults", ""], ""), 3).unwrap();
        session
            .edit(edit(3, &["12 faults", ""], "The pages were new."), 4)
            .unwrap();
        session.check_markable().unwrap();
        assert_eq!(
            session
                .transcript(&["Count", "Fault"], "Why so many?")
                .unwrap(),
            "## Step 1: Count\n\n12 faults\n\n## Step 2: Fault\n\n(Nothing recorded.)\n\n## Explain: Why so many?\n\nThe pages were new."
        );
        assert!(session.transcript(&["Count"], "Why?").is_err());
    }
}
