//! Packs: directories of things to learn, each item a Markdown file, with the skills, tracks
//! and goals they belong to in `pack.toml`. See `docs/packs.md` for the format.
//!
//! Every item has a mechanical check, which `workshop pack check` runs: a probability item's
//! simulation must agree with its exact answer, and a mental maths template must make questions
//! with answers, for example.

pub mod code;
pub mod drafts;
pub mod error_types;
mod item;
mod manifest;
pub mod mental;
pub mod number;
pub mod output;
pub mod script;
pub mod simulate;

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::{Context, Result};

pub use code::{Case, Coding, Language, Question, Reading, ReadingCheck, Source};
pub use drafts::Draft;
pub use error_types::ErrorType;
pub use item::{
    Content, DIFFICULTY, Item, Kind, MentalMaths, Param, Probability, Simulation, replace_section,
};
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
    /// Questions waiting to be made into items, under `drafts/`.
    pub drafts: Vec<Draft>,
    /// What couldn't be read, which is left out.
    pub problems: Vec<Problem>,
    /// The text added to each coach role's instructions, by role, such as `tutor`.
    pub prompt_add_ons: BTreeMap<String, String>,
    /// Styles the examiner can take, with their add-ons read; those whose add-on couldn't be
    /// read are left out.
    pub examiner_styles: Vec<ExaminerStyle>,
}

/// A style the examiner can take in timed rounds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExaminerStyle {
    pub id: String,
    pub name: String,
    pub description: String,
    /// Added to the examiner's instructions.
    pub prompt: String,
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
        let mut prompt_add_ons = BTreeMap::new();
        for (role, file) in manifest.prompts.files() {
            match files.get(file).map(|bytes| std::str::from_utf8(bytes)) {
                Some(Ok(text)) => {
                    prompt_add_ons.insert(role.to_owned(), text.trim().to_owned());
                }
                Some(Err(_)) => problems.push(Problem {
                    path: file.to_owned(),
                    message: format!("the {role}'s prompt add-on isn't UTF-8"),
                }),
                None => problems.push(Problem {
                    path: "pack.toml".to_owned(),
                    message: format!("the {role}'s prompt add-on {file:?} isn't in the pack"),
                }),
            }
        }

        let mut examiner_styles = Vec::new();
        for style in &manifest.examiner_styles {
            match files
                .get(&style.prompt)
                .map(|bytes| std::str::from_utf8(bytes))
            {
                Some(Ok(text)) => examiner_styles.push(ExaminerStyle {
                    id: style.id.clone(),
                    name: style.name.clone(),
                    description: style.description.clone(),
                    prompt: text.trim().to_owned(),
                }),
                Some(Err(_)) => problems.push(Problem {
                    path: style.prompt.clone(),
                    message: format!("the examiner style {:?}'s add-on isn't UTF-8", style.id),
                }),
                None => problems.push(Problem {
                    path: "pack.toml".to_owned(),
                    message: format!(
                        "the examiner style {:?}'s add-on {:?} isn't in the pack",
                        style.id, style.prompt
                    ),
                }),
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
            let read = |file: &str| read_item_file(&files, dir, file);
            let parsed = std::str::from_utf8(bytes)
                .map_err(|_| "it isn't UTF-8".to_owned())
                .and_then(|source| Item::parse(path, default_id, source, &manifest, read));
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
        let mut drafts = Vec::new();
        for (path, bytes) in &files {
            let Some(id) = path
                .strip_prefix("drafts/")
                .and_then(|name| name.strip_suffix(".md"))
            else {
                continue;
            };
            let parsed = if id.contains('/') || !manifest::is_slug(id) {
                Err("a draft's file name should be lowercase letters and digits, in words joined by hyphens, directly in drafts/".to_owned())
            } else {
                std::str::from_utf8(bytes)
                    .map_err(|_| "it isn't UTF-8".to_owned())
                    .and_then(|source| Draft::parse(path, id, source, &manifest))
            };
            match parsed {
                Ok(draft) => drafts.push(draft),
                Err(message) => problems.push(Problem {
                    path: path.clone(),
                    message,
                }),
            }
        }
        Ok(Self {
            manifest,
            items,
            drafts,
            problems,
            prompt_add_ons,
            examiner_styles,
        })
    }

    pub fn item(&self, id: &str) -> Option<&Item> {
        self.items.iter().find(|item| item.id == id)
    }

    /// Runs every item's mechanical check, along with what was found reading the pack. Items
    /// with programs to build and run are checked by `programs`.
    pub async fn check(&self, programs: &dyn Programs) -> Report {
        // At once, as building programs takes a while and each build is one process.
        let checks = self.items.iter().map(|item| async move {
            let verdict = match check_item(item) {
                Some(verdict) => verdict,
                None => programs.check(item).await,
            };
            Checked {
                path: item.path.clone(),
                verdict,
            }
        });
        let items = futures_util::future::join_all(checks).await;
        Report {
            problems: self.problems.clone(),
            items,
        }
    }
}

