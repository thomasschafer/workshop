//! The author: writes new items and lessons for a pack, for requested lessons, the skills the
//! learner is weakest in, and the mistakes they make most, and has each one checked before it's
//! accepted.
//!
//! A run goes:
//!
//! 1. The pack is copied, leaving out anything hidden such as `.git`, and the writer, a strong
//!    model with tools confined to the copy, writes new items and lessons there. It's the only
//!    role with tools, and never has the pack itself in reach. Anything it changes besides adding
//!    items, linking existing short items to a lesson written in the same run (changing only
//!    `lesson` and `segment` in front matter), and deleting drafts it made items from, is put back.
//! 2. Each lesson and its accompanying new short items (3 to 6) form a bundle that counts as one
//!    towards `max_items`. Items beyond the run's cap are dropped. Every item must pass its
//!    mechanical check, as `workshop pack check` runs it; the writer gets a few rounds to fix
//!    those that fail, and those that still do are dropped. If a lesson fails, its items are
//!    dropped and links to it are put back; if fewer than 3 of its items remain, the lesson is
//!    dropped too.
//! 3. The reviewer, best a model from another provider, in calls of its own with no tools,
//!    solves each practice item blind, then compares its answer with the item's and says whether
//!    the item is right and unambiguous. Where it can be told mechanically, such as a
//!    probability's answer, its answer is compared too. For a lesson, the reviewer audits the
//!    lesson and its accompanying items: factual claims, guesses and checks, explain answer,
//!    sources, and SVG diagrams read as source.
//! 4. If they disagree, the writer answers the objection, revising the item or saying why it
//!    stands, and the reviewer looks again, for a few rounds. Items they agree on are accepted;
//!    the rest wait in an approval queue for the learner. A lesson waiting for approval holds
//!    its items and links until it's approved.
//!
//! The writer can ask the learner questions, which go out as they're asked, so the learner can
//! answer later; the run carries on without waiting. What's accepted (and linked) is returned for
//! the caller to put in the pack, and what's queued for it to keep.

pub mod staging;

use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::path::Path;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use workshop_pack::{Content, Item, Pack, Programs, Verdict};

use crate::staging::Files;

/// The fewest new short items a lesson bundle must have to be accepted.
pub const MIN_LESSON_ITEMS: usize = 3;

/// The most new short items a lesson bundle may carry.
pub const MAX_LESSON_ITEMS: usize = 6;

/// The pack format, as the writer is told it.
const FORMAT: &str = include_str!("../../../docs/packs.md");

/// The writer's instructions, with the pack's add-on if it has one.
pub fn writer_system_prompt(add_on: Option<&str>) -> String {
    with_add_on(include_str!("../../../prompts/author.md"), add_on)
}

/// The reviewer's instructions, with the pack's add-on if it has one.
pub fn reviewer_system_prompt(add_on: Option<&str>) -> String {
    with_add_on(include_str!("../../../prompts/solver.md"), add_on)
}

fn with_add_on(base: &str, add_on: Option<&str>) -> String {
    match add_on.map(str::trim).filter(|a| !a.is_empty()) {
        Some(add_on) => format!("{}\n\nThe pack adds:\n\n{add_on}", base.trim_end()),
        None => base.trim_end().to_owned(),
    }
}

/// The two models a run uses.
pub trait Models: Sync {
    /// Runs the writer, with tools confined to `dir`, and returns its reply.
    fn write(&self, dir: &Path, prompt: &str) -> impl Future<Output = Result<String>> + Send;
    /// Asks the reviewer, which has no tools.
    fn review(&self, prompt: &str) -> impl Future<Output = Result<String>> + Send;
}

/// How much a run may do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Limits {
    /// The most new items (or lesson bundles) a run writes.
    pub max_items: usize,
    /// Rounds the writer gets to fix items whose checks fail.
    pub fix_rounds: usize,
    /// Rounds of discussion when the writer and reviewer disagree.
    pub discussion_rounds: usize,
}

/// A short item the learner chose "Teach me" on when it had no lesson yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LessonRequest {
    /// The item's file in the pack, such as `items/cards/heaps.md`, so the writer can link it.
    pub path: String,
    pub id: String,
    pub prompt: String,
    pub answer: String,
    pub explanation: Option<String>,
    pub skills: Vec<String>,
}

/// How many lessons a targeted skill has, how many of its short items have none, and which of
/// its topics no lesson teaches yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SkillCoverage {
    pub skill: String,
    pub lessons: usize,
    pub unlinked_items: usize,
    /// Its topics no lesson in the pack teaches, as (id, name), in the outline's order.
    pub untaught_topics: Vec<(String, String)>,
}

/// One of the learner's weakest skills, by the lower of how much of it is covered and how well
/// it's recalled.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WeakSkill {
    pub skill: String,
    /// How much of it has been taught and then recalled, from 0 to 1.
    pub coverage: f64,
    /// How well its taught items are recalled, from 0 to 1.
    pub recall: f64,
}

/// What a run should write about.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Brief {
    /// Short items the learner asked for a lesson on with "Teach me", which come first.
    pub lesson_requests: Vec<LessonRequest>,
    /// For each skill the run targets, how many lessons it has and how many items have none.
    pub skill_coverage: Vec<SkillCoverage>,
    /// The skills the learner is weakest in, weakest first.
    pub weakest: Vec<WeakSkill>,
    /// The kinds of mistake made most lately, with how often, most first.
    pub mistakes: Vec<(String, usize)>,
    /// A few recent mistakes, in words, as examples.
    pub examples: Vec<String>,
    /// The learner's answers to questions asked in earlier runs.
    pub answers: Vec<(String, String)>,
    /// The skills whose coding problems the learner found too easy, and retired, most first.
    pub too_easy: Vec<TooEasy>,
    /// The skills whose items with a fixed answer, code to read and probability questions, the
    /// learner found too easy, and retired, most first. Each one's level is the difficulty its
    /// new items should be: one above the hardest retired, as far as 5.
    pub fixed_too_easy: Vec<TooEasy>,
    /// How hard each skill's problems should be, by skill, from 1 to 5, for the skills with
    /// problems attempted: higher as they're found easy, and lower as they're forgotten.
    pub levels: Vec<(String, u8)>,
}

/// A skill whose items were found too easy, so the author writes harder ones.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TooEasy {
    pub skill: String,
    /// The level its new problems should be at, from 1 to 5.
    pub level: u8,
    /// The items retired as easy, by title, with how hard each is, if its pack says.
    pub retired: Vec<(String, Option<u8>)>,
}

/// An existing short item whose front matter was updated to link it to a lesson written in the
/// same run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Linked {
    /// The item's file, relative to the pack.
    pub path: String,
    pub id: String,
    pub label: String,
    /// The lesson it was linked to, by id.
    pub lesson: String,
    /// The segment of that lesson, counting from 1, if given.
    pub segment: Option<usize>,
    /// The updated file contents, with only `lesson` (and `segment`) changed in front matter.
    pub content: String,
}

