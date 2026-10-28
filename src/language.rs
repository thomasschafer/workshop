use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::packages::PackagesProfile;
use crate::template::{self, Vars};
use crate::toolchain::ToolchainProfile;

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
    /// Sent to the language server as it starts, for servers that need settings to work at all.
    #[serde(default)]
    pub lsp_options: Option<serde_json::Value>,
    pub template: String,
    /// How the language is spoken, given to the edit model.
    pub dictation_hints: String,
    /// Packages solutions can use beyond the standard library, if the language has any.
    #[serde(default)]
    pub packages: Option<PackagesProfile>,
    /// A module of the user's own that every solution can import.
    #[serde(default)]
    pub helpers: Option<HelpersProfile>,
    /// Turns on the template's part 2 code once part 1 is solved, such as by uncommenting the
    /// line that prints its answer.
    #[serde(default)]
    pub start_part_two: Option<TextSwap>,
    /// How to install the programs above with mise, for setup to offer when they're missing.
    #[serde(default)]
    pub toolchain: Option<ToolchainProfile>,
    /// Lines added to the solutions repo's `.gitignore` with the first solution, for what
    /// building writes inside it.
    #[serde(default)]
    pub gitignore: Vec<String>,
}

/// Text to replace with other text.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TextSwap {
    pub find: String,
    pub replace: String,
}

/// A module of the user's own, shared by every solution, such as for parsing input.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HelpersProfile {
    /// Relative to the solutions directory. Its directory is the `{helpers}` placeholder in
    /// commands.
    pub file: String,
    /// What the module starts with.
    pub template: String,
    /// Environment variables for building, running and the language server, with `{helpers}`.
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    /// Settings that tell the language server where the module is, written to the solutions
    /// directory unless the file is already there.
    #[serde(default)]
    pub lsp_config: Option<ConfigFile>,
    /// A pattern matching a line that defines a helper, with its name as the only group, so the
    /// edit model knows what the module offers and imports it when one is used.
    #[serde(default)]
    pub definition: Option<String>,
}

/// One helper in the user's module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelperDefinition {
    pub name: String,
    /// The line that defines it, such as its signature, which says how to call it.
    pub line: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigFile {
    /// Relative to the solutions directory.
    pub file: String,
    pub text: String,
}

impl HelpersProfile {
    /// The helpers' directory, which solutions import from.
    pub fn dir(&self, solutions_dir: &Path) -> Result<PathBuf> {
        let file = relative_inside(&self.file)?;
        Ok(solutions_dir.join(file.parent().unwrap_or(Path::new(""))))
    }

    /// Writes the helpers and the language server's settings, keeping any that already exist.
    pub fn create(&self, solutions_dir: &Path) -> Result<()> {
        let files = std::iter::once((&self.file, &self.template))
            .chain(self.lsp_config.iter().map(|c| (&c.file, &c.text)));
        for (file, text) in files {
            let path = solutions_dir.join(relative_inside(file)?);
            if !path.exists() {
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)
                        .with_context(|| format!("creating {}", parent.display()))?;
                }
                crate::paths::write_atomic(&path, text.trim_start().as_bytes())?;
            }
        }
        Ok(())
    }

    pub fn validate(&self) -> Result<()> {
        if let Some(pattern) = &self.definition {
            let regex = regex::Regex::new(pattern)
                .with_context(|| format!("invalid `helpers.definition` pattern {pattern:?}"))?;
            if regex.captures_len() != 2 {
                bail!("`helpers.definition` pattern {pattern:?} needs exactly one group");
            }
        }
        Ok(())
    }

    /// The helpers the module defines, from its text.
    pub fn definitions_in(&self, text: &str) -> Vec<HelperDefinition> {
        let Some(regex) = self
            .definition
            .as_deref()
            .and_then(|p| regex::RegexBuilder::new(p).multi_line(true).build().ok())
        else {
            return Vec::new();
        };
        let mut definitions: Vec<HelperDefinition> = regex
            .captures_iter(text)
            .filter_map(|c| {
                let name = c.get(1)?.as_str().to_owned();
                let start = c.get(0)?.start();
                let end = text[start..].find('\n').map_or(text.len(), |i| start + i);
                let line = text[start..end].trim().to_owned();
                Some(HelperDefinition { name, line })
            })
            .collect();
        definitions.dedup_by(|a, b| a.name == b.name);
        definitions
    }

    /// The helpers the user's module defines now, or the ones it starts with if it hasn't been
    /// made yet.
    pub fn definitions(&self, solutions_dir: &Path) -> Result<Vec<HelperDefinition>> {
        let path = solutions_dir.join(relative_inside(&self.file)?);
        match std::fs::read_to_string(&path) {
            Ok(text) => Ok(self.definitions_in(&text)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                Ok(self.definitions_in(&self.template))
            }
            Err(err) => Err(err).with_context(|| format!("reading {}", path.display())),
        }
    }

    pub fn environment(&self, solutions_dir: &Path) -> Result<Vec<(String, String)>> {
        let dir = self.dir(solutions_dir)?;
        let vars = Vars::new().set("helpers", dir.to_string_lossy());
        self.environment
            .iter()
            .map(|(name, value)| Ok((name.clone(), template::render(value, &vars)?)))
            .collect()
    }
}

/// A path that must stay inside the solutions directory.
/// A path that must stay inside the solutions directory. It's written with `/`, as in a profile,
/// and made with the system's own separator, so it reads as one path on Windows too.
pub(crate) fn relative_inside(path: &str) -> Result<PathBuf> {
    let relative: PathBuf = path.split('/').filter(|part| !part.is_empty()).collect();
    if path.starts_with('/')
        || relative.has_root()
        || relative.is_absolute()
        || relative.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::Prefix(_)
            )
        })
    {
        bail!("{path} must stay inside the solutions directory");
    }
    Ok(relative)
}

