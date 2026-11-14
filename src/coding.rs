//! The Coding track: problems from packs, solved in a chain of short steps, and code to read.
//!
//! A problem is worked through in steps of a few minutes each: understanding it, by working out
//! what an example prints; planning, in words; coding, in the editor; testing, by submitting it
//! to the hidden tests and a brute force's answers; and reviewing, by comparing it with how it's
//! meant to be solved and saying how it went. Each step is saved as it's done, and the code as
//! it's typed, so the learner can stop at any moment and carry on from there, on any device.
//!
//! When a problem comes back for review it's usually to recall the approach, which takes a few
//! minutes rather than solving it again: writing down how to solve it, then comparing that with
//! the item's approach. A problem the learner couldn't solve last time is solved again instead,
//! and they can always choose to.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use workshop_learning::{Attempt, Rating, TrackPlan};
use workshop_pack::{Case, Coding, Content, Item, Kind, Language, Pack};
use workshop_tracks::{Priority, Step, Track, TrackId};

use crate::config::Config;
use crate::learning::{Planned, Week};
use crate::paths::Paths;
use crate::tracks::Destination;
use crate::workspace::{SaveError, VersionedFile, read_versioned, save_versioned};

/// How long a solution may run on one input. Shorter than for Advent of Code, as the inputs are
/// small, and a solution stuck in a loop shouldn't keep the learner waiting long.
const RUN_TIMEOUT: Duration = Duration::from_secs(10);

/// How many random inputs a submission is compared with the brute force on.
pub const SUBMIT_RANDOM_INPUTS: u32 = 30;

/// The longest time between two saves of a problem that counts as time spent on it, so a
/// problem left open while the learner does something else counts for no more.
const MAX_GAP_MS: i64 = 2 * 60 * 1000;

/// Where and how coding items' programs are built and run: in Workshop's build directory, with
/// the solutions' toolchain, if mise provides one.
pub async fn runtime(config: &Config, paths: &Paths) -> Result<workshop_coding::Runtime> {
    let toolchain = workshop_toolchain::toolchain::Toolchain::load(&config.solutions_dir).await?;
    let build_timeout = Duration::from_secs(config.run.timeout_secs);
    Ok(workshop_coding::Runtime {
        scratch: paths.build_dir().join("coding"),
        environment: toolchain.overlay(Vec::new()),
        build_timeout,
        run_timeout: RUN_TIMEOUT.min(build_timeout),
    })
}

/// One of a problem's steps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepName {
    Understand,
    Plan,
    Code,
    Test,
    Review,
}

impl StepName {
    fn describe(self) -> &'static str {
        match self {
            Self::Understand => "understanding it",
            Self::Plan => "planning",
            Self::Code => "coding",
            Self::Test => "testing",
            Self::Review => "reviewing",
        }
    }
}

/// How a problem is gone through this time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// Every step, from understanding it to reviewing the solution.
    Solve,
    /// Writing down how to solve it, from memory, then comparing that with its approach.
    Recall,
}

impl Mode {
    pub fn steps(self) -> &'static [StepName] {
        match self {
            Self::Solve => &[
                StepName::Understand,
                StepName::Plan,
                StepName::Code,
                StepName::Test,
                StepName::Review,
            ],
            Self::Recall => &[StepName::Plan, StepName::Review],
        }
    }
}

/// Where the learner is with a problem, saved as each step goes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Session {
    pub mode: Mode,
    pub step: StepName,
    /// The language they're solving it in.
    pub language: Language,
    /// What they worked out the first example prints, while understanding it.
    #[serde(default)]
    pub prediction: Option<String>,
    /// How they mean to solve it, typed or dictated.
    #[serde(default)]
    pub plan: String,
    /// Whether their code has passed every test.
    #[serde(default)]
    pub passed: bool,
    #[serde(default)]
    pub runs: u32,
    #[serde(default)]
    pub submissions: u32,
    /// How many hints they've asked for, from the pack or the tutor.
    #[serde(default)]
    pub hints: u32,
    /// When it was started, and last saved, in milliseconds since 1970.
    pub started_at: i64,
    pub updated_at: i64,
}

