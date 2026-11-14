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
    /// Timed rounds with the examiner, on items from the other tracks.
    Rounds,
    MentalMaths,
    Review,
    /// A track a pack defines.
    Pack(PackTrackId),
}

/// The prefix that keeps a pack's track IDs apart from the built-in ones.
const PACK_PREFIX: &str = "pack:";

const BUILT_IN: &[(TrackId, &str, &str, TrackIcon)] = &[
    (
        TrackId::AdventOfCode,
        "advent-of-code",
        "Advent of Code",
        TrackIcon::Star,
    ),
    (TrackId::Coding, "coding", "Coding", TrackIcon::Code),
    (
        TrackId::Probability,
        "probability",
        "Probability",
        TrackIcon::Dice,
    ),
    (
        TrackId::SystemDesign,
        "system-design",
        "System design",
        TrackIcon::Network,
    ),
    (TrackId::Rounds, "rounds", "Timed rounds", TrackIcon::Timer),
    (
        TrackId::MentalMaths,
        "mental-maths",
        "Mental maths",
        TrackIcon::Sigma,
    ),
    (TrackId::Review, "review", "Review", TrackIcon::History),
];

/// The small picture beside a track's name, to tell tracks apart at a glance. The app draws
/// each one, by name; a pack can give its own tracks any of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TrackIcon {
    Star,
    Code,
    Dice,
    Network,
    Timer,
    Sigma,
    History,
    /// Stacked layers: a pack's track's, unless it chooses another.
    Layers,
    Approximately,
    Book,
    Chart,
    Flask,
    Languages,
    Lightbulb,
    Puzzle,
    Radical,
    Shapes,
}

impl TrackIcon {
    /// Every icon, in the order the docs list them.
    pub const ALL: [TrackIcon; 17] = [
        Self::Star,
        Self::Code,
        Self::Dice,
        Self::Network,
        Self::Timer,
        Self::Sigma,
        Self::History,
        Self::Layers,
        Self::Approximately,
        Self::Book,
        Self::Chart,
        Self::Flask,
        Self::Languages,
        Self::Lightbulb,
        Self::Puzzle,
        Self::Radical,
        Self::Shapes,
    ];

    /// What a pack's track has when the pack doesn't choose.
    pub const PACK_DEFAULT: TrackIcon = Self::Layers;

    /// Its name, as `pack.toml` and the app write it.
    pub fn name(self) -> &'static str {
        match self {
            Self::Star => "star",
            Self::Code => "code",
            Self::Dice => "dice",
            Self::Network => "network",
            Self::Timer => "timer",
            Self::Sigma => "sigma",
            Self::History => "history",
            Self::Layers => "layers",
            Self::Approximately => "approximately",
            Self::Book => "book",
            Self::Chart => "chart",
            Self::Flask => "flask",
            Self::Languages => "languages",
            Self::Lightbulb => "lightbulb",
            Self::Puzzle => "puzzle",
            Self::Radical => "radical",
            Self::Shapes => "shapes",
        }
    }
}

impl FromStr for TrackIcon {
    type Err = TrackError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|icon| icon.name() == text)
            .ok_or_else(|| TrackError::UnknownIcon(text.to_owned()))
    }
}

impl TrackId {
    /// Whether a pack's items can be in it. Advent of Code's puzzles aren't a pack's, and timed
    /// rounds are made from the other tracks' items.
    pub fn holds_items(&self) -> bool {
        !matches!(self, Self::AdventOfCode | Self::Rounds)
    }

    /// A built-in track's name, as the app shows it. A pack names its own tracks.
    pub fn built_in_name(&self) -> Option<&'static str> {
        BUILT_IN
            .iter()
            .find(|(id, _, _, _)| id == self)
            .map(|(_, _, name, _)| *name)
    }

    /// A built-in track's icon. A pack chooses its own tracks'.
    pub fn built_in_icon(&self) -> Option<TrackIcon> {
        BUILT_IN
            .iter()
            .find(|(id, _, _, _)| id == self)
            .map(|(_, _, _, icon)| *icon)
    }
}

