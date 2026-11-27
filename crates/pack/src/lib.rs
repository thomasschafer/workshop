//! Packs: directories of things to learn, each item a Markdown file, with the skills, tracks
//! and goals they belong to in `pack.toml`. See `docs/packs.md` for the format.
//!
//! Every item has a mechanical check, which `workshop pack check` runs: a probability item's
//! simulation must agree with its exact answer, and a mental maths template must make questions
//! with answers, for example.

pub mod api;
pub mod code;
pub mod diff;
pub mod drafts;
pub mod error_types;
mod item;
pub mod lesson;
mod manifest;
pub mod mental;
pub mod number;
pub mod output;
pub mod project;
pub mod script;
pub mod simulate;
pub mod svg;

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::{Context, Result};

pub use api::Api;
pub use code::{
    BruteForce, Case, Coding, Language, Part, PartWork, Question, Reading, ReadingCheck, Source,
    Work,
};
pub use drafts::Draft;
pub use error_types::ErrorType;
pub use item::{
    Content, DIFFICULTY, FollowUps, Item, Kind, MentalMaths, Param, Probability, Simulation,
    replace_section, split_front_matter,
};
pub use lesson::{
    Check, Guess, ImageData, Lesson, LessonImage, LessonRef, LessonSource, Segment, TopicRef,
};
pub use manifest::{Goal, Manifest, PackTrack, Prompts, Skill, Topic};
pub use project::{Defect, Project, ProjectFile, Review, Task};

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
            let read = |file: &str| read_item_bytes(&files, dir, file);
            let list = |sub: &str| list_item_dir(&files, dir, sub);
            let parsed = std::str::from_utf8(bytes)
                .map_err(|_| "it isn't UTF-8".to_owned())
                .and_then(|source| Item::parse_in(path, default_id, source, &manifest, read, list));
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
        self.check_where(|_| true, programs).await
    }

    /// Runs mechanical checks only on items whose paths are in `paths`, keeping the rest of the
    /// pack in place so cross-item references (such as `requires` and `lesson`) still resolve.
    pub async fn check_only(&self, paths: &BTreeSet<&str>, programs: &dyn Programs) -> Report {
        self.check_where(|item| paths.contains(item.path.as_str()), programs)
            .await
    }

    async fn check_where(&self, keep: impl Fn(&Item) -> bool, programs: &dyn Programs) -> Report {
        // At once, as building programs takes a while and each build is one process.
        let checks = self
            .items
            .iter()
            .filter(|item| keep(item))
            .map(|item| async move {
                let (verdict, warnings) = match check_item(item, self) {
                    Some(outcome) => outcome,
                    None => (programs.check(item).await, Vec::new()),
                };
                Checked {
                    path: item.path.clone(),
                    verdict,
                    warnings,
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

/// The raw bytes of a file an item refers to, relative to the item's own directory.
fn read_item_bytes(
    files: &BTreeMap<String, Vec<u8>>,
    dir: Option<&str>,
    file: &str,
) -> Result<Vec<u8>, String> {
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
    files
        .get(&format!("{dir}/{file}"))
        .cloned()
        .ok_or_else(|| format!("{file:?} isn't in the item's directory"))
}

/// The files directly in a directory of an item's own, by name. A directory inside it is a
/// mistake, as an item's directories of files, such as a project, keep them in one place.
fn list_item_dir(
    files: &BTreeMap<String, Vec<u8>>,
    dir: Option<&str>,
    sub: &str,
) -> Result<Vec<String>, String> {
    let Some(dir) = dir else {
        return Err(format!(
            "it refers to {sub:?}, so it needs a directory of its own, with an item.md"
        ));
    };
    if sub
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(format!(
            "{sub:?} should be a path inside the item's directory"
        ));
    }
    let prefix = format!("{dir}/{sub}/");
    let mut names = Vec::new();
    for path in files.keys() {
        let Some(name) = path.strip_prefix(&prefix) else {
            continue;
        };
        if name.contains('/') {
            return Err(format!(
                "{sub}/ should hold its files directly, and {sub}/{name} is in a directory inside it"
            ));
        }
        names.push(name.to_owned());
    }
    if names.is_empty() {
        return Err(format!(
            "{sub}/ isn't in the item's directory, where its front matter says it is"
        ));
    }
    Ok(names)
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
    /// Advice from the check that doesn't stop the item passing, such as a long lesson segment or
    /// a fixed SVG colour.
    pub warnings: Vec<String>,
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

    /// Warnings from checked items, which don't stop the pack from passing.
    pub fn warnings(&self) -> Vec<Problem> {
        self.items
            .iter()
            .flat_map(|item| {
                item.warnings.iter().map(move |message| Problem {
                    path: item.path.clone(),
                    message: message.clone(),
                })
            })
            .collect()
    }
}

/// An item's check, unless it's one of programs to build and run.
fn check_item(item: &Item, pack: &Pack) -> Option<(Verdict, Vec<String>)> {
    if let Err(err) = check_lesson_link(item, pack) {
        return Some((Verdict::Failed(err), Vec::new()));
    }
    match &item.content {
        Content::Coding(_) | Content::Reading(_) => None,
        Content::Lesson(lesson) => Some(check_lesson(item, lesson, pack)),
        _ => Some((check_without_programs(item).into(), Vec::new())),
    }
}

fn check_lesson_link(item: &Item, pack: &Pack) -> Result<(), String> {
    let Some(link) = &item.lesson else {
        return Ok(());
    };
    let Some(target) = pack.item(&link.id) else {
        return Err(format!("lesson {:?} isn't in the pack", link.id));
    };
    let Content::Lesson(lesson) = &target.content else {
        return Err(format!(
            "lesson {:?} is a {} item, not a lesson",
            link.id,
            item::kind_name(target.kind)
        ));
    };
    if let Some(seg) = link.segment
        && seg >= lesson.segments.len()
    {
        let count = lesson.segments.len();
        return Err(format!(
            "lesson {:?} has only {} {}, not segment {}",
            link.id,
            count,
            if count == 1 { "segment" } else { "segments" },
            seg + 1
        ));
    }
    Ok(())
}

fn check_lesson(item: &Item, lesson: &Lesson, pack: &Pack) -> (Verdict, Vec<String>) {
    let (mut errors, warnings) = lesson.check_self();
    for req in &lesson.requires {
        match pack.item(req) {
            None => errors.push(format!("requires {req:?}, which isn't in the pack")),
            Some(other) if other.kind != Kind::Lesson => errors.push(format!(
                "requires {req:?}, which is a {} item, not a lesson",
                item::kind_name(other.kind)
            )),
            Some(_) => {}
        }
    }
    if let Some(cycle) = requires_cycle(pack, &item.id) {
        errors.push(format!("requires forms a cycle: {}", cycle.join(" → ")));
    }
    let verdict = if errors.is_empty() {
        Verdict::Passed(lesson.summary())
    } else {
        Verdict::Failed(errors.join("; "))
    };
    (verdict, warnings)
}

/// If `start` lies on a `requires` cycle among lessons in `pack`, returns the lesson ids along
/// the cycle, starting and ending with `start`.
fn requires_cycle<'a>(pack: &'a Pack, start: &'a str) -> Option<Vec<&'a str>> {
    fn dfs<'a>(
        pack: &'a Pack,
        start: &'a str,
        current: &'a str,
        visited: &mut BTreeSet<&'a str>,
        path: &mut Vec<&'a str>,
    ) -> bool {
        let Some(item) = pack.item(current) else {
            return false;
        };
        let Content::Lesson(lesson) = &item.content else {
            return false;
        };
        for req in &lesson.requires {
            if req == start {
                path.push(start);
                return true;
            }
            if visited.insert(req.as_str()) {
                path.push(req.as_str());
                if dfs(pack, start, req.as_str(), visited, path) {
                    return true;
                }
                path.pop();
            }
        }
        false
    }
    let mut visited = BTreeSet::new();
    let mut path = vec![start];
    dfs(pack, start, start, &mut visited, &mut path).then_some(path)
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
        Content::Lesson(_) => unreachable!("checked by check_lesson"),
        // Reading it applied the change, and found each defect where it says.
        Content::Review(review) => Ok(format!(
            "the change to {} applies, and its {} {} where {} say{}",
            review
                .changed
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>()
                .join(", "),
            review.defects.len(),
            if review.defects.len() == 1 {
                "defect is"
            } else {
                "defects are"
            },
            if review.defects.len() == 1 {
                "it"
            } else {
                "they"
            },
            if review.defects.len() == 1 { "s" } else { "" },
        )),
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
        let warnings: Vec<String> = report.warnings().iter().map(ToString::to_string).collect();
        assert!(warnings.is_empty(), "{warnings:#?}");
        let lessons = pack.items.iter().filter(|i| i.kind == Kind::Lesson).count();
        assert!(lessons >= 1, "expected at least one sample lesson");
        assert_eq!(
            pack.item("binary-heap-costs").unwrap().lesson,
            Some(LessonRef {
                id: "binary-heaps".to_owned(),
                segment: Some(1),
            })
        );
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
        assert!((6..=10).contains(&coding), "{coding} coding items");
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
        // A task of each sort in a codebase: fixes and refactors run their projects, and a
        // review is checked by applying its change.
        for task in [Task::Fix, Task::Review, Task::Refactor] {
            let count = pack
                .items
                .iter()
                .filter(|i| match &i.content {
                    Content::Coding(coding) => coding.project().is_some_and(|p| p.task == task),
                    Content::Review(_) => task == Task::Review,
                    _ => false,
                })
                .count();
            assert_eq!(count, 1, "{count} codebase items to {task:?}");
            assert!(
                pack.items
                    .iter()
                    .all(|i| i.kind != Kind::Codebase || i.track == TrackId::Coding)
            );
        }
        let run = pack
            .items
            .iter()
            .filter(|i| i.kind == Kind::Codebase && matches!(i.content, Content::Coding(_)))
            .count();
        assert_eq!(report.skipped().len(), coding + reading + run);
    }

    #[tokio::test]
    async fn checks_how_many_follow_up_questions_each_card_offers() {
        let pack = Pack::from_files(files(&[
            ("pack.toml", MANIFEST),
            (
                "items/deeper.md",
                "+++\nkind = \"card\"\nskills = [\"dice\"]\nfollow_ups = 3\n+++\nQ\n## Answer\nA\n",
            ),
            (
                "items/too-deep.md",
                "+++\nkind = \"card\"\nskills = [\"dice\"]\nfollow_ups = 5\n+++\nQ\n## Answer\nA\n",
            ),
        ]))
        .unwrap();
        let report = pack.check(&NotRun).await;
        let failures: Vec<String> = report.failures().iter().map(ToString::to_string).collect();
        assert_eq!(failures.len(), 1, "{failures:#?}");
        assert!(failures[0].contains("items/too-deep.md"), "{failures:#?}");
        assert!(
            failures[0].contains("follow_ups should be from 0 to 3, not 5"),
            "{failures:#?}"
        );
        let Content::Card { follow_ups, .. } = &pack.item("deeper").unwrap().content else {
            panic!("not a card");
        };
        assert_eq!(follow_ups.get(), 3);
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
        let part = &coding.parts[0];
        assert_eq!(part.work.programs()[0].language, Language::Python);
        assert!(part.work.programs()[0].text.starts_with("print(sum"));
        assert_eq!(part.examples[0].output, "3");
        assert_eq!(part.tests.len(), 1);
        assert_eq!(part.prompt, "Roll some dice.");
        assert!(!coding.in_parts());
        assert_eq!(coding.api, None);
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

    fn lesson_file(requires: &[&str], segments: &[(&str, &str)]) -> String {
        let req = if requires.is_empty() {
            String::new()
        } else {
            let quoted: Vec<String> = requires.iter().map(|r| format!("{r:?}")).collect();
            format!("requires = [{}]\n", quoted.join(", "))
        };
        let body: String = segments
            .iter()
            .map(|(title, text)| format!("## {title}\n\n{text}\n\n"))
            .collect();
        format!(
            "+++\nkind = \"lesson\"\nskills = [\"dice\"]\n{req}[[sources]]\ntitle = \"Ref\"\nurl = \"https://example.com\"\n+++\nA short summary.\n\n{body}## Explain\n\nWhy?\n\n## Explain answer\n\nBecause.\n"
        )
    }

    #[tokio::test]
    async fn checks_lesson_word_counts_and_svg_colour_warnings() {
        let words = |n: usize| vec!["word"; n].join(" ");
        let ok_svg = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><line x1="0" y1="0" x2="10" y2="10" stroke="currentColor"/></svg>"#;
        let fixed_svg = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><line x1="0" y1="0" x2="10" y2="10" stroke="#000"/><text x="5" y="20" fill="black">Hi</text></svg>"##;

        let ok = Pack::from_files(files(&[
            ("pack.toml", MANIFEST),
            (
                "items/ok/item.md",
                &lesson_file(
                    &[],
                    &[(
                        "Right size",
                        &format!("{}\n\n![Diagram](a.svg)", words(180)),
                    )],
                ),
            ),
            ("items/ok/a.svg", ok_svg),
        ]))
        .unwrap();
        let report = ok.check(&NotRun).await;
        assert!(report.passed(), "{:?}", report.failures());
        assert!(report.warnings().is_empty(), "{:?}", report.warnings());

        let warned = Pack::from_files(files(&[
            ("pack.toml", MANIFEST),
            (
                "items/long/item.md",
                &lesson_file(
                    &[],
                    &[
                        ("Getting long", &words(181)),
                        (
                            "At limit",
                            &format!("{}\n\n![Fixed](fixed.svg)", words(300)),
                        ),
                    ],
                ),
            ),
            ("items/long/fixed.svg", fixed_svg),
        ]))
        .unwrap();
        let report = warned.check(&NotRun).await;
        assert!(report.passed(), "{:?}", report.failures());
        let warnings: Vec<String> = report
            .warnings()
            .iter()
            .map(|w| w.message.clone())
            .collect();
        assert_eq!(warnings.len(), 3, "{warnings:#?}");
        assert!(warnings[0].contains("181 words"), "{warnings:#?}");
        assert!(warnings[1].contains("300 words"), "{warnings:#?}");
        assert!(
            warnings[2].contains("fixed.svg") && warnings[2].contains("currentColor"),
            "{warnings:#?}"
        );

        let too_long = Pack::from_files(files(&[
            ("pack.toml", MANIFEST),
            (
                "items/huge.md",
                &lesson_file(&[], &[("Too long", &words(301))]),
            ),
        ]))
        .unwrap();
        let report = too_long.check(&NotRun).await;
        assert!(!report.passed());
        assert!(
            report.failures()[0].message.contains("301 words")
                && report.failures()[0]
                    .message
                    .contains("over the limit of 300"),
            "{:?}",
            report.failures()
        );
    }

    #[tokio::test]
    async fn checks_the_topics_lessons_teach() {
        let manifest =
            format!("{MANIFEST}topics = [{{ id = \"two-dice\", name = \"Two dice\" }}]\n");
        let with_topic = |topic: &str| {
            lesson_file(&[], &[("One", "Text.")]).replacen(
                "+++\n",
                &format!("+++\ntopic = \"{topic}\"\n"),
                1,
            )
        };
        let pack = Pack::from_files(files(&[
            ("pack.toml", &manifest),
            ("items/taught.md", &with_topic("dice/two-dice")),
            ("items/also-taught.md", &with_topic("dice/two-dice")),
            ("items/untaught.md", &with_topic("dice/three-dice")),
        ]))
        .unwrap();
        let report = pack.check(&NotRun).await;
        let failures = report.failures();
        assert_eq!(failures.len(), 1, "{failures:?}");
        assert_eq!(failures[0].path, "items/untaught.md");
        assert!(
            failures[0]
                .message
                .contains("isn't one of the topics of \"dice\""),
            "{failures:?}"
        );
    }

    #[tokio::test]
    async fn checks_lesson_requires_cycles_and_item_links() {
        let card = "+++\nkind = \"card\"\nskills = [\"dice\"]\n+++\nQ\n## Answer\nA\n";
        let linked = |lesson: &str, segment: Option<usize>| {
            let seg = segment.map_or(String::new(), |n| format!("segment = {n}\n"));
            format!(
                "+++\nkind = \"card\"\nskills = [\"dice\"]\nlesson = \"{lesson}\"\n{seg}+++\nQ\n## Answer\nA\n"
            )
        };

        // Valid DAG (diamond) and valid card links pass, including through `check_only`.
        let good = Pack::from_files(files(&[
            ("pack.toml", MANIFEST),
            ("items/d.md", &lesson_file(&[], &[("One", "Base.")])),
            ("items/b.md", &lesson_file(&["d"], &[("One", "B.")])),
            ("items/c.md", &lesson_file(&["d"], &[("One", "C.")])),
            (
                "items/a.md",
                &lesson_file(&["b", "c"], &[("One", "A1."), ("Two", "A2.")]),
            ),
            ("items/card-ok.md", &linked("a", Some(2))),
        ]))
        .unwrap();
        let report = good.check(&NotRun).await;
        assert!(report.passed(), "{:?}", report.failures());
        let only = BTreeSet::from(["items/card-ok.md"]);
        let partial = good.check_only(&only, &NotRun).await;
        assert!(partial.passed(), "{:?}", partial.failures());
        assert_eq!(partial.items.len(), 1);

        // Missing target, non-lesson target, cycles, and bad item links all fail.
        let reading_bad = "+++\nkind = \"reading\"\nskills = [\"dice\"]\nlesson = \"missing\"\nprints = \"1\"\n+++\nWhat?\n\n```python\nprint(1)\n```\n\n## Explanation\nOne.\n";
        let broken = Pack::from_files(files(&[
            ("pack.toml", MANIFEST),
            ("items/plain-card.md", card),
            (
                "items/self-loop.md",
                &lesson_file(&["self-loop"], &[("One", "Self.")]),
            ),
            ("items/cyc-a.md", &lesson_file(&["cyc-b"], &[("One", "A.")])),
            ("items/cyc-b.md", &lesson_file(&["cyc-c"], &[("One", "B.")])),
            ("items/cyc-c.md", &lesson_file(&["cyc-a"], &[("One", "C.")])),
            (
                "items/req-missing.md",
                &lesson_file(&["nope"], &[("One", "M.")]),
            ),
            (
                "items/req-card.md",
                &lesson_file(&["plain-card"], &[("One", "N.")]),
            ),
            ("items/card-missing.md", &linked("nope", None)),
            ("items/card-not-lesson.md", &linked("plain-card", None)),
            ("items/card-bad-seg.md", &linked("cyc-a", Some(2))),
            ("items/reading-bad.md", reading_bad),
        ]))
        .unwrap();
        let report = broken.check(&NotRun).await;
        let by_path: BTreeMap<&str, &str> = report
            .items
            .iter()
            .filter_map(|c| match &c.verdict {
                Verdict::Failed(msg) => Some((c.path.as_str(), msg.as_str())),
                _ => None,
            })
            .collect();
        assert!(
            by_path["items/self-loop.md"].contains("cycle: self-loop → self-loop"),
            "{by_path:#?}"
        );
        assert!(
            by_path["items/cyc-a.md"].contains("cycle: cyc-a → cyc-b → cyc-c → cyc-a"),
            "{by_path:#?}"
        );
        assert!(
            by_path["items/req-missing.md"].contains("isn't in the pack"),
            "{by_path:#?}"
        );
        assert!(
            by_path["items/req-card.md"].contains("card item, not a lesson"),
            "{by_path:#?}"
        );
        assert!(
            by_path["items/card-missing.md"].contains("isn't in the pack"),
            "{by_path:#?}"
        );
        assert!(
            by_path["items/card-not-lesson.md"].contains("card item, not a lesson"),
            "{by_path:#?}"
        );
        assert!(
            by_path["items/card-bad-seg.md"].contains("only 1 segment, not segment 2"),
            "{by_path:#?}"
        );
        assert!(
            by_path["items/reading-bad.md"].contains("isn't in the pack"),
            "{by_path:#?}"
        );
    }
}
