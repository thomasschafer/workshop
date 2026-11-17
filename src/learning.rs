//! The tracks of short items from packs: review cards, mental maths, probability and code to
//! read, and any tracks a pack adds for them. What's due across every track, the Coding track's
//! problems included, is planned here together, so they share one day's limit of reviews.
//!
//! The app works on a deck: every short item, with its schedule, and questions already made
//! from each mental maths template. With that it can practise offline, scheduling what's
//! answered itself until it can sync. Syncing sends the attempts made since, and gets the deck
//! back as the server's log now has it.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use workshop_learning::{
    Attempt, Clock, Flag, FlagChange, ItemRef, ItemSchedule, Limits, Progress, Rating, Retirement,
    RetirementChange, SkillMastery, Store, TrackPlan,
};
use workshop_pack::number::Tolerance;
use workshop_pack::{Content, Item, Pack};
use workshop_tracks::{Priority, Step, Track, TrackIcon, TrackId};

use crate::config::LearningConfig;
use crate::tracks::Destination;

/// How many questions the deck has ready from each mental maths template, for practising
/// offline. Once they're used up, the app starts them again.
const INSTANCES: u64 = 12;

pub struct Learning {
    store: Store,
    config: LearningConfig,
}

/// Everything the app needs to practise short items, offline too.
#[derive(Debug, Serialize)]
pub struct Deck {
    pub limits: Limits,
    /// What's been done today and this week, as the server knows.
    pub progress: Progress,
    /// Where today and this week began for the learner, for the app to tell once they've passed.
    pub day_start: i64,
    pub week_start: i64,
    pub tracks: Vec<DeckTrack>,
    pub items: Vec<DeckItem>,
    pub schedules: BTreeMap<String, ItemSchedule>,
    pub flags: BTreeMap<String, Flag>,
    /// Where each item that's ever been retired stands, so the app leaves retired ones out.
    pub retirements: BTreeMap<String, Retirement>,
    pub skills: Vec<DeckSkill>,
    /// The skills recent mistakes point to, whose new items come first.
    pub focus: Vec<String>,
    /// What's wrong in the packs, which is left out.
    pub problems: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct DeckTrack {
    pub id: TrackId,
    pub name: String,
    pub icon: TrackIcon,
}

#[derive(Debug, Serialize)]
pub struct DeckSkill {
    pub id: String,
    pub name: String,
    #[serde(flatten)]
    pub mastery: SkillMastery,
}

#[derive(Debug, Serialize)]
pub struct DeckItem {
    /// `pack/item`.
    pub key: String,
    pub track: TrackId,
    pub label: String,
    pub skills: Vec<String>,
    /// In Markdown.
    pub prompt: String,
    pub source: Option<String>,
    pub minutes: u32,
    #[serde(flatten)]
    pub content: DeckContent,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum DeckContent {
    Card {
        answer: String,
        explanation: Option<String>,
    },
    MentalMaths {
        instances: Vec<workshop_pack::mental::Instance>,
        tolerance: Tolerance,
    },
    Probability {
        answer: f64,
        answer_text: String,
        tolerance: Tolerance,
        solution: String,
    },
    Reading {
        language: workshop_pack::Language,
        #[serde(flatten)]
        question: workshop_pack::Question,
        explanation: String,
    },
}

/// What a device sends when it syncs: what was done since it last did.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SyncRequest {
    #[serde(default)]
    pub attempts: Vec<Attempt>,
    #[serde(default)]
    pub flags: Vec<FlagChange>,
    /// Items with a fixed answer retired after a right answer, each with the id of the attempt
    /// that retired it, and items brought back.
    #[serde(default)]
    pub retirements: Vec<RetirementChange>,
}

/// The learning tracks for the home screen, and the week's practice so far.
pub struct Tracks {
    pub tracks: Vec<Track<Destination>>,
    pub week: Week,
    pub problems: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Week {
    pub minutes: u32,
    pub target: u32,
}

/// An item from a pack, with the key it's known by across packs.
struct Short<'a> {
    key: String,
    item: &'a Item,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

impl Learning {
    pub fn open(config: &LearningConfig, data_dir: &Path) -> Result<Self> {
        Ok(Self {
            store: Store::open(&data_dir.join("learning.sqlite"))?,
            config: config.clone(),
        })
    }

    /// The packs, as the config lists them. The first time they're read after the log is
    /// brought up to date, the problems last rated easy before retiring existed are retired.
    fn packs(&self) -> Result<Vec<Pack>> {
        let packs = crate::packs::load(&self.config)?;
        let items = crate::mistakes::items_by_key(&packs);
        let retired = self.store.retire_past_easy(|key| {
            items
                .get(key)
                .is_some_and(|item| item.kind.retires_when_easy())
        })?;
        if retired > 0 {
            tracing::info!("retired {retired} problems last rated easy");
        }
        Ok(packs)
    }

    fn limits(&self) -> Limits {
        Limits {
            daily_reviews: self.config.daily_reviews,
            daily_new: self.config.daily_new,
            weekly_minutes: self.config.weekly_minutes,
            retention: self.config.desired_retention,
        }
    }

    fn progress(&self, clock: Clock) -> Result<Progress> {
        let today = self.store.activity(clock.day_start())?;
        let week = self.store.activity(clock.week_start())?;
        Ok(Progress {
            reviews_today: today.reviews,
            new_today: today.new,
            minutes_this_week: (week.ms / 60_000) as u32,
        })
    }

