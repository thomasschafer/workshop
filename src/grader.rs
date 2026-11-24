//! The grader: a coach that marks written work against a rubric, such as an answer to a design
//! prompt, a coding problem's plan or a card answered in the learner's own words, with any
//! follow-up questions on it, and checks cards for mistakes. It's a model with no tools, through
//! the provider layer, as the tutor is.
//!
//! Its marks feed the mistake log, with each finding tagged with a kind of mistake, and mastery,
//! as an attempt rated from the score. A card it finds wrong gets a proposed fix, which the
//! learner approves before it changes the pack.

use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use workshop_learning::{MistakeSource, NewMistake, Rating};
use workshop_pack::{Content, ErrorType, Item, Task};
use workshop_provider::{CallSpec, ProviderRunner};

pub const TIMEOUT: Duration = Duration::from_secs(180);

/// The grader's instructions, with a pack's add-on if it has one.
pub fn system_prompt(add_on: Option<&str>) -> String {
    with_add_on(include_str!("../prompts/grader.md"), add_on)
}

/// A coach's instructions, with a pack's add-on to them if it has one.
pub fn with_add_on(base: &str, add_on: Option<&str>) -> String {
    let base = base.trim_end();
    match add_on.map(str::trim).filter(|add_on| !add_on.is_empty()) {
        Some(add_on) => format!("{base}\n\nThe pack adds:\n\n{add_on}"),
        None => base.to_owned(),
    }
}

/// What's being marked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Work {
    /// An answer to a design prompt, against its rubric.
    Design,
    /// How the learner plans to solve a coding problem, against its approach.
    Plan,
    /// A card's answer, in the learner's own words.
    Card,
    /// How a coding problem's solution works, explained once it's been solved or given up
    /// on, against its approach.
    Explanation,
    /// A timed round with the examiner, on a coding problem, a probability question or a
    /// design prompt: the learner's working and what was said.
    Round,
    /// An answer to a twist on a coding problem solved before, posed for its review, against
    /// what a good answer to the twist covers.
    Twist,
    /// A card's answer, in the learner's own words, and their replies to the tutor's follow-up
    /// questions about it, marked for how deeply they understand it as well as whether it's
    /// right.
    FollowUps,
    /// Review comments on a change to a codebase, against the defects planted in it.
    Review,
}

impl Work {
    /// Whether marking it counts as an attempt at the item. A coding problem's attempt is its
    /// own, when it's finished, so its plan and explanation only add to the mistake log.
    pub fn is_attempt(self) -> bool {
        matches!(
            self,
            Self::Design | Self::Card | Self::Round | Self::FollowUps | Self::Review
        )
    }
}

/// What the learner gave in, to be marked.
#[derive(Debug, Clone, Copy)]
pub struct Answer<'a> {
    pub text: &'a str,
    /// Whether it was explained aloud, so it's a transcript, which is also marked for how
    /// clearly it was put.
    pub spoken: bool,
    /// For an explanation of a solution, the learner's code, and its language's name.
    pub code: Option<(&'a str, &'a str)>,
    /// What the grader should know about how the work was done, such as how a timed round
    /// ended.
    pub note: Option<&'a str>,
    /// For an answer to a twist, the twist and what a good answer to it covers.
    pub twist: Option<(&'a str, &'a str)>,
    /// For a design session or a round of a design prompt, the brief the learner's questions
    /// were answered from, which they never saw: what they asked is marked too.
    pub brief: Option<&'a str>,
    /// For a plan for a coding problem in parts, the part it's for, counting from 0: the
    /// question is then the parts up to it. Otherwise a problem in parts is asked as a whole.
    pub part: Option<usize>,
    /// For an explanation of work in a codebase, the learner's changes to it, as a diff.
    pub changes: Option<&'a str>,
}

impl<'a> Answer<'a> {
    pub fn written(text: &'a str) -> Self {
        Self {
            text,
            spoken: false,
            code: None,
            note: None,
            twist: None,
            brief: None,
            part: None,
            changes: None,
        }
    }
}

/// The rubric points for what a learner asked about a design, added to its own when its
/// questions were answered from a brief.
pub const QUESTIONING: [&str; 2] = [
    "Asks the questions that matter, finding out the key requirements before designing",
    "Asks rather than assumes: takes nothing as given that could have been asked",
];

/// The rubric points for a card's follow-up questions, added to its own.
pub const FOLLOWED_UP_POINTS: [&str; 2] = [
    "Answers each follow-up question soundly",
    "Shows why the answer holds, and where it wouldn't, not only what it is",
];

/// The rubric for a piece of work on an item, and what a good answer looks like, if the item
/// has one. Fails for work the item can't have.
fn rubric(item: &Item, work: Work, answer: &Answer<'_>) -> Result<(Vec<String>, Option<String>)> {
    let (mut rubric, reference) = own_rubric(item, work, answer.twist)?;
    if answer.brief.is_some() {
        if !matches!(
            (work, &item.content),
            (Work::Design | Work::Round, Content::Design { .. })
        ) {
            bail!(
                "only a design prompt's session or round is marked with a brief, not {}",
                item.label()
            );
        }
        rubric.extend(QUESTIONING.iter().map(|&point| point.to_owned()));
    }
    Ok((rubric, reference))
}

