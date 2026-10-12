//! An invented puzzle to practise on, which needs no Advent of Code account. It's served in the
//! same shape as an Advent of Code page, so it works everywhere a real puzzle does, and answers
//! are checked here.

use std::path::PathBuf;
use std::sync::LazyLock;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::aoc::{Part, SubmitOutcome};
use crate::paths;

/// A sled with more than this much is overloaded.
const LIMIT: u32 = 100;

const PART_ONE: &str = r#"<article class="day-desc"><h2>--- Practice: Sled Parcels ---</h2>
<p>This is a practice puzzle, made up for Workshop, so you can try solving by voice without an Advent of Code account. It works like a real one: choose the sample, write a solution, run it, and submit.</p>
<p>The elves are loading parcels onto sleds. Each line of your input lists the weights of the parcels on one sled, separated by spaces. A sled whose parcels weigh more than <code>100</code> in total is <em>overloaded</em>.</p>
<p>For example:</p>
<pre><code>40 30 20
90 15
60 25 10 8
5
</code></pre>
<p>These sleds carry <code>90</code>, <code>105</code>, <code>103</code> and <code>5</code>, so <code><em>2</em></code> of them are overloaded.</p>
<p><em>How many sleds are overloaded?</em></p>
</article>"#;

const PART_TWO: &str = r#"<article class="day-desc"><h2 id="part2">--- Part Two ---</h2>
<p>The overloaded sleds will be unpacked, so the elves only want to know about the others. For each sled that <em>isn't</em> overloaded, find its heaviest parcel.</p>
<p>In the example, the first sled's heaviest parcel weighs <code>40</code>, and the last sled's weighs <code>5</code>, so the total is <code><em>45</em></code>.</p>
<p><em>What is the total weight of the heaviest parcel on each sled that isn't overloaded?</em></p>
</article>"#;

/// The puzzle input: the same for everyone, so the answers are known.
pub static INPUT: LazyLock<String> = LazyLock::new(|| {
    // A small linear congruential generator, so the input never changes.
    let mut state: u64 = 2015;
    let mut next = |below: u64| {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (state >> 33) % below
    };
    let mut input = String::new();
    for _ in 0..300 {
        let parcels = 1 + next(6);
        let weights: Vec<String> = (0..parcels).map(|_| (1 + next(60)).to_string()).collect();
        input.push_str(&weights.join(" "));
        input.push('\n');
    }
    input
});

fn sleds(input: &str) -> Vec<Vec<u32>> {
    input
        .lines()
        .map(|line| {
            line.split_whitespace()
                .map(|w| w.parse().expect("generated weights are numbers"))
                .collect()
        })
        .collect()
}

