//! Running the author for a pack of the learner's own, from `workshop author` or the app's top-up
//! button: what it's told to write about, the models it runs, and what becomes of what it
//! writes. Items that are accepted go into the pack's files and are committed to its git repo,
//! on the branch it's on, and never pushed; items waiting for approval and questions for the
//! learner are kept in Workshop's data directory.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use workshop_author::{
    Brief, LessonRequest, Limits, Linked, Models, Report, SkillCoverage, TooEasy, WeakSkill,
    Written,
};
use workshop_learning::{Clock, SkillMastery};
use workshop_pack::{Content, Item, Kind, Lesson, Pack};
use workshop_provider::{AgentConfig, CallSpec, ProviderRunner, Role};

use crate::config::Config;
use crate::learning::{Learning, now_ms};
use crate::paths::Paths;

pub mod reviewer;
pub mod schedule;

/// How far back mistakes count towards what the author writes about.
const MISTAKES_MS: i64 = 30 * workshop_learning::schedule::DAY_MS;

/// The author's own files, in Workshop's data directory.
pub struct Desk {
    dir: PathBuf,
    lock: Mutex<()>,
}

/// An item waiting for the learner's approval.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Queued {
    pub id: String,
    /// The pack it's for, by id.
    pub pack: String,
    pub at: i64,
    pub item: Written,
}

/// A question the author asked the learner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Question {
    pub id: String,
    pub text: String,
    pub asked_at: i64,
    pub answer: Option<String>,
    /// Whether a run has been told the answer, after which it's no longer shown.
    #[serde(default)]
    pub told: bool,
}

/// How the last run went.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LastRun {
    pub started_at: i64,
    pub finished_at: i64,
    pub report: Option<Report>,
    /// The commit accepted items went into, if the pack is a git repo.
    pub commit: Option<String>,
    pub error: Option<String>,
}

/// How many times taking the author's lock is tried, and how long to wait between tries.
const LOCK_ATTEMPTS: u32 = 10;
const LOCK_RETRY: std::time::Duration = std::time::Duration::from_millis(10);

impl Desk {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.join("author"),
            lock: Mutex::new(()),
        }
    }

    fn read<T: for<'de> Deserialize<'de> + Default>(&self, name: &str) -> Result<T> {
        let path = self.dir.join(name);
        match std::fs::read_to_string(&path) {
            Ok(text) => {
                serde_json::from_str(&text).with_context(|| format!("reading {}", path.display()))
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
            Err(err) => Err(err).with_context(|| format!("reading {}", path.display())),
        }
    }

    fn write<T: Serialize>(&self, name: &str, value: &T) -> Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        workshop_common::files::write_atomic(
            &self.dir.join(name),
            serde_json::to_string_pretty(value)?.as_bytes(),
        )
    }

    fn change<T: Serialize + for<'de> Deserialize<'de> + Default, R>(
        &self,
        name: &str,
        change: impl FnOnce(&mut T) -> R,
    ) -> Result<R> {
        let _guard = self
            .lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut value: T = self.read(name)?;
        let result = change(&mut value);
        self.write(name, &value)?;
        Ok(result)
    }

    pub fn queue(&self) -> Result<Vec<Queued>> {
        self.read("queue.json")
    }

    pub fn questions(&self) -> Result<Vec<Question>> {
        self.read("questions.json")
    }

    pub fn last_run(&self) -> Result<Option<LastRun>> {
        self.read("last-run.json")
    }

    pub fn answer(&self, id: &str, answer: &str) -> Result<()> {
        let answer = answer.trim();
        if answer.is_empty() {
            bail!("there's no answer to give");
        }
        self.change("questions.json", |questions: &mut Vec<Question>| {
            let question = questions
                .iter_mut()
                .find(|q| q.id == id)
                .with_context(|| format!("there's no question {id:?}"))?;
            question.answer = Some(answer.to_owned());
            anyhow::Ok(())
        })?
    }

    fn ask(&self, text: &str, at: i64) -> Result<Question> {
        self.change("questions.json", |questions: &mut Vec<Question>| {
            let question = Question {
                id: format!("q{at}-{}", questions.len() + 1),
                text: text.to_owned(),
                asked_at: at,
                answer: None,
                told: false,
            };
            questions.push(question.clone());
            question
        })
    }

    /// Takes an item off the queue.
    pub fn take(&self, id: &str) -> Result<Queued> {
        self.change("queue.json", |queue: &mut Vec<Queued>| {
            let index = queue
                .iter()
                .position(|q| q.id == id)
                .with_context(|| format!("there's no item {id:?} waiting for approval"))?;
            anyhow::Ok(queue.remove(index))
        })?
    }

    fn enqueue(&self, items: Vec<Queued>) -> Result<()> {
        self.change("queue.json", |queue: &mut Vec<Queued>| queue.extend(items))
    }

    /// Holds the author's lock for as long as it's kept, so only one run, from the app or the
    /// command, happens at a time.
    pub fn try_lock(&self) -> Result<Option<std::fs::File>> {
        std::fs::create_dir_all(&self.dir)?;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(self.dir.join("lock"))?;
        // A process another thread is starting holds a copy of every open file between its fork
        // and its exec, this lock included, so a lock just let go of can look held for a moment.
        // Trying again briefly tells that apart from a run that's really going.
        for _ in 0..LOCK_ATTEMPTS - 1 {
            match file.try_lock() {
                Ok(()) => return Ok(Some(file)),
                Err(std::fs::TryLockError::WouldBlock) => std::thread::sleep(LOCK_RETRY),
                Err(std::fs::TryLockError::Error(err)) => return Err(err.into()),
            }
        }
        match file.try_lock() {
            Ok(()) => Ok(Some(file)),
            Err(std::fs::TryLockError::WouldBlock) => Ok(None),
            Err(std::fs::TryLockError::Error(err)) => Err(err.into()),
        }
    }
}

