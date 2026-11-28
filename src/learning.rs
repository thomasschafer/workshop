//! The tracks of short items from packs: review cards, mental maths, probability and code to
//! read, and any tracks a pack adds for them. What's due across every track, the Coding track's
//! problems included, is planned here together, so they share one day's limit of reviews.
//!
//! The app works on a deck: every short item, with its schedule, and questions already made
//! from each mental maths template. With that it can practise offline, scheduling what's
//! answered itself until it can sync. Syncing sends the attempts made since, and gets the deck
//! back as the server's log now has it.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::{Context, Result, bail};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use workshop_learning::{
    Attempt, Clock, Flag, FlagChange, ItemRef, ItemSchedule, LessonCompletion, LessonPlanRef,
    LessonRequest, LessonSkip, Limits, Log, Outline, Progress, Rating, Retirement,
    RetirementChange, SkillMastery, Store, TrackPlan,
};
use workshop_pack::number::Tolerance;
use workshop_pack::{Content, FollowUps, ImageData, Item, Lesson, Pack};
use workshop_tracks::{Priority, Step, Track, TrackIcon, TrackId};

use crate::config::LearningConfig;
use crate::follow_ups::Exchange;
use crate::tracks::Destination;

/// How many questions the deck has ready from each mental maths template, for practising
/// offline. Once they're used up, the app starts them again.
const INSTANCES: u64 = 12;

pub struct Learning {
    store: Store,
    config: LearningConfig,
    /// Cards answered in the learner's own words and being followed up, by card.
    exchanges: workshop_sessions::Saved<Exchange>,
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
    pub lessons: Vec<DeckLesson>,
    /// The labs, to list in their tracks. Working through one needs the server, so only what
    /// the list shows is here.
    pub labs: Vec<DeckLab>,
    pub schedules: BTreeMap<String, ItemSchedule>,
    pub flags: BTreeMap<String, Flag>,
    /// Where each item that's ever been retired stands, so the app leaves retired ones out.
    pub retirements: BTreeMap<String, Retirement>,
    /// Completion timestamps (ms since 1970) per lesson key, in chronological order.
    pub lesson_completions: BTreeMap<String, Vec<i64>>,
    /// Skip ("Not now") timestamps (ms since 1970) per lesson key, in chronological order.
    pub lesson_skips: BTreeMap<String, Vec<i64>>,
    /// Most recent attempt's rating per short item key, for spotting consecutive lapses.
    pub last_ratings: BTreeMap<String, Rating>,
    pub skills: Vec<DeckSkill>,
    /// The skills recent mistakes point to, whose new items come first.
    pub focus: Vec<String>,
    /// Cards with follow-up questions under way, by key, which come first, to carry on with.
    pub follow_ups: Vec<String>,
    /// What's wrong in the packs, which is left out.
    pub problems: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct DeckTrack {
    pub id: TrackId,
    pub name: String,
    pub icon: TrackIcon,
    /// Whether it's kept out of Continue, so its items have limits of their own, and don't
    /// count towards the week's target.
    pub kept_apart: bool,
    /// For a track kept apart, what's been done in it today and this week, as the server knows.
    pub progress: Option<Progress>,
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
    /// Full `pack/lesson` key of the lesson that teaches this item, if any.
    pub lesson: Option<String>,
    /// The segment of that lesson covering this item, counting from 0, if specified.
    pub segment: Option<usize>,
    #[serde(flatten)]
    pub content: DeckContent,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum DeckContent {
    Card {
        answer: String,
        explanation: Option<String>,
        /// How many follow-up questions the tutor asks when the learner goes deeper, or 0 if
        /// the card doesn't offer them.
        follow_ups: FollowUps,
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

/// A lab, as its track lists it.
#[derive(Debug, Serialize)]
pub struct DeckLab {
    /// `pack/item`.
    pub key: String,
    pub track: TrackId,
    pub title: String,
    pub minutes: u32,
    /// Full `pack/lesson` key of the lesson to do first, if it names one.
    pub lesson: Option<String>,
    /// Whether it's been done, and marked, at least once.
    pub done: bool,
}

/// A lesson in the deck, carrying its segments, checks, guesses, sources and embedded images so
/// it can be worked through offline.
#[derive(Debug, Serialize)]
pub struct DeckLesson {
    /// `pack/item`.
    pub key: String,
    pub track: TrackId,
    pub title: String,
    pub skills: Vec<String>,
    /// What the lesson covers, in Markdown.
    pub prompt: String,
    pub source: Option<String>,
    pub minutes: u32,
    /// Full `pack/item` keys of lessons in the same pack to do first.
    pub requires: Vec<String>,
    pub sources: Vec<DeckLessonSource>,
    pub guesses: Vec<DeckLessonGuess>,
    pub segments: Vec<DeckLessonSegment>,
    pub explain: String,
    pub explain_answer: String,
    /// Images referenced in segments, keyed by their relative path inside the lesson's directory.
    pub images: BTreeMap<String, DeckLessonImage>,
}

#[derive(Debug, Serialize)]
pub struct DeckLessonSource {
    pub title: String,
    pub url: String,
}

#[derive(Debug, Serialize)]
pub struct DeckLessonGuess {
    pub prompt: String,
    pub choices: Vec<String>,
    /// The right choice, counting from 0.
    pub answer: usize,
}

#[derive(Debug, Serialize)]
pub struct DeckLessonCheck {
    pub prompt: String,
    pub choices: Vec<String>,
    /// The right choice, counting from 0.
    pub answer: usize,
    pub explanation: String,
}

#[derive(Debug, Serialize)]
pub struct DeckLessonSegment {
    pub title: String,
    pub body: String,
    pub check: Option<DeckLessonCheck>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum DeckLessonImage {
    Svg { svg: String },
    Png { data_url: String },
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
    /// Lessons completed since the last sync.
    #[serde(default)]
    pub lesson_completions: Vec<LessonCompletion>,
    /// Lessons skipped with "Not now" since the last sync.
    #[serde(default)]
    pub lesson_skips: Vec<LessonSkip>,
    /// Lesson requests made by choosing "Teach me" on short items without a lesson.
    #[serde(default)]
    pub lesson_requests: Vec<LessonRequest>,
}

/// A short item the learner chose "Teach me" on when it had no lesson yet, still waiting for one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WaitingLessonRequest {
    /// `pack/item`.
    pub item: String,
    pub pack: String,
    pub path: String,
    pub id: String,
    pub label: String,
    pub skills: Vec<String>,
    pub prompt: String,
    pub answer: String,
    pub explanation: Option<String>,
    pub requested_at: i64,
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

/// The tracks kept out of Continue, and the items in each, by key.
struct Apart {
    tracks: BTreeSet<TrackId>,
    keys: BTreeMap<String, TrackId>,
}

impl Apart {
    /// The packs' tracks kept apart, with these of their items and lessons in them. A track two
    /// packs share is kept apart if either keeps it apart.
    fn new<'a>(packs: &[Pack], items: impl IntoIterator<Item = &'a Short<'a>>) -> Self {
        let tracks: BTreeSet<TrackId> = packs
            .iter()
            .flat_map(|pack| pack.manifest.kept_apart())
            .collect();
        let keys = items
            .into_iter()
            .filter(|short| tracks.contains(&short.item.track))
            .map(|short| (short.key.clone(), short.item.track.clone()))
            .collect();
        Self { tracks, keys }
    }
}

/// An item from a pack, with the key it's known by across packs.
struct Short<'a> {
    key: String,
    /// Full `pack/lesson` key of the lesson teaching this item, if any.
    lesson_key: Option<String>,
    /// Full `pack/lesson` keys of prerequisites, for lessons.
    requires_keys: Vec<String>,
    item: &'a Item,
}

/// Answer and explanation text for a short item, as shown to the author when a learner asks for
/// a lesson on it.
fn item_answer_and_explanation(item: &Item) -> (String, Option<String>) {
    match &item.content {
        Content::Card {
            answer,
            explanation,
            ..
        } => (answer.clone(), explanation.clone()),
        Content::MentalMaths(template) => {
            let answer = workshop_pack::mental::Generator::new(template, &item.prompt)
                .and_then(|g| g.instance(0))
                .map_or_else(
                    |_| template.answer.clone(),
                    |instance| {
                        format!(
                            "{} (formula: {})",
                            workshop_pack::number::display(instance.answer),
                            template.answer
                        )
                    },
                );
            (answer, template.method.clone())
        }
        Content::Probability(probability) => (
            probability.answer_text.clone(),
            Some(probability.solution.clone()),
        ),
        Content::Reading(reading) => {
            let answer = match &reading.question {
                workshop_pack::Question::Prints { output } => output.clone(),
                workshop_pack::Question::Choice { choices, answer } => choices
                    .get(*answer)
                    .cloned()
                    .unwrap_or_else(|| format!("choice {}", answer + 1)),
            };
            (answer, Some(reading.explanation.clone()))
        }
        _ => (String::new(), None),
    }
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
            exchanges: workshop_sessions::Saved::new(data_dir.join("follow-ups")),
        })
    }