/// An item from a run, and what happened to it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Written {
    /// The item's file, such as `items/cards/heaps.md`, or `items/x/item.md`.
    pub path: String,
    pub id: String,
    pub label: String,
    pub skills: Vec<String>,
    /// Its files, by path relative to the pack.
    pub files: BTreeMap<String, String>,
    /// The draft it was made from, if it was.
    pub from_draft: Option<String>,
    /// The writer and reviewer's exchange about it.
    pub transcript: Vec<Turn>,
    /// Why it's queued or was dropped, if it was.
    pub reason: Option<String>,
    /// For a queued lesson, its accompanying items held with it until it's approved.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<Written>,
    /// For a queued lesson, existing items to link to it when it's approved.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub linked: Vec<Linked>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Turn {
    /// "writer" or "reviewer".
    pub who: String,
    pub text: String,
}

/// What a run did.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Report {
    /// Checked and agreed on, ready to go in the pack.
    pub accepted: Vec<Written>,
    /// Existing short items linked to accepted lessons written in this run.
    #[serde(default)]
    pub linked: Vec<Linked>,
    /// Checked, and the writer and reviewer couldn't agree, so waiting for the learner.
    pub queued: Vec<Written>,
    /// Left out, with why: over the cap, or failing its check.
    pub dropped: Vec<Written>,
    /// Questions the writer asked the learner.
    pub questions: Vec<String>,
    /// Files the writer changed that it may not have, which were put back.
    pub put_back: Vec<String>,
}

#[derive(Deserialize, Default)]
struct WriterReply {
    #[serde(default)]
    items: Vec<WriterItem>,
    #[serde(default)]
    questions: Vec<String>,
}

#[derive(Deserialize)]
struct WriterItem {
    path: String,
    #[serde(default)]
    from_draft: Option<String>,
}

#[derive(Deserialize)]
struct Position {
    position: String,
    #[serde(default)]
    reply: String,
}

#[derive(Deserialize)]
struct Judgement {
    agree: bool,
    #[serde(default)]
    ambiguous: bool,
    #[serde(default)]
    objection: String,
}

/// Either a standalone new item, or a lesson bundled with its new short items.
enum Unit {
    Standalone(Written),
    Lesson(Bundle),
}

struct Bundle {
    lesson: Written,
    items: Vec<Written>,
}

impl Unit {
    fn sort_key(&self) -> &str {
        match self {
            Self::Standalone(item) => &item.path,
            Self::Lesson(bundle) => &bundle.lesson.path,
        }
    }
}

/// The JSON object at the end of a model's reply.
fn json_in<T: for<'de> Deserialize<'de>>(reply: &str) -> Result<T> {
    let end = reply.rfind('}').context("the reply has no JSON in it")?;
    // The last object: from the latest `{` that starts a whole one.
    for (start, _) in reply[..=end].match_indices('{') {
        if let Ok(value) = serde_json::from_str::<T>(&reply[start..=end]) {
            return Ok(value);
        }
    }
    bail!("the reply has no JSON object in the shape asked for: {reply}")
}

