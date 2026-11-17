//! The mistake log as the app shows it: mistakes found in wrong answers and failed coding
//! submissions, the kinds of mistake they can be tagged with, and the skills recent mistakes
//! point to, which Continue and the author lean towards.

use std::collections::BTreeMap;

use serde::Serialize;
use workshop_learning::{Attempt, Mistake, MistakeSource, NewMistake, Rating};
use workshop_pack::{Content, ErrorType, Item, Pack, Question, number};

use workshop_learning::schedule::DAY_MS;

/// How far back mistakes count towards what to practise next.
pub const RECENT_MS: i64 = 14 * DAY_MS;

/// The most skills recent mistakes point to that are leant towards at once, so one bad day
/// doesn't take over everything.
const FOCUS_SKILLS: usize = 3;

/// The mistake a wrong attempt shows, if it was one: a wrong answer, a card forgotten, or a
/// coding problem that couldn't be recalled.
pub fn from_attempt(item: &Item, attempt: &Attempt) -> Option<NewMistake> {
    if attempt.rating != Rating::Again {
        return None;
    }
    let response = attempt
        .response
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty());
    let (detail, suggested) = match &item.content {
        Content::Card { .. } => ("Forgot it".to_owned(), Some("concept-gap")),
        Content::MentalMaths(template) => {
            let expected = attempt.seed.and_then(|seed| {
                workshop_pack::mental::Generator::new(template, &item.prompt)
                    .and_then(|generator| generator.instance(seed))
                    .ok()
            });
            numeric(
                expected.as_ref().map(|i| i.answer),
                response,
                "arithmetic-slip",
            )
        }
        Content::Probability(probability) => {
            numeric(Some(probability.answer), response, "concept-gap")
        }
        Content::Reading(reading) => match (&reading.question, response) {
            (_, None) => ("Didn't know".to_owned(), Some("concept-gap")),
            (Question::Prints { output }, Some(given)) => (
                format!("Said it prints {given:?}; it prints {:?}", output.trim()),
                Some("concept-gap"),
            ),
            (Question::Choice { choices, answer }, Some(given)) => {
                let chosen = given
                    .parse::<usize>()
                    .ok()
                    .and_then(|n| n.checked_sub(1))
                    .and_then(|n| choices.get(n))
                    .map_or(given, String::as_str);
                (
                    format!("Chose {chosen:?}; it's {:?}", choices[*answer]),
                    Some("concept-gap"),
                )
            }
        },
        Content::Coding(_) => (
            "Couldn't solve or recall it".to_owned(),
            Some("wrong-approach"),
        ),
        Content::Design { .. } => ("Marked as forgotten".to_owned(), Some("concept-gap")),
    };
    Some(NewMistake {
        id: format!("attempt-{}", attempt.id),
        item: attempt.item.clone(),
        at: attempt.answered_at,
        source: MistakeSource::Answer,
        attempt: Some(attempt.id.clone()),
        detail,
        suggested: suggested.map(str::to_owned),
    })
}

/// What a wrong numeric answer was, and the kind of mistake it looks like.
fn numeric(
    expected: Option<f64>,
    response: Option<&str>,
    otherwise: &'static str,
) -> (String, Option<&'static str>) {
    let Some(given) = response else {
        return ("Didn't know".to_owned(), Some("concept-gap"));
    };
    let Some(expected) = expected else {
        return (format!("Answered {given}"), None);
    };
    let detail = format!("Answered {given}; it's {}", number::display(expected));
    match number::parse(given) {
        Some(value) => (
            detail,
            Some(workshop_learning::mistakes::suggest_for_number(
                expected, value, otherwise,
            )),
        ),
        None => (detail, Some("misread")),
    }
}