/// The models a run uses: the writer as an agent confined to the pack's copy, and the reviewer
/// with no tools.
struct ProviderModels {
    agent: AgentConfig,
    writer: CallSpec,
    reviewer: ProviderRunner,
    reviewer_spec: CallSpec,
    prompt_dir: PathBuf,
    timeout: Duration,
}

impl Models for ProviderModels {
    async fn write(&self, dir: &Path, prompt: &str) -> Result<String> {
        self.agent
            .run(&self.writer, dir, &self.prompt_dir, prompt, self.timeout)
            .await
            .context("the writer")
    }

    async fn review(&self, prompt: &str) -> Result<String> {
        Ok(self
            .reviewer
            .call_aside(&self.reviewer_spec, prompt, self.timeout)
            .await
            .context("the reviewer")?
            .text)
    }
}

/// The pack the author writes for: the one with this id, or the only one in the config.
fn pack_dir(config: &Config, pack: Option<&str>) -> Result<PathBuf> {
    if config.learning.packs.is_empty() {
        bail!(
            "the author writes items for a pack of your own, and the sample pack is built in; list your pack under [learning] in your config"
        );
    }
    crate::pack_files::chosen_pack_dir(&config.learning, pack)
}

async fn models(config: &Config, pack: &Pack, work_dir: &Path) -> Result<ProviderModels> {
    let settings = &config.author;
    let chosen = reviewer::chosen(config).await;
    tracing::info!(
        "the author's reviewer is {} with {}: {}",
        chosen.model.model,
        chosen.model.provider,
        chosen.reason(config)
    );
    let writer = &config.providers[&settings.writer.provider];
    let agent = writer.agent.clone().with_context(|| {
        format!(
            "{} has no way to run as an agent, which the writer needs; add [providers.{}.agent] to your config, or choose another writer",
            writer.display_name(&settings.writer.provider),
            settings.writer.provider
        )
    })?;
    let add_on = |role: &str| pack.prompt_add_ons.get(role).map(String::as_str);
    let writer_spec = writer.spec(
        Role::Discuss,
        &settings.writer.model,
        workshop_author::writer_system_prompt(add_on("author")),
    );
    // A family name, such as "sol", is the newest model in the family.
    let resolver = ProviderRunner::new(writer.clone(), work_dir.join("writer-cwd"))?;
    let writer_spec = resolver.resolved(&writer_spec).await;
    // Even with the writer's own provider, the reviewer is a call of its own, with no tools
    // and none of the writer's conversation.
    let reviewer = config
        .providers
        .get(&chosen.model.provider)
        .with_context(|| format!("there's no provider called {:?}", chosen.model.provider))?;
    let reviewer_spec = reviewer.spec(
        Role::Discuss,
        &chosen.model.model,
        workshop_author::reviewer_system_prompt(add_on("author")),
    );
    Ok(ProviderModels {
        agent,
        writer: writer_spec,
        reviewer: ProviderRunner::new(reviewer.clone(), work_dir.join("reviewer-cwd"))?,
        reviewer_spec,
        prompt_dir: work_dir.join("prompts"),
        timeout: Duration::from_secs(settings.timeout_minutes * 60),
    })
}