/// The rubric for the work itself, before what the learner asked.
fn own_rubric(
    item: &Item,
    work: Work,
    twist: Option<(&str, &str)>,
) -> Result<(Vec<String>, Option<String>)> {
    match (work, &item.content) {
        (Work::Twist, Content::Coding(coding)) => {
            let (_, notes) = twist.context("a twist's answer is marked against the twist")?;
            Ok((
                vec![
                    "Says what has to change in the approach for the twist, and why it then gives the right answer".to_owned(),
                    "Says what the changed approach costs, in time and space, and that it's good enough for the twist".to_owned(),
                    "Handles the unusual inputs the twist brings".to_owned(),
                ],
                Some(format!(
                    "{}\n\nHow the original problem is solved:\n\n{}",
                    notes.trim(),
                    coding.approach.trim()
                )),
            ))
        }
        (Work::Design, Content::Design { rubric, notes, .. }) => {
            Ok((rubric.clone(), notes.clone()))
        }
        (Work::Plan | Work::Explanation, Content::Coding(coding))
            if let Some(project) = coding.project() =>
        {
            let points: &[&str] = match (project.task, work) {
                (Task::Fix, Work::Plan) => &[
                    "Finds where the bug is, from the symptom, or a sound way to find it",
                    "Says why it happens: the cause, not only the symptom",
                    "Plans a small fix to the cause, that leaves the rest working",
                ],
                (Task::Fix, _) => &[
                    "Says what the bug was, and why it gave the symptom",
                    "Explains why the fix puts the cause right, everywhere it shows",
                    "Says how it's known to work, such as which tests show it",
                ],
                (_, Work::Plan) => &[
                    "Says what makes the code hard to test, or hard to change for what's asked",
                    "Plans changes that let tests give it what it needs, keeping what it does",
                    "Keeps the existing behaviour, and its tests, working",
                ],
                _ => &[
                    "Says what the changes separate, and why that makes the code testable",
                    "Explains how what it did before still works",
                    "Says how the change made the extension easier",
                ],
            };
            Ok((
                points.iter().map(|&point| point.to_owned()).collect(),
                Some(coding.approach.clone()),
            ))
        }
        (Work::Review, Content::Review(review)) => Ok((
            review
                .defects
                .iter()
                .enumerate()
                .map(|(at, defect)| {
                    format!(
                        "{} Finds that {} ({})",
                        defect_id(at),
                        defect.description,
                        defect.location()
                    )
                })
                .collect(),
            review.notes.clone(),
        )),
        (Work::Plan, Content::Coding(coding)) => Ok((
            vec![
                "Chooses a method that solves the problem correctly".to_owned(),
                "Is efficient enough for the sizes of input the problem allows".to_owned(),
                "Says how the unusual inputs are handled".to_owned(),
            ],
            Some(coding.approach.clone()),
        )),
        (Work::Explanation, Content::Coding(coding)) => Ok((
            vec![
                "Explains why the solution gives the right answer".to_owned(),
                "Says what the solution costs, in time and space".to_owned(),
                "Says how the unusual inputs are handled".to_owned(),
            ],
            Some(coding.approach.clone()),
        )),
        (Work::Round, Content::Coding(coding)) => Ok((
            vec![
                "Chooses a method that solves the problem correctly, and is efficient enough"
                    .to_owned(),
                "Writes code, or steps close enough to code, that would work".to_owned(),
                "Handles the unusual inputs".to_owned(),
                "Answers the examiner's follow-up questions well".to_owned(),
            ],
            Some(coding.approach.clone()),
        )),
        (Work::Round, Content::Probability(probability)) => Ok((
            vec![
                "Gets the right answer".to_owned(),
                "Shows how it was worked out, soundly".to_owned(),
                "Answers the examiner's follow-up questions well".to_owned(),
            ],
            Some(format!(
                "The answer is {}.\n\n{}",
                probability.answer_text, probability.solution
            )),
        )),
        (Work::Round, Content::Design { rubric, notes, .. }) => {
            let mut points = rubric.clone();
            points.push("Answers the examiner's follow-up questions well".to_owned());
            Ok((points, notes.clone()))
        }
        (
            Work::Card | Work::FollowUps,
            Content::Card {
                answer,
                explanation,
                ..
            },
        ) => {
            let mut points = vec![
                "Gives the card's answer, in any words".to_owned(),
                "Says nothing that contradicts the card".to_owned(),
            ];
            if work == Work::FollowUps {
                points.extend(FOLLOWED_UP_POINTS.iter().map(|&point| point.to_owned()));
            }
            Ok((
                points,
                Some(match explanation {
                    Some(explanation) => format!("{answer}\n\n{explanation}"),
                    None => answer.clone(),
                }),
            ))
        }
        _ => bail!("{} can't be marked as that kind of work", item.label()),
    }
}

/// The grader's prompt for marking work.
pub fn mark_prompt(
    item: &Item,
    work: Work,
    answer: Answer<'_>,
    error_types: &[ErrorType],
) -> Result<String> {
    let (rubric, reference) = rubric(item, work, &answer)?;
    let question = match (&item.content, answer.part) {
        (Content::Coding(coding), part) => {
            let through = part.unwrap_or(coding.last());
            if through > coding.last() {
                bail!("{} has no part {}", item.label(), through + 1);
            }
            coding.statement(through)
        }
        (_, Some(_)) => bail!("only a coding problem comes in parts"),
        (_, None) => item.prompt.clone(),
    };
    let mut out = format!("<question>\n{}\n</question>\n\n", question.trim());
    // Work in a codebase is marked knowing the project, as it's given.
    match &item.content {
        Content::Coding(coding) if let Some(project) = coding.project() => {
            let through = answer.part.unwrap_or(coding.last());
            let files = project
                .files
                .iter()
                .filter(|f| !f.is_test())
                .chain(coding.test_files(through));
            out.push_str(&format!(
                "The question is set in a project someone else wrote, as it's given:\n\n<project>\n{}</project>\n\n",
                workshop_pack::project::as_text(files)
            ));
        }
        Content::Review(review) => {
            out.push_str(&format!(
                "The project, before the change:\n\n<project>\n{}</project>\n\nThe change the learner reviewed:\n\n<change>\n{}</change>\n\nThe rubric's points are the defects planted in the change, each with an id, such as [D1], and where it is, by its line in the changed file; give each point back as it's written, starting with its id. Each review comment says where it's about, by a file and a line in the changed file, or a line of the old file it removes, or says nothing of where, for the change as a whole. Credit a point when a comment finds that defect, in any words, even if it's about a nearby line or gives no line, and partly when it notices something wrong there but not what. A comment that finds a real problem that isn't a point is fine, and so is one on style or naming: neither is a finding. Each finding is a false alarm: a comment saying something is wrong that isn't, such as a misread of what the code does. Don't list a defect that was missed as a finding; it's kept as a mistake already.\n\n",
                workshop_pack::project::as_text(review.files.iter()),
                review.diff()
            ));
        }
        _ => {}
    }
    if let (Content::Coding(coding), Some(part)) = (&item.content, answer.part)
        && coding.in_parts()
    {
        out.push_str(&format!(
            "The question comes in {} parts, each adding to the last, and the learner is on part {}: their work is for what it adds, building on their solution to the parts before it, so mark it as that. They haven't seen the parts after it, which the reference covers too.\n\n",
            coding.parts.len(),
            part + 1
        ));
    }
    if let Some((twist, _)) = answer.twist {
        out.push_str(&format!(
            "<twist>\n{}\n</twist>\n\nThe learner solved the question before, and is answering this twist on it: mark their answer to the twist.\n\n",
            twist.trim()
        ));
    }
    out.push_str("<rubric>\n");
    for point in &rubric {
        out.push_str(&format!("- {point}\n"));
    }
    out.push_str("</rubric>\n\n");
    if let Some(reference) = reference {
        let hidden = if matches!(work, Work::Explanation | Work::Twist) {
            "they've solved it, or given up on it, and may have seen it since"
        } else {
            "the learner hasn't seen it"
        };
        out.push_str(&format!(
            "<reference>\n{}\n</reference>\n\nThe reference is how it's meant to be answered, for you to mark against; {hidden}.\n\n",
            reference.trim()
        ));
    }
    if let Some(changes) = answer.changes {
        out.push_str(&format!(
            "<changes>\n{}\n</changes>\n\nThese are the learner's changes to the project, which the work explains.\n\n",
            changes.trim_end()
        ));
    }
    if let Some((language, code)) = answer.code {
        out.push_str(&format!(
            "<code language=\"{language}\">\n{}\n</code>\n\nThis is the learner's code, which the work explains.\n\n",
            code.trim_end()
        ));
    }
    if let Some(brief) = answer.brief {
        out.push_str(&format!("<brief>\n{}\n</brief>\n\n{BRIEFED}", brief.trim()));
    }
    out.push_str(&format!("<work>\n{}\n</work>\n\n", answer.text.trim()));
    if work == Work::FollowUps {
        out.push_str(FOLLOWED_UP);
    }
    if let Some(note) = answer.note {
        out.push_str(&format!("{}\n\n", note.trim()));
    }
    if answer.spoken {
        out.push_str(if work == Work::FollowUps {
            SPOKEN_IN_PART
        } else {
            SPOKEN_WHOLE
        });
        out.push_str(SPOKEN);
    }
    out.push_str(&kinds(error_types));
    out.push_str(
        "Mark the work. Reply with JSON: {\"score\": number from 0 to 1, \"points\": [{\"point\": the rubric point, \"met\": \"yes\" | \"partly\" | \"no\", \"comment\": string}], \"findings\": [{\"error_type\": one of the kinds' ids, \"detail\": string}], \"feedback\": string",
    );
    if answer.brief.is_some() {
        out.push_str(
            ", \"questioning\": {\"found\": [string], \"missed\": [string], \"assumed\": [string]}",
        );
    }
    if answer.spoken {
        out.push_str(", \"clarity\": {\"score\": number from 0 to 1, \"feedback\": string}");
    }
    out.push('}');
    Ok(out)
}

