//! What the learner has done, in SQLite: every attempt and every flag, as logs that are only
//! ever added to, and each item's schedule worked out from them.
//!
//! Attempts and flags carry ids made where they happened, so a device that sends them again,
//! such as when syncing is retried after a lost reply, changes nothing.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::mistakes::{Mistake, MistakeSource, NewMistake};
use crate::schedule::{ItemSchedule, Rating, Scheduler};

/// The longest an attempt counts for towards time spent, so one left open while the learner
/// does something else doesn't count as practice.
pub const MAX_ATTEMPT_MS: i64 = 5 * 60 * 1000;

/// One go at an item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attempt {
    /// Made by the device it happened on, unique to this attempt.
    pub id: String,
    /// The item, as `pack/item`.
    pub item: String,
    /// When it was answered, in milliseconds since 1970.
    pub answered_at: i64,
    /// How long it took.
    pub duration_ms: i64,
    pub rating: Rating,
    /// What the learner answered, for questions answered by typing.
    #[serde(default)]
    pub response: Option<String>,
    /// For a question made from a template, the seed it was made from.
    #[serde(default)]
    pub seed: Option<u64>,
}

/// Saying an item is wrong, or that it's been put right.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FlagChange {
    pub id: String,
    pub item: String,
    /// When, in milliseconds since 1970.
    pub at: i64,
    /// Whether the item is now flagged as wrong.
    pub flagged: bool,
    #[serde(default)]
    pub note: Option<String>,
}

/// An item flagged as wrong.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Flag {
    pub at: i64,
    pub note: Option<String>,
}

/// How much was done since a moment, such as the start of the day.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Activity {
    pub attempts: u32,
    /// Attempts at items that had been attempted before then, rather than new ones.
    pub reviews: u32,
    /// Items first attempted since then.
    pub new: u32,
    /// Time spent, counting each attempt for at most `MAX_ATTEMPT_MS`.
    pub ms: i64,
}

pub struct Store {
    connection: Mutex<Connection>,
    scheduler: Scheduler,
}

/// The schema's version, in SQLite's `user_version`.
const VERSION: i64 = 3;

const SCHEMA: &str = "
CREATE TABLE attempts (
    id TEXT PRIMARY KEY,
    item TEXT NOT NULL,
    answered_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    rating INTEGER NOT NULL,
    response TEXT,
    seed INTEGER,
    received_at INTEGER NOT NULL
);
CREATE INDEX attempts_by_item ON attempts (item, answered_at, id);
CREATE INDEX attempts_by_time ON attempts (answered_at);
CREATE TABLE flag_changes (
    id TEXT PRIMARY KEY,
    item TEXT NOT NULL,
    at INTEGER NOT NULL,
    flagged INTEGER NOT NULL,
    note TEXT
);
-- Worked out from the attempts, and kept to save replaying them all each time.
CREATE TABLE schedules (
    item TEXT PRIMARY KEY,
    stability REAL NOT NULL,
    difficulty REAL NOT NULL,
    stability_fast REAL NOT NULL,
    last_review INTEGER NOT NULL,
    reviews INTEGER NOT NULL,
    lapses INTEGER NOT NULL
);
";

/// What each version adds to the one before, from version 1.
const MIGRATIONS: &[&str] = &[
    "
-- Time spent on the steps of items done over several, such as coding problems, which counts
-- towards the week's minutes alongside the attempts'.
CREATE TABLE time_spent (
    id INTEGER PRIMARY KEY,
    item TEXT NOT NULL,
    at INTEGER NOT NULL,
    ms INTEGER NOT NULL
);
CREATE INDEX time_spent_by_time ON time_spent (at);
",
    "
-- The mistake log, with each mistake's suggested kind and the one the learner confirmed.
CREATE TABLE mistakes (
    id TEXT PRIMARY KEY,
    item TEXT NOT NULL,
    at INTEGER NOT NULL,
    source TEXT NOT NULL,
    attempt TEXT,
    detail TEXT NOT NULL,
    suggested TEXT,
    confirmed TEXT
);
CREATE INDEX mistakes_by_time ON mistakes (at);
",
];

/// The earliest an attempt can be from: anything before is a broken clock.
const EARLIEST: i64 = 1_577_836_800_000; // 2020-01-01