/// What the author is told to write about: the pack's weakest skills, those in its goals first,
/// the kinds of mistake made most, the skills whose problems were found too easy, how hard each
/// skill's problems should be, and the learner's answers to its questions.
fn brief(learning: &Learning, pack: &Pack, questions: &[Question], now: i64) -> Result<Brief> {
    let in_pack = |key: &str| {
        key.split_once('/')
            .is_some_and(|(p, _)| p == pack.manifest.id)
    };
    // The author runs without the learner's device, so its days are UTC's.
    let skills = learning.skill_mastery(Clock {
        now,
        utc_offset_minutes: 0,
    })?;
    let in_goals = |skill: &str| {
        pack.manifest
            .goals
            .iter()
            .any(|g| g.skills.iter().any(|s| s == skill))
    };
    let mut weakest: Vec<WeakSkill> = pack
        .manifest
        .skills
        .iter()
        .map(|skill| {
            let mastery = skills
                .iter()
                .find(|m| m.skill == skill.id)
                .cloned()
                .unwrap_or_else(|| SkillMastery::none(&skill.id));
            WeakSkill {
                skill: skill.id.clone(),
                coverage: mastery.coverage,
                recall: mastery.mastery,
            }
        })
        .collect();
    // As the Goals page does, by the lower of coverage and recall.
    let lower = |weak: &WeakSkill| weak.coverage.min(weak.recall);
    weakest.sort_by(|a, b| {
        in_goals(&b.skill)
            .cmp(&in_goals(&a.skill))
            .then(lower(a).total_cmp(&lower(b)))
    });
    weakest.truncate(5);
    let recent: Vec<_> = learning
        .store()
        .mistakes(now - MISTAKES_MS)?
        .into_iter()
        .filter(|m| in_pack(&m.mistake.item))
        .collect();
    let mistakes = crate::mistakes::common_error_types(&recent)
        .into_iter()
        .take(5)
        .map(|c| (c.error_type, c.count))
        .collect();
    let items = crate::mistakes::items_by_key(std::slice::from_ref(pack));
    let examples = recent
        .iter()
        .take(8)
        .map(|m| {
            let label = items
                .get(&m.mistake.item)
                .map_or_else(|| m.mistake.item.clone(), |item| item.label());
            format!("{label}: {}", m.mistake.detail)
        })
        .collect();
    let answers = questions
        .iter()
        .filter(|q| !q.told)
        .filter_map(|q| q.answer.clone().map(|a| (q.text.clone(), a)))
        .collect();
    let levels = workshop_learning::levels(&learning.store().all_attempts()?, |key| {
        items
            .get(key)
            .filter(|item| matches!(item.kind, Kind::Coding | Kind::Codebase))
            .map(|item| workshop_learning::level::Problem {
                skills: &item.skills,
                difficulty: item.difficulty,
            })
    });
    let retired: Vec<&Item> = learning
        .store()
        .retirements()?
        .into_iter()
        .filter(|(_, retirement)| retirement.is_retired())
        .filter_map(|(key, _)| items.get(&key).copied())
        .collect();
    let too_easy = found_too_easy(
        retired
            .iter()
            .copied()
            .filter(|item| matches!(item.kind, Kind::Coding | Kind::Codebase)),
        |skill, _| {
            levels
                .get(skill)
                .map_or(workshop_learning::level::MIDDLE, |l| l.level)
        },
    );
    // Items with a fixed answer have no level of their own, so their new ones are one above the
    // hardest retired.
    let fixed_too_easy = found_too_easy(
        retired
            .iter()
            .copied()
            .filter(|item| item.kind.has_fixed_answer()),
        |_, retired| {
            let hardest = retired
                .iter()
                .map(|(_, difficulty)| difficulty.unwrap_or(workshop_learning::level::MIDDLE))
                .max()
                .unwrap_or(workshop_learning::level::MIDDLE);
            (hardest + 1).min(*workshop_learning::level::LEVELS.end())
        },
    );
    let lesson_requests: Vec<LessonRequest> = learning
        .waiting_lesson_requests_in(std::slice::from_ref(pack))?
        .into_iter()
        .map(|req| LessonRequest {
            path: req.path,
            id: req.id,
            prompt: req.prompt,
            answer: req.answer,
            explanation: req.explanation,
            skills: req.skills,
        })
        .collect();
    let mut targeted_skills: Vec<String> = Vec::new();
    let mut seen_skills: BTreeSet<String> = BTreeSet::new();
    let mut push_skill = |skill: &str| {
        if pack.manifest.has_skill(skill) && seen_skills.insert(skill.to_owned()) {
            targeted_skills.push(skill.to_owned());
        }
    };
    for req in &lesson_requests {
        for skill in &req.skills {
            push_skill(skill);
        }
    }
    for weak in &weakest {
        push_skill(&weak.skill);
    }
    for skill in too_easy.iter().chain(fixed_too_easy.iter()) {
        push_skill(&skill.skill);
    }
    let skill_coverage = targeted_skills
        .into_iter()
        .map(|skill| {
            let lessons = pack
                .items
                .iter()
                .filter(|item| item.kind == Kind::Lesson && item.skills.contains(&skill))
                .count();
            let unlinked_items = pack
                .items
                .iter()
                .filter(|item| {
                    item.kind.is_short() && item.lesson.is_none() && item.skills.contains(&skill)
                })
                .count();
            let taught: BTreeSet<&str> = pack
                .items
                .iter()
                .filter_map(|item| match &item.content {
                    Content::Lesson(Lesson {
                        topic: Some(topic), ..
                    }) if topic.skill == skill => Some(topic.topic.as_str()),
                    _ => None,
                })
                .collect();
            let untaught_topics = pack
                .manifest
                .skill(&skill)
                .into_iter()
                .flat_map(|s| &s.topics)
                .filter(|topic| !taught.contains(topic.id.as_str()))
                .map(|topic| (topic.id.clone(), topic.name.clone()))
                .collect();
            SkillCoverage {
                skill,
                lessons,
                unlinked_items,
                untaught_topics,
            }
        })
        .collect();
    Ok(Brief {
        lesson_requests,
        skill_coverage,
        weakest,
        mistakes,
        examples,
        answers,
        too_easy,
        fixed_too_easy,
        levels: levels
            .into_iter()
            .filter(|(skill, _)| pack.manifest.has_skill(skill))
            .map(|(skill, level)| (skill, level.level))
            .collect(),
    })
}