/// What the grader is told about a design whose questions were answered from a brief.
const BRIEFED: &str = "The brief is what the learner's questions were answered from. They never saw it, so they only know what they asked, and what the question itself says. Besides the design, judge what they asked: in `questioning`, list the brief's key requirements they found out, by asking or from the question (`found`), those that matter to the design that they never found out (`missed`), and what they took as given without asking that they could have asked (`assumed`), each in a few words. A requirement in `missed` is kept as a mistake already, so don't list it in `findings` too. A design that goes against a requirement they did find out is a finding, as is an assumption that contradicts the brief.\n\n";

/// What the grader is told about a card's answer followed up by the tutor's questions.
const FOLLOWED_UP: &str = "The work is the learner's answer to the card, then the follow-up questions a tutor asked about what they said, each with their reply. Mark the exchange as a whole, against the reference: credit the depth their replies show, such as saying why the answer holds, what happens in an edge case or how it would change under a different condition, and say in the points' comments and the findings what was shallow or wrong. A reply that only restates the answer shows no more depth, and a question left unanswered counts as not knowing. A reply that's wrong, or shows they don't understand why the answer holds, is a finding, usually a concept-gap. The tutor's questions aren't the learner's work, so don't mark them.\n\n";

/// What the grader is told about work explained aloud, before [`SPOKEN`].
const SPOKEN_WHOLE: &str =
    "The learner explained this aloud, and the work is what speech recognition heard.";

/// What the grader is told about follow-ups answered aloud in part, before [`SPOKEN`].
const SPOKEN_IN_PART: &str = "The learner explained this aloud in part: what's marked \"(aloud)\" is what speech recognition heard, and the rest was written, so judge clarity on what they said aloud.";

/// What the grader is told about work explained aloud, wholly or in part.
const SPOKEN: &str = " Mark what they meant where a word is plainly misheard, such as one that sounds like the right term, and don't count the way speech is written down against them. Besides marking it against the rubric, judge how clearly they explained it: whether it's in a sensible order, gets to the point, names things precisely and would be easy to follow if heard. The score is for the rubric alone; clarity has its own score and feedback.\n\n";

fn kinds(error_types: &[ErrorType]) -> String {
    let mut out = String::from("<kinds_of_mistake>\n");
    for kind in error_types {
        out.push_str(&format!("- {}: {}\n", kind.id, kind.description));
    }
    out.push_str("</kinds_of_mistake>\n\n");
    out
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Met {
    Yes,
    Partly,
    No,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub point: String,
    pub met: Met,
    #[serde(default)]
    pub comment: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Finding {
    /// A kind of mistake, or None if the grader named one that doesn't exist.
    pub error_type: Option<String>,
    pub detail: String,
}

/// The grader's marking of a piece of work.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Marked {
    pub score: f64,
    pub points: Vec<Point>,
    pub findings: Vec<Finding>,
    pub feedback: String,
    /// For work explained aloud, how clearly it was put.
    #[serde(default)]
    pub clarity: Option<Clarity>,
    /// For a design whose questions were answered from a brief, what the learner asked.
    #[serde(default)]
    pub questioning: Option<Questioning>,
    /// For a review of a change, the defects in it the learner didn't find.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missed: Vec<String>,
}

/// What a learner found out about a design's requirements by asking, and what they didn't.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Questioning {
    /// The brief's key requirements they found out.
    #[serde(default)]
    pub found: Vec<String>,
    /// Key requirements they never found out, which go in the mistake log.
    #[serde(default)]
    pub missed: Vec<String>,
    /// What they took as given without asking.
    #[serde(default)]
    pub assumed: Vec<String>,
}

/// The kind of mistake a requirement missed in a design is kept as.
pub const MISSED_REQUIREMENT: &str = "missed-requirement";

/// The kind of mistake a defect missed in a review is kept as.
pub const MISSED_DEFECT: &str = "missed-defect";