    pub fn deck(&self, clock: Clock) -> Result<Deck> {
        let packs = self.packs()?;
        let shorts = shorts(&packs);
        let counts = self.store.attempt_counts()?;
        let schedules = self.store.schedules()?;
        let items = shorts
            .iter()
            .map(|short| deck_item(short, counts.get(&short.key).copied().unwrap_or(0)))
            .collect::<Result<Vec<_>>>()?;
        let refs = item_refs(&shorts);
        let retirements = self.store.retirements()?;
        let mastery = workshop_learning::mastery(
            &refs,
            &schedules,
            &retirements,
            self.store.scheduler(),
            clock.now,
        );
        let skills = mastery
            .into_iter()
            .map(|mastery| {
                let name = packs
                    .iter()
                    .flat_map(|pack| &pack.manifest.skills)
                    .find(|skill| skill.id == mastery.skill)
                    .map_or_else(|| mastery.skill.clone(), |skill| skill.name.clone());
                DeckSkill {
                    id: mastery.skill.clone(),
                    name,
                    mastery,
                }
            })
            .collect();
        let tracks = track_names(&packs, &shorts)
            .into_iter()
            .map(|(id, (name, icon))| DeckTrack { id, name, icon })
            .collect();
        let keys: std::collections::BTreeSet<&str> =
            shorts.iter().map(|s| s.key.as_str()).collect();
        Ok(Deck {
            limits: self.limits(),
            progress: self.progress(clock)?,
            day_start: clock.day_start(),
            week_start: clock.week_start(),
            tracks,
            items,
            schedules: schedules
                .into_iter()
                .filter(|(key, _)| keys.contains(key.as_str()))
                .collect(),
            flags: self.store.flags()?,
            retirements: retirements
                .into_iter()
                .filter(|(key, _)| keys.contains(key.as_str()))
                .collect(),
            skills,
            focus: self.focus(&packs, clock.now)?,
            problems: problems(&packs),
        })
    }

    /// Records what a device did, then gives it the deck as it now is. Sending the same
    /// attempts and changes again changes nothing.
    pub fn sync(&self, request: &SyncRequest, clock: Clock) -> Result<Deck> {
        let retirements = self.retirements_to_record(&request.attempts, &request.retirements)?;
        self.record_with(&request.attempts, &retirements, clock.now)?;
        self.store.record_flags(&request.flags)?;
        self.deck(clock)
    }

    /// The retirement changes a device sent that change where an item stands, in the order
    /// they were made. Another device may have retired an item or brought it back first, so a
    /// change to where it already stands is left out, rather than refused, which would keep
    /// everything else the device sent from being recorded. Only an item with a fixed answer
    /// can be retired this way, by the attempt answering it right that has the change's id;
    /// anything else is refused.
    fn retirements_to_record(
        &self,
        attempts: &[Attempt],
        changes: &[RetirementChange],
    ) -> Result<Vec<RetirementChange>> {
        if changes.is_empty() {
            return Ok(Vec::new());
        }
        let packs = self.packs()?;
        let items = crate::mistakes::items_by_key(&packs);
        let logged = self.store.retirement_changes()?;
        let mut standings = workshop_learning::standings(&logged, i64::MAX);
        let mut ordered: Vec<&RetirementChange> = changes.iter().collect();
        ordered.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.id.cmp(&b.id)));
        let mut kept = Vec::new();
        for change in ordered {
            // The same change sent again, after a reply was lost. One with the same id but
            // different details is kept, for the log to refuse.
            if logged.contains(change) {
                continue;
            }
            if change.retired {
                if let Some(item) = items.get(&change.item)
                    && !item.kind.has_fixed_answer()
                {
                    bail!(
                        "{} can't be retired from practice, as it has no fixed answer",
                        change.item
                    );
                }
                let by_easy_attempt = attempts
                    .iter()
                    .chain(self.store.attempts(&change.item)?.iter())
                    .any(|a| {
                        a.id == change.id && a.item == change.item && a.rating == Rating::Easy
                    });
                if !by_easy_attempt {
                    bail!(
                        "retiring {} needs the attempt it was retired by, rated easy, with the id {}",
                        change.item,
                        change.id
                    );
                }
            }
            let retired = standings.get(&change.item).is_some_and(|r| r.is_retired());
            if retired == change.retired {
                tracing::info!(
                    "left out a change to {}, which is already {}",
                    change.item,
                    if retired { "retired" } else { "not retired" }
                );
                continue;
            }
            standings.insert(
                change.item.clone(),
                if change.retired {
                    Retirement::Retired { at: change.at }
                } else {
                    Retirement::BroughtBack { at: change.at }
                },
            );
            kept.push(change.clone());
        }
        Ok(kept)
    }

    /// Records attempts, and logs the mistakes the wrong ones show.
    pub fn record(&self, attempts: &[Attempt], now: i64) -> Result<()> {
        self.record_with(attempts, &[], now)
    }

    /// Records attempts with retirement changes, all or none of them, and logs the mistakes
    /// the wrong attempts show.
    fn record_with(
        &self,
        attempts: &[Attempt],
        retirements: &[RetirementChange],
        now: i64,
    ) -> Result<()> {
        self.store.record_changes(attempts, retirements, now)?;
        if !attempts
            .iter()
            .any(|a| a.rating == workshop_learning::Rating::Again)
        {
            return Ok(());
        }
        let packs = self.packs()?;
        let items = crate::mistakes::items_by_key(&packs);
        let mistakes: Vec<_> = attempts
            .iter()
            .filter_map(|attempt| {
                let item = items.get(&attempt.item)?;
                crate::mistakes::from_attempt(item, attempt)
            })
            .collect();
        self.store.record_mistakes(&mistakes)
    }

    /// Records an attempt the grader marked, with the mistakes it found. The mistake a wrong
    /// attempt shows of itself, such as a card forgotten, is only logged when the grader found
    /// none, so the log doesn't have the same mistake twice.
    pub fn record_marked(
        &self,
        attempt: Attempt,
        findings: &[workshop_learning::NewMistake],
        now: i64,
    ) -> Result<()> {
        self.store.record_mistakes(findings)?;
        if findings.is_empty() {
            self.record(&[attempt], now)
        } else {
            self.store.record(&[attempt], now)
        }
    }

