//! Labs: hands-on exercises the learner carries out on a machine of their own, such as a Linux
//! virtual machine, following steps from Workshop and recording what they ran and saw, which the
//! grader marks against what each step should show. Workshop never runs anything for a lab, so
//! `workshop pack check` checks only its form.
//!
//! A lab's prompt says what it's about, then come `## Setup`, one to eight steps, each a `## `
//! section ending in `### Expected`, and `## Explain` with its `## Explain answer`.

use serde::Deserialize;

use crate::lesson::{LessonSource, RawSource, markdown_images, read_sources};
use crate::manifest::is_slug;

/// The fewest and most steps a lab may have.
pub const STEPS: std::ops::RangeInclusive<usize> = 1..=8;

/// The heading, within a step, of what a right observation shows.
const EXPECTED: &str = "### Expected";

/// A lab item's parsed content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lab {
    /// The id of a lesson in the pack to do first, if it says.
    pub lesson: Option<String>,
    /// Where the lab's facts come from, shown as further reading.
    pub sources: Vec<LessonSource>,
    /// What the learner needs before the first step, in Markdown.
    pub setup: String,
    /// The steps, in order (1 to 8).
    pub steps: Vec<LabStep>,
    /// The question asked at the end, in the learner's own words (`## Explain`).
    pub explain: String,
    /// What a good answer covers (`## Explain answer`).
    pub explain_answer: String,
}

/// One step of a lab: what to do, and what doing it should show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LabStep {
    pub title: String,
    /// What to do and what to record, in Markdown, with commands in code blocks.
    pub body: String,
    /// What a right observation shows and why (`### Expected`), for the grader, and shown to the
    /// learner once it's marked.
    pub expected: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LabFields {
    #[serde(default)]
    sources: Vec<RawSource>,
}

impl Lab {
    /// A lab from its front matter's fields, the `lesson` it names in its common fields, and its
    /// `## ` sections in order.
    pub(crate) fn new(
        fields: LabFields,
        lesson: Option<String>,
        prompt: &str,
        sections: Vec<(String, String)>,
    ) -> Result<Self, String> {
        if let Some(lesson) = &lesson
            && !is_slug(lesson)
        {
            return Err(format!(
                "lesson {lesson:?} should be lowercase letters and digits, in words joined by hyphens"
            ));
        }
        let sources = read_sources(fields.sources, "a lab")?;
        let mut sections = sections.into_iter();
        let setup = match sections.next() {
            Some((heading, text)) if heading == "Setup" => text,
            Some((heading, _)) => {
                return Err(format!(
                    "a lab starts with a `## Setup` section, after its prompt, not {heading:?}"
                ));
            }
            None => return Err("a lab needs a `## Setup` section".to_owned()),
        };
        if setup.is_empty() {
            return Err("the `## Setup` section is empty".to_owned());
        }
        if expected_at(&setup).is_some() {
            return Err(format!(
                "the `## Setup` section can't have an `{EXPECTED}`: only steps have one"
            ));
        }
        let mut steps = Vec::new();
        let mut explain: Option<String> = None;
        let mut explain_answer: Option<String> = None;
        for (heading, text) in sections {
            match heading.as_str() {
                "Explain" => explain = Some(text),
                "Explain answer" => explain_answer = Some(text),
                _ if explain.is_some() || explain_answer.is_some() => {
                    return Err(format!(
                        "the step {heading:?} comes after `## Explain`; steps go between `## Setup` and `## Explain`"
                    ));
                }
                _ => steps.push(step(steps.len() + 1, heading, &text)?),
            }
        }
        let explain = explain
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "a lab needs a `## Explain` section".to_owned())?;
        let explain_answer = explain_answer
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "a lab needs a `## Explain answer` section".to_owned())?;
        if steps.is_empty() {
            return Err(
                "a lab needs at least one step: a `## ` section between `## Setup` and `## Explain`"
                    .to_owned(),
            );
        }
        if steps.len() > *STEPS.end() {
            return Err(format!(
                "a lab can have at most {} steps, and this one has {}",
                STEPS.end(),
                steps.len()
            ));
        }
        let texts = [
            ("the prompt".to_owned(), prompt),
            ("`## Setup`".to_owned(), setup.as_str()),
            ("`## Explain`".to_owned(), explain.as_str()),
            ("`## Explain answer`".to_owned(), explain_answer.as_str()),
        ];
        let step_texts = steps.iter().enumerate().flat_map(|(i, step)| {
            [
                (
                    format!("step {} ({:?})", i + 1, step.title),
                    step.body.as_str(),
                ),
                (
                    format!("step {}'s `{EXPECTED}`", i + 1),
                    step.expected.as_str(),
                ),
            ]
        });
        // Labs are worked through on the server, with nothing kept beside them to show.
        if let Some((where_in, _)) = texts
            .into_iter()
            .chain(step_texts)
            .find(|(_, text)| !markdown_images(text).is_empty())
        {
            return Err(format!("a lab can't include images, as {where_in} does"));
        }
        Ok(Self {
            lesson,
            sources,
            setup,
            steps,
            explain,
            explain_answer,
        })
    }

    /// What the lab holds, for `workshop pack check`, which can't carry it out.
    pub fn summary(&self) -> String {
        let steps = self.steps.len();
        let lesson = self
            .lesson
            .as_deref()
            .map_or_else(String::new, |lesson| format!(", after the lesson {lesson}"));
        format!(
            "a lab of {steps} {}{lesson}: checked for form only, as it's carried out on the learner's own machine",
            if steps == 1 { "step" } else { "steps" }
        )
    }
}

/// A step from its section, split at its `### Expected`.
fn step(n: usize, title: String, text: &str) -> Result<LabStep, String> {
    let Some((at, end)) = expected_at(text) else {
        return Err(format!(
            "step {n} ({title:?}) needs an `{EXPECTED}` heading, saying what it should show"
        ));
    };
    let body = text[..at].trim().to_owned();
    let expected = text[end..].trim().to_owned();
    if expected_at(&text[end..]).is_some() {
        return Err(format!(
            "step {n} ({title:?}) has more than one `{EXPECTED}`"
        ));
    }
    if body.is_empty() {
        return Err(format!(
            "step {n} ({title:?}) says nothing to do before its `{EXPECTED}`"
        ));
    }
    if expected.is_empty() {
        return Err(format!("step {n} ({title:?}) has an empty `{EXPECTED}`"));
    }
    Ok(LabStep {
        title,
        body,
        expected,
    })
}

/// Where the first `### Expected` heading outside fenced code is in some text: the byte offsets
/// of its line's start and end.
fn expected_at(text: &str) -> Option<(usize, usize)> {
    let mut in_fence: Option<char> = None;
    let mut at = 0;
    for line in text.split_inclusive('\n') {
        let start = at;
        at += line.len();
        let trimmed = line.trim_start();
        if let Some(ch) = in_fence {
            if (ch == '`' && trimmed.starts_with("```"))
                || (ch == '~' && trimmed.starts_with("~~~"))
            {
                in_fence = None;
            }
            continue;
        }
        if trimmed.starts_with("```") {
            in_fence = Some('`');
        } else if trimmed.starts_with("~~~") {
            in_fence = Some('~');
        } else if line.trim_end() == EXPECTED {
            return Some((start, at));
        }
    }
    None
}
