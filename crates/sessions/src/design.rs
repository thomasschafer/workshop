//! Design sessions: a design prompt worked through in stages, from the requirements to its
//! trade-offs, with a coach asking follow-up questions at each. Every stage is saved as it's written, so the
//! learner can stop at any one and carry on later; at the end the whole session is marked
//! against the prompt's rubric.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{Speaker, Turn};

/// One of a design session's stages, in the order they're done.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Requirements,
    Scale,
    Outline,
    DeepDive,
    TradeOffs,
}

impl Stage {
    pub const ALL: [Self; 5] = [
        Self::Requirements,
        Self::Scale,
        Self::Outline,
        Self::DeepDive,
        Self::TradeOffs,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::Requirements => "Clarify the requirements",
            Self::Scale => "Estimate the scale",
            Self::Outline => "Outline the design",
            Self::DeepDive => "Deep-dive one component",
            Self::TradeOffs => "Trade-offs and failure modes",
        }
    }

    /// What the learner does at this stage, for them and for the coach.
    pub fn task(self) -> &'static str {
        match self {
            Self::Requirements => {
                "Say what the system must do and what it needn't, who uses it and how, and which qualities matter most, such as latency, consistency or availability."
            }
            Self::Scale => {
                "Estimate the load: requests per second for reads and writes, how much is stored and how fast it grows, and the bandwidth, from stated assumptions."
            }
            Self::Outline => {
                "Sketch the high-level design: the components, what each does and which talk to which, and how a typical request flows through them."
            }
            Self::DeepDive => {
                "Choose one component and go into it: its data model, algorithms, how it scales and what it depends on."
            }
            Self::TradeOffs => {
                "Weigh the choices made and their alternatives, and say what happens when parts fail or are overloaded, and how the system recovers."
            }
        }
    }

    pub fn next(self) -> Option<Self> {
        let at = Self::ALL.iter().position(|&s| s == self)?;
        Self::ALL.get(at + 1).copied()
    }
}

/// A part of the design, sketched as a list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Component {
    pub name: String,
    /// What it does.
    #[serde(default)]
    pub role: String,
    /// The components it talks to, by name.
    #[serde(default)]
    pub talks_to: Vec<String>,
}

/// What's been done at one stage.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StageWork {
    /// The learner's notes, typed or dictated.
    #[serde(default)]
    pub notes: String,
    /// The coach's follow-up questions, and the learner's replies.
    #[serde(default)]
    pub turns: Vec<Turn>,
}

/// Where the learner is with a design prompt, saved as it goes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Session {
    /// The stage they're at.
    pub stage: Stage,
    /// The furthest stage they've reached; they can go back to any stage up to it.
    pub reached: Stage,
    #[serde(default)]
    pub work: BTreeMap<Stage, StageWork>,
    #[serde(default)]
    pub components: Vec<Component>,
    /// The component chosen to go into, by name.
    #[serde(default)]
    pub deep_dive: Option<String>,
    /// When it was started, and last changed, in milliseconds since 1970.
    pub started_at: i64,
    pub updated_at: i64,
}

/// The learner's own changes to a session: everything but the coach's turns, which only the
/// coach adds to.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Edit {
    pub stage: Stage,
    #[serde(default)]
    pub notes: BTreeMap<Stage, String>,
    #[serde(default)]
    pub components: Vec<Component>,
    #[serde(default)]
    pub deep_dive: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DesignError {
    #[error("{} isn't a stage you've reached yet", .0.name())]
    NotReached(Stage),
    #[error("there's no component called {0:?} to go into")]
    NoSuchComponent(String),
    #[error("every component needs a name")]
    UnnamedComponent,
    #[error("there are two components called {0:?}")]
    DuplicateComponent(String),
    #[error("there's nothing in the session to mark yet")]
    Empty,
}

impl Session {
    pub fn new(now: i64) -> Self {
        Self {
            stage: Stage::Requirements,
            reached: Stage::Requirements,
            work: BTreeMap::new(),
            components: Vec::new(),
            deep_dive: None,
            started_at: now,
            updated_at: now,
        }
    }

