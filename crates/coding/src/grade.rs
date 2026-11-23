//! Running a solution to a coding item: on the examples while it's being written, and on
//! everything when it's submitted, which is also how a pack's reference solutions are checked.
//!
//! A submission runs on the examples, then on random inputs compared with the brute force's
//! answers, from the smallest inputs up, then on the hidden tests. So when it's wrong, the input
//! it's shown failing on is as small as could be found, which makes it easier to work through.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use workshop_pack::code::MAX_SIZE;
use workshop_pack::{Case, Coding, Language, Part, output};
use workshop_runner::{Ending, MAX_OUTPUT_BYTES, size};

use crate::programs::{Built, Flavour, Program, Run, Runtime};

/// How many random inputs are run at once: one per processor, as each is a process or two.
fn at_once() -> usize {
    std::thread::available_parallelism().map_or(4, |n| n.get())
}

/// Which of an item's cases something ran on. For a problem in parts, `part` says which part's,
/// counting from 0; it's `None` for a problem in one part.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CaseRef {
    /// One of the examples the learner sees, counting from 0.
    Example {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        part: Option<usize>,
        index: usize,
    },
    /// One of the hidden tests, counting from 0.
    Test {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        part: Option<usize>,
        index: usize,
    },
    /// A random input, made from this seed and size, compared with a part's brute force.
    Random {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        part: Option<usize>,
        seed: u64,
        size: u32,
    },
}

impl CaseRef {
    /// Which part's it is, for a problem in parts.
    pub fn part(&self) -> Option<usize> {
        match self {
            Self::Example { part, .. } | Self::Test { part, .. } | Self::Random { part, .. } => {
                *part
            }
        }
    }

    /// What it is, in words, such as "example 1" or "part 2's test 3".
    pub fn describe(&self) -> String {
        let what = match self {
            Self::Example { index, .. } => format!("example {}", index + 1),
            Self::Test { index, .. } => format!("test {}", index + 1),
            Self::Random { seed, size, .. } => {
                format!("the random input of size {size} from seed {seed}")
            }
        };
        match (self.part(), self) {
            (None, _) => what,
            (Some(part), Self::Random { .. }) => {
                format!("{what}, compared with part {}'s brute force", part + 1)
            }
            (Some(part), _) => format!("part {}'s {what}", part + 1),
        }
    }
}

/// How a run on one case went.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaseResult {
    pub case: CaseRef,
    pub input: String,
    /// What a right solution prints.
    pub expected: String,
    pub run: Run,
    pub passed: bool,
}

/// How a solution did, on whatever it was run on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
                let on = failure.case.describe();
                let what = describe(&failure.run);
                let input = shortened(failure.input.trim_end());
                if failure.run.succeeded() && failure.run.cut_off.is_some() {
                    let expected = if fits(&failure.expected) {
                        String::new()
                    } else {
                        format!(
                            ", which is longer than that itself, at {}",
                            size(failure.expected.len())
                        )
                    };
                    return format!(
                        "it {what} on {on}, where output is cut off, so it couldn't be compared with the expected output{expected}. The input:\n{input}"
                    );
                }
                format!(
                    "it {what} on {on}:\n{input}\nexpected:\n{}\ngot:\n{}{}",
                    shortened(failure.expected.trim_end()),
                    shortened(failure.run.stdout.trim_end()),
                    if failure.run.stderr.trim().is_empty() {
                        String::new()
                    } else {
                        format!("\nstderr:\n{}", shortened(failure.run.stderr.trim_end()))
                    }
                )
            }),
        }
    }
}

/// How a run that didn't print the right answer went wrong, such as "crashed".
pub fn describe(run: &Run) -> String {
    match (&run.ending, run.cut_off) {
        (Ending::TimedOut, _) => "took too long".to_owned(),
        (Ending::Cancelled, _) => "was stopped".to_owned(),
        (Ending::Exited { code: Some(0) }, Some(limit)) => {
            format!("printed more than {}", size(limit))
        }
        (Ending::Exited { code: Some(0) }, None) => "printed the wrong answer".to_owned(),
        (Ending::Exited { .. }, _) => "crashed".to_owned(),
    }
}

/// Whether a right solution can print `expected` without its output being cut off: whether
/// its lines, without the whitespace that isn't compared, and a newline at the end, fit.
pub fn fits(expected: &str) -> bool {
    output::normalise(expected).len() < MAX_OUTPUT_BYTES
}

