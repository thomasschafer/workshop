//! `pack.toml`: what a pack is called, and the skills, tracks, goals and prompt add-ons it
//! defines.

use std::collections::BTreeSet;

use serde::Deserialize;
use workshop_tracks::{PackTrackId, TrackId};

use crate::error_types::{self, ErrorType};

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
    /// Kinds of mistake the pack adds to the built-in ones, for its mistake log.
    pub error_types: Vec<ErrorType>,
    pub prompts: Prompts,
    /// Styles the examiner can take in timed rounds, for the learner to choose from.
    pub examiner_styles: Vec<ExaminerStyleRef>,
}

/// A style the examiner can take, as `pack.toml` lists it: a prompt add-on of its own, added to
/// the examiner's instructions after the pack's `examiner` add-on.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExaminerStyleRef {
    pub id: String,
    pub name: String,
    /// What it's like, such as how many hints it gives, in a line.
    pub description: String,
    /// The add-on's file, relative to the pack.
    pub prompt: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize, serde::Serialize)]
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

impl Goal {
    /// The day it's wanted by, in days since 1 January 1970, if it has one.
    pub fn by_day(&self) -> Option<i64> {
        self.by.as_deref().and_then(days_since_1970)
    }
}

/// A date written as `YYYY-MM-DD`, in days since 1 January 1970.
fn days_since_1970(date: &str) -> Option<i64> {
    let mut parts = date.split('-');
    let (year, month, day) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || year.len() != 4 || month.len() != 2 || day.len() != 2 {
        return None;
    }
    let (year, month, day): (i64, i64, i64) =
        (year.parse().ok()?, month.parse().ok()?, day.parse().ok()?);
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days_in_month = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month[(month - 1) as usize] {
        return None;
    }
    // Howard Hinnant's days_from_civil.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let year_of_era = y - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * 146_097 + day_of_era - 719_468)
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
    error_types: Vec<ErrorType>,
    #[serde(default)]
    prompts: Prompts,
    #[serde(default)]
    examiner_styles: Vec<ExaminerStyleRef>,
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
            if let Some(by) = &goal.by
                && days_since_1970(by).is_none()
            {
                return Err(format!(
                    "the goal {:?} is wanted by {by:?}, which should be a date such as 2027-06-30",
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
        let mut error_types: Vec<ErrorType> = Vec::new();
        for error_type in raw.error_types {
            if !is_slug(&error_type.id) {
                return Err(format!(
                    "the error type id {:?} should be lowercase letters and digits, in words joined by hyphens",
                    error_type.id
                ));
            }
            if error_types::is_built_in(&error_type.id) {
                return Err(format!(
                    "the error type {:?} is built in already",
                    error_type.id
                ));
            }
            if error_types.iter().any(|t| t.id == error_type.id) {
                return Err(format!(
                    "the error type {:?} is listed twice",
                    error_type.id
                ));
            }
            error_types.push(error_type);
        }
        let mut styles: Vec<ExaminerStyleRef> = Vec::new();
        for style in raw.examiner_styles {
            if !is_slug(&style.id) {
                return Err(format!(
                    "the examiner style id {:?} should be lowercase letters and digits, in words joined by hyphens",
                    style.id
                ));
            }
            if styles.iter().any(|s| s.id == style.id) {
                return Err(format!("the examiner style {:?} is listed twice", style.id));
            }
            styles.push(style);
        }
        Ok(Self {
            id: raw.id,
            name: raw.name,
            description: raw.description,
            skills: raw.skills,
            tracks,
            goals,
            error_types,
            prompts: raw.prompts,
            examiner_styles: styles,
        })
    }

    /// Every kind of mistake the pack's mistakes can be tagged with: the built-in ones, then
    /// the pack's own.
    pub fn all_error_types(&self) -> Vec<ErrorType> {
        let mut all = error_types::built_in();
        all.extend(self.error_types.iter().cloned());
        all
    }

    pub fn has_skill(&self, id: &str) -> bool {
        self.skills.iter().any(|skill| skill.id == id)
    }

    /// The track an item names in its front matter: a built-in track, or one of the pack's.
    pub fn track(&self, name: &str) -> Result<TrackId, String> {
        if let Ok(built_in) = name.parse::<TrackId>()
            && !matches!(built_in, TrackId::Pack(_))
        {
            if !built_in.holds_items() {
                return Err(format!("items can't be in the {name} track"));
            }
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

        [[error_types]]
        id = "sign-error"
        name = "Sign error"
        description = "Lost a minus sign"

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
        assert_eq!(manifest.goals[0].by_day(), None);
        assert_eq!(days_since_1970("1970-01-01"), Some(0));
        assert_eq!(days_since_1970("2026-09-21"), Some(20_717));
        assert_eq!(days_since_1970("2024-02-29"), Some(19_782));
        assert_eq!(days_since_1970("2023-02-29"), None);
        assert_eq!(days_since_1970("next june"), None);
        let types = manifest.all_error_types();
        assert_eq!(types[0].id, "misread");
        assert_eq!(types.last().unwrap().id, "sign-error");
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
            (
                "id = \"x\"\nname = \"x\"\n[[skills]]\nid = \"a\"\nname = \"A\"\n[[goals]]\nid = \"g\"\nname = \"G\"\nskills = [\"a\"]\nby = \"soon\"",
                "should be a date",
            ),
            (
                "id = \"x\"\nname = \"x\"\n[[error_types]]\nid = \"off-by-one\"\nname = \"O\"\ndescription = \"d\"",
                "built in already",
            ),
            (
                "id = \"x\"\nname = \"x\"\n[[error_types]]\nid = \"Bad\"\nname = \"O\"\ndescription = \"d\"",
                "error type id",
            ),
        ];
        for (source, expected) in broken {
            let err = Manifest::parse(source).unwrap_err();
            assert!(err.contains(expected), "{source}: {err}");
        }
    }
}
