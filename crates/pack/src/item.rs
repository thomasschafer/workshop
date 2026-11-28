//! Items: Markdown files with TOML front matter between `+++` lines, whose body is the prompt,
//! followed by sections under `## ` headings that depend on the item's kind.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use workshop_tracks::TrackId;

use crate::code::{Coding, CodingFields, MAX_PARTS, PartText, Reading, ReadingFields};
use crate::lab::{Lab, LabFields};
use crate::lesson::{Lesson, LessonFields, LessonRef};
use crate::manifest::{Manifest, is_slug};
use crate::number::{self, Tolerance};
use crate::project::{self, CodebaseFields, Review};

/// The relative tolerance for a probability answer, unless the item gives its own.
const DEFAULT_ANSWER_TOLERANCE: f64 = 0.005;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    /// A question and its answer, which the learner marks themselves.
    Card,
    /// A template of sums, with fresh numbers each time and a computed answer.
    MentalMaths,
    /// A question with an exact numeric answer, which a simulation must agree with.
    Probability,
    /// A problem to solve in code, with a reference solution, a brute-force one and tests.
    Coding,
    /// Code to read, with a question about it, checked by building and running the code.
    Reading,
    /// A design prompt, marked against a rubric.
    Design,
    /// A small project of someone else's code, with a task in it: fixing a bug, reviewing a
    /// change, or refactoring then extending it.
    Codebase,
    /// A short piece that teaches a topic in a few minutes before its questions.
    Lesson,
    /// A hands-on exercise the learner carries out on a machine of their own, recording what
    /// they ran and saw, marked by the grader against what each step should show.
    Lab,
}

impl Kind {
    /// The track an item of this kind is in, unless it says otherwise.
    pub fn default_track(self) -> TrackId {
        match self {
            Self::Card | Self::Lesson | Self::Lab => TrackId::Review,
            Self::MentalMaths => TrackId::MentalMaths,
            Self::Probability => TrackId::Probability,
            Self::Coding | Self::Reading | Self::Codebase => TrackId::Coding,
            Self::Design => TrackId::SystemDesign,
        }
    }

    /// Whether an item of this kind can be in a track of a pack's own, which offers short items
    /// a few at a time and lists its problems. Design prompts are worked through only in the
    /// System design track.
    pub fn can_be_in_pack_track(self) -> bool {
        self != Self::Design
    }

    /// Roughly how many minutes an item of this kind takes, unless it says.
    fn default_minutes(self) -> u32 {
        match self {
            Self::Card | Self::MentalMaths => 1,
            Self::Reading => 2,
            Self::Probability => 3,
            Self::Lesson => 4,
            Self::Coding | Self::Codebase => 20,
            Self::Design => 30,
            Self::Lab => 40,
        }
    }

    /// Whether items of this kind are short enough to do offline in a spare minute.
    pub fn is_short(self) -> bool {
        matches!(
            self,
            Self::Card | Self::MentalMaths | Self::Probability | Self::Reading
        )
    }

    /// Whether rating an item of this kind easy retires it, so it's never offered again. Only a
    /// coding problem: solving one again that came easily teaches little, as spacing helps
    /// remembering facts far more than solving problems. Short items, such as cards and mental
    /// maths, take a minute and are what spacing is for, so an easy rating only sends them
    /// further off. Work in a codebase is the same.
    pub fn retires_when_easy(self) -> bool {
        matches!(self, Self::Coding | Self::Codebase)
    }

    /// Whether an item of this kind has one fixed answer that the app marks itself: code to
    /// read and probability questions. Seen again, such an item soon tests memory of its answer
    /// rather than the concept, so a right answer offers retiring it, as well as sending it
    /// further off. Mental maths is made afresh each time, and cards are marked by the learner.
    pub fn has_fixed_answer(self) -> bool {
        matches!(self, Self::Reading | Self::Probability)
    }