/// The skills of the items retired, each with the items, its most retired first, and at most
/// five of each. `level` gives a skill's level from it and its items retired.
#[allow(clippy::type_complexity)]
fn found_too_easy<'a>(
    retired: impl Iterator<Item = &'a Item>,
    level: impl Fn(&str, &[(String, Option<u8>)]) -> u8,
) -> Vec<TooEasy> {
    // Each item's title and difficulty, by skill.
    let mut by_skill: Vec<(String, Vec<(String, Option<u8>)>)> = Vec::new();
    for item in retired {
        for skill in &item.skills {
            let entry = match by_skill.iter_mut().position(|(s, _)| s == skill) {
                Some(index) => &mut by_skill[index].1,
                None => {
                    by_skill.push((skill.clone(), Vec::new()));
                    &mut by_skill.last_mut().expect("just pushed").1
                }
            };
            entry.push((item.label(), item.difficulty));
        }
    }
    by_skill.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then(a.0.cmp(&b.0)));
    by_skill.truncate(5);
    by_skill
        .into_iter()
        .map(|(skill, mut retired)| {
            let level = level(&skill, &retired);
            retired.truncate(5);
            TooEasy {
                level,
                skill,
                retired,
            }
        })
        .collect()
}

/// Tells subscribed devices about a question, as a Web Push notification.
pub fn notification(question: &str) -> workshop_push::Message {
    workshop_push::Message {
        title: "A question from the author".to_owned(),
        body: question.to_owned(),
        url: "/pack".to_owned(),
    }
}

