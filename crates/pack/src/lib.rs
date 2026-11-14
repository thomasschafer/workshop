//! Packs: directories of things to learn, each item a Markdown file, with the skills, tracks
//! and goals they belong to in `pack.toml`. See `docs/packs.md` for the format.
//!
//! Every item has a mechanical check, which `workshop pack check` runs: a probability item's
//! simulation must agree with its exact answer, and a mental maths template must make questions
//! with answers, for example.

mod item;
mod manifest;
pub mod mental;
pub mod number;
pub mod script;
pub mod simulate;

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::{Context, Result};

pub use item::{Coding, Content, Item, Kind, MentalMaths, Param, Probability, Simulation};
pub use manifest::{Goal, Manifest, PackTrack, Prompts, Skill};

/// How many questions a mental maths template must make without fault to pass its check.
const MENTAL_MATHS_CHECKS: u64 = 200;

/// The fewest different questions those must include, so a template isn't the same sum every
/// time.
const MIN_DIFFERENT_QUESTIONS: usize = 5;

/// A pack, read from its files.
#[derive(Debug, Clone)]
pub struct Pack {
    pub manifest: Manifest,
    /// Every item that could be read, in the order of their paths.
    pub items: Vec<Item>,
    /// What couldn't be read, which is left out.
    pub problems: Vec<Problem>,
}

/// Something in a pack that's wrong, and where.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    pub path: String,
    pub message: String,
}

impl std::fmt::Display for Problem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.path, self.message)
    }
}

#[derive(rust_embed::RustEmbed)]
#[folder = "../../packs/sample"]
struct Sample;

impl Pack {
    /// Reads the pack in `dir`. Items that can't be read are left out and listed in `problems`;
    /// only a pack with no readable `pack.toml` is an error.
    pub fn load(dir: &Path) -> Result<Self> {
        let mut files = BTreeMap::new();
        read_dir(dir, dir, &mut files)?;
        Self::from_files(files).with_context(|| format!("in the pack at {}", dir.display()))
    }

    /// The sample pack that comes with Workshop.
    pub fn sample() -> Self {
        let files = Sample::iter()
            .map(|path| {
                let file = Sample::get(&path).expect("listed by the embed");
                (path.into_owned(), file.data.into_owned())
            })
            .collect();
        Self::from_files(files).expect("the sample pack is checked by its tests")
    }

    /// Reads a pack from its files, by their paths relative to the pack, with `/` between
    /// directories.
    pub fn from_files(files: BTreeMap<String, Vec<u8>>) -> Result<Self> {
        let manifest = files.get("pack.toml").context("there's no pack.toml")?;
        let manifest = std::str::from_utf8(manifest).context("pack.toml isn't UTF-8")?;
        let manifest =
            Manifest::parse(manifest).map_err(|err| anyhow::anyhow!("in pack.toml: {err}"))?;
        let mut problems = Vec::new();
        for (role, file) in manifest.prompts.files() {
            if !files.contains_key(file) {
                problems.push(Problem {
                    path: "pack.toml".to_owned(),
                    message: format!("the {role}'s prompt add-on {file:?} isn't in the pack"),
                });
            }
        }

        // An item is a Markdown file under items/, or a directory there with an item.md, whose
        // other files are the item's own.
        let item_dirs: BTreeSet<&str> = files
            .keys()
            .filter_map(|path| path.strip_suffix("/item.md"))
            .filter(|dir| dir.starts_with("items/"))
            .collect();
        let mut items: Vec<Item> = Vec::new();
        for (path, bytes) in &files {
            if !path.starts_with("items/") || !path.ends_with(".md") {
                continue;
            }
            let own_dir = item_dirs
                .iter()
                .find(|dir| path.starts_with(&format!("{dir}/")));
            let (default_id, dir) = match own_dir {
                Some(dir) if *path == format!("{dir}/item.md") => {
                    (dir.rsplit('/').next().unwrap_or(dir), Some(*dir))
                }
                // Another file of an item in a directory, such as its notes.
                Some(_) => continue,
                None => (
                    path.rsplit('/')
                        .next()
                        .and_then(|name| name.strip_suffix(".md"))
                        .unwrap_or(path),
                    None,
                ),
            };
            let exists =
                |file: &str| dir.is_some_and(|dir| files.contains_key(&format!("{dir}/{file}")));
            let parsed = std::str::from_utf8(bytes)
                .map_err(|_| "it isn't UTF-8".to_owned())
                .and_then(|source| Item::parse(path, default_id, source, &manifest, exists));
            match parsed {
                Ok(item) if items.iter().any(|other| other.id == item.id) => {
                    let other = items
                        .iter()
                        .find(|other| other.id == item.id)
                        .expect("found");
                    problems.push(Problem {
                        path: path.clone(),
                        message: format!("the id {:?} is already {}'s", item.id, other.path),
                    });
                }
                Ok(item) => items.push(item),
                Err(message) => problems.push(Problem {
                    path: path.clone(),
                    message,
                }),
            }
        }
        Ok(Self {
            manifest,
            items,
            problems,
        })
    }