impl fmt::Display for TrackId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Pack(id) => write!(f, "{PACK_PREFIX}{}", id.0),
            built_in => {
                let (_, slug, _, _) = BUILT_IN
                    .iter()
                    .find(|(id, _, _, _)| id == built_in)
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
            .find(|(_, slug, _, _)| *slug == text)
            .map(|(id, _, _, _)| id.clone())
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
    #[error(
        "there's no icon called {0:?}: choose one of {icons}",
        icons = TrackIcon::ALL.map(TrackIcon::name).join(", ")
    )]
    UnknownIcon(String),
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
    /// Something new in a skill the learner has been making mistakes in lately.
    Focus,
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
    pub icon: TrackIcon,
    /// A line about where the learner is in it.
    pub summary: String,
    /// Where opening the track leads.
    pub destination: D,
    /// The step this track suggests, if it has one: a few minutes' worth.
    pub next: Option<Step<D>>,
    /// The long item this track suggests for when the learner has a while, such as a design
    /// session or a timed round, if it has one.
    pub long: Option<Step<D>>,
}

impl<D> Track<D> {
    /// A built-in track, under its own name.
    pub fn built_in(id: TrackId, summary: String, destination: D, next: Option<Step<D>>) -> Self {
        let name = id
            .built_in_name()
            .expect("only built-in tracks are made with Track::built_in")
            .to_owned();
        let icon = id
            .built_in_icon()
            .expect("every built-in track has an icon");
        Self {
            id,
            name,
            icon,
            summary,
            destination,
            next,
            long: None,
        }
    }

    /// The track, suggesting this long item for when the learner has a while.
    pub fn with_long(self, long: Option<Step<D>>) -> Self {
        Self { long, ..self }
    }
}

/// How long the learner has: what Continue may offer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Time {
    /// A few minutes, as usual: only steps of a few minutes each.
    #[default]
    Short,
    /// "I've got a while": long items too, such as timed rounds and design sessions.
    AWhile,
}

