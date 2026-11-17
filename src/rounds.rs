//! The Timed rounds track: rounds with the examiner, on items from the Coding, Probability and
//! System design tracks. Rounds take a while, so the track is only on the home screen when the
//! learner has a while, or has a round under way, and only then does Continue offer one: the
//! round under way, then an item due for review, then something new, sooner if it's in a skill
//! recent mistakes point to, and otherwise any item, against the clock again.

use std::collections::BTreeMap;

use workshop_learning::TrackPlan;
use workshop_pack::Item;
use workshop_sessions::round::{Ending, Round};
use workshop_tracks::{Priority, Step, Time, Track, TrackId};

use crate::learning::Planned;
use crate::tracks::Destination;

/// The tracks rounds are made from, in the order their items are suggested.
const FROM: [TrackId; 3] = [TrackId::Coding, TrackId::Probability, TrackId::SystemDesign];

/// Every item a round can be made of, with its key. Those in a track kept out of Continue are
/// only offered in their track, so they aren't.
pub fn items(planned: &Planned) -> impl Iterator<Item = (String, &Item)> {
    planned.packs.iter().flat_map(|pack| {
        pack.items
            .iter()
            .filter(|item| crate::examiner::can_round(item) && !planned.is_kept_apart(item))
            .map(move |item| (format!("{}/{}", pack.manifest.id, item.id), item))
    })
}

/// What a round's item would be, and why, if anything can be one.
pub fn suggest(planned: &Planned) -> Option<(String, Priority, String)> {
    let roundable = |key: &String| {
        planned
            .item(key)
            .is_some_and(|item| crate::examiner::can_round(item) && !planned.is_kept_apart(item))
    };
    let plans: Vec<&TrackPlan> = FROM.iter().filter_map(|id| planned.plans.get(id)).collect();
    if let Some(key) = plans.iter().flat_map(|p| &p.due).find(|k| roundable(k)) {
        return Some((
            key.clone(),
            Priority::Due,
            "Due for review, against the clock".to_owned(),
        ));
    }
    let new: Vec<&String> = plans
        .iter()
        .flat_map(|p| &p.new)
        .filter(|k| roundable(k))
        .collect();
    let focus = new.iter().find_map(|key| {
        let skill = planned.item(key).and_then(|item| planned.focus_of(item))?;
        Some((key, skill))
    });
    if let Some((key, skill)) = focus {
        return Some((
            (*key).clone(),
            Priority::Focus,
            format!("Practise {skill}, after recent mistakes"),
        ));
    }
    if let Some(key) = new.first() {
        return Some((
            (*key).clone(),
            Priority::New,
            "Something new, against the clock".to_owned(),
        ));
    }
    items(planned)
        .find(|(key, _)| !planned.is_retired(key))
        .map(|(key, _)| (key, Priority::Browse, "Again, against the clock".to_owned()))
}

/// How long's left of a round, or how it ended, as Continue says it at `now`.
pub fn where_it_is(round: &Round, now: i64) -> String {
    match round.ending_at(now) {
        None => {
            let left = (round.clock().remaining_ms + 59_999) / 60_000;
            format!(
                "Where you left off, {left} {} left",
                if left == 1 { "minute" } else { "minutes" }
            )
        }
        Some(Ending::Interrupted) => "Ended while you were away, to be marked".to_owned(),
        Some(_) => "Over, to be marked".to_owned(),
    }
}