const BUILTIN: &[(&str, &str)] = &[
    ("haskell", include_str!("../languages/haskell.toml")),
    ("python", include_str!("../languages/python.toml")),
    ("rust", include_str!("../languages/rust.toml")),
    ("go", include_str!("../languages/go.toml")),
    ("typescript", include_str!("../languages/typescript.toml")),
];

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
    /// The invented puzzle to practise on, which needs no Advent of Code account. No real
    /// puzzle has year 0.
    pub const PRACTICE: Puzzle = Puzzle { year: 0, day: 1 };

    pub fn new(year: u16, day: u8) -> Result<Self> {
        if (year, day) == (Self::PRACTICE.year, Self::PRACTICE.day) {
            return Ok(Self::PRACTICE);
        }
        if year < 2015 {
            bail!("Advent of Code started in 2015, so there is no {year} puzzle");
        }
        if !(1..=25).contains(&day) {
            bail!("day must be between 1 and 25, got {day}");
        }
        Ok(Self { year, day })
    }
}

impl Puzzle {
    pub fn is_practice(self) -> bool {
        self == Self::PRACTICE
    }

    /// How the puzzle is named in commit messages.
    pub fn title(self) -> String {
        if self.is_practice() {
            "Workshop practice puzzle".to_owned()
        } else {
            format!("{} day {}", self.year, self.day)
        }
    }

    /// The year as it appears in paths: `practice` for the practice puzzle, which keeps its
    /// files apart from real years.
    pub fn year_label(self) -> String {
        if self.is_practice() {
            "practice".to_owned()
        } else {
            self.year.to_string()
        }
    }
}

impl std::fmt::Display for Puzzle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.is_practice() {
            write!(f, "the practice puzzle")
        } else {
            write!(f, "{} day {}", self.year, self.day)
        }
    }
}

impl LanguageProfile {
    pub fn solution_path(&self, solutions_dir: &Path, puzzle: Puzzle) -> Result<PathBuf> {
        let relative = template::render(
            &self.file,
            &Vars::new()
                .set("year", puzzle.year_label())
                .set("day", puzzle.day.to_string()),
        )?;
        Ok(solutions_dir.join(relative_inside(&relative)?))
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

    #[test]
    fn finds_the_helpers_every_language_starts_with() {
        for (id, profile) in builtin_profiles().unwrap() {
            let helpers = profile.helpers.unwrap();
            helpers.validate().unwrap();
            // Go's are capitalised, as exported names must be.
            let names: Vec<String> = helpers
                .definitions_in(&helpers.template)
                .iter()
                .map(|definition| definition.name.to_lowercase())
                .collect();
            assert_eq!(
                names[..4],
                ["ints", "grid", "neighbours4", "neighbours8"],
                "{id}"
            );
        }
    }

    #[test]
    fn reads_how_each_helper_is_defined() {
        let rust = builtin_profiles()
            .unwrap()
            .into_iter()
            .find(|(id, _)| id == "rust")
            .and_then(|(_, p)| p.helpers)
            .unwrap();
        assert_eq!(
            rust.definitions_in("pub fn ints(text: &str) -> Vec<i64> {\n    todo!()\n}\n")[0],
            HelperDefinition {
                name: "ints".to_owned(),
                line: "pub fn ints(text: &str) -> Vec<i64> {".to_owned(),
            }
        );
        let haskell = haskell().helpers.unwrap();
        assert_eq!(
            haskell
                .definitions_in("ints :: String -> [Int]\nints = undefined\n")
                .iter()
                .map(|d| d.line.as_str())
                .collect::<Vec<_>>(),
            ["ints :: String -> [Int]"]
        );
    }

    #[test]
    fn creates_helpers_without_replacing_the_users_own() {
        let dir = tempfile::tempdir().unwrap();
        let helpers = builtin_profiles()
            .unwrap()
            .into_iter()
            .find(|(id, _)| id == "python")
            .and_then(|(_, p)| p.helpers)
            .unwrap();
        std::fs::write(dir.path().join("pyrightconfig.json"), "{}").unwrap();
        helpers.create(dir.path()).unwrap();
        let module = std::fs::read_to_string(dir.path().join("lib/aoc.py")).unwrap();
        assert!(module.starts_with("\"\"\"Helpers"), "{module}");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("pyrightconfig.json")).unwrap(),
            "{}"
        );
        assert_eq!(
            helpers.environment(dir.path()).unwrap(),
            [(
                "PYTHONPATH".to_owned(),
                dir.path().join("lib").to_string_lossy().into_owned()
            )]
        );
    }

    #[test]
    fn builtin_templates_contain_their_part_two_swaps() {
        for (id, profile) in builtin_profiles().unwrap() {
            if let Some(swap) = profile.start_part_two {
                assert!(
                    profile.template.contains(&swap.find),
                    "{id}: {:?}",
                    swap.find
                );
            }
        }
    }

    #[test]
    fn builtin_packages_are_valid() {
        for (id, profile) in builtin_profiles().unwrap() {
            if let Some(packages) = profile.packages {
                packages
                    .validate()
                    .unwrap_or_else(|e| panic!("{id}: {e:#}"));
            }
        }
    }

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
        assert_eq!(profile.required_programs(), vec!["ghc"]);
    }

    #[test]
    fn python_profile_parses() {
        let (_, python) = builtin_profiles()
            .unwrap()
            .into_iter()
            .find(|(id, _)| id == "python")
            .unwrap();
        assert_eq!(python.required_programs(), vec!["python3"]);
        assert!(python.template.contains("def part1(data: str) -> int:"));
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