/// Runs the author on the pack in `pack_dir`, in `work_dir`, an empty directory of its own.
/// `programs` runs items' checks, and `ask` is told each question for the learner as it's asked.
pub async fn run<M: Models>(
    pack_dir: &Path,
    work_dir: &Path,
    models: &M,
    programs: &dyn Programs,
    brief: &Brief,
    limits: Limits,
    ask: &(dyn Fn(&str) + Sync),
) -> Result<Report> {
    if limits.max_items == 0 {
        bail!("the author's max_items is 0, so there's nothing for it to write");
    }
    let original = staging::read(pack_dir)?;
    let pack = Pack::from_files(original.clone())?;
    let copy = work_dir.join("pack");
    if copy.exists() {
        bail!("{} isn't empty", work_dir.display());
    }
    staging::stage(&original, &copy)?;

    let mut report = Report::default();
    let reply = models
        .write(&copy, &writer_prompt(&pack, brief, limits))
        .await?;
    let reply: WriterReply = json_in(&reply).unwrap_or_default();
    for question in &reply.questions {
        ask(question);
    }
    report.questions = reply.questions.clone();
    let from_drafts: BTreeMap<String, String> = reply
        .items
        .iter()
        .filter_map(|i| i.from_draft.clone().map(|d| (i.path.clone(), d)))
        .collect();

    let now_after_write = staging::read(&copy)?;
    let initial_lessons = staging::new_lesson_ids(&original, &now_after_write);
    let changes = staging::police_with_links(&original, Some(&pack), &copy, &initial_lessons)?;
    report.put_back.extend(changes.put_back);
    let mut drafts_removed = changes.drafts_removed;

    let candidates = new_items(&original, &copy)?;
    let mut units = group_into_units(&copy, candidates)?;

    // Cap each lesson bundle at MAX_LESSON_ITEMS new items.
    for unit in &mut units {
        if let Unit::Lesson(bundle) = unit {
            bundle.items.sort_by(|a, b| a.path.cmp(&b.path));
            while bundle.items.len() > MAX_LESSON_ITEMS {
                let mut over = bundle.items.pop().expect("more than MAX_LESSON_ITEMS");
                remove_item(&copy, &over)?;
                over.reason = Some(format!(
                    "over the limit of {MAX_LESSON_ITEMS} items for a lesson"
                ));
                report.dropped.push(over);
            }
        }
    }

    // Over the cap, the last units by path are dropped. A lesson and its items count as one.
    while units.len() > limits.max_items {
        let over = units.pop().expect("more than the cap");
        let reason = format!("over the run's limit of {} items", limits.max_items);
        match over {
            Unit::Standalone(mut item) => {
                remove_item(&copy, &item)?;
                item.reason = Some(reason);
                report.dropped.push(item);
            }
            Unit::Lesson(mut bundle) => {
                remove_item(&copy, &bundle.lesson)?;
                bundle.lesson.reason = Some(reason.clone());
                let lesson_id = bundle.lesson.id.clone();
                report.dropped.push(bundle.lesson);
                for mut child in bundle.items {
                    remove_item(&copy, &child)?;
                    child.reason = Some(reason.clone());
                    report.dropped.push(child);
                }
                restore_links_for(
                    &original,
                    &pack,
                    &copy,
                    &lesson_id,
                    Some(&mut report.put_back),
                )?;
            }
        }
    }

    let mut active_lessons = unit_lesson_ids(&units);

    // Every item (and every linked existing item) must pass its check; the writer can fix those
    // that don't, a few times.
    let mut failing =
        check_units_and_links(&copy, &original, &pack, &units, &active_lessons, programs).await?;
    for _ in 0..limits.fix_rounds {
        if failing.is_empty() {
            break;
        }
        models.write(&copy, &fix_prompt(&failing)).await?;
        let changes = staging::police_with_links(&original, Some(&pack), &copy, &active_lessons)?;
        report.put_back.extend(changes.put_back);
        drafts_removed.extend(changes.drafts_removed);
        // Only the items there already: a new one now would skip the cap.
        let flat = flatten_units(&units);
        let known: Vec<String> = flat.iter().flat_map(|c| c.files.keys().cloned()).collect();
        for added in changes.added.iter().filter(|p| !known.contains(p)) {
            if !flat.iter().any(|c| owns(c, added)) {
                staging::remove(&copy, added)?;
                report.put_back.push(added.clone());
            }
        }
        units = refresh_units(&copy, units)?;
        active_lessons = unit_lesson_ids(&units);
        failing = check_units_and_links(&copy, &original, &pack, &units, &active_lessons, programs)
            .await?;
    }

    // Any existing item link that still fails its check (such as an out-of-range segment) is put back.
    for link in current_links(&original, &pack, &copy, &active_lessons)? {
        if failing.contains_key(&link.path) {
            staging::write(&copy, &link.path, &original[&link.path])?;
            report.put_back.push(link.path);
        }
    }

    // Partition passing vs failing units, enforcing bundle rules.
    let mut passing_units = Vec::new();
    for unit in units {
        match unit {
            Unit::Standalone(mut item) => {
                if let Some(why) = failing.get(&item.path) {
                    remove_item(&copy, &item)?;
                    item.reason = Some(format!("its check didn't pass: {why}"));
                    report.dropped.push(item);
                } else {
                    passing_units.push(Unit::Standalone(item));
                }
            }
            Unit::Lesson(mut bundle) => {
                if let Some(why) = failing.get(&bundle.lesson.path) {
                    let lesson_id = bundle.lesson.id.clone();
                    remove_item(&copy, &bundle.lesson)?;
                    bundle.lesson.reason = Some(format!("its check didn't pass: {why}"));
                    report.dropped.push(bundle.lesson);
                    for mut child in bundle.items {
                        remove_item(&copy, &child)?;
                        child.reason = Some(match failing.get(&child.path) {
                            Some(child_why) => format!("its check didn't pass: {child_why}"),
                            None => format!("its lesson {lesson_id} didn't pass its check"),
                        });
                        report.dropped.push(child);
                    }
                    restore_links_for(
                        &original,
                        &pack,
                        &copy,
                        &lesson_id,
                        Some(&mut report.put_back),
                    )?;
                    continue;
                }
                let (passing_items, failed_items): (Vec<Written>, Vec<Written>) = bundle
                    .items
                    .into_iter()
                    .partition(|c| !failing.contains_key(&c.path));
                for mut child in failed_items {
                    remove_item(&copy, &child)?;
                    child.reason = Some(format!("its check didn't pass: {}", failing[&child.path]));
                    report.dropped.push(child);
                }
                if passing_items.len() < MIN_LESSON_ITEMS {
                    let lesson_id = bundle.lesson.id.clone();
                    remove_item(&copy, &bundle.lesson)?;
                    bundle.lesson.reason = Some(format!(
                        "fewer than {MIN_LESSON_ITEMS} of its items passed their checks ({} left)",
                        passing_items.len()
                    ));
                    report.dropped.push(bundle.lesson);
                    for mut child in passing_items {
                        remove_item(&copy, &child)?;
                        child.reason = Some(format!(
                            "its lesson {lesson_id} was left out, as fewer than {MIN_LESSON_ITEMS} of its items remained"
                        ));
                        report.dropped.push(child);
                    }
                    restore_links_for(
                        &original,
                        &pack,
                        &copy,
                        &lesson_id,
                        Some(&mut report.put_back),
                    )?;
                } else {
                    bundle.items = passing_items;
                    passing_units.push(Unit::Lesson(bundle));
                }
            }
        }
    }

    let mut review_lessons = unit_lesson_ids(&passing_units);
    let attach_draft = |item: &mut Written| {
        // A writer whose tools can't delete files leaves the draft in place, so a draft that's
        // still in the pack counts too. Only a draft in the original pack can be named, as it's
        // removed from the pack itself once the item is accepted.
        item.from_draft = from_drafts.get(&item.path).cloned().filter(|draft| {
            drafts_removed.contains(draft)
                || (staging::is_draft(draft) && original.contains_key(draft))
        });
    };

    // Review each standalone item blind, and for each lesson bundle, audit the lesson and review
    // its items blind.
    for unit in passing_units {
        match unit {
            Unit::Standalone(mut item) => {
                attach_draft(&mut item);
                match review_item(
                    &copy,
                    &original,
                    &pack,
                    &review_lessons,
                    &mut item,
                    models,
                    programs,
                    limits,
                    &mut report,
                )
                .await?
                {
                    Outcome::Agreed => report.accepted.push(item),
                    Outcome::Disagreed(reason) => {
                        remove_item(&copy, &item)?;
                        item.reason = Some(reason);
                        report.queued.push(item);
                    }
                    Outcome::Broken(reason) => {
                        remove_item(&copy, &item)?;
                        item.reason = Some(reason);
                        report.dropped.push(item);
                    }
                }
            }
            Unit::Lesson(mut bundle) => {
                attach_draft(&mut bundle.lesson);
                for child in &mut bundle.items {
                    attach_draft(child);
                }
                let lesson_outcome = audit_lesson(
                    &copy,
                    &original,
                    &pack,
                    &review_lessons,
                    &mut bundle,
                    models,
                    programs,
                    limits,
                    &mut report,
                )
                .await?;
                let lesson_id = bundle.lesson.id.clone();
                if let Outcome::Broken(reason) = lesson_outcome {
                    remove_item(&copy, &bundle.lesson)?;
                    for mut child in bundle.items {
                        remove_item(&copy, &child)?;
                        child.reason =
                            Some(format!("its lesson {lesson_id} was left out: {reason}"));
                        report.dropped.push(child);
                    }
                    restore_links_for(
                        &original,
                        &pack,
                        &copy,
                        &lesson_id,
                        Some(&mut report.put_back),
                    )?;
                    review_lessons.remove(&lesson_id);
                    bundle.lesson.reason = Some(reason);
                    report.dropped.push(bundle.lesson);
                    continue;
                }

                // Re-check linked existing items in case revising the lesson changed its segments.
                let bundle_links = valid_links_for(
                    &copy,
                    &original,
                    &pack,
                    &lesson_id,
                    programs,
                    &mut report.put_back,
                )
                .await?;

                // Review each of the lesson's items blind, as items are reviewed now.
                let mut agreed_items = Vec::new();
                let mut disagreed_items = Vec::new();
                for mut child in bundle.items {
                    match review_item(
                        &copy,
                        &original,
                        &pack,
                        &review_lessons,
                        &mut child,
                        models,
                        programs,
                        limits,
                        &mut report,
                    )
                    .await?
                    {
                        Outcome::Agreed => agreed_items.push(child),
                        Outcome::Disagreed(reason) => {
                            child.reason = Some(reason);
                            disagreed_items.push(child);
                        }
                        Outcome::Broken(reason) => {
                            remove_item(&copy, &child)?;
                            child.reason = Some(reason);
                            report.dropped.push(child);
                        }
                    }
                }

                if agreed_items.len() + disagreed_items.len() < MIN_LESSON_ITEMS {
                    remove_item(&copy, &bundle.lesson)?;
                    bundle.lesson.reason = Some(format!(
                        "fewer than {MIN_LESSON_ITEMS} of its items remained after review"
                    ));
                    report.dropped.push(bundle.lesson);
                    for mut child in agreed_items.into_iter().chain(disagreed_items) {
                        remove_item(&copy, &child)?;
                        child.reason = Some(format!(
                            "its lesson {lesson_id} was left out, as fewer than {MIN_LESSON_ITEMS} of its items remained"
                        ));
                        report.dropped.push(child);
                    }
                    restore_links_for(
                        &original,
                        &pack,
                        &copy,
                        &lesson_id,
                        Some(&mut report.put_back),
                    )?;
                    review_lessons.remove(&lesson_id);
                    continue;
                }

                match lesson_outcome {
                    Outcome::Agreed if agreed_items.len() >= MIN_LESSON_ITEMS => {
                        report.accepted.push(bundle.lesson);
                        report.accepted.extend(agreed_items);
                        report.linked.extend(bundle_links);
                        for child in disagreed_items {
                            remove_item(&copy, &child)?;
                            report.queued.push(child);
                        }
                    }
                    Outcome::Agreed => {
                        // Fewer than MIN_LESSON_ITEMS items were agreed on without the disputed
                        // ones, so hold the lesson and its items together for approval.
                        remove_item(&copy, &bundle.lesson)?;
                        for child in agreed_items.iter().chain(disagreed_items.iter()) {
                            remove_item(&copy, child)?;
                        }
                        restore_links_for(&original, &pack, &copy, &lesson_id, None)?;
                        review_lessons.remove(&lesson_id);
                        bundle.lesson.reason = Some(format!(
                            "fewer than {MIN_LESSON_ITEMS} of its items were agreed on without items the reviewer objects to"
                        ));
                        bundle.lesson.items =
                            agreed_items.into_iter().chain(disagreed_items).collect();
                        bundle.lesson.linked = bundle_links;
                        report.queued.push(bundle.lesson);
                    }
                    Outcome::Disagreed(reason) => {
                        // Lesson waiting for approval holds its items and links.
                        remove_item(&copy, &bundle.lesson)?;
                        for child in agreed_items.iter().chain(disagreed_items.iter()) {
                            remove_item(&copy, child)?;
                        }
                        restore_links_for(&original, &pack, &copy, &lesson_id, None)?;
                        review_lessons.remove(&lesson_id);
                        bundle.lesson.reason = Some(reason);
                        bundle.lesson.items =
                            agreed_items.into_iter().chain(disagreed_items).collect();
                        bundle.lesson.linked = bundle_links;
                        report.queued.push(bundle.lesson);
                    }
                    Outcome::Broken(_) => unreachable!("handled above"),
                }
            }
        }
    }
    Ok(report)
}