/// Checks items by building and running their programs, such as a coding item's reference
/// solution against its tests.
pub trait Programs: Sync {
    fn check<'a>(
        &'a self,
        item: &'a Item,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Verdict> + Send + 'a>>;
}

/// The text of a file an item refers to, relative to the item's own directory.
fn read_item_file(
    files: &BTreeMap<String, Vec<u8>>,
    dir: Option<&str>,
    file: &str,
) -> Result<String, String> {
    let Some(dir) = dir else {
        return Err(format!(
            "it refers to {file:?}, so it needs a directory of its own, with an item.md"
        ));
    };
    if file
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(format!(
            "{file:?} should be a path inside the item's directory"
        ));
    }
    let bytes = files.get(&format!("{dir}/{file}")).ok_or_else(|| {
        format!("{file:?} isn't in the item's directory, where its front matter says it is")
    })?;
    String::from_utf8(bytes.clone()).map_err(|_| format!("{file:?} isn't UTF-8"))
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
    pub verdict: Verdict,
}

/// How an item's check went.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// What was checked.
    Passed(String),
    /// Why it couldn't be checked here, such as a compiler that isn't installed. It isn't a
    /// failure, as the item may well be right, but it hasn't been shown to be.
    Skipped(String),
    /// What's wrong.
    Failed(String),
}

impl From<Result<String, String>> for Verdict {
    fn from(result: Result<String, String>) -> Self {
        match result {
            Ok(detail) => Self::Passed(detail),
            Err(problem) => Self::Failed(problem),
        }
    }
}

impl Report {
    /// Whether nothing failed. Items that were skipped don't count against it.
    pub fn passed(&self) -> bool {
        self.failures().is_empty()
    }

    /// Every problem, read or checked.
    pub fn failures(&self) -> Vec<Problem> {
        let checked = self.items.iter().filter_map(|item| match &item.verdict {
            Verdict::Failed(message) => Some(Problem {
                path: item.path.clone(),
                message: message.clone(),
            }),
            _ => None,
        });
        self.problems.iter().cloned().chain(checked).collect()
    }

    /// Items that couldn't be checked here, and why.
    pub fn skipped(&self) -> Vec<Problem> {
        self.items
            .iter()
            .filter_map(|item| match &item.verdict {
                Verdict::Skipped(reason) => Some(Problem {
                    path: item.path.clone(),
                    message: reason.clone(),
                }),
                _ => None,
            })
            .collect()
    }
}

/// An item's check, unless it's one of programs to build and run.
fn check_item(item: &Item) -> Option<Verdict> {
    match &item.content {
        Content::Coding(_) | Content::Reading(_) => None,
        _ => Some(check_without_programs(item).into()),
    }
}