    pub fn item(&self, id: &str) -> Option<&Item> {
        self.items.iter().find(|item| item.id == id)
    }

    /// Runs every item's mechanical check, along with what was found reading the pack.
    pub fn check(&self) -> Report {
        let items = self
            .items
            .iter()
            .map(|item| Checked {
                path: item.path.clone(),
                result: check_item(item),
            })
            .collect();
        Report {
            problems: self.problems.clone(),
            items,
        }
    }
}

fn read_dir(root: &Path, dir: &Path, files: &mut BTreeMap<String, Vec<u8>>) -> Result<()> {
    let entries = std::fs::read_dir(dir).with_context(|| format!("reading {}", dir.display()))?;
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        // Version control and editors' own files aren't part of the pack.
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        if entry.file_type()?.is_dir() {
            read_dir(root, &path, files)?;
        } else {
            let relative = path
                .strip_prefix(root)
                .expect("under the root")
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            let bytes =
                std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
            files.insert(relative, bytes);
        }
    }
    Ok(())
}

/// What checking a pack found.
#[derive(Debug, Clone)]
pub struct Report {
    /// Files that couldn't be read, or that the pack refers to and doesn't have.
    pub problems: Vec<Problem>,
    pub items: Vec<Checked>,
}

#[derive(Debug, Clone)]
pub struct Checked {
    pub path: String,
    /// What was checked, or what's wrong.
    pub result: Result<String, String>,
}

impl Report {
    pub fn passed(&self) -> bool {
        self.problems.is_empty() && self.items.iter().all(|item| item.result.is_ok())
    }

    /// Every problem, read or checked.
    pub fn failures(&self) -> Vec<Problem> {
        let checked = self.items.iter().filter_map(|item| {
            item.result.as_ref().err().map(|message| Problem {
                path: item.path.clone(),
                message: message.clone(),
            })
        });
        self.problems.iter().cloned().chain(checked).collect()
    }
}