/// Runs the author on a pack of the learner's own: writes and reviews items, puts those
/// accepted in the pack and commits them, and keeps those waiting for approval. Questions for
/// the learner go out to `notifier` as they're asked.
pub async fn run(
    config: &Config,
    paths: &Paths,
    learning: &Learning,
    desk: &Desk,
    notifier: Arc<workshop_push::Notifier>,
    pack: Option<&str>,
) -> Result<LastRun> {
    let Some(_lock) = desk.try_lock()? else {
        bail!("the author is already running");
    };
    let started_at = now_ms();
    let outcome = run_locked(config, paths, learning, desk, notifier, pack, started_at).await;
    let last = match outcome {
        Ok((report, commit)) => LastRun {
            started_at,
            finished_at: now_ms(),
            report: Some(report),
            commit,
            error: None,
        },
        Err(err) => LastRun {
            started_at,
            finished_at: now_ms(),
            report: None,
            commit: None,
            error: Some(format!("{err:#}")),
        },
    };
    desk.write("last-run.json", &Some(last.clone()))?;
    Ok(last)
}

async fn run_locked(
    config: &Config,
    paths: &Paths,
    learning: &Learning,
    desk: &Desk,
    notifier: Arc<workshop_push::Notifier>,
    pack: Option<&str>,
    started_at: i64,
) -> Result<(Report, Option<String>)> {
    let dir = pack_dir(config, pack)?;
    let loaded = Pack::load(&dir)?;
    let work_dir = desk.dir.join("runs").join(started_at.to_string());
    if work_dir.exists() {
        std::fs::remove_dir_all(&work_dir)?;
    }
    std::fs::create_dir_all(&work_dir)?;
    let models = models(config, &loaded, &work_dir).await?;
    let questions = desk.questions()?;
    let brief = brief(learning, &loaded, &questions, started_at)?;
    let runtime = crate::coding::runtime(config, paths).await?;
    // The writer's programs never run outside a sandbox: without one, its coding and reading
    // items are left out, as they can't be checked.
    let checker = workshop_coding::Checker {
        runtime,
        unconfined: workshop_coding::Unconfined::Skip,
    };
    let sends = Mutex::new(Vec::new());
    let ask = |question: &str| {
        if let Err(err) = desk.ask(question, now_ms()) {
            tracing::warn!("keeping the author's question: {err:#}");
        }
        let notifier = notifier.clone();
        let message = notification(question);
        // Sent as it's asked, while the run carries on.
        sends
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(tokio::spawn(
                async move { notifier.send_to_all(&message).await },
            ));
    };
    let limits = Limits {
        max_items: config.author.max_items,
        fix_rounds: config.author.fix_rounds,
        discussion_rounds: config.author.discussion_rounds,
    };
    let result = workshop_author::run(
        &dir,
        &work_dir.join("copy"),
        &models,
        &checker,
        &brief,
        limits,
        &ask,
    )
    .await;
    let sends = std::mem::take(
        &mut *sends
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
    );
    for send in sends {
        let _ = send.await;
    }
    let mut report = result?;
    // The answers it was told are done with.
    let told: Vec<String> = questions
        .iter()
        .filter(|q| q.answer.is_some() && !q.told)
        .map(|q| q.id.clone())
        .collect();
    desk.change("questions.json", |questions: &mut Vec<Question>| {
        for question in questions.iter_mut().filter(|q| told.contains(&q.id)) {
            question.told = true;
        }
    })?;

    let (commit, clashing, unlinked) = land(&dir, &report.accepted, &report.linked).await?;
    for mut item in clashing {
        item.reason = Some("the pack has a file of the same name now".to_owned());
        report.accepted.retain(|a| a.path != item.path);
        report.queued.push(item);
    }
    if !unlinked.is_empty() {
        report.linked.retain(|l| !unlinked.contains(&l.path));
    }
    let pack_id = loaded.manifest.id.clone();
    desk.enqueue(
        report
            .queued
            .iter()
            .map(|item| Queued {
                id: format!("{started_at}-{}", item.id),
                pack: pack_id.clone(),
                at: started_at,
                item: item.clone(),
            })
            .collect(),
    )?;
    // What's worth keeping from the run is in the report and the queue.
    std::fs::remove_dir_all(&work_dir).ok();
    Ok((report, commit))
}