    /// Records how a coding problem went, from the attempt finishing it. Rated easy, it's
    /// retired, and a retired problem done again by choice and rated otherwise is brought back,
    /// by a change with the attempt's id, so sending it again changes nothing. Returns whether
    /// it's retired now.
    pub fn record_problem(
        &self,
        attempt: Attempt,
        findings: &[workshop_learning::NewMistake],
        now: i64,
    ) -> Result<bool> {
        let packs = self.packs()?;
        let items = crate::mistakes::items_by_key(&packs);
        let item = items
            .get(&attempt.item)
            .with_context(|| format!("there's no item {}", attempt.item))?;
        let retired = self
            .store
            .retirements()?
            .get(&attempt.item)
            .is_some_and(|r| r.is_retired());
        let easy = attempt.rating == Rating::Easy;
        let retirement =
            (item.kind.retires_when_easy() && easy != retired).then(|| RetirementChange {
                id: attempt.id.clone(),
                item: attempt.item.clone(),
                at: attempt.answered_at,
                retired: easy,
            });
        // A forgotten attempt's own mistake, unless the grader found what went wrong.
        let own = findings
            .is_empty()
            .then(|| crate::mistakes::from_attempt(item, &attempt))
            .flatten();
        self.store
            .record_changes(std::slice::from_ref(&attempt), retirement.as_slice(), now)?;
        self.store.record_mistakes(findings)?;
        self.store.record_mistakes(own.as_slice())?;
        Ok(self
            .store
            .retirements()?
            .get(&attempt.item)
            .is_some_and(|r| r.is_retired()))
    }

    /// Brings a retired item back, due from now. `id` is the change's, made by the app, so
    /// bringing it back twice is one change. Fails for an item that isn't retired.
    pub fn bring_back(&self, item: &str, id: &str, now: i64) -> Result<()> {
        let already = self
            .store
            .retirement_changes()?
            .into_iter()
            .any(|change| change.id == id && change.item == item && !change.retired);
        if already {
            return Ok(());
        }
        if !self
            .store
            .retirements()?
            .get(item)
            .is_some_and(|r| r.is_retired())
        {
            bail!("{item} isn't retired");
        }
        self.store.record_retirements(&[RetirementChange {
            id: id.to_owned(),
            item: item.to_owned(),
            at: now,
            retired: false,
        }])
    }

    /// How well each skill is known now, over the items there's practice of.
    pub fn skill_mastery(&self, now: i64) -> Result<Vec<SkillMastery>> {
        let packs = self.packs()?;
        let items = practised(&packs);
        Ok(workshop_learning::mastery(
            &item_refs(&items),
            &self.store.schedules()?,
            &self.store.retirements()?,
            self.store.scheduler(),
            now,
        ))
    }

    /// How each of the packs' goals is going.
    pub fn goals(&self, now: i64) -> Result<Vec<crate::goals::GoalProgress>> {
        let packs = self.packs()?;
        let items = practised(&packs);
        let recent = self.store.mistakes(now - crate::mistakes::RECENT_MS)?;
        Ok(crate::goals::progress(
            &packs,
            &item_refs(&items),
            &self.store.all_attempts()?,
            &self.store.retirement_changes()?,
            &recent,
            self.store.scheduler(),
            now,
        ))
    }

    /// The skills recent mistakes point to.
    fn focus(&self, packs: &[Pack], now: i64) -> Result<Vec<String>> {
        let recent = self.store.mistakes(now - crate::mistakes::RECENT_MS)?;
        Ok(crate::mistakes::focus_skills(packs, &recent))
    }

    /// What's due and new in every track, as one plan, with the packs it was made from.
    pub fn planned(&self, clock: Clock) -> Result<Planned> {
        let packs = self.packs()?;
        let items = practised(&packs);
        let refs = item_refs(&items);
        let progress = self.progress(clock)?;
        let limits = self.limits();
        let focus = self.focus(&packs, clock.now)?;
        let retirements = self.store.retirements()?;
        let plans = workshop_learning::plan(
            &refs,
            &self.store.schedules()?,
            &self.store.flags()?,
            &retirements,
            progress,
            limits,
            &focus,
            self.store.scheduler(),
            clock.now,
        );
        let names = track_names(&packs, &items);
        let skill_names = packs
            .iter()
            .flat_map(|pack| &pack.manifest.skills)
            .map(|skill| (skill.id.clone(), skill.name.clone()))
            .collect();
        Ok(Planned {
            focus,
            skill_names,
            week: Week {
                minutes: progress.minutes_this_week,
                target: limits.weekly_minutes,
            },
            problems: problems(&packs),
            plans,
            retirements,
            names,
            packs,
        })
    }

    /// The tracks of short items, from a plan, and of design prompts, with the design sessions
    /// in progress. The Coding track, whose problems are worked on over several steps, is the
    /// coding module's.
    pub fn tracks(
        &self,
        planned: &Planned,
        clock: Clock,
        designs: &BTreeMap<String, workshop_sessions::design::Session>,
    ) -> Tracks {
        let tracks = planned
            .names
            .iter()
            .filter(|(id, _)| **id != TrackId::Coding)
            .map(|(id, (name, icon))| {
                let plan = &planned.plans[id];
                if *id == TrackId::SystemDesign {
                    return design_track(plan, planned, designs);
                }
                Track {
                    summary: summary(plan, clock),
                    destination: Destination::Practice { track: id.clone() },
                    next: next_step(id, plan, planned),
                    long: None,
                    id: id.clone(),
                    name: name.clone(),
                    icon: *icon,
                }
            })
            .collect();
        Tracks {
            tracks,
            week: planned.week,
            problems: planned.problems.clone(),
        }
    }

    pub fn store(&self) -> &Store {
        &self.store
    }
}