enum Outcome {
    Agreed,
    Disagreed(String),
    Broken(String),
}

/// Groups new candidate items into standalone items and lesson bundles (each new lesson paired
/// with any new items whose front matter names that lesson).
fn group_into_units(copy: &Path, candidates: Vec<Written>) -> Result<Vec<Unit>> {
    let now = staging::read(copy)?;
    let mut lessons: Vec<Written> = Vec::new();
    let mut others: Vec<Written> = Vec::new();
    for item in candidates {
        let is_lesson = now
            .get(&item.path)
            .and_then(|bytes| staging::lesson_id_from_front_matter(&item.path, bytes))
            .is_some();
        if is_lesson {
            lessons.push(item);
        } else {
            others.push(item);
        }
    }
    let mut bundles: Vec<Bundle> = lessons
        .into_iter()
        .map(|lesson| Bundle {
            lesson,
            items: Vec::new(),
        })
        .collect();
    let mut units: Vec<Unit> = Vec::new();
    for item in others {
        let target = now
            .get(&item.path)
            .and_then(|bytes| staging::lesson_ref_from_front_matter(bytes));
        if let Some(target_id) = target
            && let Some(bundle) = bundles.iter_mut().find(|b| b.lesson.id == target_id)
        {
            bundle.items.push(item);
        } else {
            units.push(Unit::Standalone(item));
        }
    }
    for bundle in bundles {
        units.push(Unit::Lesson(bundle));
    }
    units.sort_by(|a, b| a.sort_key().cmp(b.sort_key()));
    Ok(units)
}

fn unit_lesson_ids(units: &[Unit]) -> BTreeSet<String> {
    units
        .iter()
        .filter_map(|u| match u {
            Unit::Lesson(bundle) => Some(bundle.lesson.id.clone()),
            Unit::Standalone(_) => None,
        })
        .collect()
}

fn flatten_units(units: &[Unit]) -> Vec<&Written> {
    let mut out = Vec::new();
    for unit in units {
        match unit {
            Unit::Standalone(item) => out.push(item),
            Unit::Lesson(bundle) => {
                out.push(&bundle.lesson);
                out.extend(bundle.items.iter());
            }
        }
    }
    out
}

fn refresh_units(copy: &Path, units: Vec<Unit>) -> Result<Vec<Unit>> {
    let now = staging::read(copy)?;
    let pack = Pack::from_files(now.clone())?;
    let refresh_one = |item: Written| -> Option<Written> {
        if !now.contains_key(&item.path) {
            return None;
        }
        Some(match pack.items.iter().find(|i| i.path == item.path) {
            Some(loaded) => Written {
                transcript: item.transcript,
                from_draft: item.from_draft,
                items: item.items,
                linked: item.linked,
                ..written(loaded, &now)
            },
            None => Written {
                files: files_of(&item.path, &now),
                ..item
            },
        })
    };
    let mut refreshed = Vec::with_capacity(units.len());
    for unit in units {
        match unit {
            Unit::Standalone(item) => {
                if let Some(item) = refresh_one(item) {
                    refreshed.push(Unit::Standalone(item));
                }
            }
            Unit::Lesson(bundle) => {
                if let Some(lesson) = refresh_one(bundle.lesson) {
                    let items = bundle.items.into_iter().filter_map(refresh_one).collect();
                    refreshed.push(Unit::Lesson(Bundle { lesson, items }));
                }
            }
        }
    }
    Ok(refreshed)
}

/// Current valid links from existing short items in `copy` to lessons in `allowed_lessons`.
fn current_links(
    original: &Files,
    original_pack: &Pack,
    copy: &Path,
    allowed_lessons: &BTreeSet<String>,
) -> Result<Vec<Linked>> {
    let now = staging::read(copy)?;
    let mut links = Vec::new();
    for item in &original_pack.items {
        if !item.kind.is_short() {
            continue;
        }
        let Some(before) = original.get(&item.path) else {
            continue;
        };
        let Some(after) = now.get(&item.path) else {
            continue;
        };
        if let Some((lesson, segment, content)) =
            staging::lesson_link_change(before, after, allowed_lessons)
        {
            links.push(Linked {
                path: item.path.clone(),
                id: item.id.clone(),
                label: item.label(),
                lesson,
                segment,
                content,
            });
        }
    }
    Ok(links)
}

/// Restores any existing items in `copy` that were linked to `lesson_id`, optionally recording
/// their paths in `put_back`.
fn restore_links_for(
    original: &Files,
    original_pack: &Pack,
    copy: &Path,
    lesson_id: &str,
    mut put_back: Option<&mut Vec<String>>,
) -> Result<()> {
    let only = BTreeSet::from([lesson_id.to_owned()]);
    for link in current_links(original, original_pack, copy, &only)? {
        if let Some(before) = original.get(&link.path) {
            staging::write(copy, &link.path, before)?;
            if let Some(list) = put_back.as_deref_mut() {
                list.push(link.path);
            }
        }
    }
    Ok(())
}