/// Puts accepted items and linked existing items in the pack, removing the drafts they were made
/// from, and commits them. Returns the commit, if there is one, items that would overwrite a file
/// the pack has now (which aren't put in), and any linked paths skipped because their lesson
/// clashed or the file is gone.
async fn land(
    dir: &Path,
    items: &[Written],
    linked: &[Linked],
) -> Result<(Option<String>, Vec<Written>, BTreeSet<String>)> {
    // If a lesson clashes, hold back its accompanying items and links too so nothing lands broken.
    let clashing_lessons: BTreeSet<&str> = items
        .iter()
        .filter(|item| {
            item.files.get(&item.path).is_some_and(|text| {
                workshop_author::staging::lesson_id_from_front_matter(&item.path, text.as_bytes())
                    .is_some()
            }) && item.files.keys().any(|path| dir.join(path).exists())
        })
        .map(|item| item.id.as_str())
        .collect();
    let mut landed = Vec::new();
    let mut clashing = Vec::new();
    let mut paths = Vec::new();
    for item in items {
        let belongs_to_clashing_lesson = item.files.get(&item.path).is_some_and(|text| {
            workshop_author::staging::lesson_ref_from_front_matter(text.as_bytes())
                .is_some_and(|id| clashing_lessons.contains(id.as_str()))
        });
        if belongs_to_clashing_lesson || item.files.keys().any(|path| dir.join(path).exists()) {
            clashing.push(item.clone());
            continue;
        }
        for (path, text) in &item.files {
            crate::pack_files::write(dir, path, text)?;
            paths.push(path.clone());
        }
        if let Some(draft) = &item.from_draft
            && dir.join(draft).is_file()
        {
            std::fs::remove_file(dir.join(draft))?;
            paths.push(draft.clone());
        }
        landed.push(item);
    }
    let mut landed_links = Vec::new();
    let mut skipped_links = BTreeSet::new();
    for link in linked {
        if clashing_lessons.contains(link.lesson.as_str()) || !dir.join(&link.path).is_file() {
            skipped_links.insert(link.path.clone());
            continue;
        }
        crate::pack_files::write(dir, &link.path, &link.content)?;
        paths.push(link.path.clone());
        landed_links.push(link);
    }
    if landed.is_empty() && landed_links.is_empty() {
        return Ok((None, clashing, skipped_links));
    }
    let commit =
        crate::pack_files::commit(dir, &paths, &commit_message(&landed, &landed_links)).await?;
    Ok((commit, clashing, skipped_links))
}

fn commit_message(items: &[&Written], linked: &[&Linked]) -> String {
    let title = match items {
        [one] => format!("Add an item from the author: {}", one.label),
        _ => format!("Add {} items from the author", items.len()),
    };
    let mut body = String::new();
    for item in items {
        body.push_str(&format!("\n- {}: {}", item.path, item.label));
    }
    if !linked.is_empty() {
        body.push_str("\n\nLinked to new lessons:");
        for link in linked {
            match link.segment {
                Some(seg) => body.push_str(&format!(
                    "\n- {}: {} (lesson {}, segment {seg})",
                    link.path, link.label, link.lesson
                )),
                None => body.push_str(&format!(
                    "\n- {}: {} (lesson {})",
                    link.path, link.label, link.lesson
                )),
            }
        }
    }
    format!(
        "{title}\n\nWritten by one model and reviewed blind by another, and each passes its check.\n{body}"
    )
}