fn check_without_programs(item: &Item) -> Result<String, String> {
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
        Content::Coding(_) | Content::Reading(_) => {
            unreachable!("checked by running their programs")
        }
        Content::Design { rubric, brief, .. } => Ok(format!(
            "a rubric of {} points, {}",
            rubric.len(),
            if brief.is_some() {
                "and a brief"
            } else {
                "with a brief made up as each session starts"
            }
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use workshop_tracks::TrackId;

    fn files(entries: &[(&str, &str)]) -> BTreeMap<String, Vec<u8>> {
        entries
            .iter()
            .map(|(path, text)| ((*path).to_owned(), text.as_bytes().to_vec()))
            .collect()
    }

    const MANIFEST: &str =
        "id = \"example\"\nname = \"Example\"\n[[skills]]\nid = \"dice\"\nname = \"Dice\"\n";

    /// Stands in for building and running programs, which `workshop-coding` does.
    struct NotRun;

    impl Programs for NotRun {
        fn check<'a>(
            &'a self,
            item: &'a Item,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Verdict> + Send + 'a>> {
            Box::pin(async move { Verdict::Skipped(format!("{} isn't run here", item.id)) })
        }
    }

    #[tokio::test]
    async fn the_sample_pack_passes_its_checks() {
        let pack = Pack::sample();
        let report = pack.check(&NotRun).await;
        let failures: Vec<String> = report.failures().iter().map(ToString::to_string).collect();
        assert!(failures.is_empty(), "{failures:#?}");
        for kind in [Kind::Card, Kind::MentalMaths, Kind::Probability] {
            // Mental maths templates come in two tracks: exact sums, and estimates.
            for track in [
                TrackId::Review,
                TrackId::MentalMaths,
                TrackId::Probability,
                TrackId::Pack("estimation".parse().unwrap()),
            ] {
                let count = pack
                    .items
                    .iter()
                    .filter(|item| item.kind == kind && item.track == track)
                    .count();
                assert!(
                    count == 0 || (8..=12).contains(&count),
                    "{count} of {kind:?} in {track}"
                );
            }
            let count = pack.items.iter().filter(|item| item.kind == kind).count();
            assert!(count >= 8, "{count} of {kind:?}");
        }
        // Coding items' programs are checked by workshop-coding, which runs them.
        let coding = pack.items.iter().filter(|i| i.kind == Kind::Coding).count();
        let reading = pack
            .items
            .iter()
            .filter(|i| i.kind == Kind::Reading)
            .count();
        assert!((6..=8).contains(&coding), "{coding} coding items");
        assert!((12..=16).contains(&reading), "{reading} reading items");
        // Code to read in each language.
        for language in Language::ALL {
            let count = pack
                .items
                .iter()
                .filter(|i| matches!(&i.content, Content::Reading(r) if r.language == language))
                .count();
            assert!(
                (3..=4).contains(&count),
                "{count} reading items in {language:?}"
            );
        }
        assert_eq!(report.skipped().len(), coding + reading);
    }

    const CODING: &str = "+++\nkind = \"coding\"\nskills = [\"dice\"]\nlanguages = [\"python\"]\nreference = [\"reference.py\"]\nstarter = [\"starter.py\"]\nbrute_force = \"brute.py\"\ntests = \"tests.toml\"\ninputs = \"inputs.py\"\n+++\nRoll some dice.\n## Approach\nAdd them up.\n";
    const TESTS: &str =
        "[[example]]\ninput = \"1 2\"\noutput = \"3\"\n[[test]]\ninput = \"2 2\"\noutput = \"4\"\n";

    #[tokio::test]
    async fn reads_items_in_files_and_directories() {
        let card = "+++\nkind = \"card\"\nskills = [\"dice\"]\n+++\nQ\n## Answer\nA\n";
        let pack = Pack::from_files(files(&[
            ("pack.toml", MANIFEST),
            ("items/cards/one.md", card),
            ("items/roll/item.md", CODING),
            ("items/roll/notes.md", "Not an item."),
            (
                "items/roll/reference.py",
                "print(sum(map(int, input().split())))\n",
            ),
            ("items/roll/starter.py", "print(0)\n"),
            ("items/roll/brute.py", ""),
            ("items/roll/tests.toml", TESTS),
            ("items/roll/inputs.py", ""),
            ("README.md", "Not an item either."),
        ]))
        .unwrap();
        assert_eq!(pack.problems, []);
        let ids: Vec<&str> = pack.items.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, ["one", "roll"]);
        assert!(pack.drafts.is_empty());
        let Content::Coding(coding) = &pack.item("roll").unwrap().content else {
            panic!("not a coding item");
        };
        assert_eq!(coding.reference[0].language, Language::Python);
        assert!(coding.reference[0].text.starts_with("print(sum"));
        assert_eq!(coding.examples[0].output, "3");
        assert_eq!(coding.tests.len(), 1);
        assert_eq!(coding.approach, "Add them up.");
        let report = pack.check(&NotRun).await;
        assert!(report.passed());
        assert_eq!(report.skipped()[0].path, "items/roll/item.md");
    }

    #[test]
    fn says_what_is_wrong_with_a_coding_items_files() {
        let pack = |extra: &[(&str, &str)], front: &str| {
            let item = CODING.replace("+++\nRoll", &format!("{front}+++\nRoll"));
            let mut entries = vec![
                ("pack.toml", MANIFEST),
                ("items/roll/reference.py", ""),
                ("items/roll/starter.py", ""),
                ("items/roll/brute.py", ""),
                ("items/roll/tests.toml", TESTS),
                ("items/roll/inputs.py", ""),
            ];
            entries.extend_from_slice(extra);
            let item = item.clone();
            let mut all = files(&entries);
            all.insert("items/roll/item.md".to_owned(), item.into_bytes());
            let pack = Pack::from_files(all).unwrap();
            pack.problems
                .first()
                .map(|p| p.message.clone())
                .unwrap_or_default()
        };
        assert_eq!(pack(&[], ""), "");
        assert!(pack(&[], "random_inputs = 0\n").contains("random_inputs"));
        assert!(
            pack(
                &[(
                    "items/roll/tests.toml",
                    "[[test]]\ninput = \"\"\noutput = \"\"\n"
                )],
                ""
            )
            .contains("[[example]]")
        );
        assert!(pack(&[("items/roll/tests.toml", "nonsense")], "").contains("tests.toml"));
        let flat =
            Pack::from_files(files(&[("pack.toml", MANIFEST), ("items/roll.md", CODING)])).unwrap();
        assert!(
            flat.problems[0].message.contains("directory of its own"),
            "{}",
            flat.problems[0]
        );
    }

    #[test]
    fn reads_the_examiners_styles() {
        let sample = Pack::sample();
        let ids: Vec<&str> = sample
            .examiner_styles
            .iter()
            .map(|s| s.id.as_str())
            .collect();
        assert_eq!(ids, ["steady", "probing"]);
        assert!(sample.examiner_styles[0].prompt.starts_with("Be steady"));

        let style = |id: &str, file: &str| {
            format!(
                "[[examiner_styles]]\nid = \"{id}\"\nname = \"N\"\ndescription = \"D\"\nprompt = \"{file}\"\n"
            )
        };
        let pack = Pack::from_files(files(&[
            (
                "pack.toml",
                &format!(
                    "{MANIFEST}{}{}",
                    style("kind", "prompts/kind.md"),
                    style("gone", "prompts/gone.md")
                ),
            ),
            ("prompts/kind.md", "  Be kind.\n"),
        ]))
        .unwrap();
        // A style whose add-on isn't there is left out, and said to be.
        assert_eq!(pack.examiner_styles.len(), 1);
        assert_eq!(pack.examiner_styles[0].prompt, "Be kind.");
        assert!(pack.problems[0].message.contains("\"gone\"'s add-on"));

        for (manifest, message) in [
            (
                format!("{MANIFEST}{}", style("Bad", "x.md")),
                "should be lowercase",
            ),
            (
                format!("{MANIFEST}{}{}", style("a", "x.md"), style("a", "y.md")),
                "listed twice",
            ),
        ] {
            let err = Manifest::parse(&manifest).unwrap_err();
            assert!(err.contains(message), "{err}");
        }
    }

    #[tokio::test]
    async fn leaves_out_items_that_cannot_be_read() {
        let card = "+++\nkind = \"card\"\nskills = [\"dice\"]\n+++\nQ\n## Answer\nA\n";
        let pack = Pack::from_files(files(&[
            (
                "pack.toml",
                &format!("{MANIFEST}[prompts]\ntutor = \"prompts/tutor.md\"\n"),
            ),
            ("items/a.md", card),
            ("items/b/a.md", card),
            ("items/broken.md", "no front matter"),
            (
                "drafts/good.md",
                "+++\nskills = [\"dice\"]\n+++\nWhat's a die?\n",
            ),
            ("drafts/Bad Name.md", "+++\nskills = []\n+++\nQ\n"),
        ]))
        .unwrap();
        assert_eq!(pack.items.len(), 1);
        assert_eq!(pack.drafts[0].id, "good");
        let problems: Vec<&str> = pack.problems.iter().map(|p| p.path.as_str()).collect();
        assert_eq!(
            problems,
            [
                "pack.toml",
                "items/b/a.md",
                "items/broken.md",
                "drafts/Bad Name.md"
            ]
        );
        assert!(pack.problems[1].message.contains("already items/a.md's"));
        assert!(!pack.check(&NotRun).await.passed());
        assert!(Pack::from_files(files(&[("items/a.md", card)])).is_err());
    }

    #[tokio::test]
    async fn checks_fail_for_wrong_answers() {
        let wrong = "+++\nkind = \"probability\"\nskills = [\"dice\"]\nanswer = \"1/2\"\n[simulation]\ntrials = 20000\ntolerance = 0.02\n+++\nWhat's the chance of a six?\n## Solution\nOne side in six.\n## Simulation\n```rhai\nrand_int(1, 6) == 6\n```\n";
        let same = "+++\nkind = \"mental-maths\"\nskills = [\"dice\"]\nanswer = \"a\"\n[params]\na = { choices = [1, 2] }\n+++\nWhat's {a}?\n";
        let pack = Pack::from_files(files(&[
            ("pack.toml", MANIFEST),
            ("items/wrong.md", wrong),
            ("items/same.md", same),
        ]))
        .unwrap();
        let report = pack.check(&NotRun).await;
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