    fn sections(self) -> &'static [(&'static str, bool)] {
        // (heading, required)
        match self {
            Self::Card => &[("Answer", true), ("Explanation", false)],
            Self::MentalMaths => &[("Method", false)],
            Self::Probability => &[("Solution", true), ("Simulation", true)],
            // A problem in parts has a section saying what each part after the first adds, and
            // can have its hints, up to `MAX_PARTS`.
            Self::Coding => &[
                ("Approach", true),
                ("Hints", false),
                ("Notes", false),
                ("Part 2", false),
                ("Part 2 hints", false),
                ("Part 3", false),
                ("Part 3 hints", false),
                ("Part 4", false),
                ("Part 4 hints", false),
                ("Part 5", false),
                ("Part 5 hints", false),
            ],
            Self::Reading => &[("Explanation", true)],
            Self::Design => &[("Rubric", true), ("Notes", false), ("Brief", false)],
            // Which are required depends on the task, so the task checks them.
            Self::Codebase => &[
                ("Explanation", false),
                ("Defects", false),
                ("Hints", false),
                ("Notes", false),
                ("Part 2", false),
                ("Part 2 hints", false),
                ("Part 3", false),
                ("Part 3 hints", false),
                ("Part 4", false),
                ("Part 4 hints", false),
                ("Part 5", false),
                ("Part 5 hints", false),
            ],
            // Lessons have arbitrary segment headings plus `Explain` and `Explain answer`, handled
            // by `split_lesson_sections`.
            Self::Lesson => &[("Explain", true), ("Explain answer", true)],
            // Labs have arbitrary step headings too, between `Setup` and `Explain`, handled by
            // `split_lesson_sections` and `Lab::new`.
            Self::Lab => &[("Setup", true), ("Explain", true), ("Explain answer", true)],
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub id: String,
    /// Where it is in the pack, for messages.
    pub path: String,
    pub kind: Kind,
    pub title: Option<String>,
    pub skills: Vec<String>,
    pub track: TrackId,
    /// Where the item came from, in the pack author's words, such as for imported questions.
    pub source: Option<String>,
    /// Roughly how long it takes.
    pub minutes: u32,
    /// How hard it is, from `DIFFICULTY`'s easiest to its hardest, if the pack says.
    pub difficulty: Option<u8>,
    /// For a short item, the lesson that teaches it, and optionally which segment of it.
    pub lesson: Option<LessonRef>,
    /// What the learner is asked, in Markdown.
    pub prompt: String,
    pub content: Content,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Content {
    Card {
        answer: String,
        explanation: Option<String>,
        /// How many follow-up questions the tutor asks when the learner goes deeper, having
        /// answered in their own words.
        follow_ups: FollowUps,
    },
    MentalMaths(MentalMaths),
    Probability(Probability),
    /// A problem to solve in code: from a starter, or in a codebase, a fix or a refactor.
    Coding(Coding),
    Reading(Reading),
    /// A change to a codebase to review.
    Review(Review),
    Design {
        /// What a good answer covers, one point each.
        rubric: Vec<String>,
        notes: Option<String>,
        /// What the coach answers the learner's questions from: who uses the system, what it
        /// must do, its scale and the qualities it needs. Never shown before the session's
        /// marked. Without one, the coach makes one up as a session starts.
        brief: Option<String>,
    },
    Lesson(Lesson),
    Lab(Lab),
}

#[derive(Debug, Clone, PartialEq)]
pub struct MentalMaths {
    /// The numbers drawn for each instance, by name.
    pub params: BTreeMap<String, Param>,
    /// Values worked out from the params, by name, for the prompt to show.
    pub derived: BTreeMap<String, String>,
    /// An expression of the params and derived values.
    pub answer: String,
    /// An expression the params must satisfy, such as `a != b`.
    pub require: Option<String>,
    pub tolerance: Tolerance,
    /// How to work it out, shown after answering, with the instance's values filled in.
    pub method: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Param {
    /// Any integer from `min` to `max`, inclusive.
    Range { min: i64, max: i64 },
    /// One of these.
    Choices { choices: Vec<i64> },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawParam {
    min: Option<i64>,
    max: Option<i64>,
    choices: Option<Vec<i64>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Probability {
    /// The exact answer, as the pack writes it, such as `5/36`.
    pub answer_text: String,
    pub answer: f64,
    pub tolerance: Tolerance,
    pub solution: String,
    pub simulation: Simulation,
}

/// A Monte Carlo check of a probability item: the script is one trial, giving true or false
/// for a probability, or a number for an expectation, and the mean over the trials must be
/// within `tolerance` of the exact answer.
#[derive(Debug, Clone, PartialEq)]
pub struct Simulation {
    pub script: String,
    pub trials: u32,
    pub tolerance: f64,
}

/// How many follow-up questions the tutor asks about a card answered in the learner's own
/// words, before the grader marks the whole exchange: none, for a card that shouldn't offer them,
/// up to [`FollowUps::MOST`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "u8", into = "u8")]
pub struct FollowUps(u8);

impl FollowUps {
    /// For a card that doesn't say.
    pub const DEFAULT: Self = Self(2);
    pub const MOST: u8 = 3;

    pub fn new(count: i64) -> Result<Self, String> {
        match u8::try_from(count) {
            Ok(count) if count <= Self::MOST => Ok(Self(count)),
            _ => Err(format!(
                "follow_ups should be from 0 to {}, not {count}",
                Self::MOST
            )),
        }
    }

    pub fn get(self) -> u8 {
        self.0
    }

    /// Whether the card offers follow-up questions at all.
    pub fn offered(self) -> bool {
        self.0 > 0
    }
}

impl TryFrom<u8> for FollowUps {
    type Error = String;

    fn try_from(count: u8) -> Result<Self, String> {
        Self::new(i64::from(count))
    }
}

impl From<FollowUps> for u8 {
    fn from(follow_ups: FollowUps) -> Self {
        follow_ups.0
    }
}

/// How hard an item can be: 1 is a warm-up, 3 typical of its kind, and 5 among the hardest of
/// its kind.
pub const DIFFICULTY: std::ops::RangeInclusive<u8> = 1..=5;

const COMMON_KEYS: &[&str] = &[
    "id",
    "kind",
    "title",
    "skills",
    "track",
    "source",
    "minutes",
    "difficulty",
    "lesson",
    "segment",
];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Common {
    id: Option<String>,
    kind: Kind,
    title: Option<String>,
    skills: Vec<String>,
    track: Option<String>,
    source: Option<String>,
    minutes: Option<u32>,
    difficulty: Option<u8>,
    lesson: Option<String>,
    segment: Option<usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoFields {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CardFields {
    follow_ups: Option<i64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MentalMathsFields {
    params: BTreeMap<String, RawParam>,
    #[serde(default)]
    derived: BTreeMap<String, String>,
    answer: String,
    require: Option<String>,
    #[serde(default)]
    tolerance: f64,
    relative_tolerance: Option<f64>,
    factor: Option<f64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProbabilityFields {
    answer: String,
    answer_tolerance: Option<f64>,
    simulation: SimulationFields,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SimulationFields {
    trials: u32,
    tolerance: f64,
}

/// The fewest and most trials a simulation may ask for.
const TRIALS: std::ops::RangeInclusive<u32> = 1_000..=2_000_000;

impl Item {
    /// Reads an item from its file. `default_id` is what it's called if its front matter
    /// doesn't say, from its file or directory name, and `read` gives the text of a file the
    /// item refers to, relative to the item's directory, or says why it can't.
    pub fn parse(
        path: &str,
        default_id: &str,
        source: &str,
        manifest: &Manifest,
        read: impl Fn(&str) -> Result<String, String>,
    ) -> Result<Self, String> {
        Self::parse_in(
            path,
            default_id,
            source,
            manifest,
            |file| read(file).map(String::into_bytes),
            |dir| Err(format!("{dir}/ isn't in the item's directory")),
        )
    }

    /// Reads an item from its file, as [`Item::parse`] does, with `read_bytes` giving the raw
    /// bytes of a file the item refers to (including binary images such as `.png`) and `list`
    /// giving the files directly in a directory of the item's, by name, for an item with a
    /// directory of files, such as a codebase's project.
    pub fn parse_in(
        path: &str,
        default_id: &str,
        source: &str,
        manifest: &Manifest,
        read_bytes: impl Fn(&str) -> Result<Vec<u8>, String>,
        list: impl Fn(&str) -> Result<Vec<String>, String>,
    ) -> Result<Self, String> {
        let read = |file: &str| {
            read_bytes(file).and_then(|bytes| {
                String::from_utf8(bytes).map_err(|_| format!("{file:?} isn't UTF-8"))
            })
        };
        let (front, body) = split_front_matter(source)?;
        let mut table: toml::Table = toml::from_str(front).map_err(|err| err.to_string())?;
        let mut common = toml::Table::new();
        for key in COMMON_KEYS {
            if let Some(value) = table.remove(*key) {
                common.insert((*key).to_owned(), value);
            }
        }
        let common: Common = common.try_into().map_err(|err| err.to_string())?;
        let id = common.id.unwrap_or_else(|| default_id.to_owned());
        if !is_slug(&id) {
            return Err(format!(
                "the id {id:?} should be lowercase letters and digits, in words joined by hyphens"
            ));
        }
        if common.skills.is_empty() {
            return Err("an item needs at least one skill".to_owned());
        }
        if let Some(unknown) = common.skills.iter().find(|s| !manifest.has_skill(s)) {
            return Err(format!(
                "the skill {unknown:?} isn't in the pack's skills, in pack.toml"
            ));
        }
        let track = match &common.track {
            Some(name) => manifest.track(name)?,
            None => manifest.default_track(common.kind),
        };
        if matches!(track, TrackId::Pack(_)) && !common.kind.can_be_in_pack_track() {
            return Err(
                "a design prompt is worked through as a design session, in the system-design track, so it can't be in a pack's own"
                    .to_owned(),
            );
        }
        // A lab is listed, and worked through, from a track's practice screen, which the Coding
        // and System design tracks don't have.
        if common.kind == Kind::Lab && matches!(track, TrackId::Coding | TrackId::SystemDesign) {
            return Err(format!(
                "a lab is listed in its track's practice screen, so it can't be in the {track} track"
            ));
        }
        if common.minutes == Some(0) {
            return Err("minutes should be at least 1".to_owned());
        }
        if let Some(difficulty) = common.difficulty
            && !DIFFICULTY.contains(&difficulty)
        {
            return Err(format!(
                "difficulty should be from {} to {}, not {difficulty}",
                DIFFICULTY.start(),
                DIFFICULTY.end()
            ));
        }
        // A lab's `lesson` is one to do before it's offered, rather than one that teaches it.
        let (lab_lesson, common_lesson) = match (common.kind, common.lesson) {
            (Kind::Lab, lesson) if common.segment.is_none() => (lesson, None),
            (Kind::Lab, _) => {
                return Err(
                    "a lab can name a `lesson` to do first, but not a `segment` of it".to_owned(),
                );
            }
            (_, lesson) => (None, lesson),
        };
        let lesson = match (common_lesson, common.segment) {
            (None, None) => None,
            (Some(_), _) | (None, Some(_)) if !common.kind.is_short() => {
                return Err(
                    "only short items (cards, mental maths, probability and code to read) can name a `lesson` or `segment`"
                        .to_owned(),
                );
            }
            (None, Some(_)) => {
                return Err(
                    "`segment` names a segment of a lesson, so give `lesson` too".to_owned(),
                );
            }
            (Some(lesson_id), segment) => {
                if !is_slug(&lesson_id) {
                    return Err(format!(
                        "lesson {lesson_id:?} should be lowercase letters and digits, in words joined by hyphens"
                    ));
                }
                let segment = match segment {
                    None => None,
                    Some(0) => {
                        return Err(
                            "`segment` counts from 1, so it should be at least 1".to_owned()
                        );
                    }
                    Some(n) => Some(n - 1),
                };
                Some(LessonRef {
                    id: lesson_id,
                    segment,
                })
            }
        };

        let kind_fields = toml::Value::Table(table);
        let (prompt, content) = if common.kind == Kind::Lab {
            let (prompt, sections) = split_lesson_sections(body)?;
            let fields: LabFields = kind_fields.try_into().map_err(|err| err.to_string())?;
            let lab = Lab::new(fields, lab_lesson, &prompt, sections)?;
            (prompt, Content::Lab(lab))
        } else if common.kind == Kind::Lesson {
            let (prompt, sections) = split_lesson_sections(body)?;
            let fields: LessonFields = kind_fields.try_into().map_err(|err| err.to_string())?;
            let lesson = Lesson::new(fields, &prompt, sections, &read_bytes)?;
            if let Some(topic) = &lesson.topic {
                if !common.skills.contains(&topic.skill) {
                    return Err(format!(
                        "topic {:?} is a topic of {:?}, which isn't one of the lesson's skills",
                        topic.to_string(),
                        topic.skill
                    ));
                }
                let skill = manifest.skill(&topic.skill).expect("checked above");
                if skill.topic(&topic.topic).is_none() {
                    return Err(format!(
                        "topic {:?} isn't one of the topics of {:?}, in pack.toml",
                        topic.to_string(),
                        topic.skill
                    ));
                }
            }
            (prompt, Content::Lesson(lesson))
        } else {
            let (prompt, mut sections) = split_sections(body, common.kind)?;
            let mut section = |name: &str| sections.remove(name);
            let content = match common.kind {
                Kind::Card => {
                    let fields: CardFields =
                        kind_fields.try_into().map_err(|err| err.to_string())?;
                    Content::Card {
                        answer: section("Answer").expect("required"),
                        explanation: section("Explanation"),
                        follow_ups: fields
                            .follow_ups
                            .map_or(Ok(FollowUps::DEFAULT), FollowUps::new)?,
                    }
                }
                Kind::MentalMaths => {
                    let fields: MentalMathsFields =
                        kind_fields.try_into().map_err(|err| err.to_string())?;
                    Content::MentalMaths(MentalMaths::new(fields, &prompt, section("Method"))?)
                }
                Kind::Probability => {
                    let fields: ProbabilityFields =
                        kind_fields.try_into().map_err(|err| err.to_string())?;
                    let simulation = section("Simulation").expect("required");
                    Content::Probability(Probability::new(
                        fields,
                        section("Solution").expect("required"),
                        &simulation,
                    )?)
                }
                Kind::Coding => {
                    let fields: CodingFields =
                        kind_fields.try_into().map_err(|err| err.to_string())?;
                    let approach = section("Approach").expect("required");
                    let hints = section("Hints");
                    let notes = section("Notes");
                    let later = (2..=MAX_PARTS)
                        .map(|n| PartText {
                            prompt: section(&format!("Part {n}")),
                            hints: section(&format!("Part {n} hints")),
                        })
                        .collect();
                    Content::Coding(Coding::new(
                        fields, &prompt, approach, hints, notes, later, &read,
                    )?)
                }
                Kind::Codebase => {
                    let fields: CodebaseFields =
                        kind_fields.try_into().map_err(|err| err.to_string())?;
                    let sections = project::Sections {
                        explanation: section("Explanation"),
                        hints: section("Hints"),
                        notes: section("Notes"),
                        defects: section("Defects"),
                        later: (2..=MAX_PARTS)
                            .map(|n| PartText {
                                prompt: section(&format!("Part {n}")),
                                hints: section(&format!("Part {n} hints")),
                            })
                            .collect(),
                    };
                    match project::parse(fields, &prompt, sections, &read, &list)? {
                        project::Codebase::Coding(coding) => Content::Coding(coding),
                        project::Codebase::Review(review) => Content::Review(review),
                    }
                }
                Kind::Reading => {
                    let fields: ReadingFields =
                        kind_fields.try_into().map_err(|err| err.to_string())?;
                    Content::Reading(Reading::new(
                        fields,
                        &prompt,
                        section("Explanation").expect("required"),
                    )?)
                }
                Kind::Design => {
                    kind_fields
                        .try_into::<NoFields>()
                        .map_err(|err| err.to_string())?;
                    let rubric = crate::code::list(&section("Rubric").expect("required"));
                    if rubric.is_empty() {
                        return Err(
                            "the rubric should be a list, with a point on each line starting with `- `"
                                .to_owned(),
                        );
                    }
                    Content::Design {
                        rubric,
                        notes: section("Notes"),
                        brief: section("Brief"),
                    }
                }
                Kind::Lesson | Kind::Lab => unreachable!("handled above"),
            };
            (prompt, content)
        };
        Ok(Self {
            id,
            path: path.to_owned(),
            kind: common.kind,
            title: common.title,
            skills: common.skills,
            track,
            source: common.source,
            minutes: common.minutes.unwrap_or(common.kind.default_minutes()),
            difficulty: common.difficulty,
            lesson,
            prompt,
            content,
        })
    }

    /// What the item is called in lists: its title, or the start of its prompt.
    pub fn label(&self) -> String {
        if let Some(title) = &self.title {
            return title.clone();
        }
        let first = self.prompt.lines().next().unwrap_or_default();
        let words: Vec<&str> = first.split_whitespace().collect();
        if words.len() <= 8 {
            words.join(" ")
        } else {
            format!("{}…", words[..8].join(" "))
        }
    }
}

/// An item's file with one of its `## ` sections' text replaced, added at the end if it isn't
/// there, or with `None`, removed, leaving the rest of the file as it was.
pub fn replace_section(source: &str, heading: &str, text: Option<&str>) -> String {
    let mut out = String::new();
    let mut in_code = false;
    let mut inside = false;
    let mut found = false;
    let new_section = |out: &mut String| {
        if let Some(text) = text {
            out.push_str(&format!("## {heading}\n\n{}\n\n", text.trim()));
        }
    };
    for line in source.split_inclusive('\n') {
        if line.trim_start().starts_with("```") {
            in_code = !in_code;
        }
        if !in_code && let Some(name) = line.trim_end().strip_prefix("## ") {
            if inside {
                inside = false;
            }
            if name.trim() == heading {
                inside = true;
                found = true;
                new_section(&mut out);
                continue;
            }
        }
        if !inside {
            out.push_str(line);
        }
    }
    if !found && text.is_some() {
        if !out.ends_with('\n') {
            out.push('\n');
        }
        if !out.ends_with("\n\n") {
            out.push('\n');
        }
        new_section(&mut out);
    }
    format!("{}\n", out.trim_end())
}

pub fn split_front_matter(source: &str) -> Result<(&str, &str), String> {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let rest = source
        .strip_prefix("+++\n")
        .or_else(|| source.strip_prefix("+++\r\n"))
        .ok_or("an item should start with TOML front matter, between lines of `+++`")?;
    let end = rest
        .match_indices("+++")
        .find(|(at, _)| {
            (*at == 0 || rest[..*at].ends_with('\n'))
                && rest[at + 3..]
                    .chars()
                    .next()
                    .is_none_or(|c| c == '\n' || c == '\r')
        })
        .map(|(at, _)| at)
        .ok_or("the front matter has no closing `+++` line")?;
    let body = rest[end + 3..].trim_start_matches(['\r', '\n']);
    Ok((&rest[..end], body))
}

/// The prompt, and each section by its heading, checking the kind's required sections are
/// there and no others.
fn split_sections(body: &str, kind: Kind) -> Result<(String, BTreeMap<String, String>), String> {
    let mut prompt = String::new();
    let mut sections: BTreeMap<String, String> = BTreeMap::new();
    let mut current: Option<String> = None;
    let mut in_code = false;
    for line in body.lines() {
        if line.trim_start().starts_with("```") {
            in_code = !in_code;
        }
        if !in_code && let Some(heading) = line.strip_prefix("## ") {
            let heading = heading.trim().to_owned();
            if !kind.sections().iter().any(|(name, _)| *name == heading) {
                let allowed: Vec<_> = kind.sections().iter().map(|(name, _)| *name).collect();
                return Err(format!(
                    "a {} item can't have a section called {heading:?}; it can have {}",
                    kind_name(kind),
                    allowed.join(", ")
                ));
            }
            if sections.contains_key(&heading) {
                return Err(format!("the {heading:?} section is there twice"));
            }
            sections.insert(heading.clone(), String::new());
            current = Some(heading);
            continue;
        }
        let text = match &current {
            Some(heading) => sections.get_mut(heading).expect("inserted above"),
            None => &mut prompt,
        };
        text.push_str(line);
        text.push('\n');
    }
    let prompt = prompt.trim().to_owned();
    if prompt.is_empty() {
        return Err("the prompt, before the first `## ` heading, is empty".to_owned());
    }
    for text in sections.values_mut() {
        *text = text.trim().to_owned();
    }
    sections.retain(|_, text| !text.is_empty());
    for (name, required) in kind.sections() {
        if *required && !sections.contains_key(*name) {
            return Err(format!(
                "a {} item needs a `## {name}` section",
                kind_name(kind)
            ));
        }
    }
    Ok((prompt, sections))
}

/// The prompt, and each `## ` section of a lesson in order, allowing any segment titles without
/// duplicates.
fn split_lesson_sections(body: &str) -> Result<(String, Vec<(String, String)>), String> {
    let mut prompt = String::new();
    let mut sections: Vec<(String, String)> = Vec::new();
    let mut in_fence: Option<char> = None;
    for line in body.lines() {
        let trimmed = line.trim_start();
        if let Some(ch) = in_fence {
            if (ch == '`' && trimmed.starts_with("```"))
                || (ch == '~' && trimmed.starts_with("~~~"))
            {
                in_fence = None;
            }
        } else if trimmed.starts_with("```") {
            in_fence = Some('`');
        } else if trimmed.starts_with("~~~") {
            in_fence = Some('~');
        }
        if in_fence.is_none()
            && let Some(heading) = line.strip_prefix("## ")
        {
            let heading = heading.trim().to_owned();
            if heading.is_empty() {
                return Err("a section has an empty `## ` heading".to_owned());
            }
            if sections.iter().any(|(name, _)| name == &heading) {
                return Err(format!("the {heading:?} section is there twice"));
            }
            sections.push((heading, String::new()));
            continue;
        }
        let text = match sections.last_mut() {
            Some((_, text)) => text,
            None => &mut prompt,
        };
        text.push_str(line);
        text.push('\n');
    }
    let prompt = prompt.trim().to_owned();
    if prompt.is_empty() {
        return Err("the prompt, before the first `## ` heading, is empty".to_owned());
    }
    for (_, text) in &mut sections {
        *text = text.trim().to_owned();
    }
    Ok((prompt, sections))
}

pub(crate) fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::Card => "card",
        Kind::MentalMaths => "mental maths",
        Kind::Probability => "probability",
        Kind::Coding => "coding",
        Kind::Reading => "reading",
        Kind::Design => "design",
        Kind::Codebase => "codebase",
        Kind::Lesson => "lesson",
        Kind::Lab => "lab",
    }
}

impl MentalMaths {
    fn new(
        fields: MentalMathsFields,
        prompt: &str,
        method: Option<String>,
    ) -> Result<Self, String> {
        if fields.params.is_empty() {
            return Err("a mental maths item needs at least one param".to_owned());
        }
        let mut params = BTreeMap::new();
        for (name, raw) in fields.params {
            if !is_identifier(&name) {
                return Err(format!(
                    "{name:?} can't be a param's name: use letters, digits and underscores, starting with a letter"
                ));
            }
            let param = match raw {
                RawParam {
                    min: Some(min),
                    max: Some(max),
                    choices: None,
                } => {
                    if min > max {
                        return Err(format!("the param {name} has min {min} above max {max}"));
                    }
                    Param::Range { min, max }
                }
                RawParam {
                    min: None,
                    max: None,
                    choices: Some(choices),
                } => {
                    if choices.is_empty() {
                        return Err(format!("the param {name} has no choices"));
                    }
                    Param::Choices { choices }
                }
                _ => {
                    return Err(format!(
                        "the param {name} should have either a min and a max, or choices"
                    ));
                }
            };
            params.insert(name, param);
        }
        for name in fields.derived.keys() {
            if !is_identifier(name) || params.contains_key(name) || name == "answer" {
                return Err(format!(
                    "{name:?} can't be a derived value's name: use letters, digits and underscores, and not the name of a param or `answer`"
                ));
            }
        }
        if !(fields.tolerance >= 0.0 && fields.tolerance.is_finite()) {
            return Err("tolerance should be 0 or more".to_owned());
        }
        if let Some(relative) = fields.relative_tolerance
            && !(0.0..1.0).contains(&relative)
        {
            return Err(
                "relative_tolerance should be at least 0 and below 1, such as 0.05 for 5%"
                    .to_owned(),
            );
        }
        if let Some(factor) = fields.factor
            && !(factor > 1.0 && factor.is_finite())
        {
            return Err(
                "factor should be above 1, such as 2 for half to twice the answer".to_owned(),
            );
        }
        let known = |name: &str| params.contains_key(name) || fields.derived.contains_key(name);
        for name in placeholders(prompt) {
            if !known(&name) {
                return Err(format!(
                    "the prompt shows {{{name}}}, which isn't a param or a derived value"
                ));
            }
        }
        if let Some(method) = &method {
            for name in placeholders(method) {
                if !known(&name) && name != "answer" {
                    return Err(format!(
                        "the method shows {{{name}}}, which isn't a param, a derived value or the answer"
                    ));
                }
            }
        }
        Ok(Self {
            params,
            derived: fields.derived,
            answer: fields.answer,
            require: fields.require,
            tolerance: Tolerance {
                absolute: fields.tolerance.max(Tolerance::EXACT.absolute),
                relative: fields.relative_tolerance.unwrap_or(0.0),
                factor: fields.factor,
            },
            method,
        })
    }
}

impl Probability {
    fn new(fields: ProbabilityFields, solution: String, simulation: &str) -> Result<Self, String> {
        let answer = number::parse(&fields.answer).ok_or_else(|| {
            format!(
                "the answer {:?} should be a number, such as 0.25, 1/4 or 25%",
                fields.answer
            )
        })?;
        let relative = fields.answer_tolerance.unwrap_or(DEFAULT_ANSWER_TOLERANCE);
        if !(0.0..1.0).contains(&relative) {
            return Err("answer_tolerance should be at least 0 and below 1".to_owned());
        }
        if !TRIALS.contains(&fields.simulation.trials) {
            return Err(format!(
                "the simulation should run between {} and {} trials",
                TRIALS.start(),
                TRIALS.end()
            ));
        }
        if !(fields.simulation.tolerance > 0.0 && fields.simulation.tolerance.is_finite()) {
            return Err("the simulation's tolerance should be above 0".to_owned());
        }
        let script = code_block(simulation, "rhai").ok_or(
            "the Simulation section should hold the script for one trial, in a ```rhai code block",
        )?;
        Ok(Self {
            answer_text: fields.answer,
            answer,
            tolerance: Tolerance {
                relative,
                ..Tolerance::EXACT
            },
            solution,
            simulation: Simulation {
                script,
                trials: fields.simulation.trials,
                tolerance: fields.simulation.tolerance,
            },
        })
    }
}

fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The names in `{name}` placeholders.
pub(crate) fn placeholders(text: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find('{') {
        let after = &rest[start + 1..];
        match after.find('}') {
            Some(end) if is_identifier(&after[..end]) => {
                names.push(after[..end].to_owned());
                rest = &after[end + 1..];
            }
            _ => rest = after,
        }
    }
    names
}

/// The only code block in `text` in this language.
fn code_block(text: &str, language: &str) -> Option<String> {
    let mut blocks = Vec::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        let fence = line.trim_start().strip_prefix("```");
        match (&mut current, fence) {
            (None, Some(info)) => {
                current = (info.trim() == language).then(String::new);
                if current.is_none() {
                    // Another language's block: skip to its end.
                    current = Some(String::from("\0"));
                }
            }
            (Some(code), Some(_)) => {
                if !code.starts_with('\0') {
                    blocks.push(std::mem::take(code));
                }
                current = None;
            }
            (Some(code), None) => {
                code.push_str(line);
                code.push('\n');
            }
            (None, None) => {}
        }
    }
    if current.is_some() || blocks.len() != 1 {
        return None;
    }
    blocks.pop()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_a_section_and_keeps_the_rest() {
        let card = "+++\nkind = \"card\"\nskills = [\"a\"]\n+++\nQ?\n\n## Answer\n\nOld.\n\n```\n## Not a heading\n```\n\n## Explanation\n\nWhy.\n";
        let fixed = replace_section(card, "Answer", Some("New."));
        assert_eq!(
            fixed,
            "+++\nkind = \"card\"\nskills = [\"a\"]\n+++\nQ?\n\n## Answer\n\nNew.\n\n## Explanation\n\nWhy.\n"
        );
        let without = replace_section(card, "Explanation", None);
        assert!(without.ends_with("## Not a heading\n```\n"), "{without}");
        let added = replace_section(&without, "Explanation", Some("Because."));
        assert!(
            added.ends_with("```\n\n## Explanation\n\nBecause.\n"),
            "{added}"
        );
    }

    fn manifest() -> Manifest {
        Manifest::parse(
            r#"
            id = "example"
            name = "Example"
            [[skills]]
            id = "arithmetic"
            name = "Arithmetic"
            topics = [{ id = "heaps", name = "Binary heaps" }]
            [[skills]]
            id = "dice"
            name = "Dice"
            [[tracks]]
            id = "estimation"
            name = "Estimation"
            "#,
        )
        .unwrap()
    }

    fn parse(source: &str) -> Result<Item, String> {
        Item::parse("items/x.md", "x", source, &manifest(), |file| {
            match file {
            "reference.py" | "starter.py" | "brute.py" | "inputs.py" => Ok(String::new()),
            "tests.toml" => Ok(
                "[[example]]\ninput = \"1\"\noutput = \"1\"\n[[test]]\ninput = \"2\"\noutput = \"2\"\n"
                    .to_owned(),
            ),
            _ => Err(format!("{file:?} isn't in the item's directory")),
        }
        })
    }

    #[test]
    fn reads_a_card() {
        let item = parse(
            "+++\nkind = \"card\"\nskills = [\"arithmetic\"]\nsource = \"Written for the example\"\n+++\n\nWhat's 7 × 8?\n\n## Answer\n\n56\n\n## Explanation\n\n7 × 8 = 7 × 7 + 7.\n",
        )
        .unwrap();
        assert_eq!(item.id, "x");
        assert_eq!(item.track, TrackId::Review);
        assert_eq!(item.prompt, "What's 7 × 8?");
        assert_eq!(item.minutes, 1);
        assert_eq!(item.source.as_deref(), Some("Written for the example"));
        assert_eq!(
            item.content,
            Content::Card {
                answer: "56".to_owned(),
                explanation: Some("7 × 8 = 7 × 7 + 7.".to_owned()),
                follow_ups: FollowUps::DEFAULT,
            }
        );
        assert_eq!(item.label(), "What's 7 × 8?");
    }

    #[test]
    fn reads_how_many_follow_up_questions_a_card_offers() {
        let follow_ups = |line: &str| {
            let item = parse(&format!(
                "+++\nkind = \"card\"\nskills = [\"arithmetic\"]\n{line}\n+++\nQ\n\n## Answer\n\nA\n"
            ))
            .unwrap();
            let Content::Card { follow_ups, .. } = item.content else {
                panic!("not a card");
            };
            follow_ups
        };
        assert_eq!(follow_ups(""), FollowUps::DEFAULT);
        assert_eq!(FollowUps::DEFAULT.get(), 2);
        assert_eq!(follow_ups("follow_ups = 3").get(), 3);
        let none = follow_ups("follow_ups = 0");
        assert!(!none.offered());
        assert!(follow_ups("follow_ups = 1").offered());
        // Kept as a number, and never read back out of range.
        assert_eq!(serde_json::to_string(&none).unwrap(), "0");
        assert!(serde_json::from_str::<FollowUps>("4").is_err());
    }

    #[test]
    fn puts_items_in_the_packs_own_track_unless_they_say_otherwise() {
        let manifest = Manifest::parse(
            "id = \"example\"\nname = \"Example\"\ntrack = \"drill\"\n[[skills]]\nid = \"dice\"\nname = \"Dice\"\n[[tracks]]\nid = \"drill\"\nname = \"Drill\"\ncontinue = false\n",
        )
        .unwrap();
        let parse = |source: &str| {
            Item::parse("items/x.md", "x", source, &manifest, |file| {
                match file {
                "reference.py" | "starter.py" | "brute.py" | "inputs.py" => Ok(String::new()),
                "tests.toml" => Ok(
                    "[[example]]\ninput = \"1\"\noutput = \"1\"\n[[test]]\ninput = \"2\"\noutput = \"2\"\n"
                        .to_owned(),
                ),
                _ => Err(format!("{file:?} isn't in the item's directory")),
            }
            })
        };
        let drill = TrackId::Pack("drill".parse().unwrap());
        let card =
            parse("+++\nkind = \"card\"\nskills = [\"dice\"]\n+++\nQ\n## Answer\nA\n").unwrap();
        assert_eq!(card.track, drill);
        let reading = parse(&reading_in("python", "print(1)", "prints = \"1\"\n")).unwrap();
        assert_eq!(reading.track, drill);
        let coding = parse(&coding("python", "\"reference.py\"", "\"starter.py\"")).unwrap();
        assert_eq!(coding.track, drill);
        // An item's own track wins.
        let own = parse(
            "+++\nkind = \"card\"\nskills = [\"dice\"]\ntrack = \"review\"\n+++\nQ\n## Answer\nA\n",
        )
        .unwrap();
        assert_eq!(own.track, TrackId::Review);
        // Design prompts stay in the System design track, and can't be in a pack's own.
        let design = "+++\nkind = \"design\"\nskills = [\"dice\"]\n+++\nDesign a dice roller.\n## Rubric\n- Fair\n";
        assert_eq!(parse(design).unwrap().track, TrackId::SystemDesign);
        let err =
            parse(&design.replace("kind = \"design\"", "kind = \"design\"\ntrack = \"drill\""))
                .unwrap_err();
        assert!(err.contains("design session"), "{err}");
    }

    #[test]
    fn reads_a_mental_maths_template() {
        let item = parse(
            "+++\nkind = \"mental-maths\"\nid = \"times\"\nskills = [\"arithmetic\"]\ntrack = \"estimation\"\nanswer = \"a * b\"\nrequire = \"a != b\"\n[params]\na = { min = 2, max = 9 }\nb = { choices = [11, 12] }\n[derived]\nboth = \"a + b\"\n+++\nWhat's {a} × {b}?\n\n## Method\n\n{a} × {b} = {answer}\n",
        )
        .unwrap();
        assert_eq!(item.id, "times");
        assert_eq!(item.track, TrackId::Pack("estimation".parse().unwrap()));
        let Content::MentalMaths(maths) = item.content else {
            panic!("not mental maths");
        };
        assert_eq!(maths.params["a"], Param::Range { min: 2, max: 9 });
        assert_eq!(
            maths.params["b"],
            Param::Choices {
                choices: vec![11, 12]
            }
        );
        assert_eq!(maths.method.as_deref(), Some("{a} × {b} = {answer}"));
    }

    #[test]
    fn reads_how_close_an_estimate_must_be() {
        let template = |bounds: &str| {
            let item = parse(&format!(
                "+++\nkind = \"mental-maths\"\nskills = [\"arithmetic\"]\nanswer = \"a * 3.7\"\n{bounds}\n[params]\na = {{ min = 2, max = 9 }}\n+++\nRoughly what's {{a}} × 3.7?\n"
            ))
            .unwrap();
            let Content::MentalMaths(maths) = item.content else {
                panic!("not mental maths");
            };
            maths.tolerance
        };
        assert_eq!(template(""), Tolerance::EXACT);
        let relative = template("relative_tolerance = 0.05");
        assert_eq!((relative.relative, relative.factor), (0.05, None));
        assert!(relative.allows(100.0, 104.0) && !relative.allows(100.0, 106.0));
        let factor = template("factor = 2");
        assert_eq!((factor.relative, factor.factor), (0.0, Some(2.0)));
        assert!(factor.allows(100.0, 51.0) && factor.allows(100.0, 199.0));
        assert!(!factor.allows(100.0, 201.0) && !factor.allows(100.0, -100.0));
    }

    #[test]
    fn reads_a_probability_item() {
        let item = parse(
            "+++\nkind = \"probability\"\nskills = [\"dice\"]\nanswer = \"1/6\"\n[simulation]\ntrials = 50000\ntolerance = 0.01\n+++\nTwo dice: what's the chance they sum to 7?\n\n## Solution\n\n6 of the 36 outcomes.\n\n## Simulation\n\n```rhai\nrand_int(1, 6) + rand_int(1, 6) == 7\n```\n",
        )
        .unwrap();
        let Content::Probability(probability) = item.content else {
            panic!("not probability");
        };
        assert_eq!(probability.answer, 1.0 / 6.0);
        assert_eq!(probability.tolerance.relative, DEFAULT_ANSWER_TOLERANCE);
        assert_eq!(
            probability.simulation.script,
            "rand_int(1, 6) + rand_int(1, 6) == 7\n"
        );
        assert_eq!(item.minutes, 3);
    }

    #[test]
    fn reads_coding_and_design_items() {
        let coding = parse(
            "+++\nkind = \"coding\"\nskills = [\"arithmetic\"]\nlanguages = [\"python\"]\nreference = [\"reference.py\"]\nstarter = [\"starter.py\"]\nbrute_force = \"brute.py\"\ntests = \"tests.toml\"\ninputs = \"inputs.py\"\n+++\nSum a list.\n\n## Approach\n\nAdd as you go.\n\n## Hints\n\n- Start at zero.\n- Add each number.\n",
        )
        .unwrap();
        assert_eq!(coding.track, TrackId::Coding);
        assert_eq!(coding.minutes, 20);
        assert_eq!(coding.difficulty, None);
        let hard = parse(
            "+++\nkind = \"card\"\nskills = [\"arithmetic\"]\ndifficulty = 4\n+++\nQ\n\n## Answer\n\nA\n",
        )
        .unwrap();
        assert_eq!(hard.difficulty, Some(4));
        let Content::Coding(problem) = &coding.content else {
            panic!("not coding");
        };
        assert_eq!(
            problem.parts[0].hints,
            ["Start at zero.", "Add each number."]
        );
        assert_eq!(problem.random_inputs, 100);
        let design = parse(
            "+++\nkind = \"design\"\nskills = [\"arithmetic\"]\nminutes = 25\n+++\nDesign a calculator service.\n\n## Rubric\n\n- Handles precision\n- Scales reads\n",
        )
        .unwrap();
        assert_eq!(design.minutes, 25);
        assert_eq!(
            design.content,
            Content::Design {
                rubric: vec!["Handles precision".to_owned(), "Scales reads".to_owned()],
                notes: None,
                brief: None,
            }
        );
        let briefed = parse(
            "+++\nkind = \"design\"\nskills = [\"arithmetic\"]\n+++\nDesign a calculator service.\n\n## Rubric\n\n- Scales reads\n\n## Brief\n\n- Used by schools\n- 50 sums a second\n",
        )
        .unwrap();
        let Content::Design { brief, .. } = &briefed.content else {
            panic!("not design");
        };
        assert_eq!(
            brief.as_deref(),
            Some("- Used by schools\n- 50 sums a second")
        );
    }

    /// A problem in parts: `parts` is its `[[parts]]`, and `body` what follows its prompt.
    fn in_parts(front: &str, parts: &str, body: &str) -> Result<Item, String> {
        let source = format!(
            "+++\nkind = \"coding\"\nskills = [\"dice\"]\nlanguages = [\"python\"]\nreference = [\"reference.py\"]\nstarter = [\"starter.py\"]\nbrute_force = \"brute.py\"\ntests = \"tests.toml\"\ninputs = \"inputs.py\"\n{front}{parts}+++\nKeep a tally.\n\n{body}## Approach\n\nA map of counts.\n"
        );
        Item::parse("items/x/item.md", "x", &source, &manifest(), |file| {
            match file {
            "reference.py" | "starter.py" | "brute.py" | "inputs.py" | "two/reference.py"
            | "two/brute.py" | "two/inputs.py" | "three/reference.py" | "two/reference.rs" => {
                Ok(format!("# {file}"))
            }
            "tests.toml" => Ok("[[example]]\ninput = \"a\"\noutput = \"1\"\n[[test]]\ninput = \"b\"\noutput = \"1\"\n".to_owned()),
            "two/tests.toml" | "three/tests.toml" => Ok("[[example]]\ninput = \"a a\"\noutput = \"2\"\n[[test]]\ninput = \"\"\noutput = \"0\"\n".to_owned()),
            "api.toml" => Ok("[[example]]\ncalls = [{ call = \"add\", args = [\"a\"] }, { call = \"count\", args = [\"a\"], returns = 1 }]\n[[test]]\nnew = [2]\ncalls = [{ call = \"count\", args = [\"b\"], returns = 0 }]\n".to_owned()),
            _ => Err(format!("{file:?} isn't in the item's directory")),
        }
        })
    }

    const TWO: &str = "[[parts]]\nreference = [\"two/reference.py\"]\ntests = \"two/tests.toml\"\nbrute_force = \"two/brute.py\"\ninputs = \"two/inputs.py\"\n";
    const THREE: &str = "[[parts]]\nreference = [\"three/reference.py\"]\ntests = \"three/tests.toml\"\nreplaces = [1]\n";

    #[test]
    fn reads_a_problem_in_parts() {
        let item = in_parts(
            "",
            &format!("{TWO}{THREE}"),
            "## Part 2\n\nNow count pairs.\n\n## Part 2 hints\n\n- Pairs are two.\n\n## Part 3\n\nNow forget the first.\n\n## Hints\n\n- Count.\n\n",
        )
        .unwrap();
        assert_eq!(item.prompt, "Keep a tally.");
        let Content::Coding(coding) = &item.content else {
            panic!("not coding");
        };
        assert!(coding.in_parts());
        assert_eq!(coding.last(), 2);
        let prompts: Vec<&str> = coding.parts.iter().map(|p| p.prompt.as_str()).collect();
        assert_eq!(
            prompts,
            ["Keep a tally.", "Now count pairs.", "Now forget the first."]
        );
        assert_eq!(coding.parts[0].hints, ["Count."]);
        assert_eq!(coding.parts[1].hints, ["Pairs are two."]);
        assert!(coding.parts[2].hints.is_empty());
        assert_eq!(
            coding.parts[1].work.programs()[0].text,
            "# two/reference.py"
        );
        assert_eq!(
            coding.parts[1].brute_force.as_ref().unwrap().inputs.file,
            "two/inputs.py"
        );
        assert!(coding.parts[2].brute_force.is_none());
        assert_eq!(coding.parts[2].replaces, [0]);
        assert_eq!(
            coding
                .reference_in(1, crate::Language::Python)
                .unwrap()
                .file,
            "two/reference.py"
        );
        // Each part's tests apply from then on, unless a later part replaces them.
        assert_eq!(coding.applying(0), [0]);
        assert_eq!(coding.applying(1), [0, 1]);
        assert_eq!(coding.applying(2), [1, 2]);
        assert_eq!(
            coding.statement(1),
            "## Part 1\n\nKeep a tally.\n\n## Part 2\n\nNow count pairs."
        );
        // A problem in one part is just its prompt.
        let one = in_parts("", "", "").unwrap();
        let Content::Coding(one) = &one.content else {
            panic!("not coding");
        };
        assert_eq!(one.statement(0), "Keep a tally.");
        assert_eq!(one.applying(0), [0]);
    }

    #[test]
    fn reads_a_problem_in_api_mode() {
        let item = in_parts("[api]\nclass = \"Tally\"\n", "", "");
        // The ordinary tests.toml has inputs and outputs, which API mode doesn't.
        assert!(item.unwrap_err().contains("unknown field `input`"));
        let item = Item::parse(
            "items/x/item.md",
            "x",
            "+++\nkind = \"coding\"\nskills = [\"dice\"]\nlanguages = [\"python\"]\nreference = [\"reference.py\"]\nstarter = [\"starter.py\"]\nbrute_force = \"brute.py\"\ntests = \"api.toml\"\ninputs = \"inputs.py\"\n\n[api]\nclass = \"Tally\"\n+++\nKeep a tally.\n\n## Approach\n\nA map.\n",
            &manifest(),
            |file| match file {
                "api.toml" => Ok("[[example]]\ncalls = [{ call = \"add\", args = [\"a\"] }, { call = \"count\", args = [\"a\"], returns = 1 }]\n[[test]]\nnew = [2]\ncalls = [{ call = \"count\", args = [\"b\"], returns = 0 }]\n".to_owned()),
                _ => Ok(String::new()),
            },
        )
        .unwrap();
        let Content::Coding(coding) = &item.content else {
            panic!("not coding");
        };
        assert_eq!(
            coding.api,
            Some(crate::Api {
                class: Some("Tally".to_owned())
            })
        );
        let example = &coding.parts[0].examples[0];
        assert_eq!(
            example.input,
            "[\"Tally\"]\n[\"add\",\"a\"]\n[\"count\",\"a\"]\n"
        );
        assert_eq!(example.output, "null\n1\n");
        assert_eq!(
            coding.parts[0].tests[0].input,
            "[\"Tally\",2]\n[\"count\",\"b\"]\n"
        );
        // Results are compared as values.
        assert!(coding.same_output("null\n1\n", "null\n1.0\n"));
        assert!(!coding.same_output("null\n1\n", "1\n"));
    }

    #[test]
    fn says_what_is_wrong_with_a_problem_in_parts() {
        let part_two = "## Part 2\n\nNow pairs.\n\n";
        let cases: &[(&str, &str, &str, &str)] = &[
            ("", TWO, "", "needs a `## Part 2` section"),
            ("", "", part_two, "no part 2"),
            (
                "",
                TWO,
                "## Part 2\n\nPairs.\n\n## Part 3 hints\n\n- No.\n\n",
                "`## Part 3 hints` section, but no part 3",
            ),
            (
                "",
                &format!(
                    "{TWO}[[parts]]\nreference = [\"three/reference.py\"]\ntests = \"three/tests.toml\"\nreplaces = [3]\n"
                ),
                "## Part 2\n\nPairs.\n\n## Part 3\n\nMore.\n\n",
                "from 1 to 2, not 3",
            ),
            (
                "",
                "[[parts]]\nreference = [\"two/reference.py\"]\ntests = \"two/tests.toml\"\nbrute_force = \"two/brute.py\"\n",
                part_two,
                "together, or neither",
            ),
            (
                "",
                "[[parts]]\nreference = [\"missing.py\"]\ntests = \"two/tests.toml\"\n",
                part_two,
                "in part 2: \"missing.py\" isn't in",
            ),
            (
                "",
                "[[parts]]\nreference = []\ntests = \"two/tests.toml\"\n",
                part_two,
                "in part 2: a coding item needs a reference solution",
            ),
            ("", &TWO.repeat(5), "", "at most 5 parts"),
            (
                "[api]\nclass = \"Two words\"\n",
                "",
                "",
                "a name the code can define",
            ),
        ];
        for (front, parts, body, says) in cases {
            let err = in_parts(front, parts, body).unwrap_err();
            assert!(err.contains(says), "{parts} {body}: {err}");
        }
        let rust = Item::parse(
            "items/x/item.md",
            "x",
            "+++\nkind = \"coding\"\nskills = [\"dice\"]\nlanguages = [\"python\", \"rust\"]\nreference = [\"reference.py\", \"reference.rs\"]\nstarter = [\"starter.py\", \"starter.rs\"]\nbrute_force = \"brute.py\"\ntests = \"tests.toml\"\ninputs = \"inputs.py\"\napi = {}\n+++\nQ\n\n## Approach\n\nA\n",
            &manifest(),
            |_| Ok(String::new()),
        )
        .unwrap_err();
        assert!(rust.contains("API mode is for Python only"), "{rust}");
    }

    fn coding(languages: &str, reference: &str, starter: &str) -> String {
        format!(
            "+++\nkind = \"coding\"\nskills = [\"dice\"]\nlanguages = [\"{languages}\"]\nreference = [{reference}]\nstarter = [{starter}]\nbrute_force = \"brute.py\"\ntests = \"tests.toml\"\ninputs = \"inputs.py\"\n+++\nQ\n## Approach\nA\n"
        )
    }

    fn reading(fields: &str) -> String {
        reading_in("cpp", "int main() {}", fields)
    }

    fn reading_in(fence: &str, code: &str, fields: &str) -> String {
        format!(
            "+++\nkind = \"reading\"\nskills = [\"dice\"]\n{fields}+++\nWhat does it print?\n\n```{fence}\n{code}\n```\n\n## Explanation\n\nNothing.\n"
        )
    }

    fn reading_check(fence: &str, expect: &str) -> Result<crate::ReadingCheck, String> {
        let fields =
            format!("choices = [\"a\", \"b\"]\nanswer = 1\n[check]\nexpect = \"{expect}\"\n");
        let item = parse(&reading_in(fence, "x", &fields))?;
        let Content::Reading(reading) = item.content else {
            panic!("not reading");
        };
        Ok(reading.check)
    }

    #[test]
    fn reads_reading_items_in_each_language() {
        use crate::{Language, ReadingCheck};
        for (fence, language, default) in [
            ("python", Language::Python, ReadingCheck::Runs),
            ("py", Language::Python, ReadingCheck::Runs),
            ("rust", Language::Rust, ReadingCheck::Compiles),
            ("rs", Language::Rust, ReadingCheck::Compiles),
            ("cpp", Language::Cpp, ReadingCheck::Compiles),
            ("c++", Language::Cpp, ReadingCheck::Compiles),
            ("haskell", Language::Haskell, ReadingCheck::Compiles),
            ("hs", Language::Haskell, ReadingCheck::Compiles),
        ] {
            let item = parse(&reading_in(
                fence,
                "x",
                "choices = [\"a\", \"b\"]\nanswer = 1\n",
            ))
            .unwrap();
            let Content::Reading(reading) = item.content else {
                panic!("not reading");
            };
            assert_eq!(reading.language, language, "{fence}");
            assert_eq!(reading.check, default, "{fence}");
            let prints = parse(&reading_in(fence, "x", "prints = \"1\"\n")).unwrap();
            let Content::Reading(prints) = prints.content else {
                panic!("not reading");
            };
            assert_eq!(
                prints.check,
                ReadingCheck::Prints("1".to_owned()),
                "{fence}"
            );
            assert_eq!(
                reading_check(fence, "runs"),
                Ok(ReadingCheck::Runs),
                "{fence}"
            );
        }
        assert_eq!(
            reading_check("rust", "compiles"),
            Ok(ReadingCheck::Compiles)
        );
        assert_eq!(
            reading_check("rust", "compile-error"),
            Ok(ReadingCheck::CompileError)
        );
        assert_eq!(reading_check("rust", "panic"), Ok(ReadingCheck::Panics));
        assert_eq!(
            reading_check("cpp", "compile-error"),
            Ok(ReadingCheck::CompileError)
        );
        assert_eq!(
            reading_check("cpp", "sanitizer-error"),
            Ok(ReadingCheck::SanitizerError)
        );
        assert_eq!(
            reading_check("python", "exception"),
            Ok(ReadingCheck::Raises)
        );
        assert_eq!(
            reading_check("haskell", "compile-error"),
            Ok(ReadingCheck::CompileError)
        );
        assert_eq!(reading_check("hs", "exception"), Ok(ReadingCheck::Raises));
    }

    #[test]
    fn refuses_checks_that_dont_fit_the_language() {
        for (fence, expect, says) in [
            ("python", "compiles", "use expect = \"runs\""),
            ("python", "compile-error", "use expect = \"exception\""),
            (
                "python",
                "sanitizer-error",
                "for Python, use expect = \"exception\"",
            ),
            ("python", "panic", "for Python, use expect = \"exception\""),
            (
                "rust",
                "sanitizer-error",
                "for Rust, use expect = \"panic\"",
            ),
            ("rust", "exception", "for Rust, use expect = \"panic\""),
            ("cpp", "panic", "for C++, use expect = \"sanitizer-error\""),
            (
                "cpp",
                "exception",
                "for C++, use expect = \"sanitizer-error\"",
            ),
            (
                "haskell",
                "panic",
                "for Haskell, use expect = \"exception\"",
            ),
            (
                "haskell",
                "sanitizer-error",
                "for Haskell, use expect = \"exception\"",
            ),
        ] {
            let err = reading_check(fence, expect).unwrap_err();
            assert!(
                err.contains(&format!("expect = \"{expect}\" doesn't fit")),
                "{err}"
            );
            assert!(err.contains(says), "{fence} {expect}: {err}");
        }
    }

    #[test]
    fn reads_reading_items() {
        let prints = parse(&reading("prints = \"6\\n\"\n")).unwrap();
        assert_eq!(prints.track, TrackId::Coding);
        assert_eq!(prints.minutes, 2);
        assert!(prints.kind.is_short());
        let Content::Reading(reading_item) = prints.content else {
            panic!("not reading");
        };
        assert_eq!(reading_item.language, crate::Language::Cpp);
        assert_eq!(reading_item.code, "int main() {}\n");
        assert_eq!(
            reading_item.check,
            crate::ReadingCheck::Prints("6\n".to_owned())
        );
        let choice = parse(&reading(
            "choices = [\"It leaks\", \"It reads freed memory\"]\nanswer = 2\n[check]\nexpect = \"sanitizer-error\"\n",
        ))
        .unwrap();
        let Content::Reading(choice) = choice.content else {
            panic!("not reading");
        };
        assert_eq!(
            choice.question,
            crate::Question::Choice {
                choices: vec!["It leaks".to_owned(), "It reads freed memory".to_owned()],
                answer: 1
            }
        );
        assert_eq!(choice.check, crate::ReadingCheck::SanitizerError);
        let unchecked = parse(&reading("choices = [\"a\", \"b\"]\nanswer = 1\n")).unwrap();
        let Content::Reading(unchecked) = unchecked.content else {
            panic!("not reading");
        };
        assert_eq!(unchecked.check, crate::ReadingCheck::Compiles);
    }

    #[test]
    fn says_what_is_wrong_with_an_item() {
        let card = "kind = \"card\"\nskills = [\"arithmetic\"]";
        let broken = [
            ("What?\n## Answer\nYes", "front matter"),
            (
                "+++\nkind = \"card\"\nskills = [\"arithmetic\"]\nWhat?",
                "closing",
            ),
            (&*format!("+++\n{card}\n+++\nWhat?\n"), "## Answer"),
            (&*format!("+++\n{card}\n+++\n## Answer\nYes"), "prompt"),
            (&*format!("+++\n{card}\n+++\nQ\n## Answr\nYes"), "Answr"),
            (
                &*format!("+++\n{card}\ncolour = 1\n+++\nQ\n## Answer\nA"),
                "colour",
            ),
            (
                "+++\nkind = \"card\"\nskills = []\n+++\nQ\n## Answer\nA",
                "at least one skill",
            ),
            (
                "+++\nkind = \"card\"\nskills = [\"chess\"]\n+++\nQ\n## Answer\nA",
                "chess",
            ),
            (
                "+++\nkind = \"card\"\nid = \"Big\"\nskills = [\"dice\"]\n+++\nQ\n## Answer\nA",
                "lowercase",
            ),
            (
                "+++\nkind = \"card\"\ntrack = \"chess\"\nskills = [\"dice\"]\n+++\nQ\n## Answer\nA",
                "no track",
            ),
            (
                "+++\nkind = \"mental-maths\"\nskills = [\"dice\"]\nanswer = \"a\"\nrelative_tolerance = 5\n[params]\na = { min = 1, max = 2 }\n+++\n{a}",
                "relative_tolerance should be at least 0 and below 1",
            ),
            (
                "+++\nkind = \"mental-maths\"\nskills = [\"dice\"]\nanswer = \"a\"\nfactor = 0.5\n[params]\na = { min = 1, max = 2 }\n+++\n{a}",
                "factor should be above 1",
            ),
            (
                "+++\nkind = \"card\"\ntrack = \"rounds\"\nskills = [\"dice\"]\n+++\nQ\n## Answer\nA",
                "can't be in the rounds track",
            ),
            (
                "+++\nkind = \"riddle\"\nskills = [\"dice\"]\n+++\nQ",
                "riddle",
            ),
            (
                "+++\nkind = \"mental-maths\"\nskills = [\"dice\"]\nanswer = \"a\"\n[params]\na = { min = 1, max = 2 }\n+++\nWhat's {b}?",
                "{b}",
            ),
            (
                "+++\nkind = \"mental-maths\"\nskills = [\"dice\"]\nanswer = \"a\"\n[params]\na = { min = 3, max = 2 }\n+++\nQ",
                "above max",
            ),
            (
                "+++\nkind = \"probability\"\nskills = [\"dice\"]\nanswer = \"lots\"\n[simulation]\ntrials = 5000\ntolerance = 0.01\n+++\nQ\n## Solution\nS\n## Simulation\n```rhai\ntrue\n```",
                "should be a number",
            ),
            (
                "+++\nkind = \"probability\"\nskills = [\"dice\"]\nanswer = \"1/2\"\n[simulation]\ntrials = 5000\ntolerance = 0.01\n+++\nQ\n## Solution\nS\n## Simulation\nrand_bool(0.5)",
                "```rhai",
            ),
            (
                "+++\nkind = \"probability\"\nskills = [\"dice\"]\nanswer = \"1/2\"\n[simulation]\ntrials = 5\ntolerance = 0.01\n+++\nQ\n## Solution\nS\n## Simulation\n```rhai\ntrue\n```",
                "trials",
            ),
            (
                &*coding("python", "\"missing.py\"", "\"starter.py\""),
                "missing.py",
            ),
            (
                &*coding("python", "", "\"starter.py\""),
                "reference solution",
            ),
            (
                &*coding("python", "\"reference.py\"", ""),
                "starter in Python",
            ),
            (
                &*coding("cpp", "\"reference.py\"", "\"starter.py\""),
                "reading item",
            ),
            (
                &*coding("go", "\"reference.py\"", "\"starter.py\""),
                "\"go\"",
            ),
            (
                &*coding(
                    "python",
                    "\"reference.py\", \"reference.py\"",
                    "\"starter.py\"",
                ),
                "two reference solutions",
            ),
            (
                "+++\nkind = \"coding\"\nskills = [\"dice\"]\nlanguages = [\"python\"]\nreference = [\"reference.py\"]\nstarter = [\"starter.py\"]\nbrute_force = \"brute.py\"\ntests = \"tests.toml\"\ninputs = \"inputs.py\"\n+++\nQ",
                "## Approach",
            ),
            (
                &*reading("prints = \"1\"\n[check]\nexpect = \"compiles\"\n"),
                "no [check]",
            ),
            (
                &*reading("choices = [\"a\", \"b\"]\nanswer = 3\n"),
                "from 1 to 2",
            ),
            (&*reading("choices = [\"a\"]\nanswer = 1\n"), "two choices"),
            (&*reading(""), "either prints"),
            (
                &*reading("choices = [\"a\", \"b\"]\nanswer = 1\n[check]\nexpect = \"magic\"\n"),
                "\"magic\"",
            ),
            (
                &*reading("choices = [\"a\", \"b\"]\nanswer = 1\n[check]\nexpect = \"output\"\n"),
                "give the output",
            ),
            (
                "+++\nkind = \"design\"\nskills = [\"dice\"]\n+++\nQ\n## Rubric\nBe good.",
                "a list",
            ),
            (
                &*format!("+++\n{card}\ndifficulty = 6\n+++\nQ\n## Answer\nA"),
                "from 1 to 5, not 6",
            ),
            (
                &*format!("+++\n{card}\nfollow_ups = 4\n+++\nQ\n## Answer\nA"),
                "follow_ups should be from 0 to 3, not 4",
            ),
            (
                &*format!("+++\n{card}\nfollow_ups = -1\n+++\nQ\n## Answer\nA"),
                "follow_ups should be from 0 to 3, not -1",
            ),
            (
                "+++\nkind = \"probability\"\nskills = [\"dice\"]\nfollow_ups = 1\nanswer = \"1/2\"\n[simulation]\ntrials = 1000\ntolerance = 0.1\n+++\nQ\n## Solution\nS\n## Simulation\n```rhai\ntrue\n```",
                "follow_ups",
            ),
        ];
        for (source, expected) in broken {
            let err = parse(source).unwrap_err();
            assert!(err.contains(expected), "{source:?}: {err}");
        }
    }

    #[test]
    fn ignores_headings_inside_code() {
        let item = parse(
            "+++\nkind = \"card\"\nskills = [\"arithmetic\"]\n+++\nWhat does this print?\n\n```python\n## not a heading\nprint(1)\n```\n\n## Answer\n\n1\n",
        )
        .unwrap();
        assert!(item.prompt.contains("## not a heading"));
    }

    #[test]
    fn finds_placeholders() {
        assert_eq!(placeholders("{a} × {b_2} = {}"), ["a", "b_2"]);
        assert_eq!(placeholders("a set {1, 2}"), Vec::<String>::new());
    }

    const GOOD_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="10" height="10" stroke="currentColor"/></svg>"#;
    const GOOD_PNG: &[u8] = b"\x89PNG\r\n\x1a\nfake-body";

    fn parse_lesson_in(source: &str) -> Result<Item, String> {
        Item::parse_in(
            "items/lessons/heaps/item.md",
            "heaps",
            source,
            &manifest(),
            |file| {
                match file {
                "diagram.svg" => Ok(GOOD_SVG.as_bytes().to_vec()),
                "photo.png" => Ok(GOOD_PNG.to_vec()),
                "bad.png" => Ok(b"not a png".to_vec()),
                "evil.svg" => {
                    Ok(br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script></svg>"#.to_vec())
                }
                _ => Err(format!("{file:?} isn't in the item's directory")),
            }
            },
            |dir| Err(format!("{dir}/ isn't in the item's directory")),
        )
    }

    #[test]
    fn reads_a_lesson_and_its_linked_short_items() {
        let lesson = parse_lesson_in(
            r#"+++
kind = "lesson"
title = "Binary heaps"
skills = ["arithmetic"]
topic = "arithmetic/heaps"
requires = ["trees"]

[[sources]]
title = "Heap notes"
url = "https://example.com/heaps"

[[guesses]]
prompt = "Where is the smallest?"
choices = ["Root", "Leaf"]
answer = 1

[[checks]]
segment = 2
prompt = "What does sifting cost?"
choices = ["O(1)", "O(log n)", "O(n)"]
answer = 2
explanation = "It walks one root-to-leaf path."
+++
How a binary heap keeps the smallest at the root.

## Layout

Stored in an array.

![Heap diagram](diagram.svg)

## Sifting

Sifting takes log n steps.

![Step trace](photo.png)

## Explain

Why does an array work?

## Explain answer

Because the tree is complete with no gaps.
"#,
        )
        .unwrap();
        assert_eq!(lesson.id, "heaps");
        assert_eq!(lesson.kind, Kind::Lesson);
        assert_eq!(lesson.track, TrackId::Review);
        assert_eq!(lesson.minutes, 4);
        assert!(!lesson.kind.is_short());
        assert!(lesson.kind.can_be_in_pack_track());
        let Content::Lesson(parsed) = &lesson.content else {
            panic!("not a lesson");
        };
        assert_eq!(
            parsed.topic,
            Some(crate::TopicRef {
                skill: "arithmetic".to_owned(),
                topic: "heaps".to_owned(),
            })
        );
        assert_eq!(parsed.requires, ["trees"]);
        assert_eq!(parsed.sources.len(), 1);
        assert_eq!(parsed.guesses.len(), 1);
        assert_eq!(parsed.guesses[0].answer, 0);
        assert_eq!(parsed.segments.len(), 2);
        assert_eq!(parsed.segments[0].title, "Layout");
        assert!(parsed.segments[0].check.is_none());
        assert_eq!(parsed.segments[0].images.len(), 1);
        assert_eq!(parsed.segments[0].images[0].file, "diagram.svg");
        assert_eq!(parsed.segments[1].title, "Sifting");
        assert_eq!(parsed.segments[1].check.as_ref().unwrap().answer, 1);
        assert_eq!(parsed.segments[1].images[0].file, "photo.png");
        assert_eq!(parsed.explain, "Why does an array work?");
        assert_eq!(
            parsed.explain_answer,
            "Because the tree is complete with no gaps."
        );

        // Lessons default to the pack's track if it has one, unless they name their own.
        let pack_track_manifest = Manifest::parse(
            "id = \"ex\"\nname = \"Ex\"\ntrack = \"drill\"\n[[skills]]\nid = \"a\"\nname = \"A\"\n[[tracks]]\nid = \"drill\"\nname = \"Drill\"\n",
        )
        .unwrap();
        let minimal = "+++\nkind = \"lesson\"\nskills = [\"a\"]\n[[sources]]\ntitle = \"Ref\"\nurl = \"https://example.com\"\n+++\nSummary.\n## Part one\nText.\n## Explain\nWhy?\n## Explain answer\nBecause.\n";
        let in_pack_track = Item::parse("items/l.md", "l", minimal, &pack_track_manifest, |_| {
            Err("no files".to_owned())
        })
        .unwrap();
        assert_eq!(in_pack_track.track, TrackId::Pack("drill".parse().unwrap()));

        // Short items can link to a lesson and segment (1-based in TOML, 0-based in Rust).
        let card = parse(
            "+++\nkind = \"card\"\nskills = [\"arithmetic\"]\nlesson = \"heaps\"\nsegment = 2\n+++\nQ\n## Answer\nA\n",
        )
        .unwrap();
        assert_eq!(
            card.lesson,
            Some(LessonRef {
                id: "heaps".to_owned(),
                segment: Some(1),
            })
        );
        let reading = parse(&reading("lesson = \"heaps\"\nprints = \"1\"\n")).unwrap();
        assert_eq!(
            reading.lesson,
            Some(LessonRef {
                id: "heaps".to_owned(),
                segment: None,
            })
        );
    }

    #[test]
    fn says_what_is_wrong_with_a_lesson() {
        let base_front = "kind = \"lesson\"\nskills = [\"arithmetic\"]\n[[sources]]\ntitle = \"Ref\"\nurl = \"https://example.com\"\n";
        let base_body = "Summary.\n\n## First\n\nBody.\n\n## Explain\n\nWhy?\n\n## Explain answer\n\nBecause.\n";
        let with = |front: &str, body: &str| format!("+++\n{front}+++\n{body}");

        let seven_segments = (1..=7)
            .map(|n| format!("## Seg {n}\n\nText.\n\n"))
            .collect::<String>();
        let four_guesses = (1..=4)
            .map(|n| {
                format!("[[guesses]]\nprompt = \"G{n}\"\nchoices = [\"A\", \"B\"]\nanswer = 1\n")
            })
            .collect::<String>();

        let cases: &[(&str, &str)] = &[
            (
                "+++\nkind = \"lesson\"\nskills = [\"arithmetic\"]\n+++\nSummary.\n## One\nText.\n## Explain\nWhy?\n## Explain answer\nBecause.\n",
                "[[sources]]",
            ),
            (
                "+++\nkind = \"lesson\"\nskills = [\"arithmetic\"]\n[[sources]]\ntitle = \" \"\nurl = \"https://example.com\"\n+++\nSummary.\n## One\nText.\n## Explain\nWhy?\n## Explain answer\nBecause.\n",
                "title is empty",
            ),
            (
                "+++\nkind = \"lesson\"\nskills = [\"arithmetic\"]\n[[sources]]\ntitle = \"Ref\"\nurl = \"ftp://example.com\"\n+++\nSummary.\n## One\nText.\n## Explain\nWhy?\n## Explain answer\nBecause.\n",
                "http or https",
            ),
            (
                &*with(
                    base_front,
                    "Summary.\n## One\nText.\n## Explain answer\nBecause.\n",
                ),
                "## Explain",
            ),
            (
                &*with(base_front, "Summary.\n## One\nText.\n## Explain\nWhy?\n"),
                "## Explain answer",
            ),
            (
                &*with(
                    base_front,
                    "Summary.\n## Explain\nWhy?\n## Explain answer\nBecause.\n",
                ),
                "at least one segment",
            ),
            (
                &*with(
                    base_front,
                    &format!(
                        "Summary.\n{seven_segments}## Explain\nWhy?\n## Explain answer\nBecause.\n"
                    ),
                ),
                "at most 6 segments",
            ),
            (
                &*with(
                    base_front,
                    "Summary.\n## One\n\n## Explain\nWhy?\n## Explain answer\nBecause.\n",
                ),
                "is empty",
            ),
            (
                &*with(
                    base_front,
                    "Summary.\n## One\nA.\n## One\nB.\n## Explain\nWhy?\n## Explain answer\nBecause.\n",
                ),
                "there twice",
            ),
            (
                &*with(&format!("{base_front}{four_guesses}"), base_body),
                "at most 3 guesses",
            ),
            (
                &*with(
                    &format!(
                        "{base_front}[[guesses]]\nprompt = \"G\"\nchoices = [\"Only\"]\nanswer = 1\n"
                    ),
                    base_body,
                ),
                "between 2 and 5 choices",
            ),
            (
                &*with(
                    &format!(
                        "{base_front}[[guesses]]\nprompt = \"G\"\nchoices = [\"1\",\"2\",\"3\",\"4\",\"5\",\"6\"]\nanswer = 1\n"
                    ),
                    base_body,
                ),
                "between 2 and 5 choices",
            ),
            (
                &*with(
                    &format!(
                        "{base_front}[[guesses]]\nprompt = \"G\"\nchoices = [\"A\", \"B\"]\nanswer = 3\n"
                    ),
                    base_body,
                ),
                "from 1 to 2, not 3",
            ),
            (
                &*with(
                    &format!(
                        "{base_front}[[checks]]\nsegment = 2\nprompt = \"C\"\nchoices = [\"A\", \"B\"]\nanswer = 1\nexplanation = \"Because.\"\n"
                    ),
                    base_body,
                ),
                "only 1 segment",
            ),
            (
                &*with(
                    &format!(
                        "{base_front}[[checks]]\nsegment = 1\nprompt = \"C1\"\nchoices = [\"A\", \"B\"]\nanswer = 1\nexplanation = \"E1\"\n[[checks]]\nsegment = 1\nprompt = \"C2\"\nchoices = [\"A\", \"B\"]\nanswer = 1\nexplanation = \"E2\"\n"
                    ),
                    base_body,
                ),
                "more than one check",
            ),
            (
                &*with(
                    &format!(
                        "{base_front}[[checks]]\nsegment = 1\nprompt = \"C\"\nchoices = [\"A\", \"B\"]\nanswer = 1\nexplanation = \" \"\n"
                    ),
                    base_body,
                ),
                "empty explanation",
            ),
            (
                &*with(
                    &format!("requires = [\"a\", \"a\"]\n{base_front}"),
                    base_body,
                ),
                "lists \"a\" twice",
            ),
            (
                &*with(&format!("topic = \"heaps\"\n{base_front}"), base_body),
                "joined by `/`",
            ),
            (
                &*with(
                    &format!("topic = \"arithmetic/Heaps\"\n{base_front}"),
                    base_body,
                ),
                "joined by `/`",
            ),
            (
                &*with(&format!("topic = \"dice/heaps\"\n{base_front}"), base_body),
                "isn't one of the lesson's skills",
            ),
            (
                &*with(
                    &format!("topic = \"arithmetic/tries\"\n{base_front}"),
                    base_body,
                ),
                "isn't one of the topics of \"arithmetic\"",
            ),
            (
                &*with(
                    base_front,
                    "Summary.\n## One\n![](diagram.svg)\n## Explain\nWhy?\n## Explain answer\nBecause.\n",
                ),
                "needs alt text",
            ),
            (
                &*with(
                    base_front,
                    "Summary.\n## One\n![Alt](../diagram.svg)\n## Explain\nWhy?\n## Explain answer\nBecause.\n",
                ),
                "relative path inside",
            ),
            (
                &*with(
                    base_front,
                    "Summary.\n## One\n![Alt](/diagram.svg)\n## Explain\nWhy?\n## Explain answer\nBecause.\n",
                ),
                "relative path inside",
            ),
            (
                &*with(
                    base_front,
                    "Summary.\n## One\n![Alt](https://example.com/a.svg)\n## Explain\nWhy?\n## Explain answer\nBecause.\n",
                ),
                "not a URL",
            ),
            (
                &*with(
                    base_front,
                    "Summary.\n## One\n![Alt](photo.jpg)\n## Explain\nWhy?\n## Explain answer\nBecause.\n",
                ),
                ".svg or .png",
            ),
            (
                &*with(
                    base_front,
                    "Summary.\n## One\n![Alt](missing.svg)\n## Explain\nWhy?\n## Explain answer\nBecause.\n",
                ),
                "isn't in the item's directory",
            ),
            (
                &*with(
                    base_front,
                    "Summary.\n## One\n![Alt](bad.png)\n## Explain\nWhy?\n## Explain answer\nBecause.\n",
                ),
                "valid PNG",
            ),
            (
                &*with(
                    base_front,
                    "Summary.\n## One\n![Alt](evil.svg)\n## Explain\nWhy?\n## Explain answer\nBecause.\n",
                ),
                "<script>",
            ),
            (
                &*with(
                    base_front,
                    "Summary ![Alt](diagram.svg).\n## One\nText.\n## Explain\nWhy?\n## Explain answer\nBecause.\n",
                ),
                "images belong in segments",
            ),
            (
                "+++\nkind = \"card\"\nskills = [\"arithmetic\"]\nsegment = 1\n+++\nQ\n## Answer\nA\n",
                "give `lesson` too",
            ),
            (
                "+++\nkind = \"card\"\nskills = [\"arithmetic\"]\nlesson = \"heaps\"\nsegment = 0\n+++\nQ\n## Answer\nA\n",
                "at least 1",
            ),
            (
                "+++\nkind = \"design\"\nskills = [\"arithmetic\"]\nlesson = \"heaps\"\n+++\nDesign it.\n## Rubric\n- Works\n",
                "only short items",
            ),
        ];

        for (source, expected) in cases {
            let err = parse_lesson_in(source).unwrap_err();
            assert!(
                err.contains(expected),
                "expected {expected:?} in error {err:?} for:\n{source}"
            );
        }
    }

    /// A lab's front matter, with `extra` fields before its sources.
    fn lab_front(extra: &str) -> String {
        format!(
            "kind = \"lab\"\ntitle = \"Watching page faults\"\nskills = [\"arithmetic\"]\n{extra}[[sources]]\ntitle = \"perf-stat(1)\"\nurl = \"https://man7.org/linux/man-pages/man1/perf-stat.1.html\"\n"
        )
    }

    fn lab_with(front: &str, body: &str) -> String {
        format!("+++\n{front}+++\n{body}")
    }

    /// A lab's body, with `steps` between its setup and its explain question.
    fn lab_body(steps: &str) -> String {
        format!(
            "Count a program's page faults.\n\n## Setup\n\nA Linux machine with `perf`.\n\n{steps}## Explain\n\nWhy is the second run quicker?\n\n## Explain answer\n\nIts pages are in memory already.\n"
        )
    }

    const LAB_STEP: &str = "## Count the faults\n\nRun:\n\n```sh\nperf stat -e minor-faults ./alloc\n# ### Expected isn't a heading in here\n```\n\nRecord the count.\n\n### Expected\n\nAbout one minor fault for each page touched.\n\n";

    #[test]
    fn reads_a_lab() {
        let source = lab_with(
            &lab_front("lesson = \"heaps\"\n"),
            &lab_body(&format!(
                "{LAB_STEP}## Make a major fault\n\nDrop the page cache, then run it again.\n\n### Expected\n\nA major fault, as the page is read from disk.\n\n### Why\n\nIt's not in memory.\n\n"
            )),
        );
        let item = parse(&source).unwrap();
        assert_eq!(item.kind, Kind::Lab);
        // A lab is in the Review track unless it says, takes 40 minutes, and its `lesson` is one
        // to do first rather than one that teaches it.
        assert_eq!(item.track, TrackId::Review);
        assert_eq!(item.minutes, 40);
        assert_eq!(item.lesson, None);
        assert_eq!(item.prompt, "Count a program's page faults.");
        let Content::Lab(lab) = &item.content else {
            panic!("not a lab: {:?}", item.content);
        };
        assert_eq!(lab.lesson.as_deref(), Some("heaps"));
        assert_eq!(lab.sources[0].title, "perf-stat(1)");
        assert_eq!(lab.setup, "A Linux machine with `perf`.");
        assert_eq!(lab.steps.len(), 2);
        assert_eq!(lab.steps[0].title, "Count the faults");
        assert!(lab.steps[0].body.starts_with("Run:"));
        assert!(lab.steps[0].body.contains("# ### Expected isn't a heading"));
        assert!(lab.steps[0].body.ends_with("Record the count."));
        assert_eq!(
            lab.steps[0].expected,
            "About one minor fault for each page touched."
        );
        // Headings after `### Expected` are part of it.
        assert!(
            lab.steps[1]
                .expected
                .ends_with("### Why\n\nIt's not in memory.")
        );
        assert_eq!(lab.explain, "Why is the second run quicker?");
        assert_eq!(lab.explain_answer, "Its pages are in memory already.");
        assert!(
            lab.summary().contains("checked for form only"),
            "{}",
            lab.summary()
        );

        // In the pack's track, or its own, as lessons are, and as long as it says.
        let own = parse(&lab_with(
            &lab_front("track = \"estimation\"\nminutes = 25\n"),
            &lab_body(LAB_STEP),
        ))
        .unwrap();
        assert_eq!(own.track, TrackId::Pack("estimation".parse().unwrap()));
        assert_eq!(own.minutes, 25);
    }

    #[test]
    fn says_what_is_wrong_with_a_lab() {
        let nine_steps: String = (1..=9)
            .map(|n| format!("## Step {n}\n\nDo it.\n\n### Expected\n\nIt works.\n\n"))
            .collect();
        let no_sources = "kind = \"lab\"\nskills = [\"arithmetic\"]\n";
        let cases: Vec<(String, &str)> = vec![
            (lab_with(no_sources, &lab_body(LAB_STEP)), "[[sources]]"),
            (
                lab_with(
                    &lab_front(""),
                    "Count faults.\n\n## Count\n\nDo it.\n\n### Expected\n\nFaults.\n\n## Explain\n\nWhy?\n\n## Explain answer\n\nBecause.\n",
                ),
                "starts with a `## Setup`",
            ),
            (
                lab_with(
                    &lab_front(""),
                    "Count faults.\n\n## Setup\n\nA machine.\n\n## Explain\n\nWhy?\n\n## Explain answer\n\nBecause.\n",
                ),
                "at least one step",
            ),
            (
                lab_with(&lab_front(""), &lab_body(&nine_steps)),
                "at most 8 steps",
            ),
            (
                lab_with(
                    &lab_front(""),
                    &lab_body("## Count\n\nDo it, and record it.\n\n"),
                ),
                "needs an `### Expected`",
            ),
            (
                lab_with(
                    &lab_front(""),
                    &lab_body("## Count\n\n### Expected\n\nFaults.\n\n"),
                ),
                "says nothing to do",
            ),
            (
                lab_with(
                    &lab_front(""),
                    &lab_body("## Count\n\nDo it.\n\n### Expected\n\n"),
                ),
                "empty `### Expected`",
            ),
            (
                lab_with(
                    &lab_front(""),
                    &lab_body(
                        "## Count\n\nDo it.\n\n### Expected\n\nOne.\n\n### Expected\n\nTwo.\n\n",
                    ),
                ),
                "more than one `### Expected`",
            ),
            (
                lab_with(
                    &lab_front(""),
                    "Count faults.\n\n## Setup\n\nA machine.\n\n### Expected\n\nNo.\n\n## Count\n\nDo it.\n\n### Expected\n\nFaults.\n\n## Explain\n\nWhy?\n\n## Explain answer\n\nBecause.\n",
                ),
                "only steps have one",
            ),
            (
                lab_with(
                    &lab_front(""),
                    "Count faults.\n\n## Setup\n\nA machine.\n\n## Explain\n\nWhy?\n\n## Count\n\nDo it.\n\n### Expected\n\nFaults.\n\n## Explain answer\n\nBecause.\n",
                ),
                "comes after `## Explain`",
            ),
            (
                lab_with(
                    &lab_front(""),
                    "Count faults.\n\n## Setup\n\nA machine.\n\n## Count\n\nDo it.\n\n### Expected\n\nFaults.\n\n## Explain answer\n\nBecause.\n",
                ),
                "needs a `## Explain` section",
            ),
            (
                lab_with(
                    &lab_front(""),
                    "Count faults.\n\n## Setup\n\nA machine.\n\n## Count\n\nDo it.\n\n### Expected\n\nFaults.\n\n## Explain\n\nWhy?\n",
                ),
                "needs a `## Explain answer` section",
            ),
            (
                lab_with(
                    &lab_front(""),
                    &lab_body("## Count\n\nDo it.\n\n## Count\n\nAgain.\n\n"),
                ),
                "there twice",
            ),
            (
                lab_with(
                    &lab_front(""),
                    &lab_body(
                        "## Count\n\nSee ![the output](out.png).\n\n### Expected\n\nFaults.\n\n",
                    ),
                ),
                "can't include images",
            ),
            (
                lab_with(
                    &lab_front("lesson = \"heaps\"\nsegment = 1\n"),
                    &lab_body(LAB_STEP),
                ),
                "not a `segment`",
            ),
            (
                lab_with(&lab_front("lesson = \"Heaps!\"\n"), &lab_body(LAB_STEP)),
                "lowercase letters",
            ),
            (
                lab_with(&lab_front("rubric = [\"x\"]\n"), &lab_body(LAB_STEP)),
                "unknown field",
            ),
            (
                lab_with(&lab_front("track = \"coding\"\n"), &lab_body(LAB_STEP)),
                "can't be in the coding track",
            ),
        ];
        for (source, expected) in &cases {
            let err = parse(source).unwrap_err();
            assert!(
                err.contains(expected),
                "expected {expected:?} in error {err:?} for:\n{source}"
            );
        }
    }
}