/// Approves an item (or lesson bundle) waiting in the queue: puts it in the pack, if it still
/// passes its check, and commits it. Returns the commit, if the pack is a git repo.
pub async fn approve(
    config: &Config,
    paths: &Paths,
    desk: &Desk,
    id: &str,
) -> Result<Option<String>> {
    let queued = desk.take(id)?;
    let result = approve_queued(config, paths, &queued).await;
    if result.is_err() {
        // Still waiting, to try again or turn down.
        desk.enqueue(vec![queued])?;
    }
    result
}

/// Restores the pack working tree if approving a queued item fails before the commit lands.
struct ApproveRollback {
    written: Vec<PathBuf>,
    restored: Vec<(PathBuf, Vec<u8>)>,
    removed_drafts: Vec<(PathBuf, Vec<u8>)>,
    armed: bool,
}

impl ApproveRollback {
    fn new() -> Self {
        Self {
            written: Vec::new(),
            restored: Vec::new(),
            removed_drafts: Vec::new(),
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for ApproveRollback {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        for path in &self.written {
            if let Err(err) = std::fs::remove_file(path) {
                tracing::warn!("removing {} after approval failed: {err}", path.display());
            }
        }
        for (path, bytes) in &self.restored {
            if let Err(err) = workshop_common::files::write_atomic(path, bytes) {
                tracing::warn!(
                    "restoring {} after approval failed: {err:#}",
                    path.display()
                );
            }
        }
        for (path, bytes) in &self.removed_drafts {
            if let Err(err) = workshop_common::files::write_atomic(path, bytes) {
                tracing::warn!(
                    "restoring {} after approval failed: {err:#}",
                    path.display()
                );
            }
        }
    }
}

async fn approve_queued(config: &Config, paths: &Paths, queued: &Queued) -> Result<Option<String>> {
    let dir = crate::pack_files::pack_dir(&config.learning, &queued.pack)?;
    let item = &queued.item;
    let all_items: Vec<&Written> = std::iter::once(item).chain(item.items.iter()).collect();
    for entry in &all_items {
        if entry.files.keys().any(|path| dir.join(path).exists()) {
            bail!("the pack has a file where this item would go, so it wasn't added");
        }
    }
    let mut rollback = ApproveRollback::new();
    let mut all_written_files: BTreeSet<String> = BTreeSet::new();
    for entry in &all_items {
        for (path, text) in &entry.files {
            crate::pack_files::write(&dir, path, text)?;
            rollback.written.push(dir.join(path));
            all_written_files.insert(path.clone());
        }
    }
    let mut applied_links: Vec<&Linked> = Vec::new();
    for link in &item.linked {
        let target = dir.join(&link.path);
        if target.is_file() {
            let before =
                std::fs::read(&target).with_context(|| format!("reading {}", target.display()))?;
            crate::pack_files::write(&dir, &link.path, &link.content)?;
            rollback.restored.push((target, before));
            applied_links.push(link);
        }
    }
    let pack = Pack::load(&dir)?;
    // Only these items (and applied links): the rest of the pack is kept for cross-item checks,
    // without rebuilding its existing coding problems.
    let mut only: BTreeSet<&str> = all_items.iter().map(|i| i.path.as_str()).collect();
    for link in &applied_links {
        only.insert(link.path.as_str());
    }
    let runtime = crate::coding::runtime(config, paths).await?;
    let report = pack
        .check_only(
            &only,
            &workshop_coding::Checker {
                runtime,
                unconfined: workshop_coding::Unconfined::Skip,
            },
        )
        .await;
    let problem = report
        .problems
        .iter()
        .find(|p| {
            all_written_files.contains(&p.path) || applied_links.iter().any(|l| l.path == p.path)
        })
        .map(|p| p.message.clone())
        .or_else(|| {
            for check_path in &only {
                match report
                    .items
                    .iter()
                    .find(|c| c.path == *check_path)
                    .map(|c| &c.verdict)
                {
                    Some(workshop_pack::Verdict::Passed(_)) => {}
                    Some(workshop_pack::Verdict::Failed(why)) => return Some(why.clone()),
                    Some(workshop_pack::Verdict::Skipped(why)) => {
                        return Some(format!("it couldn't be checked here, as {why}"));
                    }
                    None => {
                        return Some(
                            report.problems.first().map_or_else(
                                || "it can't be read".to_owned(),
                                |p| p.message.clone(),
                            ),
                        );
                    }
                }
            }
            None
        });
    if let Some(problem) = problem {
        bail!("it doesn't pass its check now, so it wasn't added: {problem}");
    }
    let mut paths: Vec<String> = all_written_files.into_iter().collect();
    for link in &applied_links {
        paths.push(link.path.clone());
    }
    for entry in &all_items {
        if let Some(draft) = &entry.from_draft {
            let draft_path = dir.join(draft);
            if draft_path.is_file() {
                let bytes = std::fs::read(&draft_path)
                    .with_context(|| format!("reading {}", draft_path.display()))?;
                std::fs::remove_file(&draft_path)
                    .with_context(|| format!("removing {}", draft_path.display()))?;
                rollback.removed_drafts.push((draft_path, bytes));
                paths.push(draft.clone());
            }
        }
    }
    let mut message = format!(
        "Add an item from the author, approved: {}\n\nThe reviewer didn't agree with it; it was approved in the app.",
        item.label
    );
    if !item.items.is_empty() {
        message.push_str("\n\nWith items:");
        for child in &item.items {
            message.push_str(&format!("\n- {}: {}", child.path, child.label));
        }
    }
    if !applied_links.is_empty() {
        message.push_str("\n\nLinked to new lessons:");
        for link in &applied_links {
            message.push_str(&format!("\n- {}: {}", link.path, link.label));
        }
    }
    match crate::pack_files::commit(&dir, &paths, &message).await {
        Ok(hash) => {
            rollback.disarm();
            Ok(hash)
        }
        Err(err) => {
            // Unstage any paths that `git add` staged before `git commit` failed.
            let mut reset = vec!["reset", "--quiet", "HEAD", "--"];
            reset.extend(paths.iter().map(String::as_str));
            if let Err(reset_err) = crate::workspace::git(&dir, &reset).await {
                tracing::warn!(
                    "unstaging {} after approval commit failed: {reset_err:#}",
                    paths.join(", ")
                );
            }
            Err(err)
        }
    }
}

/// What a run did, for the command line.
pub fn summary(last: &LastRun) -> String {
    if let Some(error) = &last.error {
        return format!("The author couldn't finish: {error}");
    }
    let Some(report) = &last.report else {
        return "The author finished.".to_owned();
    };
    let mut out = String::new();
    let line = |out: &mut String, heading: &str, items: &[Written]| {
        if items.is_empty() {
            return;
        }
        out.push_str(&format!("{heading}:\n"));
        for item in items {
            match &item.reason {
                Some(reason) => {
                    out.push_str(&format!("  {} ({}): {reason}\n", item.path, item.label))
                }
                None => out.push_str(&format!("  {} ({})\n", item.path, item.label)),
            }
        }
    };
    line(&mut out, "Added", &report.accepted);
    if !report.linked.is_empty() {
        out.push_str("Linked:\n");
        for link in &report.linked {
            match link.segment {
                Some(seg) => out.push_str(&format!(
                    "  {} ({}) → {} (segment {seg})\n",
                    link.path, link.label, link.lesson
                )),
                None => out.push_str(&format!(
                    "  {} ({}) → {}\n",
                    link.path, link.label, link.lesson
                )),
            }
        }
    }
    line(
        &mut out,
        "Waiting for your approval in the app",
        &report.queued,
    );
    line(&mut out, "Left out", &report.dropped);
    if report.accepted.is_empty()
        && report.linked.is_empty()
        && report.queued.is_empty()
        && report.dropped.is_empty()
    {
        out.push_str("No items were written.\n");
    }
    if let Some(commit) = &last.commit {
        out.push_str(&format!(
            "Committed to your pack as {commit}; nothing was pushed.\n"
        ));
    }
    if !report.put_back.is_empty() {
        out.push_str(&format!(
            "The writer changed files it may not, which were put back: {}\n",
            report.put_back.join(", ")
        ));
    }
    for question in &report.questions {
        out.push_str(&format!("It asks: {question}\n"));
    }
    out
}

#[cfg(test)]
mod tests;