/// Returns the valid links to `lesson_id` in `copy` that pass `workshop pack check`, putting back
/// any that fail (e.g. an out-of-range segment after the lesson was revised).
async fn valid_links_for(
    copy: &Path,
    original: &Files,
    original_pack: &Pack,
    lesson_id: &str,
    programs: &dyn Programs,
    put_back: &mut Vec<String>,
) -> Result<Vec<Linked>> {
    let only = BTreeSet::from([lesson_id.to_owned()]);
    let links = current_links(original, original_pack, copy, &only)?;
    if links.is_empty() {
        return Ok(Vec::new());
    }
    let link_paths: Vec<String> = links.iter().map(|l| l.path.clone()).collect();
    let failing = failures_on_paths(copy, &[], &link_paths, programs).await?;
    let mut valid = Vec::new();
    for link in links {
        if failing.contains_key(&link.path) {
            if let Some(before) = original.get(&link.path) {
                staging::write(copy, &link.path, before)?;
            }
            put_back.push(link.path);
        } else {
            valid.push(link);
        }
    }
    Ok(valid)
}

async fn check_units_and_links(
    copy: &Path,
    original: &Files,
    original_pack: &Pack,
    units: &[Unit],
    allowed_lessons: &BTreeSet<String>,
    programs: &dyn Programs,
) -> Result<BTreeMap<String, String>> {
    let items: Vec<&Written> = flatten_units(units);
    let link_paths: Vec<String> = current_links(original, original_pack, copy, allowed_lessons)?
        .into_iter()
        .map(|l| l.path)
        .collect();
    failures_on_paths(copy, &items, &link_paths, programs).await
}

/// Has the reviewer solve a practice item blind and review it, and the writer and reviewer
/// discuss what it objects to.
#[allow(clippy::too_many_arguments)]
async fn review_item<M: Models>(
    copy: &Path,
    original: &Files,
    original_pack: &Pack,
    allowed_lessons: &BTreeSet<String>,
    item: &mut Written,
    models: &M,
    programs: &dyn Programs,
    limits: Limits,
    report: &mut Report,
) -> Result<Outcome> {
    let loaded = load_item(copy, &item.path)?;
    let solved = models.review(&blind_prompt(&loaded)).await?;
    item.transcript.push(Turn {
        who: "reviewer".to_owned(),
        text: solved.clone(),
    });
    let mut verdict = judge(models, item, &loaded, &solved, None).await?;
    for _ in 0..limits.discussion_rounds {
        let Some(objection) = verdict else {
            return Ok(Outcome::Agreed);
        };
        let reply = models.write(copy, &answer_prompt(item, &objection)).await?;
        let changes =
            staging::police_with_links(original, Some(original_pack), copy, allowed_lessons)?;
        report.put_back.extend(changes.put_back);
        let position: Position = json_in(&reply).unwrap_or(Position {
            position: "stands".to_owned(),
            reply: reply.clone(),
        });
        item.transcript.push(Turn {
            who: "writer".to_owned(),
            text: position.reply.clone(),
        });
        let refreshed = refresh(copy, vec![item.clone()])?;
        let Some(revised) = refreshed.into_iter().next() else {
            return Ok(Outcome::Broken(
                "the writer's revision left it unreadable".to_owned(),
            ));
        };
        let changed = revised.files != item.files;
        item.files = revised.files;
        item.label = revised.label;
        if changed || position.position == "revised" {
            let failing = failures(copy, std::slice::from_ref(item), programs).await?;
            if let Some(problem) = failing.get(&item.path) {
                return Ok(Outcome::Broken(format!(
                    "its check didn't pass once revised: {problem}"
                )));
            }
        }
        let loaded = load_item(copy, &item.path)?;
        verdict = judge(models, item, &loaded, &solved, Some(&position.reply)).await?;
    }
    Ok(match verdict {
        None => Outcome::Agreed,
        Some(objection) => Outcome::Disagreed(format!(
            "the reviewer still objects after {} rounds: {objection}",
            limits.discussion_rounds
        )),
    })
}

/// Has the reviewer audit a lesson and its accompanying items, and the writer and reviewer discuss
/// any objections.
#[allow(clippy::too_many_arguments)]
async fn audit_lesson<M: Models>(
    copy: &Path,
    original: &Files,
    original_pack: &Pack,
    allowed_lessons: &BTreeSet<String>,
    bundle: &mut Bundle,
    models: &M,
    programs: &dyn Programs,
    limits: Limits,
    report: &mut Report,
) -> Result<Outcome> {
    let mut verdict = judge_lesson(models, bundle, None).await?;
    for _ in 0..limits.discussion_rounds {
        let Some(objection) = verdict else {
            return Ok(Outcome::Agreed);
        };
        let reply = models
            .write(copy, &audit_answer_prompt(&bundle.lesson, &objection))
            .await?;
        let changes =
            staging::police_with_links(original, Some(original_pack), copy, allowed_lessons)?;
        report.put_back.extend(changes.put_back);
        let position: Position = json_in(&reply).unwrap_or(Position {
            position: "stands".to_owned(),
            reply: reply.clone(),
        });
        bundle.lesson.transcript.push(Turn {
            who: "writer".to_owned(),
            text: position.reply.clone(),
        });
        let refreshed = refresh(copy, vec![bundle.lesson.clone()])?;
        let Some(revised) = refreshed.into_iter().next() else {
            return Ok(Outcome::Broken(
                "the writer's revision left it unreadable".to_owned(),
            ));
        };
        let lesson_changed = revised.files != bundle.lesson.files;
        bundle.lesson.files = revised.files;
        bundle.lesson.label = revised.label;
        bundle.items = refresh(copy, std::mem::take(&mut bundle.items))?;
        if lesson_changed || position.position == "revised" {
            let mut to_check: Vec<&Written> = vec![&bundle.lesson];
            to_check.extend(bundle.items.iter());
            let failing = failures_on_paths(copy, &to_check, &[], programs).await?;
            if let Some(problem) = failing.get(&bundle.lesson.path) {
                return Ok(Outcome::Broken(format!(
                    "its check didn't pass once revised: {problem}"
                )));
            }
        }
        verdict = judge_lesson(models, bundle, Some(&position.reply)).await?;
    }
    Ok(match verdict {
        None => Outcome::Agreed,
        Some(objection) => Outcome::Disagreed(format!(
            "the reviewer still objects after {} rounds: {objection}",
            limits.discussion_rounds
        )),
    })
}

/// Has the reviewer audit a lesson and its accompanying items, returning its objection if any.
async fn judge_lesson<M: Models>(
    models: &M,
    bundle: &mut Bundle,
    writer: Option<&str>,
) -> Result<Option<String>> {
    let reply = models
        .review(&audit_prompt(&bundle.lesson, &bundle.items, writer))
        .await?;
    bundle.lesson.transcript.push(Turn {
        who: "reviewer".to_owned(),
        text: reply.clone(),
    });
    let verdict: Judgement = json_in(&reply)?;
    Ok((!verdict.agree || verdict.ambiguous).then(|| {
        if verdict.objection.trim().is_empty() {
            "it objects to the lesson".to_owned()
        } else {
            verdict.objection.clone()
        }
    }))
}

/// Has the reviewer compare its blind answer with the item's, and returns its objection, if it
/// has one. A numeric answer that doesn't match is an objection whatever it says.
async fn judge<M: Models>(
    models: &M,
    item: &mut Written,
    loaded: &Item,
    solved: &str,
    writer: Option<&str>,
) -> Result<Option<String>> {
    let reply = models.review(&compare_prompt(item, solved, writer)).await?;
    item.transcript.push(Turn {
        who: "reviewer".to_owned(),
        text: reply.clone(),
    });
    let verdict: Judgement = json_in(&reply)?;
    let mut objection = (!verdict.agree || verdict.ambiguous).then(|| {
        if verdict.objection.trim().is_empty() {
            "it doesn't agree with the item's answer".to_owned()
        } else {
            verdict.objection.clone()
        }
    });
    if writer.is_none()
        && let Some(mismatch) = numeric_mismatch(loaded, solved)
    {
        objection = Some(match objection {
            Some(o) => format!("{o} ({mismatch})"),
            None => mismatch,
        });
    }
    Ok(objection)
}

