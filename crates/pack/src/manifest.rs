//! `pack.toml`: what a pack is called, and the skills, tracks, goals and prompt add-ons it
//! defines.

use std::collections::BTreeSet;

use serde::Deserialize;
use workshop_tracks::{PackTrackId, TrackId};

/// The default mastery a goal asks of each of its skills.
const DEFAULT_GOAL_MASTERY: f64 = 0.8;

#[derive(Debug, Clone, PartialEq)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub skills: Vec<Skill>,
    pub tracks: Vec<PackTrack>,
    pub goals: Vec<Goal>,
    pub prompts: Prompts,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Skill {
    /// Words of lowercase letters and digits, joined by hyphens, in parts separated by dots,
    /// such as `probability.conditional`.
    pub id: String,
    pub name: String,
}

/// A track of the pack's own, beside the built-in ones.
#[derive(Debug, Clone, PartialEq)]
pub struct PackTrack {
    pub id: PackTrackId,
    pub name: String,
    pub summary: Option<String>,
}

/// Something the learner is working towards: a set of skills, each to be mastered to a level.
#[derive(Debug, Clone, PartialEq)]
pub struct Goal {
    pub id: String,
    pub name: String,
    pub skills: Vec<String>,
    /// The mastery each skill should reach, from 0 to 1.
    pub mastery: f64,
    /// When it's wanted by, as the pack writes it, such as `2027-06-30`.
    pub by: Option<String>,
}

/// Text added to a coach role's instructions, from files in the pack, such as to shape the
/// examiner's style.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Prompts {
    pub tutor: Option<String>,
    pub examiner: Option<String>,
    pub grader: Option<String>,
    pub author: Option<String>,
}

