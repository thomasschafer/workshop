//! The `workshop run` and `workshop env` commands: working on solutions from a terminal, with
//! the same input, packages and helpers as the app.

use anyhow::{Context, Result, bail};
use tokio_util::sync::CancellationToken;

use crate::aoc::Part;
use crate::config::Config;
use crate::language::Puzzle;
use crate::paths::Paths;
use crate::runner::{Ending, Phase, RunResult};
use crate::settings::AppSettings;
use crate::solutions::{Solutions, aoc_client};
use crate::workspace::Workspace;

/// A puzzle as given on the command line: a year and day, or `practice`.
pub fn parse_puzzle(year: &str, day: Option<u8>) -> Result<Puzzle> {
    if year == "practice" {
        return Ok(Puzzle::PRACTICE);
    }
    let year: u16 = year
        .parse()
        .with_context(|| format!("{year:?} isn't a year, or `practice`"))?;
    let Some(day) = day else {
        bail!("give the day too, such as `workshop run {year} 1`");
    };
    Puzzle::new(year, day)
}

async fn solutions<'a>(config: &'a Config, paths: &'a Paths) -> Result<Solutions<'a>> {
    Solutions::load(config, paths, AppSettings::load(config, paths).language).await
}

/// Runs a solution on the real input or the sample chosen in the app, printing its output and
/// how it went. Returns whether it worked, and for a sample whether its answers were right.
pub async fn run(
    config: &Config,
    paths: &Paths,
    session: Option<String>,
    puzzle: Puzzle,
    sample: bool,
    part: Part,
) -> Result<bool> {
    let meta = Workspace::new(config.solutions_dir.clone(), paths.clone()).load_day_meta(puzzle)?;
    let input = if sample {
        meta.sample_input(part)
            .context("no sample is chosen for this puzzle yet; choose one in the app by tapping its example")?
            .to_owned()
    } else {
        aoc_client(config, paths, session)?.input(puzzle).await?
    };
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            stop.cancel();
        }
    });
    let result = solutions(config, paths)
        .await?
        .run(puzzle, &input, &cancel)
        .await?;
    print!("{}", result.stdout);
    eprint!("{}", result.stderr);
    eprintln!("{}", describe(&result));
    let mut passed =
        matches!(result.ending, Ending::Exited { code: Some(0) }) && result.phase == Phase::Run;
    if sample && passed {
        for (i, expected) in meta.sample_answers.iter().enumerate() {
            let (Some(expected), Some(answer)) = (expected, result.answers.get(i)) else {
                continue;
            };
            let right = answer == expected;
            passed &= right;
            eprintln!(
                "Part {}: {answer} {}",
                i + 1,
                if right {
                    "✓".to_owned()
                } else {
                    format!("✗ (expected {expected})")
                }
            );
        }
    }
    Ok(passed)
}

/// How a run ended, in a few words.
fn describe(result: &RunResult) -> String {
    let seconds = result.duration_ms as f64 / 1000.0;
    match (&result.phase, &result.ending) {
        (Phase::Build, Ending::Exited { code }) => match code {
            Some(code) => format!("The build failed (exit {code})."),
            None => "The build was stopped.".to_owned(),
        },
        (_, Ending::TimedOut) => format!("Stopped after {seconds:.1}s, the time limit."),
        (_, Ending::Cancelled) => "Cancelled.".to_owned(),
        (Phase::Run, Ending::Exited { code: Some(0) }) => format!("Finished in {seconds:.1}s."),
        (Phase::Run, Ending::Exited { code: Some(code) }) => {
            format!("Failed (exit {code}) after {seconds:.1}s.")
        }
        (Phase::Run, Ending::Exited { code: None }) => "The program was stopped.".to_owned(),
    }
}

/// Shells `workshop env` can print for.
#[derive(Debug, Clone, Copy, clap::ValueEnum)]
pub enum Shell {
    /// sh, bash and zsh.
    Posix,
    Fish,
}

/// The environment solutions run with, as commands for a shell to set it, so a terminal or
/// editor sees the same programs, packages and helpers as the app.
pub async fn env(config: &Config, paths: &Paths, shell: Shell) -> Result<String> {
    let environment = solutions(config, paths).await?.environment()?;
    Ok(environment
        .iter()
        .map(|(name, value)| match shell {
            Shell::Posix => format!("export {name}={}\n", posix_quote(value)),
            Shell::Fish => format!("set -gx {name} {}\n", fish_quote(value)),
        })
        .collect())
}

fn posix_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn fish_quote(value: &str) -> String {
    format!("'{}'", value.replace('\\', r"\\").replace('\'', r"\'"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_puzzles() {
        assert_eq!(
            parse_puzzle("2018", Some(1)).unwrap(),
            Puzzle::new(2018, 1).unwrap()
        );
        assert_eq!(parse_puzzle("practice", None).unwrap(), Puzzle::PRACTICE);
        assert!(parse_puzzle("2018", None).is_err());
        assert!(parse_puzzle("last", Some(1)).is_err());
    }

    #[test]
    fn quotes_for_each_shell() {
        assert_eq!(posix_quote("/a b/it's"), r"'/a b/it'\''s'");
        assert_eq!(fish_quote(r"/a\b/it's"), r"'/a\\b/it\'s'");
    }
}
