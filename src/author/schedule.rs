//! Running the author on a schedule from the server, as `every` and `after` under `[author]`
//! say: for each pack of the learner's own in turn, keeping when it last started in the
//! author's files, so a restart neither runs it again nor skips a run, and telling devices how
//! each run went.

use std::fmt;
use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{Result, bail};
use jiff::Timestamp;
use jiff::tz::TimeZone;
use serde::{Deserialize, Serialize};
use workshop_pack::Pack;

use super::{Desk, LastRun, run};
use crate::config::Config;
use crate::learning::Learning;
use crate::paths::Paths;

const HOUR_MS: i64 = 60 * 60 * 1000;
const DAY_MS: i64 = 24 * HOUR_MS;

/// The longest the scheduler sleeps before looking again, so a clock that changes or a computer
/// that sleeps doesn't delay a run by much.
const LONGEST_WAIT: Duration = Duration::from_secs(15 * 60);

/// How long to wait before trying again when a run is already going, from the app or the
/// command.
const BUSY_WAIT: Duration = Duration::from_secs(60);

/// How often to run, as the config writes it: a whole number of hours, days or weeks, such as
/// `12h`, `7d` or `2w`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Every {
    count: u32,
    unit: Unit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Unit {
    Hours,
    Days,
    Weeks,
}

impl Every {
    pub fn ms(self) -> i64 {
        let unit = match self.unit {
            Unit::Hours => HOUR_MS,
            Unit::Days => DAY_MS,
            Unit::Weeks => 7 * DAY_MS,
        };
        i64::from(self.count) * unit
    }

    /// As the app says it, such as "every 7 days".
    pub fn describe(self) -> String {
        let (one, many) = match self.unit {
            Unit::Hours => ("hour", "hours"),
            Unit::Days => ("day", "days"),
            Unit::Weeks => ("week", "weeks"),
        };
        if self.count == 1 {
            format!("every {one}")
        } else {
            format!("every {} {many}", self.count)
        }
    }
}

impl FromStr for Every {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let wrong = || {
            format!(
                "{text:?} isn't how often to run: write a number of hours, days or weeks, such as \"12h\", \"7d\" or \"2w\""
            )
        };
        let Some(unit) = text.chars().last() else {
            return Err(wrong());
        };
        let count = &text[..text.len() - unit.len_utf8()];
        let unit = match unit {
            'h' => Unit::Hours,
            'd' => Unit::Days,
            'w' => Unit::Weeks,
            _ => return Err(wrong()),
        };
        let count: u32 = count.parse().map_err(|_| wrong())?;
        // At most a year, which also keeps the arithmetic far from overflowing.
        let every = Self { count, unit };
        if count == 0 || every.ms() > 366 * DAY_MS {
            return Err(format!("{text:?} should be from 1h to a year"));
        }
        Ok(every)
    }
}

impl TryFrom<String> for Every {
    type Error = String;

    fn try_from(text: String) -> Result<Self, Self::Error> {
        text.parse()
    }
}

impl From<Every> for String {
    fn from(every: Every) -> Self {
        every.to_string()
    }
}

impl fmt::Display for Every {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let unit = match self.unit {
            Unit::Hours => "h",
            Unit::Days => "d",
            Unit::Weeks => "w",
        };
        write!(f, "{}{unit}", self.count)
    }
}

/// A time of day on this computer's clock, as `HH:MM`, such as `02:00`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct TimeOfDay {
    hour: i8,
    minute: i8,
}

impl FromStr for TimeOfDay {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let wrong =
            || format!("{text:?} isn't a time of day: write it as HH:MM, such as \"02:00\"");
        let (hour, minute) = text.split_once(':').ok_or_else(wrong)?;
        if hour.len() != 2 || minute.len() != 2 {
            return Err(wrong());
        }
        let hour: i8 = hour.parse().map_err(|_| wrong())?;
        let minute: i8 = minute.parse().map_err(|_| wrong())?;
        if !(0..24).contains(&hour) || !(0..60).contains(&minute) {
            return Err(wrong());
        }
        Ok(Self { hour, minute })
    }
}

impl TryFrom<String> for TimeOfDay {
    type Error = String;

    fn try_from(text: String) -> Result<Self, Self::Error> {
        text.parse()
    }
}