/// The Timed rounds track on the home screen at `now`, if there's anything to make a round of
/// and the learner has `time` for one, or a round under way.
pub fn track(
    planned: &Planned,
    rounds: &BTreeMap<String, Round>,
    now: i64,
    time: Time,
) -> Option<Track<Destination>> {
    let open = |key: &str| Destination::Round {
        item: Some(key.to_owned()),
    };
    let label = |key: &str| {
        planned
            .item(key)
            .map_or_else(|| key.to_owned(), |item| item.label())
    };
    let under_way: Vec<(&String, &Round)> = rounds
        .iter()
        .filter(|(key, _)| planned.item(key).is_some())
        .collect();
    if time == Time::Short && under_way.is_empty() {
        return None;
    }
    let long = match under_way.iter().max_by_key(|(_, round)| round.seen_at) {
        Some((key, round)) => Some(Step {
            title: label(key),
            reason: where_it_is(round, now),
            priority: Priority::Unfinished,
            destination: open(key),
        }),
        None => suggest(planned).map(|(key, priority, reason)| Step {
            title: label(&key),
            reason,
            priority,
            destination: open(&key),
        }),
    }?;
    let summary = match under_way.len() {
        0 => "Against the clock, with the examiner".to_owned(),
        1 => "1 under way".to_owned(),
        n => format!("{n} under way"),
    };
    Some(
        Track::built_in(
            TrackId::Rounds,
            summary,
            Destination::Round { item: None },
            None,
        )
        .with_long(Some(long)),
    )
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use workshop_learning::{Attempt, Clock, Rating};

    use super::*;
    use crate::config::LearningConfig;
    use crate::learning::Learning;

    const NOW: i64 = 1_790_000_000_000;

    fn learning(dir: &Path) -> Learning {
        let config = LearningConfig {
            packs: Vec::new(),
            sample_pack: false,
            daily_reviews: 40,
            daily_new: 10,
            weekly_minutes: 90,
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

    #[test]
    fn suggests_something_new_then_what_is_due_then_the_round_under_way() {
        let dir = tempfile::tempdir().unwrap();
        let learning = learning(dir.path());
        let planned = learning.planned(clock(NOW)).unwrap();
        let none = BTreeMap::new();
        // Without a while, there's no track, as there's nothing under way.
        assert!(track(&planned, &none, NOW, Time::Short).is_none());
        let track = track(&planned, &none, NOW, Time::AWhile).unwrap();
        assert_eq!(track.name, "Timed rounds");
        assert_eq!(track.next, None);
        let long = track.long.unwrap();
        assert_eq!(long.priority, Priority::New);
        // The first track's first: a coding problem.
        let Destination::Round { item: Some(key) } = &long.destination else {
            panic!("{:?}", long.destination);
        };
        assert!(planned.item(key).unwrap().kind == workshop_pack::Kind::Coding);
        assert!(long.reason.starts_with("Something new, against the clock"));

        // Once a probability question's due, that's first.
        learning
            .record(
                &[Attempt {
                    id: "5f0c2a8e-4a51-4c3e-9d0b-1f6b2f0f8a70".to_owned(),
                    item: "sample/two-dice-seven".to_owned(),
                    answered_at: NOW,
                    duration_ms: 1000,
                    rating: Rating::Again,
                    response: None,
                    seed: None,
                }],
                NOW,
            )
            .unwrap();
        let later = NOW + 3 * 24 * 3_600_000;
        let planned = learning.planned(clock(later)).unwrap();
        let (key, priority, _) = suggest(&planned).unwrap();
        assert_eq!(
            (key.as_str(), priority),
            ("sample/two-dice-seven", Priority::Due)
        );

        let mut round = Round::new(10, None, later);
        round.seen(later + 10_000);
        let rounds = BTreeMap::from([("sample/islands".to_owned(), round.clone())]);
        // One under way stays on the home screen without a while, to be carried on with.
        assert!(super::track(&planned, &rounds, later + 10_000, Time::Short).is_some());
        let track = super::track(&planned, &rounds, later + 10_000, Time::AWhile).unwrap();
        let long = track.long.unwrap();
        assert_eq!(long.priority, Priority::Unfinished);
        assert_eq!(long.title, "Count the islands");
        assert_eq!(long.reason, "Where you left off, 10 minutes left");
        assert_eq!(track.summary, "1 under way");
        let away = later + 10_000 + workshop_sessions::round::AWAY_MS + 1;
        assert_eq!(
            where_it_is(&round, away),
            "Ended while you were away, to be marked"
        );
    }
}