/// The step Continue takes, and the track it's in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Next<D> {
    pub track: TrackId,
    #[serde(flatten)]
    pub step: Step<D>,
    /// Whether it's a long item, only offered when the learner has a while.
    pub long: bool,
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
    ///
    /// Long items are only offered when the learner has a while, and then they come first,
    /// as that's what the learner asked for. One that's unfinished comes first of all. Otherwise
    /// they take turns, so neither design sessions nor timed rounds crowd out the other: the
    /// first track listed with a long item other than `last_long`, the track of the long item
    /// done last. How pressing each is otherwise, such as a round in a skill with recent
    /// mistakes, doesn't count, as each is a sitting's work whatever's in it. If no long item
    /// is more than something to browse, the usual step is better.
    pub fn new(
        tracks: impl IntoIterator<Item = Option<Track<D>>>,
        time: Time,
        last_long: Option<&TrackId>,
    ) -> Result<Self, TrackError> {
        let mut tracks: Vec<Track<D>> = tracks.into_iter().flatten().collect();
        tracks.sort_by(|a, b| a.id.cmp(&b.id));
        if let Some(pair) = tracks.windows(2).find(|pair| pair[0].id == pair[1].id) {
            return Err(TrackError::DuplicateTrack(pair[0].id.clone()));
        }
        let next = |track: &Track<D>, step: &Step<D>, long: bool| Next {
            track: track.id.clone(),
            step: step.clone(),
            long,
        };
        let usual = || {
            tracks
                .iter()
                .filter_map(|track| track.next.as_ref().map(|step| (track, step)))
                .min_by_key(|(_, step)| step.priority)
                .map(|(track, step)| next(track, step, false))
        };
        let next = match time {
            Time::Short => usual(),
            Time::AWhile => {
                let long: Vec<(&Track<D>, &Step<D>)> = tracks
                    .iter()
                    .filter_map(|track| track.long.as_ref().map(|step| (track, step)))
                    .collect();
                let unfinished = long
                    .iter()
                    .find(|(_, step)| step.priority == Priority::Unfinished);
                let turn = long
                    .iter()
                    .filter(|(_, step)| step.priority < Priority::Browse)
                    .min_by_key(|(track, _)| Some(&track.id) == last_long);
                match unfinished.or(turn) {
                    Some((track, step)) => Some(next(track, step, true)),
                    None => usual()
                        .or_else(|| long.first().map(|(track, step)| next(track, step, true))),
                }
            }
        };
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
            icon: TrackIcon::PACK_DEFAULT,
            id,
            summary: String::new(),
            destination: "the track",
            next,
            long: None,
        })
    }

    #[test]
    fn writes_and_reads_track_ids() {
        for (id, text) in [
            (TrackId::AdventOfCode, "advent-of-code"),
            (TrackId::SystemDesign, "system-design"),
            (TrackId::MentalMaths, "mental-maths"),
            (TrackId::Rounds, "rounds"),
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
    fn gives_built_in_tracks_icons_and_reads_icon_names() {
        assert_eq!(TrackId::Probability.built_in_icon(), Some(TrackIcon::Dice));
        assert_eq!(
            TrackId::Pack("graphs".parse().unwrap()).built_in_icon(),
            None
        );
        for icon in TrackIcon::ALL {
            assert_eq!(icon.name().parse::<TrackIcon>().unwrap(), icon);
            assert_eq!(
                serde_json::to_string(&icon).unwrap(),
                format!("\"{}\"", icon.name())
            );
        }
        let err = "rocket".parse::<TrackIcon>().unwrap_err().to_string();
        assert!(err.contains("\"rocket\""), "{err}");
        assert!(err.contains("dice, network"), "{err}");
    }

    /// The app draws every icon the server can send, by the same name.
    #[test]
    fn the_app_draws_every_icon() {
        let app = include_str!("../../../frontend/src/tracks/icons.tsx");
        for icon in TrackIcon::ALL {
            assert!(
                app.contains(&format!("\n  {}: ", icon.name()))
                    || app.contains(&format!("\n  \"{}\": ", icon.name())),
                "frontend/src/tracks/icons.tsx doesn't draw {:?}",
                icon.name()
            );
        }
    }

    #[test]
    fn lists_tracks_in_order_leaving_out_empty_ones() {
        let pack = TrackId::Pack("graphs".parse().unwrap());
        let home = Home::new(
            [
                track(pack.clone(), None),
                track(TrackId::Review, None),
                None,
                track(TrackId::AdventOfCode, None),
            ],
            Time::Short,
            None,
        )
        .unwrap();
        let ids: Vec<TrackId> = home.tracks.iter().map(|t| t.id.clone()).collect();
        assert_eq!(ids, [TrackId::AdventOfCode, TrackId::Review, pack]);
        assert_eq!(home.next, None);
    }

    #[test]
    fn continues_with_the_most_pressing_step() {
        let home = Home::new(
            [
                track(
                    TrackId::AdventOfCode,
                    Some(step("puzzle", Priority::Unfinished)),
                ),
                track(TrackId::Coding, Some(step("new problem", Priority::New))),
                track(TrackId::Review, Some(step("cards", Priority::Due))),
            ],
            Time::Short,
            None,
        )
        .unwrap();
        let next = home.next.unwrap();
        assert_eq!(next.track, TrackId::Review);
        assert_eq!(next.step.title, "cards");
    }

    #[test]
    fn breaks_ties_by_the_order_tracks_are_listed() {
        let home = Home::new(
            [
                track(TrackId::Probability, Some(step("later", Priority::New))),
                track(TrackId::Coding, Some(step("first", Priority::New))),
            ],
            Time::Short,
            None,
        )
        .unwrap();
        assert_eq!(home.next.unwrap().track, TrackId::Coding);
    }

    #[test]
    fn refuses_a_track_listed_twice() {
        let err = Home::new(
            [track(TrackId::Coding, None), track(TrackId::Coding, None)],
            Time::Short,
            None,
        )
        .unwrap_err();
        assert_eq!(err, TrackError::DuplicateTrack(TrackId::Coding));
    }

    fn with_long(
        track: Option<Track<&'static str>>,
        long: Step<&'static str>,
    ) -> Option<Track<&'static str>> {
        track.map(|track| track.with_long(Some(long)))
    }

    #[test]
    fn offers_long_items_only_when_the_learner_has_a_while() {
        let tracks = || {
            [
                track(TrackId::Review, Some(step("cards", Priority::Due))),
                with_long(
                    track(TrackId::SystemDesign, None),
                    step("design session", Priority::New),
                ),
                with_long(
                    track(TrackId::Rounds, None),
                    step("timed round", Priority::Focus),
                ),
            ]
        };
        let short = Home::new(tracks(), Time::Short, None)
            .unwrap()
            .next
            .unwrap();
        assert_eq!((short.step.title.as_str(), short.long), ("cards", false));
        // With a while, a long item comes first, even before due reviews. A round in a skill
        // with recent mistakes doesn't outrank a new design session: the first listed goes
        // first.
        let long = Home::new(tracks(), Time::AWhile, None)
            .unwrap()
            .next
            .unwrap();
        assert_eq!(
            (long.step.title.as_str(), long.long),
            ("design session", true)
        );
        assert_eq!(long.track, TrackId::SystemDesign);
    }

    #[test]
    fn takes_turns_between_long_items_unless_one_is_unfinished() {
        let tracks = |round: Priority| {
            [
                with_long(
                    track(TrackId::SystemDesign, None),
                    step("design session", Priority::Due),
                ),
                with_long(track(TrackId::Rounds, None), step("timed round", round)),
            ]
        };
        let after = |last: TrackId, round: Priority| {
            Home::new(tracks(round), Time::AWhile, Some(&last))
                .unwrap()
                .next
                .unwrap()
                .step
                .title
        };
        assert_eq!(after(TrackId::SystemDesign, Priority::New), "timed round");
        assert_eq!(after(TrackId::Rounds, Priority::New), "design session");
        assert_eq!(after(TrackId::Rounds, Priority::Focus), "design session");
        // Unfinished work comes first, whoever's turn it is.
        assert_eq!(after(TrackId::Rounds, Priority::Unfinished), "timed round");
        // Something only to browse doesn't get a turn.
        assert_eq!(
            after(TrackId::SystemDesign, Priority::Browse),
            "design session"
        );
    }

    #[test]
    fn with_a_while_still_prefers_a_real_step_to_a_long_item_only_to_browse() {
        let tracks = || {
            [
                track(TrackId::Review, Some(step("cards", Priority::New))),
                with_long(
                    track(TrackId::Rounds, None),
                    step("any round", Priority::Browse),
                ),
            ]
        };
        let next = Home::new(tracks(), Time::AWhile, None)
            .unwrap()
            .next
            .unwrap();
        assert_eq!(next.step.title, "cards");
        // With nothing else, the long item is still better than nothing.
        let only = Home::new(
            [with_long(
                track(TrackId::Rounds, None),
                step("any round", Priority::Browse),
            )],
            Time::AWhile,
            None,
        )
        .unwrap();
        assert_eq!(only.next.unwrap().step.title, "any round");
        let none = Home::new(
            [with_long(
                track(TrackId::Rounds, None),
                step("any round", Priority::Browse),
            )],
            Time::Short,
            None,
        )
        .unwrap();
        assert_eq!(none.next, None);
    }

    #[test]
    fn says_where_to_continue_alongside_the_step() {
        let home = Home::new(
            [track(
                TrackId::AdventOfCode,
                Some(step("2025 · day 3", Priority::Unfinished)),
            )],
            Time::Short,
            None,
        )
        .unwrap();
        let json = serde_json::to_value(&home).unwrap();
        assert_eq!(json["continue"]["track"], "advent-of-code");
        assert_eq!(json["continue"]["title"], "2025 · day 3");
        assert_eq!(json["continue"]["priority"], "unfinished");
        assert_eq!(json["continue"]["destination"], "somewhere");
        assert_eq!(json["continue"]["long"], false);
        assert_eq!(json["tracks"][0]["id"], "advent-of-code");
    }
}