impl From<TimeOfDay> for String {
    fn from(time: TimeOfDay) -> Self {
        time.to_string()
    }
}

impl fmt::Display for TimeOfDay {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:02}:{:02}", self.hour, self.minute)
    }
}

/// When the scheduled run after `last`, the latest run's start, is due, in milliseconds since
/// 1970.
///
/// Without a time of day, it's `every` after the last run, or now if there hasn't been one.
/// With one, it's the first time the clock shows it once `every` has nearly passed, so a run
/// that started late, such as after the computer woke, doesn't push every later run back; and
/// with no run yet, the next time the clock shows it.
pub fn next_run(
    every: Every,
    after: Option<TimeOfDay>,
    last: Option<i64>,
    now: i64,
    zone: &TimeZone,
) -> Result<i64> {
    let Some(after) = after else {
        return Ok(last.map_or(now, |last| last + every.ms()));
    };
    let from = match last {
        None => now,
        // Half a day early at most, so the time of day that's nearest `every` after it comes.
        Some(last) => last + every.ms() - (every.ms() / 2).min(12 * HOUR_MS),
    };
    let from = Timestamp::from_millisecond(from)?.to_zoned(zone.clone());
    let on = |day: &jiff::Zoned| {
        day.with()
            .hour(after.hour)
            .minute(after.minute)
            .second(0)
            .subsec_nanosecond(0)
            .build()
    };
    let mut at = on(&from)?;
    if at < from {
        at = on(&from.tomorrow()?)?;
    }
    Ok(at.timestamp().as_millisecond())
}

/// What the scheduler keeps between runs, in the author's files.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Kept {
    /// When the scheduler last started a run.
    last_started_at: Option<i64>,
}

const KEPT: &str = "schedule.json";

/// When the next scheduled run is due, or None when the author isn't scheduled, or has no pack
/// of the learner's own to write for.
pub fn next_scheduled(config: &Config, desk: &Desk, now: i64) -> Result<Option<i64>> {
    let Some(every) = config.author.every else {
        return Ok(None);
    };
    if config.learning.packs.is_empty() {
        return Ok(None);
    }
    let kept: Kept = desk.read(KEPT)?;
    // A run from the app or the command counts too.
    let last = kept
        .last_started_at
        .into_iter()
        .chain(desk.last_run()?.map(|run| run.started_at))
        .max();
    next_run(every, config.author.after, last, now, &TimeZone::system()).map(Some)
}

/// What the scheduler found to do when it looked.
#[derive(Debug, PartialEq, Eq)]
pub enum Looked {
    /// Nothing is scheduled.
    Off,
    /// Not due yet: look again this much later.
    Wait(Duration),
    /// Another run was going, so this one waits.
    Busy,
    /// It ran, for these packs.
    Ran(Vec<String>),
}

/// The parts of the server a scheduled run needs.
pub struct Scheduler<'a> {
    pub config: &'a Config,
    pub paths: &'a Paths,
    pub learning: &'a Learning,
    pub desk: &'a Desk,
    pub notifier: Arc<workshop_push::Notifier>,
    /// Whether a run from the app is going, which the scheduler sets while it runs too.
    pub running: &'a AtomicBool,
}

