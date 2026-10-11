//! Checks the edit model against a file of example utterances, so changes to the edit prompt or a
//! language's dictation hints can be compared. Every case is a real model call, so this is run
//! by hand rather than in CI.

use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::Deserialize;

use crate::config::Config;
use crate::edit::{self, CURSOR, EditOutcome};
use crate::provider::{CallSpec, ProviderRunner};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EvalFile {
    case: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    name: String,
    utterance: String,
    /// The file before the edit, with `‸` marking the cursor.
    before: String,
    /// The most recent insertion, which "that" refers to.
    #[serde(default)]
    recent: Option<String>,
    /// The expected file after the edit, with `‸` marking where the cursor should end up.
    #[serde(default)]
    after: Option<String>,
    /// Other results that are equally good.
    #[serde(default)]
    also: Vec<String>,
    /// The model should make no edit, because the request is ambiguous or asks it to write logic.
    #[serde(default)]
    unsure: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    Pass,
    /// The text is right but the cursor ended up elsewhere.
    CursorElsewhere,
    Fail(String),
}

impl Case {
    fn validate(&self) -> Result<()> {
        if self.before.matches(CURSOR).count() != 1 {
            bail!("`before` needs exactly one {CURSOR}");
        }
        match (&self.after, self.unsure) {
            (Some(_), true) => bail!("give either `after` or `unsure`, not both"),
            (None, false) => bail!("give `after`, or `unsure = true`"),
            _ => {}
        }
        for after in self.after.iter().chain(&self.also) {
            if after.matches(CURSOR).count() != 1 {
                bail!("expected results need exactly one {CURSOR}");
            }
        }
        Ok(())
    }

    fn judge(&self, outcome: &Result<EditOutcome>) -> Verdict {
        match (outcome, &self.after) {
            (Err(err), _) => Verdict::Fail(format!("error: {err:#}")),
            (Ok(EditOutcome::Unsure { .. }), None) => Verdict::Pass,
            (Ok(EditOutcome::Applied { doc, .. }), None) => {
                Verdict::Fail(format!("edited when it should have asked:\n{doc}"))
            }
            (Ok(EditOutcome::Unsure { message }), Some(_)) => {
                Verdict::Fail(format!("unsure: {message}"))
            }
            (Ok(EditOutcome::Applied { doc, .. }), Some(after)) => {
                let expected: Vec<&String> = std::iter::once(after).chain(&self.also).collect();
                if expected.iter().any(|e| normalise(e) == normalise(doc)) {
                    Verdict::Pass
                } else if expected.iter().any(|e| {
                    normalise(&e.replace(CURSOR, "")) == normalise(&doc.replace(CURSOR, ""))
                }) {
                    Verdict::CursorElsewhere
                } else {
                    Verdict::Fail(format!("got:\n{doc}"))
                }
            }
        }
    }
}

/// Trailing spaces and a final newline aren't significant.
fn normalise(text: &str) -> String {
    text.trim_end()
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
}

pub async fn run(
    config: &Config,
    cache_dir: &Path,
    path: &Path,
    filter: Option<&str>,
) -> Result<bool> {
    let source =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let file: EvalFile =
        toml::from_str(&source).with_context(|| format!("parsing {}", path.display()))?;
    for case in &file.case {
        case.validate()
            .with_context(|| format!("in case {:?}", case.name))?;
    }
    let cases: Vec<&Case> = file
        .case
        .iter()
        .filter(|c| filter.is_none_or(|f| c.name.contains(f)))
        .collect();
    if cases.is_empty() {
        bail!("no cases match");
    }

    let provider = config.providers[&config.models.edit.provider].clone();
    let runner = ProviderRunner::new(provider, cache_dir.join("model-cwd"))?;
    let spec = CallSpec {
        model: config.models.edit.model.clone(),
        system_prompt: edit::system_prompt(config.language()),
    };
    runner.warm(&spec).await?;

    let (mut passed, mut cursor, mut failed) = (0, 0, 0);
    let mut total_ms = 0;
    for case in &cases {
        let prompt = edit::user_prompt(&case.before, &case.utterance, case.recent.as_deref());
        let (outcome, elapsed_ms) = match runner.call(&spec, &prompt, Duration::from_secs(60)).await
        {
            Ok(reply) => (
                edit::parse_reply(&reply.text).and_then(|r| edit::apply(&case.before, r)),
                reply.elapsed_ms,
            ),
            Err(err) => (Err(err), 0),
        };
        total_ms += elapsed_ms;
        let seconds = elapsed_ms as f64 / 1000.0;
        match case.judge(&outcome) {
            Verdict::Pass => {
                passed += 1;
                println!("✓ {} ({seconds:.1}s)", case.name);
            }
            Verdict::CursorElsewhere => {
                cursor += 1;
                println!(
                    "~ {} ({seconds:.1}s): right text, cursor elsewhere",
                    case.name
                );
                if let Ok(EditOutcome::Applied { doc, .. }) = &outcome {
                    println!("{}", indent(doc));
                }
            }
            Verdict::Fail(detail) => {
                failed += 1;
                println!("✗ {} ({seconds:.1}s): {:?}", case.name, case.utterance);
                println!("{}", indent(&detail));
            }
        }
    }
    println!(
        "\n{passed} passed, {cursor} with the cursor elsewhere, {failed} failed, of {}. Average {:.1}s per edit.",
        cases.len(),
        total_ms as f64 / 1000.0 / cases.len() as f64
    );
    Ok(failed == 0)
}

fn indent(text: &str) -> String {
    text.lines()
        .map(|l| format!("    {l}"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn case(after: Option<&str>, unsure: bool) -> Case {
        Case {
            name: "c".into(),
            utterance: "u".into(),
            before: "a‸".into(),
            recent: None,
            after: after.map(str::to_owned),
            also: vec!["x = ‸y".into()],
            unsure,
        }
    }

    fn applied(doc: &str) -> Result<EditOutcome> {
        Ok(EditOutcome::Applied {
            doc: doc.into(),
            summary: String::new(),
        })
    }

    #[test]
    fn judges_outcomes() {
        let c = case(Some("x = y‸"), false);
        assert_eq!(c.judge(&applied("x = y‸  \n")), Verdict::Pass);
        assert_eq!(c.judge(&applied("x = ‸y")), Verdict::Pass);
        assert_eq!(c.judge(&applied("x =‸ y")), Verdict::CursorElsewhere);
        assert!(matches!(c.judge(&applied("x = z‸")), Verdict::Fail(_)));
        let unsure = Ok(EditOutcome::Unsure {
            message: "?".into(),
        });
        assert!(matches!(c.judge(&unsure), Verdict::Fail(_)));
        let c = case(None, true);
        assert_eq!(c.judge(&unsure), Verdict::Pass);
        assert!(matches!(c.judge(&applied("x‸")), Verdict::Fail(_)));
    }

    #[test]
    fn validates_cases() {
        assert!(case(Some("x‸"), false).validate().is_ok());
        assert!(case(Some("x‸"), true).validate().is_err());
        assert!(case(None, false).validate().is_err());
        assert!(case(Some("no cursor"), false).validate().is_err());
    }

    #[test]
    fn bundled_cases_are_valid() {
        let source = include_str!("../evals/edits.toml");
        let file: EvalFile = toml::from_str(source).unwrap();
        assert!(file.case.len() >= 20);
        let mut names = std::collections::HashSet::new();
        for case in &file.case {
            case.validate()
                .unwrap_or_else(|e| panic!("{}: {e}", case.name));
            assert!(
                names.insert(&case.name),
                "duplicate case name {}",
                case.name
            );
        }
    }
}
