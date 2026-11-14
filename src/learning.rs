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

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use workshop_learning::{
    Attempt, Clock, Flag, FlagChange, ItemRef, ItemSchedule, Limits, Progress, SkillMastery, Store,
    TrackPlan,
};
use workshop_pack::number::Tolerance;
use workshop_pack::{Content, Item, Pack};
use workshop_tracks::{Priority, Step, Track, TrackId};

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
    pub skills: Vec<DeckSkill>,
    /// What's wrong in the packs, which is left out.
    pub problems: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct DeckTrack {
    pub id: TrackId,
    pub name: String,
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

    fn limits(&self) -> Limits {
        Limits {
            daily_reviews: self.config.daily_reviews,
            weekly_minutes: self.config.weekly_minutes,
            retention: self.config.desired_retention,
        }
    }

    fn progress(&self, clock: Clock) -> Result<Progress> {
        let today = self.store.activity(clock.day_start())?;
        let week = self.store.activity(clock.week_start())?;
        Ok(Progress {
            reviews_today: today.reviews,
            minutes_this_week: (week.ms / 60_000) as u32,
        })
    }

    pub fn deck(&self, clock: Clock) -> Result<Deck> {
        let packs = crate::packs::load(&self.config)?;
        let shorts = shorts(&packs);
        let counts = self.store.attempt_counts()?;
        let schedules = self.store.schedules()?;
        let items = shorts
            .iter()
            .map(|short| deck_item(short, counts.get(&short.key).copied().unwrap_or(0)))
            .collect::<Result<Vec<_>>>()?;
        let refs = item_refs(&shorts);
        let mastery =
            workshop_learning::mastery(&refs, &schedules, self.store.scheduler(), clock.now);
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
            .map(|(id, name)| DeckTrack { id, name })
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
            skills,
            problems: problems(&packs),
        })
    }

    /// Records what a device did, then gives it the deck as it now is. Sending the same
    /// attempts again changes nothing.
    pub fn sync(&self, request: &SyncRequest, clock: Clock) -> Result<Deck> {
        self.store.record(&request.attempts, clock.now)?;
        self.store.record_flags(&request.flags)?;
        self.deck(clock)
    }

    /// What's due and new in every track, as one plan, with the packs it was made from.
    pub fn planned(&self, clock: Clock) -> Result<Planned> {
        let packs = crate::packs::load(&self.config)?;
        let items = practised(&packs);
        let refs = item_refs(&items);
        let progress = self.progress(clock)?;
        let limits = self.limits();
        let plans = workshop_learning::plan(
            &refs,
            &self.store.schedules()?,
            &self.store.flags()?,
            progress,
            limits,
            self.store.scheduler(),
            clock.now,
        );
        let names = track_names(&packs, &items);
        Ok(Planned {
            week: Week {
                minutes: progress.minutes_this_week,
                target: limits.weekly_minutes,
            },
            problems: problems(&packs),
            plans,
            names,
            packs,
        })
    }

    /// The tracks of short items, from a plan. The Coding track, whose problems are worked on
    /// over several steps, is the coding module's.
    pub fn tracks(&self, planned: &Planned, clock: Clock) -> Tracks {
        let tracks = planned
            .names
            .iter()
            .filter(|(id, _)| **id != TrackId::Coding)
            .map(|(id, name)| {
                let plan = &planned.plans[id];
                Track {
                    summary: summary(plan, clock),
                    destination: Destination::Practice { track: id.clone() },
                    next: next_step(id, plan, planned.week),
                    id: id.clone(),
                    name: name.clone(),
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
    pub plans: BTreeMap<TrackId, TrackPlan>,
    /// Each track with items in it, and its name.
    pub names: BTreeMap<TrackId, String>,
    pub week: Week,
    pub problems: Vec<String>,
}

fn shorts(packs: &[Pack]) -> Vec<Short<'_>> {
    items_where(packs, |item| item.kind.is_short())
}

/// The items there's practice of: the short ones, and coding problems.
fn practised(packs: &[Pack]) -> Vec<Short<'_>> {
    items_where(packs, |item| {
        item.kind.is_short() || item.kind == workshop_pack::Kind::Coding
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
/// names. Two packs' tracks with the same id are one track.
fn track_names(packs: &[Pack], shorts: &[Short<'_>]) -> BTreeMap<TrackId, String> {
    shorts
        .iter()
        .map(|short| {
            let id = short.item.track.clone();
            let name = match &id {
                TrackId::Pack(pack_track) => packs
                    .iter()
                    .flat_map(|pack| &pack.manifest.tracks)
                    .find(|track| track.id == *pack_track)
                    .map(|track| track.name.clone())
                    .expect("an item's pack track is checked to be in its pack"),
                built_in => built_in
                    .built_in_name()
                    .expect("every other track is built in")
                    .to_owned(),
            };
            (id, name)
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

fn week_so_far(week: Week) -> String {
    let minutes = if week.target == 1 {
        "minute"
    } else {
        "minutes"
    };
    if week.minutes >= week.target {
        format!("This week's {} {minutes} done", week.target)
    } else {
        format!("{} of {} {minutes} this week", week.minutes, week.target)
    }
}

fn next_step(id: &TrackId, plan: &TrackPlan, week: Week) -> Option<Step<Destination>> {
    let destination = Destination::Practice { track: id.clone() };
    if !plan.due.is_empty() {
        return Some(Step {
            title: format!("{} due", count(plan.due.len(), "", id)),
            reason: format!("Due today · {}", week_so_far(week)),
            priority: Priority::Due,
            destination,
        });
    }
    if !plan.new.is_empty() {
        // Once the week's target is met, new items wait behind anything else to do.
        let priority = if week.minutes >= week.target {
            Priority::Browse
        } else {
            Priority::New
        };
        return Some(Step {
            title: count(plan.new.len(), "new ", id),
            reason: format!("Something new · {}", week_so_far(week)),
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
    if !plan.new.is_empty() {
        parts.push(format!("{} new", plan.new.len()));
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
            daily_reviews: 3,
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
        learning.tracks(&planned, clock)
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
        assert_eq!(deck.items.len(), 34);
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
                },
                clock(NOW),
            )
            .unwrap();
        assert!(deck.flags.is_empty());
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
        assert!(next.reason.contains("This week's 1 minute done"));
    }
}