/// The most of a program's input or output that's shown, as a hidden test's can be far bigger
/// than anyone can usefully read, least of all on a phone.
const SHOWN_CHARS: usize = 4000;

/// `text`, or its start if it's longer than is worth showing, saying how much more there is.
pub fn shortened(text: &str) -> String {
    match text.char_indices().nth(SHOWN_CHARS) {
        Some((end, _)) => format!(
            "{}\n… and {} more characters",
            &text[..end],
            text.chars().count() - SHOWN_CHARS
        ),
        None => text.to_owned(),
    }
}

/// Builds a solution, or one of the item's own, or says why it can't be run: a program, or in
/// API mode, a module, which Workshop's driver imports and calls.
pub async fn build_solution(
    runtime: &Runtime,
    coding: &Coding,
    language: Language,
    code: &str,
    cancel: &CancellationToken,
) -> Result<Result<Program, Graded>> {
    let built = match &coding.api {
        None => {
            runtime
                .build(language, code, Flavour::Plain, cancel)
                .await?
        }
        Some(api) => {
            let driver = crate::api::driver(api, language)?;
            runtime
                .build_with(
                    language,
                    &driver,
                    &[(crate::api::MODULE, code)],
                    Flavour::Plain,
                    cancel,
                )
                .await?
        }
    };
    Ok(match built {
        Built::Ready(program) => Ok(program),
        Built::Failed { errors, .. } => Err(Graded::BuildFailed { errors }),
        Built::Unavailable(reason) => Err(Graded::Unavailable { reason }),
    })
}

async fn run_case(
    runtime: &Runtime,
    coding: &Coding,
    program: &Program,
    case: CaseRef,
    known: &Case,
    cancel: &CancellationToken,
) -> Result<CaseResult> {
    let run = runtime.run(program, &[], &known.input, cancel).await?;
    let passed = run.printed_in_full() && coding.same_output(&known.output, &run.stdout);
    Ok(CaseResult {
        case,
        input: known.input.clone(),
        expected: known.output.clone(),
        run,
        passed,
    })
}

/// The cases of a kind that apply once the learner is on `part`, from the earliest part's, with
/// which case each is.
fn applying(
    coding: &Coding,
    part: usize,
    cases: fn(&Part) -> &Vec<Case>,
    case: fn(Option<usize>, usize) -> CaseRef,
) -> Vec<(CaseRef, &Case)> {
    coding
        .applying(part)
        .into_iter()
        .flat_map(|p| {
            let which = coding.in_parts().then_some(p);
            cases(&coding.parts[p])
                .iter()
                .enumerate()
                .map(move |(index, known)| (case(which, index), known))
        })
        .collect()
}

/// The examples that apply once the learner is on `part`: its own, and those of the parts
/// before it whose requirements still hold.
pub fn examples(coding: &Coding, part: usize) -> Vec<(CaseRef, &Case)> {
    applying(
        coding,
        part,
        |p| &p.examples,
        |part, index| CaseRef::Example { part, index },
    )
}

fn tests(coding: &Coding, part: usize) -> Vec<(CaseRef, &Case)> {
    applying(
        coding,
        part,
        |p| &p.tests,
        |part, index| CaseRef::Test { part, index },
    )
}

/// A part's own examples, without the earlier parts'.
pub fn own_examples(coding: &Coding, part: usize) -> Vec<(CaseRef, &Case)> {
    let which = coding.in_parts().then_some(part);
    coding.parts[part]
        .examples
        .iter()
        .enumerate()
        .map(|(index, known)| (CaseRef::Example { part: which, index }, known))
        .collect()
}

/// Runs a solution on the examples that apply at `part`, all of them, whichever it gets wrong.
pub async fn run_examples(
    runtime: &Runtime,
    coding: &Coding,
    part: usize,
    language: Language,
    code: &str,
    cancel: &CancellationToken,
) -> Result<Graded> {
    run_all(
        runtime,
        coding,
        examples(coding, part),
        language,
        code,
        cancel,
    )
    .await
}

/// Runs a solution on `cases`, all of them, whichever it gets wrong.
pub async fn run_all(
    runtime: &Runtime,
    coding: &Coding,
    cases: Vec<(CaseRef, &Case)>,
    language: Language,
    code: &str,
    cancel: &CancellationToken,
) -> Result<Graded> {
    let program = match build_solution(runtime, coding, language, code, cancel).await? {
        Ok(program) => program,
        Err(graded) => return Ok(graded),
    };
    let mut results = Vec::new();
    for (case, known) in cases {
        results.push(run_case(runtime, coding, &program, case, known, cancel).await?);
    }
    Ok(Graded::Ran {
        total: results.len(),
        results,
    })
}