    /// Applies the learner's changes. They can move on one stage at a time, and back to any
    /// stage they've reached.
    pub fn edit(&mut self, edit: Edit, now: i64) -> Result<(), DesignError> {
        let furthest = self.reached.next().unwrap_or(self.reached);
        if edit.stage > furthest {
            return Err(DesignError::NotReached(edit.stage));
        }
        if let Some(&stage) = edit.notes.keys().find(|&&stage| stage > furthest) {
            return Err(DesignError::NotReached(stage));
        }
        let mut names = std::collections::BTreeSet::new();
        for component in &edit.components {
            let name = component.name.trim();
            if name.is_empty() {
                return Err(DesignError::UnnamedComponent);
            }
            if !names.insert(name.to_lowercase()) {
                return Err(DesignError::DuplicateComponent(name.to_owned()));
            }
        }
        if let Some(chosen) = &edit.deep_dive
            && !edit
                .components
                .iter()
                .any(|c| c.name.trim() == chosen.trim())
        {
            return Err(DesignError::NoSuchComponent(chosen.clone()));
        }
        for (stage, notes) in edit.notes {
            self.work.entry(stage).or_default().notes = notes;
        }
        self.stage = edit.stage;
        self.reached = self.reached.max(edit.stage);
        self.components = edit.components;
        self.deep_dive = edit.deep_dive;
        self.updated_at = now;
        Ok(())
    }

    /// Adds what was said at a stage the learner has reached.
    pub fn say(
        &mut self,
        stage: Stage,
        speaker: Speaker,
        text: &str,
        now: i64,
    ) -> Result<(), DesignError> {
        if stage > self.reached {
            return Err(DesignError::NotReached(stage));
        }
        self.work.entry(stage).or_default().turns.push(Turn {
            speaker,
            text: text.trim().to_owned(),
            at: now,
        });
        self.updated_at = now;
        Ok(())
    }

    /// The conversation with the coach at a stage.
    pub fn turns(&self, stage: Stage) -> &[Turn] {
        self.work.get(&stage).map_or(&[], |work| &work.turns)
    }

    /// The session so far, as the coach and the grader read it: each stage reached, with its
    /// notes and the questions asked about it, and the component list.
    pub fn transcript(&self) -> String {
        let mut out = String::new();
        for stage in Stage::ALL.into_iter().filter(|&s| s <= self.reached) {
            let heading = match (stage, &self.deep_dive) {
                (Stage::DeepDive, Some(chosen)) => format!("{}: {chosen}", stage.name()),
                _ => stage.name().to_owned(),
            };
            out.push_str(&format!("## {heading}\n\n"));
            if stage == Stage::Outline && !self.components.is_empty() {
                out.push_str("Components:\n");
                for component in &self.components {
                    out.push_str(&format!("- {}", component.name.trim()));
                    if !component.role.trim().is_empty() {
                        out.push_str(&format!(": {}", component.role.trim()));
                    }
                    let talks_to: Vec<&str> = component
                        .talks_to
                        .iter()
                        .map(|name| name.trim())
                        .filter(|name| !name.is_empty())
                        .collect();
                    if !talks_to.is_empty() {
                        out.push_str(&format!(" (talks to {})", talks_to.join(", ")));
                    }
                    out.push('\n');
                }
                out.push('\n');
            }
            let work = self.work.get(&stage);
            match work.map(|w| w.notes.trim()).filter(|n| !n.is_empty()) {
                Some(notes) => out.push_str(&format!("{notes}\n\n")),
                None => out.push_str("(Nothing written.)\n\n"),
            }
            for turn in work.map_or(&[][..], |w| &w.turns) {
                let who = match turn.speaker {
                    Speaker::Coach => "Coach",
                    Speaker::Learner => "Learner",
                };
                out.push_str(&format!("{who}: {}\n", turn.text));
            }
            if work.is_some_and(|w| !w.turns.is_empty()) {
                out.push('\n');
            }
        }
        out.trim_end().to_owned()
    }

