//! Running a solution to a coding item: on the examples while it's being written, and on
//! everything when it's submitted, which is also how a pack's reference solutions are checked.
//!
//! A submission runs on the examples, then on random inputs compared with the brute force's
//! answers, from the smallest inputs up, then on the hidden tests. So when it's wrong, the input
//! it's shown failing on is as small as could be found, which makes it easier to work through.

use anyhow::Result;
use serde::Serialize;
use tokio_util::sync::CancellationToken;
use workshop_pack::code::MAX_SIZE;
use workshop_pack::{Case, Coding, Language, output};
use workshop_runner::Ending;

use crate::programs::{Built, Flavour, Program, Run, Runtime};

/// How many random inputs are run at once: one per processor, as each is a process or two.
fn at_once() -> usize {
    std::thread::available_parallelism().map_or(4, |n| n.get())
}

/// Which of an item's cases something ran on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CaseRef {
    /// One of the examples the learner sees, counting from 0.
    Example { index: usize },
    /// One of the hidden tests, counting from 0.
    Test { index: usize },
    /// A random input, made from this seed and size.
    Random { seed: u64, size: u32 },
}

/// How a run on one case went.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CaseResult {
    pub case: CaseRef,
    pub input: String,
    /// What a right solution prints.
    pub expected: String,
    pub run: Run,
    pub passed: bool,
}

/// How a solution did, on whatever it was run on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum Graded {
    /// It didn't build.
    BuildFailed { errors: String },
    /// It can't be built or run here, and why.
    Unavailable { reason: String },
    /// It ran on these, stopping at the first it got wrong.
    Ran {
        results: Vec<CaseResult>,
        /// How many cases there were to run, of which these are the first.
        total: usize,
    },
}

impl Graded {
    /// The first case it got wrong, if it ran.
    pub fn failure(&self) -> Option<&CaseResult> {
        match self {
            Self::Ran { results, .. } => results.iter().find(|result| !result.passed),
            _ => None,
        }
    }

    pub fn passed(&self) -> bool {
        matches!(self, Self::Ran { results, total } if results.len() == *total && results.iter().all(|r| r.passed))
    }

    /// What went wrong, in a sentence, or None if it passed.
    pub fn problem(&self) -> Option<String> {
        match self {
            Self::BuildFailed { errors } => Some(format!("it doesn't build:\n{errors}")),
            Self::Unavailable { reason } => Some(reason.clone()),
            Self::Ran { .. } => self.failure().map(|failure| {
                let on = match &failure.case {
                    CaseRef::Example { index } => format!("example {}", index + 1),
                    CaseRef::Test { index } => format!("test {}", index + 1),
                    CaseRef::Random { seed, size } => {
                        format!("the random input of size {size} from seed {seed}")
                    }
                };
                let what = describe(&failure.run);
                format!(
                    "{what} on {on}:\n{}\nexpected:\n{}\ngot:\n{}{}",
                    failure.input.trim_end(),
                    failure.expected.trim_end(),
                    failure.run.stdout.trim_end(),
                    if failure.run.stderr.trim().is_empty() {
                        String::new()
                    } else {
                        format!("\nstderr:\n{}", failure.run.stderr.trim_end())
                    }
                )
            }),
        }
    }
}

/// How a run that didn't print the right answer went wrong.
pub fn describe(run: &Run) -> &'static str {
    match run.ending {
        Ending::TimedOut => "it took too long",
        Ending::Cancelled => "it was stopped",
        Ending::Exited { code: Some(0) } => "it printed the wrong answer",
        Ending::Exited { .. } => "it crashed",
    }
}

/// Builds a solution, or says why it can't be run.
async fn build_solution(
    runtime: &Runtime,
    language: Language,
    code: &str,
    cancel: &CancellationToken,
) -> Result<Result<Program, Graded>> {
    Ok(
        match runtime
            .build(language, code, Flavour::Plain, cancel)
            .await?
        {
            Built::Ready(program) => Ok(program),
            Built::Failed { errors, .. } => Err(Graded::BuildFailed { errors }),
            Built::Unavailable(reason) => Err(Graded::Unavailable { reason }),
        },
    )
}