/// Whether a numeric answer the reviewer gave blind differs from the item's, for items whose
/// answers are numbers.
fn numeric_mismatch(item: &Item, solved: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Solved {
        answer: serde_json::Value,
    }
    let solved: Solved = json_in(solved).ok()?;
    let given = match &solved.answer {
        serde_json::Value::Number(n) => n.as_f64()?,
        serde_json::Value::String(s) => workshop_pack::number::parse(s)?,
        _ => return None,
    };
    let (expected, tolerance) = match &item.content {
        Content::Probability(p) => (p.answer, p.tolerance),
        Content::MentalMaths(template) => {
            let instance = workshop_pack::mental::Generator::new(template, &item.prompt)
                .ok()?
                .instance(0)
                .ok()?;
            (instance.answer, template.tolerance)
        }
        _ => return None,
    };
    (!tolerance.allows(expected, given)).then(|| {
        format!(
            "solved blind, it came to {}, where the item says {}",
            workshop_pack::number::display(given),
            workshop_pack::number::display(expected)
        )
    })
}

/// The new items in the copy, by the item's file, each with its files.
fn new_items(original: &Files, copy: &Path) -> Result<Vec<Written>> {
    let now = staging::read(copy)?;
    let pack = Pack::from_files(now.clone())?;
    let mut items: Vec<Written> = Vec::new();
    for item in &pack.items {
        if original.contains_key(&item.path) {
            continue;
        }
        items.push(written(item, &now));
    }
    // New files that aren't readable items are items too, which fail their check.
    for problem in &pack.problems {
        if problem.path.starts_with("items/")
            && !original.contains_key(&problem.path)
            && !items.iter().any(|i| i.path == problem.path)
        {
            let files = files_of(&problem.path, &now);
            let id = now
                .get(&problem.path)
                .and_then(|bytes| staging::lesson_id_from_front_matter(&problem.path, bytes))
                .unwrap_or_else(|| problem.path.clone());
            items.push(Written {
                id,
                label: problem.path.clone(),
                path: problem.path.clone(),
                skills: Vec::new(),
                files,
                from_draft: None,
                transcript: Vec::new(),
                reason: None,
                items: Vec::new(),
                linked: Vec::new(),
            });
        }
    }
    items.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(items)
}

fn written(item: &Item, files: &Files) -> Written {
    Written {
        path: item.path.clone(),
        id: item.id.clone(),
        label: item.label(),
        skills: item.skills.clone(),
        files: files_of(&item.path, files),
        from_draft: None,
        transcript: Vec::new(),
        reason: None,
        items: Vec::new(),
        linked: Vec::new(),
    }
}

/// An item's files: the one file, or every file in its directory.
fn files_of(path: &str, files: &Files) -> BTreeMap<String, String> {
    let dir = path.strip_suffix("/item.md").map(|d| format!("{d}/"));
    files
        .iter()
        .filter(|(p, _)| *p == path || dir.as_ref().is_some_and(|d| p.starts_with(d)))
        .map(|(p, bytes)| (p.clone(), String::from_utf8_lossy(bytes).into_owned()))
        .collect()
}

fn owns(item: &Written, path: &str) -> bool {
    path == item.path
        || item
            .path
            .strip_suffix("/item.md")
            .is_some_and(|dir| path.starts_with(&format!("{dir}/")))
}

/// The items as they are now in the copy.
fn refresh(copy: &Path, items: Vec<Written>) -> Result<Vec<Written>> {
    let now = staging::read(copy)?;
    let pack = Pack::from_files(now.clone())?;
    Ok(items
        .into_iter()
        .filter(|item| now.contains_key(&item.path))
        .map(
            |item| match pack.items.iter().find(|i| i.path == item.path) {
                Some(loaded) => Written {
                    transcript: item.transcript,
                    from_draft: item.from_draft,
                    items: item.items,
                    linked: item.linked,
                    ..written(loaded, &now)
                },
                None => Written {
                    files: files_of(&item.path, &now),
                    ..item
                },
            },
        )
        .collect())
}

fn remove_item(copy: &Path, item: &Written) -> Result<()> {
    for path in item.files.keys() {
        staging::remove(copy, path)?;
    }
    Ok(())
}

fn load_item(copy: &Path, path: &str) -> Result<Item> {
    let pack = Pack::from_files(staging::read(copy)?)?;
    pack.items
        .into_iter()
        .find(|i| i.path == path)
        .with_context(|| format!("{path} can't be read"))
}

/// What's wrong with each of these items, by its path, as `workshop pack check` finds it. An
/// item that can't be checked here counts as failing, as it hasn't been shown to be right.
async fn failures(
    copy: &Path,
    items: &[Written],
    programs: &dyn Programs,
) -> Result<BTreeMap<String, String>> {
    let refs: Vec<&Written> = items.iter().collect();
    failures_on_paths(copy, &refs, &[], programs).await
}

/// Like [`failures`], also checking linked existing items at `extra_paths`.
async fn failures_on_paths(
    copy: &Path,
    items: &[&Written],
    extra_paths: &[String],
    programs: &dyn Programs,
) -> Result<BTreeMap<String, String>> {
    let pack = Pack::from_files(staging::read(copy)?)?;
    // Only these items are checked: the rest of the pack is kept for cross-item checks, without
    // rebuilding its existing coding problems.
    let mut paths: BTreeSet<&str> = items.iter().map(|i| i.path.as_str()).collect();
    for path in extra_paths {
        paths.insert(path.as_str());
    }
    let report = pack.check_only(&paths, programs).await;
    let mut failing = BTreeMap::new();
    for item in items {
        if let Some(problem) = report.problems.iter().find(|p| owns(item, &p.path)) {
            failing.insert(item.path.clone(), problem.message.clone());
            continue;
        }
        record_verdict(&report, &item.path, &mut failing);
    }
    for path in extra_paths {
        if let Some(problem) = report.problems.iter().find(|p| p.path == *path) {
            failing.insert(path.clone(), problem.message.clone());
            continue;
        }
        record_verdict(&report, path, &mut failing);
    }
    Ok(failing)
}

fn record_verdict(
    report: &workshop_pack::Report,
    path: &str,
    failing: &mut BTreeMap<String, String>,
) {
    match report
        .items
        .iter()
        .find(|c| c.path == path)
        .map(|c| &c.verdict)
    {
        Some(Verdict::Passed(_)) => {}
        Some(Verdict::Failed(why)) => {
            failing.insert(path.to_owned(), why.clone());
        }
        Some(Verdict::Skipped(why)) => {
            failing.insert(
                path.to_owned(),
                format!("it couldn't be checked here, as {why}"),
            );
        }
        None => {
            failing.insert(path.to_owned(), "it can't be read".to_owned());
        }
    }
}