    /// Cards being followed up, kept as each answer and question is given.
    pub fn exchanges(&self) -> &workshop_sessions::Saved<Exchange> {
        &self.exchanges
    }

    /// A card's follow-up questions, under way or marked, if it has any, as they stand now.
    /// Ones under way that were superseded, as the card's been answered some other way since
    /// they started, such as rated by the learner, offline or on another device, or flagged as
    /// wrong, are over, so there are none. They're only replaced when follow-ups start again.
    pub fn exchange(&self, key: &str) -> Result<Option<Exchange>> {
        let Some(exchange) = self.exchanges.get(key)? else {
            return Ok(None);
        };
        let attempts = self.store.attempts(key)?.len() as u64;
        let flagged = self.store.flags()?.contains_key(key);
        Ok((!exchange.superseded(attempts, flagged)).then_some(exchange))
    }

    /// The follow-up questions under way on a card, if there are any, as `exchange` finds them,
    /// but not those marked already.
    pub fn follow_ups(&self, key: &str) -> Result<Option<Exchange>> {
        Ok(self
            .exchange(key)?
            .filter(|exchange| exchange.marked.is_none()))
    }

    /// The cards with follow-up questions under way, as `follow_ups` finds them.
    pub fn follow_ups_under_way(&self) -> Result<BTreeSet<String>> {
        let attempts = self.store.attempt_counts()?;
        let flags = self.store.flags()?;
        Ok(self
            .exchanges
            .all()?
            .into_iter()
            .filter(|(key, exchange)| {
                let count = attempts.get(key).copied().unwrap_or(0);
                exchange.marked.is_none() && !exchange.superseded(count, flags.contains_key(key))
            })
            .map(|(key, _)| key)
            .collect())
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
            daily_lessons: self.config.daily_lessons,
            weekly_minutes: self.config.weekly_minutes,
            retention: self.config.desired_retention,
        }
    }

    /// What's been done today and this week on the items, by key, that `counts` says count.
    fn progress_of(&self, clock: Clock, counts: impl Fn(&str) -> bool) -> Result<Progress> {
        let today = self.store.activity_of(clock.day_start(), &counts)?;
        let week = self.store.activity_of(clock.week_start(), &counts)?;
        Ok(Progress {
            reviews_today: today.reviews,
            new_today: today.new,
            lessons_today: today.lessons,
            minutes_this_week: (week.ms / 60_000) as u32,
        })
    }

    /// What's been done today and this week: on everything but the tracks kept apart, which
    /// counts towards the day's limits and the week's target, and on each track kept apart,
    /// which counts towards its own limits only.
    fn progress(
        &self,
        clock: Clock,
        apart: &Apart,
    ) -> Result<(Progress, BTreeMap<TrackId, Progress>)> {
        let shared = self.progress_of(clock, |key| !apart.keys.contains_key(key))?;
        let mut tracks = BTreeMap::new();
        for track in &apart.tracks {
            let progress = self.progress_of(clock, |key| apart.keys.get(key) == Some(track))?;
            tracks.insert(track.clone(), progress);
        }
        Ok((shared, tracks))
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
        let mastery = self.mastery_of(&packs, &refs, clock)?;
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
        let practised = practised(&packs);
        let lesson_items = lessons(&packs);
        let deck_lessons: Vec<DeckLesson> = lesson_items
            .iter()
            .map(deck_lesson)
            .collect::<Result<Vec<_>>>()?;
        let labs = practised
            .iter()
            .filter_map(|short| {
                let Content::Lab(lab) = &short.item.content else {
                    return None;
                };
                Some(DeckLab {
                    key: short.key.clone(),
                    track: short.item.track.clone(),
                    title: short.item.label(),
                    minutes: short.item.minutes,
                    lesson: lab
                        .lesson
                        .as_ref()
                        .map(|lesson| format!("{}/{lesson}", pack_of(&short.key))),
                    done: counts.get(&short.key).is_some_and(|&n| n > 0),
                })
            })
            .collect();
        let mut all_track_items = Vec::with_capacity(practised.len() + lesson_items.len());
        all_track_items.extend(&practised);
        all_track_items.extend(&lesson_items);
        let apart = Apart::new(&packs, all_track_items.iter().copied());
        let (progress, mut apart_progress) = self.progress(clock, &apart)?;
        let tracks = track_names(&packs, all_track_items)
            .into_iter()
            .map(|(id, (name, icon))| DeckTrack {
                kept_apart: apart.tracks.contains(&id),
                progress: apart_progress.remove(&id),
                id,
                name,
                icon,
            })
            .collect();
        let keys: std::collections::BTreeSet<&str> =
            shorts.iter().map(|s| s.key.as_str()).collect();
        let lesson_keys: std::collections::BTreeSet<&str> =
            lesson_items.iter().map(|l| l.key.as_str()).collect();
        let lesson_completions = self
            .store
            .lesson_completions_by_lesson()?
            .into_iter()
            .filter(|(key, _)| lesson_keys.contains(key.as_str()))
            .collect();
        let lesson_skips = self
            .store
            .lesson_skips_by_lesson()?
            .into_iter()
            .filter(|(key, _)| lesson_keys.contains(key.as_str()))
            .collect();
        let last_ratings = self
            .store
            .last_ratings()?
            .into_iter()
            .filter(|(key, _)| keys.contains(key.as_str()))
            .collect();
        let follow_ups = self
            .follow_ups_under_way()?
            .into_iter()
            .filter(|key| keys.contains(key.as_str()))
            .collect();
        Ok(Deck {
            limits: self.limits(),
            progress,
            day_start: clock.day_start(),
            week_start: clock.week_start(),
            tracks,
            items,
            lessons: deck_lessons,
            labs,
            schedules: schedules
                .into_iter()
                .filter(|(key, _)| keys.contains(key.as_str()))
                .collect(),
            flags: self.store.flags()?,
            retirements: retirements
                .into_iter()
                .filter(|(key, _)| keys.contains(key.as_str()))
                .collect(),
            lesson_completions,
            lesson_skips,
            last_ratings,
            skills,
            focus: self.focus(&packs, clock.now)?,
            follow_ups,
            problems: problems(&packs),
        })
    }

    /// Records what a device did, then gives it the deck as it now is. Sending the same
    /// attempts and changes again changes nothing.
    pub fn sync(&self, request: &SyncRequest, clock: Clock) -> Result<Deck> {
        let retirements = self.retirements_to_record(&request.attempts, &request.retirements)?;
        self.record_with(&request.attempts, &retirements, clock.now)?;
        self.store.record_flags(&request.flags)?;
        self.store
            .record_lesson_completions(&request.lesson_completions, clock.now)?;
        self.store
            .record_lesson_skips(&request.lesson_skips, clock.now)?;
        self.store
            .record_lesson_requests(&request.lesson_requests, clock.now)?;
        self.deck(clock)
    }

    /// Waiting lesson requests across all loaded packs, dropping any for items that now name a
    /// lesson or are gone from their pack.
    pub fn waiting_lesson_requests(&self) -> Result<Vec<WaitingLessonRequest>> {
        let packs = self.packs()?;
        self.waiting_lesson_requests_in(&packs)
    }

    /// Waiting lesson requests for items in `packs`, dropping any for items in those packs that
    /// now name a lesson or are gone from their pack.
    pub fn waiting_lesson_requests_in(&self, packs: &[Pack]) -> Result<Vec<WaitingLessonRequest>> {
        let requests = self.store.lesson_requests()?;
        if requests.is_empty() {
            return Ok(Vec::new());
        }
        let packs_by_id: BTreeMap<&str, &Pack> = packs
            .iter()
            .map(|pack| (pack.manifest.id.as_str(), pack))
            .collect();
        let mut to_drop: BTreeSet<String> = BTreeSet::new();
        let mut seen: BTreeSet<String> = BTreeSet::new();
        let mut waiting = Vec::new();
        for req in requests {
            let Some((pack_id, item_id)) = req.item.split_once('/') else {
                to_drop.insert(req.item);
                continue;
            };
            let Some(pack) = packs_by_id.get(pack_id) else {
                continue;
            };
            let Some(item) = pack.item(item_id) else {
                // Only drop when the pack doesn't have an unreadable file that may be this item.
                if !pack.problems.iter().any(|p| p.path.contains(item_id)) {
                    to_drop.insert(req.item);
                }
                continue;
            };
            if item.lesson.is_some() || !item.kind.is_short() {
                to_drop.insert(req.item);
                continue;
            }
            if !seen.insert(req.item.clone()) {
                continue;
            }
            let (answer, explanation) = item_answer_and_explanation(item);
            let pack = pack_id.to_owned();
            waiting.push(WaitingLessonRequest {
                item: req.item,
                pack,
                path: item.path.clone(),
                id: item.id.clone(),
                label: item.label(),
                skills: item.skills.clone(),
                prompt: item.prompt.clone(),
                answer,
                explanation,
                requested_at: req.requested_at,
            });
        }
        if !to_drop.is_empty() {
            let drop_list: Vec<String> = to_drop.into_iter().collect();
            self.store.drop_lesson_requests(&drop_list)?;
        }
        Ok(waiting)
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

    /// How well each skill is known and how much of it is covered, at `clock`, over `items`.
    fn mastery_of(
        &self,
        packs: &[Pack],
        items: &[ItemRef<'_>],
        clock: Clock,
    ) -> Result<Vec<SkillMastery>> {
        let attempts = self.store.all_attempts()?;
        let retirements = self.store.retirement_changes()?;
        let lesson_completions = self.store.lesson_completions()?;
        Ok(workshop_learning::mastery(
            items,
            &outline(packs),
            Log {
                attempts: &attempts,
                retirements: &retirements,
                lesson_completions: &lesson_completions,
            },
            self.store.scheduler(),
            clock.now,
            clock.utc_offset_minutes,
        ))
    }

    /// How well each skill is known now, and how much of it is covered, over the items there's
    /// practice of.
    pub fn skill_mastery(&self, clock: Clock) -> Result<Vec<SkillMastery>> {
        let packs = self.packs()?;
        let items = practised(&packs);
        self.mastery_of(&packs, &item_refs(&items), clock)
    }

    /// How each of the packs' goals is going.
    pub fn goals(&self, clock: Clock) -> Result<Vec<crate::goals::GoalProgress>> {
        let packs = self.packs()?;
        let items = practised(&packs);
        let recent = self
            .store
            .mistakes(clock.now - crate::mistakes::RECENT_MS)?;
        let attempts = self.store.all_attempts()?;
        let retirements = self.store.retirement_changes()?;
        let lesson_completions = self.store.lesson_completions()?;
        Ok(crate::goals::progress(
            &packs,
            &item_refs(&items),
            &outline(&packs),
            Log {
                attempts: &attempts,
                retirements: &retirements,
                lesson_completions: &lesson_completions,
            },
            &recent,
            self.store.scheduler(),
            clock,
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
        let lesson_items = lessons(&packs);
        // Cards being followed up are carried on with first, apart from what's due and new,
        // and today's limits, as the app does.
        let follow_ups = self.follow_ups_under_way()?;
        let refs: Vec<ItemRef<'_>> = item_refs(&items)
            .into_iter()
            .filter(|item| !follow_ups.contains(item.key))
            .collect();
        let lesson_refs = lesson_plan_refs(&lesson_items);
        let apart = Apart::new(&packs, items.iter().chain(&lesson_items));
        let (progress, apart_progress) = self.progress(clock, &apart)?;
        let limits = self.limits();
        let focus = self.focus(&packs, clock.now)?;
        let retirements = self.store.retirements()?;
        let schedules = self.store.schedules()?;
        let flags = self.store.flags()?;
        let lesson_completions = self.store.lesson_completions_by_lesson()?;
        let lesson_skips = self.store.lesson_skips_by_lesson()?;
        let plan = |refs: &[ItemRef<'_>], lessons: &[LessonPlanRef<'_>], progress: Progress| {
            workshop_learning::plan(
                refs,
                lessons,
                &schedules,
                &flags,
                &retirements,
                &lesson_completions,
                &lesson_skips,
                progress,
                limits,
                &focus,
                self.store.scheduler(),
                clock,
            )
        };
        // Everything but the tracks kept apart shares the day's limits; each track kept apart
        // has limits of its own, the same size, counting only what's done in it.
        let (kept, shared): (Vec<ItemRef<'_>>, Vec<ItemRef<'_>>) = refs
            .iter()
            .partition(|item| apart.tracks.contains(item.track));
        let (kept_lessons, shared_lessons): (Vec<LessonPlanRef<'_>>, Vec<LessonPlanRef<'_>>) =
            lesson_refs
                .iter()
                .partition(|lesson| apart.tracks.contains(lesson.track));
        let mut plans = plan(&shared, &shared_lessons, progress);
        for (track, progress) in &apart_progress {
            let in_track: Vec<ItemRef<'_>> = kept
                .iter()
                .filter(|item| item.track == track)
                .copied()
                .collect();
            let track_lessons: Vec<LessonPlanRef<'_>> = kept_lessons
                .iter()
                .filter(|lesson| lesson.track == track)
                .copied()
                .collect();
            plans.extend(plan(&in_track, &track_lessons, *progress));
        }
        let lessons_done = lesson_completions
            .iter()
            .filter(|(_, done)| !done.is_empty())
            .map(|(key, _)| key.clone())
            .collect();
        let names = track_names(&packs, &items);
        let skill_names = packs
            .iter()
            .flat_map(|pack| &pack.manifest.skills)
            .map(|skill| (skill.id.clone(), skill.name.clone()))
            .collect();
        Ok(Planned {
            follow_ups,
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
            kept_apart: apart.tracks,
            lessons_done,
            packs,
        })
    }

    /// The tracks of short items, from a plan, with any coding problems in them and the
    /// problems in progress, the cards with follow-up questions under way, and the labs, with
    /// those under way, and of design prompts, with the design sessions in progress. The Coding
    /// track, whose problems are worked on over several steps, is the coding module's.
    pub fn tracks(
        &self,
        planned: &Planned,
        clock: Clock,
        designs: &BTreeMap<String, workshop_sessions::design::Session>,
        problems: &BTreeMap<String, crate::coding::Started>,
        labs: &BTreeMap<String, workshop_sessions::lab::Session>,
    ) -> Tracks {
        let empty = workshop_learning::TrackPlan::default();
        let tracks = planned
            .names
            .iter()
            .filter(|(id, _)| **id != TrackId::Coding)
            .map(|(id, (name, icon))| {
                let plan = planned.plans.get(id).unwrap_or(&empty);
                if *id == TrackId::SystemDesign {
                    return design_track(plan, planned, designs);
                }
                let followed_up: Vec<&Item> = planned
                    .follow_ups
                    .iter()
                    .filter_map(|key| planned.item(key))
                    .filter(|item| item.track == *id)
                    .collect();
                // Short items first, between steps as pressing as each other, as they're quicker.
                let next = [
                    followed_up_step(id, &followed_up),
                    next_step(id, plan, planned),
                    crate::coding::problem_step(planned, problems, id),
                ]
                .into_iter()
                .flatten()
                .min_by_key(|step| step.priority);
                Track {
                    summary: summary(&without_labs(plan, planned), clock, followed_up.len()),
                    destination: Destination::Practice { track: id.clone() },
                    next,
                    long: lab_step(id, plan, planned, labs),
                    in_continue: !planned.kept_apart.contains(id),
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
    /// The cards with follow-up questions under way, which aren't in the plans.
    pub follow_ups: BTreeSet<String>,
    /// The skills recent mistakes point to, most first.
    pub focus: Vec<String>,
    /// Every skill's name, by id.
    pub skill_names: BTreeMap<String, String>,
    pub plans: BTreeMap<TrackId, TrackPlan>,
    /// Where each item that's ever been retired stands.
    pub retirements: BTreeMap<String, Retirement>,
    /// Each track with items in it, and its name and icon.
    pub names: BTreeMap<TrackId, (String, TrackIcon)>,
    /// The packs' tracks kept out of Continue, whose items are only offered in them.
    pub kept_apart: BTreeSet<TrackId>,
    /// The lessons done at least once, as `pack/lesson`.
    pub lessons_done: BTreeSet<String>,
    pub week: Week,
    pub problems: Vec<String>,
}

fn shorts(packs: &[Pack]) -> Vec<Short<'_>> {
    items_where(packs, |item| item.kind.is_short())
}

fn lessons(packs: &[Pack]) -> Vec<Short<'_>> {
    items_where(packs, |item| item.kind == workshop_pack::Kind::Lesson)
}

/// The items there's practice of: the short ones, coding problems, work in a codebase, design
/// prompts and labs. Lessons aren't scheduled or counted towards mastery.
fn practised(packs: &[Pack]) -> Vec<Short<'_>> {
    items_where(packs, |item| {
        item.kind.is_short()
            || matches!(
                item.kind,
                workshop_pack::Kind::Coding
                    | workshop_pack::Kind::Codebase
                    | workshop_pack::Kind::Design
                    | workshop_pack::Kind::Lab
            )
    })
}

/// The pack of an item's `pack/item` key.
fn pack_of(key: &str) -> &str {
    key.split_once('/')
        .map(|(pack, _)| pack)
        .expect("an item's key is `pack/item`")
}

fn items_where(packs: &[Pack], keep: impl Fn(&Item) -> bool) -> Vec<Short<'_>> {
    packs
        .iter()
        .flat_map(|pack| {
            pack.items.iter().filter(|item| keep(item)).map(|item| {
                let pack_id = &pack.manifest.id;
                let lesson_key = item.lesson.as_ref().map(|l| format!("{pack_id}/{}", l.id));
                let requires_keys = match &item.content {
                    Content::Lesson(lesson) => lesson
                        .requires
                        .iter()
                        .map(|req| format!("{pack_id}/{req}"))
                        .collect(),
                    _ => Vec::new(),
                };
                Short {
                    key: format!("{pack_id}/{}", item.id),
                    lesson_key,
                    requires_keys,
                    item,
                }
            })
        })
        .collect()
}

/// Every skill's topics, and the topic each lesson teaches, across the packs. Skills with the
/// same id in two packs are one skill, with the topics of both.
fn outline(packs: &[Pack]) -> Outline {
    let mut outline = Outline::default();
    for pack in packs {
        for skill in &pack.manifest.skills {
            if !skill.topics.is_empty() {
                outline
                    .topics
                    .entry(skill.id.clone())
                    .or_default()
                    .extend(skill.topics.iter().map(|topic| topic.id.clone()));
            }
        }
        for item in &pack.items {
            if let Content::Lesson(Lesson {
                topic: Some(topic), ..
            }) = &item.content
            {
                outline.lessons.insert(
                    format!("{}/{}", pack.manifest.id, item.id),
                    (topic.skill.clone(), topic.topic.clone()),
                );
            }
        }
    }
    outline
}

fn item_refs<'a>(shorts: &'a [Short<'a>]) -> Vec<ItemRef<'a>> {
    shorts
        .iter()
        .map(|short| ItemRef {
            key: &short.key,
            track: &short.item.track,
            skills: &short.item.skills,
            lesson: short.lesson_key.as_deref(),
        })
        .collect()
}

fn lesson_plan_refs<'a>(lessons: &'a [Short<'a>]) -> Vec<LessonPlanRef<'a>> {
    lessons
        .iter()
        .map(|short| LessonPlanRef {
            key: &short.key,
            track: &short.item.track,
            requires: &short.requires_keys,
        })
        .collect()
}

/// The tracks with these items in them, in the order the home screen shows them, and their
/// names and icons. Two packs' tracks with the same id are one track.
fn track_names<'a>(
    packs: &[Pack],
    shorts: impl IntoIterator<Item = &'a Short<'a>>,
) -> BTreeMap<TrackId, (String, TrackIcon)> {
    shorts
        .into_iter()
        .map(|short| {
            let id = short.item.track.clone();
            let label = track_label(packs, &id);
            (id, label)
        })
        .collect()
}

/// A track's name and icon: a built-in track's own, or as the first of `packs` with the track
/// names it.
pub fn track_label(packs: &[Pack], id: &TrackId) -> (String, TrackIcon) {
    match id {
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
    }
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
            follow_ups,
        } => DeckContent::Card {
            answer: answer.clone(),
            explanation: explanation.clone(),
            follow_ups: *follow_ups,
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
        Content::Coding(_)
        | Content::Design { .. }
        | Content::Review(_)
        | Content::Lesson(_)
        | Content::Lab(_) => {
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
        lesson: short.lesson_key.clone(),
        segment: item.lesson.as_ref().and_then(|l| l.segment),
        content,
    })
}

fn deck_lesson(short: &Short<'_>) -> Result<DeckLesson> {
    let item = short.item;
    let Content::Lesson(Lesson {
        topic: _,
        requires,
        sources,
        guesses,
        segments,
        explain,
        explain_answer,
    }) = &item.content
    else {
        unreachable!("only lessons are built as deck lessons");
    };
    let pack_id = short
        .key
        .split_once('/')
        .map(|(pack, _)| pack)
        .context("lesson key should have pack/item form")?;
    let mut images = BTreeMap::new();
    for segment in segments {
        for image in &segment.images {
            images
                .entry(image.file.clone())
                .or_insert_with(|| match &image.data {
                    ImageData::Svg(svg) => DeckLessonImage::Svg { svg: svg.clone() },
                    ImageData::Png(bytes) => {
                        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
                        DeckLessonImage::Png {
                            data_url: format!("data:image/png;base64,{encoded}"),
                        }
                    }
                });
        }
    }
    Ok(DeckLesson {
        key: short.key.clone(),
        track: item.track.clone(),
        title: item.label(),
        skills: item.skills.clone(),
        prompt: item.prompt.clone(),
        source: item.source.clone(),
        minutes: item.minutes,
        requires: requires
            .iter()
            .map(|req| format!("{pack_id}/{req}"))
            .collect(),
        sources: sources
            .iter()
            .map(|s| DeckLessonSource {
                title: s.title.clone(),
                url: s.url.clone(),
            })
            .collect(),
        guesses: guesses
            .iter()
            .map(|g| DeckLessonGuess {
                prompt: g.prompt.clone(),
                choices: g.choices.clone(),
                answer: g.answer,
            })
            .collect(),
        segments: segments
            .iter()
            .map(|s| DeckLessonSegment {
                title: s.title.clone(),
                body: s.body.clone(),
                check: s.check.as_ref().map(|c| DeckLessonCheck {
                    prompt: c.prompt.clone(),
                    choices: c.choices.clone(),
                    answer: c.answer,
                    explanation: c.explanation.clone(),
                }),
            })
            .collect(),
        explain: explain.clone(),
        explain_answer: explain_answer.clone(),
        images,
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

/// A track's plan without its labs, which its practice screen lists apart from what's due and
/// new, so the track's summary counts what's practised in it.
fn without_labs(plan: &TrackPlan, planned: &Planned) -> TrackPlan {
    let not_lab = |key: &&String| {
        planned
            .item(key)
            .is_none_or(|item| item.kind != workshop_pack::Kind::Lab)
    };
    TrackPlan {
        due: plan.due.iter().filter(not_lab).cloned().collect(),
        new: plan.new.iter().filter(not_lab).cloned().collect(),
        new_waiting: plan.new_waiting.iter().filter(not_lab).cloned().collect(),
        ..plan.clone()
    }
}

/// The lab a track suggests for when the learner has a while, as labs take one: the one under
/// way that was worked on most recently, then one that's due, then something new whose lesson,
/// if it names one, has been done.
fn lab_step(
    id: &TrackId,
    plan: &TrackPlan,
    planned: &Planned,
    labs: &BTreeMap<String, workshop_sessions::lab::Session>,
) -> Option<Step<Destination>> {
    let lab = |key: &str| {
        planned
            .item(key)
            .filter(|item| item.track == *id)
            .and_then(|item| match &item.content {
                Content::Lab(lab) => Some((item, lab)),
                _ => None,
            })
    };
    let unfinished = labs
        .iter()
        .filter(|(key, _)| lab(key).is_some())
        .max_by_key(|(_, session)| session.updated_at)
        .map(|(key, session)| {
            let place = match session.at {
                0 => "the setup".to_owned(),
                at if at > session.steps() => "the question at the end".to_owned(),
                at => format!("step {at}"),
            };
            (
                key,
                Priority::Unfinished,
                format!("Where you left off: {place}"),
            )
        });
    let ready = |key: &&String| {
        lab(key).is_some_and(|(_, lab)| {
            lab.lesson.as_ref().is_none_or(|lesson| {
                planned
                    .lessons_done
                    .contains(&format!("{}/{lesson}", pack_of(key)))
            })
        })
    };
    unfinished
        .or_else(|| {
            plan.due
                .iter()
                .find(|key| lab(key).is_some())
                .map(|key| (key, Priority::Due, "Lab · due for review".to_owned()))
        })
        .or_else(|| {
            plan.new
                .iter()
                .find(ready)
                .map(|key| (key, Priority::New, "Lab · something new".to_owned()))
        })
        .map(|(key, priority, reason)| Step {
            title: planned.item(key).map_or_else(|| key.clone(), Item::label),
            reason,
            priority,
            destination: Destination::Lab { item: key.clone() },
        })
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

    /// Whether an item is in a track kept out of Continue, so it's only offered in its track.
    pub fn is_kept_apart(&self, item: &Item) -> bool {
        self.kept_apart.contains(&item.track)
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

/// The step a track with cards whose follow-up questions are under way suggests: carrying on
/// with them, which the app does first.
fn followed_up_step(id: &TrackId, cards: &[&Item]) -> Option<Step<Destination>> {
    let first = cards.first()?;
    Some(Step {
        title: first.label(),
        reason: "Where you left off: its follow-up questions".to_owned(),
        priority: Priority::Unfinished,
        destination: Destination::Practice { track: id.clone() },
    })
}

/// The step a track suggests for its next eligible lesson, when one is offered before new items.
pub(crate) fn lesson_step(plan: &TrackPlan, planned: &Planned) -> Option<Step<Destination>> {
    let key = plan.next_lesson.as_ref()?;
    let lesson = planned.item(key);
    let title = lesson.map_or_else(|| key.clone(), Item::label);
    let destination = Destination::Lesson { item: key.clone() };
    if let Some(skill) = lesson.and_then(|l| planned.focus_of(l)) {
        return Some(Step {
            title,
            reason: format!("Lesson · practise {skill}, after recent mistakes"),
            priority: Priority::Focus,
            destination,
        });
    }
    let priority = if planned.week.minutes >= planned.week.target {
        Priority::Browse
    } else {
        Priority::New
    };
    Some(Step {
        title,
        reason: "Lesson".to_owned(),
        priority,
        destination,
    })
}

/// The step a track suggests, given its plan: due reviews, then the track's next lesson if one is
/// offered, then something new, sooner if it's in a skill recent mistakes point to.
fn next_step(id: &TrackId, plan: &TrackPlan, planned: &Planned) -> Option<Step<Destination>> {
    // Only the short items, practised a few at a time; the track's problems are the coding
    // module's.
    let short = |key: &&String| planned.item(key).is_some_and(|item| item.kind.is_short());
    let short_plan = TrackPlan {
        due: plan.due.iter().filter(short).cloned().collect(),
        new: plan.new.iter().filter(short).cloned().collect(),
        next_lesson: plan.next_lesson.clone(),
        ..TrackPlan::default()
    };
    let week = planned.week;
    let destination = Destination::Practice { track: id.clone() };
    if !short_plan.due.is_empty() {
        return Some(Step {
            title: format!("{} due", count(short_plan.due.len(), "", id)),
            reason: "Due today".to_owned(),
            priority: Priority::Due,
            destination,
        });
    }
    if let Some(step) = lesson_step(&short_plan, planned) {
        return Some(step);
    }
    if let Some(first) = short_plan.new.first() {
        if let Some(skill) = planned.item(first).and_then(|item| planned.focus_of(item)) {
            return Some(Step {
                title: count(short_plan.new.len(), "new ", id),
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
            title: count(short_plan.new.len(), "new ", id),
            reason: "Something new".to_owned(),
            priority,
            destination,
        });
    }
    None
}

/// What's to do in a track, with `followed_up` cards whose follow-up questions are under way.
fn summary(plan: &TrackPlan, clock: Clock, followed_up: usize) -> String {
    let mut parts = Vec::new();
    if followed_up > 0 {
        parts.push(format!("{followed_up} being followed up"));
    }
    if !plan.due.is_empty() {
        parts.push(format!("{} due", plan.due.len()));
    }
    if plan.next_lesson.is_some() {
        parts.push("1 lesson".to_owned());
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
            daily_lessons: 1,
            weekly_minutes: 1,
            desired_retention: 0.9,
        };
        Learning::open(&config, dir).unwrap()
    }

    /// A pack with a track kept out of Continue, which its items are in unless they say
    /// otherwise: three cards, code to read and a coding problem. Another card is in Review.
    pub(crate) fn kept_apart_pack(dir: &Path) -> std::path::PathBuf {
        let pack = dir.join("pack");
        let files: &[(&str, &str)] = &[
            (
                "pack.toml",
                "id = \"apart\"\nname = \"Apart\"\ntrack = \"drill\"\n\n[[skills]]\nid = \"sums\"\nname = \"Sums\"\n\n[[tracks]]\nid = \"drill\"\nname = \"Drill\"\ncontinue = false\n",
            ),
            (
                "items/one.md",
                "+++\nkind = \"card\"\nskills = [\"sums\"]\n+++\nOne?\n## Answer\n1\n",
            ),
            (
                "items/two.md",
                "+++\nkind = \"card\"\nskills = [\"sums\"]\n+++\nTwo?\n## Answer\n2\n",
            ),
            (
                "items/three.md",
                "+++\nkind = \"card\"\nskills = [\"sums\"]\n+++\nThree?\n## Answer\n3\n",
            ),
            (
                "items/shared.md",
                "+++\nkind = \"card\"\nskills = [\"sums\"]\ntrack = \"review\"\n+++\nShared?\n## Answer\nYes\n",
            ),
            (
                "items/read.md",
                "+++\nkind = \"reading\"\nskills = [\"sums\"]\nprints = \"3\"\n+++\nWhat does this print?\n\n```python\nprint(1 + 2)\n```\n\n## Explanation\n\nAddition.\n",
            ),
            (
                "items/add/item.md",
                "+++\nkind = \"coding\"\ntitle = \"Add them up\"\nskills = [\"sums\"]\nlanguages = [\"python\"]\nreference = [\"reference.py\"]\nstarter = [\"starter.py\"]\nbrute_force = \"reference.py\"\ninputs = \"inputs.py\"\ntests = \"tests.toml\"\n+++\nPrint the sum of the numbers.\n\n## Approach\n\nAdd them up.\n",
            ),
            (
                "items/add/reference.py",
                "print(sum(map(int, input().split())))\n",
            ),
            (
                "items/add/starter.py",
                "numbers = list(map(int, input().split()))\n",
            ),
            (
                "items/add/inputs.py",
                "import random, sys\nrng = random.Random(int(sys.argv[1]))\nprint(*[rng.randint(-9, 9) for _ in range(int(sys.argv[2]))])\n",
            ),
            (
                "items/add/tests.toml",
                "[[example]]\ninput = \"1 2\"\noutput = \"3\"\n[[test]]\ninput = \"4\"\noutput = \"4\"\n",
            ),
        ];
        for (path, text) in files {
            let path = pack.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        pack
    }

    #[test]
    fn keeps_a_track_to_itself_with_limits_of_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let config = LearningConfig {
            packs: vec![kept_apart_pack(dir.path())],
            sample_pack: false,
            daily_reviews: 1,
            daily_new: 2,
            daily_lessons: 1,
            weekly_minutes: 1,
            desired_retention: 0.9,
        };
        let learning = Learning::open(&config, dir.path()).unwrap();
        let drill = TrackId::Pack("drill".parse().unwrap());
        let planned = learning.planned(clock(NOW)).unwrap();
        assert!(planned.problems.is_empty(), "{:?}", planned.problems);
        assert_eq!(planned.kept_apart, [drill.clone()].into());
        // Its own limit of new items, the same size as the rest's.
        assert_eq!(planned.plans[&drill].new, ["apart/add", "apart/one"]);
        assert_eq!(
            planned.plans[&drill].new_waiting,
            ["apart/read", "apart/three", "apart/two"]
        );
        assert_eq!(planned.plans[&TrackId::Review].new, ["apart/shared"]);

        // A long while on two of its cards: neither the week's minutes nor the rest's limit of
        // new items changes, but the track's own does.
        let mut long = attempt("1", "apart/one", NOW, Rating::Again);
        long.duration_ms = 4 * 60_000;
        learning
            .record(&[long, attempt("2", "apart/two", NOW, Rating::Again)], NOW)
            .unwrap();
        let later = clock(NOW + 20 * 60_000);
        let planned = learning.planned(later).unwrap();
        assert_eq!(planned.week.minutes, 0);
        assert_eq!(planned.plans[&TrackId::Review].new, ["apart/shared"]);
        assert!(planned.plans[&drill].new.is_empty());
        // Due again soon, as they were forgotten, and reviewed within the track's own limit.
        let next_day = clock(NOW + workshop_learning::schedule::DAY_MS);
        learning
            .record(&[attempt("3", "apart/shared", NOW, Rating::Again)], NOW)
            .unwrap();
        let planned = learning.planned(next_day).unwrap();
        assert_eq!(planned.plans[&drill].due.len(), 1);
        assert_eq!(planned.plans[&drill].waiting, 1);
        assert_eq!(planned.plans[&TrackId::Review].due, ["apart/shared"]);
        assert_eq!(planned.week.minutes, 0);

        // Offered when it's opened, but never by Continue, nor as a timed round.
        let tracks = learning.tracks(
            &planned,
            next_day,
            &BTreeMap::new(),
            &BTreeMap::new(),
            &BTreeMap::new(),
        );
        let track = tracks.tracks.iter().find(|t| t.id == drill).unwrap();
        assert!(!track.in_continue);
        assert_eq!(track.next.as_ref().unwrap().priority, Priority::Due);
        let review = tracks
            .tracks
            .iter()
            .find(|t| t.id == TrackId::Review)
            .unwrap();
        assert!(review.in_continue);
        let home = workshop_tracks::Home::new(
            tracks.tracks.into_iter().map(Some),
            workshop_tracks::Time::AWhile,
            None,
        )
        .unwrap();
        assert_eq!(home.next.unwrap().track, TrackId::Review);
        assert_eq!(crate::rounds::items(&planned).count(), 0);

        // The app is told, with what's been done in it, to plan as the server does offline.
        let deck = learning.deck(next_day).unwrap();
        let in_deck = deck.tracks.iter().find(|t| t.id == drill).unwrap();
        assert!(in_deck.kept_apart);
        let progress = in_deck.progress.unwrap();
        assert_eq!(progress.reviews_today, 0);
        assert_eq!(progress.minutes_this_week, 4);
        assert_eq!(deck.progress.minutes_this_week, 0);
        assert!(
            deck.tracks
                .iter()
                .filter(|t| t.id != drill)
                .all(|t| !t.kept_apart && t.progress.is_none())
        );
    }

    #[test]
    fn offers_a_tracks_coding_problems_from_the_track() {
        let dir = tempfile::tempdir().unwrap();
        let config = LearningConfig {
            packs: vec![kept_apart_pack(dir.path())],
            sample_pack: false,
            daily_reviews: 10,
            daily_new: 10,
            daily_lessons: 1,
            weekly_minutes: 60,
            desired_retention: 0.9,
        };
        let learning = Learning::open(&config, dir.path()).unwrap();
        let drill = TrackId::Pack("drill".parse().unwrap());
        let problems = crate::coding::Problems::new(dir.path());
        let packs = crate::packs::load(&config).unwrap();
        let found = crate::coding::find(&packs, "apart", "add").unwrap();
        // With nothing begun, the short items come first.
        let planned = learning.planned(clock(NOW)).unwrap();
        let tracks = learning.tracks(
            &planned,
            clock(NOW),
            &BTreeMap::new(),
            &BTreeMap::new(),
            &BTreeMap::new(),
        );
        let track = tracks.tracks.iter().find(|t| t.id == drill).unwrap();
        assert_eq!(
            track.next.as_ref().unwrap().destination,
            Destination::Practice {
                track: drill.clone()
            }
        );
        // A problem started is carried on with from the track, and isn't the Coding track's.
        problems.start(&found, &[], false, None, NOW).unwrap();
        let sessions = problems.started().unwrap();
        let tracks = learning.tracks(
            &planned,
            clock(NOW),
            &BTreeMap::new(),
            &sessions,
            &BTreeMap::new(),
        );
        let next = tracks
            .tracks
            .iter()
            .find(|t| t.id == drill)
            .unwrap()
            .next
            .clone()
            .unwrap();
        assert_eq!(next.priority, Priority::Unfinished);
        assert_eq!(
            next.destination,
            Destination::Coding {
                item: Some("apart/add".to_owned())
            }
        );
        assert_eq!(crate::coding::track(&planned, &sessions), None);
        let listed = crate::coding::overview(&planned, &sessions, &BTreeMap::new(), &drill);
        let keys: Vec<&str> = listed.items.iter().map(|item| item.key.as_str()).collect();
        assert_eq!(keys, ["apart/add", "apart/read"]);
        let config = crate::config::Config::parse("").unwrap();
        let opened = problems
            .open(
                &config,
                &found,
                problems.session(&found.key()).unwrap().unwrap(),
                &[],
            )
            .unwrap();
        assert_eq!(opened.track.id, drill);
        assert_eq!(opened.track.name, "Drill");
    }

    fn clock(now: i64) -> Clock {
        Clock {
            now,
            utc_offset_minutes: 0,
        }
    }

    fn tracks_at(learning: &Learning, clock: Clock) -> Tracks {
        let planned = learning.planned(clock).unwrap();
        learning.tracks(
            &planned,
            clock,
            &BTreeMap::new(),
            &BTreeMap::new(),
            &BTreeMap::new(),
        )
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
        // Every track with something to practise, so a track of problems alone has its name.
        let names: Vec<&str> = deck.tracks.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "Coding",
                "Probability",
                "System design",
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
        // The sample pack's Review track has a lesson waiting, so Continue offers it before new
        // cards, and the card linked to that lesson waits until the day after it's done.
        let next = review.next.as_ref().unwrap();
        assert_eq!(next.priority, Priority::New);
        assert_eq!(next.title, "How a binary heap works");
        assert_eq!(next.reason, "Lesson");
        assert_eq!(
            next.destination,
            Destination::Lesson {
                item: "sample/binary-heaps".to_owned()
            }
        );
        assert_eq!(review.summary, "1 lesson · 9 new");
        assert_eq!(
            tracks.week,
            Week {
                minutes: 0,
                target: 1
            }
        );

        // Once the lesson is done, it counts towards the week's minutes, its card still waits
        // until the next day, and Review offers its other new cards.
        learning
            .sync(
                &SyncRequest {
                    lesson_completions: vec![LessonCompletion {
                        id: "lesson-done-1".to_owned(),
                        lesson: "sample/binary-heaps".to_owned(),
                        completed_at: NOW,
                        duration_ms: 120_000,
                    }],
                    ..Default::default()
                },
                clock(NOW),
            )
            .unwrap();
        let same_day = tracks_at(&learning, clock(NOW + 1000));
        assert_eq!(same_day.week.minutes, 2);
        let review = same_day
            .tracks
            .iter()
            .find(|track| track.id == TrackId::Review)
            .unwrap();
        assert_eq!(review.summary, "9 new");
        assert_eq!(review.next.as_ref().unwrap().title, "9 new cards");

        // Two days later, the card answered today is due again, and the lesson's card has
        // unlocked.
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
        // Two minutes from the lesson plus forty seconds from the attempt = 2 minutes.
        assert_eq!(later.week.minutes, 2);
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
        assert_eq!(review.summary, "1 lesson · 8 new · 1 flagged");
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
        let tracks = learning.tracks(
            &planned,
            clock(NOW + 1),
            &BTreeMap::new(),
            &BTreeMap::new(),
            &BTreeMap::new(),
        );
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

    #[test]
    fn tracks_does_not_panic_when_every_item_in_a_track_has_a_follow_up() {
        let dir = tempfile::tempdir().unwrap();
        let pack = dir.path().join("single-pack");
        std::fs::create_dir_all(pack.join("items")).unwrap();
        std::fs::write(
            pack.join("pack.toml"),
            "id = \"solo\"\nname = \"Solo\"\n\n[[skills]]\nid = \"s\"\nname = \"S\"\n",
        )
        .unwrap();
        std::fs::write(
            pack.join("items/only.md"),
            "+++\nkind = \"card\"\nskills = [\"s\"]\n+++\nOnly question?\n\n## Answer\n\nOnly answer.\n",
        )
        .unwrap();
        let config = LearningConfig {
            packs: vec![pack],
            sample_pack: false,
            daily_reviews: 10,
            daily_new: 10,
            daily_lessons: 1,
            weekly_minutes: 60,
            desired_retention: 0.9,
        };
        let learning = Learning::open(&config, dir.path()).unwrap();
        let exchange = crate::follow_ups::Exchange {
            id: "ex-1".to_owned(),
            limit: workshop_pack::FollowUps::new(2).unwrap(),
            answer: crate::follow_ups::Said {
                text: "my answer".to_owned(),
                spoken: false,
                at: NOW,
            },
            questions: Vec::new(),
            attempts_before: 0,
            started_at: NOW,
            updated_at: NOW,
            marked: None,
        };
        learning.exchanges().put("solo/only", &exchange).unwrap();

        let tracks = tracks_at(&learning, clock(NOW));
        assert_eq!(tracks.tracks.len(), 1);
        let next = tracks.tracks[0]
            .next
            .as_ref()
            .expect("track should still offer the active follow-up");
        assert!(
            next.reason.to_lowercase().contains("follow")
                || next.title.to_lowercase().contains("follow")
                || matches!(next.destination, Destination::Practice { .. }),
            "unexpected next step: {next:?}"
        );
    }

    #[test]
    fn leaves_lessons_out_of_deck_mastery_and_rounds() {
        let dir = tempfile::tempdir().unwrap();
        let learning = learning(dir.path());
        let deck = learning.deck(clock(NOW)).unwrap();
        assert!(
            deck.items
                .iter()
                .all(|item| item.key != "sample/binary-heaps")
        );

        let planned = learning.planned(clock(NOW)).unwrap();
        assert!(planned.item("sample/binary-heaps").is_some());
        for plan in planned.plans.values() {
            assert!(!plan.due.iter().any(|k| k == "sample/binary-heaps"));
            assert!(!plan.new.iter().any(|k| k == "sample/binary-heaps"));
        }
        assert!(crate::rounds::items(&planned).all(|(key, _)| key != "sample/binary-heaps"));

        // A pack with only a lesson has no practised items, so no tracks and zero mastery items.
        let lesson_only = dir.path().join("lesson-only");
        std::fs::create_dir_all(lesson_only.join("items")).unwrap();
        std::fs::write(
            lesson_only.join("pack.toml"),
            "id = \"only\"\nname = \"Only\"\n[[skills]]\nid = \"s\"\nname = \"S\"\n",
        )
        .unwrap();
        std::fs::write(
            lesson_only.join("items/intro.md"),
            "+++\nkind = \"lesson\"\nskills = [\"s\"]\n[[sources]]\ntitle = \"Ref\"\nurl = \"https://example.com\"\n+++\nIntro.\n## One\nText.\n## Explain\nWhy?\n## Explain answer\nBecause.\n",
        )
        .unwrap();
        let only_learning = Learning::open(
            &LearningConfig {
                packs: vec![lesson_only],
                sample_pack: false,
                daily_reviews: 10,
                daily_new: 10,
                daily_lessons: 1,
                weekly_minutes: 60,
                desired_retention: 0.9,
            },
            &dir.path().join("only-data"),
        )
        .unwrap();
        assert!(only_learning.deck(clock(NOW)).unwrap().items.is_empty());
        assert_eq!(only_learning.deck(clock(NOW)).unwrap().lessons.len(), 1);
        assert!(only_learning.skill_mastery(clock(NOW)).unwrap().is_empty());
        assert!(only_learning.planned(clock(NOW)).unwrap().names.is_empty());
    }

    #[test]
    fn includes_lessons_with_images_and_syncs_completions() {
        let dir = tempfile::tempdir().unwrap();
        let pack = dir.path().join("pack");
        std::fs::create_dir_all(pack.join("items/lessons/first")).unwrap();
        std::fs::create_dir_all(pack.join("items/lessons/second")).unwrap();
        std::fs::write(
            pack.join("pack.toml"),
            "id = \"p\"\nname = \"P\"\n[[skills]]\nid = \"s\"\nname = \"S\"\n",
        )
        .unwrap();
        // Minimal valid 1x1 PNG header + bytes.
        let png_bytes = b"\x89PNG\r\n\x1a\nfake";
        std::fs::write(pack.join("items/lessons/first/pic.png"), png_bytes).unwrap();
        std::fs::write(
            pack.join("items/lessons/first/diagram.svg"),
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" stroke="currentColor"/></svg>"#,
        )
        .unwrap();
        std::fs::write(
            pack.join("items/lessons/first/item.md"),
            "+++\nkind = \"lesson\"\ntitle = \"First\"\nskills = [\"s\"]\n[[sources]]\ntitle = \"Docs\"\nurl = \"https://example.com\"\n+++\nSummary.\n## One\nText.\n\n![A svg](diagram.svg)\n\n![A png](pic.png)\n## Explain\nWhy?\n## Explain answer\nBecause.\n",
        )
        .unwrap();
        std::fs::write(
            pack.join("items/lessons/second/item.md"),
            "+++\nkind = \"lesson\"\ntitle = \"Second\"\nskills = [\"s\"]\nrequires = [\"first\"]\n[[sources]]\ntitle = \"Docs\"\nurl = \"https://example.com\"\n+++\nSummary two.\n## One\nText.\n## Explain\nWhy?\n## Explain answer\nBecause.\n",
        )
        .unwrap();

        let learning = Learning::open(
            &LearningConfig {
                packs: vec![pack],
                sample_pack: false,
                daily_reviews: 10,
                daily_new: 10,
                daily_lessons: 1,
                weekly_minutes: 60,
                desired_retention: 0.9,
            },
            &dir.path().join("data"),
        )
        .unwrap();

        let deck = learning.deck(clock(NOW)).unwrap();
        assert_eq!(deck.lessons.len(), 2);
        let first = deck.lessons.iter().find(|l| l.key == "p/first").unwrap();
        assert!(matches!(
            first.images.get("diagram.svg"),
            Some(DeckLessonImage::Svg { svg }) if svg.contains("<svg")
        ));
        let expected_png = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png_bytes)
        );
        assert!(matches!(
            first.images.get("pic.png"),
            Some(DeckLessonImage::Png { data_url }) if data_url == &expected_png
        ));
        let second = deck.lessons.iter().find(|l| l.key == "p/second").unwrap();
        assert_eq!(second.requires, vec!["p/first"]);
        assert!(deck.lesson_completions.is_empty());

        let c1 = LessonCompletion {
            id: "lesson-done-1".to_owned(),
            lesson: "p/first".to_owned(),
            completed_at: NOW - 1000,
            duration_ms: 90_000,
        };
        let c2 = LessonCompletion {
            id: "lesson-done-2".to_owned(),
            lesson: "p/first".to_owned(),
            completed_at: NOW,
            duration_ms: 60_000,
        };
        let synced = learning
            .sync(
                &SyncRequest {
                    lesson_completions: vec![c1.clone(), c2.clone()],
                    ..Default::default()
                },
                clock(NOW),
            )
            .unwrap();
        assert_eq!(
            synced.lesson_completions.get("p/first"),
            Some(&vec![NOW - 1000, NOW])
        );
        // Re-sending the same completions is idempotent.
        let again = learning
            .sync(
                &SyncRequest {
                    lesson_completions: vec![c1],
                    ..Default::default()
                },
                clock(NOW),
            )
            .unwrap();
        assert_eq!(
            again.lesson_completions.get("p/first"),
            Some(&vec![NOW - 1000, NOW])
        );
    }
}
