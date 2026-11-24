//! The Coding track: problems from packs, solved in a chain of short steps, and code to read.
//!
//! A problem is worked through in steps of a few minutes each: understanding it, by working out
//! what an example prints; planning, in words; coding, in the editor; testing, by submitting it
//! to the hidden tests and a brute force's answers; and reviewing, by comparing it with how it's
//! meant to be solved and saying how it went. Each step is saved as it's done, and the code as
//! it's typed, so the learner can stop at any moment and carry on from there, on any device.
//!
//! When a problem comes back for review, it's a twist on it, which takes a few minutes rather
//! than solving it again: a follow-up the tutor poses, which the learner answers and the grader
//! marks (see the twist module). With no model to pose one, or if posing one fails, it's a
//! recall instead: writing down how to solve it, then comparing that with the item's approach.
//! A problem the learner couldn't solve last time is solved again instead, and they can always
//! choose to.
//!
//! A codebase item's fix or refactor is solved the same way, in a project of several files
//! rather than from a starter, without understanding it from an example first, as the project
//! is there to read, and with the plan written beside the code once it's been read. It comes back as a recall, of what was wrong and how it was put right.
//! A change to review is the `review` module's.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use workshop_learning::{Attempt, Rating, TrackPlan};
use workshop_pack::diff::{self, Line};
use workshop_pack::{Case, Coding, Content, Item, Kind, Language, Pack, ProjectFile, Task};
use workshop_toolchain::toolchain::Toolchain;
use workshop_tracks::{Priority, Step, Track, TrackIcon, TrackId};

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

/// The most files a learner's project can have, with any they add.
const MAX_PROJECT_FILES: usize = 20;

/// The Coding track's directory in Workshop's data, for problems' sessions, twists and drafts.
fn coding_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("coding")
}

/// Where a language's drafts are, which its language server is started in. Its programs come
/// from there too, as a solutions directory's do: from mise, if it has a mise config, which
/// Workshop can write from the language's profile and install.
pub fn language_dir(data_dir: &Path, language: Language) -> PathBuf {
    coding_dir(data_dir).join(language.id())
}

/// The programs the Coding track builds, runs and checks code in `language` with, from mise if
/// the language's directory has a mise config, and otherwise from Workshop's own `PATH`.
pub async fn toolchain(paths: &Paths, language: Language) -> Result<Toolchain> {
    Toolchain::load(&language_dir(&paths.data_dir, language))
        .await
        .with_context(|| format!("loading the Coding track's {} toolchain", language.name()))
}

/// Where and how coding items' programs are built and run: in Workshop's build directory, with
/// each language's toolchain, and inside this machine's sandbox, if it has one. Without one,
/// they run with all the user's access, as Advent of Code solutions do; it's up to the caller
/// whether to run model-written programs then.
pub async fn runtime(config: &Config, paths: &Paths) -> Result<workshop_coding::Runtime> {
    let build_timeout = Duration::from_secs(config.run.timeout_secs);
    let mut environments = BTreeMap::new();
    for language in Language::ALL {
        let toolchain = toolchain(paths, language).await?;
        environments.insert(language, toolchain.variables().to_vec());
    }
    let all: Vec<_> = environments.values().cloned().collect();
    let sandbox = workshop_coding::Sandbox::detect(&all)
        .await
        .unwrap_or(workshop_coding::Sandbox::Unconfined);
    Ok(workshop_coding::Runtime {
        scratch: paths.build_dir().join("coding"),
        environments,
        build_timeout,
        run_timeout: RUN_TIMEOUT.min(build_timeout),
        sandbox,
        tools: Default::default(),
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
    /// Answering a twist on it, posed for its review.
    Twist,
}

impl StepName {
    fn describe(self) -> &'static str {
        match self {
            Self::Understand => "understanding it",
            Self::Plan => "planning",
            Self::Code => "coding",
            Self::Test => "testing",
            Self::Review => "reviewing",
            Self::Twist => "answering a twist on it",
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
    /// Answering a twist on it, which the grader marks.
    Twist,
}

impl Mode {
    /// The steps of going through a problem this way: for a project, solving it starts with the
    /// code, as there's code to read rather than an example to work out, and the plan, of what's
    /// wrong or what to change, is written beside it, once it's been read.
    pub fn steps_for(self, coding: &Coding) -> &'static [StepName] {
        match (self, coding.project()) {
            (Self::Solve, Some(_)) => &[StepName::Code, StepName::Test, StepName::Review],
            _ => self.steps(),
        }
    }

    fn steps(self) -> &'static [StepName] {
        match self {
            Self::Solve => &[
                StepName::Understand,
                StepName::Plan,
                StepName::Code,
                StepName::Test,
                StepName::Review,
            ],
            Self::Recall => &[StepName::Plan, StepName::Review],
            Self::Twist => &[StepName::Twist],
        }
    }

    fn describe(self) -> &'static str {
        match self {
            Self::Solve => "solving",
            Self::Recall => "recalling",
            Self::Twist => "answering a twist on",
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
    /// For a problem in parts, the part they're on, counting from 0. Passing a part's tests
    /// moves them on to the next, with their code as it is.
    #[serde(default)]
    pub part: usize,
    /// For a problem in parts, how they planned each part before the one they're on.
    #[serde(default)]
    pub plans: Vec<String>,
    /// What they worked out the first example prints, while understanding it, or for a part
    /// after the first, the part's first example.
    #[serde(default)]
    pub prediction: Option<String>,
    /// How they mean to solve it, typed or dictated, or for a twist, their answer to it.
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
    /// Why a review that would have been a twist is a recall instead, such as there being no
    /// model to pose one.
    #[serde(default)]
    pub no_twist: Option<String>,
    /// For a project, the file open in the editor, so it's open again on coming back.
    #[serde(default)]
    pub file: Option<String>,
    /// When it was started, and last saved, in milliseconds since 1970.
    pub started_at: i64,
    pub updated_at: i64,
    /// Monotonic version bumped on every write, shared by online and offline sync paths.
    #[serde(default)]
    pub version: u64,
}

impl Session {
    fn new(mode: Mode, coding: &Coding, language: Language, now: i64) -> Self {
        Self {
            mode,
            step: mode.steps_for(coding)[0],
            language,
            part: 0,
            plans: Vec::new(),
            prediction: None,
            plan: String::new(),
            passed: false,
            runs: 0,
            submissions: 0,
            hints: 0,
            no_twist: None,
            file: None,
            started_at: now,
            updated_at: now,
            version: 1,
        }
    }

    /// Whether two sessions have the same user-visible fields, ignoring timestamps and version.
    pub fn same_content(&self, other: &Self) -> bool {
        self.mode == other.mode
            && self.step == other.step
            && self.language == other.language
            && self.part == other.part
            && self.plans == other.plans
            && self.prediction == other.prediction
            && self.plan == other.plan
            && self.passed == other.passed
            && self.runs == other.runs
            && self.submissions == other.submissions
            && self.hints == other.hints
            && self.no_twist == other.no_twist
            && self.file == other.file
    }

    /// The same review as a recall instead of a twist, saying why.
    pub fn recall_instead(self, why: String) -> Self {
        Self {
            mode: Mode::Recall,
            step: Mode::Recall.steps()[0],
            no_twist: Some(why),
            ..self
        }
    }

    /// Whether the app may save `next` over this session. What only the server's own run of the
    /// tests changes, the part, the plans before it, whether it passed and how many times it
    /// was submitted, must stay as it is, and the mode only changes from a twist to a recall,
    /// when there's no twist to be had.
    fn may_become(&self, next: &Session) -> Result<(), String> {
        let ours = (self.part, &self.plans, self.passed, self.submissions);
        if ours != (next.part, &next.plans, next.passed, next.submissions) {
            return Err(
                "only running the tests moves on to another part, passes it or counts a submission"
                    .to_owned(),
            );
        }
        if next.mode != self.mode && (self.mode, next.mode) != (Mode::Twist, Mode::Recall) {
            return Err(format!(
                "a problem being {} can't become one being {}; open it again to start afresh",
                self.mode.describe(),
                next.mode.describe()
            ));
        }
        Ok(())
    }

    /// What they planned, for the attempt to keep: the plan, or for a problem in parts, each
    /// part's in turn.
    pub fn response(&self) -> String {
        if self.plans.is_empty() {
            return self.plan.clone();
        }
        self.plans
            .iter()
            .chain(std::iter::once(&self.plan))
            .enumerate()
            .map(|(i, plan)| format!("Part {}: {}", i + 1, plan.trim()))
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    /// The parts the learner can see: those they've reached, while solving it, and every part
    /// once it's being reviewed, or in a review of a problem solved before.
    pub fn revealed(&self, coding: &Coding) -> usize {
        match (self.mode, self.step) {
            (Mode::Solve, StepName::Review) | (Mode::Recall | Mode::Twist, _) => coding.last(),
            (Mode::Solve, _) => self.part,
        }
    }

    fn check(&self, coding: &Coding) -> Result<(), String> {
        if self.part > coding.last() {
            return Err(format!(
                "this problem has {} parts, so there's no part {}",
                coding.parts.len(),
                self.part + 1
            ));
        }
        if self.plans.len() != self.part {
            return Err(format!(
                "on part {}, there's a plan for each of the {} before it",
                self.part + 1,
                self.part
            ));
        }
        if self.part > 0 && self.mode != Mode::Solve {
            return Err(format!(
                "only solving a problem goes through its parts, not {} it",
                self.mode.describe()
            ));
        }
        if !self.mode.steps_for(coding).contains(&self.step) {
            return Err(format!(
                "{} isn't a step when {} a problem",
                self.step.describe(),
                self.mode.describe()
            ));
        }
        if !coding.languages.contains(&self.language) {
            return Err(format!(
                "this problem can't be solved in {}",
                self.language.name()
            ));
        }
        match (&self.file, coding.project()) {
            (Some(_), None) => Err("only a project has files to open".to_owned()),
            (Some(file), Some(_)) if !diff::is_project_path(file) => {
                Err(format!("{file:?} isn't a file a project can have"))
            }
            _ => Ok(()),
        }
    }
}

/// Where the learner is with something they've started in the Coding track: a problem, at a
/// step, or a change being reviewed, which has none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Started {
    pub updated_at: i64,
    pub step: Option<StepName>,
    pub mode: Option<Mode>,
}

impl Started {
    fn describe(self) -> &'static str {
        self.step.map_or("reviewing the change", StepName::describe)
    }
}

/// How a submission went, to record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Submitted {
    /// The part the server graded it on, counting from 0, or `None` when it wasn't the server's
    /// own run of the tests, which can't pass anything or move on to another part.
    pub part: Option<usize>,
    pub passed: bool,
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
    /// Rated easy, so never offered again, until it's brought back.
    Retired,
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
    /// For work in a codebase, what's asked.
    pub task: Option<Task>,
}

