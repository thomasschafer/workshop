//! Building and running solutions, and the environment they need. Shared by the server and the
//! `workshop run` and `workshop env` commands, so a solution behaves the same from the phone and
//! from a terminal.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio_util::sync::CancellationToken;

use crate::aoc::AocClient;
use crate::config::Config;
use crate::language::{LanguageProfile, Puzzle};
use crate::packages::Packages;
use crate::paths::Paths;
use crate::practice::Practice;
use crate::runner::{self, RunResult};
use crate::toolchain::Toolchain;

/// The client for Advent of Code, with the practice puzzle served alongside it.
pub fn aoc_client(config: &Config, paths: &Paths, session: Option<String>) -> Result<AocClient> {
    Ok(AocClient::with_base_url(
        session,
        &config.aoc.user_agent,
        paths.aoc_cache_dir(),
        config.aoc.base_url.clone(),
    )?
    .with_practice(Practice::new(paths.data_dir.join("practice.json"))))
}

/// The solutions in the chosen language.
pub struct Solutions<'a> {
    pub config: &'a Config,
    pub paths: &'a Paths,
    /// The chosen language, such as `haskell`.
    pub language_id: String,
    pub toolchain: Toolchain,
}

impl<'a> Solutions<'a> {
    pub async fn load(config: &'a Config, paths: &'a Paths, language_id: String) -> Result<Self> {
        Ok(Self {
            config,
            paths,
            language_id,
            toolchain: Toolchain::load(&config.solutions_dir).await?,
        })
    }

    pub fn language(&self) -> &'a LanguageProfile {
        &self.config.languages[&self.language_id]
    }

    /// The language's packages, if it has any.
    pub fn packages(&self) -> Option<Packages<'a>> {
        let language = self.language();
        language.packages.as_ref().map(|profile| Packages {
            profile,
            language_name: &language.name,
            solutions_dir: &self.config.solutions_dir,
            dir: self.paths.packages_dir(&self.language_id),
            toolchain: self.toolchain.clone(),
        })
    }

    /// The directory of the user's helpers, which solutions import from.
    pub fn helpers_dir(&self) -> Result<Option<PathBuf>> {
        self.language()
            .helpers
            .as_ref()
            .map(|h| h.dir(&self.config.solutions_dir))
            .transpose()
    }

    /// Environment variables for building, running and the language server: the toolchain's,
    /// and where the user's helpers and installed packages are. A variable both helpers and
    /// packages set, such as a search path, gets both values.
    pub fn environment(&self) -> Result<Vec<(String, String)>> {
        let helpers = match &self.language().helpers {
            Some(helpers) => helpers.environment(&self.config.solutions_dir)?,
            None => Vec::new(),
        };
        let packages = match self.packages() {
            Some(packages) => packages.environment()?,
            None => Vec::new(),
        };
        Ok(self
            .toolchain
            .overlay(merge_environment(helpers.into_iter().chain(packages))))
    }

    /// Builds and runs a puzzle's solution on `input`.
    pub async fn run(
        &self,
        puzzle: Puzzle,
        input: &str,
        cancel: &CancellationToken,
    ) -> Result<RunResult> {
        let profile = self.language();
        let file = profile.solution_path(&self.config.solutions_dir, puzzle)?;
        let build_dir = self
            .paths
            .build_dir()
            .join(puzzle.year_label())
            .join(format!("{:02}", puzzle.day));
        let result = runner::run(runner::RunRequest {
            profile,
            file: &file,
            build_dir: &build_dir,
            puzzle,
            input,
            timeout: Duration::from_secs(self.config.run.timeout_secs),
            cancel,
            environment: &self.environment()?,
            helpers: self.helpers_dir()?.as_deref(),
        })
        .await
        .with_context(|| format!("running {puzzle}"))?;
        Ok(self.shorten_paths(result))
    }

    /// Shows paths in the solutions directory relative to it, as compilers and tracebacks give
    /// them in full, which takes much of a phone's width.
    fn shorten_paths(&self, mut result: RunResult) -> RunResult {
        let dir = &self.config.solutions_dir;
        result.stdout = relative_paths(&result.stdout, dir);
        result.stderr = relative_paths(&result.stderr, dir);
        result
    }
}

/// `text` with paths inside `dir` written relative to it.
fn relative_paths(text: &str, dir: &std::path::Path) -> String {
    text.replace(&format!("{}/", dir.display()), "")
}

/// Joins environment variables, giving one set more than once all its values, separated by `:`
/// as search paths are.
fn merge_environment(
    variables: impl IntoIterator<Item = (String, String)>,
) -> Vec<(String, String)> {
    let mut environment: Vec<(String, String)> = Vec::new();
    for (name, value) in variables {
        match environment.iter_mut().find(|(n, _)| *n == name) {
            Some((_, existing)) => {
                existing.push(':');
                existing.push_str(&value);
            }
            None => environment.push((name, value)),
        }
    }
    environment
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortens_paths_in_output() {
        let dir = std::path::Path::new("/home/me/aoc");
        assert_eq!(
            relative_paths(
                "File \"/home/me/aoc/2024/day01/main.py\", line 2\n/home/me/aocx/y",
                dir
            ),
            "File \"2024/day01/main.py\", line 2\n/home/me/aocx/y"
        );
    }

    #[test]
    fn merges_search_paths() {
        let merged = merge_environment([
            ("PYTHONPATH".to_owned(), "/lib".to_owned()),
            ("A".to_owned(), "1".to_owned()),
            ("PYTHONPATH".to_owned(), "/site".to_owned()),
        ]);
        assert_eq!(
            merged,
            [
                ("PYTHONPATH".to_owned(), "/lib:/site".to_owned()),
                ("A".to_owned(), "1".to_owned())
            ]
        );
    }
}
