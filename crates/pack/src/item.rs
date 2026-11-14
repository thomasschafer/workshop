//! Items: Markdown files with TOML front matter between `+++` lines, whose body is the prompt,
//! followed by sections under `## ` headings that depend on the item's kind.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use workshop_tracks::TrackId;

use crate::code::{Coding, CodingFields, Reading, ReadingFields};
use crate::manifest::{Manifest, is_slug};
use crate::number::{self, Tolerance};

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
}

impl Kind {
    /// The track an item of this kind is in, unless it says otherwise.
    pub fn default_track(self) -> TrackId {
        match self {
            Self::Card => TrackId::Review,
            Self::MentalMaths => TrackId::MentalMaths,
            Self::Probability => TrackId::Probability,
            Self::Coding | Self::Reading => TrackId::Coding,
            Self::Design => TrackId::SystemDesign,
        }
    }

    /// Roughly how many minutes an item of this kind takes, unless it says.
    fn default_minutes(self) -> u32 {
        match self {
            Self::Card | Self::MentalMaths => 1,
            Self::Reading => 2,
            Self::Probability => 3,
            Self::Coding => 20,
            Self::Design => 30,
        }
    }

    /// Whether items of this kind are short enough to do offline in a spare minute.
    pub fn is_short(self) -> bool {
        matches!(
            self,
            Self::Card | Self::MentalMaths | Self::Probability | Self::Reading
        )
    }

    fn sections(self) -> &'static [(&'static str, bool)] {
        // (heading, required)
        match self {
            Self::Card => &[("Answer", true), ("Explanation", false)],
            Self::MentalMaths => &[("Method", false)],
            Self::Probability => &[("Solution", true), ("Simulation", true)],
            Self::Coding => &[("Approach", true), ("Hints", false), ("Notes", false)],
            Self::Reading => &[("Explanation", true)],
            Self::Design => &[("Rubric", true), ("Notes", false)],
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
    /// What the learner is asked, in Markdown.
    pub prompt: String,
    pub content: Content,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Content {
    Card {
        answer: String,
        explanation: Option<String>,
    },
    MentalMaths(MentalMaths),
    Probability(Probability),
    Coding(Coding),
    Reading(Reading),
    Design {
        /// What a good answer covers, one point each.
        rubric: Vec<String>,
        notes: Option<String>,
    },
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

const COMMON_KEYS: &[&str] = &[
    "id", "kind", "title", "skills", "track", "source", "minutes",
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
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoFields {}

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
            None => common.kind.default_track(),
        };
        if common.minutes == Some(0) {
            return Err("minutes should be at least 1".to_owned());
        }

        let (prompt, mut sections) = split_sections(body, common.kind)?;
        let mut section = |name: &str| sections.remove(name);
        let kind_fields = toml::Value::Table(table);
        let content = match common.kind {
            Kind::Card => {
                kind_fields
                    .try_into::<NoFields>()
                    .map_err(|err| err.to_string())?;
                Content::Card {
                    answer: section("Answer").expect("required"),
                    explanation: section("Explanation"),
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
                let fields: CodingFields = kind_fields.try_into().map_err(|err| err.to_string())?;
                Content::Coding(Coding::new(
                    fields,
                    section("Approach").expect("required"),
                    section("Hints"),
                    section("Notes"),
                    &read,
                )?)
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
                }
            }
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

pub(crate) fn split_front_matter(source: &str) -> Result<(&str, &str), String> {
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

fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::Card => "card",
        Kind::MentalMaths => "mental maths",
        Kind::Probability => "probability",
        Kind::Coding => "coding",
        Kind::Reading => "reading",
        Kind::Design => "design",
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
                explanation: Some("7 × 8 = 7 × 7 + 7.".to_owned())
            }
        );
        assert_eq!(item.label(), "What's 7 × 8?");
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
        let Content::Coding(problem) = &coding.content else {
            panic!("not coding");
        };
        assert_eq!(problem.hints, ["Start at zero.", "Add each number."]);
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
                notes: None
            }
        );
    }

    fn coding(languages: &str, reference: &str, starter: &str) -> String {
        format!(
            "+++\nkind = \"coding\"\nskills = [\"dice\"]\nlanguages = [\"{languages}\"]\nreference = [{reference}]\nstarter = [{starter}]\nbrute_force = \"brute.py\"\ntests = \"tests.toml\"\ninputs = \"inputs.py\"\n+++\nQ\n## Approach\nA\n"
        )
    }

    fn reading(fields: &str) -> String {
        format!(
            "+++\nkind = \"reading\"\nskills = [\"dice\"]\n{fields}+++\nWhat does it print?\n\n```cpp\nint main() {{}}\n```\n\n## Explanation\n\nNothing.\n"
        )
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
}
