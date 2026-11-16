//! The author: writes new items for a pack, for the skills the learner is weakest in and the
//! mistakes they make most, and has each one checked before it's accepted.
//!
//! A run goes:
//!
//! 1. The pack is copied, leaving out anything hidden such as `.git`, and the writer, a strong
//!    model with tools confined to the copy, writes new items there. It's the only role with
//!    tools, and never has the pack itself in reach. Anything it changes besides adding items,
//!    and deleting drafts it made items from, is put back.
//! 2. Items beyond the run's cap are dropped. Every item must pass its mechanical check, as
//!    `workshop pack check` runs it; the writer gets a few rounds to fix those that fail, and
//!    those that still do are dropped.
//! 3. A model from another provider, with no tools, solves each item blind, then compares its
//!    answer with the item's and says whether the item is right and unambiguous. Where it can
//!    be told mechanically, such as a probability's answer, its answer is compared too.
//! 4. If they disagree, the writer answers the objection, revising the item or saying why it
//!    stands, and the reviewer looks again, for a few rounds. Items they agree on are accepted;
//!    the rest wait in an approval queue for the learner.
//!
//! The writer can ask the learner questions, which go out as they're asked, so the learner can
//! answer later; the run carries on without waiting. What's accepted is returned for the caller
//! to put in the pack, and what's queued for it to keep.

pub mod staging;

use std::collections::BTreeMap;
use std::future::Future;
use std::path::Path;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use workshop_pack::{Content, Item, Pack, Programs, Verdict};

use crate::staging::Files;

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
    /// The most new items a run writes.
    pub max_items: usize,
    /// Rounds the writer gets to fix items whose checks fail.
    pub fix_rounds: usize,
    /// Rounds of discussion when the writer and reviewer disagree.
    pub discussion_rounds: usize,
}

/// What a run should write about.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Brief {
    /// The skills the learner is weakest in, weakest first, with their mastery from 0 to 1.
    pub weakest: Vec<(String, f64)>,
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

    let changes = staging::police(&original, &copy)?;
    report.put_back.extend(changes.put_back);
    let mut candidates = new_items(&original, &copy)?;
    // Over the cap, the last by path are dropped.
    while candidates.len() > limits.max_items {
        let mut over = candidates.pop().expect("more than the cap");
        remove_item(&copy, &over)?;
        over.reason = Some(format!(
            "over the run's limit of {} items",
            limits.max_items
        ));
        report.dropped.push(over);
    }

    // Every item must pass its check; the writer can fix those that don't, a few times.
    let mut failing = failures(&copy, &candidates, programs).await?;
    for _ in 0..limits.fix_rounds {
        if failing.is_empty() {
            break;
        }
        models.write(&copy, &fix_prompt(&failing)).await?;
        let changes = staging::police(&original, &copy)?;
        report.put_back.extend(changes.put_back);
        // Only the items there already: a new one now would skip the cap.
        let known: Vec<String> = candidates
            .iter()
            .flat_map(|c| c.files.keys().cloned())
            .collect();
        for added in changes.added.iter().filter(|p| !known.contains(p)) {
            if !candidates.iter().any(|c| owns(c, added)) {
                staging::remove(&copy, added)?;
                report.put_back.push(added.clone());
            }
        }
        candidates = refresh(&copy, candidates)?;
        failing = failures(&copy, &candidates, programs).await?;
    }
    let (passing, failed): (Vec<Written>, Vec<Written>) = candidates
        .into_iter()
        .partition(|c| !failing.contains_key(&c.path));
    for mut item in failed {
        remove_item(&copy, &item)?;
        item.reason = Some(format!("its check didn't pass: {}", failing[&item.path]));
        report.dropped.push(item);
    }

    // A second model solves each one blind, then reviews it, and they discuss what it objects to.
    for mut item in passing {
        item.from_draft = from_drafts
            .get(&item.path)
            .cloned()
            .filter(|draft| changes.drafts_removed.contains(draft));
        match review(
            &copy,
            &original,
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
                item.reason = Some(reason);
                report.queued.push(item);
            }
            Outcome::Broken(reason) => {
                item.reason = Some(reason);
                report.dropped.push(item);
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

/// Has the reviewer solve an item blind and review it, and the writer and reviewer discuss what
/// it objects to.
async fn review<M: Models>(
    copy: &Path,
    original: &Files,
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
        let changes = staging::police(original, copy)?;
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
            items.push(Written {
                id: problem.path.clone(),
                label: problem.path.clone(),
                path: problem.path.clone(),
                skills: Vec::new(),
                files,
                from_draft: None,
                transcript: Vec::new(),
                reason: None,
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
    let mut pack = Pack::from_files(staging::read(copy)?)?;
    // Only these items are checked: the rest of the pack is as it was, and its coding problems
    // take a while to build.
    pack.items
        .retain(|i| items.iter().any(|item| item.path == i.path));
    let report = pack.check(programs).await;
    let mut failing = BTreeMap::new();
    for item in items {
        if let Some(problem) = report.problems.iter().find(|p| owns(item, &p.path)) {
            failing.insert(item.path.clone(), problem.message.clone());
            continue;
        }
        match report
            .items
            .iter()
            .find(|c| c.path == item.path)
            .map(|c| &c.verdict)
        {
            Some(Verdict::Passed(_)) => {}
            Some(Verdict::Failed(why)) => {
                failing.insert(item.path.clone(), why.clone());
            }
            Some(Verdict::Skipped(why)) => {
                failing.insert(
                    item.path.clone(),
                    format!("it couldn't be checked here, as {why}"),
                );
            }
            None => {
                failing.insert(item.path.clone(), "it can't be read".to_owned());
            }
        }
    }
    Ok(failing)
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
    }
    if !brief.weakest.is_empty() {
        out.push_str(
            "\nThe learner's weakest skills, with how well they know each, from 0 to 1:\n",
        );
        for (skill, mastery) in &brief.weakest {
            out.push_str(&format!("- {skill}: {mastery:.2}\n"));
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
        "\nWrite at most {} new items, for the weakest skills and the kinds of mistake above, so the learner practises what they get wrong, and harder problems where they found them too easy. Then reply with JSON: {{\"items\": [{{\"path\": the item's file, such as items/x.md or items/x/item.md, \"from_draft\": the draft's path, if you made it from one, or null}}], \"questions\": [questions for the learner, if any]}}",
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
        _ => out.push_str(item.prompt.trim()),
    }
    out.push_str("\n</question>\n");
    match &item.content {
        Content::Coding(coding) => {
            out.push_str("\nExamples:\n");
            for example in &coding.examples {
                out.push_str(&format!(
                    "<input>\n{}\n</input>\n<output>\n{}\n</output>\n",
                    example.input.trim_end(),
                    example.output.trim_end()
                ));
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

#[cfg(test)]
mod tests;