/// The mistake a failed coding submission shows, if it ran and got something wrong: too slow if
/// it took too long, a misreading if it got the examples the learner could see wrong, and
/// otherwise a missed edge case.
pub fn from_submission(
    key: &str,
    id: String,
    at: i64,
    graded: &workshop_coding::Graded,
) -> Option<NewMistake> {
    use workshop_coding::CaseRef;
    let failure = graded.failure()?;
    let suggested = if failure.run.ending == workshop_runner::Ending::TimedOut {
        "too-slow"
    } else {
        match failure.case {
            CaseRef::Example { .. } => "misread",
            CaseRef::Test { .. } | CaseRef::Random { .. } => "missed-edge-case",
        }
    };
    let on = match &failure.case {
        CaseRef::Example { index } => format!("example {}", index + 1),
        CaseRef::Test { index } => format!("hidden test {}", index + 1),
        CaseRef::Random { size, .. } => format!("a random input of size {size}"),
    };
    Some(NewMistake {
        id,
        item: key.to_owned(),
        at,
        source: MistakeSource::Submission,
        attempt: None,
        detail: format!(
            "A submission {} on {on}",
            workshop_coding::grade::describe(&failure.run)
        ),
        suggested: Some(suggested.to_owned()),
    })
}

/// The packs' items by key, as `pack/item`.
pub fn items_by_key(packs: &[Pack]) -> BTreeMap<String, &Item> {
    packs
        .iter()
        .flat_map(|pack| {
            pack.items
                .iter()
                .map(move |item| (format!("{}/{}", pack.manifest.id, item.id), item))
        })
        .collect()
}

/// Every kind of mistake the packs' mistakes can be tagged with, the built-in ones first.
pub fn error_types(packs: &[Pack]) -> Vec<ErrorType> {
    let mut all = workshop_pack::error_types::built_in();
    for pack in packs {
        for error_type in &pack.manifest.error_types {
            if !all.iter().any(|t| t.id == error_type.id) {
                all.push(error_type.clone());
            }
        }
    }
    all
}

/// The skills that recent mistakes point to, most mistakes first, for Continue and the author
/// to lean towards.
pub fn focus_skills(packs: &[Pack], recent: &[Mistake]) -> Vec<String> {
    let items = items_by_key(packs);
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for mistake in recent {
        if let Some(item) = items.get(&mistake.mistake.item) {
            for skill in &item.skills {
                *counts.entry(skill).or_default() += 1;
            }
        }
    }
    let mut ranked: Vec<(&str, usize)> = counts.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    ranked
        .into_iter()
        .take(FOCUS_SKILLS)
        .map(|(skill, _)| skill.to_owned())
        .collect()
}