/// Every track's items, by what's to be done with them, and the packs they're from.
pub struct Planned {
    pub packs: Vec<Pack>,
    /// The skills recent mistakes point to, most first.
    pub focus: Vec<String>,
    /// Every skill's name, by id.
    pub skill_names: BTreeMap<String, String>,
    pub plans: BTreeMap<TrackId, TrackPlan>,
    /// Where each item that's ever been retired stands.
    pub retirements: BTreeMap<String, Retirement>,
    /// Each track with items in it, and its name and icon.
    pub names: BTreeMap<TrackId, (String, TrackIcon)>,
    pub week: Week,
    pub problems: Vec<String>,
}

fn shorts(packs: &[Pack]) -> Vec<Short<'_>> {
    items_where(packs, |item| item.kind.is_short())
}

/// The items there's practice of: the short ones, coding problems and design prompts.
fn practised(packs: &[Pack]) -> Vec<Short<'_>> {
    items_where(packs, |item| {
        item.kind.is_short()
            || matches!(
                item.kind,
                workshop_pack::Kind::Coding | workshop_pack::Kind::Design
            )
    })
}

fn items_where(packs: &[Pack], keep: impl Fn(&Item) -> bool) -> Vec<Short<'_>> {
    packs
        .iter()
        .flat_map(|pack| {
            pack.items
                .iter()
                .filter(|item| keep(item))
                .map(|item| Short {
                    key: format!("{}/{}", pack.manifest.id, item.id),
                    item,
                })
        })
        .collect()
}

fn item_refs<'a>(shorts: &'a [Short<'a>]) -> Vec<ItemRef<'a>> {
    shorts
        .iter()
        .map(|short| ItemRef {
            key: &short.key,
            track: &short.item.track,
            skills: &short.item.skills,
        })
        .collect()
}

/// The tracks with these items in them, in the order the home screen shows them, and their
/// names and icons. Two packs' tracks with the same id are one track.
fn track_names(packs: &[Pack], shorts: &[Short<'_>]) -> BTreeMap<TrackId, (String, TrackIcon)> {
    shorts
        .iter()
        .map(|short| {
            let id = short.item.track.clone();
            let label = match &id {
                TrackId::Pack(pack_track) => packs
                    .iter()
                    .flat_map(|pack| &pack.manifest.tracks)
                    .find(|track| track.id == *pack_track)
                    .map(|track| (track.name.clone(), track.icon))
                    .expect("an item's pack track is checked to be in its pack"),
                built_in => (
                    built_in
                        .built_in_name()
                        .expect("every other track is built in")
                        .to_owned(),
                    built_in
                        .built_in_icon()
                        .expect("every built-in track has an icon"),
                ),
            };
            (id, label)
        })
        .collect()
}

fn problems(packs: &[Pack]) -> Vec<String> {
    packs
        .iter()
        .flat_map(|pack| {
            pack.problems
                .iter()
                .map(move |problem| format!("{}: {problem}", pack.manifest.name))
        })
        .collect()
}

fn deck_item(short: &Short<'_>, attempts: u64) -> Result<DeckItem> {
    let item = short.item;
    let content = match &item.content {
        Content::Card {
            answer,
            explanation,
        } => DeckContent::Card {
            answer: answer.clone(),
            explanation: explanation.clone(),
        },
        Content::MentalMaths(template) => {
            let generator = workshop_pack::mental::Generator::new(template, &item.prompt)
                .map_err(anyhow::Error::msg)
                .with_context(|| format!("in {}", item.path))?;
            // Each attempt moves on, so questions don't repeat in the same order.
            let base = seed_base(&short.key).wrapping_add(attempts);
            let instances = (0..INSTANCES)
                .map(|i| generator.instance(base.wrapping_add(i)))
                .collect::<Result<_, _>>()
                .map_err(anyhow::Error::msg)
                .with_context(|| format!("in {}", item.path))?;
            DeckContent::MentalMaths {
                instances,
                tolerance: template.tolerance,
            }
        }
        Content::Probability(probability) => DeckContent::Probability {
            answer: probability.answer,
            answer_text: probability.answer_text.clone(),
            tolerance: probability.tolerance,
            solution: probability.solution.clone(),
        },
        Content::Reading(reading) => DeckContent::Reading {
            language: reading.language,
            question: reading.question.clone(),
            explanation: reading.explanation.clone(),
        },
        Content::Coding(_) | Content::Design { .. } => {
            unreachable!("only short items are in the deck")
        }
    };
    Ok(DeckItem {
        key: short.key.clone(),
        track: item.track.clone(),
        label: item.label(),
        skills: item.skills.clone(),
        prompt: item.prompt.clone(),
        source: item.source.clone(),
        minutes: item.minutes,
        content,
    })
}

/// Where a template's seeds start, different for each item so they don't all make their
/// questions from the same draws.
fn seed_base(key: &str) -> u64 {
    // FNV-1a, whose value never changes between versions.
    key.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
    }) >> 16
}

/// The System design track. Its prompts are worked through in design sessions, which take a
/// while, so Continue only suggests one when the learner has a while: the session worked on
/// most recently, then one that's due, then something new.
fn design_track(
    plan: &TrackPlan,
    planned: &Planned,
    designs: &BTreeMap<String, workshop_sessions::design::Session>,
) -> Track<Destination> {
    let destination = Destination::Design { item: None };
    let unfinished = designs
        .iter()
        .filter(|(key, _)| planned.item(key).is_some())
        .max_by_key(|(_, session)| session.updated_at)
        .map(|(key, session)| {
            let reason = format!(
                "Where you left off: {}",
                session.stage.name().to_lowercase()
            );
            (key, Priority::Unfinished, reason)
        });
    let long = unfinished
        .or_else(|| {
            plan.due.first().map(|key| {
                let reason = "Due for review".to_owned();
                (key, Priority::Due, reason)
            })
        })
        .or_else(|| {
            plan.new.first().map(|key| {
                let reason = "Something new".to_owned();
                (key, Priority::New, reason)
            })
        })
        .map(|(key, priority, reason)| Step {
            title: planned.item(key).map_or_else(|| key.clone(), Item::label),
            reason,
            priority,
            destination: Destination::Design {
                item: Some(key.clone()),
            },
        });
    let in_progress = designs
        .keys()
        .filter(|key| planned.item(key).is_some())
        .count();
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
    Track::built_in(TrackId::SystemDesign, parts.join(" · "), destination, None).with_long(long)
}