/// How much each false alarm in a review takes off its score.
pub const FALSE_ALARM_COST: f64 = 0.1;

/// How clearly something explained aloud was put.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Clarity {
    /// From 0 to 1.
    pub score: f64,
    pub feedback: String,
}

impl Marked {
    /// How the attempt counts towards scheduling and mastery.
    pub fn rating(&self) -> Rating {
        match self.score {
            s if s >= 0.85 => Rating::Good,
            s if s >= 0.6 => Rating::Hard,
            _ => Rating::Again,
        }
    }

    /// How an answer to a twist counts, as a coding problem's review: as other work, except
    /// that a twist answered fully, with nothing wrong found, is easy. A harder follow-up done
    /// that well says the problem's known, so like any problem rated easy it's retired.
    pub fn twist_rating(&self) -> Rating {
        if self.score >= 0.95 && self.findings.is_empty() {
            Rating::Easy
        } else {
            self.rating()
        }
    }

    /// The mistakes the grader found, for the mistake log, with ids made from the grading's:
    /// its findings, then the requirements of a design the learner never found out.
    pub fn mistakes(&self, id: &str, item: &str, at: i64) -> Vec<NewMistake> {
        let findings = self
            .findings
            .iter()
            .map(|finding| (finding.detail.clone(), finding.error_type.clone()));
        let missed = self
            .questioning
            .iter()
            .flat_map(|questioning| &questioning.missed)
            .map(|requirement| {
                (
                    format!("Didn't find out: {requirement}"),
                    Some(MISSED_REQUIREMENT.to_owned()),
                )
            });
        let defects = self.missed.iter().map(|defect| {
            (
                format!("Missed in a review: {defect}"),
                Some(MISSED_DEFECT.to_owned()),
            )
        });
        findings
            .chain(missed)
            .chain(defects)
            .enumerate()
            .map(|(n, (detail, suggested))| NewMistake {
                id: format!("grade-{id}-{n}"),
                item: item.to_owned(),
                at,
                source: MistakeSource::Grader,
                attempt: None,
                detail,
                suggested,
            })
            .collect()
    }
}

/// The JSON object in a model's reply, which may be wrapped in a fenced code block.
pub fn json_in(reply: &str) -> Result<&str> {
    let start = reply
        .find('{')
        .context("the grader's reply has no JSON in it")?;
    let end = reply
        .rfind('}')
        .context("the grader's reply has no JSON in it")?;
    if end < start {
        bail!("the grader's reply has no JSON in it");
    }
    Ok(&reply[start..=end])
}

/// Reads the grader's marking, checking it's whole, and dropping kinds of mistake that don't
/// exist rather than trusting them. Work explained aloud must have been marked for clarity, and
/// work with a brief for what the learner asked.
pub fn parse_marked(reply: &str, error_types: &[ErrorType], answer: &Answer<'_>) -> Result<Marked> {
    let spoken = answer.spoken;
    #[derive(Deserialize)]
    struct Raw {
        score: f64,
        points: Vec<Point>,
        #[serde(default)]
        findings: Vec<RawFinding>,
        feedback: String,
        clarity: Option<Clarity>,
        questioning: Option<Questioning>,
    }
    #[derive(Deserialize)]
    struct RawFinding {
        error_type: Option<String>,
        detail: String,
    }
    let raw: Raw = serde_json::from_str(json_in(reply)?)
        .with_context(|| format!("the grader's reply isn't in the shape asked for: {reply}"))?;
    if !(0.0..=1.0).contains(&raw.score) {
        bail!("the grader gave a score of {}, outside 0 to 1", raw.score);
    }
    let clarity = match (spoken, raw.clarity) {
        (true, None) => bail!("the grader didn't say how clearly it was explained: {reply}"),
        (true, Some(clarity)) if !(0.0..=1.0).contains(&clarity.score) => bail!(
            "the grader gave clarity a score of {}, outside 0 to 1",
            clarity.score
        ),
        (true, clarity) => clarity,
        (false, _) => None,
    };
    let questioning = match (answer.brief, raw.questioning) {
        (Some(_), None) => bail!("the grader didn't say what the learner asked about: {reply}"),
        (Some(_), questioning) => questioning,
        (None, _) => None,
    };
    Ok(Marked {
        score: raw.score,
        points: raw.points,
        findings: raw
            .findings
            .into_iter()
            .map(|finding| Finding {
                error_type: finding
                    .error_type
                    .filter(|id| error_types.iter().any(|t| t.id == *id)),
                detail: finding.detail,
            })
            .collect(),
        feedback: raw.feedback,
        clarity,
        questioning,
        missed: Vec::new(),
    })
}

/// A review's marking, scored from what it found rather than as the grader weighs it, so it's
/// the same however the grader would weigh it: the share of the defects found, with one found
/// in part counting half, less [`FALSE_ALARM_COST`] for each false alarm. The defects not found
/// at all are kept, for the mistake log.
pub fn score_review(marked: Marked, review: &workshop_pack::Review) -> Result<Marked> {
    // Points are matched with defects by their ids, whatever order the grader gives them in.
    let mut points: Vec<Option<Point>> = vec![None; review.defects.len()];
    for point in &marked.points {
        let at = (0..review.defects.len())
            .find(|&at| point.point.trim_start().starts_with(&defect_id(at)))
            .with_context(|| {
                format!(
                    "the grader marked a point that isn't one of the defects: {:?}",
                    point.point
                )
            })?;
        if points[at].replace(point.clone()).is_some() {
            bail!("the grader marked {} twice", defect_id(at));
        }
    }
    let points: Vec<Point> = points
        .into_iter()
        .enumerate()
        .map(|(at, point)| {
            point.with_context(|| format!("the grader didn't mark {}", defect_id(at)))
        })
        .collect::<Result<_>>()?;
    let marked = Marked { points, ..marked };
    let found: f64 = marked
        .points
        .iter()
        .map(|point| match point.met {
            Met::Yes => 1.0,
            Met::Partly => 0.5,
            Met::No => 0.0,
        })
        .sum();
    let score = (found / review.defects.len() as f64
        - FALSE_ALARM_COST * marked.findings.len() as f64)
        .clamp(0.0, 1.0);
    let missed = marked
        .points
        .iter()
        .zip(&review.defects)
        .filter(|(point, _)| point.met == Met::No)
        .map(|(_, defect)| format!("{} ({})", defect.description, defect.location()))
        .collect();
    Ok(Marked {
        score,
        missed,
        ..marked
    })
}