impl Scheduler<'_> {
    /// Runs the author for each of the learner's packs if a run is due at `now`.
    pub async fn look(&self, now: i64) -> Result<Looked> {
        let Some(next) = next_scheduled(self.config, self.desk, now)? else {
            return Ok(Looked::Off);
        };
        if next > now {
            let wait = Duration::from_millis(u64::try_from(next - now).unwrap_or(0));
            return Ok(Looked::Wait(wait.min(LONGEST_WAIT)));
        }
        if self.running.swap(true, Ordering::SeqCst) {
            return Ok(Looked::Busy);
        }
        let ran = self.run_each(now).await;
        self.running.store(false, Ordering::SeqCst);
        ran
    }

    async fn run_each(&self, now: i64) -> Result<Looked> {
        // Whether the command is running it, which holds the author's lock.
        if self.desk.try_lock()?.is_none() {
            return Ok(Looked::Busy);
        }
        // Kept before running, so a restart part-way through doesn't start it again.
        self.desk.write(
            KEPT,
            &Kept {
                last_started_at: Some(now),
            },
        )?;
        let mut ran = Vec::new();
        for dir in &self.config.learning.packs {
            let (id, name) = match Pack::load(dir) {
                Ok(pack) => (pack.manifest.id, pack.manifest.name),
                Err(err) => {
                    let message = failed(&dir.display().to_string(), &format!("{err:#}"));
                    self.notifier.send_to_all(&message).await;
                    continue;
                }
            };
            tracing::info!("running the author for {name}, as scheduled");
            let message = match run(
                self.config,
                self.paths,
                self.learning,
                self.desk,
                self.notifier.clone(),
                Some(&id),
            )
            .await
            {
                Ok(last) => finished(&name, &last),
                Err(err) => failed(&name, &format!("{err:#}")),
            };
            self.notifier.send_to_all(&message).await;
            ran.push(id);
        }
        Ok(Looked::Ran(ran))
    }

    /// Looks for a run that's due for as long as the server runs.
    pub async fn run_forever(&self) {
        loop {
            let wait = match self.look(crate::learning::now_ms()).await {
                Ok(Looked::Off) => LONGEST_WAIT,
                Ok(Looked::Wait(wait)) => wait,
                Ok(Looked::Busy) => BUSY_WAIT,
                Ok(Looked::Ran(_)) => Duration::from_secs(1),
                Err(err) => {
                    tracing::warn!("running the author on its schedule: {err:#}");
                    LONGEST_WAIT
                }
            };
            tokio::time::sleep(wait).await;
        }
    }
}

/// Tells devices how a scheduled run went.
pub fn finished(pack: &str, last: &LastRun) -> workshop_push::Message {
    let Some(report) = &last.report else {
        return failed(
            pack,
            last.error
                .as_deref()
                .unwrap_or("it stopped without saying why"),
        );
    };
    let counts = [
        (report.accepted.len(), "added"),
        (report.queued.len(), "waiting for approval"),
        (report.dropped.len(), "left out"),
    ];
    let said: Vec<String> = counts
        .iter()
        .filter(|(count, _)| *count > 0)
        .map(|(count, what)| {
            let items = if *count == 1 { "item" } else { "items" };
            format!("{count} {items} {what}")
        })
        .collect();
    workshop_push::Message {
        title: format!("The author has topped up {pack}"),
        body: if said.is_empty() {
            "Nothing new this time.".to_owned()
        } else {
            format!("{}.", said.join(", "))
        },
        url: "/pack".to_owned(),
    }
}

/// Tells devices a scheduled run couldn't finish, and why, in short.
pub fn failed(pack: &str, error: &str) -> workshop_push::Message {
    const LONGEST: usize = 160;
    let first = error.lines().next().unwrap_or(error);
    let body = if first.chars().count() > LONGEST {
        let cut: String = first.chars().take(LONGEST - 1).collect();
        format!("{cut}…")
    } else {
        first.to_owned()
    };
    workshop_push::Message {
        title: format!("The author's run for {pack} failed"),
        body,
        url: "/pack".to_owned(),
    }
}

