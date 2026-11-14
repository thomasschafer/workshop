//! Checking a probability item's exact answer with a Monte Carlo simulation.

use crate::item::Probability;
use crate::script::{Scripts, Value};

/// The seed every simulation starts from, so a check passes or fails the same way every time.
const SEED: u64 = 0x5EED;

/// How many standard errors the tolerance must allow at least: any tighter, and a right answer
/// could fail, or a wrong one pass, by the luck of the draw.
const MIN_STANDARD_ERRORS: f64 = 3.0;

#[derive(Debug, Clone, PartialEq)]
pub struct Estimate {
    pub mean: f64,
    pub standard_error: f64,
    pub trials: u32,
}

/// Runs the simulation, and says whether it agrees with the exact answer.
pub fn check(item: &Probability) -> Result<Estimate, String> {
    let estimate = run(&item.simulation.script, item.simulation.trials)?;
    let tolerance = item.simulation.tolerance;
    let floor = MIN_STANDARD_ERRORS * estimate.standard_error;
    if tolerance < floor {
        return Err(format!(
            "the tolerance {tolerance} is under {MIN_STANDARD_ERRORS} standard errors ({floor:.5}) of {} trials, so chance alone could decide the check; allow more, or run more trials",
            estimate.trials
        ));
    }
    let gap = (estimate.mean - item.answer).abs();
    if gap > tolerance {
        return Err(format!(
            "the simulation estimates {:.5}, but the answer is {} ({:.5}), {gap:.5} away where at most {tolerance} is allowed",
            estimate.mean, item.answer_text, item.answer
        ));
    }
    Ok(estimate)
}

/// The mean of the script's result over `trials` runs.
pub fn run(script: &str, trials: u32) -> Result<Estimate, String> {
    let scripts = Scripts::new(SEED);
    let ast = scripts.compile(script)?;
    let mut sum = 0.0;
    let mut sum_of_squares = 0.0;
    let mut kind = None;
    for trial in 0..trials {
        let value = scripts
            .run(&ast, &[])
            .map_err(|err| format!("in trial {}: {err}", trial + 1))?;
        let is_bool = matches!(value, Value::Bool(_));
        match kind {
            None => kind = Some(is_bool),
            Some(was_bool) if was_bool != is_bool => {
                return Err(
                    "the script should give true or false every time, or a number every time"
                        .to_owned(),
                );
            }
            Some(_) => {}
        }
        let x = value.as_f64();
        sum += x;
        sum_of_squares += x * x;
    }
    let n = f64::from(trials);
    let mean = sum / n;
    let variance = (sum_of_squares / n - mean * mean).max(0.0) * n / (n - 1.0).max(1.0);
    Ok(Estimate {
        mean,
        standard_error: (variance / n).sqrt(),
        trials,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::item::Simulation;
    use crate::number::Tolerance;

    fn item(answer: f64, script: &str, trials: u32, tolerance: f64) -> Probability {
        Probability {
            answer_text: answer.to_string(),
            answer,
            tolerance: Tolerance::EXACT,
            solution: String::new(),
            simulation: Simulation {
                script: script.to_owned(),
                trials,
                tolerance,
            },
        }
    }

    #[test]
    fn agrees_with_a_right_answer() {
        let sevens = item(
            1.0 / 6.0,
            "rand_int(1, 6) + rand_int(1, 6) == 7",
            40_000,
            0.01,
        );
        let estimate = check(&sevens).unwrap();
        assert!((estimate.mean - 1.0 / 6.0).abs() < 0.01);
        assert!(estimate.standard_error > 0.001 && estimate.standard_error < 0.003);

        let mean_roll = item(3.5, "rand_int(1, 6)", 40_000, 0.05);
        assert!(check(&mean_roll).is_ok());
    }

    #[test]
    fn catches_a_wrong_answer() {
        let wrong = item(
            1.0 / 4.0,
            "rand_int(1, 6) + rand_int(1, 6) == 7",
            40_000,
            0.01,
        );
        assert!(check(&wrong).unwrap_err().contains("estimates"));
    }

    #[test]
    fn refuses_a_tolerance_chance_could_decide() {
        let tight = item(0.5, "rand_bool(0.5)", 1_000, 0.001);
        assert!(check(&tight).unwrap_err().contains("standard errors"));
    }

    #[test]
    fn gives_the_same_estimate_every_time() {
        assert_eq!(
            run("rand_float()", 5_000).unwrap(),
            run("rand_float()", 5_000).unwrap()
        );
    }

    #[test]
    fn refuses_trials_of_mixed_kinds() {
        let mixed = "if rand_bool(0.5) { true } else { 1 }";
        assert!(run(mixed, 1_000).unwrap_err().contains("every time"));
    }
}