/// What a review's defect is called in its rubric, which the grader gives back with its mark:
/// `[D1]`, counting from 1.
fn defect_id(at: usize) -> String {
    format!("[D{}]", at + 1)
}

/// Marks a piece of work with the grader.
pub async fn mark(
    runner: &ProviderRunner,
    spec: &CallSpec,
    item: &Item,
    work: Work,
    answer: Answer<'_>,
    error_types: &[ErrorType],
) -> Result<Marked> {
    if answer.text.trim().is_empty() {
        bail!(if answer.spoken {
            "nothing was heard to mark"
        } else {
            "there's nothing written to mark"
        });
    }
    let prompt = mark_prompt(item, work, answer, error_types)?;
    let reply = runner.call_aside(spec, &prompt, TIMEOUT).await?;
    let marked = parse_marked(&reply.text, error_types, &answer)?;
    match &item.content {
        Content::Review(review) => score_review(marked, review),
        _ => Ok(marked),
    }
}

/// The grader's review of a card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Review {
    pub verdict: Verdict,
    /// Why, in a sentence or two.
    pub explanation: String,
    /// For a card that's wrong, the corrected answer and explanation.
    pub fix: Option<Fix>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Correct,
    Wrong,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fix {
    pub answer: String,
    pub explanation: Option<String>,
}

/// The grader's prompt for checking a card, with what the learner said was wrong, if they did.
pub fn review_prompt(item: &Item, note: Option<&str>) -> Result<String> {
    let Content::Card {
        answer,
        explanation,
        ..
    } = &item.content
    else {
        bail!("only cards are reviewed");
    };
    let mut out = format!(
        "<question>\n{}\n</question>\n\n<answer>\n{}\n</answer>\n\n",
        item.prompt.trim(),
        answer.trim()
    );
    if let Some(explanation) = explanation {
        out.push_str(&format!(
            "<explanation>\n{}\n</explanation>\n\n",
            explanation.trim()
        ));
    }
    match note.map(str::trim).filter(|n| !n.is_empty()) {
        Some(note) => out.push_str(&format!(
            "The learner flagged this card as wrong, saying: {note}\n\n"
        )),
        None => out.push_str("Check this card for mistakes.\n\n"),
    }
    out.push_str("Reply with JSON: {\"verdict\": \"correct\" | \"wrong\", \"explanation\": string, \"fix\": null, or for a wrong card {\"answer\": string, \"explanation\": string or null}}");
    Ok(out)
}

pub fn parse_review(reply: &str) -> Result<Review> {
    let review: Review = serde_json::from_str(json_in(reply)?)
        .with_context(|| format!("the grader's review isn't in the shape asked for: {reply}"))?;
    match (&review.verdict, &review.fix) {
        (Verdict::Wrong, None) => bail!("the grader says the card is wrong but proposes no fix"),
        (Verdict::Wrong, Some(fix)) if fix.answer.trim().is_empty() => {
            bail!("the grader's fix has no answer")
        }
        (Verdict::Correct, _) => Ok(Review {
            fix: None,
            ..review
        }),
        _ => Ok(review),
    }
}

/// Checks a card with the grader.
pub async fn review(
    runner: &ProviderRunner,
    spec: &CallSpec,
    item: &Item,
    note: Option<&str>,
) -> Result<Review> {
    let prompt = review_prompt(item, note)?;
    let reply = runner.call_aside(spec, &prompt, TIMEOUT).await?;
    parse_review(&reply.text)
}

/// A card's file with a fix applied.
pub fn apply_fix(source: &str, fix: &Fix) -> String {
    let fixed = workshop_pack::replace_section(source, "Answer", Some(&fix.answer));
    workshop_pack::replace_section(&fixed, "Explanation", fix.explanation.as_deref())
}

/// Fixes the grader has proposed for cards, waiting for the learner to approve them, kept in
/// Workshop's data directory by item.
pub struct Fixes {
    file: std::path::PathBuf,
    lock: std::sync::Mutex<()>,
}

/// A fix waiting for approval.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Proposed {
    pub review: Review,
    /// When it was proposed, in milliseconds since 1970.
    pub at: i64,
}

impl Fixes {
    pub fn new(data_dir: &std::path::Path) -> Self {
        Self {
            file: data_dir.join("card-fixes.json"),
            lock: std::sync::Mutex::new(()),
        }
    }

    pub fn all(&self) -> Result<std::collections::BTreeMap<String, Proposed>> {
        match std::fs::read_to_string(&self.file) {
            Ok(text) => serde_json::from_str(&text)
                .with_context(|| format!("reading {}", self.file.display())),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Default::default()),
            Err(err) => Err(err).with_context(|| format!("reading {}", self.file.display())),
        }
    }

    fn change(
        &self,
        change: impl FnOnce(&mut std::collections::BTreeMap<String, Proposed>),
    ) -> Result<()> {
        let _guard = self
            .lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut all = self.all()?;
        change(&mut all);
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        workshop_common::files::write_atomic(
            &self.file,
            serde_json::to_string_pretty(&all)?.as_bytes(),
        )
    }

    pub fn propose(&self, key: &str, proposed: Proposed) -> Result<()> {
        self.change(|all| {
            all.insert(key.to_owned(), proposed);
        })
    }

    pub fn remove(&self, key: &str) -> Result<()> {
        self.change(|all| {
            all.remove(key);
        })
    }
}

#[cfg(test)]
mod tests {
    use workshop_pack::Pack;

    use super::*;