async fn run_case(
    runtime: &Runtime,
    program: &Program,
    case: CaseRef,
    known: &Case,
    cancel: &CancellationToken,
) -> Result<CaseResult> {
    let run = runtime.run(program, &[], &known.input, cancel).await?;
    let passed = run.succeeded() && output::same(&known.output, &run.stdout);
    Ok(CaseResult {
        case,
        input: known.input.clone(),
        expected: known.output.clone(),
        run,
        passed,
    })
}

/// Runs a solution on the examples, all of them, whichever it gets wrong.
pub async fn run_examples(
    runtime: &Runtime,
    coding: &Coding,
    language: Language,
    code: &str,
    cancel: &CancellationToken,
) -> Result<Graded> {
    let program = match build_solution(runtime, language, code, cancel).await? {
        Ok(program) => program,
        Err(graded) => return Ok(graded),
    };
    let mut results = Vec::new();
    for (index, example) in coding.examples.iter().enumerate() {
        results.push(
            run_case(
                runtime,
                &program,
                CaseRef::Example { index },
                example,
                cancel,
            )
            .await?,
        );
    }
    Ok(Graded::Ran {
        total: results.len(),
        results,
    })
}

/// The brute force and the inputs program, built, for comparing solutions with on random inputs,
/// and the random cases made with them so far, which are the same for every solution.
pub struct Oracle {
    brute_force: Program,
    inputs: Program,
    made: std::sync::Mutex<std::collections::HashMap<(u64, u32), Case>>,
}

impl Oracle {
    /// Builds the item's brute force and inputs program, or says why they can't be.
    pub async fn build(
        runtime: &Runtime,
        coding: &Coding,
        cancel: &CancellationToken,
    ) -> Result<Result<Self, String>> {
        let mut built = Vec::new();
        for source in [&coding.brute_force, &coding.inputs] {
            match runtime
                .build(source.language, &source.text, Flavour::Plain, cancel)
                .await?
            {
                Built::Ready(program) => built.push(program),
                Built::Failed { errors, .. } => {
                    return Ok(Err(format!("{} doesn't build:\n{errors}", source.file)));
                }
                Built::Unavailable(reason) => return Ok(Err(reason)),
            }
        }
        let inputs = built.pop().expect("built both");
        let brute_force = built.pop().expect("built both");
        Ok(Ok(Self {
            brute_force,
            inputs,
            made: std::sync::Mutex::default(),
        }))
    }

    fn made(&self) -> std::sync::MutexGuard<'_, std::collections::HashMap<(u64, u32), Case>> {
        self.made
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The random input for a seed and size, or what went wrong making it.
    pub(crate) async fn input(
        &self,
        runtime: &Runtime,
        seed: u64,
        size: u32,
        cancel: &CancellationToken,
    ) -> Result<Result<String, String>> {
        let args = [seed.to_string(), size.to_string()];
        let made = runtime.run(&self.inputs, &args, "", cancel).await?;
        Ok(if made.succeeded() {
            Ok(made.stdout)
        } else {
            Err(format!(
                "the inputs program {} for seed {seed} and size {size}:\n{}",
                describe(&made),
                made.stderr.trim_end()
            ))
        })
    }

    /// A random input and the brute force's answer to it, or what went wrong making them.
    async fn case(
        &self,
        runtime: &Runtime,
        seed: u64,
        size: u32,
        cancel: &CancellationToken,
    ) -> Result<Result<Case, String>> {
        let cached = self.made().get(&(seed, size)).cloned();
        if let Some(case) = cached {
            return Ok(Ok(case));
        }
        let input = match self.input(runtime, seed, size, cancel).await? {
            Ok(input) => input,
            Err(problem) => return Ok(Err(problem)),
        };
        let answered = runtime.run(&self.brute_force, &[], &input, cancel).await?;
        if !answered.succeeded() {
            return Ok(Err(format!(
                "the brute force {} on the input from seed {seed} and size {size}:\n{}\n{}",
                describe(&answered),
                input.trim_end(),
                answered.stderr.trim_end()
            )));
        }
        let case = Case {
            input,
            output: answered.stdout,
        };
        self.made().insert((seed, size), case.clone());
        Ok(Ok(case))
    }
}

