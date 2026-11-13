//! Tracks: the strands of learning Workshop offers, such as Advent of Code, Coding or Review,
//! and the home screen's choice of what to do next.
//!
//! Each track says what's in it and the step it would suggest, or nothing if it's empty. Where a
//! step leads is up to whoever builds the home screen, as `D`: this crate only needs to pass it
//! along.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

/// Which track something belongs to. Built-in tracks are listed in the order the home screen
/// shows them; tracks a pack defines come after them.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub enum TrackId {
    AdventOfCode,
    Coding,
    Probability,
    SystemDesign,
    MentalMaths,
    Review,
    /// A track a pack defines.
    Pack(PackTrackId),
}

/// The prefix that keeps a pack's track IDs apart from the built-in ones.
const PACK_PREFIX: &str = "pack:";

const BUILT_IN: &[(TrackId, &str, &str)] = &[
    (TrackId::AdventOfCode, "advent-of-code", "Advent of Code"),
    (TrackId::Coding, "coding", "Coding"),
    (TrackId::Probability, "probability", "Probability"),
    (TrackId::SystemDesign, "system-design", "System design"),
    (TrackId::MentalMaths, "mental-maths", "Mental maths"),
    (TrackId::Review, "review", "Review"),
];

impl TrackId {
    /// A built-in track's name, as the app shows it. A pack names its own tracks.
    pub fn built_in_name(&self) -> Option<&'static str> {
        BUILT_IN
            .iter()
            .find(|(id, _, _)| id == self)
            .map(|(_, _, name)| *name)
    }
}

impl fmt::Display for TrackId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Pack(id) => write!(f, "{PACK_PREFIX}{}", id.0),
            built_in => {
                let (_, slug, _) = BUILT_IN
                    .iter()
                    .find(|(id, _, _)| id == built_in)
                    .expect("every built-in track is listed in BUILT_IN");
                f.write_str(slug)
            }
        }
    }
}

impl FromStr for TrackId {
    type Err = TrackError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        if let Some(id) = text.strip_prefix(PACK_PREFIX) {
            return id.parse().map(Self::Pack);
        }
        BUILT_IN
            .iter()
            .find(|(_, slug, _)| *slug == text)
            .map(|(id, _, _)| id.clone())
            .ok_or_else(|| TrackError::UnknownTrack(text.to_owned()))
    }
}

impl TryFrom<String> for TrackId {
    type Error = TrackError;

    fn try_from(text: String) -> Result<Self, Self::Error> {
        text.parse()
    }
}

impl From<TrackId> for String {
    fn from(id: TrackId) -> Self {
        id.to_string()
    }
}

/// A track's ID within its pack: lowercase letters and digits, in words joined by hyphens, such
/// as `graph-search`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PackTrackId(String);

impl FromStr for PackTrackId {
    type Err = TrackError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let valid = !text.is_empty()
            && text.split('-').all(|word| {
                !word.is_empty()
                    && word
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            });
        if valid {
            Ok(Self(text.to_owned()))
        } else {
            Err(TrackError::InvalidPackTrack(text.to_owned()))
        }
    }
}

impl PackTrackId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TrackError {
    #[error("there's no track called {0:?}")]
    UnknownTrack(String),
    #[error(
        "{0:?} can't be a pack's track ID: use lowercase letters and digits, in words joined by hyphens"
    )]
    InvalidPackTrack(String),
    #[error("the {0} track is listed twice")]
    DuplicateTrack(TrackId),
}

/// How soon a step should be done, which decides what Continue picks. Earlier comes first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Priority {
    /// Due now, such as reviews whose time has come.
    Due,
    /// Started and not finished, such as a problem part-way through.
    Unfinished,
    /// Something new that's ready to start.
    New,
    /// Nothing in particular: the track itself, to choose from.
    Browse,
}

/// Something to do next in a track.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Step<D> {
    /// What it is, such as "2025 · day 3".
    pub title: String,
    /// Why it's suggested, such as "Where you left off".
    pub reason: String,
    pub priority: Priority,
    /// Where doing it starts.
    pub destination: D,
}

/// A track as the home screen lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Track<D> {
    pub id: TrackId,
    pub name: String,
    /// A line about where the learner is in it.
    pub summary: String,
    /// Where opening the track leads.
    pub destination: D,
    /// The step this track suggests, if it has one.
    pub next: Option<Step<D>>,
}

impl<D> Track<D> {
    /// A built-in track, under its own name.
    pub fn built_in(id: TrackId, summary: String, destination: D, next: Option<Step<D>>) -> Self {
        let name = id
            .built_in_name()
            .expect("only built-in tracks are made with Track::built_in")
            .to_owned();
        Self {
            id,
            name,
            summary,
            destination,
            next,
        }
    }
}

/// The step Continue takes, and the track it's in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Next<D> {
    pub track: TrackId,
    #[serde(flatten)]
    pub step: Step<D>,
}

/// The home screen: one step to continue with, and the tracks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Home<D> {
    #[serde(rename = "continue")]
    pub next: Option<Next<D>>,
    pub tracks: Vec<Track<D>>,
}