fn check_item(item: &Item) -> Result<String, String> {
    match &item.content {
        Content::Card { .. } => Ok("a card, marked by the learner".to_owned()),
        Content::MentalMaths(template) => {
            let generator = mental::Generator::new(template, &item.prompt)?;
            let mut prompts = BTreeSet::new();
            for seed in 0..MENTAL_MATHS_CHECKS {
                let instance = generator
                    .instance(seed)
                    .map_err(|err| format!("making the question for seed {seed}: {err}"))?;
                prompts.insert(instance.prompt);
            }
            if prompts.len() < MIN_DIFFERENT_QUESTIONS {
                return Err(format!(
                    "{MENTAL_MATHS_CHECKS} draws made only {} different questions",
                    prompts.len()
                ));
            }
            Ok(format!(
                "{MENTAL_MATHS_CHECKS} questions made, {} of them different",
                prompts.len()
            ))
        }
        Content::Probability(probability) => {
            let estimate = simulate::check(probability)?;
            Ok(format!(
                "{} trials estimate {:.4} ± {:.4}, against {}",
                estimate.trials, estimate.mean, estimate.standard_error, probability.answer_text
            ))
        }
        // Running the solutions needs a toolchain, which the coding track's runner provides.
        Content::Coding(coding) => Ok(format!(
            "its reference in {}, brute force, tests and inputs are in place",
            coding.reference.join(", ")
        )),
        Content::Design { rubric, .. } => Ok(format!("a rubric of {} points", rubric.len())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(entries: &[(&str, &str)]) -> BTreeMap<String, Vec<u8>> {
        entries
            .iter()
            .map(|(path, text)| ((*path).to_owned(), text.as_bytes().to_vec()))
            .collect()
    }

    const MANIFEST: &str =
        "id = \"example\"\nname = \"Example\"\n[[skills]]\nid = \"dice\"\nname = \"Dice\"\n";

    #[test]
    fn the_sample_pack_passes_its_checks() {
        let pack = Pack::sample();
        let report = pack.check();
        let failures: Vec<String> = report.failures().iter().map(ToString::to_string).collect();
        assert!(failures.is_empty(), "{failures:#?}");
        for kind in [Kind::Card, Kind::MentalMaths, Kind::Probability] {
            let count = pack.items.iter().filter(|item| item.kind == kind).count();
            assert!((8..=12).contains(&count), "{count} of {kind:?}");
        }
    }

    #[test]
    fn reads_items_in_files_and_directories() {
        let card = "+++\nkind = \"card\"\nskills = [\"dice\"]\n+++\nQ\n## Answer\nA\n";
        let coding = "+++\nkind = \"coding\"\nskills = [\"dice\"]\nlanguages = [\"python\"]\nreference = [\"reference.py\"]\nbrute_force = \"brute.py\"\ntests = \"tests.toml\"\ninputs = \"inputs.py\"\n+++\nRoll some dice.\n";
        let pack = Pack::from_files(files(&[
            ("pack.toml", MANIFEST),
            ("items/cards/one.md", card),
            ("items/roll/item.md", coding),
            ("items/roll/notes.md", "Not an item."),
            ("items/roll/reference.py", ""),
            ("items/roll/brute.py", ""),
            ("items/roll/tests.toml", ""),
            ("items/roll/inputs.py", ""),
            ("README.md", "Not an item either."),
        ]))
        .unwrap();
        assert_eq!(pack.problems, []);
        let ids: Vec<&str> = pack.items.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, ["one", "roll"]);
        assert!(pack.check().passed());
    }

    #[test]
    fn leaves_out_items_that_cannot_be_read() {
        let card = "+++\nkind = \"card\"\nskills = [\"dice\"]\n+++\nQ\n## Answer\nA\n";
        let pack = Pack::from_files(files(&[
            (
                "pack.toml",
                &format!("{MANIFEST}[prompts]\ntutor = \"prompts/tutor.md\"\n"),
            ),
            ("items/a.md", card),
            ("items/b/a.md", card),
            ("items/broken.md", "no front matter"),
        ]))
        .unwrap();
        assert_eq!(pack.items.len(), 1);
        let problems: Vec<&str> = pack.problems.iter().map(|p| p.path.as_str()).collect();
        assert_eq!(problems, ["pack.toml", "items/b/a.md", "items/broken.md"]);
        assert!(pack.problems[1].message.contains("already items/a.md's"));
        assert!(!pack.check().passed());
        assert!(Pack::from_files(files(&[("items/a.md", card)])).is_err());
    }

    #[test]
    fn checks_fail_for_wrong_answers() {
        let wrong = "+++\nkind = \"probability\"\nskills = [\"dice\"]\nanswer = \"1/2\"\n[simulation]\ntrials = 20000\ntolerance = 0.02\n+++\nWhat's the chance of a six?\n## Solution\nOne side in six.\n## Simulation\n```rhai\nrand_int(1, 6) == 6\n```\n";
        let same = "+++\nkind = \"mental-maths\"\nskills = [\"dice\"]\nanswer = \"a\"\n[params]\na = { choices = [1, 2] }\n+++\nWhat's {a}?\n";
        let pack = Pack::from_files(files(&[
            ("pack.toml", MANIFEST),
            ("items/wrong.md", wrong),
            ("items/same.md", same),
        ]))
        .unwrap();
        let report = pack.check();
        let failures = report.failures();
        assert_eq!(failures.len(), 2);
        assert!(
            failures[0].message.contains("different questions"),
            "{}",
            failures[0]
        );
        assert!(failures[1].message.contains("estimates"), "{}", failures[1]);
    }

    #[test]
    fn reads_a_pack_from_its_directory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("items/cards")).unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join("pack.toml"), MANIFEST).unwrap();
        std::fs::write(dir.path().join(".git/HEAD"), "ref").unwrap();
        std::fs::write(
            dir.path().join("items/cards/one.md"),
            "+++\nkind = \"card\"\nskills = [\"dice\"]\n+++\nQ\n## Answer\nA\n",
        )
        .unwrap();
        let pack = Pack::load(dir.path()).unwrap();
        assert_eq!(pack.items[0].path, "items/cards/one.md");
        assert!(pack.item("one").is_some());
        assert!(Pack::load(&dir.path().join("nowhere")).is_err());
    }
}