/// How far in the future an attempt may claim to be, for a device whose clock is fast.
const FUTURE_SLACK_MS: i64 = 2 * 24 * 60 * 60 * 1000;

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
        let connection =
            Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        Self::new(connection).with_context(|| format!("in {}", path.display()))
    }

    pub fn in_memory() -> Result<Self> {
        Self::new(Connection::open_in_memory()?)
    }

    fn new(connection: Connection) -> Result<Self> {
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "busy_timeout", 5000)?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version > VERSION {
            bail!(
                "it was written by a newer Workshop (schema {version}, where this one knows {VERSION}); update Workshop to use it"
            );
        }
        if version < VERSION {
            let transaction = connection.unchecked_transaction()?;
            if version == 0 {
                transaction.execute_batch(SCHEMA)?;
            }
            for migration in &MIGRATIONS[(version.max(1) - 1) as usize..] {
                transaction.execute_batch(migration)?;
            }
            transaction.pragma_update(None, "user_version", VERSION)?;
            transaction.commit()?;
        }
        Ok(Self {
            connection: Mutex::new(connection),
            scheduler: Scheduler::default(),
        })
    }

    fn connection(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.connection
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn scheduler(&self) -> &Scheduler {
        &self.scheduler
    }

    /// Adds attempts to the log, ignoring any already there, and updates the schedules of the
    /// items they're for. An attempt with the id of one already there but different in any
    /// other way is refused, along with the rest of the batch.
    pub fn record(&self, attempts: &[Attempt], now: i64) -> Result<()> {
        for attempt in attempts {
            validate_id(&attempt.id)?;
            if attempt.item.is_empty() {
                bail!("attempt {} isn't for any item", attempt.id);
            }
            if !(EARLIEST..=now + FUTURE_SLACK_MS).contains(&attempt.answered_at) {
                bail!(
                    "attempt {} says it was made at {}, which this device's clock can't be right about",
                    attempt.id,
                    attempt.answered_at
                );
            }
            if attempt.duration_ms < 0 {
                bail!("attempt {} took less than no time", attempt.id);
            }
        }
        let mut connection = self.connection();
        let transaction = connection.transaction()?;
        let mut touched = BTreeSet::new();
        for attempt in attempts {
            let existing: Option<Attempt> = transaction
                .query_row(
                    "SELECT id, item, answered_at, duration_ms, rating, response, seed
                     FROM attempts WHERE id = ?",
                    [&attempt.id],
                    row_to_attempt,
                )
                .optional()?;
            match existing {
                Some(existing) if existing == *attempt => continue,
                Some(_) => bail!(
                    "attempt {} was sent before with different details, so one of them is wrong",
                    attempt.id
                ),
                None => {}
            }
            transaction.execute(
                "INSERT INTO attempts
                 (id, item, answered_at, duration_ms, rating, response, seed, received_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    attempt.id,
                    attempt.item,
                    attempt.answered_at,
                    attempt.duration_ms,
                    attempt.rating.number(),
                    attempt.response,
                    attempt.seed.map(|seed| seed as i64),
                    now,
                ],
            )?;
            touched.insert(attempt.item.clone());
        }
        for item in touched {
            reschedule(&transaction, &self.scheduler, &item)?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// Adds flag changes to the log, ignoring any already there.
    pub fn record_flags(&self, changes: &[FlagChange]) -> Result<()> {
        for change in changes {
            validate_id(&change.id)?;
        }
        let mut connection = self.connection();
        let transaction = connection.transaction()?;
        for change in changes {
            let existing: Option<FlagChange> = transaction
                .query_row(
                    "SELECT id, item, at, flagged, note FROM flag_changes WHERE id = ?",
                    [&change.id],
                    |row| {
                        Ok(FlagChange {
                            id: row.get(0)?,
                            item: row.get(1)?,
                            at: row.get(2)?,
                            flagged: row.get(3)?,
                            note: row.get(4)?,
                        })
                    },
                )
                .optional()?;
            match existing {
                Some(existing) if existing == *change => continue,
                Some(_) => bail!(
                    "flag change {} was sent before with different details",
                    change.id
                ),
                None => {}
            }
            transaction.execute(
                "INSERT INTO flag_changes (id, item, at, flagged, note) VALUES (?, ?, ?, ?, ?)",
                params![
                    change.id,
                    change.item,
                    change.at,
                    change.flagged,
                    change.note
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// The items flagged as wrong now: those whose latest change flagged them.
    pub fn flags(&self) -> Result<BTreeMap<String, Flag>> {
        let connection = self.connection();
        let mut statement = connection
            .prepare("SELECT item, at, flagged, note FROM flag_changes ORDER BY item, at, id")?;
        let mut flags = BTreeMap::new();
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, bool>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?;
        for row in rows {
            let (item, at, flagged, note) = row?;
            if flagged {
                flags.insert(item, Flag { at, note });
            } else {
                flags.remove(&item);
            }
        }
        Ok(flags)
    }

    pub fn schedules(&self) -> Result<BTreeMap<String, ItemSchedule>> {
        let connection = self.connection();
        let mut statement = connection.prepare(
            "SELECT item, stability, difficulty, stability_fast, last_review, reviews, lapses
             FROM schedules",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                ItemSchedule {
                    stability: row.get::<_, f64>(1)? as f32,
                    difficulty: row.get::<_, f64>(2)? as f32,
                    stability_fast: row.get::<_, f64>(3)? as f32,
                    last_review: row.get(4)?,
                    reviews: row.get(5)?,
                    lapses: row.get(6)?,
                },
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Counts time spent on a step of an item done over several, such as a coding problem,
    /// towards the week's minutes. At most `MAX_ATTEMPT_MS` counts at a time.
    pub fn record_time(&self, item: &str, at: i64, ms: i64) -> Result<()> {
        if ms < 0 {
            bail!("less than no time was spent on {item}");
        }
        self.connection().execute(
            "INSERT INTO time_spent (item, at, ms) VALUES (?, ?, ?)",
            params![item, at, ms.min(MAX_ATTEMPT_MS)],
        )?;
        Ok(())
    }

    /// What was done from `since`, in milliseconds since 1970.
    pub fn activity(&self, since: i64) -> Result<Activity> {
        let connection = self.connection();
        let (attempts, reviews, new, ms) = connection.query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(EXISTS (
                        SELECT 1 FROM attempts b
                        WHERE b.item = a.item AND b.answered_at < ?1
                    )), 0),
                    COUNT(DISTINCT CASE WHEN NOT EXISTS (
                        SELECT 1 FROM attempts b
                        WHERE b.item = a.item AND b.answered_at < ?1
                    ) THEN a.item END),
                    COALESCE(SUM(MIN(a.duration_ms, ?2)), 0)
                        + (SELECT COALESCE(SUM(ms), 0) FROM time_spent WHERE at >= ?1)
             FROM attempts a WHERE a.answered_at >= ?1",
            params![since, MAX_ATTEMPT_MS],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        Ok(Activity {
            attempts,
            reviews,
            new,
            ms,
        })
    }

    /// How many attempts there have been at each item.
    pub fn attempt_counts(&self) -> Result<BTreeMap<String, u64>> {
        let connection = self.connection();
        let mut statement =
            connection.prepare("SELECT item, COUNT(*) FROM attempts GROUP BY item")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Adds mistakes to the log, ignoring any already there, so a mistake found again, such as
    /// from an attempt synced twice, is only logged once.
    pub fn record_mistakes(&self, mistakes: &[NewMistake]) -> Result<()> {
        for mistake in mistakes {
            if mistake.id.is_empty() || mistake.item.is_empty() {
                bail!("a mistake needs an id and an item");
            }
        }
        let mut connection = self.connection();
        let transaction = connection.transaction()?;
        for mistake in mistakes {
            transaction.execute(
                "INSERT OR IGNORE INTO mistakes (id, item, at, source, attempt, detail, suggested)
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
                params![
                    mistake.id,
                    mistake.item,
                    mistake.at,
                    mistake.source.as_str(),
                    mistake.attempt,
                    mistake.detail,
                    mistake.suggested,
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// Sets the kind of mistake the learner says a mistake was, or with `None` goes back to the
    /// suggestion. Fails if there's no such mistake.
    pub fn tag_mistake(&self, id: &str, error_type: Option<&str>) -> Result<()> {
        let changed = self.connection().execute(
            "UPDATE mistakes SET confirmed = ? WHERE id = ?",
            params![error_type, id],
        )?;
        if changed == 0 {
            bail!("there's no mistake {id:?}");
        }
        Ok(())
    }

    /// The mistakes made from `since`, the most recent first.
    pub fn mistakes(&self, since: i64) -> Result<Vec<Mistake>> {
        let connection = self.connection();
        let mut statement = connection.prepare(
            "SELECT id, item, at, source, attempt, detail, suggested, confirmed
             FROM mistakes WHERE at >= ? ORDER BY at DESC, id",
        )?;
        let rows = statement.query_map([since], |row| {
            let source: String = row.get(3)?;
            Ok(Mistake {
                mistake: NewMistake {
                    id: row.get(0)?,
                    item: row.get(1)?,
                    at: row.get(2)?,
                    source: MistakeSource::parse(&source).ok_or_else(|| {
                        rusqlite::Error::FromSqlConversionFailure(
                            3,
                            rusqlite::types::Type::Text,
                            format!("{source:?} isn't where a mistake can come from").into(),
                        )
                    })?,
                    attempt: row.get(4)?,
                    detail: row.get(5)?,
                    suggested: row.get(6)?,
                },
                confirmed: row.get(7)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Every attempt, at any item, in the order they were made.
    pub fn all_attempts(&self) -> Result<Vec<Attempt>> {
        let connection = self.connection();
        let mut statement = connection.prepare(
            "SELECT id, item, answered_at, duration_ms, rating, response, seed
             FROM attempts ORDER BY answered_at, id",
        )?;
        let rows = statement.query_map([], row_to_attempt)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Every attempt at an item, in the order they were made.
    pub fn attempts(&self, item: &str) -> Result<Vec<Attempt>> {
        let connection = self.connection();
        let mut statement = connection.prepare(
            "SELECT id, item, answered_at, duration_ms, rating, response, seed
             FROM attempts WHERE item = ? ORDER BY answered_at, id",
        )?;
        let rows = statement.query_map([item], row_to_attempt)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

fn validate_id(id: &str) -> Result<()> {
    let valid =
        (8..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !valid {
        bail!("{id:?} isn't an id: use 8 to 64 letters, digits and hyphens, such as a UUID");
    }
    Ok(())
}

fn row_to_attempt(row: &rusqlite::Row<'_>) -> rusqlite::Result<Attempt> {
    let rating: u32 = row.get(4)?;
    Ok(Attempt {
        id: row.get(0)?,
        item: row.get(1)?,
        answered_at: row.get(2)?,
        duration_ms: row.get(3)?,
        rating: Rating::from_number(rating).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                4,
                rusqlite::types::Type::Integer,
                format!("{rating} isn't a rating").into(),
            )
        })?,
        response: row.get(5)?,
        seed: row.get::<_, Option<i64>>(6)?.map(|seed| seed as u64),
    })
}

/// Works out an item's schedule again from all its attempts, which puts attempts that arrive
/// late, such as from a device that was offline, in their place.
fn reschedule(connection: &Connection, scheduler: &Scheduler, item: &str) -> Result<()> {
    let mut statement = connection.prepare(
        "SELECT answered_at, rating FROM attempts WHERE item = ? ORDER BY answered_at, id",
    )?;
    let attempts = statement
        .query_map([item], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, u32>(1)?))
        })?
        .map(|row| {
            let (at, rating) = row?;
            let rating =
                Rating::from_number(rating).with_context(|| format!("{rating} isn't a rating"))?;
            Ok((at, rating))
        })
        .collect::<Result<Vec<_>>>()?;
    let Some(schedule) = scheduler.replay(attempts) else {
        return Ok(());
    };
    connection.execute(
        "INSERT OR REPLACE INTO schedules
         (item, stability, difficulty, stability_fast, last_review, reviews, lapses)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
        params![
            item,
            f64::from(schedule.stability),
            f64::from(schedule.difficulty),
            f64::from(schedule.stability_fast),
            schedule.last_review,
            schedule.reviews,
            schedule.lapses,
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schedule::DAY_MS;

    const NOW: i64 = 1_790_000_000_000;

    fn attempt(id: &str, item: &str, answered_at: i64, rating: Rating) -> Attempt {
        Attempt {
            id: format!("attempt-{id}"),
            item: item.to_owned(),
            answered_at,
            duration_ms: 20_000,
            rating,
            response: None,
            seed: None,
        }
    }

    #[test]
    fn schedules_items_from_their_attempts() {
        let store = Store::in_memory().unwrap();
        store
            .record(
                &[
                    attempt("1", "sample/a", NOW - 3 * DAY_MS, Rating::Good),
                    attempt("2", "sample/a", NOW - DAY_MS, Rating::Good),
                    attempt("3", "sample/b", NOW, Rating::Again),
                ],
                NOW,
            )
            .unwrap();
        let schedules = store.schedules().unwrap();
        let scheduler = Scheduler::default();
        assert_eq!(
            schedules["sample/a"],
            scheduler
                .replay([
                    (NOW - 3 * DAY_MS, Rating::Good),
                    (NOW - DAY_MS, Rating::Good)
                ])
                .unwrap()
        );
        assert_eq!(schedules["sample/b"].reviews, 1);
    }

    #[test]
    fn ignores_an_attempt_sent_again() {
        let store = Store::in_memory().unwrap();
        let first = attempt("1", "sample/a", NOW, Rating::Good);
        store.record(std::slice::from_ref(&first), NOW).unwrap();
        store.record(&[first.clone(), first.clone()], NOW).unwrap();
        assert_eq!(
            store.attempts("sample/a").unwrap(),
            std::slice::from_ref(&first)
        );
        assert_eq!(store.schedules().unwrap()["sample/a"].reviews, 1);

        let changed = Attempt {
            rating: Rating::Again,
            ..first
        };
        let err = store.record(&[changed], NOW).unwrap_err();
        assert!(err.to_string().contains("different details"));
    }

    #[test]
    fn puts_attempts_that_arrive_late_in_their_place() {
        let store = Store::in_memory().unwrap();
        let latest = attempt("2", "sample/a", NOW, Rating::Good);
        store.record(std::slice::from_ref(&latest), NOW).unwrap();
        // From a device that was offline, made before the one already here.
        let earlier = attempt("1", "sample/a", NOW - 2 * DAY_MS, Rating::Again);
        store.record(std::slice::from_ref(&earlier), NOW).unwrap();
        let expected = Scheduler::default()
            .replay([(earlier.answered_at, Rating::Again), (NOW, Rating::Good)])
            .unwrap();
        assert_eq!(store.schedules().unwrap()["sample/a"], expected);
        assert_eq!(store.attempts("sample/a").unwrap(), [earlier, latest]);
    }

    #[test]
    fn refuses_attempts_it_cannot_trust() {
        let store = Store::in_memory().unwrap();
        let broken = [
            (
                Attempt {
                    id: "short".to_owned(),
                    ..attempt("1", "sample/a", NOW, Rating::Good)
                },
                "isn't an id",
            ),
            (attempt("1", "", NOW, Rating::Good), "any item"),
            (attempt("1", "sample/a", 0, Rating::Good), "clock"),
            (
                attempt("1", "sample/a", NOW + 10 * DAY_MS, Rating::Good),
                "clock",
            ),
            (
                Attempt {
                    duration_ms: -1,
                    ..attempt("1", "sample/a", NOW, Rating::Good)
                },
                "no time",
            ),
        ];
        for (attempt, expected) in broken {
            let err = store.record(&[attempt], NOW).unwrap_err().to_string();
            assert!(err.contains(expected), "{err}");
        }
        assert!(store.schedules().unwrap().is_empty());
    }

    #[test]
    fn counts_what_was_done_since_a_moment() {
        let store = Store::in_memory().unwrap();
        let mut long = attempt("3", "sample/b", NOW, Rating::Good);
        long.duration_ms = 60 * 60 * 1000;
        store
            .record(
                &[
                    attempt("1", "sample/a", NOW - 2 * DAY_MS, Rating::Good),
                    attempt("2", "sample/a", NOW, Rating::Good),
                    long,
                    attempt("4", "sample/b", NOW + 1, Rating::Good),
                ],
                NOW,
            )
            .unwrap();
        let today = store.activity(NOW - 1000).unwrap();
        assert_eq!(today.attempts, 3);
        // Only sample/a had been seen before today, and sample/b is new however many times
        // it's been attempted.
        assert_eq!(today.reviews, 1);
        assert_eq!(today.new, 1);
        assert_eq!(today.ms, 2 * 20_000 + MAX_ATTEMPT_MS);
        assert_eq!(store.activity(NOW + 2).unwrap(), Activity::default());

        // Time on the steps of a coding problem counts too, a little at a time.
        store.record_time("sample/islands", NOW, 90_000).unwrap();
        store
            .record_time("sample/islands", NOW + 10, 60 * 60 * 1000)
            .unwrap();
        assert!(store.record_time("sample/islands", NOW, -1).is_err());
        let later = store.activity(NOW - 1000).unwrap();
        assert_eq!(later.attempts, 3);
        assert_eq!(later.ms, 2 * 20_000 + 2 * MAX_ATTEMPT_MS + 90_000);
    }

    #[test]
    fn brings_an_older_log_up_to_date() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("learning.sqlite");
        {
            let connection = Connection::open(&path).unwrap();
            connection.execute_batch(SCHEMA).unwrap();
            connection.pragma_update(None, "user_version", 1).unwrap();
        }
        let store = Store::open(&path).unwrap();
        store.record_time("sample/islands", NOW, 1000).unwrap();
        assert_eq!(store.activity(NOW - 1).unwrap().ms, 1000);
        assert!(store.mistakes(0).unwrap().is_empty());
        drop(store);
        let version: i64 = Connection::open(&path)
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, VERSION);
    }

    #[test]
    fn logs_mistakes_once_and_keeps_the_learners_tag() {
        let store = Store::in_memory().unwrap();
        let mistake = |id: &str, at: i64| NewMistake {
            id: format!("attempt-{id}"),
            item: "sample/times-eleven".to_owned(),
            at,
            source: MistakeSource::Answer,
            attempt: Some(id.to_owned()),
            detail: "Answered 132; it's 121".to_owned(),
            suggested: Some("arithmetic-slip".to_owned()),
        };
        store
            .record_mistakes(&[mistake("1", NOW), mistake("2", NOW + 5)])
            .unwrap();
        store.record_mistakes(&[mistake("1", NOW)]).unwrap();
        let logged = store.mistakes(0).unwrap();
        assert_eq!(logged.len(), 2);
        // The most recent first.
        assert_eq!(logged[0].mistake.id, "attempt-2");
        assert_eq!(logged[1].error_type(), Some("arithmetic-slip"));

        store.tag_mistake("attempt-1", Some("misread")).unwrap();
        let logged = store.mistakes(NOW).unwrap();
        assert_eq!(logged[1].error_type(), Some("misread"));
        assert_eq!(logged[1].confirmed.as_deref(), Some("misread"));
        store.tag_mistake("attempt-1", None).unwrap();
        assert_eq!(
            store.mistakes(NOW).unwrap()[1].error_type(),
            Some("arithmetic-slip")
        );
        assert!(store.tag_mistake("attempt-9", Some("misread")).is_err());
        assert_eq!(store.mistakes(NOW + 1).unwrap().len(), 1);
    }

    #[test]
    fn keeps_the_latest_word_on_each_flag() {
        let store = Store::in_memory().unwrap();
        let change = |id: &str, item: &str, at: i64, flagged: bool| FlagChange {
            id: format!("flag-change-{id}"),
            item: item.to_owned(),
            at,
            flagged,
            note: None,
        };
        store
            .record_flags(&[
                change("1", "sample/a", NOW, true),
                change("2", "sample/b", NOW, true),
                change("3", "sample/b", NOW + 1, false),
            ])
            .unwrap();
        store
            .record_flags(&[change("1", "sample/a", NOW, true)])
            .unwrap();
        let flags = store.flags().unwrap();
        assert_eq!(flags.keys().collect::<Vec<_>>(), ["sample/a"]);
        assert!(
            store
                .record_flags(&[change("1", "sample/a", NOW, false)])
                .is_err()
        );
    }

    #[test]
    fn keeps_everything_across_opening_again() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data/learning.sqlite");
        Store::open(&path)
            .unwrap()
            .record(&[attempt("1", "sample/a", NOW, Rating::Good)], NOW)
            .unwrap();
        let store = Store::open(&path).unwrap();
        assert_eq!(store.attempts("sample/a").unwrap().len(), 1);
        assert_eq!(store.attempt_counts().unwrap()["sample/a"], 1);

        let connection = Connection::open(&path).unwrap();
        connection.pragma_update(None, "user_version", 99).unwrap();
        drop(connection);
        let err = Store::open(&path).err().unwrap();
        assert!(format!("{err:#}").contains("newer Workshop"));
    }
}
