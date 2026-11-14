//! The grader: a coach that marks written work against a rubric, such as an answer to a design
//! prompt, a coding problem's plan or a card answered in the learner's own words, and checks
//! cards for mistakes. It's a model with no tools, through the provider layer, as the tutor is.
//!
//! Its marks feed the mistake log, with each finding tagged with a kind of mistake, and mastery,
//! as an attempt rated from the score. A card it finds wrong gets a proposed fix, which the
//! learner approves before it changes the pack.

use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use workshop_learning::{MistakeSource, NewMistake, Rating};
use workshop_pack::{Content, ErrorType, Item};
use workshop_provider::{CallSpec, ProviderRunner};

pub const TIMEOUT: Duration = Duration::from_secs(180);

/// The grader's instructions, with a pack's add-on if it has one.
pub fn system_prompt(add_on: Option<&str>) -> String {
    let base = include_str!("../prompts/grader.md").trim_end();
    match add_on {
        Some(add_on) if !add_on.trim().is_empty() => {
            format!("{base}\n\nThe pack adds:\n\n{}", add_on.trim())
        }
        _ => base.to_owned(),
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
}

/// The rubric for a piece of work on an item, and what a good answer looks like, if the item
/// has one. Fails for work the item can't have.
fn rubric(item: &Item, work: Work) -> Result<(Vec<String>, Option<String>)> {
    match (work, &item.content) {
        (Work::Design, Content::Design { rubric, notes }) => Ok((rubric.clone(), notes.clone())),
        (Work::Plan, Content::Coding(coding)) => Ok((
            vec![
                "Chooses a method that solves the problem correctly".to_owned(),
                "Is efficient enough for the sizes of input the problem allows".to_owned(),
                "Says how the unusual inputs are handled".to_owned(),
            ],
            Some(coding.approach.clone()),
        )),
        (
            Work::Card,
            Content::Card {
                answer,
                explanation,
            },
        ) => Ok((
            vec![
                "Gives the card's answer, in any words".to_owned(),
                "Says nothing that contradicts the card".to_owned(),
            ],
            Some(match explanation {
                Some(explanation) => format!("{answer}\n\n{explanation}"),
                None => answer.clone(),
            }),
        )),
        _ => bail!("{} can't be marked as that kind of work", item.label()),
    }
}

/// The grader's prompt for marking work.
pub fn mark_prompt(
    item: &Item,
    work: Work,
    text: &str,
    error_types: &[ErrorType],
) -> Result<String> {
    let (rubric, reference) = rubric(item, work)?;
    let mut out = format!(
        "<question>\n{}\n</question>\n\n<rubric>\n",
        item.prompt.trim()
    );
    for point in &rubric {
        out.push_str(&format!("- {point}\n"));
    }
    out.push_str("</rubric>\n\n");
    if let Some(reference) = reference {
        out.push_str(&format!(
            "<reference>\n{}\n</reference>\n\nThe reference is how it's meant to be answered, for you to mark against; the learner hasn't seen it.\n\n",
            reference.trim()
        ));
    }
    out.push_str(&format!("<work>\n{}\n</work>\n\n", text.trim()));
    out.push_str(&kinds(error_types));
    out.push_str(
        "Mark the work. Reply with JSON: {\"score\": number from 0 to 1, \"points\": [{\"point\": the rubric point, \"met\": \"yes\" | \"partly\" | \"no\", \"comment\": string}], \"findings\": [{\"error_type\": one of the kinds' ids, \"detail\": string}], \"feedback\": string}",
    );
    Ok(out)
}

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

    /// The mistakes the grader found, for the mistake log, with ids made from the grading's.
    pub fn mistakes(&self, id: &str, item: &str, at: i64) -> Vec<NewMistake> {
        self.findings
            .iter()
            .enumerate()
            .map(|(n, finding)| NewMistake {
                id: format!("grade-{id}-{n}"),
                item: item.to_owned(),
                at,
                source: MistakeSource::Grader,
                attempt: None,
                detail: finding.detail.clone(),
                suggested: finding.error_type.clone(),
            })
            .collect()
    }
}

/// The JSON object in a model's reply, which may be wrapped in a fenced code block.
fn json_in(reply: &str) -> Result<&str> {
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
/// exist rather than trusting them.
pub fn parse_marked(reply: &str, error_types: &[ErrorType]) -> Result<Marked> {
    #[derive(Deserialize)]
    struct Raw {
        score: f64,
        points: Vec<Point>,
        #[serde(default)]
        findings: Vec<RawFinding>,
        feedback: String,
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
    })
}

/// Marks a piece of work with the grader.
pub async fn mark(
    runner: &ProviderRunner,
    spec: &CallSpec,
    item: &Item,
    work: Work,
    text: &str,
    error_types: &[ErrorType],
) -> Result<Marked> {
    if text.trim().is_empty() {
        bail!("there's nothing written to mark");
    }
    let prompt = mark_prompt(item, work, text, error_types)?;
    let reply = runner.call_aside(spec, &prompt, TIMEOUT).await?;
    parse_marked(&reply.text, error_types)
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
        let prompt = mark_prompt(problem, Work::Plan, "Flood fill each island", &types).unwrap();
        assert!(prompt.contains("<work>\nFlood fill each island\n</work>"));
        assert!(prompt.contains("<reference>"));
        assert!(prompt.contains("- off-by-one: "));
        assert!(mark_prompt(problem, Work::Design, "x", &types).is_err());

        let reply = r#"Here it is: ```json
{"score": 0.5, "points": [{"point": "Chooses a method", "met": "partly", "comment": "ok"}],
 "findings": [{"error_type": "missed-edge-case", "detail": "An empty grid"}, {"error_type": "guess", "detail": "?"}],
 "feedback": "Think about empty grids."}
```"#;
        let marked = parse_marked(reply, &types).unwrap();
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
            parse_marked("{\"score\": 2, \"points\": [], \"feedback\": \"\"}", &types).is_err()
        );
        assert!(parse_marked("No idea", &types).is_err());
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
}