impl Prompts {
    /// Each role's add-on file, relative to the pack.
    pub fn files(&self) -> impl Iterator<Item = (&'static str, &str)> {
        [
            ("tutor", &self.tutor),
            ("examiner", &self.examiner),
            ("grader", &self.grader),
            ("author", &self.author),
        ]
        .into_iter()
        .filter_map(|(role, file)| file.as_deref().map(|file| (role, file)))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawManifest {
    id: String,
    name: String,
    description: Option<String>,
    #[serde(default)]
    skills: Vec<Skill>,
    #[serde(default)]
    tracks: Vec<RawTrack>,
    #[serde(default)]
    goals: Vec<RawGoal>,
    #[serde(default)]
    prompts: Prompts,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawTrack {
    id: String,
    name: String,
    summary: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawGoal {
    id: String,
    name: String,
    skills: Vec<String>,
    mastery: Option<f64>,
    by: Option<String>,
}

/// Whether `text` is lowercase letters and digits, in words joined by hyphens.
pub fn is_slug(text: &str) -> bool {
    !text.is_empty()
        && text.split('-').all(|word| {
            !word.is_empty()
                && word
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
}

fn is_skill_id(text: &str) -> bool {
    text.split('.').all(is_slug)
}

impl Manifest {
    pub fn parse(source: &str) -> Result<Self, String> {
        let raw: RawManifest = toml::from_str(source).map_err(|err| err.to_string())?;
        if !is_slug(&raw.id) {
            return Err(format!(
                "the pack's id {:?} should be lowercase letters and digits, in words joined by hyphens",
                raw.id
            ));
        }
        let mut skills = BTreeSet::new();
        for skill in &raw.skills {
            if !is_skill_id(&skill.id) {
                return Err(format!(
                    "the skill id {:?} should be words of lowercase letters and digits joined by hyphens, in parts separated by dots",
                    skill.id
                ));
            }
            if !skills.insert(skill.id.as_str()) {
                return Err(format!("the skill {:?} is listed twice", skill.id));
            }
        }
        let mut tracks = Vec::new();
        for track in raw.tracks {
            let id: PackTrackId = track.id.parse().map_err(|err| format!("{err}"))?;
            if track.id.parse::<TrackId>().is_ok() {
                return Err(format!(
                    "the track {:?} has the same id as a built-in track",
                    track.id
                ));
            }
            if tracks.iter().any(|t: &PackTrack| t.id == id) {
                return Err(format!("the track {:?} is listed twice", track.id));
            }
            tracks.push(PackTrack {
                id,
                name: track.name,
                summary: track.summary,
            });
        }
        let mut goals = Vec::new();
        for goal in raw.goals {
            if !is_slug(&goal.id) {
                return Err(format!(
                    "the goal id {:?} should be lowercase letters and digits, in words joined by hyphens",
                    goal.id
                ));
            }
            if goals.iter().any(|g: &Goal| g.id == goal.id) {
                return Err(format!("the goal {:?} is listed twice", goal.id));
            }
            if goal.skills.is_empty() {
                return Err(format!("the goal {:?} needs at least one skill", goal.id));
            }
            if let Some(unknown) = goal.skills.iter().find(|s| !skills.contains(s.as_str())) {
                return Err(format!(
                    "the goal {:?} has the skill {unknown:?}, which isn't in the pack's skills",
                    goal.id
                ));
            }
            let mastery = goal.mastery.unwrap_or(DEFAULT_GOAL_MASTERY);
            if !(mastery > 0.0 && mastery <= 1.0) {
                return Err(format!(
                    "the goal {:?} asks for mastery {mastery}, which should be above 0 and at most 1",
                    goal.id
                ));
            }
            goals.push(Goal {
                id: goal.id,
                name: goal.name,
                skills: goal.skills,
                mastery,
                by: goal.by,
            });
        }
        Ok(Self {
            id: raw.id,
            name: raw.name,
            description: raw.description,
            skills: raw.skills,
            tracks,
            goals,
            prompts: raw.prompts,
        })
    }

    pub fn has_skill(&self, id: &str) -> bool {
        self.skills.iter().any(|skill| skill.id == id)
    }

    /// The track an item names in its front matter: a built-in track, or one of the pack's.
    pub fn track(&self, name: &str) -> Result<TrackId, String> {
        if let Ok(built_in) = name.parse::<TrackId>()
            && !matches!(built_in, TrackId::Pack(_))
        {
            return Ok(built_in);
        }
        self.tracks
            .iter()
            .find(|track| track.id.as_str() == name)
            .map(|track| TrackId::Pack(track.id.clone()))
            .ok_or_else(|| format!("there's no track called {name:?} built in or in the pack"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MANIFEST: &str = r#"
        id = "example"
        name = "Example"

        [[skills]]
        id = "arithmetic.multiplication"
        name = "Multiplication"

        [[skills]]
        id = "graphs"
        name = "Graphs"

        [[tracks]]
        id = "estimation"
        name = "Estimation"

        [[goals]]
        id = "quick-sums"
        name = "Quick sums"
        skills = ["arithmetic.multiplication"]

        [prompts]
        examiner = "prompts/examiner.md"
    "#;

    #[test]
    fn reads_a_manifest() {
        let manifest = Manifest::parse(MANIFEST).unwrap();
        assert_eq!(manifest.id, "example");
        assert!(manifest.has_skill("graphs"));
        assert!(!manifest.has_skill("geometry"));
        assert_eq!(manifest.goals[0].mastery, 0.8);
        assert_eq!(
            manifest.prompts.files().collect::<Vec<_>>(),
            [("examiner", "prompts/examiner.md")]
        );
        assert_eq!(manifest.track("review").unwrap(), TrackId::Review);
        assert_eq!(
            manifest.track("estimation").unwrap(),
            TrackId::Pack("estimation".parse().unwrap())
        );
        assert!(manifest.track("chess").is_err());
    }

    #[test]
    fn refuses_manifests_that_contradict_themselves() {
        let broken = [
            ("id = \"Example\"\nname = \"x\"", "lowercase"),
            (
                "id = \"x\"\nname = \"x\"\ncolour = \"red\"",
                "unknown field",
            ),
            (
                "id = \"x\"\nname = \"x\"\n[[skills]]\nid = \"a\"\nname = \"A\"\n[[skills]]\nid = \"a\"\nname = \"B\"",
                "listed twice",
            ),
            (
                "id = \"x\"\nname = \"x\"\n[[skills]]\nid = \"A.b\"\nname = \"A\"",
                "skill id",
            ),
            (
                "id = \"x\"\nname = \"x\"\n[[tracks]]\nid = \"review\"\nname = \"R\"",
                "built-in",
            ),
            (
                "id = \"x\"\nname = \"x\"\n[[goals]]\nid = \"g\"\nname = \"G\"\nskills = [\"nope\"]",
                "isn't in the pack's skills",
            ),
            (
                "id = \"x\"\nname = \"x\"\n[[skills]]\nid = \"a\"\nname = \"A\"\n[[goals]]\nid = \"g\"\nname = \"G\"\nskills = [\"a\"]\nmastery = 1.5",
                "at most 1",
            ),
        ];
        for (source, expected) in broken {
            let err = Manifest::parse(source).unwrap_err();
            assert!(err.contains(expected), "{source}: {err}");
        }
    }
}