impl Session {
    fn check(&self, coding: &Coding) -> Result<(), String> {
        if !self.mode.steps().contains(&self.step) {
            return Err(format!(
                "{} isn't a step when recalling a problem",
                self.step.describe()
            ));
        }
        if !coding.languages.contains(&self.language) {
            return Err(format!(
                "this problem can't be solved in {}",
                self.language.name()
            ));
        }
        Ok(())
    }
}

/// The Coding track's items, and where each one is.
#[derive(Debug, Serialize)]
pub struct Overview {
    pub items: Vec<Listed>,
    pub week: Week,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Started and not finished.
    InProgress,
    Due,
    New,
    /// Done, and not due again yet.
    Done,
    /// Flagged as wrong.
    Flagged,
}

#[derive(Debug, Serialize)]
pub struct Listed {
    pub key: String,
    pub kind: Kind,
    pub label: String,
    pub skills: Vec<String>,
    pub minutes: u32,
    pub status: Status,
    /// The step it's at, if it's in progress.
    pub step: Option<StepName>,
    pub mode: Option<Mode>,
}

/// A problem, as the app shows it: everything but its hidden tests, and its solution only once
/// it's being reviewed.
#[derive(Debug, Serialize)]
pub struct Opened {
    pub key: String,
    pub label: String,
    /// In Markdown.
    pub prompt: String,
    pub skills: Vec<String>,
    pub source: Option<String>,
    pub minutes: u32,
    pub examples: Vec<Case>,
    /// The pack's hints, from gentlest to most telling, which the app shows one at a time.
    pub hints: Vec<String>,
    pub languages: Vec<OpenedLanguage>,
    pub session: Session,
    /// How they planned to solve it last time, for comparing with when recalling it.
    pub previous_plan: Option<String>,
    pub solution: Option<Solution>,
}

#[derive(Debug, Serialize)]
pub struct OpenedLanguage {
    pub id: Language,
    pub name: &'static str,
    /// Syntax highlighting, from the language's profile.
    pub editor_mode: String,
    pub code: VersionedFile,
    /// The language server, if the language has one.
    pub lsp: Option<OpenedLsp>,
}

#[derive(Debug, Serialize)]
pub struct OpenedLsp {
    pub root_uri: String,
    pub file_uri: String,
    pub language_id: String,
    pub options: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct Solution {
    pub approach: String,
    pub notes: Option<String>,
    pub reference: Vec<Reference>,
}

#[derive(Debug, Serialize)]
pub struct Reference {
    pub language: Language,
    pub text: String,
}

/// The problems' sessions and code drafts, kept in Workshop's data directory.
pub struct Problems {
    dir: PathBuf,
    /// Held while saving a draft, so two saves from the same version can't both succeed.
    save_lock: std::sync::Mutex<()>,
}

/// A problem found in the packs.
pub struct Found<'a> {
    pub pack: &'a Pack,
    pub item: &'a Item,
    pub coding: &'a Coding,
}

impl Found<'_> {
    pub fn key(&self) -> String {
        format!("{}/{}", self.pack.manifest.id, self.item.id)
    }
}

/// The coding problem with this key in the packs.
pub fn find<'a>(packs: &'a [Pack], pack: &str, item: &str) -> Result<Found<'a>> {
    let found = packs
        .iter()
        .find(|p| p.manifest.id == pack)
        .and_then(|p| p.item(item).map(|item| (p, item)));
    let Some((pack, item)) = found else {
        bail!("there's no item {pack}/{item}");
    };
    match &item.content {
        Content::Coding(coding) => Ok(Found { pack, item, coding }),
        _ => bail!("{}/{} isn't a coding problem", pack.manifest.id, item.id),
    }
}