/// The answers to the two parts.
fn answers() -> [String; 2] {
    let sleds = sleds(&INPUT);
    let overloaded = |sled: &Vec<u32>| sled.iter().sum::<u32>() > LIMIT;
    let part_one = sleds.iter().filter(|s| overloaded(s)).count();
    let part_two: u32 = sleds
        .iter()
        .filter(|s| !overloaded(s))
        .filter_map(|s| s.iter().max())
        .sum();
    [part_one.to_string(), part_two.to_string()]
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Progress {
    /// The answers accepted so far, by part.
    answers: Vec<String>,
}

/// Progress on the practice puzzle, kept with Workshop's data.
pub struct Practice {
    progress_path: PathBuf,
}

impl Practice {
    pub fn new(progress_path: PathBuf) -> Self {
        Self { progress_path }
    }

    fn progress(&self) -> Result<Progress> {
        match std::fs::read_to_string(&self.progress_path) {
            Ok(text) => serde_json::from_str(&text).context("reading practice progress"),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Progress::default()),
            Err(err) => Err(err).context("reading practice progress"),
        }
    }

    fn save(&self, progress: &Progress) -> Result<()> {
        paths::write_atomic(
            &self.progress_path,
            serde_json::to_string_pretty(progress)?.as_bytes(),
        )
    }

    /// The puzzle page as Advent of Code would show it, given the progress so far.
    pub fn page(&self) -> Result<String> {
        let progress = self.progress()?;
        let mut html = String::from("<html><body><main>\n");
        html.push_str(PART_ONE);
        for (i, answer) in progress.answers.iter().enumerate() {
            html.push_str(&format!(
                "\n<p>Your puzzle answer was <code>{answer}</code>.</p>\n"
            ));
            if i == 0 {
                html.push_str(PART_TWO);
            }
        }
        html.push_str(match progress.answers.len() {
            0 => "",
            1 => "\n<p class=\"day-success\">The first half of this puzzle is complete! It provides one gold star: *</p>",
            _ => "\n<p class=\"day-success\">Both parts of this puzzle are complete! They provide two gold stars: **</p>",
        });
        html.push_str("\n</main></body></html>");
        Ok(html)
    }

    pub fn submit(&self, part: Part, answer: &str) -> Result<SubmitOutcome> {
        let mut progress = self.progress()?;
        let index = usize::from(part.number() - 1);
        if index < progress.answers.len() {
            return Ok(SubmitOutcome::AlreadySolved {
                message: "You've already solved this part.".to_owned(),
            });
        }
        if index > progress.answers.len() {
            return Ok(SubmitOutcome::Unknown {
                message: "Solve part 1 first.".to_owned(),
            });
        }
        let expected = &answers()[index];
        if answer.trim() == expected {
            progress.answers.push(expected.clone());
            self.save(&progress)?;
            return Ok(SubmitOutcome::Correct);
        }
        let hint = match (answer.trim().parse::<i64>(), expected.parse::<i64>()) {
            (Ok(given), Ok(expected)) if given > expected => Some("too high".to_owned()),
            (Ok(given), Ok(expected)) if given < expected => Some("too low".to_owned()),
            _ => None,
        };
        Ok(SubmitOutcome::Incorrect {
            message: format!(
                "That's not the right answer{}.",
                hint.as_deref()
                    .map(|h| format!("; your answer is {h}"))
                    .unwrap_or_default()
            ),
            hint,
        })
    }

    /// Starts the practice puzzle again, for another go.
    pub fn reset(&self) -> Result<()> {
        match std::fs::remove_file(&self.progress_path) {
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => {
                Err(err).context("resetting practice progress")
            }
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aoc::parse_problem;

    #[test]
    fn the_input_is_fixed_and_varied() {
        let sleds = sleds(&INPUT);
        assert_eq!(sleds.len(), 300);
        let [one, two] = answers();
        // Some of each kind of sled, so both parts are interesting.
        let overloaded: usize = one.parse().unwrap();
        assert!((50..250).contains(&overloaded), "{overloaded}");
        assert!(two.parse::<u32>().unwrap() > 0);
        assert_eq!(answers(), [one, two]);
    }

    #[test]
    fn the_sample_answers_match_the_text() {
        let example = "40 30 20\n90 15\n60 25 10 8\n5\n";
        let sleds = sleds(example);
        let overloaded = sleds
            .iter()
            .filter(|s| s.iter().sum::<u32>() > LIMIT)
            .count();
        assert_eq!(overloaded, 2);
        let heaviest: u32 = sleds
            .iter()
            .filter(|s| s.iter().sum::<u32>() <= LIMIT)
            .filter_map(|s| s.iter().max())
            .sum();
        assert_eq!(heaviest, 45);
    }

    #[test]
    fn plays_through_like_a_real_puzzle() {
        let dir = tempfile::tempdir().unwrap();
        let practice = Practice::new(dir.path().join("practice.json"));
        let problem = parse_problem(&practice.page().unwrap()).unwrap();
        assert_eq!(problem.title.as_deref(), Some("Practice: Sled Parcels"));
        assert_eq!(problem.parts_html.len(), 1);
        assert_eq!(problem.stars, 0);
        assert_eq!(problem.suggested_sample_answers, [Some("2".to_owned())]);
        assert_eq!(problem.suggested_sample_blocks, [Some(0)]);

        let [one, two] = answers();
        let wrong = (one.parse::<u32>().unwrap() + 1).to_string();
        assert!(matches!(
            practice.submit(Part::One, &wrong).unwrap(),
            SubmitOutcome::Incorrect { hint: Some(h), .. } if h == "too high"
        ));
        assert!(matches!(
            practice.submit(Part::Two, &two).unwrap(),
            SubmitOutcome::Unknown { .. }
        ));
        assert_eq!(
            practice.submit(Part::One, &one).unwrap(),
            SubmitOutcome::Correct
        );

        let problem = parse_problem(&practice.page().unwrap()).unwrap();
        assert_eq!(problem.parts_html.len(), 2);
        assert_eq!(problem.stars, 1);
        assert_eq!(problem.answers, std::slice::from_ref(&one));
        assert_eq!(
            practice.submit(Part::Two, &two).unwrap(),
            SubmitOutcome::Correct
        );
        let problem = parse_problem(&practice.page().unwrap()).unwrap();
        assert_eq!(problem.stars, 2);
        assert_eq!(problem.answers, [one, two]);

        practice.reset().unwrap();
        assert_eq!(parse_problem(&practice.page().unwrap()).unwrap().stars, 0);
    }
}