/// Checks `every` and `after` together, as the config is read.
pub fn check(every: Option<Every>, after: Option<TimeOfDay>) -> Result<()> {
    match (every, after) {
        (None, Some(_)) => bail!("[author] after needs every, to say how often to run"),
        (Some(every), Some(_)) if every.ms() < DAY_MS => {
            bail!("[author] after is a time of day, so every should be at least a day")
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use anyhow::Context;

    use super::*;

    fn at(text: &str) -> i64 {
        text.parse::<Timestamp>()
            .context(text.to_owned())
            .unwrap()
            .as_millisecond()
    }

    #[test]
    fn reads_how_often_and_when() {
        let every: Every = "7d".parse().unwrap();
        assert_eq!(every.ms(), 7 * DAY_MS);
        assert_eq!(every.describe(), "every 7 days");
        assert_eq!(every.to_string(), "7d");
        assert_eq!("1w".parse::<Every>().unwrap().describe(), "every week");
        assert_eq!("12h".parse::<Every>().unwrap().ms(), 12 * HOUR_MS);
        for bad in ["", "7", "d", "0d", "7m", "-1d", "1.5d", "400d"] {
            assert!(bad.parse::<Every>().is_err(), "{bad:?}");
        }
        assert_eq!(
            "02:30".parse::<TimeOfDay>().unwrap(),
            TimeOfDay {
                hour: 2,
                minute: 30
            }
        );
        for bad in ["2:30", "24:00", "02:60", "0230", "02:3a"] {
            assert!(bad.parse::<TimeOfDay>().is_err(), "{bad:?}");
        }
        assert!(check(None, Some("02:00".parse().unwrap())).is_err());
        assert!(check(Some("12h".parse().unwrap()), Some("02:00".parse().unwrap())).is_err());
        assert!(check(Some("1d".parse().unwrap()), Some("02:00".parse().unwrap())).is_ok());
    }

    #[test]
    fn runs_every_so_often_from_the_last_run() {
        let utc = TimeZone::UTC;
        let every: Every = "7d".parse().unwrap();
        let now = at("2026-11-14T10:00:00Z");
        // Nothing yet: straight away.
        assert_eq!(next_run(every, None, None, now, &utc).unwrap(), now);
        assert_eq!(
            next_run(every, None, Some(at("2026-11-10T09:00:00Z")), now, &utc).unwrap(),
            at("2026-11-17T09:00:00Z")
        );
    }

    #[test]
    fn waits_for_the_time_of_day_on_this_computers_clock() {
        // An hour ahead of UTC.
        let zone = TimeZone::fixed(jiff::tz::offset(1));
        let every: Every = "7d".parse().unwrap();
        let two = Some("02:00".parse().unwrap());
        let now = at("2026-11-14T10:00:00Z");
        // Nothing yet: the next 2am here, which is 1am UTC.
        assert_eq!(
            next_run(every, two, None, now, &zone).unwrap(),
            at("2026-11-15T01:00:00Z")
        );
        // A week after a run on time.
        assert_eq!(
            next_run(every, two, Some(at("2026-11-08T01:00:00Z")), now, &zone).unwrap(),
            at("2026-11-15T01:00:00Z")
        );
        // A run that started late, after the computer woke, doesn't move the next one later.
        assert_eq!(
            next_run(every, two, Some(at("2026-11-08T08:30:00Z")), now, &zone).unwrap(),
            at("2026-11-15T01:00:00Z")
        );
        // Daily, from a run on time.
        let daily: Every = "1d".parse().unwrap();
        assert_eq!(
            next_run(daily, two, Some(at("2026-11-14T01:00:00Z")), now, &zone).unwrap(),
            at("2026-11-15T01:00:00Z")
        );
    }

    #[test]
    fn says_how_a_run_went() {
        let written = |id: &str| workshop_author::Written {
            path: format!("items/{id}.md"),
            id: id.to_owned(),
            label: id.to_owned(),
            skills: Vec::new(),
            files: Default::default(),
            from_draft: None,
            transcript: Vec::new(),
            reason: None,
        };
        let last = |report: Option<workshop_author::Report>, error: Option<&str>| LastRun {
            started_at: 0,
            finished_at: 1,
            report,
            commit: None,
            error: error.map(str::to_owned),
        };
        let report = workshop_author::Report {
            accepted: vec![written("a"), written("b")],
            queued: vec![written("c")],
            ..Default::default()
        };
        let message = finished("My pack", &last(Some(report), None));
        assert_eq!(message.title, "The author has topped up My pack");
        assert_eq!(message.body, "2 items added, 1 item waiting for approval.");
        assert_eq!(message.url, "/pack");
        let nothing = finished("My pack", &last(Some(Default::default()), None));
        assert_eq!(nothing.body, "Nothing new this time.");
        let broken = finished("My pack", &last(None, Some("the writer timed out\nmore")));
        assert_eq!(broken.title, "The author's run for My pack failed");
        assert_eq!(broken.body, "the writer timed out");
        let long = failed("My pack", &"x".repeat(500));
        assert_eq!(long.body.chars().count(), 160);
    }

    #[test]
    fn rejects_empty_and_multibyte_utf8_intervals_without_panicking() {
        assert!("".parse::<Every>().is_err());
        assert!("7日".parse::<Every>().is_err());
        assert!("é".parse::<Every>().is_err());
    }
}
