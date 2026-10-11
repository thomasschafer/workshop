use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::template::{self, Vars};

/// Everything Workshop needs to know to work with one programming language.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LanguageProfile {
    pub name: String,
    /// Which syntax highlighting mode the editor uses.
    pub editor_mode: String,
    pub lsp_language_id: String,
    /// Solution path relative to the solutions directory, e.g. `{year}/day{day:02}/Main.hs`.
    pub file: String,
    /// Optional compile step, run before `run` with the same placeholders.
    #[serde(default)]
    pub build: Option<Vec<String>>,
    /// Runs the solution with the puzzle input on stdin.
    pub run: Vec<String>,
    #[serde(default)]
    pub lsp: Option<Vec<String>>,
    pub template: String,
    /// How the language is spoken, given to the edit model.
    pub dictation_hints: String,
    /// Shown in the app's help, to teach people how to dictate this language.
    #[serde(default)]
    pub examples: Vec<DictationExample>,
}

/// Something to say, and the code it produces.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DictationExample {
    pub say: String,
    pub result: String,
}

const BUILTIN: &[(&str, &str)] = &[("haskell", include_str!("../languages/haskell.toml"))];

pub fn builtin_profiles() -> Result<Vec<(String, LanguageProfile)>> {
    BUILTIN
        .iter()
        .map(|(id, source)| {
            let profile = toml::from_str(source)
                .with_context(|| format!("parsing built-in language profile {id}"))?;
            Ok(((*id).to_owned(), profile))
        })
        .collect()
}

/// A puzzle, identified by year and day.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "UncheckedPuzzle")]
pub struct Puzzle {
    pub year: u16,
    pub day: u8,
}

#[derive(Deserialize)]
struct UncheckedPuzzle {
    year: u16,
    day: u8,
}

impl TryFrom<UncheckedPuzzle> for Puzzle {
    type Error = anyhow::Error;

    fn try_from(value: UncheckedPuzzle) -> Result<Self> {
        Self::new(value.year, value.day)
    }
}

impl Puzzle {
    pub fn new(year: u16, day: u8) -> Result<Self> {
        if year < 2015 {
            bail!("Advent of Code started in 2015, so there is no {year} puzzle");
        }
        if !(1..=25).contains(&day) {
            bail!("day must be between 1 and 25, got {day}");
        }
        Ok(Self { year, day })
    }
}

impl std::fmt::Display for Puzzle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} day {}", self.year, self.day)
    }
}

impl LanguageProfile {
    pub fn solution_path(&self, solutions_dir: &Path, puzzle: Puzzle) -> Result<PathBuf> {
        let relative = template::render(
            &self.file,
            &Vars::new()
                .set("year", puzzle.year.to_string())
                .set("day", puzzle.day.to_string()),
        )?;
        let relative = Path::new(&relative);
        if relative.is_absolute()
            || relative
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            bail!(
                "solution path {} must stay inside the solutions directory",
                relative.display()
            );
        }
        Ok(solutions_dir.join(relative))
    }

    /// The programs this profile needs, for setup checks. Placeholder commands (such as a
    /// freshly built binary) are skipped.
    pub fn required_programs(&self) -> Vec<&str> {
        self.build
            .iter()
            .chain(std::iter::once(&self.run))
            .filter_map(|cmd| cmd.first())
            .filter(|program| !program.contains('{'))
            .map(String::as_str)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn haskell() -> LanguageProfile {
        builtin_profiles()
            .unwrap()
            .into_iter()
            .find(|(id, _)| id == "haskell")
            .unwrap()
            .1
    }

    #[test]
    fn builtin_profiles_parse() {
        let profile = haskell();
        assert_eq!(profile.name, "Haskell");
        assert!(profile.template.starts_with("module Main where"));
        assert!(profile.examples.len() >= 3);
        assert_eq!(profile.required_programs(), vec!["ghc"]);
    }

    #[test]
    fn solution_path_is_padded() {
        let path = haskell()
            .solution_path(Path::new("/aoc"), Puzzle::new(2016, 3).unwrap())
            .unwrap();
        assert_eq!(path, Path::new("/aoc/2016/day03/Main.hs"));
    }

    #[test]
    fn solution_path_cannot_escape() {
        let mut profile = haskell();
        profile.file = "../{year}.hs".into();
        assert!(
            profile
                .solution_path(Path::new("/aoc"), Puzzle::new(2016, 3).unwrap())
                .is_err()
        );
    }

    #[test]
    fn puzzle_validates_when_deserialised() {
        assert!(serde_json::from_str::<Puzzle>(r#"{"year":2017,"day":26}"#).is_err());
        assert_eq!(
            serde_json::from_str::<Puzzle>(r#"{"year":2017,"day":3}"#).unwrap(),
            Puzzle::new(2017, 3).unwrap()
        );
    }

    #[test]
    fn puzzle_validates() {
        assert!(Puzzle::new(2014, 1).is_err());
        assert!(Puzzle::new(2020, 0).is_err());
        assert!(Puzzle::new(2020, 26).is_err());
    }
}