    #[test]
    fn asks_for_marks_against_the_rubric_and_reads_them() {
        let pack = Pack::sample();
        let types = workshop_pack::error_types::built_in();
        let problem = pack.item("islands").unwrap();
        let prompt = mark_prompt(
            problem,
            Work::Plan,
            Answer::written("Flood fill each island"),
            &types,
        )
        .unwrap();
        assert!(prompt.contains("<work>\nFlood fill each island\n</work>"));
        assert!(prompt.contains("<reference>"));
        assert!(prompt.contains("the learner hasn't seen it"));
        assert!(prompt.contains("- off-by-one: "));
        assert!(!prompt.contains("aloud"));
        assert!(!prompt.contains("clarity"));
        assert!(mark_prompt(problem, Work::Design, Answer::written("x"), &types).is_err());

        let reply = r#"Here it is: ```json
{"score": 0.5, "points": [{"point": "Chooses a method", "met": "partly", "comment": "ok"}],
 "findings": [{"error_type": "missed-edge-case", "detail": "An empty grid"}, {"error_type": "guess", "detail": "?"}],
 "feedback": "Think about empty grids."}
```"#;
        let marked = parse_marked(reply, &types, &Answer::written("x")).unwrap();
        assert_eq!(marked.clarity, None);
        assert_eq!(marked.score, 0.5);
        assert_eq!(marked.points[0].met, Met::Partly);
        assert_eq!(marked.rating(), Rating::Again);
        assert_eq!(
            marked.findings[0].error_type.as_deref(),
            Some("missed-edge-case")
        );
        // A kind that doesn't exist is dropped, not trusted.
        assert_eq!(marked.findings[1].error_type, None);
        let mistakes = marked.mistakes("g1", "sample/islands", 5);
        assert_eq!(mistakes[1].id, "grade-g1-1");
        assert_eq!(mistakes[0].source, MistakeSource::Grader);

        assert!(
            parse_marked(
                "{\"score\": 2, \"points\": [], \"feedback\": \"\"}",
                &types,
                &Answer::written("x")
            )
            .is_err()
        );
        assert!(parse_marked("No idea", &types, &Answer::written("x")).is_err());
    }

    #[test]
    fn marks_a_timed_round_with_how_it_ended() {
        let pack = Pack::sample();
        let types = workshop_pack::error_types::built_in();
        let answer = Answer {
            note: Some("The round ended when its 10 minutes ran out."),
            ..Answer::written("Working:\n1/6")
        };
        for (id, point) in [
            ("two-dice-seven", "- Gets the right answer\n"),
            (
                "islands",
                "- Writes code, or steps close enough to code, that would work\n",
            ),
            (
                "link-shortener",
                "- Says what happens when the store is unavailable\n",
            ),
        ] {
            let prompt = mark_prompt(pack.item(id).unwrap(), Work::Round, answer, &types).unwrap();
            assert!(prompt.contains(point), "{id}");
            assert!(prompt.contains("- Answers the examiner's follow-up questions well\n"));
            assert!(prompt.contains("</work>\n\nThe round ended when its 10 minutes ran out.\n\n"));
        }
        let card = pack.item("binary-heap-costs").unwrap();
        assert!(mark_prompt(card, Work::Round, answer, &types).is_err());
    }

    #[test]
    fn marks_an_answer_to_a_twist_against_what_a_good_one_covers() {
        let pack = Pack::sample();
        let types = workshop_pack::error_types::built_in();
        let problem = pack.item("islands").unwrap();
        let answer = Answer {
            twist: Some((
                "Now the grid streams in a row at a time.",
                "Keep a union-find of the last row's islands.",
            )),
            ..Answer::written("Remember the islands touching the row above")
        };
        let prompt = mark_prompt(problem, Work::Twist, answer, &types).unwrap();
        assert!(prompt.contains("<twist>\nNow the grid streams in a row at a time.\n</twist>"));
        assert!(prompt.contains(
            "Keep a union-find of the last row's islands.\n\nHow the original problem is solved:"
        ));
        assert!(prompt.contains("breadth-first"));
        assert!(prompt.contains("- Says what has to change in the approach for the twist"));
        // A twist's answer can't be marked without the twist.
        let bare = mark_prompt(problem, Work::Twist, Answer::written("x"), &types).unwrap_err();
        assert!(bare.to_string().contains("against the twist"), "{bare}");

        let marked = |score: f64, findings: Vec<Finding>| Marked {
            score,
            points: Vec::new(),
            findings,
            feedback: String::new(),
            clarity: None,
            questioning: None,
            missed: Vec::new(),
        };
        // Answered fully, with nothing wrong, it's easy; otherwise as any other work.
        assert_eq!(marked(1.0, Vec::new()).twist_rating(), Rating::Easy);
        let slip = Finding {
            error_type: None,
            detail: "Forgot an empty row".to_owned(),
        };
        assert_eq!(marked(1.0, vec![slip]).twist_rating(), Rating::Good);
        assert_eq!(marked(0.9, Vec::new()).twist_rating(), Rating::Good);
        assert_eq!(marked(0.7, Vec::new()).twist_rating(), Rating::Hard);
        assert_eq!(marked(0.2, Vec::new()).twist_rating(), Rating::Again);
    }

    #[test]
    fn marks_an_explanation_aloud_for_clarity_too() {
        let pack = Pack::sample();
        let types = workshop_pack::error_types::built_in();
        let problem = pack.item("islands").unwrap();
        let answer = Answer {
            text: "I go through every square and flood each new island",
            spoken: true,
            code: Some(("Python", "print(count(grid))\n")),
            note: None,
            twist: None,
            brief: None,
            part: None,
            changes: None,
        };
        let prompt = mark_prompt(problem, Work::Explanation, answer, &types).unwrap();
        assert!(prompt.contains("explained this aloud"));
        assert!(prompt.contains("<code language=\"Python\">\nprint(count(grid))\n</code>"));
        assert!(prompt.contains("may have seen it since"));
        assert!(prompt.contains("- Says what the solution costs, in time and space\n"));
        assert!(
            prompt.ends_with("\"clarity\": {\"score\": number from 0 to 1, \"feedback\": string}}")
        );
        assert!(!Work::Explanation.is_attempt());
        assert!(Work::Card.is_attempt());
        // Only a coding problem's solution can be explained.
        let card = pack.item("binary-heap-costs").unwrap();
        assert!(mark_prompt(card, Work::Explanation, answer, &types).is_err());

        let marked = r#"{"score": 0.8, "points": [], "feedback": "Good.", "clarity": {"score": 0.6, "feedback": "Say the cost before the details."}}"#;
        let marked = parse_marked(marked, &types, &answer).unwrap();
        assert_eq!(marked.clarity.unwrap().score, 0.6);
        // Explained aloud, it must be marked for clarity.
        let unclear = r#"{"score": 0.8, "points": [], "feedback": "Good."}"#;
        assert!(parse_marked(unclear, &types, &answer).is_err());
        let out_of_range = r#"{"score": 0.8, "points": [], "feedback": "Good.", "clarity": {"score": 7, "feedback": ""}}"#;
        assert!(parse_marked(out_of_range, &types, &answer).is_err());
        // Written, any clarity is ignored rather than shown.
        let written = r#"{"score": 0.8, "points": [], "feedback": "Good.", "clarity": {"score": 0.6, "feedback": "x"}}"#;
        assert_eq!(
            parse_marked(written, &types, &Answer::written("x"))
                .unwrap()
                .clarity,
            None
        );
    }

    #[test]
    fn marks_a_cards_follow_ups_for_depth_and_what_was_said_aloud_for_clarity() {
        let pack = Pack::sample();
        let types = workshop_pack::error_types::built_in();
        let card = pack.item("binary-heap-costs").unwrap();
        let exchange = "Learner: Log n\nTutor: Why?\nLearner (aloud): one path down";
        let answer = Answer {
            spoken: true,
            ..Answer::written(exchange)
        };
        let prompt = mark_prompt(card, Work::FollowUps, answer, &types).unwrap();
        assert!(prompt.contains("- Gives the card's answer, in any words\n"));
        assert!(prompt.contains(&format!(
            "- {}\n- {}\n</rubric>",
            FOLLOWED_UP_POINTS[0], FOLLOWED_UP_POINTS[1]
        )));
        assert!(prompt.contains("<reference>\nAdding and removing take O(log n)"));
        assert!(prompt.contains("the learner hasn't seen it"));
        assert!(prompt.contains(&format!("<work>\n{exchange}\n</work>\n\n{FOLLOWED_UP}")));
        assert!(prompt.contains("usually a concept-gap"));
        // Only what's marked as aloud was, so clarity is judged on that.
        assert!(prompt.contains(&format!("{SPOKEN_IN_PART}{SPOKEN}")));
        assert!(!prompt.contains(SPOKEN_WHOLE));
        assert!(
            prompt.ends_with("\"clarity\": {\"score\": number from 0 to 1, \"feedback\": string}}")
        );
        assert!(Work::FollowUps.is_attempt());
        // Written throughout, it isn't marked for clarity.
        let written =
            mark_prompt(card, Work::FollowUps, Answer::written(exchange), &types).unwrap();
        assert!(!written.contains(SPOKEN) && !written.contains("clarity"));
        // A card answered without follow-ups is marked as before.
        let plain = mark_prompt(card, Work::Card, Answer::written("Log n"), &types).unwrap();
        assert!(!plain.contains(FOLLOWED_UP_POINTS[0]) && !plain.contains(FOLLOWED_UP));
        // Only a card is followed up.
        let problem = pack.item("islands").unwrap();
        assert!(mark_prompt(problem, Work::FollowUps, answer, &types).is_err());
    }

    #[test]
    fn adds_a_packs_add_on_to_a_coachs_instructions() {
        assert_eq!(
            with_add_on("Be fair.\n", Some(" Be kind. ")),
            "Be fair.\n\nThe pack adds:\n\nBe kind."
        );
        assert_eq!(with_add_on("Be fair.\n", Some(" \n")), "Be fair.");
        assert_eq!(with_add_on("Be fair.", None), "Be fair.");
    }

    #[test]
    fn marks_what_was_asked_about_a_design_against_its_brief() {
        let pack = Pack::sample();
        let types = workshop_pack::error_types::built_in();
        let design = pack.item("link-shortener").unwrap();
        let answer = Answer {
            brief: Some("- Links last five years\n- 2 million made a day"),
            ..Answer::written("## Clarify the requirements\n\nLearner: How many are made?")
        };
        for work in [Work::Design, Work::Round] {
            let prompt = mark_prompt(design, work, answer, &types).unwrap();
            assert!(
                prompt
                    .contains("<brief>\n- Links last five years\n- 2 million made a day\n</brief>")
            );
            assert!(prompt.contains("They never saw it"));
            assert!(prompt.contains(
                "- Considers links that expire, or that are made to abuse the service\n"
            ));
            assert!(prompt.contains(&format!(
                "- {}\n- {}\n</rubric>",
                QUESTIONING[0], QUESTIONING[1]
            )));
            assert!(prompt.contains("- missed-requirement: "));
            assert!(prompt.ends_with("\"questioning\": {\"found\": [string], \"missed\": [string], \"assumed\": [string]}}"));
        }
        // Without one, it's marked on the design alone.
        let bare = mark_prompt(design, Work::Design, Answer::written("x"), &types).unwrap();
        assert!(
            !bare.contains("<brief>")
                && !bare.contains(QUESTIONING[0])
                && !bare.contains("questioning")
        );
        // Only a design is marked with a brief.
        let problem = pack.item("islands").unwrap();
        assert!(mark_prompt(problem, Work::Round, answer, &types).is_err());

        let reply = r#"{"score": 0.7, "points": [], "findings": [{"error_type": "wrong-approach", "detail": "Counters in one place"}], "feedback": "Ask about expiry.",
            "questioning": {"found": ["2 million made a day"], "missed": ["How long links last"], "assumed": ["Codes are 6 characters"]}}"#;
        let marked = parse_marked(reply, &types, &answer).unwrap();
        let questioning = marked.questioning.as_ref().unwrap();
        assert_eq!(questioning.assumed, ["Codes are 6 characters"]);
        // A missed requirement is kept as a mistake of its own kind, after the findings.
        let mistakes = marked.mistakes("g2", "sample/link-shortener", 9);
        assert_eq!(mistakes.len(), 2);
        assert_eq!(mistakes[1].id, "grade-g2-1");
        assert_eq!(mistakes[1].detail, "Didn't find out: How long links last");
        assert_eq!(mistakes[1].suggested.as_deref(), Some(MISSED_REQUIREMENT));
        assert!(types.iter().any(|t| t.id == MISSED_REQUIREMENT));
        // With a brief, what was asked must be marked; without one, it's ignored.
        let unasked = r#"{"score": 0.7, "points": [], "feedback": "Fine."}"#;
        assert!(parse_marked(unasked, &types, &answer).is_err());
        let plain = parse_marked(reply, &types, &Answer::written("x")).unwrap();
        assert_eq!(plain.questioning, None);
        assert_eq!(plain.mistakes("g3", "sample/link-shortener", 9).len(), 1);
    }

    #[test]
    fn reviews_cards_and_fixes_them() {
        let pack = Pack::sample();
        let card = pack.item("binary-heap-costs").unwrap();
        let prompt = review_prompt(card, Some("It's O(1)")).unwrap();
        assert!(prompt.contains("saying: It's O(1)"));
        assert!(review_prompt(pack.item("islands").unwrap(), None).is_err());

        let correct = parse_review(r#"{"verdict": "correct", "explanation": "It's right.", "fix": {"answer": "x", "explanation": null}}"#).unwrap();
        assert_eq!(correct.fix, None);
        assert!(parse_review(r#"{"verdict": "wrong", "explanation": "e", "fix": null}"#).is_err());
        let wrong = parse_review(r#"{"verdict": "wrong", "explanation": "e", "fix": {"answer": "O(log n).", "explanation": null}}"#).unwrap();
        let source = "+++\nkind = \"card\"\nskills = [\"a\"]\n+++\nQ\n\n## Answer\n\nO(1).\n\n## Explanation\n\nWrong.\n";
        assert_eq!(
            apply_fix(source, wrong.fix.as_ref().unwrap()),
            "+++\nkind = \"card\"\nskills = [\"a\"]\n+++\nQ\n\n## Answer\n\nO(log n).\n"
        );
    }

    #[test]
    fn marks_a_review_against_the_defects_planted_in_the_change() {
        let pack = Pack::sample();
        let types = workshop_pack::error_types::built_in();
        let item = pack.item("loan-renewals").unwrap();
        let Content::Review(review) = &item.content else {
            panic!("not a review");
        };
        let comments = "- On loans.py, line 47: allows a third renewal\n";
        let prompt = mark_prompt(item, Work::Review, Answer::written(comments), &types).unwrap();
        // Each defect is a point, with where it is, and the grader sees the change.
        assert!(
            prompt.contains("- [D1] Finds that The renewal limit is off by one"),
            "{prompt}"
        );
        assert!(prompt.contains("(loans.py:47)"), "{prompt}");
        assert!(
            prompt.contains("<change>\n--- a/loans.py\n+++ b/loans.py\n"),
            "{prompt}"
        );
        assert!(prompt.contains("<file path=\"catalogue.py\">"), "{prompt}");
        assert!(prompt.contains("Each finding is a false alarm"), "{prompt}");
        assert!(
            prompt.contains(&format!("<work>\n{}\n</work>", comments.trim())),
            "{prompt}"
        );
        assert!(
            prompt.contains("isn't one of the planted defects"),
            "{prompt}"
        );
        assert!(Work::Review.is_attempt());

        // Given back in another order, they're matched by their ids.
        let reply = r#"{"score": 1, "points": [{"point": "[D3] c", "met": "no"}, {"point": "[D1] a", "met": "yes"}, {"point": "[D2] b", "met": "partly"}], "findings": [], "feedback": "Good start."}"#;
        let marked = parse_marked(reply, &types, &Answer::written(comments)).unwrap();
        // Scored from what it found, whatever the grader said.
        let scored = score_review(marked.clone(), review).unwrap();
        assert!((scored.score - 0.5).abs() < 1e-9);
        assert_eq!(scored.missed.len(), 1);
        assert!(
            scored.missed[0].contains("reservations"),
            "{:?}",
            scored.missed
        );
        assert!(
            scored.missed[0].ends_with("(loans.py:44-53)"),
            "{:?}",
            scored.missed
        );
        let mistakes = scored.mistakes("attempt", "sample/loan-renewals", 1);
        assert_eq!(mistakes.len(), 1);
        assert_eq!(mistakes[0].suggested.as_deref(), Some(MISSED_DEFECT));
        assert!(mistakes[0].detail.starts_with("Missed in a review:"));
        // Each false alarm takes a little off, and is a mistake of its own.
        let alarmed = Marked {
            findings: vec![Finding {
                error_type: Some("misread".to_owned()),
                detail: "Thinks renew skips the borrower check".to_owned(),
            }],
            ..marked.clone()
        };
        let scored = score_review(alarmed, review).unwrap();
        assert!((scored.score - 0.4).abs() < 1e-9);
        assert_eq!(
            scored.mistakes("attempt", "sample/loan-renewals", 1).len(),
            2
        );
        assert_eq!(
            score_review(marked.clone(), review).unwrap().points[0].point,
            "[D1] a"
        );
        // Every defect must be marked, once, and nothing else.
        let point = |text: &str| Point {
            point: text.to_owned(),
            met: Met::Yes,
            comment: String::new(),
        };
        for (points, says) in [
            (vec![point("[D1] a"), point("[D2] b")], "didn't mark [D3]"),
            (
                vec![point("[D1] a"), point("[D1] b"), point("[D3] c")],
                "marked [D1] twice",
            ),
            (
                vec![point("[D1] a"), point("b"), point("[D3] c")],
                "isn't one of the defects",
            ),
        ] {
            let wrong = Marked {
                points,
                ..marked.clone()
            };
            let err = score_review(wrong, review).unwrap_err();
            assert!(err.to_string().contains(says), "{err}");
        }
    }

    #[test]
    fn marks_work_in_a_project_knowing_the_project() {
        let pack = Pack::sample();
        let types = workshop_pack::error_types::built_in();
        let fix = pack.item("word-counts").unwrap();
        let prompt =
            mark_prompt(fix, Work::Plan, Answer::written("It's split_words"), &types).unwrap();
        assert!(
            prompt.contains("- Says why it happens: the cause, not only the symptom"),
            "{prompt}"
        );
        assert!(prompt.contains("<file path=\"words.py\">"), "{prompt}");
        assert!(prompt.contains("<file path=\"test_stats.py\">"), "{prompt}");
        // The hidden tests are the problem's, not the learner's to see.
        assert!(!prompt.contains("test_punctuation"), "{prompt}");
        let answer = Answer {
            changes: Some("--- a/words.py\n+++ b/words.py\n"),
            ..Answer::written("Empty words were counted")
        };
        let prompt = mark_prompt(fix, Work::Explanation, answer, &types).unwrap();
        assert!(prompt.contains("<changes>\n--- a/words.py"), "{prompt}");
        assert!(
            prompt.contains("- Says what the bug was, and why it gave the symptom"),
            "{prompt}"
        );

        let refactor = pack.item("habit-streaks").unwrap();
        let answer = Answer {
            part: Some(0),
            ..Answer::written("Pass in the clock")
        };
        let prompt = mark_prompt(refactor, Work::Plan, answer, &types).unwrap();
        assert!(
            prompt.contains("- Says what makes the code hard to test"),
            "{prompt}"
        );
        // Only the tests of the parts reached.
        assert!(
            prompt.contains("<file path=\"test_tracker_clock.py\">"),
            "{prompt}"
        );
        assert!(!prompt.contains("test_longest"), "{prompt}");
    }
}