/// A problem, as the app shows it: everything but its hidden tests, and its solution only once
/// it's being reviewed.
#[derive(Debug, Serialize)]
pub struct Opened {
    pub key: String,
    pub label: String,
    /// The track it's in, for the way back to it: the Coding track, or another, such as a
    /// pack's own.
    pub track: OpenedTrack,
    pub skills: Vec<String>,
    pub source: Option<String>,
    pub minutes: u32,
    /// Its parts as far as the learner can see them: the first, and each they've reached since,
    /// or all of them once it's being reviewed.
    pub parts: Vec<OpenedPart>,
    /// How many parts it has, seen or not.
    pub part_count: usize,
    /// How the tests call the code, in API mode.
    pub api: Option<OpenedApi>,
    /// The languages a program can be written in; none for a project, whose files are in
    /// `project`.
    pub languages: Vec<OpenedLanguage>,
    /// For a codebase item, the project being worked in.
    pub project: Option<OpenedProject>,
    pub session: Session,
    /// How they planned to solve it last time, for comparing with when recalling it.
    pub previous_plan: Option<String>,
    pub solution: Option<Solution>,
    /// For a twist, the twist, once it's been posed.
    pub twist: Option<OpenedTwist>,
}

/// One of a problem's parts, as the learner sees it.
#[derive(Debug, Clone, Serialize)]
pub struct OpenedPart {
    /// What it asks, in Markdown: the item's prompt for the first part.
    pub prompt: String,
    /// In API mode, the calls each makes and what they return, as JSON, a line each.
    pub examples: Vec<Case>,
    /// The pack's hints for it, from gentlest to most telling, which the app shows one at a
    /// time.
    pub hints: Vec<String>,
    /// Earlier parts, counting from 0, whose requirements it changes.
    pub replaces: Vec<usize>,
}

impl OpenedPart {
    /// The first `count` of a problem's parts.
    pub fn first(coding: &Coding, count: usize) -> Vec<Self> {
        coding.parts[..count]
            .iter()
            .map(|part| Self {
                prompt: part.prompt.clone(),
                examples: part.examples.clone(),
                hints: part.hints.clone(),
                replaces: part.replaces.clone(),
            })
            .collect()
    }
}

/// How the tests call the learner's code, in API mode.
#[derive(Debug, Clone, Serialize)]
pub struct OpenedApi {
    /// The class they make, or with none, the module's functions are called.
    pub class: Option<String>,
}

impl OpenedApi {
    pub fn of(coding: &Coding) -> Option<Self> {
        coding.api.as_ref().map(|api| Self {
            class: api.class.clone(),
        })
    }
}

#[derive(Debug, Serialize)]
pub struct OpenedTrack {
    pub id: TrackId,
    pub name: String,
    pub icon: TrackIcon,
}

impl OpenedTrack {
    pub fn of(found: &Found<'_>) -> Self {
        let id = found.item.track.clone();
        let (name, icon) = crate::learning::track_label(std::slice::from_ref(found.pack), &id);
        Self { id, name, icon }
    }
}

/// A twist as the learner sees it before answering: without what a good answer covers.
#[derive(Debug, Serialize)]
pub struct OpenedTwist {
    pub kind: crate::twist::Kind,
    /// In Markdown.
    pub prompt: String,
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

/// A project being worked in, as the learner has it.
#[derive(Debug, Serialize)]
pub struct OpenedProject {
    pub task: Task,
    /// In order of their names.
    pub files: Vec<OpenedFile>,
    /// Syntax highlighting, from Python's profile.
    pub editor_mode: String,
    /// The language server, started in the project's directory, if Python has one.
    pub lsp: Option<OpenedProjectLsp>,
    /// The version of a file that isn't there yet, for adding one.
    pub empty_version: String,
}

#[derive(Debug, Serialize)]
pub struct OpenedFile {
    pub path: String,
    pub code: VersionedFile,
    /// The file as the project is given, unless the learner added it.
    pub original: Option<String>,
    /// Whether it's a file of tests, which are the item's own: read and run, never changed.
    pub read_only: bool,
    pub uri: String,
}

#[derive(Debug, Serialize)]
pub struct OpenedProjectLsp {
    pub root_uri: String,
    pub language_id: String,
    pub options: Option<serde_json::Value>,
}

/// What a file's change is, line by line, for one that's changed.
#[derive(Debug, Clone, Serialize)]
pub struct FileChange {
    pub path: String,
    pub lines: Vec<Line>,
    pub added: usize,
    pub removed: usize,
}

impl FileChange {
    /// The files that differ from `before` to `after`, in order of their names, with each file's
    /// lines, or none if it hasn't changed.
    pub fn between(before: &[&ProjectFile], after: &[ProjectFile]) -> Vec<Self> {
        let mut paths: Vec<&str> = before
            .iter()
            .map(|f| f.path.as_str())
            .chain(after.iter().map(|f| f.path.as_str()))
            .collect();
        paths.sort_unstable();
        paths.dedup();
        paths
            .into_iter()
            .filter_map(|path| {
                let old = before
                    .iter()
                    .find(|f| f.path == path)
                    .map(|f| f.text.as_str());
                let new = after
                    .iter()
                    .find(|f| f.path == path)
                    .map(|f| f.text.as_str());
                let lines = diff::lines(old.unwrap_or(""), new.unwrap_or(""));
                let (added, removed) = diff::counts(&lines);
                (added + removed > 0).then(|| Self {
                    path: path.to_owned(),
                    lines,
                    added,
                    removed,
                })
            })
            .collect()
    }