    /// Whether the learner has written or said anything to mark.
    pub fn check_markable(&self) -> Result<(), DesignError> {
        let anything = !self.components.is_empty()
            || self.work.values().any(|work| {
                !work.notes.trim().is_empty()
                    || work.turns.iter().any(|t| t.speaker == Speaker::Learner)
            });
        if anything {
            Ok(())
        } else {
            Err(DesignError::Empty)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(stage: Stage) -> Edit {
        Edit {
            stage,
            notes: BTreeMap::new(),
            components: Vec::new(),
            deep_dive: None,
        }
    }

    fn component(name: &str, role: &str, talks_to: &[&str]) -> Component {
        Component {
            name: name.to_owned(),
            role: role.to_owned(),
            talks_to: talks_to.iter().map(|&s| s.to_owned()).collect(),
        }
    }

    #[test]
    fn goes_through_the_stages_in_order() {
        assert_eq!(Stage::Requirements.next(), Some(Stage::Scale));
        assert_eq!(Stage::TradeOffs.next(), None);
        let mut session = Session::new(1);
        // A stage can't be skipped.
        assert_eq!(
            session.edit(edit(Stage::Outline), 2),
            Err(DesignError::NotReached(Stage::Outline))
        );
        session.edit(edit(Stage::Scale), 2).unwrap();
        session.edit(edit(Stage::Outline), 3).unwrap();
        assert_eq!(session.reached, Stage::Outline);
        // Going back keeps how far it's got.
        session.edit(edit(Stage::Requirements), 4).unwrap();
        assert_eq!(
            (session.stage, session.reached, session.updated_at),
            (Stage::Requirements, Stage::Outline, 4)
        );
        session.edit(edit(Stage::DeepDive), 5).unwrap();
        assert_eq!(session.reached, Stage::DeepDive);
        // Notes can't be written ahead of where it's got, either.
        let mut ahead = edit(Stage::Requirements);
        ahead.notes.insert(Stage::TradeOffs, "Later".to_owned());
        let mut fresh = Session::new(1);
        assert_eq!(
            fresh.edit(ahead, 2),
            Err(DesignError::NotReached(Stage::TradeOffs))
        );
    }

    #[test]
    fn keeps_the_component_list_sensible() {
        let mut session = Session::new(1);
        let mut change = edit(Stage::Requirements);
        change.components = vec![component("Cache", "", &[]), component(" cache ", "", &[])];
        assert_eq!(
            session.edit(change.clone(), 2),
            Err(DesignError::DuplicateComponent("cache".to_owned()))
        );
        change.components = vec![component("  ", "", &[])];
        assert_eq!(
            session.edit(change.clone(), 2),
            Err(DesignError::UnnamedComponent)
        );
        change.components = vec![component("Cache", "", &[])];
        change.deep_dive = Some("Store".to_owned());
        assert_eq!(
            session.edit(change.clone(), 2),
            Err(DesignError::NoSuchComponent("Store".to_owned()))
        );
        change.deep_dive = Some("Cache".to_owned());
        session.edit(change, 2).unwrap();
        // Nothing failed changed the session.
        assert_eq!(session.components.len(), 1);
    }

    #[test]
    fn writes_out_the_session_for_the_coach_and_grader() {
        let mut session = Session::new(1);
        assert_eq!(session.check_markable(), Err(DesignError::Empty));
        let mut change = edit(Stage::Scale);
        change.notes.insert(
            Stage::Requirements,
            "Make short links, and follow them.".to_owned(),
        );
        session.edit(change, 2).unwrap();
        session.check_markable().unwrap();
        session
            .say(Stage::Requirements, Speaker::Coach, "Do links expire?", 3)
            .unwrap();
        session
            .say(Stage::Requirements, Speaker::Learner, " After a year. ", 4)
            .unwrap();
        assert_eq!(
            session.say(Stage::Outline, Speaker::Learner, "x", 5),
            Err(DesignError::NotReached(Stage::Outline))
        );
        let mut change = edit(Stage::Outline);
        change.components = vec![
            component("API", "Takes requests", &["Store", " "]),
            component("Store", "", &[]),
        ];
        session.edit(change, 6).unwrap();
        let mut change = edit(Stage::DeepDive);
        change.components = session.components.clone();
        change.deep_dive = Some("Store".to_owned());
        session.edit(change, 7).unwrap();
        assert_eq!(
            session.transcript(),
            "## Clarify the requirements\n\nMake short links, and follow them.\n\nCoach: Do links expire?\nLearner: After a year.\n\n## Estimate the scale\n\n(Nothing written.)\n\n## Outline the design\n\nComponents:\n- API: Takes requests (talks to Store)\n- Store\n\n(Nothing written.)\n\n## Deep-dive one component: Store\n\n(Nothing written.)"
        );
        assert_eq!(session.turns(Stage::Requirements).len(), 2);
        assert!(session.turns(Stage::Scale).is_empty());
    }
}
