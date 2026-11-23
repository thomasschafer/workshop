//! Running solutions, and reading their answers from what they print.

use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Serialize;
use tokio_util::sync::CancellationToken;
use workshop_common::template::Vars;
use workshop_runner::{Ending, Job, Phase};

use crate::language::{LanguageProfile, Puzzle};

#[derive(Debug, Clone, Serialize)]
pub struct RunResult {
    /// The phase that produced this result: a failed build stops before running.
    pub phase: Phase,
    pub ending: Ending,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    /// Non-empty stdout lines, read as answers by `answer`; line N is the answer to part N.
    pub answers: Vec<String>,
    /// Answers that are probably wrong as printed, such as a decimal, to point out with them.
    pub warnings: Vec<String>,
}

#[cfg(test)]
impl RunResult {
    pub fn succeeded(&self) -> bool {
        self.phase == Phase::Run && self.ending == Ending::Exited { code: Some(0) }
    }
}

pub struct RunRequest<'a> {
    pub profile: &'a LanguageProfile,
    pub file: &'a Path,
    pub build_dir: &'a Path,
    pub puzzle: Puzzle,
    pub input: &'a str,
    pub timeout: Duration,
    pub cancel: &'a CancellationToken,
    /// Extra environment variables, such as where installed packages are.
    pub environment: &'a [(String, String)],
    /// The directory of the user's shared helpers, for the `{helpers}` placeholder.
    pub helpers: Option<&'a Path>,
}

pub async fn run(request: RunRequest<'_>) -> Result<RunResult> {
    std::fs::create_dir_all(request.build_dir)
        .with_context(|| format!("creating {}", request.build_dir.display()))?;
    let dir = request
        .file
        .parent()
        .context("solution file has no parent directory")?;
    let mut vars = Vars::new()
        .set("file", request.file.to_string_lossy())
        .set("dir", dir.to_string_lossy())
        .set("build_dir", request.build_dir.to_string_lossy())
        .set("year", request.puzzle.year_label())
        .set("day", request.puzzle.day.to_string());
    if let Some(helpers) = request.helpers {
        vars = vars.set("helpers", helpers.to_string_lossy());
    }
    let outcome = workshop_runner::build_and_run(Job {
        build: request.profile.build.as_deref(),
        run: &request.profile.run,
        vars: &vars,
        dir,
        input: request.input,
        timeout: request.timeout,
        cancel: request.cancel,
        environment: request.environment,
    })
    .await?;
    let answers = match outcome.phase {
        Phase::Build => Vec::new(),
        Phase::Run => parse_answers(&outcome.stdout),
    };
    let warnings = answer_warnings(&answers);
    Ok(RunResult {
        phase: outcome.phase,
        ending: outcome.ending,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        duration_ms: outcome.duration_ms,
        answers,
        warnings,
    })
}

pub fn parse_answers(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| answer(l).to_owned())
        .collect()
}

pub fn answer_warnings(answers: &[String]) -> Vec<String> {
    answers
        .iter()
        .take(2)
        .enumerate()
        .filter(|(_, a)| looks_like_a_decimal(a))
        .map(|(i, a)| {
            format!(
                "Part {}'s answer, {a}, looks like a decimal, but Advent of Code's answers are \
                 whole numbers. Is a division or a float type giving it?",
                i + 1
            )
        })
        .collect()
}

/// The answer a line of output gives. Advent of Code's answers are letters, digits and the odd
/// comma, so how a language prints a value can be read past: a string in double quotes, as
/// Haskell's `print` writes one, is the text inside, and digits ending in `n`, as JavaScript
/// writes a BigInt, are the number.
fn answer(line: &str) -> &str {
    if let Some(inner) = line
        .strip_prefix('"')
        .and_then(|l| l.strip_suffix('"'))
        .filter(|inner| !inner.is_empty() && !inner.contains('"'))
    {
        return inner;
    }
    match line.strip_suffix('n') {
        Some(number) if is_integer(number) => number,
        _ => line,
    }
}

fn is_integer(text: &str) -> bool {
    let digits = text.strip_prefix('-').unwrap_or(text);
    !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())
}