    /// The changes as a unified diff, for a model to read.
    pub fn unified(changes: &[Self], before: &[&ProjectFile], after: &[ProjectFile]) -> String {
        changes
            .iter()
            .map(|change| {
                diff::unified(
                    &change.path,
                    before
                        .iter()
                        .find(|f| f.path == change.path)
                        .map(|f| f.text.as_str()),
                    after
                        .iter()
                        .find(|f| f.path == change.path)
                        .map(|f| f.text.as_str()),
                )
            })
            .collect()
    }
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
    /// Solutions to the whole problem, its last part's for a problem in parts.
    pub reference: Vec<Reference>,
    /// For a project, how the reference changes it, and how the learner did.
    pub project: Option<ProjectChanges>,
}

#[derive(Debug, Serialize)]
pub struct ProjectChanges {
    pub reference: Vec<FileChange>,
    pub yours: Vec<FileChange>,
}

impl Solution {
    pub fn of(coding: &Coding) -> Self {
        Self {
            approach: coding.approach.clone(),
            notes: coding.notes.clone(),
            reference: coding.parts[coding.last()]
                .work
                .programs()
                .iter()
                .map(|source| Reference {
                    language: source.language,
                    text: source.text.clone(),
                })
                .collect(),
            project: None,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Reference {
    pub language: Language,
    pub text: String,
}

/// An idempotent coding session event synced from a client (offline or online).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CodingEvent {
    SessionOpened {
        id: String,
        item: String,
        mode: Mode,
        language: Language,
        #[serde(default)]
        no_twist: Option<String>,
        started_at: i64,
    },
    SessionUpdated {
        id: String,
        item: String,
        base_version: u64,
        session: Session,
        at: i64,
    },
    Submitted {
        id: String,
        item: String,
        base_version: u64,
        passed: bool,
        #[serde(default)]
        part: Option<usize>,
        #[serde(default)]
        graded: Option<workshop_coding::Graded>,
        at: i64,
    },
    Finished {
        id: String,
        item: String,
        #[serde(default)]
        base_version: Option<u64>,
        #[serde(default)]
        started_at: Option<i64>,
        rating: Rating,
        #[serde(default)]
        plan: Option<String>,
        #[serde(default)]
        duration_ms: i64,
        answered_at: i64,
    },
}

impl CodingEvent {
    pub fn id(&self) -> &str {
        match self {
            Self::SessionOpened { id, .. }
            | Self::SessionUpdated { id, .. }
            | Self::Submitted { id, .. }
            | Self::Finished { id, .. } => id,
        }
    }

    pub fn item(&self) -> &str {
        match self {
            Self::SessionOpened { item, .. }
            | Self::SessionUpdated { item, .. }
            | Self::Submitted { item, .. }
            | Self::Finished { item, .. } => item,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CodingEventStatus {
    Applied {
        #[serde(skip_serializing_if = "Option::is_none")]
        session: Option<Session>,
    },
    Duplicate,
    Conflict {
        current: Box<Session>,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Serialize)]
pub struct CodingEventOutcome {
    pub id: String,
    pub item: String,
    #[serde(flatten)]
    pub status: CodingEventStatus,
}

#[derive(Debug, thiserror::Error)]
pub enum SessionWriteError {
    #[error("this coding session changed on another device")]
    Conflict { current: Box<Session> },
    #[error("the problem hasn't been started, or it's been finished")]
    NotStarted,
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

/// The problems' sessions and code drafts, kept in Workshop's data directory, and the changes
/// being reviewed.
pub struct Problems {
    data_dir: PathBuf,
    pub reviews: crate::code_review::Reviews,
    saved: workshop_sessions::Saved<Session>,
    /// Every twist posed for each problem.
    twists: workshop_sessions::Saved<crate::twist::Posed>,
    /// Held while saving a draft, so two saves from the same version can't both succeed.
    save_lock: std::sync::Mutex<()>,
    /// Held while mutating a session or checking applied event IDs (single writer).
    session_lock: std::sync::Mutex<()>,
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
        let dir = coding_dir(data_dir);
        Self {
            saved: workshop_sessions::Saved::new(dir.join("sessions")),
            twists: workshop_sessions::Saved::new(dir.join("twists")),
            reviews: crate::code_review::Reviews::new(&dir),
            data_dir: data_dir.to_owned(),
            save_lock: std::sync::Mutex::new(()),
            session_lock: std::sync::Mutex::new(()),
        }
    }

    fn applied_events_path(&self) -> PathBuf {
        coding_dir(&self.data_dir).join("applied_events.json")
    }

    fn load_applied_events(&self) -> Result<Vec<String>> {
        let path = self.applied_events_path();
        match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).context("reading applied coding events"),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(err) => Err(err).with_context(|| format!("reading {}", path.display())),
        }
    }

    fn save_applied_events(&self, applied: &[String]) -> Result<()> {
        let path = self.applied_events_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        workshop_common::files::write_atomic(&path, &serde_json::to_vec(applied)?)
    }

    fn mark_event_applied_locked(&self, applied: &mut Vec<String>, id: String) -> Result<()> {
        const MAX_APPLIED_EVENTS: usize = 2000;
        if !applied.contains(&id) {
            applied.push(id);
            if applied.len() > MAX_APPLIED_EVENTS {
                let overflow = applied.len() - MAX_APPLIED_EVENTS;
                applied.drain(..overflow);
            }
        }
        self.save_applied_events(applied)
    }

    /// Where a language's drafts are, which its language server is started in.
    pub fn root(&self, language: Language) -> PathBuf {
        language_dir(&self.data_dir, language)
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
        match language {
            Language::Rust => {
                let manifest = self.root(language).join("Cargo.toml");
                if !manifest.exists() {
                    std::fs::create_dir_all(self.root(language))?;
                    workshop_common::files::write_atomic(&manifest, RUST_PROJECT.as_bytes())?;
                }
            }
            Language::Haskell => {
                // Workshop's own, and made from how drafts are built, so it's written again
                // whenever that changes.
                let cradle = self.root(language).join("hie.yaml");
                let text = haskell_cradle();
                if std::fs::read_to_string(&cradle).ok().as_deref() != Some(text.as_str()) {
                    std::fs::create_dir_all(self.root(language))?;
                    workshop_common::files::write_atomic(&cradle, text.as_bytes())?;
                }
            }
            Language::Python | Language::Cpp => {}
        }
        Ok(())
    }

    pub fn session(&self, key: &str) -> Result<Option<Session>> {
        self.saved.get(key)
    }

    /// Every session in progress, by item.
    pub fn sessions(&self) -> Result<BTreeMap<String, Session>> {
        self.saved.all()
    }

    /// Everything started in the Coding track and not finished, by item: problems, and
    /// changes being reviewed.
    pub fn started(&self) -> Result<BTreeMap<String, Started>> {
        let mut started: BTreeMap<String, Started> = self
            .sessions()?
            .into_iter()
            .map(|(key, session)| {
                (
                    key,
                    Started {
                        updated_at: session.updated_at,
                        step: Some(session.step),
                        mode: Some(session.mode),
                    },
                )
            })
            .collect();
        for (key, review) in self.reviews.sessions()? {
            started.insert(
                key,
                Started {
                    updated_at: review.updated_at,
                    step: None,
                    mode: None,
                },
            );
        }
        Ok(started)
    }

    fn write_session(&self, key: &str, session: &Session) -> Result<()> {
        self.saved.put(key, session)
    }

    fn save_session_locked(
        &self,
        found: &Found<'_>,
        mut session: Session,
        base_version: Option<u64>,
        now: i64,
    ) -> Result<(Session, i64), SessionWriteError> {
        session
            .check(found.coding)
            .map_err(SessionWriteError::Invalid)?;
        let key = found.key();
        let before = self
            .session_for(found)?
            .ok_or(SessionWriteError::NotStarted)?;
        if let Some(expected) = base_version
            && before.version != expected
        {
            if session.same_content(&before) {
                return Ok((before, 0));
            }
            return Err(SessionWriteError::Conflict {
                current: Box::new(before),
            });
        }
        before
            .may_become(&session)
            .map_err(SessionWriteError::Invalid)?;
        session.started_at = before.started_at;
        session.updated_at = now.max(before.updated_at);
        session.version = before.version + 1;
        self.write_session(&key, &session)?;
        Ok((session, spent(&before, now)))
    }

    /// Saves where the learner is with a problem, checking monotonic version if `base_version` is
    /// given. Both online `PUT /session` and offline `SessionUpdated` events go through here.
    pub fn save_session_checked(
        &self,
        found: &Found<'_>,
        session: Session,
        base_version: Option<u64>,
        now: i64,
    ) -> Result<(Session, i64), SessionWriteError> {
        let _guard = self
            .session_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.save_session_locked(found, session, base_version, now)
    }

    /// Saves where the learner is with a problem, as long as it's somewhere the problem has.
    /// Returns it as saved, and the time spent on it since it was last saved.
    pub fn save_session(
        &self,
        found: &Found<'_>,
        session: Session,
        now: i64,
    ) -> Result<(Session, i64)> {
        let base = (session.version > 0).then_some(session.version);
        self.save_session_checked(found, session, base, now)
            .map_err(anyhow::Error::from)
    }

    fn record_submission_locked(
        &self,
        found: &Found<'_>,
        base_version: Option<u64>,
        submitted: Submitted,
        now: i64,
    ) -> Result<(Session, i64), SessionWriteError> {
        let key = found.key();
        let before = self
            .session_for(found)?
            .ok_or(SessionWriteError::NotStarted)?;
        if before.mode != Mode::Solve {
            return Err(SessionWriteError::Invalid(format!(
                "only solving a problem submits it, not {} it",
                before.mode.describe()
            )));
        }
        // Graded on one part, it's recorded for that part, or not at all if the session's moved
        // on since, such as on another device.
        let stale = base_version.is_some_and(|expected| before.version != expected)
            || submitted.part.is_some_and(|part| part != before.part);
        if stale {
            return Err(SessionWriteError::Conflict {
                current: Box::new(before),
            });
        }
        if submitted.passed && submitted.part.is_none() {
            return Err(SessionWriteError::Invalid(
                "only the server's own run of the tests can pass a problem or a part".to_owned(),
            ));
        }
        let passed = submitted.passed;
        let mut next = before.clone();
        next.submissions += 1;
        if passed && next.part < found.coding.last() {
            // On to the next part, keeping their code, to understand and plan what it adds.
            next.plans.push(std::mem::take(&mut next.plan));
            next.part += 1;
            next.prediction = None;
            next.step = Mode::Solve.steps_for(found.coding)[0];
        } else {
            next.passed = passed;
            next.step = if passed {
                StepName::Review
            } else {
                StepName::Test
            };
        }
        next.updated_at = now.max(before.updated_at);
        next.version = before.version + 1;
        self.write_session(&key, &next)?;
        Ok((next, spent(&before, now)))
    }

    /// Records a submission outcome (from either a live server submit or an offline `Submitted`
    /// event) through the same versioned session writer. Passing a part before the last moves
    /// the session on to the next part.
    pub fn record_submission(
        &self,
        found: &Found<'_>,
        base_version: Option<u64>,
        submitted: Submitted,
        now: i64,
    ) -> Result<(Session, i64), SessionWriteError> {
        let _guard = self
            .session_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.record_submission_locked(found, base_version, submitted, now)
    }

    /// A problem's session, if it's started and still fits the problem. One that doesn't, such
    /// as for a part the pack no longer has, is dropped, so the problem starts afresh.
    pub fn session_for(&self, found: &Found<'_>) -> Result<Option<Session>> {
        let key = found.key();
        let Some(session) = self.session(&key)? else {
            return Ok(None);
        };
        match session.check(found.coding) {
            Ok(()) => Ok(Some(session)),
            Err(why) => {
                tracing::warn!("starting {key} afresh, as its session no longer fits it: {why}");
                self.saved.remove(&key)?;
                Ok(None)
            }
        }
    }

    /// Notes that the learner is working on a problem, such as by typing its code. Returns the
    /// time spent on it since it was last saved.
    pub fn touch(&self, key: &str, now: i64) -> Result<i64> {
        let _guard = self
            .session_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(mut session) = self.session(key)? else {
            return Ok(0);
        };
        let spent = spent(&session, now);
        session.updated_at = now.max(session.updated_at);
        self.write_session(key, &session)?;
        Ok(spent)
    }

    /// Starts a problem, or carries on with it: a solve the first time, or if it went badly
    /// last time, and otherwise a twist on it, unless the learner asks for a solve. `no_twist`
    /// says why there can't be a twist, if there can't, which makes it a recall instead.
    pub fn start(
        &self,
        found: &Found<'_>,
        attempts: &[Attempt],
        solve: bool,
        no_twist: Option<String>,
        now: i64,
    ) -> Result<Session> {
        let _guard = self
            .session_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let key = found.key();
        if let Some(session) = self.session_for(found)?
            && !(solve && session.mode != Mode::Solve)
        {
            return Ok(session);
        }
        let review = !solve
            && attempts
                .last()
                .is_some_and(|last| last.rating != Rating::Again);
        let session = if !review {
            // A project is solved afresh from the project as it's given.
            if found.coding.project().is_some() {
                self.reset_project(found)?;
            }
            Session::new(Mode::Solve, found.coding, found.coding.languages[0], now)
        } else if found.coding.project().is_some() {
            // There are no twists on work in a codebase: it's recalled, what was wrong and how
            // it was put right.
            Session::new(Mode::Recall, found.coding, found.coding.languages[0], now)
        } else {
            // In the language they last wrote it in, as the twist is on their solution.
            let language = self
                .last_draft(found)?
                .map_or(found.coding.languages[0], |(language, _)| language);
            let twist = Session::new(Mode::Twist, found.coding, language, now);
            match no_twist {
                Some(why) => twist.recall_instead(why),
                None => twist,
            }
        };
        self.write_session(&key, &session)?;
        Ok(session)
    }

    /// Applies an idempotent offline/online [`CodingEvent`] through the single session writer,
    /// holding `session_lock` from duplicate check through recording the applied event ID.
    pub fn apply_event(
        &self,
        packs: &[Pack],
        learning: &crate::learning::Learning,
        event: CodingEvent,
    ) -> CodingEventOutcome {
        let id = event.id().to_owned();
        let item_key = event.item().to_owned();
        let error_outcome = |message: String| CodingEventOutcome {
            id: id.clone(),
            item: item_key.clone(),
            status: CodingEventStatus::Error { message },
        };
        let Some((pack, item)) = item_key.split_once('/') else {
            return error_outcome("item key must be pack/item".to_owned());
        };
        let found = match find(packs, pack, item) {
            Ok(f) => f,
            Err(err) => return error_outcome(format!("{err:#}")),
        };

        let _guard = self
            .session_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        let mut applied = match self.load_applied_events() {
            Ok(list) => list,
            Err(err) => return error_outcome(format!("{err:#}")),
        };
        if applied.contains(&id) {
            return CodingEventOutcome {
                id,
                item: item_key,
                status: CodingEventStatus::Duplicate,
            };
        }

        match event {
            CodingEvent::SessionOpened {
                mode,
                language,
                no_twist,
                started_at,
                ..
            } => {
                let result = (|| -> Result<Session, SessionWriteError> {
                    if let Some(existing) = self.session_for(&found)? {
                        return Ok(existing);
                    }
                    let mut session = Session::new(mode, found.coding, language, started_at);
                    session.no_twist = no_twist;
                    session
                        .check(found.coding)
                        .map_err(SessionWriteError::Invalid)?;
                    self.write_session(&item_key, &session)?;
                    Ok(session)
                })();
                match result {
                    Ok(session) => {
                        if let Err(err) = self.mark_event_applied_locked(&mut applied, id.clone()) {
                            return error_outcome(format!("{err:#}"));
                        }
                        CodingEventOutcome {
                            id,
                            item: item_key,
                            status: CodingEventStatus::Applied {
                                session: Some(session),
                            },
                        }
                    }
                    Err(SessionWriteError::Conflict { current }) => CodingEventOutcome {
                        id,
                        item: item_key,
                        status: CodingEventStatus::Conflict { current },
                    },
                    Err(err) => error_outcome(format!("{err:#}")),
                }
            }
            CodingEvent::SessionUpdated {
                base_version,
                session,
                at,
                ..
            } => match self.save_session_locked(&found, session, Some(base_version), at) {
                Ok((saved, spent_ms)) => {
                    if let Err(err) = learning.store().record_time(&item_key, at, spent_ms) {
                        return error_outcome(format!("{err:#}"));
                    }
                    if let Err(err) = self.mark_event_applied_locked(&mut applied, id.clone()) {
                        return error_outcome(format!("{err:#}"));
                    }
                    CodingEventOutcome {
                        id,
                        item: item_key,
                        status: CodingEventStatus::Applied {
                            session: Some(saved),
                        },
                    }
                }
                Err(SessionWriteError::Conflict { current }) => CodingEventOutcome {
                    id,
                    item: item_key,
                    status: CodingEventStatus::Conflict { current },
                },
                Err(err) => error_outcome(format!("{err:#}")),
            },
            CodingEvent::Submitted {
                base_version,
                passed,
                part,
                graded,
                at,
                ..
            } => match self.record_submission_locked(
                &found,
                Some(base_version),
                Submitted { part, passed },
                at,
            ) {
                Ok((saved, spent_ms)) => {
                    if let Err(err) = learning.store().record_time(&item_key, at, spent_ms) {
                        return error_outcome(format!("{err:#}"));
                    }
                    if let Some(graded) = &graded {
                        let mistake_id = format!(
                            "submission-{}-{}-{}",
                            item_key, saved.started_at, saved.submissions
                        );
                        if let Some(mistake) = crate::mistakes::from_submission(
                            &item_key,
                            found.coding,
                            mistake_id,
                            at,
                            graded,
                        ) && let Err(err) = learning.store().record_mistakes(&[mistake])
                        {
                            return error_outcome(format!("{err:#}"));
                        }
                    }
                    if let Err(err) = self.mark_event_applied_locked(&mut applied, id.clone()) {
                        return error_outcome(format!("{err:#}"));
                    }
                    CodingEventOutcome {
                        id,
                        item: item_key,
                        status: CodingEventStatus::Applied {
                            session: Some(saved),
                        },
                    }
                }
                Err(SessionWriteError::Conflict { current }) => CodingEventOutcome {
                    id,
                    item: item_key,
                    status: CodingEventStatus::Conflict { current },
                },
                Err(err) => error_outcome(format!("{err:#}")),
            },
            CodingEvent::Finished {
                base_version: _,
                started_at,
                rating,
                plan,
                duration_ms,
                answered_at,
                ..
            } => {
                // Finishing records an append-only attempt (idempotent by event ID) and only
                // closes the on-disk session if it belongs to the same sitting (`started_at`),
                // so a stale offline finish never deletes a newer attempt started on another device.
                let store = learning.store();
                let already = match store.attempts(&item_key) {
                    Ok(attempts) => attempts.iter().any(|a| a.id == id),
                    Err(err) => return error_outcome(format!("{err:#}")),
                };
                if already {
                    if let Err(err) = self.mark_event_applied_locked(&mut applied, id.clone()) {
                        return error_outcome(format!("{err:#}"));
                    }
                    return CodingEventOutcome {
                        id,
                        item: item_key,
                        status: CodingEventStatus::Duplicate,
                    };
                }
                let session_opt = match self.session_for(&found) {
                    Ok(s) => s,
                    Err(err) => return error_outcome(format!("{err:#}")),
                };
                let matching_session = session_opt
                    .as_ref()
                    .filter(|s| started_at.is_none_or(|at| s.started_at == at));
                // The plans of earlier parts are the server's, as only it moves a session on
                // from one part to the next; the current part's may be newer on the device.
                let response = match (matching_session, plan) {
                    (Some(session), plan) => Some(
                        Session {
                            plan: plan.unwrap_or_else(|| session.plan.clone()),
                            ..session.clone()
                        }
                        .response(),
                    ),
                    (None, plan) => plan,
                };
                let spent_ms = if duration_ms > 0 {
                    duration_ms.clamp(0, workshop_sessions::MAX_STEP_GAP_MS)
                } else {
                    matching_session.map_or(0, |s| spent(s, answered_at))
                };
                if let Err(err) = learning.record_problem(
                    Attempt {
                        id: id.clone(),
                        item: item_key.clone(),
                        answered_at,
                        duration_ms: spent_ms,
                        rating,
                        response,
                        seed: None,
                    },
                    &[],
                    answered_at,
                ) {
                    return error_outcome(format!("{err:#}"));
                }
                if matching_session.is_some()
                    && let Err(err) = self.saved.remove(&item_key)
                {
                    return error_outcome(format!("{err:#}"));
                }
                if let Err(err) = self.mark_event_applied_locked(&mut applied, id.clone()) {
                    return error_outcome(format!("{err:#}"));
                }
                CodingEventOutcome {
                    id,
                    item: item_key,
                    status: CodingEventStatus::Applied { session: None },
                }
            }
        }
    }

    /// The draft written in most recently, in any of the problem's languages, and its text.
    pub fn last_draft(&self, found: &Found<'_>) -> Result<Option<(Language, String)>> {
        let mut latest: Option<(std::time::SystemTime, Language, PathBuf)> = None;
        for &language in &found.coding.languages {
            let path = self.draft_path(&found.key(), language);
            let modified = match std::fs::metadata(&path) {
                Ok(metadata) => metadata.modified()?,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
                Err(err) => {
                    return Err(err).with_context(|| format!("reading {}", path.display()));
                }
            };
            if latest.as_ref().is_none_or(|(at, ..)| modified > *at) {
                latest = Some((modified, language, path));
            }
        }
        latest
            .map(|(_, language, path)| {
                let text = std::fs::read_to_string(&path)
                    .with_context(|| format!("reading {}", path.display()))?;
                Ok((language, text))
            })
            .transpose()
    }

    /// Every twist posed for a problem.
    pub fn twists(&self, key: &str) -> Result<crate::twist::Posed> {
        Ok(self.twists.get(key)?.unwrap_or_default())
    }

    /// Keeps a twist posed for a problem, or replaces the one for the same review, such as once
    /// it's answered.
    pub fn keep_twist(&self, key: &str, twist: crate::twist::Twist) -> Result<()> {
        let mut posed = self.twists(key)?;
        match posed.twists.iter_mut().find(|t| t.session == twist.session) {
            Some(same) => *same = twist,
            None => posed.twists.push(twist),
        }
        self.twists.put(key, &posed)
    }

    /// Ends a problem's session, once its attempt is recorded.
    pub fn finish(&self, key: &str) -> Result<()> {
        let _guard = self
            .session_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.saved.remove(key)
    }

    /// A problem's draft in a language if it already exists on disk, without creating one from
    /// the starter.
    pub fn existing_draft(
        &self,
        found: &Found<'_>,
        language: Language,
    ) -> Result<Option<VersionedFile>> {
        let path = self.draft_path(&found.key(), language);
        if !path.exists() {
            return Ok(None);
        }
        read_versioned(&path).map(Some)
    }

    /// The path a problem's draft lives at, whether or not it exists yet.
    pub fn draft_file_path(&self, found: &Found<'_>, language: Language) -> PathBuf {
        self.draft_path(&found.key(), language)
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

    /// Where a project's files are, as the learner has them. Its language server is started
    /// there, so it sees the project as a whole.
    pub fn project_dir(&self, key: &str) -> PathBuf {
        let (pack, item) = key.split_once('/').expect("keys are pack/item");
        self.root(Language::Python)
            .join("projects")
            .join(pack)
            .join(item)
    }

    /// Puts a project back as it's given, for solving it afresh.
    fn reset_project(&self, found: &Found<'_>) -> Result<()> {
        let dir = self.project_dir(&found.key());
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err).with_context(|| format!("removing {}", dir.display())),
        }
    }

    /// A project's files as the learner has them once they're on `part`, in order of their
    /// names: the project's own, as they've changed them, any they've added, and the tests that
    /// apply then, which are always the item's.
    pub fn project_files(
        &self,
        found: &Found<'_>,
        part: usize,
    ) -> Result<Vec<(String, VersionedFile)>> {
        let project = found
            .coding
            .project()
            .context("only a codebase item has a project")?;
        let dir = self.project_dir(&found.key());
        std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
        for file in project.files.iter().filter(|f| !f.is_test()) {
            let path = dir.join(&file.path);
            if !path.exists() {
                workshop_common::files::write_atomic(&path, file.text.as_bytes())?;
            }
        }
        // Tests are the item's, so they're written each time, and those of parts not reached
        // yet, such as from an earlier sitting, are taken away.
        let tests = found.coding.test_files(part);
        for entry in std::fs::read_dir(&dir)? {
            let name = entry?.file_name().to_string_lossy().into_owned();
            if workshop_pack::project::is_test_file(&name) && !tests.iter().any(|t| t.path == name)
            {
                std::fs::remove_file(dir.join(&name))?;
            }
        }
        for test in &tests {
            let path = dir.join(&test.path);
            if std::fs::read_to_string(&path).ok().as_deref() != Some(test.text.as_str()) {
                workshop_common::files::write_atomic(&path, test.text.as_bytes())?;
            }
        }
        let mut files = Vec::new();
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            // Only what a project can have, as a language server or Python may leave caches.
            if !entry.file_type()?.is_file() || !diff::is_project_path(&name) {
                continue;
            }
            files.push((name, read_versioned(&entry.path())?));
        }
        files.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(files)
    }

    /// A project's files as they are, for running them.
    pub fn project_solution(&self, found: &Found<'_>, part: usize) -> Result<Vec<ProjectFile>> {
        Ok(self
            .project_files(found, part)?
            .into_iter()
            .map(|(path, file)| ProjectFile {
                path,
                text: file.text,
            })
            .collect())
    }

    /// Why a file of a project can't be saved, if it can't: it isn't a name a project can have,
    /// it's a file of tests, which are the item's own, it's Workshop's, or it's one more file
    /// than a project can have.
    pub fn unsaveable(&self, found: &Found<'_>, path: &str) -> Option<String> {
        if found.coding.project().is_none() {
            return Some("only a codebase item has files to save".to_owned());
        }
        if let Some(problem) = workshop_pack::project::name_problem(path) {
            return Some(problem);
        }
        if workshop_pack::project::is_test_file(path) {
            return Some(format!(
                "{path} is named as a file of tests, which are the problem's own, so it can't be changed or added"
            ));
        }
        let taken = std::fs::read_dir(self.project_dir(&found.key()))
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .find(|name| name != path && workshop_pack::project::same_name(name, path));
        if let Some(taken) = taken {
            return Some(format!(
                "the project has {taken} already, which is the same file where case is ignored"
            ));
        }
        let dir = self.project_dir(&found.key());
        if !dir.join(path).exists() {
            let count = std::fs::read_dir(&dir).map_or(0, |entries| entries.count());
            if count >= MAX_PROJECT_FILES {
                return Some(format!(
                    "the project has {count} files already, the most it can have"
                ));
            }
        }
        None
    }

    /// Saves a file of a project, or adds one, unless it's [`Problems::unsaveable`].
    pub fn save_project_file(
        &self,
        found: &Found<'_>,
        path: &str,
        text: &str,
        version: &str,
    ) -> Result<VersionedFile, SaveError> {
        if let Some(why) = self.unsaveable(found, path) {
            return Err(SaveError::Other(anyhow::anyhow!(why)));
        }
        let file = self.project_dir(&found.key()).join(path);
        save_versioned(&self.save_lock, &file, text, version)
    }

    /// The project as the app shows it, once the learner is on `part`.
    fn opened_project(
        &self,
        config: &Config,
        found: &Found<'_>,
        part: usize,
    ) -> Result<OpenedProject> {
        let project = found
            .coding
            .project()
            .context("only a codebase item has a project")?;
        let profile = config.languages.get(Language::Python.id());
        let files = self
            .project_files(found, part)?
            .into_iter()
            .map(|(path, code)| {
                let given = found
                    .coding
                    .test_files(part)
                    .into_iter()
                    .chain(project.files.iter())
                    .find(|f| f.path == path)
                    .map(|f| f.text.clone());
                OpenedFile {
                    read_only: workshop_pack::project::is_test_file(&path),
                    uri: crate::server::file_uri(&code.path),
                    original: given,
                    path,
                    code,
                }
            })
            .collect();
        Ok(OpenedProject {
            task: project.task,
            files,
            editor_mode: profile.map_or_else(
                || Language::Python.id().to_owned(),
                |profile| profile.editor_mode.clone(),
            ),
            lsp: profile
                .filter(|p| p.lsp.is_some())
                .map(|profile| OpenedProjectLsp {
                    root_uri: crate::server::file_uri(&self.project_dir(&found.key())),
                    language_id: profile.lsp_language_id.clone(),
                    options: profile.lsp_options.clone(),
                }),
            empty_version: workshop_common::files::version_of(""),
        })
    }

    /// How the reference changes a project, and how the learner has, without its tests.
    fn project_changes(&self, found: &Found<'_>, part: usize) -> Result<Option<ProjectChanges>> {
        let Some(project) = found.coding.project() else {
            return Ok(None);
        };
        let original: Vec<&ProjectFile> = project.files.iter().filter(|f| !f.is_test()).collect();
        let reference = match &found.coding.parts[found.coding.last()].work {
            workshop_pack::PartWork::Project { reference, .. } => reference.as_slice(),
            workshop_pack::PartWork::Program { .. } => &[],
        };
        let yours: Vec<ProjectFile> = self
            .project_solution(found, part)?
            .into_iter()
            .filter(|f| !f.is_test())
            .collect();
        Ok(Some(ProjectChanges {
            reference: FileChange::between(&original, reference),
            yours: FileChange::between(&original, &yours),
        }))
    }

    /// The learner's changes to a project so far, as a unified diff, for the tutor and the
    /// grader.
    pub fn project_diff(&self, found: &Found<'_>, part: usize) -> Result<String> {
        let project = found
            .coding
            .project()
            .context("only a codebase item has a project")?;
        let original: Vec<&ProjectFile> = project.files.iter().filter(|f| !f.is_test()).collect();
        let yours: Vec<ProjectFile> = self
            .project_solution(found, part)?
            .into_iter()
            .filter(|f| !f.is_test())
            .collect();
        Ok(FileChange::unified(
            &FileChange::between(&original, &yours),
            &original,
            &yours,
        ))
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
        let project = coding
            .project()
            .map(|_| self.opened_project(config, found, session.part))
            .transpose()?;
        let languages = coding
            .languages
            .iter()
            .filter(|_| project.is_none())
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
        let solution = match session.step {
            StepName::Review => Some(Solution {
                project: self.project_changes(found, session.part)?,
                ..Solution::of(coding)
            }),
            _ => None,
        };
        let twist = match session.mode {
            Mode::Twist => self
                .twists(&found.key())?
                .for_session(session.started_at)
                .map(|twist| OpenedTwist {
                    kind: twist.kind,
                    prompt: twist.prompt.clone(),
                }),
            _ => None,
        };
        Ok(Opened {
            key: found.key(),
            label: item.label(),
            track: OpenedTrack::of(found),
            skills: item.skills.clone(),
            source: item.source.clone(),
            minutes: item.minutes,
            parts: OpenedPart::first(coding, session.revealed(coding) + 1),
            part_count: coding.parts.len(),
            api: OpenedApi::of(coding),
            languages,
            project,
            session,
            previous_plan: attempts
                .iter()
                .rev()
                .find_map(|attempt| attempt.response.clone()),
            solution,
            twist,
        })
    }
}

/// The time between a session's last save and now that counts as time spent on it.
fn spent(session: &Session, now: i64) -> i64 {
    workshop_sessions::spent(session.updated_at, now)
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

/// haskell-language-server's settings for Haskell drafts: GHC's flags as drafts are built with
/// them, so it sees the same packages, and no package environment of the user's own.
fn haskell_cradle() -> String {
    let mut arguments = vec!["-package-env".to_owned(), "-".to_owned()];
    arguments.extend(workshop_coding::programs::ghc_package_flags());
    let quoted: Vec<String> = arguments
        .iter()
        .map(|argument| serde_json::to_string(argument).expect("strings serialise"))
        .collect();
    format!(
        "# Drafts of coding problems, for the language server. Workshop writes this file.\ncradle:\n  direct:\n    arguments: [{}]\n",
        quoted.join(", ")
    )
}

/// A track's problems and code to read, from the plan: the Coding track's, or another's, such
/// as a pack's own.
pub fn overview(
    planned: &Planned,
    sessions: &BTreeMap<String, Started>,
    flags: &BTreeMap<String, workshop_learning::Flag>,
    track: &TrackId,
) -> Overview {
    let plan = planned.plans.get(track);
    let items = coding_items(planned, track)
        .map(|(key, item)| {
            let session = sessions.get(&key);
            let retired = planned.is_retired(&key);
            let status = if flags.contains_key(&key) {
                Status::Flagged
            } else if session.is_some() {
                Status::InProgress
            } else if retired {
                Status::Retired
            } else if plan.is_some_and(|plan| plan.due.contains(&key)) {
                Status::Due
            } else if plan.is_some_and(|plan| plan.is_new(&key)) {
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
                step: session.and_then(|s| s.step),
                mode: session.and_then(|s| s.mode),
                task: match &item.content {
                    Content::Coding(coding) => coding.project().map(|p| p.task),
                    Content::Review(_) => Some(Task::Review),
                    _ => None,
                },
                key,
            }
        })
        .collect();
    Overview {
        items,
        week: planned.week,
    }
}

/// A track's problems and code to read, with their keys.
fn coding_items<'a>(
    planned: &'a Planned,
    track: &'a TrackId,
) -> impl Iterator<Item = (String, &'a Item)> {
    planned.packs.iter().flat_map(move |pack| {
        pack.items
            .iter()
            .filter(move |item| {
                item.track == *track
                    && matches!(item.kind, Kind::Coding | Kind::Reading | Kind::Codebase)
            })
            .map(move |item| (format!("{}/{}", pack.manifest.id, item.id), item))
    })
}

/// The Coding track on the home screen, if there's anything in it.
pub fn track(
    planned: &Planned,
    sessions: &BTreeMap<String, Started>,
) -> Option<Track<Destination>> {
    let plan = planned.plans.get(&TrackId::Coding)?;
    let items: BTreeMap<String, &Item> = coding_items(planned, &TrackId::Coding).collect();
    Some(Track::built_in(
        TrackId::Coding,
        summary(
            plan,
            sessions.keys().filter(|k| items.contains_key(*k)).count(),
        ),
        Destination::Coding { item: None },
        next_step(planned, sessions, plan, &items),
    ))
}

/// The step a track of short items suggests from the coding problems in it, if it has any,
/// such as a pack's own track. Its code to read is practised with its other short items.
pub fn problem_step(
    planned: &Planned,
    sessions: &BTreeMap<String, Started>,
    track: &TrackId,
) -> Option<Step<Destination>> {
    let plan = planned.plans.get(track)?;
    let problems: BTreeMap<String, &Item> = coding_items(planned, track)
        .filter(|(_, item)| matches!(item.kind, Kind::Coding | Kind::Codebase))
        .collect();
    next_step(planned, sessions, plan, &problems)
}

/// The step `items`, of a track with this plan, suggest: the one worked on most recently, then
/// one that's due, then something new.
fn next_step(
    planned: &Planned,
    sessions: &BTreeMap<String, Started>,
    plan: &TrackPlan,
    items: &BTreeMap<String, &Item>,
) -> Option<Step<Destination>> {
    let label = |key: &str| {
        items
            .get(key)
            .map_or_else(|| key.to_owned(), |item| item.label())
    };
    let open = |key: &str| Destination::Coding {
        item: Some(key.to_owned()),
    };
    // The problem worked on most recently, of those still in the packs.
    let unfinished = sessions
        .iter()
        .filter(|(key, _)| items.contains_key(*key))
        .max_by_key(|(_, session)| session.updated_at);
    if let Some((key, session)) = unfinished {
        return Some(Step {
            title: label(key),
            reason: format!("Where you left off, {}", session.describe()),
            priority: Priority::Unfinished,
            destination: open(key),
        });
    }
    if let Some(key) = plan.due.iter().find(|key| items.contains_key(*key)) {
        let why = match items.get(key).map(|item| (item.kind, &item.content)) {
            Some((Kind::Coding, _)) => "Due for review: a quick follow-up on it",
            Some((Kind::Codebase, Content::Coding(_))) => {
                "Due for review: recalling what you changed, and why"
            }
            _ => "Due today",
        };
        return Some(Step {
            title: label(key),
            reason: why.to_owned(),
            priority: Priority::Due,
            destination: open(key),
        });
    }
    // In a skill recent mistakes point to, if any are, and then the quickest, so a spare few
    // minutes are enough to start.
    let focus = |key: &str| items.get(key).and_then(|item| planned.focus_of(item));
    let quickest = plan
        .new
        .iter()
        .filter(|key| items.contains_key(*key))
        .min_by_key(|key| {
            (
                focus(key).is_none(),
                items
                    .get(key.as_str())
                    .map_or(u32::MAX, |item| item.minutes),
            )
        });
    quickest.map(|key| match focus(key) {
        Some(skill) => Step {
            title: label(key),
            reason: format!("Practise {skill}, after recent mistakes"),
            priority: Priority::Focus,
            destination: open(key),
        },
        None => Step {
            title: label(key),
            reason: "Something new".to_owned(),
            // Once the week's target is met, new items wait behind anything else to do.
            priority: if planned.week.minutes >= planned.week.target {
                Priority::Browse
            } else {
                Priority::New
            },
            destination: open(key),
        },
    })
}

fn summary(plan: &TrackPlan, in_progress: usize) -> String {
    let mut parts = Vec::new();
    if in_progress > 0 {
        parts.push(format!("{in_progress} in progress"));
    }
    if !plan.due.is_empty() {
        parts.push(format!("{} due", plan.due.len()));
    }
    if plan.new_count() > 0 {
        parts.push(format!("{} new", plan.new_count()));
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
            sample_pack: false,
            daily_reviews: 40,
            daily_new: 10,
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
        let mut session = problems.start(&found, &[], false, None, NOW).unwrap();
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
            workshop_sessions::MAX_STEP_GAP_MS
        );
        let saved = problems.session(&found.key()).unwrap().unwrap();
        // Starting again carries on where it was left.
        assert_eq!(
            problems.start(&found, &[], false, None, NOW + 9).unwrap(),
            saved
        );
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

    /// A submission is recorded for the part it was graded on, and only the server's own run
    /// passes one; an offline event can only say it failed.
    #[test]
    fn records_a_submission_for_the_part_it_was_graded_on() {
        let dir = tempfile::tempdir().unwrap();
        let learning = learning(dir.path());
        let packs = vec![Pack::sample()];
        let found = find(&packs, "sample", "text-buffer").unwrap();
        let problems = Problems::new(dir.path());
        problems.start(&found, &[], false, None, NOW).unwrap();
        let passed = |part| Submitted {
            part: Some(part),
            passed: true,
        };
        let (moved, _) = problems
            .record_submission(&found, None, passed(0), NOW)
            .unwrap();
        assert_eq!((moved.part, moved.step), (1, StepName::Understand));
        // Graded on part 1 while another device moved on, it isn't recorded.
        assert!(matches!(
            problems.record_submission(&found, None, passed(0), NOW),
            Err(SessionWriteError::Conflict { current }) if current.part == 1
        ));
        let offline = |id: &str, passed: bool, part: Option<usize>| CodingEvent::Submitted {
            id: id.to_owned(),
            item: found.key(),
            base_version: moved.version,
            passed,
            part,
            graded: None,
            at: NOW,
        };
        let refused = problems.apply_event(&packs, &learning, offline("offline-pass", true, None));
        assert!(
            matches!(&refused.status, CodingEventStatus::Error { message } if message.contains("only the server's own run")),
            "{:?}",
            refused.status
        );
        // A stale part conflicts instead of advancing the session.
        let stale_part =
            problems.apply_event(&packs, &learning, offline("offline-stale", true, Some(0)));
        assert!(
            matches!(&stale_part.status, CodingEventStatus::Conflict { current } if current.part == 1),
            "{:?}",
            stale_part.status
        );
        let failed = problems.apply_event(&packs, &learning, offline("offline-fail", false, None));
        let CodingEventStatus::Applied {
            session: Some(failed),
        } = failed.status
        else {
            panic!("{:?}", failed.status);
        };
        assert_eq!(
            (failed.part, failed.step, failed.passed),
            (1, StepName::Test, false)
        );
        // A verified on-device pass carrying the current part advances to the next part.
        let passed_on_device = problems.apply_event(
            &packs,
            &learning,
            CodingEvent::Submitted {
                id: "offline-pass-part1".to_owned(),
                item: found.key(),
                base_version: failed.version,
                passed: true,
                part: Some(1),
                graded: None,
                at: NOW,
            },
        );
        let CodingEventStatus::Applied {
            session: Some(advanced),
        } = passed_on_device.status
        else {
            panic!("{:?}", passed_on_device.status);
        };
        assert_eq!(
            (advanced.part, advanced.step, advanced.passed),
            (2, StepName::Understand, false)
        );
    }

    /// A session left for a part the problem no longer has, such as after its pack changed, is
    /// dropped, and the problem starts afresh.
    #[test]
    fn starts_afresh_when_a_session_no_longer_fits_the_problem() {
        let dir = tempfile::tempdir().unwrap();
        let packs = vec![Pack::sample()];
        let found = find(&packs, "sample", "text-buffer").unwrap();
        let problems = Problems::new(dir.path());
        let mut session = problems.start(&found, &[], false, None, NOW).unwrap();
        session.part = 7;
        session.plans = vec![String::new(); 7];
        problems.write_session(&found.key(), &session).unwrap();
        assert_eq!(problems.session_for(&found).unwrap(), None);
        let fresh = problems.start(&found, &[], false, None, NOW + 1).unwrap();
        assert_eq!((fresh.part, fresh.started_at), (0, NOW + 1));
    }

    #[test]
    fn reviews_a_problem_solved_before_with_a_twist_unless_it_went_badly() {
        let dir = tempfile::tempdir().unwrap();
        let packs = vec![Pack::sample()];
        let found = find(&packs, "sample", "pair-sums").unwrap();
        let problems = Problems::new(dir.path());
        let solved = [attempt("1", NOW, Rating::Good, "A map of counts")];
        // Last written in Rust, the twist is on that.
        let draft = problems.draft(&found, Language::Rust).unwrap();
        let session = problems.start(&found, &solved, false, None, NOW).unwrap();
        assert_eq!((session.mode, session.step), (Mode::Twist, StepName::Twist));
        assert_eq!(session.language, Language::Rust);
        assert_eq!(
            problems.last_draft(&found).unwrap(),
            Some((Language::Rust, draft.text))
        );
        let config = Config::parse("").unwrap();
        let opened = problems
            .open(&config, &found, session.clone(), &solved)
            .unwrap();
        assert!(opened.twist.is_none());
        // The twist posed for this review, and not another's, is the one it shows.
        let twist = |session: i64, prompt: &str| crate::twist::Twist {
            session,
            kind: crate::twist::Kind::Scale,
            prompt: prompt.to_owned(),
            notes: "Notes".to_owned(),
            posed_at: NOW,
            answered: None,
        };
        problems
            .keep_twist(&found.key(), twist(NOW - 1, "An older one"))
            .unwrap();
        problems
            .keep_twist(&found.key(), twist(session.started_at, "A billion pairs?"))
            .unwrap();
        let opened = problems
            .open(&config, &found, session.clone(), &solved)
            .unwrap();
        assert_eq!(opened.twist.unwrap().prompt, "A billion pairs?");
        assert_eq!(problems.twists(&found.key()).unwrap().twists.len(), 2);
        // Choosing to solve it starts it over as a solve.
        let session = problems.start(&found, &solved, true, None, NOW).unwrap();
        assert_eq!(session.mode, Mode::Solve);
        problems.finish(&found.key()).unwrap();

        // With no model to pose a twist, it's a recall, saying why.
        let session = problems
            .start(&found, &solved, false, Some("No model".to_owned()), NOW)
            .unwrap();
        assert_eq!((session.mode, session.step), (Mode::Recall, StepName::Plan));
        assert_eq!(session.no_twist.as_deref(), Some("No model"));
        problems.finish(&found.key()).unwrap();

        let failed = [
            attempt("1", NOW, Rating::Good, "A map of counts"),
            attempt("2", NOW + 1, Rating::Again, ""),
        ];
        let session = problems.start(&found, &failed, false, None, NOW).unwrap();
        assert_eq!(session.mode, Mode::Solve);
        let config = Config::parse("").unwrap();
        let opened = problems.open(&config, &found, session, &failed).unwrap();
        assert_eq!(opened.previous_plan.as_deref(), Some(""));
        assert!(opened.solution.is_none());
        assert_eq!(opened.parts[0].examples.len(), 2);
        assert_eq!((opened.parts.len(), opened.part_count), (1, 1));
        assert_eq!(opened.languages.len(), 2);
        assert!(opened.parts[0].hints.len() >= 2);
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
    fn opens_haskell_drafts_in_a_project_for_the_language_server() {
        let dir = tempfile::tempdir().unwrap();
        let packs = vec![Pack::sample()];
        let found = find(&packs, "sample", "lowest-balance").unwrap();
        let problems = Problems::new(dir.path());
        let session = problems.start(&found, &[], false, None, NOW).unwrap();
        assert_eq!(session.language, Language::Haskell);
        let config = Config::parse("").unwrap();
        let opened = problems.open(&config, &found, session, &[]).unwrap();
        let haskell = &opened.languages[0];
        assert_eq!(haskell.id, Language::Haskell);
        assert_eq!(haskell.editor_mode, "haskell");
        assert!(haskell.code.text.contains("undefined"));
        assert!(haskell.code.path.ends_with("lowest-balance.hs"));
        let lsp = haskell.lsp.as_ref().unwrap();
        assert_eq!(lsp.language_id, "haskell");
        assert!(lsp.root_uri.ends_with("/coding/haskell"));
        let cradle =
            std::fs::read_to_string(problems.root(Language::Haskell).join("hie.yaml")).unwrap();
        assert!(
            cradle.contains(r#"["-package-env", "-", "-no-user-package-db", "-hide-all-packages", "-package", "base""#),
            "{cradle}"
        );
        // Written again if it's changed, as it's Workshop's own.
        std::fs::write(
            problems.root(Language::Haskell).join("hie.yaml"),
            "cradle: {}",
        )
        .unwrap();
        problems.draft(&found, Language::Haskell).unwrap();
        assert_eq!(
            std::fs::read_to_string(problems.root(Language::Haskell).join("hie.yaml")).unwrap(),
            cradle
        );
    }

    #[test]
    fn shows_the_solution_only_once_its_being_reviewed() {
        let dir = tempfile::tempdir().unwrap();
        let packs = vec![Pack::sample()];
        let found = find(&packs, "sample", "islands").unwrap();
        let problems = Problems::new(dir.path());
        let mut session = problems.start(&found, &[], false, None, NOW).unwrap();
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
        assert_eq!(track.summary, "26 new");
        let next = track.next.unwrap();
        assert_eq!(next.priority, Priority::New);
        // The quickest first: code to read, rather than a problem.
        assert_eq!(
            next.destination,
            Destination::Coding {
                item: Some("sample/assigning-a-global".to_owned())
            }
        );
        assert_eq!(next.reason, "Something new");

        let packs = vec![Pack::sample()];
        let found = find(&packs, "sample", "islands").unwrap();
        let problems = Problems::new(dir.path());
        let mut session = problems.start(&found, &[], false, None, NOW).unwrap();
        session.step = StepName::Code;
        problems.save_session(&found, session, NOW).unwrap();
        let sessions = problems.started().unwrap();
        let track = super::track(&planned, &sessions).unwrap();
        assert_eq!(track.summary, "1 in progress · 26 new");
        let next = track.next.unwrap();
        assert_eq!(next.priority, Priority::Unfinished);
        assert_eq!(next.title, "Count the islands");
        assert_eq!(next.reason, "Where you left off, coding");

        let overview = overview(&planned, &sessions, &BTreeMap::new(), &TrackId::Coding);
        let islands = overview
            .items
            .iter()
            .find(|item| item.key == "sample/islands")
            .unwrap();
        assert_eq!(islands.status, Status::InProgress);
        assert_eq!(islands.step, Some(StepName::Code));
        assert_eq!(overview.items.len(), 26);
        assert!(
            overview
                .items
                .iter()
                .any(|item| item.kind == Kind::Reading && item.status == Status::New)
        );
    }

    #[test]
    fn keeps_a_projects_files_and_which_is_open() {
        let dir = tempfile::tempdir().unwrap();
        let packs = vec![Pack::sample()];
        let found = find(&packs, "sample", "habit-streaks").unwrap();
        let problems = Problems::new(dir.path());
        let session = problems.start(&found, &[], false, None, NOW).unwrap();
        assert_eq!((session.mode, session.step), (Mode::Solve, StepName::Code));
        let open = Session {
            file: Some("tracker.py".to_owned()),
            ..session.clone()
        };
        let (saved, _) = problems.save_session(&found, open, NOW + 1).unwrap();
        assert_eq!(saved.file.as_deref(), Some("tracker.py"));
        let nowhere = Session {
            file: Some("../tracker.py".to_owned()),
            ..saved.clone()
        };
        assert!(problems.save_session(&found, nowhere, NOW + 2).is_err());
        // Only the tests of the parts reached are there, and they're always the item's own.
        let files = problems.project_files(&found, 0).unwrap();
        let names: Vec<&str> = files.iter().map(|(path, _)| path.as_str()).collect();
        assert_eq!(
            names,
            [
                "log.py",
                "test_tracker.py",
                "test_tracker_clock.py",
                "tracker.py"
            ]
        );
        let dir = problems.project_dir(&found.key());
        std::fs::write(dir.join("test_tracker.py"), "def test_x():\n    pass\n").unwrap();
        std::fs::write(dir.join("test_longest.py"), "def test_y():\n    pass\n").unwrap();
        let files = problems.project_files(&found, 0).unwrap();
        assert!(files.iter().all(|(path, _)| path != "test_longest.py"));
        let (_, tests) = files
            .iter()
            .find(|(path, _)| path == "test_tracker.py")
            .unwrap();
        assert!(tests.text.contains("def test_reads_the_log"));
        assert!(
            problems
                .project_files(&found, 1)
                .unwrap()
                .iter()
                .any(|(path, _)| path == "test_longest.py")
        );
        assert!(problems.unsaveable(&found, "test_tracker.py").is_some());
        assert!(problems.unsaveable(&found, "clock.py").is_none());

        // A program has no files to open.
        let program = find(&packs, "sample", "islands").unwrap();
        let session = problems.start(&program, &[], false, None, NOW).unwrap();
        let open = Session {
            file: Some("main.py".to_owned()),
            ..session
        };
        assert!(problems.save_session(&program, open, NOW + 1).is_err());
        assert!(problems.unsaveable(&program, "main.py").is_some());
    }

    #[test]
    fn event_sourced_writer_bumps_versions_detects_conflicts_and_derives_mistakes() {
        let dir = tempfile::tempdir().unwrap();
        let learning = learning(dir.path());
        let packs = vec![Pack::sample()];
        let found = find(&packs, "sample", "islands").unwrap();
        let problems = Problems::new(dir.path());

        // Start offline via SessionOpened.
        let open_outcome = problems.apply_event(
            &packs,
            &learning,
            CodingEvent::SessionOpened {
                id: "ev-open-1".into(),
                item: found.key(),
                mode: Mode::Solve,
                language: Language::Python,
                no_twist: None,
                started_at: NOW,
            },
        );
        let opened = match open_outcome.status {
            CodingEventStatus::Applied { session: Some(s) } => s,
            other => panic!("expected applied open, got {other:?}"),
        };
        assert_eq!(opened.version, 1);

        // Replaying the same event ID is a no-op duplicate.
        let dup = problems.apply_event(
            &packs,
            &learning,
            CodingEvent::SessionOpened {
                id: "ev-open-1".into(),
                item: found.key(),
                mode: Mode::Solve,
                language: Language::Python,
                no_twist: None,
                started_at: NOW,
            },
        );
        assert!(matches!(dup.status, CodingEventStatus::Duplicate));

        // Update bumps version to 2.
        let mut planned = opened.clone();
        planned.step = StepName::Code;
        planned.plan = "BFS over the grid".into();
        let update_outcome = problems.apply_event(
            &packs,
            &learning,
            CodingEvent::SessionUpdated {
                id: "ev-upd-1".into(),
                item: found.key(),
                base_version: 1,
                session: planned.clone(),
                at: NOW + 5_000,
            },
        );
        let updated = match update_outcome.status {
            CodingEventStatus::Applied { session: Some(s) } => s,
            other => panic!("expected applied update, got {other:?}"),
        };
        assert_eq!(updated.version, 2);

        // A stale update against version 1 with different content reports Conflict.
        let mut stale = opened;
        stale.plan = "Conflicting edit from another device".into();
        let conflict = problems.apply_event(
            &packs,
            &learning,
            CodingEvent::SessionUpdated {
                id: "ev-upd-conflict".into(),
                item: found.key(),
                base_version: 1,
                session: stale,
                at: NOW + 6_000,
            },
        );
        assert!(matches!(
            conflict.status,
            CodingEventStatus::Conflict { current } if current.version == 2
        ));

        // A failed local submission derives a mistake via Rust's mistakes::from_submission.
        let graded = workshop_coding::Graded::Ran {
            total: 3,
            results: vec![workshop_coding::CaseResult {
                case: workshop_coding::CaseRef::Test {
                    part: None,
                    index: 0,
                },
                input: "1 1\n0\n".into(),
                expected: "0\n".into(),
                run: workshop_coding::Run {
                    ending: workshop_runner::Ending::Exited { code: Some(0) },
                    stdout: "1\n".into(),
                    stderr: String::new(),
                    cut_off: None,
                    duration_ms: 12,
                },
                passed: false,
            }],
        };
        let sub_outcome = problems.apply_event(
            &packs,
            &learning,
            CodingEvent::Submitted {
                id: "ev-sub-1".into(),
                item: found.key(),
                base_version: 2,
                passed: false,
                part: Some(0),
                graded: Some(graded),
                at: NOW + 10_000,
            },
        );
        let after_sub = match sub_outcome.status {
            CodingEventStatus::Applied { session: Some(s) } => s,
            other => panic!("expected applied submit, got {other:?}"),
        };
        assert_eq!(after_sub.version, 3);
        assert_eq!(after_sub.submissions, 1);
        assert_eq!(after_sub.step, StepName::Test);
        assert_eq!(learning.store().mistakes(0).unwrap().len(), 1);

        // Finishing records the attempt and removes the session.
        let fin_outcome = problems.apply_event(
            &packs,
            &learning,
            CodingEvent::Finished {
                id: "ev-fin-1".into(),
                item: found.key(),
                base_version: Some(3),
                started_at: Some(NOW),
                rating: Rating::Good,
                plan: Some("BFS over the grid".into()),
                duration_ms: 15_000,
                answered_at: NOW + 20_000,
            },
        );
        assert!(matches!(
            fin_outcome.status,
            CodingEventStatus::Applied { session: None }
        ));
        assert!(problems.session(&found.key()).unwrap().is_none());
        assert_eq!(learning.store().attempts(&found.key()).unwrap().len(), 1);

        // Offline open -> update (base 1) -> finish (base 1, even though update bumped to v2)
        // succeeds without conflict, and clamps oversized duration_ms to MAX_STEP_GAP_MS.
        let found2 = find(&packs, "sample", "first-repeat").unwrap();
        let o1 = problems.apply_event(
            &packs,
            &learning,
            CodingEvent::SessionOpened {
                id: "chain-open".into(),
                item: found2.key(),
                mode: Mode::Solve,
                language: Language::Python,
                no_twist: None,
                started_at: NOW,
            },
        );
        let s1 = match o1.status {
            CodingEventStatus::Applied { session: Some(s) } => s,
            other => panic!("expected open, got {other:?}"),
        };
        let mut s2 = s1.clone();
        s2.step = StepName::Review;
        s2.plan = "Set of seen words".into();
        let o2 = problems.apply_event(
            &packs,
            &learning,
            CodingEvent::SessionUpdated {
                id: "chain-upd".into(),
                item: found2.key(),
                base_version: 1,
                session: s2,
                at: NOW + 3_000,
            },
        );
        assert!(matches!(
            o2.status,
            CodingEventStatus::Applied { session: Some(s) } if s.version == 2
        ));
        let o3 = problems.apply_event(
            &packs,
            &learning,
            CodingEvent::Finished {
                id: "chain-fin".into(),
                item: found2.key(),
                base_version: Some(1),
                started_at: Some(NOW),
                rating: Rating::Good,
                plan: Some("Set of seen words".into()),
                duration_ms: 9_999_999,
                answered_at: NOW + 10_000,
            },
        );
        assert!(matches!(
            o3.status,
            CodingEventStatus::Applied { session: None }
        ));
        assert!(problems.session(&found2.key()).unwrap().is_none());
        let attempts2 = learning.store().attempts(&found2.key()).unwrap();
        assert_eq!(attempts2.len(), 1);
        assert_eq!(attempts2[0].duration_ms, workshop_sessions::MAX_STEP_GAP_MS);

        // A stale offline Finished from an earlier sitting records its attempt without deleting a
        // newer session started later on another device.
        let newer_started_at = NOW + 60_000;
        let _ = problems.apply_event(
            &packs,
            &learning,
            CodingEvent::SessionOpened {
                id: "newer-open".into(),
                item: found2.key(),
                mode: Mode::Solve,
                language: Language::Python,
                no_twist: None,
                started_at: newer_started_at,
            },
        );
        let stale_fin = problems.apply_event(
            &packs,
            &learning,
            CodingEvent::Finished {
                id: "stale-fin".into(),
                item: found2.key(),
                base_version: None,
                started_at: Some(NOW),
                rating: Rating::Hard,
                plan: Some("Old offline plan".into()),
                duration_ms: 0,
                answered_at: NOW + 30_000,
            },
        );
        assert!(matches!(
            stale_fin.status,
            CodingEventStatus::Applied { session: None }
        ));
        let remaining = problems
            .session(&found2.key())
            .unwrap()
            .expect("newer session must remain on disk");
        assert_eq!(remaining.started_at, newer_started_at);
        assert_eq!(learning.store().attempts(&found2.key()).unwrap().len(), 2);
    }
}