/// What a track's items are called, one and many.
fn noun(track: &TrackId) -> (&'static str, &'static str) {
    match track {
        TrackId::Review => ("card", "cards"),
        TrackId::MentalMaths => ("sum", "sums"),
        TrackId::Probability => ("question", "questions"),
        _ => ("item", "items"),
    }
}

/// So many of a track's items, such as "3 new cards", with any word before the noun.
fn count(n: usize, before: &str, track: &TrackId) -> String {
    let (one, many) = noun(track);
    format!("{n} {before}{}", if n == 1 { one } else { many })
}

impl Planned {
    /// The skill to focus on that an item has, if it has one, by name.
    pub fn focus_of(&self, item: &Item) -> Option<&str> {
        self.focus
            .iter()
            .find(|skill| item.skills.contains(skill))
            .map(|skill| {
                self.skill_names
                    .get(skill)
                    .map_or(skill.as_str(), String::as_str)
            })
    }

    /// Whether an item is retired, so it's never offered.
    pub fn is_retired(&self, key: &str) -> bool {
        self.retirements.get(key).is_some_and(|r| r.is_retired())
    }

    pub fn item(&self, key: &str) -> Option<&Item> {
        let (pack, item) = key.split_once('/')?;
        self.packs
            .iter()
            .find(|p| p.manifest.id == pack)
            .and_then(|p| p.item(item))
    }
}

/// The step a track suggests, given its plan: due reviews, then something new, sooner if it's
/// in a skill recent mistakes point to.
fn next_step(id: &TrackId, plan: &TrackPlan, planned: &Planned) -> Option<Step<Destination>> {
    let week = planned.week;
    let destination = Destination::Practice { track: id.clone() };
    if !plan.due.is_empty() {
        return Some(Step {
            title: format!("{} due", count(plan.due.len(), "", id)),
            reason: "Due today".to_owned(),
            priority: Priority::Due,
            destination,
        });
    }
    if let Some(first) = plan.new.first() {
        if let Some(skill) = planned.item(first).and_then(|item| planned.focus_of(item)) {
            return Some(Step {
                title: count(plan.new.len(), "new ", id),
                reason: format!("Practise {skill}, after recent mistakes"),
                priority: Priority::Focus,
                destination,
            });
        }
        // Once the week's target is met, new items wait behind anything else to do.
        let priority = if week.minutes >= week.target {
            Priority::Browse
        } else {
            Priority::New
        };
        return Some(Step {
            title: count(plan.new.len(), "new ", id),
            reason: "Something new".to_owned(),
            priority,
            destination,
        });
    }
    None
}

fn summary(plan: &TrackPlan, clock: Clock) -> String {
    let mut parts = Vec::new();
    if !plan.due.is_empty() {
        parts.push(format!("{} due", plan.due.len()));
    }
    if plan.new_count() > 0 {
        parts.push(format!("{} new", plan.new_count()));
    }
    if parts.is_empty() {
        if plan.waiting > 0 {
            parts.push(format!(
                "Today's reviews are done; {} more tomorrow",
                plan.waiting
            ));
        } else {
            let tomorrow = clock.day_start() + workshop_learning::schedule::DAY_MS;
            parts.push(match plan.next_due {
                Some(next) if next < tomorrow => "More later today".to_owned(),
                Some(_) => "Nothing due today".to_owned(),
                None => "Nothing to do".to_owned(),
            });
        }
    } else if plan.waiting > 0 {
        parts.push(format!("{} for tomorrow", plan.waiting));
    }
    if plan.flagged > 0 {
        parts.push(format!("{} flagged", plan.flagged));
    }
    parts.join(" · ")
}

#[cfg(test)]
mod tests {
    use workshop_learning::Rating;

    use super::*;

    const NOW: i64 = 1_790_000_000_000;

    fn learning(dir: &Path) -> Learning {
        let config = LearningConfig {
            packs: Vec::new(),
            sample_pack: false,
            daily_reviews: 3,
            daily_new: 10,
            weekly_minutes: 1,
            desired_retention: 0.9,
        };
        Learning::open(&config, dir).unwrap()
    }

    fn clock(now: i64) -> Clock {
        Clock {
            now,
            utc_offset_minutes: 0,
        }
    }

    fn tracks_at(learning: &Learning, clock: Clock) -> Tracks {
        let planned = learning.planned(clock).unwrap();
        learning.tracks(&planned, clock, &BTreeMap::new())
    }

    fn attempt(id: &str, item: &str, at: i64, rating: Rating) -> Attempt {
        Attempt {
            id: format!("attempt-{id}"),
            item: item.to_owned(),
            answered_at: at,
            duration_ms: 40_000,
            rating,
            response: None,
            seed: None,
        }
    }