/// Each skill found too easy, with its level and the items retired, one per line.
fn push_too_easy(out: &mut String, too_easy: &[TooEasy]) {
    for too_easy in too_easy {
        let retired: Vec<String> = too_easy
            .retired
            .iter()
            .map(|(title, difficulty)| match difficulty {
                Some(difficulty) => format!("\"{title}\" (difficulty {difficulty})"),
                None => format!("\"{title}\" (no difficulty given, so taken as 3)"),
            })
            .collect();
        out.push_str(&format!(
            "- {} (level {}): {}\n",
            too_easy.skill,
            too_easy.level,
            retired.join(", ")
        ));
    }
}

fn writer_prompt(pack: &Pack, brief: &Brief, limits: Limits) -> String {
    let mut out = format!(
        "<format>\n{}\n</format>\n\nThe pack is \"{}\". Its skills:\n",
        FORMAT.trim(),
        pack.manifest.name
    );
    for skill in &pack.manifest.skills {
        out.push_str(&format!("- {}: {}\n", skill.id, skill.name));
        if !skill.topics.is_empty() {
            let topics: Vec<String> = skill
                .topics
                .iter()
                .map(|topic| format!("{} ({})", topic.id, topic.name))
                .collect();
            out.push_str(&format!("  Topics: {}\n", topics.join(", ")));
        }
    }
    if pack
        .manifest
        .skills
        .iter()
        .any(|skill| !skill.topics.is_empty())
    {
        out.push_str("Give every lesson you write for a skill with topics the `topic` it teaches, such as `topic = \"skill.id/topic-id\"`, one topic a lesson.\n");
    }
    if !brief.lesson_requests.is_empty() {
        out.push_str("\nRequests for lessons come first. The learner tapped \"Teach me\" on these short items, which have no lesson yet. Write a lesson for them (one lesson can cover several related items) with 3 to 6 new short items, and link each requested item to it by adding `lesson` (and `segment`, counting from 1, where one segment covers it) in its front matter:\n");
        for req in &brief.lesson_requests {
            out.push_str(&format!(
                "- {} (id: {}, skills: {})\n  Prompt: {}\n  Answer: {}\n",
                req.path,
                req.id,
                req.skills.join(", "),
                req.prompt.trim(),
                req.answer.trim(),
            ));
            if let Some(explanation) = &req.explanation
                && !explanation.trim().is_empty()
            {
                out.push_str(&format!("  Explanation: {}\n", explanation.trim()));
            }
        }
    }
    if !brief.skill_coverage.is_empty() {
        out.push_str("\nLesson coverage for the skills this run targets. Write a lesson where a skill's items assume knowledge no lesson teaches, and where existing items in the pack would be taught by a new lesson, link them to it by adding or changing only `lesson` and `segment` in their front matter:\n");
        for cov in &brief.skill_coverage {
            let lessons = if cov.lessons == 1 {
                "1 lesson".to_owned()
            } else {
                format!("{} lessons", cov.lessons)
            };
            let items = if cov.unlinked_items == 1 {
                "1 item without a lesson".to_owned()
            } else {
                format!("{} items without a lesson", cov.unlinked_items)
            };
            out.push_str(&format!("- {}: {lessons}, {items}\n", cov.skill));
            if !cov.untaught_topics.is_empty() {
                let topics: Vec<String> = cov
                    .untaught_topics
                    .iter()
                    .map(|(id, name)| format!("`{}/{id}` ({name})", cov.skill))
                    .collect();
                out.push_str(&format!(
                    "  Topics no lesson teaches yet: {}\n",
                    topics.join(", ")
                ));
            }
        }
        if brief
            .skill_coverage
            .iter()
            .any(|cov| !cov.untaught_topics.is_empty())
        {
            out.push_str("Lessons for these skills, after any requested ones, should teach the topics no lesson teaches yet, one topic each, as a skill barely covered is as weak as one barely recalled.\n");
        }
    }
    if !brief.weakest.is_empty() {
        out.push_str(
            "\nThe learner's weakest skills, with how much of each has been taught and then recalled (covered), and how well what's been taught is recalled, each from 0 to 1:\n",
        );
        for weak in &brief.weakest {
            out.push_str(&format!(
                "- {}: covered {:.2}, recall {:.2}\n",
                weak.skill, weak.coverage, weak.recall
            ));
        }
    }
    if !brief.too_easy.is_empty() {
        out.push_str("\nProblems the learner found too easy, and retired, by skill. Write harder problems for these skills, at the skill's level, which is above what they found easy, and none at the same difficulty as these or easier:\n");
        push_too_easy(&mut out, &brief.too_easy);
    }
    if !brief.fixed_too_easy.is_empty() {
        out.push_str("\nCode to read and probability questions the learner found too easy, and retired, by skill: they knew the answer by heart, so seeing these again would test their memory of it rather than the concept. For these skills, write new items of the same kind that are harder, at the level given, with their `difficulty` set, and that test the concept differently: different code or a different situation, where the concept shows up in a less obvious way or combines with another, so the answer can't be recalled from these. Never a copy of one of these reworded, with its names or numbers changed, or asking the same question of the same code:\n");
        push_too_easy(&mut out, &brief.fixed_too_easy);
    }
    if !brief.levels.is_empty() {
        out.push_str("\nHow hard each skill's coding problems should be, from 1 to 5, as their `difficulty` goes. A level rises as the learner finds problems easy and falls as they forget them. Write a skill's new problems at its level, and give each its `difficulty`:\n");
        for (skill, level) in &brief.levels {
            out.push_str(&format!("- {skill}: {level}\n"));
        }
    }
    if !brief.mistakes.is_empty() {
        out.push_str("\nThe kinds of mistake they've made most lately:\n");
        for (kind, count) in &brief.mistakes {
            out.push_str(&format!("- {kind}: {count}\n"));
        }
        let kinds: Vec<String> = pack
            .manifest
            .all_error_types()
            .into_iter()
            .map(|t| format!("{} ({})", t.id, t.description))
            .collect();
        out.push_str(&format!("The kinds are: {}.\n", kinds.join("; ")));
    }
    if !brief.examples.is_empty() {
        out.push_str("\nSome of those mistakes:\n");
        for example in &brief.examples {
            out.push_str(&format!("- {example}\n"));
        }
    }
    if !pack.drafts.is_empty() {
        out.push_str("\nDrafts waiting to be made into items, in drafts/. Make an item from one with a check, and delete its file, if it's for the skills above or there's room:\n");
        for draft in &pack.drafts {
            out.push_str(&format!("- {}: {}\n", draft.path, draft.label()));
        }
    }
    if !brief.answers.is_empty() {
        out.push_str("\nThe learner's answers to questions you asked before:\n");
        for (question, answer) in &brief.answers {
            out.push_str(&format!("- Q: {question}\n  A: {answer}\n"));
        }
    }
    out.push_str(&format!(
        "\nWrite at most {} new items (a lesson together with its 3 to 6 new items counts as one towards this limit), addressing lesson requests first, then the weakest skills, the topics no lesson teaches yet and the kinds of mistake above, and harder problems where they found them too easy. Then reply with JSON: {{\"items\": [{{\"path\": the item's file, such as items/x.md or items/x/item.md, \"from_draft\": the draft's path, if you made it from one, or null}}], \"questions\": [questions for the learner, if any]}}",
        limits.max_items
    ));
    out
}