impl<D: Clone> Home<D> {
    /// The home screen for these tracks, where `None` is a track with nothing in it yet, which
    /// isn't shown. Continue takes the most pressing step any track suggests; between steps as
    /// pressing as each other, the track listed first.
    pub fn new(tracks: impl IntoIterator<Item = Option<Track<D>>>) -> Result<Self, TrackError> {
        let mut tracks: Vec<Track<D>> = tracks.into_iter().flatten().collect();
        tracks.sort_by(|a, b| a.id.cmp(&b.id));
        if let Some(pair) = tracks.windows(2).find(|pair| pair[0].id == pair[1].id) {
            return Err(TrackError::DuplicateTrack(pair[0].id.clone()));
        }
        let next = tracks
            .iter()
            .filter_map(|track| track.next.as_ref().map(|step| (track, step)))
            .min_by_key(|(_, step)| step.priority)
            .map(|(track, step)| Next {
                track: track.id.clone(),
                step: step.clone(),
            });
        Ok(Self { next, tracks })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(title: &str, priority: Priority) -> Step<&'static str> {
        Step {
            title: title.to_owned(),
            reason: String::new(),
            priority,
            destination: "somewhere",
        }
    }

    fn track(id: TrackId, next: Option<Step<&'static str>>) -> Option<Track<&'static str>> {
        Some(Track {
            name: id.to_string(),
            id,
            summary: String::new(),
            destination: "the track",
            next,
        })
    }

    #[test]
    fn writes_and_reads_track_ids() {
        for (id, text) in [
            (TrackId::AdventOfCode, "advent-of-code"),
            (TrackId::SystemDesign, "system-design"),
            (TrackId::MentalMaths, "mental-maths"),
            (
                TrackId::Pack("graph-search".parse().unwrap()),
                "pack:graph-search",
            ),
        ] {
            assert_eq!(id.to_string(), text);
            assert_eq!(text.parse::<TrackId>().unwrap(), id);
            assert_eq!(serde_json::to_string(&id).unwrap(), format!("\"{text}\""));
        }
        assert!("chess".parse::<TrackId>().is_err());
        assert!(serde_json::from_str::<TrackId>("\"chess\"").is_err());
    }

    #[test]
    fn checks_pack_track_ids() {
        for id in ["graphs", "graph-search", "week-2"] {
            assert!(id.parse::<PackTrackId>().is_ok(), "{id}");
        }
        for id in [
            "",
            "Graphs",
            "graph search",
            "-graphs",
            "graphs-",
            "a--b",
            "a/b",
        ] {
            assert!(id.parse::<PackTrackId>().is_err(), "{id:?}");
        }
        assert!("pack:".parse::<TrackId>().is_err());
    }

    #[test]
    fn names_built_in_tracks() {
        assert_eq!(
            TrackId::AdventOfCode.built_in_name(),
            Some("Advent of Code")
        );
        assert_eq!(TrackId::SystemDesign.built_in_name(), Some("System design"));
        assert_eq!(
            TrackId::Pack("graphs".parse().unwrap()).built_in_name(),
            None
        );
    }

    #[test]
    fn lists_tracks_in_order_leaving_out_empty_ones() {
        let pack = TrackId::Pack("graphs".parse().unwrap());
        let home = Home::new([
            track(pack.clone(), None),
            track(TrackId::Review, None),
            None,
            track(TrackId::AdventOfCode, None),
        ])
        .unwrap();
        let ids: Vec<TrackId> = home.tracks.iter().map(|t| t.id.clone()).collect();
        assert_eq!(ids, [TrackId::AdventOfCode, TrackId::Review, pack]);
        assert_eq!(home.next, None);
    }

    #[test]
    fn continues_with_the_most_pressing_step() {
        let home = Home::new([
            track(
                TrackId::AdventOfCode,
                Some(step("puzzle", Priority::Unfinished)),
            ),
            track(TrackId::Coding, Some(step("new problem", Priority::New))),
            track(TrackId::Review, Some(step("cards", Priority::Due))),
        ])
        .unwrap();
        let next = home.next.unwrap();
        assert_eq!(next.track, TrackId::Review);
        assert_eq!(next.step.title, "cards");
    }

    #[test]
    fn breaks_ties_by_the_order_tracks_are_listed() {
        let home = Home::new([
            track(TrackId::Probability, Some(step("later", Priority::New))),
            track(TrackId::Coding, Some(step("first", Priority::New))),
        ])
        .unwrap();
        assert_eq!(home.next.unwrap().track, TrackId::Coding);
    }

    #[test]
    fn refuses_a_track_listed_twice() {
        let err =
            Home::new([track(TrackId::Coding, None), track(TrackId::Coding, None)]).unwrap_err();
        assert_eq!(err, TrackError::DuplicateTrack(TrackId::Coding));
    }

    #[test]
    fn says_where_to_continue_alongside_the_step() {
        let home = Home::new([track(
            TrackId::AdventOfCode,
            Some(step("2025 · day 3", Priority::Unfinished)),
        )])
        .unwrap();
        let json = serde_json::to_value(&home).unwrap();
        assert_eq!(json["continue"]["track"], "advent-of-code");
        assert_eq!(json["continue"]["title"], "2025 · day 3");
        assert_eq!(json["continue"]["priority"], "unfinished");
        assert_eq!(json["continue"]["destination"], "somewhere");
        assert_eq!(json["tracks"][0]["id"], "advent-of-code");
    }
}