/// The seeds and sizes of `count` random inputs, from the smallest up.
pub fn random_inputs(count: u32) -> impl Iterator<Item = (u64, u32)> {
    (0..count).map(move |i| {
        let size = 1 + (u64::from(i) * u64::from(MAX_SIZE) / u64::from(count.max(1))) as u32;
        (u64::from(i), size.min(MAX_SIZE))
    })
}

/// Runs a solution on everything: the examples, `random` random inputs compared with the brute
/// force, and the hidden tests, stopping at the first it gets wrong. The oracle's own failures,
/// such as a brute force that crashes, are errors in the item rather than the solution.
pub async fn grade(
    runtime: &Runtime,
    coding: &Coding,
    oracle: &Oracle,
    language: Language,
    code: &str,
    random: u32,
    cancel: &CancellationToken,
) -> Result<Result<Graded, String>> {
    let program = match build_solution(runtime, language, code, cancel).await? {
        Ok(program) => program,
        Err(graded) => return Ok(Ok(graded)),
    };
    let total = coding.examples.len() + random as usize + coding.tests.len();
    let mut results: Vec<CaseResult> = Vec::new();
    let finished = |results: Vec<CaseResult>| Ok(Ok(Graded::Ran { results, total }));

    for (index, example) in coding.examples.iter().enumerate() {
        let result = run_case(
            runtime,
            &program,
            CaseRef::Example { index },
            example,
            cancel,
        )
        .await?;
        let passed = result.passed;
        results.push(result);
        if !passed {
            return finished(results);
        }
    }

    let inputs: Vec<(u64, u32)> = random_inputs(random).collect();
    for chunk in inputs.chunks(at_once()) {
        let runs = chunk.iter().map(|&(seed, size)| {
            let program = &program;
            async move {
                let case = match oracle.case(runtime, seed, size, cancel).await? {
                    Ok(case) => case,
                    Err(problem) => return Ok(Err(problem)),
                };
                let result = run_case(
                    runtime,
                    program,
                    CaseRef::Random { seed, size },
                    &case,
                    cancel,
                )
                .await?;
                anyhow::Ok(Ok(result))
            }
        });
        for result in futures_util::future::join_all(runs).await {
            let result = match result? {
                Ok(result) => result,
                Err(problem) => return Ok(Err(problem)),
            };
            let passed = result.passed;
            results.push(result);
            if !passed {
                return finished(results);
            }
        }
    }

    for (index, test) in coding.tests.iter().enumerate() {
        let result = run_case(runtime, &program, CaseRef::Test { index }, test, cancel).await?;
        let passed = result.passed;
        results.push(result);
        if !passed {
            return finished(results);
        }
    }
    finished(results)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use workshop_pack::{Content, Pack};

    use super::*;

    fn rising_run() -> Coding {
        let pack = Pack::sample();
        match &pack.item("rising-run").unwrap().content {
            Content::Coding(coding) => coding.clone(),
            _ => panic!("not a coding item"),
        }
    }

    fn runtime(dir: &std::path::Path, timeout: Duration) -> Runtime {
        Runtime {
            scratch: dir.to_owned(),
            environments: Default::default(),
            build_timeout: Duration::from_secs(60),
            run_timeout: timeout,
            sandbox: crate::Sandbox::Unconfined,
        }
    }

    const MAIN: &str =
        "data = [int(x) for x in open(0).read().split()]\nprint(longest_rise(data[1:]))\n";

    #[cfg(unix)]
    #[tokio::test]
    async fn finds_a_small_input_a_wrong_solution_fails_on() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = runtime(dir.path(), Duration::from_secs(30));
        let coding = rising_run();
        let cancel = CancellationToken::new();
        let oracle = Oracle::build(&runtime, &coding, &cancel)
            .await
            .unwrap()
            .unwrap();
        // Right on the examples, but wrong for a single reading.
        let wrong = format!(
            "def longest_rise(readings):\n    best, run = 0, 1\n    for a, b in zip(readings, readings[1:]):\n        run = run + 1 if b > a else 1\n        best = max(best, run)\n    return best\n{MAIN}"
        );
        let examples = run_examples(&runtime, &coding, Language::Python, &wrong, &cancel)
            .await
            .unwrap();
        assert!(examples.passed(), "{examples:?}");
        let graded = grade(
            &runtime,
            &coding,
            &oracle,
            Language::Python,
            &wrong,
            30,
            &cancel,
        )
        .await
        .unwrap()
        .unwrap();
        assert!(!graded.passed());
        let failure = graded.failure().unwrap();
        let CaseRef::Random { size, .. } = failure.case else {
            panic!("failed on {:?}", failure.case);
        };
        assert!(size <= 2, "a large input, of size {size}");
        assert!(
            failure.input.split_whitespace().count() <= 4,
            "{}",
            failure.input
        );
        assert_eq!(failure.expected.trim(), "1");
        let problem = graded.problem().unwrap();
        assert!(
            problem.starts_with("it printed the wrong answer on the random input"),
            "{problem}"
        );

        let right = &coding.reference_in(Language::Python).unwrap().text;
        let graded = grade(
            &runtime,
            &coding,
            &oracle,
            Language::Python,
            right,
            30,
            &cancel,
        )
        .await
        .unwrap()
        .unwrap();
        assert!(graded.passed(), "{:?}", graded.problem());
        let Graded::Ran { results, total } = &graded else {
            panic!("didn't run");
        };
        assert_eq!(*total, coding.examples.len() + 30 + coding.tests.len());
        assert_eq!(results.len(), *total);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn says_when_a_solution_doesnt_build_or_finish() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = runtime(dir.path(), Duration::from_secs(2));
        let coding = rising_run();
        let cancel = CancellationToken::new();
        let broken = run_examples(&runtime, &coding, Language::Rust, "fn main() {", &cancel)
            .await
            .unwrap();
        assert!(matches!(broken, Graded::BuildFailed { .. }), "{broken:?}");
        assert!(broken.problem().unwrap().starts_with("it doesn't build"));
        let forever = format!("def longest_rise(readings):\n    while True:\n        pass\n{MAIN}");
        let slow = run_examples(&runtime, &coding, Language::Python, &forever, &cancel)
            .await
            .unwrap();
        assert!(
            slow.problem()
                .unwrap()
                .starts_with("it took too long on example 1")
        );
        let crash = format!("def longest_rise(readings):\n    raise NotImplementedError\n{MAIN}");
        let crashed = run_examples(&runtime, &coding, Language::Python, &crash, &cancel)
            .await
            .unwrap();
        let problem = crashed.problem().unwrap();
        assert!(problem.starts_with("it crashed on example 1"), "{problem}");
        assert!(problem.contains("NotImplementedError"), "{problem}");
    }

    #[test]
    fn makes_random_inputs_from_small_to_large() {
        let inputs: Vec<(u64, u32)> = random_inputs(20).collect();
        assert_eq!(inputs[0], (0, 1));
        assert_eq!(inputs[19].1, MAX_SIZE);
        assert!(inputs.windows(2).all(|pair| pair[0].1 <= pair[1].1));
        assert_eq!(random_inputs(1).collect::<Vec<_>>(), [(0, 1)]);
        let few: Vec<u32> = random_inputs(3).map(|(_, size)| size).collect();
        assert_eq!(few, [1, 4, 7]);
    }
}