impl Problems {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.join("coding"),
            save_lock: std::sync::Mutex::new(()),
        }
    }

    fn session_path(&self, key: &str) -> PathBuf {
        self.dir.join("sessions").join(format!("{key}.json"))
    }

    /// Where a language's drafts are, which its language server is started in.
    pub fn root(&self, language: Language) -> PathBuf {
        self.dir.join(language.id())
    }

    /// The file a problem's draft in a language is kept in.
    fn draft_path(&self, key: &str, language: Language) -> PathBuf {
        let (pack, item) = key.split_once('/').expect("keys are pack/item");
        match language {
            // One Cargo package, of which each draft is a binary, so the language server sees
            // them all as one project.
            Language::Rust => self
                .root(language)
                .join("src")
                .join("bin")
                .join(format!("{pack}-{item}.rs")),
            _ => self
                .root(language)
                .join(pack)
                .join(format!("{item}.{}", language.extension())),
        }
    }

    /// The files that make a language's drafts a project, for its language server.
    fn ensure_project(&self, language: Language) -> Result<()> {
        if language != Language::Rust {
            return Ok(());
        }
        let manifest = self.root(language).join("Cargo.toml");
        if !manifest.exists() {
            std::fs::create_dir_all(self.root(language))?;
            workshop_common::files::write_atomic(&manifest, RUST_PROJECT.as_bytes())?;
        }
        Ok(())
    }

    pub fn session(&self, key: &str) -> Result<Option<Session>> {
        let path = self.session_path(key);
        match std::fs::read_to_string(&path) {
            Ok(text) => Ok(Some(
                serde_json::from_str(&text)
                    .with_context(|| format!("reading {}", path.display()))?,
            )),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err).with_context(|| format!("reading {}", path.display())),
        }
    }

    /// Every session in progress, by item.
    pub fn sessions(&self) -> Result<BTreeMap<String, Session>> {
        let mut sessions = BTreeMap::new();
        let root = self.dir.join("sessions");
        let Ok(packs) = std::fs::read_dir(&root) else {
            return Ok(sessions);
        };
        for pack in packs {
            let pack = pack?;
            for file in std::fs::read_dir(pack.path())? {
                let name = file?.file_name().to_string_lossy().into_owned();
                if let Some(item) = name.strip_suffix(".json") {
                    let key = format!("{}/{item}", pack.file_name().to_string_lossy());
                    if let Some(session) = self.session(&key)? {
                        sessions.insert(key, session);
                    }
                }
            }
        }
        Ok(sessions)
    }

    fn write_session(&self, key: &str, session: &Session) -> Result<()> {
        let path = self.session_path(key);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let json = serde_json::to_string_pretty(session)?;
        workshop_common::files::write_atomic(&path, json.as_bytes())
    }

    /// Saves where the learner is with a problem, as long as it's somewhere the problem has.
    /// Returns it as saved, and the time spent on it since it was last saved.
    pub fn save_session(
        &self,
        found: &Found<'_>,
        mut session: Session,
        now: i64,
    ) -> Result<(Session, i64)> {
        session.check(found.coding).map_err(anyhow::Error::msg)?;
        let key = found.key();
        let before = self
            .session(&key)?
            .context("the problem hasn't been started, or it's been finished")?;
        session.started_at = before.started_at;
        session.updated_at = now;
        self.write_session(&key, &session)?;
        Ok((session, spent(&before, now)))
    }

    /// Notes that the learner is working on a problem, such as by typing its code. Returns the
    /// time spent on it since it was last saved.
    pub fn touch(&self, key: &str, now: i64) -> Result<i64> {
        let Some(mut session) = self.session(key)? else {
            return Ok(0);
        };
        let spent = spent(&session, now);
        session.updated_at = now;
        self.write_session(key, &session)?;
        Ok(spent)
    }

    /// Starts a problem, or carries on with it: a solve the first time, or if it went badly
    /// last time, and otherwise a recall, unless the learner asks for a solve.
    pub fn start(
        &self,
        found: &Found<'_>,
        attempts: &[Attempt],
        solve: bool,
        now: i64,
    ) -> Result<Session> {
        let key = found.key();
        if let Some(session) = self.session(&key)?
            && !(solve && session.mode == Mode::Recall)
        {
            return Ok(session);
        }
        let recall = !solve
            && attempts
                .last()
                .is_some_and(|last| last.rating != Rating::Again);
        let mode = if recall { Mode::Recall } else { Mode::Solve };
        let session = Session {
            mode,
            step: mode.steps()[0],
            language: found.coding.languages[0],
            prediction: None,
            plan: String::new(),
            passed: false,
            runs: 0,
            submissions: 0,
            hints: 0,
            started_at: now,
            updated_at: now,
        };
        self.write_session(&key, &session)?;
        Ok(session)
    }

    /// Ends a problem's session, once its attempt is recorded.
    pub fn finish(&self, key: &str) -> Result<()> {
        match std::fs::remove_file(self.session_path(key)) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err.into()),
        }
    }

    /// A problem's draft in a language, starting from the item's starter the first time.
    pub fn draft(&self, found: &Found<'_>, language: Language) -> Result<VersionedFile> {
        let path = self.draft_path(&found.key(), language);
        self.ensure_project(language)?;
        if !path.exists() {
            let starter = found
                .coding
                .starter_in(language)
                .with_context(|| format!("there's no starter in {}", language.name()))?;
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            workshop_common::files::write_atomic(&path, starter.text.as_bytes())?;
        }
        read_versioned(&path)
    }

    pub fn save_draft(
        &self,
        found: &Found<'_>,
        language: Language,
        text: &str,
        version: &str,
    ) -> Result<VersionedFile, SaveError> {
        if !found.coding.languages.contains(&language) {
            return Err(SaveError::Other(anyhow::anyhow!(
                "this problem can't be solved in {}",
                language.name()
            )));
        }
        let path = self.draft_path(&found.key(), language);
        self.ensure_project(language)?;
        save_versioned(&self.save_lock, &path, text, version)
    }

    /// Everything the app needs to show a problem at its current step.
    pub fn open(
        &self,
        config: &Config,
        found: &Found<'_>,
        session: Session,
        attempts: &[Attempt],
    ) -> Result<Opened> {
        let item = found.item;
        let coding = found.coding;
        let languages = coding
            .languages
            .iter()
            .map(|&language| {
                let code = self.draft(found, language)?;
                let profile = config.languages.get(language.id());
                let lsp = profile
                    .filter(|p| p.lsp.is_some())
                    .map(|profile| OpenedLsp {
                        root_uri: crate::server::file_uri(&self.root(language)),
                        file_uri: crate::server::file_uri(&code.path),
                        language_id: profile.lsp_language_id.clone(),
                        options: profile.lsp_options.clone(),
                    });
                Ok(OpenedLanguage {
                    id: language,
                    name: language.name(),
                    editor_mode: profile.map_or_else(
                        || language.id().to_owned(),
                        |profile| profile.editor_mode.clone(),
                    ),
                    code,
                    lsp,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let solution = (session.step == StepName::Review).then(|| Solution {
            approach: coding.approach.clone(),
            notes: coding.notes.clone(),
            reference: coding
                .reference
                .iter()
                .map(|source| Reference {
                    language: source.language,
                    text: source.text.clone(),
                })
                .collect(),
        });
        Ok(Opened {
            key: found.key(),
            label: item.label(),
            prompt: item.prompt.clone(),
            skills: item.skills.clone(),
            source: item.source.clone(),
            minutes: item.minutes,
            examples: coding.examples.clone(),
            hints: coding.hints.clone(),
            languages,
            session,
            previous_plan: attempts
                .iter()
                .rev()
                .find_map(|attempt| attempt.response.clone()),
            solution,
        })
    }
}

/// The time between a session's last save and now that counts as time spent on it.
fn spent(session: &Session, now: i64) -> i64 {
    (now - session.updated_at).clamp(0, MAX_GAP_MS)
}

/// The Cargo package Rust drafts are binaries of, for rust-analyzer.
const RUST_PROJECT: &str = r#"# Drafts of coding problems, each a binary of this package, for the language server.
[package]
name = "drafts"
version = "0.1.0"
edition = "2024"

[dependencies]

# Unfinished solutions are full of code that isn't used yet.
[lints.rust]
dead_code = "allow"
unused_variables = "allow"
unused_imports = "allow"
"#;

/// The Coding track's items, from the plan: problems and code to read.
pub fn overview(
    planned: &Planned,
    sessions: &BTreeMap<String, Session>,
    flags: &BTreeMap<String, workshop_learning::Flag>,
) -> Overview {
    let plan = planned.plans.get(&TrackId::Coding);
    let items = coding_items(planned)
        .map(|(key, item)| {
            let session = sessions.get(&key);
            let status = if flags.contains_key(&key) {
                Status::Flagged
            } else if session.is_some() {
                Status::InProgress
            } else if plan.is_some_and(|plan| plan.due.contains(&key)) {
                Status::Due
            } else if plan.is_some_and(|plan| plan.new.contains(&key)) {
                Status::New
            } else {
                Status::Done
            };
            Listed {
                kind: item.kind,
                label: item.label(),
                skills: item.skills.clone(),
                minutes: item.minutes,
                status,
                step: session.map(|s| s.step),
                mode: session.map(|s| s.mode),
                key,
            }
        })
        .collect();
    Overview {
        items,
        week: planned.week,
    }
}

fn coding_items(planned: &Planned) -> impl Iterator<Item = (String, &Item)> {
    planned.packs.iter().flat_map(|pack| {
        pack.items
            .iter()
            .filter(|item| {
                item.track == TrackId::Coding && matches!(item.kind, Kind::Coding | Kind::Reading)
            })
            .map(move |item| (format!("{}/{}", pack.manifest.id, item.id), item))
    })
}

/// The Coding track on the home screen, if there's anything in it.
pub fn track(
    planned: &Planned,
    sessions: &BTreeMap<String, Session>,
) -> Option<Track<Destination>> {
    let plan = planned.plans.get(&TrackId::Coding)?;
    let labels: BTreeMap<String, &Item> = coding_items(planned).collect();
    let label = |key: &str| {
        labels
            .get(key)
            .map_or_else(|| key.to_owned(), |item| item.label())
    };
    let open = |key: &str| Destination::Coding {
        item: Some(key.to_owned()),
    };
    // The problem worked on most recently, of those still in the packs.
    let unfinished = sessions
        .iter()
        .filter(|(key, _)| labels.contains_key(*key))
        .max_by_key(|(_, session)| session.updated_at);
    let next = if let Some((key, session)) = unfinished {
        Some(Step {
            title: label(key),
            reason: format!("Where you left off, {}", session.step.describe()),
            priority: Priority::Unfinished,
            destination: open(key),
        })
    } else if let Some(key) = plan.due.first() {
        let recall = labels
            .get(key)
            .is_some_and(|item| item.kind == Kind::Coding);
        Some(Step {
            title: label(key),
            reason: if recall {
                "Due for review: recall how to solve it".to_owned()
            } else {
                "Due for review".to_owned()
            },
            priority: Priority::Due,
            destination: open(key),
        })
    } else {
        plan.new.first().map(|key| Step {
            title: label(key),
            reason: "Something new".to_owned(),
            // Once the week's target is met, new items wait behind anything else to do.
            priority: if planned.week.minutes >= planned.week.target {
                Priority::Browse
            } else {
                Priority::New
            },
            destination: open(key),
        })
    };
    Some(Track::built_in(
        TrackId::Coding,
        summary(
            plan,
            sessions.keys().filter(|k| labels.contains_key(*k)).count(),
        ),
        Destination::Coding { item: None },
        next,
    ))
}

fn summary(plan: &TrackPlan, in_progress: usize) -> String {
    let mut parts = Vec::new();
    if in_progress > 0 {
        parts.push(format!("{in_progress} in progress"));
    }
    if !plan.due.is_empty() {
        parts.push(format!("{} due", plan.due.len()));
    }
    if !plan.new.is_empty() {
        parts.push(format!("{} new", plan.new.len()));
    }
    if parts.is_empty() {
        parts.push("Nothing due".to_owned());
    }
    parts.join(" · ")
}

#[cfg(test)]
mod tests {
    use workshop_learning::Clock;

    use super::*;
    use crate::config::LearningConfig;
    use crate::learning::Learning;

    const NOW: i64 = 1_790_000_000_000;

    fn clock(now: i64) -> Clock {
        Clock {
            now,
            utc_offset_minutes: 0,
        }
    }

    fn learning(dir: &Path) -> Learning {
        let config = LearningConfig {
            packs: Vec::new(),
            daily_reviews: 40,
            weekly_minutes: 90,
            desired_retention: 0.9,
        };
        Learning::open(&config, dir).unwrap()
    }

    fn attempt(id: &str, at: i64, rating: Rating, plan: &str) -> Attempt {
        Attempt {
            id: format!("attempt-{id}"),
            item: "sample/pair-sums".to_owned(),
            answered_at: at,
            duration_ms: 600_000,
            rating,
            response: Some(plan.to_owned()),
            seed: None,
        }
    }

    #[test]
    fn keeps_where_the_learner_is_and_their_code() {
        let dir = tempfile::tempdir().unwrap();
        let packs = vec![Pack::sample()];
        let found = find(&packs, "sample", "pair-sums").unwrap();
        let problems = Problems::new(dir.path());
        let mut session = problems.start(&found, &[], false, NOW).unwrap();
        assert_eq!(
            (session.mode, session.step),
            (Mode::Solve, StepName::Understand)
        );
        assert_eq!(session.language, Language::Python);

        session.step = StepName::Plan;
        session.plan = "Count what I've seen in a map".to_owned();
        let (saved, spent) = problems
            .save_session(&found, session.clone(), NOW + 5)
            .unwrap();
        assert_eq!(saved.updated_at, NOW + 5);
        assert_eq!(spent, 5);
        // Left for an hour, it only counts for a couple of minutes.
        assert_eq!(
            problems.touch(&found.key(), NOW + 3_600_000).unwrap(),
            MAX_GAP_MS
        );
        let saved = problems.session(&found.key()).unwrap().unwrap();
        // Starting again carries on where it was left.
        assert_eq!(problems.start(&found, &[], false, NOW + 9).unwrap(), saved);
        assert_eq!(problems.sessions().unwrap().len(), 1);

        let recall = Session {
            mode: Mode::Recall,
            step: StepName::Code,
            ..saved.clone()
        };
        assert!(problems.save_session(&found, recall, NOW).is_err());
        let cpp = Session {
            language: Language::Cpp,
            ..saved
        };
        assert!(problems.save_session(&found, cpp, NOW).is_err());

        let draft = problems.draft(&found, Language::Rust).unwrap();
        assert!(draft.text.contains("fn count_pairs"));
        assert!(draft.path.ends_with("rust/src/bin/sample-pair-sums.rs"));
        assert!(dir.path().join("coding/rust/Cargo.toml").is_file());
        let saved = problems
            .save_draft(&found, Language::Rust, "fn main() {}", &draft.version)
            .unwrap();
        assert_eq!(saved.text, "fn main() {}\n");
        // A save based on the old version is refused, rather than losing the newer one.
        assert!(matches!(
            problems.save_draft(&found, Language::Rust, "fn main() {}", &draft.version),
            Err(SaveError::Conflict { .. })
        ));
        assert_eq!(
            problems.draft(&found, Language::Rust).unwrap().text,
            "fn main() {}\n"
        );

        problems.finish(&found.key()).unwrap();
        assert!(problems.sessions().unwrap().is_empty());
    }

    #[test]
    fn recalls_a_problem_solved_before_unless_it_went_badly() {
        let dir = tempfile::tempdir().unwrap();
        let packs = vec![Pack::sample()];
        let found = find(&packs, "sample", "pair-sums").unwrap();
        let problems = Problems::new(dir.path());
        let solved = [attempt("1", NOW, Rating::Good, "A map of counts")];
        let session = problems.start(&found, &solved, false, NOW).unwrap();
        assert_eq!((session.mode, session.step), (Mode::Recall, StepName::Plan));
        // Choosing to solve it starts it over as a solve.
        let session = problems.start(&found, &solved, true, NOW).unwrap();
        assert_eq!(session.mode, Mode::Solve);
        problems.finish(&found.key()).unwrap();

        let failed = [
            attempt("1", NOW, Rating::Good, "A map of counts"),
            attempt("2", NOW + 1, Rating::Again, ""),
        ];
        let session = problems.start(&found, &failed, false, NOW).unwrap();
        assert_eq!(session.mode, Mode::Solve);
        let config = Config::parse("").unwrap();
        let opened = problems.open(&config, &found, session, &failed).unwrap();
        assert_eq!(opened.previous_plan.as_deref(), Some(""));
        assert!(opened.solution.is_none());
        assert_eq!(opened.examples.len(), 2);
        assert_eq!(opened.languages.len(), 2);
        assert!(opened.hints.len() >= 2);
        let rust = &opened.languages[1];
        assert_eq!(rust.id, Language::Rust);
        assert!(
            rust.lsp
                .as_ref()
                .unwrap()
                .root_uri
                .ends_with("/coding/rust")
        );
    }

    #[test]
    fn shows_the_solution_only_once_its_being_reviewed() {
        let dir = tempfile::tempdir().unwrap();
        let packs = vec![Pack::sample()];
        let found = find(&packs, "sample", "islands").unwrap();
        let problems = Problems::new(dir.path());
        let mut session = problems.start(&found, &[], false, NOW).unwrap();
        session.step = StepName::Review;
        let config = Config::parse("").unwrap();
        let opened = problems.open(&config, &found, session, &[]).unwrap();
        let solution = opened.solution.unwrap();
        assert!(solution.approach.contains("breadth-first"));
        assert_eq!(solution.reference.len(), 2);
        assert!(find(&packs, "sample", "times-eleven").is_err());
        assert!(find(&packs, "sample", "nothing").is_err());
    }

    #[test]
    fn continues_with_the_problem_left_part_way_through() {
        let dir = tempfile::tempdir().unwrap();
        let learning = learning(dir.path());
        let planned = learning.planned(clock(NOW)).unwrap();
        let none = BTreeMap::new();
        let track = track(&planned, &none).unwrap();
        assert_eq!(track.name, "Coding");
        assert_eq!(track.summary, "11 new");
        let next = track.next.unwrap();
        assert_eq!(next.priority, Priority::New);
        assert_eq!(
            next.destination,
            Destination::Coding {
                item: Some("sample/common-subsequence".to_owned())
            }
        );

        let packs = vec![Pack::sample()];
        let found = find(&packs, "sample", "islands").unwrap();
        let problems = Problems::new(dir.path());
        let mut session = problems.start(&found, &[], false, NOW).unwrap();
        session.step = StepName::Code;
        problems.save_session(&found, session, NOW).unwrap();
        let sessions = problems.sessions().unwrap();
        let track = super::track(&planned, &sessions).unwrap();
        assert_eq!(track.summary, "1 in progress · 11 new");
        let next = track.next.unwrap();
        assert_eq!(next.priority, Priority::Unfinished);
        assert_eq!(next.title, "Count the islands");
        assert_eq!(next.reason, "Where you left off, coding");

        let overview = overview(&planned, &sessions, &BTreeMap::new());
        let islands = overview
            .items
            .iter()
            .find(|item| item.key == "sample/islands")
            .unwrap();
        assert_eq!(islands.status, Status::InProgress);
        assert_eq!(islands.step, Some(StepName::Code));
        assert_eq!(overview.items.len(), 11);
        assert!(
            overview
                .items
                .iter()
                .any(|item| item.kind == Kind::Reading && item.status == Status::New)
        );
    }
}