fn fix_prompt(failing: &BTreeMap<String, String>) -> String {
    let mut out = String::from(
        "These items you wrote don't pass their checks yet. Fix each in place, keeping its files where they are, without weakening its check:\n\n",
    );
    for (path, problem) in failing {
        out.push_str(&format!("- {path}: {problem}\n"));
    }
    out.push_str("\nReply with JSON: {\"items\": [], \"questions\": []}");
    out
}

/// The item as a learner would see it, without its answer.
fn blind_prompt(item: &Item) -> String {
    let mut out = String::from("Solve this, without seeing its answer.\n\n<question>\n");
    match &item.content {
        Content::MentalMaths(template) => {
            let prompt = workshop_pack::mental::Generator::new(template, &item.prompt)
                .and_then(|g| g.instance(0))
                .map_or_else(|_| item.prompt.clone(), |i| i.prompt);
            out.push_str(&prompt);
        }
        // Every part of a problem in parts, as the learner sees each in turn.
        Content::Coding(coding) => out.push_str(coding.statement(coding.last()).trim()),
        _ => out.push_str(item.prompt.trim()),
    }
    out.push_str("\n</question>\n");
    match &item.content {
        Content::Coding(coding) if let Some(project) = coding.project() => {
            let files = project.files.iter().chain(
                coding
                    .test_files(coding.last())
                    .into_iter()
                    .filter(|f| project.file(&f.path).is_none()),
            );
            out.push_str(&format!(
                "\nThe question is set in this project, whose test files are run as its tests:\n\n<project>\n{}</project>\n",
                workshop_pack::project::as_text(files)
            ));
            out.push_str(match project.task {
                workshop_pack::Task::Fix => {
                    "\nSay what the bug is, why it gives the symptom, and how you'd fix it, as the answer.\n"
                }
                _ => "\nSay how you'd refactor it and then extend it, part by part, as the answer.\n",
            });
        }
        Content::Review(review) => {
            out.push_str(&format!(
                "\nThe project, before the change:\n\n<project>\n{}</project>\n\nThe change:\n\n<change>\n{}</change>\n\nReview the change: list each thing wrong with it, with the file and line in the changed file, as the answer.\n",
                workshop_pack::project::as_text(review.files.iter()),
                review.diff()
            ));
        }
        Content::Coding(coding) => {
            if let Some(api) = &coding.api {
                out.push_str(&format!(
                    "\nThe tests call {}. Each example's input is the calls it makes, one a line, as a JSON array of the name called and its arguments, where a call to the class makes a new one; its output is what each other call returns, one a line, as JSON.\n",
                    api.describe()
                ));
            }
            out.push_str("\nExamples:\n");
            for (p, part) in coding.parts.iter().enumerate() {
                for example in &part.examples {
                    let label = if coding.in_parts() {
                        format!(" part=\"{}\"", p + 1)
                    } else {
                        String::new()
                    };
                    out.push_str(&format!(
                        "<input{label}>\n{}\n</input>\n<output>\n{}\n</output>\n",
                        example.input.trim_end(),
                        example.output.trim_end()
                    ));
                }
            }
            out.push_str("\nGive the approach you'd take, and its cost, as the answer.\n");
        }
        Content::Reading(reading) => {
            if let workshop_pack::Question::Choice { choices, .. } = &reading.question {
                out.push_str("\nChoices:\n");
                for (n, choice) in choices.iter().enumerate() {
                    out.push_str(&format!("{}. {choice}\n", n + 1));
                }
            }
        }
        _ => {}
    }
    out.push_str(
        "\nReply with JSON: {\"answer\": your answer, as a number where it's one, \"working\": brief working, \"unclear\": [anything you had to guess at]}",
    );
    out
}

fn compare_prompt(item: &Written, solved: &str, writer: Option<&str>) -> String {
    let mut out = String::from("<item>\n");
    for (path, text) in &item.files {
        out.push_str(&format!(
            "<file path=\"{path}\">\n{}\n</file>\n",
            text.trim_end()
        ));
    }
    out.push_str(&format!(
        "</item>\n\n<your_blind_solution>\n{}\n</your_blind_solution>\n\n",
        solved.trim()
    ));
    match writer {
        Some(reply) => out.push_str(&format!(
            "You objected to the item, and its author replied, perhaps revising it, as it is above:\n<author>\n{}\n</author>\n\nLook again: is the item now right and unambiguous?",
            reply.trim()
        )),
        None => out.push_str(
            "Compare your answer with the item's: is the item right, and unambiguous?",
        ),
    }
    out.push_str(" Reply with JSON: {\"agree\": true or false, \"ambiguous\": true or false, \"objection\": what's wrong and how to fix it, or \"\"}");
    out
}

fn answer_prompt(item: &Written, objection: &str) -> String {
    format!(
        "Another model solved {} blind, compared its answer with the item's, and objects:\n\n<objection>\n{}\n</objection>\n\nIf it's right, revise the item's files to fix it, keeping them where they are and its check honest. If the item stands, say why. Reply with JSON: {{\"position\": \"revised\" or \"stands\", \"reply\": what you'd say to it}}",
        item.path,
        objection.trim()
    )
}

/// Prompt asking the reviewer to audit a lesson and its accompanying items.
fn audit_prompt(lesson: &Written, items: &[Written], writer: Option<&str>) -> String {
    let mut out = String::from("Audit this lesson and its accompanying items.\n\n<lesson>\n");
    for (path, text) in &lesson.files {
        out.push_str(&format!(
            "<file path=\"{path}\">\n{}\n</file>\n",
            text.trim_end()
        ));
    }
    out.push_str("</lesson>\n\n<items>\n");
    for item in items {
        for (path, text) in &item.files {
            out.push_str(&format!(
                "<file path=\"{path}\">\n{}\n</file>\n",
                text.trim_end()
            ));
        }
    }
    out.push_str("</items>\n\n");
    match writer {
        Some(reply) => out.push_str(&format!(
            "You objected to the lesson, and its author replied, perhaps revising it, as it is above:\n<author>\n{}\n</author>\n\nLook again: are your objections resolved and is the lesson now accurate and clear?",
            reply.trim()
        )),
        None => out.push_str(
            "Check:\n\
             - every factual claim, saying which you believe wrong or misleading and why; object to any claim you believe wrong, and to any you aren't sure of that's stated as certain (including behaviour that varies by version or configuration without saying so);\n\
             - each guess's and check's answer, that it is right and the only right choice, and each check's explanation;\n\
             - the `## Explain answer`;\n\
             - that the sources listed in `[[sources]]` appear real and relevant, as far as you can tell without fetching them;\n\
             - any diagram, read as SVG source, that it shows what the text says and has no overlapping text and shapes.",
        ),
    }
    out.push_str(" Reply with JSON: {\"agree\": true or false, \"ambiguous\": true or false, \"objection\": what's wrong and how to fix it, or \"\"}");
    out
}

fn audit_answer_prompt(lesson: &Written, objection: &str) -> String {
    format!(
        "Another model audited {} and objects:\n\n<objection>\n{}\n</objection>\n\nIf it's right, revise the lesson's files to fix it, keeping them where they are (and keeping any checks, diagrams and accompanying items consistent). If the lesson stands, say why. Reply with JSON: {{\"position\": \"revised\" or \"stands\", \"reply\": what you'd say to it}}",
        lesson.path,
        objection.trim()
    )
}

#[cfg(test)]
mod tests;