    #[test]
    fn deals_every_short_item_of_the_sample_pack() {
        let dir = tempfile::tempdir().unwrap();
        let deck = learning(dir.path()).deck(clock(NOW)).unwrap();
        // Coding problems aren't short, so aren't in it; code to read is.
        assert_eq!(deck.items.len(), 51);
        assert!(deck.problems.is_empty());
        let names: Vec<&str> = deck.tracks.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "Coding",
                "Probability",
                "Mental maths",
                "Review",
                "Estimation"
            ]
        );
        let sums = deck
            .items
            .iter()
            .find_map(|item| match &item.content {
                DeckContent::MentalMaths { instances, .. } => Some(instances),
                _ => None,
            })
            .unwrap();
        assert_eq!(sums.len(), INSTANCES as usize);
        assert!(deck.skills.iter().all(|skill| skill.mastery.mastery == 0.0));
        let json = serde_json::to_value(&deck).unwrap();
        let card = json["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["kind"] == "card")
            .unwrap();
        assert!(card["key"].as_str().unwrap().starts_with("sample/"));
        assert!(card["answer"].is_string());
        let reading = json["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["key"] == "sample/negative-division")
            .unwrap();
        assert_eq!(reading["kind"], "reading");
        assert_eq!(reading["track"], "coding");
        assert_eq!(reading["ask"], "prints");
        assert_eq!(reading["output"], "-3 -1");
        assert_eq!(reading["language"], "cpp");
        let languages: std::collections::BTreeSet<&str> = json["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["kind"] == "reading")
            .map(|item| item["language"].as_str().unwrap())
            .collect();
        assert_eq!(languages, ["cpp", "haskell", "python", "rust"].into());
    }

    #[test]
    fn moves_on_to_new_questions_as_templates_are_attempted() {
        let dir = tempfile::tempdir().unwrap();
        let learning = learning(dir.path());
        let instances = |deck: &Deck| {
            deck.items
                .iter()
                .find(|item| item.key == "sample/times-eleven")
                .and_then(|item| match &item.content {
                    DeckContent::MentalMaths { instances, .. } => Some(instances.clone()),
                    _ => None,
                })
                .unwrap()
        };
        let before = instances(&learning.deck(clock(NOW)).unwrap());
        let request = SyncRequest {
            attempts: vec![attempt("1", "sample/times-eleven", NOW, Rating::Good)],
            flags: Vec::new(),
            ..Default::default()
        };
        let after = instances(&learning.sync(&request, clock(NOW)).unwrap());
        assert_eq!(after[0], before[1]);
    }

    #[test]
    fn offers_new_items_then_due_reviews_first() {
        let dir = tempfile::tempdir().unwrap();
        let learning = learning(dir.path());
        let tracks = tracks_at(&learning, clock(NOW));
        let review = tracks
            .tracks
            .iter()
            .find(|track| track.id == TrackId::Review)
            .unwrap();
        let next = review.next.as_ref().unwrap();
        assert_eq!(next.priority, Priority::New);
        assert_eq!(next.title, "10 new cards");
        assert_eq!(review.summary, "10 new");
        assert_eq!(
            tracks.week,
            Week {
                minutes: 0,
                target: 1
            }
        );

        // Two days later, the card answered today is due again.
        let request = SyncRequest {
            attempts: vec![attempt("1", "sample/stable-sorting", NOW, Rating::Again)],
            flags: Vec::new(),
            ..Default::default()
        };
        learning.sync(&request, clock(NOW)).unwrap();
        let later = tracks_at(&learning, clock(NOW + 2 * 86_400_000));
        let review = later
            .tracks
            .iter()
            .find(|track| track.id == TrackId::Review)
            .unwrap();
        let next = review.next.as_ref().unwrap();
        assert_eq!(next.priority, Priority::Due);
        assert_eq!(next.title, "1 card due");
        assert_eq!(review.summary, "1 due · 9 new");
        assert_eq!(
            review.destination,
            Destination::Practice {
                track: TrackId::Review
            }
        );
        // Forty seconds of practice is less than a minute.
        assert_eq!(later.week.minutes, 0);
    }

    #[test]
    fn leaves_flagged_cards_out_until_the_flag_is_cleared() {
        let dir = tempfile::tempdir().unwrap();
        let learning = learning(dir.path());
        let flag = |id: &str, flagged: bool, at: i64| FlagChange {
            id: format!("flag-change-{id}"),
            item: "sample/stable-sorting".to_owned(),
            at,
            flagged,
            note: Some("The example is muddled".to_owned()),
        };
        let deck = learning
            .sync(
                &SyncRequest {
                    attempts: Vec::new(),
                    flags: vec![flag("1", true, NOW)],
                    ..Default::default()
                },
                clock(NOW),
            )
            .unwrap();
        assert!(deck.flags.contains_key("sample/stable-sorting"));
        let tracks = tracks_at(&learning, clock(NOW));
        let review = tracks
            .tracks
            .iter()
            .find(|track| track.id == TrackId::Review)
            .unwrap();
        assert_eq!(review.summary, "9 new · 1 flagged");
        let deck = learning
            .sync(
                &SyncRequest {
                    attempts: Vec::new(),
                    flags: vec![flag("2", false, NOW + 1)],
                    ..Default::default()
                },
                clock(NOW),
            )
            .unwrap();
        assert!(deck.flags.is_empty());
    }

    #[test]
    fn leans_towards_the_skills_of_recent_mistakes() {
        let dir = tempfile::tempdir().unwrap();
        let learning = learning(dir.path());
        let mut wrong = attempt("1", "sample/both-heads", NOW, Rating::Again);
        wrong.response = Some("1/4".to_owned());
        learning
            .sync(
                &SyncRequest {
                    attempts: vec![wrong],
                    flags: Vec::new(),
                    ..Default::default()
                },
                clock(NOW),
            )
            .unwrap();
        let mistakes = learning.store().mistakes(0).unwrap();
        assert_eq!(mistakes.len(), 1);
        assert!(mistakes[0].mistake.detail.starts_with("Answered 1/4"));

        let planned = learning.planned(clock(NOW + 1)).unwrap();
        assert_eq!(planned.focus, ["probability.conditional"]);
        let probability = &planned.plans[&TrackId::Probability];
        let first = planned.item(&probability.new[0]).unwrap();
        assert!(first.skills.contains(&"probability.conditional".to_owned()));
        let tracks = learning.tracks(&planned, clock(NOW + 1), &BTreeMap::new());
        let next = tracks
            .tracks
            .iter()
            .find(|track| track.id == TrackId::Probability)
            .and_then(|track| track.next.clone())
            .unwrap();
        assert_eq!(next.priority, Priority::Focus);
        assert!(
            next.reason
                .starts_with("Practise Conditional probability, after recent mistakes"),
            "{}",
            next.reason
        );
        let deck = learning.deck(clock(NOW + 1)).unwrap();
        assert_eq!(deck.focus, ["probability.conditional"]);
    }

    #[test]
    fn logs_a_marked_attempt_as_forgotten_only_without_the_graders_findings() {
        let dir = tempfile::tempdir().unwrap();
        let learning = learning(dir.path());
        let finding = workshop_learning::NewMistake {
            id: "grade-1-0".to_owned(),
            item: "sample/binary-heap-costs".to_owned(),
            at: NOW,
            source: workshop_learning::MistakeSource::Grader,
            attempt: None,
            detail: "Says removing the smallest is constant".to_owned(),
            suggested: Some("concept-gap".to_owned()),
        };
        let wrong = attempt("1", "sample/binary-heap-costs", NOW, Rating::Again);
        learning.record_marked(wrong, &[finding], NOW).unwrap();
        let mistakes = learning.store().mistakes(0).unwrap();
        let details: Vec<&str> = mistakes.iter().map(|m| m.mistake.detail.as_str()).collect();
        assert_eq!(details, ["Says removing the smallest is constant"]);
        assert_eq!(
            learning
                .store()
                .attempts("sample/binary-heap-costs")
                .unwrap()
                .len(),
            1
        );

        // With nothing found, the attempt's own mistake is all there is to log.
        let wrong = attempt("2", "sample/binary-heap-costs", NOW + 1, Rating::Again);
        learning.record_marked(wrong, &[], NOW + 1).unwrap();
        let mistakes = learning.store().mistakes(0).unwrap();
        let mut details: Vec<&str> = mistakes.iter().map(|m| m.mistake.detail.as_str()).collect();
        details.sort_unstable();
        assert_eq!(
            details,
            ["Forgot it", "Says removing the smallest is constant"]
        );
    }

    #[test]
    fn retires_the_problems_an_older_log_last_rated_easy() {
        let dir = tempfile::tempdir().unwrap();
        {
            // A log as Workshop wrote it before problems were retired, at version 3.
            let connection =
                rusqlite::Connection::open(dir.path().join("learning.sqlite")).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE attempts (id TEXT PRIMARY KEY, item TEXT NOT NULL,
                         answered_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
                         rating INTEGER NOT NULL, response TEXT, seed INTEGER,
                         received_at INTEGER NOT NULL);
                     CREATE TABLE flag_changes (id TEXT PRIMARY KEY, item TEXT NOT NULL,
                         at INTEGER NOT NULL, flagged INTEGER NOT NULL, note TEXT);
                     CREATE TABLE schedules (item TEXT PRIMARY KEY, stability REAL NOT NULL,
                         difficulty REAL NOT NULL, stability_fast REAL NOT NULL,
                         last_review INTEGER NOT NULL, reviews INTEGER NOT NULL,
                         lapses INTEGER NOT NULL);
                     CREATE TABLE time_spent (id INTEGER PRIMARY KEY, item TEXT NOT NULL,
                         at INTEGER NOT NULL, ms INTEGER NOT NULL);
                     CREATE TABLE mistakes (id TEXT PRIMARY KEY, item TEXT NOT NULL,
                         at INTEGER NOT NULL, source TEXT NOT NULL, attempt TEXT,
                         detail TEXT NOT NULL, suggested TEXT, confirmed TEXT);
                     PRAGMA user_version = 3;",
                )
                .unwrap();
            let insert = |id: &str, item: &str, at: i64, rating: u32| {
                connection
                    .execute(
                        "INSERT INTO attempts VALUES (?, ?, ?, 600000, ?, NULL, NULL, ?)",
                        rusqlite::params![id, item, at, rating, at],
                    )
                    .unwrap();
            };
            // A problem rated easy, one rated easy and then hard, and a card rated easy.
            insert("attempt-1", "sample/islands", NOW - 3 * 86_400_000, 4);
            insert("attempt-2", "sample/pair-sums", NOW - 3 * 86_400_000, 4);
            insert("attempt-3", "sample/pair-sums", NOW - 86_400_000, 2);
            insert("attempt-4", "sample/stable-sorting", NOW - 86_400_000, 4);
        }
        let learning = learning(dir.path());
        let planned = learning.planned(clock(NOW)).unwrap();
        let retired: Vec<&String> = planned
            .retirements
            .iter()
            .filter(|(_, r)| r.is_retired())
            .map(|(key, _)| key)
            .collect();
        assert_eq!(retired, ["sample/islands"]);
        assert_eq!(planned.plans[&TrackId::Coding].retired, 1);
        // Every attempt is still there.
        assert_eq!(learning.store().all_attempts().unwrap().len(), 4);
    }

    #[test]
    fn retires_a_problem_rated_easy_but_not_a_card() {
        let dir = tempfile::tempdir().unwrap();
        let learning = learning(dir.path());
        let card = attempt("1", "sample/stable-sorting", NOW, Rating::Easy);
        assert!(!learning.record_problem(card, &[], NOW).unwrap());
        let problem = attempt("2", "sample/islands", NOW, Rating::Easy);
        assert!(learning.record_problem(problem, &[], NOW).unwrap());
        let hard = attempt("3", "sample/pair-sums", NOW, Rating::Hard);
        assert!(!learning.record_problem(hard, &[], NOW).unwrap());
        let retirements = learning.store().retirements().unwrap();
        assert_eq!(retirements.keys().collect::<Vec<_>>(), ["sample/islands"]);
        assert!(
            learning
                .bring_back("sample/pair-sums", "back-1234", NOW)
                .is_err()
        );
        learning
            .bring_back("sample/islands", "back-1234", NOW + 1)
            .unwrap();
        learning
            .bring_back("sample/islands", "back-1234", NOW + 2)
            .unwrap();
        assert!(!learning.store().retirements().unwrap()["sample/islands"].is_retired());
        let planned = learning.planned(clock(NOW + 3)).unwrap();
        assert!(
            planned.plans[&TrackId::Coding]
                .due
                .contains(&"sample/islands".to_owned())
        );
    }

    fn retire(attempt: &Attempt) -> RetirementChange {
        RetirementChange {
            id: attempt.id.clone(),
            item: attempt.item.clone(),
            at: attempt.answered_at,
            retired: true,
        }
    }

    #[test]
    fn retires_an_item_with_a_fixed_answer_from_a_sync_until_its_brought_back() {
        let dir = tempfile::tempdir().unwrap();
        let learning = learning(dir.path());
        let right = attempt("1", "sample/two-dice-seven", NOW, Rating::Easy);
        let request = SyncRequest {
            attempts: vec![right.clone()],
            retirements: vec![retire(&right)],
            ..Default::default()
        };
        let deck = learning.sync(&request, clock(NOW)).unwrap();
        assert_eq!(
            deck.retirements,
            BTreeMap::from([(
                "sample/two-dice-seven".to_owned(),
                Retirement::Retired { at: NOW }
            )])
        );
        // Sent again, as after a lost reply, it's the same attempt and retirement.
        learning.sync(&request, clock(NOW)).unwrap();
        assert_eq!(learning.store().retirement_changes().unwrap().len(), 1);
        assert_eq!(
            learning
                .store()
                .attempts("sample/two-dice-seven")
                .unwrap()
                .len(),
            1
        );
        // Never offered, however long it's been, and known for good.
        let planned = learning.planned(clock(NOW + 400 * 86_400_000)).unwrap();
        let plan = &planned.plans[&TrackId::Probability];
        assert_eq!(plan.retired, 1);
        assert!(!plan.due.contains(&"sample/two-dice-seven".to_owned()));
        assert!(!plan.is_new("sample/two-dice-seven"));

        // Brought back, from another sync, it's due from then.
        let back = RetirementChange {
            id: "back-1234".to_owned(),
            item: "sample/two-dice-seven".to_owned(),
            at: NOW + 5,
            retired: false,
        };
        let request = SyncRequest {
            retirements: vec![back.clone()],
            ..Default::default()
        };
        let deck = learning.sync(&request, clock(NOW + 6)).unwrap();
        assert_eq!(
            deck.retirements["sample/two-dice-seven"],
            Retirement::BroughtBack { at: NOW + 5 }
        );
        let planned = learning.planned(clock(NOW + 6)).unwrap();
        assert!(
            planned.plans[&TrackId::Probability]
                .due
                .contains(&"sample/two-dice-seven".to_owned())
        );
        // Brought back again by a device that hadn't heard, it's left as it is.
        let request = SyncRequest {
            retirements: vec![RetirementChange {
                id: "back-5678".to_owned(),
                at: NOW + 7,
                ..back
            }],
            ..Default::default()
        };
        learning.sync(&request, clock(NOW + 8)).unwrap();
        assert_eq!(learning.store().retirement_changes().unwrap().len(), 2);
    }

    #[test]
    fn retires_from_a_sync_only_items_with_a_fixed_answer_by_an_easy_attempt() {
        let dir = tempfile::tempdir().unwrap();
        let learning = learning(dir.path());
        let refused = |attempt: Attempt, change: RetirementChange| {
            let request = SyncRequest {
                attempts: vec![attempt],
                retirements: vec![change],
                ..Default::default()
            };
            learning.sync(&request, clock(NOW)).unwrap_err().to_string()
        };
        // A card, mental maths and a coding problem retire otherwise, or never.
        for item in [
            "sample/stable-sorting",
            "sample/times-eleven",
            "sample/islands",
        ] {
            let easy = attempt("1", item, NOW, Rating::Easy);
            let why = refused(easy.clone(), retire(&easy));
            assert!(why.contains("no fixed answer"), "{why}");
        }
        // Code to read retires only by an attempt rated easy, with the change's id.
        let good = attempt("2", "sample/negative-division", NOW, Rating::Good);
        let why = refused(good.clone(), retire(&good));
        assert!(why.contains("rated easy"), "{why}");
        let easy = attempt("3", "sample/negative-division", NOW, Rating::Easy);
        let other = RetirementChange {
            id: "attempt-other".to_owned(),
            ..retire(&easy)
        };
        let why = refused(easy, other);
        assert!(why.contains("rated easy"), "{why}");
        // Nothing in a refused sync is recorded.
        assert!(learning.store().retirement_changes().unwrap().is_empty());
        assert!(learning.store().all_attempts().unwrap().is_empty());

        // Rated easy without retiring, it's only sent further off than a right answer was.
        let easy = attempt("4", "sample/negative-division", NOW, Rating::Easy);
        let good = attempt("5", "sample/both-heads", NOW, Rating::Good);
        let request = SyncRequest {
            attempts: vec![easy, good],
            ..Default::default()
        };
        let deck = learning.sync(&request, clock(NOW)).unwrap();
        assert!(deck.retirements.is_empty());
        let due = |key: &str| learning.store().scheduler().due(&deck.schedules[key], 0.9);
        assert!(due("sample/negative-division") > due("sample/both-heads") + 7 * 86_400_000);
    }

    #[test]
    fn counts_the_weeks_minutes() {
        let dir = tempfile::tempdir().unwrap();
        let learning = learning(dir.path());
        let request = SyncRequest {
            attempts: (0..3)
                .map(|i| {
                    attempt(
                        &i.to_string(),
                        "sample/two-dice-seven",
                        NOW + i,
                        Rating::Good,
                    )
                })
                .collect(),
            flags: Vec::new(),
            ..Default::default()
        };
        learning.sync(&request, clock(NOW)).unwrap();
        let tracks = tracks_at(&learning, clock(NOW + 10));
        assert_eq!(
            tracks.week,
            Week {
                minutes: 2,
                target: 1
            }
        );
        let next = tracks.tracks[0].next.as_ref().unwrap();
        // The week's target is met, so something new can wait.
        assert_eq!(next.priority, Priority::Browse);
    }
}
