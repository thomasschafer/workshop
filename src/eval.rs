//! Checks the edit model against a file of example utterances, so changes to the edit prompt or a
//! language's dictation hints can be compared. Every case is a real model call, so this is run
//! by hand rather than in CI.

use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::Deserialize;

use crate::config::Config;
use crate::edit::{self, CURSOR, EditOutcome};
use crate::models::ModelChoice;
use crate::paths::Paths;
use crate::provider::{CallSpec, ProviderRunner, Role};
use crate::settings::AppSettings;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EvalFile {
    /// The language profile whose dictation hints the cases use.
    language: String,
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
    /// Questions the model asked, which this utterance replies to.
    #[serde(default)]
    earlier: Vec<edit::Exchange>,
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

/// Runs the cases in `path`, a file or a directory of files, returning whether all passed.
pub async fn run(
    config: &Config,
    paths: &Paths,
    path: &Path,
    filter: Option<&str>,
    model: Option<ModelChoice>,
) -> Result<bool> {
    let files = eval_files(path)?;
    let mut suites = Vec::new();
    for file in &files {
        let source =
            std::fs::read_to_string(file).with_context(|| format!("reading {}", file.display()))?;
        let suite: EvalFile =
            toml::from_str(&source).with_context(|| format!("parsing {}", file.display()))?;
        let profile = config.languages.get(&suite.language).with_context(|| {
            format!(
                "{} is for {:?}, which has no language profile",
                file.display(),
                suite.language
            )
        })?;
        for case in &suite.case {
            case.validate()
                .with_context(|| format!("in case {:?} in {}", case.name, file.display()))?;
        }
        suites.push((suite.case, profile));
    }

    let choice = match model {
        Some(choice) => choice,
        None => AppSettings::load(config, paths).models.edit,
    };
    let provider = config
        .providers
        .get(&choice.provider)
        .with_context(|| format!("there's no provider called {:?}", choice.provider))?;
    let runner = ProviderRunner::new(provider.clone(), paths.cache_dir.join("model-cwd"))?;
    println!(
        "Using {} through {}.",
        choice.model,
        provider.display_name(&choice.provider)
    );

    let mut totals = Totals::default();
    for (cases, profile) in &suites {
        let cases: Vec<&Case> = cases
            .iter()
            .filter(|c| filter.is_none_or(|f| c.name.contains(f)))
            .collect();
        if cases.is_empty() {
            continue;
        }
        println!("\n{}:", profile.name);
        let spec = provider.spec(Role::Edit, &choice.model, edit::system_prompt(profile));
        runner.warm(&spec).await?;
        for case in cases {
            run_case(&runner, &spec, case, &mut totals).await;
        }
    }
    if totals.cases == 0 {
        bail!("no cases match");
    }
    println!(
        "\n{} passed, {} with the cursor elsewhere, {} failed, of {}; {} needed a retry. Average {:.1}s per edit.",
        totals.passed,
        totals.cursor,
        totals.failed,
        totals.cases,
        totals.retries,
        totals.ms as f64 / 1000.0 / totals.cases as f64
    );
    Ok(totals.failed == 0)
}

#[derive(Default)]
struct Totals {
    cases: usize,
    passed: usize,
    cursor: usize,
    failed: usize,
    retries: usize,
    ms: u64,
}

fn eval_files(path: &Path) -> Result<Vec<std::path::PathBuf>> {
    if !path.is_dir() {
        return Ok(vec![path.to_owned()]);
    }
    let mut files: Vec<_> = std::fs::read_dir(path)
        .with_context(|| format!("reading {}", path.display()))?
        .map(|entry| entry.map(|e| e.path()))
        .collect::<std::io::Result<_>>()?;
    files.retain(|f| f.extension().is_some_and(|e| e == "toml"));
    files.sort();
    if files.is_empty() {
        bail!("{} has no eval files", path.display());
    }
    Ok(files)
}

async fn run_case(runner: &ProviderRunner, spec: &CallSpec, case: &Case, totals: &mut Totals) {
    let prompt = edit::user_prompt(
        &case.before,
        &case.utterance,
        case.recent.as_deref(),
        &case.earlier,
    );
    let (outcome, elapsed_ms, retried) =
        match edit::request(runner, spec, &case.before, &prompt, Duration::from_secs(60)).await {
            Ok(response) => (
                Ok(response.outcome),
                response.elapsed_ms,
                response.replies.len() > 1,
            ),
            Err(failed) => (
                Err(anyhow::anyhow!(
                    "{}\nreplies:\n{}",
                    failed.message,
                    failed.replies.join("\n")
                )),
                0,
                true,
            ),
        };
    totals.cases += 1;
    totals.retries += usize::from(retried);
    totals.ms += elapsed_ms;
    let seconds = elapsed_ms as f64 / 1000.0;
    match case.judge(&outcome) {
        Verdict::Pass => {
            totals.passed += 1;
            println!("✓ {} ({seconds:.1}s)", case.name);
        }
        Verdict::CursorElsewhere => {
            totals.cursor += 1;
            println!(
                "~ {} ({seconds:.1}s): right text, cursor elsewhere",
                case.name
            );
            if let Ok(EditOutcome::Applied { doc, .. }) = &outcome {
                println!("{}", indent(doc));
            }
        }
        Verdict::Fail(detail) => {
            totals.failed += 1;
            println!("✗ {} ({seconds:.1}s): {:?}", case.name, case.utterance);
            println!("{}", indent(&detail));
        }
    }
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
            earlier: Vec::new(),
            after: after.map(str::to_owned),
            also: vec!["x = ‸y".into()],
            unsure,
        }
    }

    fn applied(doc: &str) -> Result<EditOutcome> {
        Ok(EditOutcome::Applied {
            doc: doc.into(),
            summary: String::new(),
            inserted: String::new(),
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
        for (language, source) in [
            ("haskell", include_str!("../evals/haskell.toml")),
            ("python", include_str!("../evals/python.toml")),
        ] {
            check_bundled(language, source);
        }
    }

    fn check_bundled(language: &str, source: &str) {
        let file: EvalFile = toml::from_str(source).unwrap();
        assert_eq!(file.language, language);
        assert!(file.case.len() >= 10);
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