/// How often each kind of mistake was made, most often first.
pub fn common_error_types(mistakes: &[Mistake]) -> Vec<Count> {
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for mistake in mistakes {
        if let Some(error_type) = mistake.error_type() {
            *counts.entry(error_type).or_default() += 1;
        }
    }
    let mut ranked: Vec<Count> = counts
        .into_iter()
        .map(|(error_type, count)| Count {
            error_type: error_type.to_owned(),
            count,
        })
        .collect();
    ranked.sort_by(|a, b| b.count.cmp(&a.count).then(a.error_type.cmp(&b.error_type)));
    ranked
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Count {
    pub error_type: String,
    pub count: usize,
}

/// The mistake log, as the app shows it.
#[derive(Debug, Serialize)]
pub struct Log {
    pub error_types: Vec<ErrorType>,
    pub mistakes: Vec<Logged>,
    /// How often each kind was made, most often first.
    pub common: Vec<Count>,
    /// The skills recent mistakes point to, which practice leans towards.
    pub focus: Vec<String>,
    pub skills: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
pub struct Logged {
    #[serde(flatten)]
    pub mistake: Mistake,
    /// What the item is called, if it's still in the packs.
    pub label: Option<String>,
    pub skills: Vec<String>,
}

pub fn log(packs: &[Pack], mistakes: Vec<Mistake>, now: i64) -> Log {
    let items = items_by_key(packs);
    let recent: Vec<Mistake> = mistakes
        .iter()
        .filter(|m| m.mistake.at >= now - RECENT_MS)
        .cloned()
        .collect();
    let skills = packs
        .iter()
        .flat_map(|pack| &pack.manifest.skills)
        .map(|skill| (skill.id.clone(), skill.name.clone()))
        .collect();
    Log {
        error_types: error_types(packs),
        common: common_error_types(&mistakes),
        focus: focus_skills(packs, &recent),
        skills,
        mistakes: mistakes
            .into_iter()
            .map(|mistake| {
                let item = items.get(&mistake.mistake.item);
                Logged {
                    label: item.map(|item| item.label()),
                    skills: item.map(|item| item.skills.clone()).unwrap_or_default(),
                    mistake,
                }
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_790_000_000_000;

    fn attempt(item: &str, rating: Rating, response: Option<&str>, seed: Option<u64>) -> Attempt {
        Attempt {
            id: "attempt-id-1".to_owned(),
            item: format!("sample/{item}"),
            answered_at: NOW,
            duration_ms: 10_000,
            rating,
            response: response.map(str::to_owned),
            seed,
        }
    }

    #[test]
    fn finds_mistakes_in_wrong_answers() {
        let pack = Pack::sample();
        let item = |id: &str| pack.item(id).unwrap();
        assert!(
            from_attempt(
                item("two-dice-seven"),
                &attempt("two-dice-seven", Rating::Good, Some("1/6"), None)
            )
            .is_none()
        );

        let wrong = from_attempt(
            item("two-dice-seven"),
            &attempt("two-dice-seven", Rating::Again, Some("1/36"), None),
        )
        .unwrap();
        assert_eq!(wrong.id, "attempt-attempt-id-1");
        assert_eq!(wrong.source, MistakeSource::Answer);
        assert!(
            wrong.detail.starts_with("Answered 1/36; it's"),
            "{}",
            wrong.detail
        );
        assert_eq!(wrong.suggested.as_deref(), Some("concept-gap"));

        let unknown = from_attempt(
            item("two-dice-seven"),
            &attempt("two-dice-seven", Rating::Again, None, None),
        )
        .unwrap();
        assert_eq!(unknown.detail, "Didn't know");

        // A sum one out, worked out again from the seed it was made from.
        let template = item("times-eleven");
        let Content::MentalMaths(maths) = &template.content else {
            panic!("not mental maths")
        };
        let instance = workshop_pack::mental::Generator::new(maths, &template.prompt)
            .unwrap()
            .instance(7)
            .unwrap();
        let one_out = (instance.answer + 1.0).to_string();
        let slip = from_attempt(
            template,
            &attempt("times-eleven", Rating::Again, Some(&one_out), Some(7)),
        )
        .unwrap();
        assert_eq!(slip.suggested.as_deref(), Some("off-by-one"));

        let card = from_attempt(
            item("stable-sorting"),
            &attempt("stable-sorting", Rating::Again, None, None),
        )
        .unwrap();
        assert_eq!(card.detail, "Forgot it");

        let reading = from_attempt(
            item("negative-division"),
            &attempt("negative-division", Rating::Again, Some("-4 1"), None),
        )
        .unwrap();
        assert!(reading.detail.contains("\"-3 -1\""), "{}", reading.detail);
    }

    fn mistake(item: &str, at: i64, suggested: &str) -> Mistake {
        Mistake {
            mistake: NewMistake {
                id: format!("m-{item}-{at}"),
                item: format!("sample/{item}"),
                at,
                source: MistakeSource::Answer,
                attempt: None,
                detail: String::new(),
                suggested: Some(suggested.to_owned()),
            },
            confirmed: None,
        }
    }

    #[test]
    fn points_to_the_skills_and_kinds_of_recent_mistakes() {
        let packs = vec![Pack::sample()];
        let mistakes = vec![
            mistake("two-dice-seven", NOW, "concept-gap"),
            mistake("two-dice-seven", NOW - 3, "concept-gap"),
            mistake("both-heads", NOW - 1, "concept-gap"),
            mistake("times-eleven", NOW - 2, "off-by-one"),
            // Long ago, so it doesn't count towards what to practise.
            mistake("stable-sorting", NOW - RECENT_MS - 1, "concept-gap"),
        ];
        let log = log(&packs, mistakes, NOW);
        assert_eq!(log.focus[0], "probability.counting");
        assert!(
            !log.focus
                .iter()
                .any(|skill| skill == "algorithms.complexity")
        );
        assert_eq!(
            log.common[0],
            Count {
                error_type: "concept-gap".to_owned(),
                count: 4
            }
        );
        assert_eq!(
            log.mistakes[0].label.as_deref(),
            Some(packs[0].item("two-dice-seven").unwrap().label().as_str())
        );
        assert_eq!(log.error_types.len(), 8);
    }
}