/// Whether an answer is a number written as a decimal or in exponent form, such as `3.0` or
/// `1e+21`, which no answer is but a float prints as.
fn looks_like_a_decimal(answer: &str) -> bool {
    let unsigned = answer.strip_prefix('-').unwrap_or(answer);
    let (mantissa, exponent) = match unsigned.split_once(['e', 'E']) {
        Some((m, e)) => (m, Some(e.strip_prefix(['+', '-']).unwrap_or(e))),
        None => (unsigned, None),
    };
    let mantissa_ok = match mantissa.split_once('.') {
        Some((whole, fraction)) => is_integer(whole) && is_integer(fraction),
        None => is_integer(mantissa),
    };
    mantissa_ok
        && match exponent {
            Some(e) => is_integer(e),
            None => mantissa.contains('.'),
        }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn profile(build: Option<&[&str]>, run: &[&str]) -> LanguageProfile {
        LanguageProfile {
            name: "Shell".into(),
            editor_mode: "shell".into(),
            lsp_language_id: "shellscript".into(),
            file: "{year}/{day}.sh".into(),
            build: build.map(|b| b.iter().map(|s| (*s).to_owned()).collect()),
            run: run.iter().map(|s| (*s).to_owned()).collect(),
            lsp: None,
            lsp_options: None,
            formatter: None,
            template: String::new(),
            dictation_hints: String::new(),
            packages: None,
            helpers: None,
            start_part_two: None,
            toolchain: None,
            gitignore: Vec::new(),
        }
    }

    async fn run_with(
        profile: &LanguageProfile,
        script: &str,
        input: &str,
        timeout: Duration,
    ) -> RunResult {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("solution.sh");
        std::fs::write(&file, script).unwrap();
        let cancel = CancellationToken::new();
        run(RunRequest {
            profile,
            file: &file,
            build_dir: &dir.path().join("build"),
            puzzle: Puzzle::new(2017, 1).unwrap(),
            input,
            timeout,
            cancel: &cancel,
            environment: &[(
                "WORKSHOP_TEST".to_owned(),
                "from the environment".to_owned(),
            )],
            helpers: None,
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn passes_input_and_reads_answers() {
        let profile = profile(None, &["sh", "{file}"]);
        let result = run_with(
            &profile,
            "read a; echo \"$a\"; echo; echo 42; echo oops >&2",
            "7\n",
            Duration::from_secs(10),
        )
        .await;
        assert!(result.succeeded());
        assert_eq!(result.answers, vec!["7", "42"]);
        assert_eq!(result.stderr.trim(), "oops");
    }

    #[test]
    fn reads_answers_past_how_a_language_prints_them() {
        assert_eq!(answer("\"fgij\""), "fgij");
        assert_eq!(answer("10n"), "10");
        assert_eq!(answer("-10n"), "-10");
        for line in [
            "42", "abc", "\"\"", "\"a\"b\"", "\"ab", "n", "-n", "12an", "1,2,3",
        ] {
            assert_eq!(answer(line), line, "{line}");
        }
    }

    #[test]
    fn spots_answers_printed_as_decimals() {
        for answer in ["3.0", "-2.5", "1e+21", "1.5e21", "2E-3"] {
            assert!(looks_like_a_decimal(answer), "{answer}");
        }
        for answer in [
            "3", "-12", "1,2", "abc", "e5", "1.", ".5", "3.0.1", "1e", "fgij",
        ] {
            assert!(!looks_like_a_decimal(answer), "{answer}");
        }
    }

    #[tokio::test]
    async fn reads_answers_and_warns_about_a_decimal_one() {
        let profile = profile(None, &["sh", "{file}"]);
        let result = run_with(
            &profile,
            "echo '\"fgij\"'; echo 3.0; echo 1.5",
            "",
            Duration::from_secs(10),
        )
        .await;
        assert_eq!(result.answers, vec!["fgij", "3.0", "1.5"]);
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].starts_with("Part 2's answer, 3.0,"));
        assert!(result.stdout.contains("\"fgij\""));
    }

    #[tokio::test]
    async fn builds_and_runs_with_the_given_environment() {
        let profile = profile(
            Some(&[
                "sh",
                "-c",
                "test \"$WORKSHOP_TEST\" = 'from the environment'",
            ]),
            &["sh", "{file}"],
        );
        let result = run_with(
            &profile,
            "echo \"$WORKSHOP_TEST\"",
            "",
            Duration::from_secs(10),
        )
        .await;
        assert!(result.succeeded(), "{result:?}");
        assert_eq!(result.answers, vec!["from the environment"]);
    }

    #[test]
    fn matches_shared_answers_fixture() {
        #[derive(serde::Deserialize)]
        struct Case {
            stdout: String,
            answers: Vec<String>,
            warnings: Vec<String>,
        }
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../crates/runner/tests/answers.json")).unwrap();
        assert!(cases.len() >= 5);
        for case in cases {
            let answers = parse_answers(&case.stdout);
            let warnings = answer_warnings(&answers);
            assert_eq!(answers, case.answers, "stdout={:?}", case.stdout);
            assert_eq!(warnings, case.warnings, "stdout={:?}", case.stdout);
        }
    }
}