/// A part's brute force and inputs program, built, for comparing solutions with on random
/// inputs, and the random cases made with them so far, which are the same for every solution.
pub struct Oracle {
    /// The part whose they are.
    part: usize,
    brute_force: Program,
    inputs: Program,
    made: std::sync::Mutex<std::collections::HashMap<(u64, u32), Case>>,
}

impl Oracle {
    /// Builds a part's brute force and inputs program, or says why they can't be.
    pub async fn build(
        runtime: &Runtime,
        coding: &Coding,
        part: usize,
        cancel: &CancellationToken,
    ) -> Result<Result<Self, String>> {
        let brute = coding
            .parts
            .get(part)
            .and_then(|p| p.brute_force.as_ref())
            .with_context(|| format!("part {} has no brute force", part + 1))?;
        let brute_force = match build_solution(
            runtime,
            coding,
            brute.program.language,
            &brute.program.text,
            cancel,
        )
        .await?
        {
            Ok(program) => program,
            Err(Graded::BuildFailed { errors }) => {
                return Ok(Err(format!(
                    "{} doesn't build:\n{errors}",
                    brute.program.file
                )));
            }
            Err(Graded::Unavailable { reason }) => return Ok(Err(reason)),
            Err(Graded::Ran { .. }) => unreachable!("building doesn't run anything"),
        };
        let inputs = match runtime
            .build(
                brute.inputs.language,
                &brute.inputs.text,
                Flavour::Plain,
                cancel,
            )
            .await?
        {
            Built::Ready(program) => program,
            Built::Failed { errors, .. } => {
                return Ok(Err(format!(
                    "{} doesn't build:\n{errors}",
                    brute.inputs.file
                )));
            }
            Built::Unavailable(reason) => return Ok(Err(reason)),
        };
        Ok(Ok(Self {
            part,
            brute_force,
            inputs,
            made: std::sync::Mutex::default(),
        }))
    }

    /// The part whose brute force it is, counting from 0.
    pub fn part(&self) -> usize {
        self.part
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
        Ok(if made.printed_in_full() {
            Ok(made.stdout)
        } else if let (true, Some(limit)) = (made.succeeded(), made.cut_off) {
            Err(format!(
                "the inputs program printed more than {} for seed {seed} and size {size}, where output is cut off, so the input it made can't be used; keep inputs smaller than that",
                workshop_runner::size(limit)
            ))
        } else {
            Err(format!(
                "the inputs program {} for seed {seed} and size {size}:\n{}",
                describe(&made),
                shortened(made.stderr.trim_end())
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
                shortened(input.trim_end()),
                shortened(answered.stderr.trim_end())
            )));
        }
        if let Some(limit) = answered.cut_off {
            return Ok(Err(format!(
                "the brute force printed more than {} on the input from seed {seed} and size {size}, where output is cut off, so its answer can't be compared with; keep inputs small enough for their answers to be shorter than that",
                workshop_runner::size(limit)
            )));
        }
        let case = Case {
            input,
            output: answered.stdout,
        };
        self.made().insert((seed, size), case.clone());
        Ok(Ok(case))
    }

    /// Generates `count` deterministic random `(input, expected)` cases from this oracle.
    pub async fn generate_cases(
        &self,
        runtime: &Runtime,
        count: u32,
        cancel: &CancellationToken,
    ) -> Result<Result<Vec<OracleCase>, String>> {
        let mut out = Vec::with_capacity(count as usize);
        for (seed, size) in random_inputs(count) {
            let case = match self.case(runtime, seed, size, cancel).await? {
                Ok(case) => case,
                Err(problem) => return Ok(Err(problem)),
            };
            out.push(OracleCase {
                seed,
                size,
                input: case.input,
                output: case.output,
            });
        }
        Ok(Ok(out))
    }
}

/// A precomputed deterministic random test case from an item's inputs + brute-force oracle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OracleCase {
    pub seed: u64,
    pub size: u32,
    pub input: String,
    pub output: String,
}

/// The seeds and sizes of `count` random inputs, from the smallest up.
pub fn random_inputs(count: u32) -> impl Iterator<Item = (u64, u32)> {
    (0..count).map(move |i| {
        let size = 1 + (u64::from(i) * u64::from(MAX_SIZE) / u64::from(count.max(1))) as u32;
        (u64::from(i), size.min(MAX_SIZE))
    })
}

/// Runs a solution on everything that applies once the learner is on `part`: the examples,
/// `random` random inputs compared with each brute force in `oracles`, and the hidden tests,
/// stopping at the first it gets wrong. `oracles` must be those of `Coding::compared_with`. The
/// oracles' own failures, such as a brute force that crashes, are errors in the item rather than
/// the solution.
#[allow(clippy::too_many_arguments)]
pub async fn grade(
    runtime: &Runtime,
    coding: &Coding,
    oracles: &[&Oracle],
    part: usize,
    language: Language,
    code: &str,
    random: u32,
    cancel: &CancellationToken,
) -> Result<Result<Graded, String>> {
    let expected = coding.compared_with(part);
    let given: Vec<usize> = oracles.iter().map(|oracle| oracle.part).collect();
    if given != expected {
        anyhow::bail!(
            "part {} is compared with the brute forces of parts {expected:?}, not {given:?}",
            part + 1
        );
    }
    let program = match build_solution(runtime, coding, language, code, cancel).await? {
        Ok(program) => program,
        Err(graded) => return Ok(Ok(graded)),
    };
    let examples = examples(coding, part);
    let tests = tests(coding, part);
    let total = examples.len() + random as usize * oracles.len() + tests.len();
    let mut results: Vec<CaseResult> = Vec::new();
    let finished = |results: Vec<CaseResult>| Ok(Ok(Graded::Ran { results, total }));

    for (case, example) in examples {
        let result = run_case(runtime, coding, &program, case, example, cancel).await?;
        let passed = result.passed;
        results.push(result);
        if !passed {
            return finished(results);
        }
    }

    let inputs: Vec<(u64, u32)> = random_inputs(random).collect();
    for oracle in oracles {
        let which = coding.in_parts().then_some(oracle.part);
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
                        coding,
                        program,
                        CaseRef::Random {
                            part: which,
                            seed,
                            size,
                        },
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
    }

    for (case, test) in tests {
        let result = run_case(runtime, coding, &program, case, test, cancel).await?;
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
            tools: Default::default(),
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
        let oracle = Oracle::build(&runtime, &coding, 0, &cancel)
            .await
            .unwrap()
            .unwrap();
        // Right on the examples, but wrong for a single reading.
        let wrong = format!(
            "def longest_rise(readings):\n    best, run = 0, 1\n    for a, b in zip(readings, readings[1:]):\n        run = run + 1 if b > a else 1\n        best = max(best, run)\n    return best\n{MAIN}"
        );
        let examples = run_examples(&runtime, &coding, 0, Language::Python, &wrong, &cancel)
            .await
            .unwrap();
        assert!(examples.passed(), "{examples:?}");
        let graded = grade(
            &runtime,
            &coding,
            &[&oracle],
            0,
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

        let right = &coding.reference_in(0, Language::Python).unwrap().text;
        let graded = grade(
            &runtime,
            &coding,
            &[&oracle],
            0,
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
        assert_eq!(
            *total,
            coding.parts[0].examples.len() + 30 + coding.parts[0].tests.len()
        );
        assert_eq!(results.len(), *total);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn says_when_a_solution_doesnt_build_or_finish() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = runtime(dir.path(), Duration::from_secs(2));
        let coding = rising_run();
        let cancel = CancellationToken::new();
        let broken = run_examples(&runtime, &coding, 0, Language::Rust, "fn main() {", &cancel)
            .await
            .unwrap();
        assert!(matches!(broken, Graded::BuildFailed { .. }), "{broken:?}");
        assert!(broken.problem().unwrap().starts_with("it doesn't build"));
        let forever = format!("def longest_rise(readings):\n    while True:\n        pass\n{MAIN}");
        let slow = run_examples(&runtime, &coding, 0, Language::Python, &forever, &cancel)
            .await
            .unwrap();
        assert!(
            slow.problem()
                .unwrap()
                .starts_with("it took too long on example 1")
        );
        let crash = format!("def longest_rise(readings):\n    raise NotImplementedError\n{MAIN}");
        let crashed = run_examples(&runtime, &coding, 0, Language::Python, &crash, &cancel)
            .await
            .unwrap();
        let problem = crashed.problem().unwrap();
        assert!(problem.starts_with("it crashed on example 1"), "{problem}");
        assert!(problem.contains("NotImplementedError"), "{problem}");
    }

    fn text_buffer() -> Coding {
        let pack = Pack::sample();
        match &pack.item("text-buffer").unwrap().content {
            Content::Coding(coding) => coding.clone(),
            _ => panic!("not a coding item"),
        }
    }

    /// In API mode, the driver calls the learner's class, and says plainly what's wrong when it
    /// can't: a method missing, or a result that can't be compared.
    #[cfg(unix)]
    #[tokio::test]
    async fn calls_a_class_in_api_mode_through_the_driver() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = runtime(dir.path(), Duration::from_secs(30));
        let cancel = CancellationToken::new();
        let coding = text_buffer();
        let examples = |code: String, part: usize| {
            let runtime = &runtime;
            let coding = &coding;
            let cancel = &cancel;
            async move {
                run_examples(runtime, coding, part, Language::Python, &code, cancel)
                    .await
                    .unwrap()
            }
        };
        // What the learner's code prints goes to stderr, so it isn't taken for a result.
        let chatty = coding.parts[0].reference[0].text.replace(
            "    def text(self) -> str:\n",
            "    def text(self) -> str:\n        print(\"debugging\")\n",
        );
        let ran = examples(chatty, 0).await;
        assert!(ran.passed(), "{:?}", ran.problem());
        let Graded::Ran { results, .. } = &ran else {
            panic!("didn't run");
        };
        assert_eq!(results[0].run.stderr.trim(), "debugging");

        // Part 1's code, kept for part 2, runs part 1's example and fails part 2's.
        let part_one = coding.parts[0].reference[0].text.clone();
        let ran = examples(part_one.clone(), 1).await;
        let Graded::Ran { results, total } = &ran else {
            panic!("didn't run");
        };
        assert_eq!(*total, 2);
        assert!(results[0].passed);
        assert_eq!(
            results[0].case,
            CaseRef::Example {
                part: Some(0),
                index: 0
            }
        );
        assert_eq!(
            results[1].case,
            CaseRef::Example {
                part: Some(1),
                index: 0
            }
        );
        let problem = ran.problem().unwrap();
        assert!(
            problem.starts_with("it crashed on part 2's example 1"),
            "{problem}"
        );
        assert!(
            problem.contains("TextBuffer has no undo to call"),
            "{problem}"
        );

        let returns_a_set = part_one.replace(
            "        return \"\".join(self.chars)",
            "        return set(self.chars)",
        );
        let problem = examples(returns_a_set, 0).await.problem().unwrap();
        assert!(problem.contains("text returned {"), "{problem}");
        assert!(problem.contains("which can't be compared"), "{problem}");
        let problem = examples("class Buffer:\n    pass\n".to_owned(), 0)
            .await
            .problem()
            .unwrap();
        assert!(problem.contains("There's no class TextBuffer"), "{problem}");
    }

    /// Comparing with a brute force on random inputs works in API mode as it does otherwise,
    /// with the inputs program making calls rather than input to read.
    #[cfg(unix)]
    #[tokio::test]
    async fn compares_a_class_with_the_brute_force_on_random_calls() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = runtime(dir.path(), Duration::from_secs(30));
        let cancel = CancellationToken::new();
        let coding = text_buffer();
        // Undo that forgets deletes of nothing passes the examples, but not every random call.
        let careless = coding.parts[1].reference[0].text.replace(
            "        removed = self.remove(count)\n        self.done.append((\"delete\", removed))",
            "        removed = self.remove(count)\n        if removed:\n            self.done.append((\"delete\", removed))",
        );
        assert_ne!(careless, coding.parts[1].reference[0].text);
        let mut oracles = Vec::new();
        for part in coding.compared_with(1) {
            oracles.push(
                Oracle::build(&runtime, &coding, part, &cancel)
                    .await
                    .unwrap()
                    .unwrap(),
            );
        }
        let oracles: Vec<&Oracle> = oracles.iter().collect();
        let graded = grade(
            &runtime,
            &coding,
            &oracles,
            1,
            Language::Python,
            &careless,
            100,
            &cancel,
        )
        .await
        .unwrap()
        .unwrap();
        let failure = graded.failure().unwrap();
        assert!(
            matches!(failure.case, CaseRef::Random { part: Some(1), .. }),
            "{:?}",
            failure.case
        );
        assert!(
            failure.input.starts_with("[\"TextBuffer\"]\n"),
            "{}",
            failure.input
        );
        // Asked for oracles that don't apply at the part, it refuses.
        assert!(
            grade(
                &runtime,
                &coding,
                &oracles[..1],
                1,
                Language::Python,
                &careless,
                1,
                &cancel
            )
            .await
            .is_err()
        );
    }

    /// A program printing `bytes` of a's, then a newline.
    fn prints(bytes: usize) -> String {
        format!("import sys\nsys.stdout.write('a' * {bytes} + '\\n')\n")
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn says_output_was_cut_off_rather_than_comparing_it() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = runtime(dir.path(), Duration::from_secs(30));
        let cancel = CancellationToken::new();
        let mut coding = rising_run();
        coding.parts[0].examples.truncate(1);
        let long = 100 * 1024;
        for (expected, says) in [
            ("a".to_owned(), None),
            (
                "a".repeat(long),
                Some(", which is longer than that itself, at 100 KiB"),
            ),
        ] {
            coding.parts[0].examples[0].output = expected;
            let graded = run_examples(
                &runtime,
                &coding,
                0,
                Language::Python,
                &prints(long),
                &cancel,
            )
            .await
            .unwrap();
            let failure = graded.failure().unwrap();
            assert_eq!(failure.run.cut_off, Some(MAX_OUTPUT_BYTES));
            assert_eq!(describe(&failure.run), "printed more than 64 KiB");
            let problem = graded.problem().unwrap();
            assert!(
                problem.starts_with(&format!(
                    "it printed more than 64 KiB on example 1, where output is cut off, so it couldn't be compared with the expected output{}. The input:\n",
                    says.unwrap_or_default()
                )),
                "{problem}"
            );
            assert!(problem.len() < 1000, "{problem}");
        }
        // Everything a program prints up to the limit is compared.
        coding.parts[0].examples[0].output = "a".repeat(MAX_OUTPUT_BYTES - 1);
        let graded = run_examples(
            &runtime,
            &coding,
            0,
            Language::Python,
            &prints(MAX_OUTPUT_BYTES - 1),
            &cancel,
        )
        .await
        .unwrap();
        assert!(graded.passed(), "{:?}", graded.problem());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_oracle_that_prints_too_much_is_the_item_s_fault() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = runtime(dir.path(), Duration::from_secs(30));
        let cancel = CancellationToken::new();
        let right = rising_run();
        let reference = right
            .reference_in(0, Language::Python)
            .unwrap()
            .text
            .clone();
        let source = |text: String| workshop_pack::Source {
            file: "program.py".to_owned(),
            language: Language::Python,
            text,
        };
        let with = |change: &dyn Fn(&mut workshop_pack::BruteForce)| {
            let mut coding = right.clone();
            change(coding.parts[0].brute_force.as_mut().unwrap());
            coding
        };
        let long = 100 * 1024;
        for (coding, says) in [
            (
                with(&|brute| brute.program = source(prints(long))),
                "the brute force printed more than 64 KiB on the input from seed 0 and size 1, where output is cut off",
            ),
            (
                with(&|brute| brute.inputs = source(prints(long))),
                "the inputs program printed more than 64 KiB for seed 0 and size 1, where output is cut off",
            ),
        ] {
            let oracle = Oracle::build(&runtime, &coding, 0, &cancel)
                .await
                .unwrap()
                .unwrap();
            let problem = grade(
                &runtime,
                &coding,
                &[&oracle],
                0,
                Language::Python,
                &reference,
                1,
                &cancel,
            )
            .await
            .unwrap()
            .unwrap_err();
            assert!(problem.starts_with(says), "{problem}");
            assert!(problem.len() < 1000, "{problem}");
        }
    }

    #[test]
    fn shortens_text_too_long_to_read() {
        assert_eq!(shortened("short"), "short");
        let long = "é".repeat(SHOWN_CHARS + 10);
        let shown = shortened(&long);
        assert!(shown.starts_with(&"é".repeat(SHOWN_CHARS)));
        assert!(shown.ends_with("\n… and 10 more characters"), "{shown}");
    }

    #[test]
    fn expected_output_fits_if_a_right_solution_can_print_it_in_full() {
        assert!(fits(&"a".repeat(MAX_OUTPUT_BYTES - 1)));
        // Whitespace that isn't compared doesn't count.
        assert!(fits(&format!(
            "{}   \n\n\n",
            "a".repeat(MAX_OUTPUT_BYTES - 1)
        )));
        // With its newline, it's more than is kept.
        assert!(!fits(&"a".repeat(MAX_OUTPUT_BYTES)));
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
