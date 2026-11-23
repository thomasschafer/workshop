//! `workshop pack check` for the items with programs: a coding item's reference solutions must
//! pass its tests and agree with its brute force on random inputs, and a reading item's code
//! must do what its answer says, such as print what the learner is asked to work out.

use anyhow::Result;
use tokio_util::sync::CancellationToken;
use workshop_pack::{
    BruteForce, Coding, Content, Item, Language, Reading, ReadingCheck, Verdict, output,
};

use crate::grade::{self, CaseRef, Graded, Oracle, describe};
use crate::programs::{Built, Flavour, Run, Runtime};
use workshop_runner::{Ending, MAX_OUTPUT_BYTES, size};

/// Checks items' programs by building and running them, for `Pack::check`.
pub struct Checker {
    pub runtime: Runtime,
    pub unconfined: Unconfined,
}

/// What to do with items' programs when the runtime has no sandbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unconfined {
    /// Run them anyway, for programs the user has chosen to trust.
    Run,
    /// Skip the item, as it can't be shown to be right here.
    Skip,
}

impl workshop_pack::Programs for Checker {
    fn check<'a>(
        &'a self,
        item: &'a Item,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Verdict> + Send + 'a>> {
        Box::pin(async move {
            // Checked even where its programs can't be run, as it needs nothing run.
            if let Content::Coding(coding) = &item.content
                && let Some(problem) = expects_too_much(coding)
            {
                return Verdict::Failed(problem);
            }
            let has_programs = matches!(item.content, Content::Coding(_) | Content::Reading(_));
            if has_programs
                && !self.runtime.sandbox.confines()
                && self.unconfined == Unconfined::Skip
            {
                return Verdict::Skipped(
                    "there's no sandbox here to run its programs in (sandbox-exec on macOS, or bubblewrap on Linux)"
                        .to_owned(),
                );
            }
            let cancel = CancellationToken::new();
            let checked = match &item.content {
                Content::Coding(coding) => check_coding(&self.runtime, coding, &cancel).await,
                Content::Reading(reading) => check_reading(&self.runtime, reading, &cancel).await,
                _ => Ok(Verdict::Passed("has no programs to run".to_owned())),
            };
            checked.unwrap_or_else(|err| Verdict::Failed(format!("{err:#}")))
        })
    }
}

/// Says which of a coding item's examples and tests expect more output than a program can print
/// before it's cut off, as no solution could pass them.
fn expects_too_much(coding: &Coding) -> Option<String> {
    let long: Vec<String> = coding
        .parts
        .iter()
        .enumerate()
        .flat_map(|(p, part)| {
            let which = coding.in_parts().then_some(p);
            let examples = part
                .examples
                .iter()
                .enumerate()
                .map(move |(index, case)| (CaseRef::Example { part: which, index }, case));
            let tests = part
                .tests
                .iter()
                .enumerate()
                .map(move |(index, case)| (CaseRef::Test { part: which, index }, case));
            examples.chain(tests)
        })
        .filter(|(_, case)| !grade::fits(&case.output))
        .map(|(which, case)| {
            format!(
                "{} expects {} of output",
                which.describe(),
                size(case.output.len())
            )
        })
        .collect();
    (!long.is_empty()).then(|| {
        format!(
            "{}, more than the {} a program's output is cut off at, so no solution can pass {}; keep every expected output under that",
            long.join(", and "),
            size(MAX_OUTPUT_BYTES),
            if long.len() == 1 { "it" } else { "them" }
        )
    })
}

/// Checks a coding item, part by part: at each, its reference solutions must pass every example
/// and test that applies, its own and the earlier parts' that it doesn't replace, and agree with
/// every brute force that applies on random inputs. Each brute force must pass its part's own
/// examples, and its inputs program must vary with its seed. Then each starter must
/// build, and in API mode, be a module the driver can import.
pub async fn check_coding(
    runtime: &Runtime,
    coding: &Coding,
    cancel: &CancellationToken,
) -> Result<Verdict> {
    let mut oracles: Vec<Option<Oracle>> = Vec::new();
    let mut skipped = Vec::new();
    for part in 0..coding.parts.len() {
        let at = |problem: String| {
            if coding.in_parts() {
                format!("part {}: {problem}", part + 1)
            } else {
                problem
            }
        };
        let oracle = match &coding.parts[part].brute_force {
            None => None,
            Some(brute) => {
                let oracle = match Oracle::build(runtime, coding, part, cancel).await? {
                    Ok(oracle) => oracle,
                    Err(problem) => {
                        return Ok(unavailable_or_failed(runtime, brute, at(problem)));
                    }
                };
                // The brute force is what everything else is compared with, so it has to be
                // right too, on its part's examples at least: the tests can be too big for it
                // to finish, and a later part's brute force need only do what that part adds.
                let program = &brute.program;
                let graded = grade::run_all(
                    runtime,
                    coding,
                    grade::own_examples(coding, part),
                    program.language,
                    &program.text,
                    cancel,
                )
                .await?;
                if let Some(problem) = graded.problem() {
                    return Ok(Verdict::Failed(at(format!(
                        "the brute force, {}, is wrong: {problem}",
                        program.file
                    ))));
                }
                if let Some(problem) = inputs_vary(runtime, &oracle, cancel).await? {
                    return Ok(Verdict::Failed(at(problem)));
                }
                Some(oracle)
            }
        };
        oracles.push(oracle);
        let compared: Vec<&Oracle> = coding
            .compared_with(part)
            .into_iter()
            .map(|p| {
                oracles[p]
                    .as_ref()
                    .expect("built for each part with a brute force")
            })
            .collect();
        for reference in &coding.parts[part].reference {
            let graded = grade::grade(
                runtime,
                coding,
                &compared,
                part,
                reference.language,
                &reference.text,
                coding.random_inputs,
                cancel,
            )
            .await?;
            match graded {
                Err(problem) => return Ok(Verdict::Failed(at(problem))),
                Ok(Graded::Unavailable { reason }) => {
                    skipped.push(format!("{}: {reason}", reference.file));
                }
                Ok(graded) => {
                    // A build that fails says why itself, which may be the toolchain rather
                    // than the solution, such as a missing linker.
                    if let Some(problem) = graded.problem() {
                        let what = if matches!(graded, Graded::BuildFailed { .. }) {
                            ":"
                        } else {
                            " is wrong:"
                        };
                        return Ok(Verdict::Failed(at(format!(
                            "{}{what} {problem}",
                            reference.file
                        ))));
                    }
                }
            }
        }
    }
    for starter in &coding.starter {
        match grade::build_solution(runtime, coding, starter.language, &starter.text, cancel)
            .await?
        {
            Ok(program) => {
                if coding.api.is_some()
                    && let Some(problem) = imports(runtime, coding, &program, cancel).await?
                {
                    return Ok(Verdict::Failed(format!(
                        "the starter {} {problem}",
                        starter.file
                    )));
                }
            }
            Err(Graded::BuildFailed { errors }) => {
                return Ok(Verdict::Failed(format!(
                    "the starter {} doesn't build, and should, unfinished as it is:\n{errors}",
                    starter.file
                )));
            }
            Err(Graded::Unavailable { reason }) => {
                skipped.push(format!("{}: {reason}", starter.file));
            }
            Err(Graded::Ran { .. }) => unreachable!("building doesn't run anything"),
        }
    }
    if !skipped.is_empty() {
        return Ok(Verdict::Skipped(format!(
            "not everything could be run here: {}",
            skipped.join("; ")
        )));
    }
    Ok(Verdict::Passed(passed(coding)))
}

/// What a coding item that passes its check passed.
fn passed(coding: &Coding) -> String {
    let references = |part: &workshop_pack::Part| {
        format!(
            "{} {}",
            if part.reference.len() == 1 {
                "the reference passes"
            } else {
                "the references pass"
            },
            part.reference
                .iter()
                .map(|r| r.language.name())
                .collect::<Vec<_>>()
                .join(" and "),
        )
    };
    if !coding.in_parts() {
        let part = &coding.parts[0];
        return format!(
            "{} {} examples, {} tests and {} random inputs against the brute force",
            references(part),
            part.examples.len(),
            part.tests.len(),
            coding.random_inputs,
        );
    }
    format!(
        "in each of its {} parts, {} every example and test that applies, and {} random inputs against each brute force that applies",
        coding.parts.len(),
        references(&coding.parts[coding.last()]),
        coding.random_inputs,
    )
}

/// Says if a module in API mode can't be imported by the driver, or doesn't define everything
/// the first part's examples and tests call, without calling any of it.
async fn imports(
    runtime: &Runtime,
    coding: &Coding,
    program: &crate::programs::Program,
    cancel: &CancellationToken,
) -> Result<Option<String>> {
    let first = &coding.parts[0];
    let calls: String = first
        .examples
        .iter()
        .chain(&first.tests)
        .map(|case| case.input.as_str())
        .collect();
    let run = runtime
        .run(program, &["--names".to_owned()], &calls, cancel)
        .await?;
    Ok((!run.succeeded()).then(|| {
        let api = coding
            .api
            .as_ref()
            .expect("only modules in API mode are imported");
        format!(
            "{} when it's imported, and should define {}, with everything part 1 calls, unfinished as it is:\n{}",
            describe(&run),
            api.describe(),
            grade::shortened(run.stderr.trim_end())
        )
    }))
}

/// A program that can't be built here is skipped; one that's broken is a failure.
fn unavailable_or_failed(runtime: &Runtime, brute: &BruteForce, problem: String) -> Verdict {
    let unavailable = [&brute.program, &brute.inputs].iter().any(|source| {
        runtime
            .find(source.language, crate::programs::needs(source.language))
            .is_none()
    });
    if unavailable {
        Verdict::Skipped(problem)
    } else {
        Verdict::Failed(problem)
    }
}

/// Says if the inputs program makes the same input for every seed, which would make comparing
/// on random inputs pointless, or a different one for the same seed, which would make a failure
/// impossible to look into again.
async fn inputs_vary(
    runtime: &Runtime,
    oracle: &Oracle,
    cancel: &CancellationToken,
) -> Result<Option<String>> {
    let size = workshop_pack::code::MAX_SIZE;
    let mut made = Vec::new();
    for seed in [1, 1, 2] {
        match oracle.input(runtime, seed, size, cancel).await? {
            Ok(input) => made.push(input),
            Err(problem) => return Ok(Some(problem)),
        }
    }
    let [first, again, other] = <[String; 3]>::try_from(made).expect("made three");
    Ok(if first != again {
        Some("the inputs program made two different inputs from the same seed; draw from the seed it's given".to_owned())
    } else if first == other {
        Some("the inputs program made the same input from different seeds".to_owned())
    } else {
        None
    })
}

pub async fn check_reading(
    runtime: &Runtime,
    reading: &Reading,
    cancel: &CancellationToken,
) -> Result<Verdict> {
    if let Err(problem) = reading.check.fits(reading.language) {
        return Ok(Verdict::Failed(problem));
    }
    // Rust code is run as a debug build, as it usually is while it's written, so an overflow
    // panics. C++ is only built with sanitizers when the answer is that they find something, as
    // they change what the code does.
    let flavour = match (reading.language, &reading.check) {
        (Language::Rust, _) | (Language::Cpp, ReadingCheck::SanitizerError) => Flavour::Checked,
        _ => Flavour::Plain,
    };
    let built = runtime
        .build(reading.language, &reading.code, flavour, cancel)
        .await?;
    let program = match (built, &reading.check) {
        (Built::Unavailable(reason), _) => return Ok(Verdict::Skipped(reason)),
        (Built::Failed { .. }, ReadingCheck::CompileError) => {
            return Ok(Verdict::Passed(
                "the code fails to build, as it should".to_owned(),
            ));
        }
        (Built::Failed { errors, .. }, _) => {
            return Ok(Verdict::Failed(format!(
                "the code doesn't build:\n{errors}"
            )));
        }
        (Built::Ready(_), ReadingCheck::CompileError) => {
            return Ok(Verdict::Failed(
                "the code builds, though the answer says it shouldn't".to_owned(),
            ));
        }
        (Built::Ready(_), ReadingCheck::Compiles) => {
            return Ok(Verdict::Passed("the code builds".to_owned()));
        }
        (Built::Ready(program), _) => program,
    };
    let run = runtime.run(&program, &[], "", cancel).await?;
    Ok(match &reading.check {
        ReadingCheck::Prints(expected) => {
            if !run.printed_in_full() {
                Verdict::Failed(format!(
                    "the code {}{}",
                    describe(&run),
                    if run.succeeded() {
                        ", where output is cut off, so it can't be compared with what the answer says it prints".to_owned()
                    } else {
                        format!(":\n{}", grade::shortened(run.stderr.trim_end()))
                    }
                ))
            } else if output::same(expected, &run.stdout) {
                Verdict::Passed("the code prints what the answer says".to_owned())
            } else {
                Verdict::Failed(format!(
                    "the answer says it prints:\n{}\nbut it prints:\n{}",
                    grade::shortened(expected.trim_end()),
                    grade::shortened(run.stdout.trim_end())
                ))
            }
        }
        ReadingCheck::Runs => {
            if run.succeeded() {
                Verdict::Passed("the code runs without an error".to_owned())
            } else {
                Verdict::Failed(format!(
                    "the code {}, though the answer says it runs without an error:\n{}",
                    describe(&run),
                    run.stderr.trim_end()
                ))
            }
        }
        ReadingCheck::SanitizerError => {
            let found = run.stderr.contains("Sanitizer") || run.stderr.contains("runtime error");
            stopped(
                &run,
                found,
                "the sanitizers stop the code",
                "built with sanitizers, the code ran without being stopped by them",
            )
        }
        ReadingCheck::Panics => stopped(
            &run,
            run.stderr.contains("panicked at"),
            "the code panics",
            "the code ran without panicking",
        ),
        ReadingCheck::Raises => stopped(
            &run,
            raised(reading.language, &run),
            "the code stops with an exception",
            "the code ran without stopping with an exception",
        ),
        ReadingCheck::Compiles | ReadingCheck::CompileError => {
            unreachable!("decided once it's built")
        }
    })
}

/// Whether a run stopped with an exception the code didn't catch, as its language reports one.
fn raised(language: Language, run: &Run) -> bool {
    match language {
        Language::Python => run.stderr.contains("Traceback (most recent call last)"),
        // GHC's runtime reports an uncaught exception, such as from `error` or a failed pattern
        // match, as the program's name and the exception, and exits with 1. Running out of heap
        // or stack exits otherwise, with 251 or 2, and isn't an exception the code raised.
        Language::Haskell => {
            run.ending == (Ending::Exited { code: Some(1) })
                && run.stderr.lines().any(|line| line.starts_with("main: "))
        }
        Language::Rust | Language::Cpp => false,
    }
}

/// Whether a run stopped with the error the answer says it should, which `found` says was seen.
fn stopped(run: &Run, found: bool, passed: &str, failed: &str) -> Verdict {
    if run.ending == Ending::TimedOut {
        Verdict::Failed(format!(
            "the code {}, though the answer says it stops with an error",
            describe(run)
        ))
    } else if !run.succeeded() && found {
        Verdict::Passed(format!("{passed}, as the answer says"))
    } else {
        Verdict::Failed(format!(
            "{failed}, though the answer says it should:\n{}",
            run.stderr.trim_end()
        ))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::time::Duration;

    use workshop_pack::{Pack, Verdict};

    use super::*;
    use crate::Sandbox;

    #[tokio::test]
    async fn the_sample_packs_programs_pass_their_checks() {
        let dir = tempfile::tempdir().unwrap();
        let sandbox = Sandbox::detect(&[]).await;
        // Where there's a sandbox, the real toolchains must work inside it.
        assert!(
            sandbox.is_some() || !cfg!(target_os = "macos"),
            "macOS always has a sandbox"
        );
        let checker = Checker {
            runtime: Runtime {
                scratch: dir.path().to_owned(),
                environments: Default::default(),
                build_timeout: Duration::from_secs(60),
                run_timeout: Duration::from_secs(60),
                sandbox: sandbox.unwrap_or(Sandbox::Unconfined),
                tools: Default::default(),
            },
            unconfined: Unconfined::Run,
        };
        let pack = Pack::sample();
        let report = pack.check(&checker).await;
        let failures: Vec<String> = report.failures().iter().map(ToString::to_string).collect();
        assert!(failures.is_empty(), "{failures:#?}");
        let has_cpp = has_cpp(&checker.runtime);
        let has_ghc = checker.runtime.find(Language::Haskell, "ghc").is_some();
        for checked in &report.items {
            match &checked.verdict {
                Verdict::Passed(_) => {}
                // Only C++ and Haskell can be missing where the tests run, as Python and Rust
                // are needed for Workshop's own.
                Verdict::Skipped(reason) => {
                    let item = pack.items.iter().find(|i| i.path == checked.path).unwrap();
                    let languages: Vec<Language> = match &item.content {
                        Content::Reading(reading) => vec![reading.language],
                        Content::Coding(coding) => coding.languages.clone(),
                        _ => Vec::new(),
                    };
                    if languages.contains(&Language::Cpp) {
                        assert!(!has_cpp, "{}: {reason}", checked.path);
                        assert!(reason.contains("no C++ compiler"), "{reason}");
                    } else {
                        assert!(
                            !has_ghc && languages.contains(&Language::Haskell),
                            "{}: {reason}",
                            checked.path
                        );
                        assert!(reason.contains("GHC isn't installed"), "{reason}");
                    }
                }
                Verdict::Failed(_) => unreachable!("listed above"),
            }
        }
    }

    fn has_cpp(runtime: &Runtime) -> bool {
        ["c++", "clang++", "g++"]
            .iter()
            .any(|compiler| runtime.find(Language::Cpp, compiler).is_some())
    }

    #[tokio::test]
    async fn checks_reading_items_in_each_language_by_what_it_means_there() {
        use workshop_pack::Question;
        let dir = tempfile::tempdir().unwrap();
        let runtime = Runtime {
            scratch: dir.path().to_owned(),
            environments: Default::default(),
            build_timeout: Duration::from_secs(60),
            run_timeout: Duration::from_secs(20),
            sandbox: Sandbox::detect(&[]).await.unwrap_or(Sandbox::Unconfined),
            tools: Default::default(),
        };
        let prints = |output: &str| ReadingCheck::Prints(output.to_owned());
        let borrowed_after_move = "fn main() {\n    let a = String::from(\"x\");\n    let b = a;\n    println!(\"{a} {b}\");\n}\n";
        // black_box keeps the compiler from seeing the overflow coming, and refusing to build it.
        let overflows = "fn main() {\n    let x: u8 = 255;\n    println!(\"{}\", x + std::hint::black_box(1));\n}\n";
        let use_after_free = "#include <iostream>\n#include <vector>\nint main() {\n    std::vector<int> v = {1};\n    int& first = v[0];\n    v.push_back(2);\n    std::cout << first << \"\\n\";\n}\n";
        let no_show = "data Colour = Red | Green\n\nmain :: IO ()\nmain = print Red\n";
        let empty_head = "main :: IO ()\nmain = print (head ([] :: [Int]))\n";
        let missing_case =
            "f :: Int -> String\nf 0 = \"zero\"\n\nmain :: IO ()\nmain = putStrLn (f 1)\n";
        let cases: &[(Language, &str, ReadingCheck, bool, &str)] = &[
            (
                Language::Python,
                "print(1 + 2)\n",
                prints("3"),
                true,
                "prints what",
            ),
            (
                Language::Python,
                "print(1 + 2)\n",
                prints("4"),
                false,
                "but it prints",
            ),
            (
                Language::Python,
                "print('a' * 100000)\n",
                prints("a"),
                false,
                "printed more than 64 KiB, where output is cut off, so it can't be compared",
            ),
            (
                Language::Python,
                "x = [1]\n",
                ReadingCheck::Runs,
                true,
                "runs",
            ),
            (
                Language::Python,
                "{}['k']\n",
                ReadingCheck::Runs,
                false,
                "KeyError",
            ),
            (
                Language::Python,
                "{}['k']\n",
                ReadingCheck::Raises,
                true,
                "exception",
            ),
            (
                Language::Python,
                "print(1)\n",
                ReadingCheck::Raises,
                false,
                "without stopping",
            ),
            // A syntax error isn't an exception the code raises as it runs.
            (
                Language::Python,
                "def (:\n",
                ReadingCheck::Raises,
                false,
                "SyntaxError",
            ),
            (
                Language::Python,
                "print(1)\n",
                ReadingCheck::Compiles,
                false,
                "doesn't fit",
            ),
            (
                Language::Python,
                "def (:\n",
                ReadingCheck::CompileError,
                false,
                "doesn't fit",
            ),
            (
                Language::Rust,
                overflows,
                ReadingCheck::Panics,
                true,
                "panics",
            ),
            (
                Language::Rust,
                overflows,
                ReadingCheck::Runs,
                false,
                "overflow",
            ),
            (
                Language::Rust,
                overflows,
                ReadingCheck::Compiles,
                true,
                "builds",
            ),
            (
                Language::Rust,
                "fn main() { println!(\"{}\", 6 * 7); }\n",
                prints("42"),
                true,
                "prints what",
            ),
            (
                Language::Rust,
                "fn main() {}\n",
                ReadingCheck::Panics,
                false,
                "without panicking",
            ),
            (
                Language::Rust,
                borrowed_after_move,
                ReadingCheck::CompileError,
                true,
                "fails to build",
            ),
            (
                Language::Rust,
                borrowed_after_move,
                ReadingCheck::Compiles,
                false,
                "borrow of moved value",
            ),
            (
                Language::Rust,
                "fn main() {}\n",
                ReadingCheck::CompileError,
                false,
                "builds, though",
            ),
            (
                Language::Rust,
                overflows,
                ReadingCheck::SanitizerError,
                false,
                "doesn't fit",
            ),
            (
                Language::Rust,
                overflows,
                ReadingCheck::Raises,
                false,
                "doesn't fit",
            ),
            (
                Language::Cpp,
                use_after_free,
                ReadingCheck::SanitizerError,
                true,
                "sanitizers stop",
            ),
            (
                Language::Cpp,
                "int main() {}\n",
                ReadingCheck::SanitizerError,
                false,
                "without being stopped",
            ),
            (
                Language::Cpp,
                "int main() { return 1; }\n",
                ReadingCheck::Runs,
                false,
                "crashed",
            ),
            (
                Language::Cpp,
                "int main() { x; }\n",
                ReadingCheck::CompileError,
                true,
                "fails to build",
            ),
            (
                Language::Cpp,
                "int main() {}\n",
                ReadingCheck::Panics,
                false,
                "doesn't fit",
            ),
            (
                Language::Cpp,
                "int main() {}\n",
                ReadingCheck::Raises,
                false,
                "doesn't fit",
            ),
            (
                Language::Haskell,
                no_show,
                ReadingCheck::CompileError,
                true,
                "fails to build",
            ),
            (
                Language::Haskell,
                no_show,
                ReadingCheck::Compiles,
                false,
                "No instance for",
            ),
            // A type error is a compile error, never an exception.
            (
                Language::Haskell,
                no_show,
                ReadingCheck::Raises,
                false,
                "doesn't build",
            ),
            (
                Language::Haskell,
                empty_head,
                ReadingCheck::Raises,
                true,
                "exception",
            ),
            (
                Language::Haskell,
                empty_head,
                ReadingCheck::CompileError,
                false,
                "builds, though",
            ),
            (
                Language::Haskell,
                empty_head,
                ReadingCheck::Runs,
                false,
                "empty list",
            ),
            (
                Language::Haskell,
                missing_case,
                ReadingCheck::Raises,
                true,
                "exception",
            ),
            (
                Language::Haskell,
                "main :: IO ()\nmain = error \"no answer\"\n",
                ReadingCheck::Raises,
                true,
                "exception",
            ),
            // Exiting with a failure on purpose isn't an exception it didn't catch.
            (
                Language::Haskell,
                "import System.Exit\n\nmain :: IO ()\nmain = exitWith (ExitFailure 1)\n",
                ReadingCheck::Raises,
                false,
                "without stopping",
            ),
            (
                Language::Haskell,
                "main :: IO ()\nmain = print (take 5 (filter odd (map (* 3) [1 ..])))\n",
                prints("[3,9,15,21,27]"),
                true,
                "prints what",
            ),
            (
                Language::Haskell,
                "main :: IO ()\nmain = pure ()\n",
                ReadingCheck::Runs,
                true,
                "runs",
            ),
            (
                Language::Haskell,
                empty_head,
                ReadingCheck::Panics,
                false,
                "doesn't fit",
            ),
            (
                Language::Haskell,
                empty_head,
                ReadingCheck::SanitizerError,
                false,
                "doesn't fit",
            ),
        ];
        let has_cpp = has_cpp(&runtime);
        let has_ghc = runtime.find(Language::Haskell, "ghc").is_some();
        for (language, code, check, passes, says) in cases {
            let reading = Reading {
                language: *language,
                code: (*code).to_owned(),
                question: Question::Choice {
                    choices: vec!["a".to_owned(), "b".to_owned()],
                    answer: 0,
                },
                check: check.clone(),
                explanation: String::new(),
            };
            let verdict = check_reading(&runtime, &reading, &CancellationToken::new())
                .await
                .unwrap();
            let case = format!("{} {check:?}: {verdict:?}", language.name());
            match verdict {
                Verdict::Passed(why) => {
                    assert!(*passes, "{case}");
                    assert!(why.contains(says), "{case}");
                }
                Verdict::Failed(why) => {
                    assert!(!*passes, "{case}");
                    assert!(why.contains(says), "{case}");
                }
                Verdict::Skipped(why) => match language {
                    Language::Cpp => {
                        assert!(!has_cpp, "{case}");
                        assert!(why.contains("no C++ compiler"), "{case}");
                    }
                    Language::Haskell => {
                        assert!(!has_ghc, "{case}");
                        assert!(why.contains("GHC isn't installed"), "{case}");
                    }
                    _ => panic!("{case}"),
                },
            }
        }
    }

    /// Every program of a problem can be in Haskell: the brute force and the inputs program as
    /// well as the reference and the starter, which builds with `undefined` left in it.
    #[tokio::test]
    async fn checks_problems_written_wholly_in_haskell() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = Runtime {
            scratch: dir.path().to_owned(),
            environments: Default::default(),
            build_timeout: Duration::from_secs(120),
            run_timeout: Duration::from_secs(30),
            sandbox: Sandbox::detect(&[]).await.unwrap_or(Sandbox::Unconfined),
            tools: Default::default(),
        };
        if runtime.find(Language::Haskell, "ghc").is_none() {
            return;
        }
        let item = "+++\nkind = \"coding\"\nskills = [\"sums\"]\nlanguages = [\"haskell\"]\nreference = [\"Reference.hs\"]\nstarter = [\"Starter.hs\"]\nbrute_force = \"Brute.hs\"\ninputs = \"Inputs.hs\"\ntests = \"tests.toml\"\nrandom_inputs = 20\n+++\nAdd up the numbers.\n## Approach\nsum.\n";
        let tests = "[[example]]\ninput = \"3\\n1 2 3\\n\"\noutput = \"6\"\n[[test]]\ninput = \"1\\n-4\\n\"\noutput = \"-4\"\n";
        let main = "main :: IO ()\nmain = do\n  n : xs <- map read . words <$> getContents\n  print (total (take n xs))\n";
        let reference = format!(
            "import qualified Data.Map.Strict as M\n\ntotal :: [Int] -> Int\ntotal = sum . M.elems . M.fromListWith (+) . zip [0 :: Int ..]\n\n{main}"
        );
        let brute = format!("total :: [Int] -> Int\ntotal = foldr (+) 0\n\n{main}");
        let starter = format!("total :: [Int] -> Int\ntotal xs = undefined\n\n{main}");
        // A small generator of its own, as the random package doesn't come with GHC.
        let inputs = "import System.Environment (getArgs)\n\nmain :: IO ()\nmain = do\n  [seed, size] <- map read <$> getArgs\n  let draws = tail (iterate (\\x -> (x * 1103515245 + 12345) `mod` 2147483648) (seed + 1))\n      n = 1 + head draws `mod` (3 * size)\n  print n\n  putStrLn (unwords [show (d `mod` 201 - 100) | d <- take n (drop 1 draws)])\n";
        let files = |starter: &str| {
            [
                ("pack.toml", "id = \"example\"\nname = \"Example\"\n[[skills]]\nid = \"sums\"\nname = \"Sums\"\n"),
                ("items/total/item.md", item),
                ("items/total/tests.toml", tests),
                ("items/total/Reference.hs", &reference),
                ("items/total/Brute.hs", &brute),
                ("items/total/Starter.hs", starter),
                ("items/total/Inputs.hs", inputs),
            ]
            .into_iter()
            .map(|(path, text)| (path.to_owned(), text.as_bytes().to_vec()))
            .collect()
        };
        let check = |starter: String| {
            let runtime = &runtime;
            async move {
                let pack = Pack::from_files(files(&starter)).unwrap();
                assert!(pack.problems.is_empty(), "{:?}", pack.problems);
                let Content::Coding(coding) = &pack.item("total").unwrap().content else {
                    panic!("not a coding item");
                };
                check_coding(runtime, coding, &CancellationToken::new())
                    .await
                    .unwrap()
            }
        };
        let verdict = check(starter).await;
        assert!(
            matches!(&verdict, Verdict::Passed(why) if why.contains("Haskell")),
            "{verdict:?}"
        );
        let verdict = check(format!(
            "total :: [Int] -> Int\ntotal xs = \"no\"\n\n{main}"
        ))
        .await;
        assert!(
            matches!(&verdict, Verdict::Failed(why) if why.contains("the starter Starter.hs doesn't build")),
            "{verdict:?}"
        );
    }

    fn runtime(dir: &std::path::Path, sandbox: Sandbox) -> Runtime {
        Runtime {
            scratch: dir.to_owned(),
            environments: Default::default(),
            build_timeout: Duration::from_secs(60),
            run_timeout: Duration::from_secs(30),
            sandbox,
            tools: Default::default(),
        }
    }

    /// Reads a problem from its files, by their paths within its directory.
    fn problem(files: &[(&str, &str)]) -> Coding {
        let mut all: std::collections::BTreeMap<String, Vec<u8>> = files
            .iter()
            .map(|(path, text)| (format!("items/it/{path}"), text.as_bytes().to_vec()))
            .collect();
        all.insert(
            "pack.toml".to_owned(),
            b"id = \"example\"\nname = \"Example\"\n[[skills]]\nid = \"sums\"\nname = \"Sums\"\n"
                .to_vec(),
        );
        let pack = Pack::from_files(all).unwrap();
        assert!(pack.problems.is_empty(), "{:?}", pack.problems);
        let Content::Coding(coding) = &pack.item("it").unwrap().content else {
            panic!("not a coding item");
        };
        coding.clone()
    }

    const SUMS: &str = "import sys\nprint(sum(map(int, sys.stdin.read().split())))\n";
    const SUMS_OR_MOST: &str = "import sys\nwords = sys.stdin.read().split()\nif words and words[0] == 'most':\n    print(max(map(int, words[1:])))\nelse:\n    print(sum(map(int, words)))\n";
    const SUM_INPUTS: &str = "import random, sys\nrng = random.Random(int(sys.argv[1]))\nprint(' '.join(str(rng.randint(-9, 9)) for _ in range(rng.randint(1, 3 * int(sys.argv[2])))))\n";
    const MOST_INPUTS: &str = "import random, sys\nrng = random.Random(int(sys.argv[1]))\nprint('most', ' '.join(str(rng.randint(-9, 9)) for _ in range(rng.randint(1, 3 * int(sys.argv[2])))))\n";

    /// A problem in two parts: adding up numbers, then, for input starting with `most`, the
    /// largest instead.
    fn sums_in_parts(second: &str, brute: &str, front: &str) -> Coding {
        let item = format!(
            "+++\nkind = \"coding\"\nskills = [\"sums\"]\nlanguages = [\"python\"]\nreference = [\"reference.py\"]\nstarter = [\"starter.py\"]\nbrute_force = \"brute.py\"\ninputs = \"inputs.py\"\ntests = \"tests.toml\"\nrandom_inputs = 20\n\n[[parts]]\nreference = [\"two/reference.py\"]\nbrute_force = \"two/brute.py\"\ninputs = \"two/inputs.py\"\ntests = \"two/tests.toml\"\n{front}+++\nAdd up the numbers.\n\n## Part 2\n\nGiven `most` first, print the largest.\n\n## Approach\n\nsum, or max.\n"
        );
        problem(&[
            ("item.md", &item),
            (
                "tests.toml",
                "[[example]]\ninput = \"1 2\"\noutput = \"3\"\n[[test]]\ninput = \"-4\"\noutput = \"-4\"\n",
            ),
            ("reference.py", SUMS),
            ("brute.py", SUMS),
            ("inputs.py", SUM_INPUTS),
            ("starter.py", "print(0)\n"),
            (
                "two/tests.toml",
                "[[example]]\ninput = \"most 1 5 2\"\noutput = \"5\"\n[[test]]\ninput = \"most -3\"\noutput = \"-3\"\n",
            ),
            ("two/reference.py", second),
            ("two/brute.py", brute),
            ("two/inputs.py", MOST_INPUTS),
        ])
    }

    /// Each part's reference must pass what applies then: its own tests and the earlier parts',
    /// unless it replaces them, and every brute force that applies.
    #[tokio::test]
    async fn checks_every_part_of_a_problem_in_parts() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = runtime(
            dir.path(),
            Sandbox::detect(&[]).await.unwrap_or(Sandbox::Unconfined),
        );
        let cancel = CancellationToken::new();
        let most = "import sys\nprint(max(map(int, sys.stdin.read().split()[1:])))\n";
        let check = |coding: Coding| {
            let runtime = &runtime;
            let cancel = &cancel;
            async move { check_coding(runtime, &coding, cancel).await.unwrap() }
        };
        let verdict = check(sums_in_parts(SUMS_OR_MOST, most, "")).await;
        assert!(
            matches!(&verdict, Verdict::Passed(why) if why.starts_with("in each of its 2 parts, the reference passes Python every example and test that applies")),
            "{verdict:?}"
        );
        // Part 2's reference forgets what part 1 asked for, so part 1's example fails.
        let verdict = check(sums_in_parts(most, most, "")).await;
        assert!(
            matches!(&verdict, Verdict::Failed(why) if why.starts_with("part 2: two/reference.py is wrong: it printed the wrong answer on part 1's example 1")),
            "{verdict:?}"
        );
        // Unless part 2 replaces part 1.
        let verdict = check(sums_in_parts(most, most, "replaces = [1]\n")).await;
        assert!(matches!(&verdict, Verdict::Passed(_)), "{verdict:?}");
        // A wrong brute force is found on its part's examples.
        let verdict = check(sums_in_parts(SUMS_OR_MOST, SUMS, "")).await;
        assert!(
            matches!(&verdict, Verdict::Failed(why) if why.starts_with("part 2: the brute force, two/brute.py, is wrong: it crashed on part 2's example 1")),
            "{verdict:?}"
        );
        // Agreeing on the tests isn't enough: it's compared with part 2's brute force too.
        let negatives = "import sys\nwords = sys.stdin.read().split()\nif words and words[0] == 'most':\n    print(max(max(map(int, words[1:])), -3))\nelse:\n    print(sum(map(int, words)))\n";
        let verdict = check(sums_in_parts(negatives, most, "")).await;
        assert!(
            matches!(&verdict, Verdict::Failed(why) if why.contains("compared with part 2's brute force")),
            "{verdict:?}"
        );
    }

    /// In API mode, every part is checked as a module the driver calls, and a starter must be
    /// a module defining what the tests call.
    #[tokio::test]
    async fn checks_a_problem_in_api_mode_part_by_part() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = runtime(
            dir.path(),
            Sandbox::detect(&[]).await.unwrap_or(Sandbox::Unconfined),
        );
        let cancel = CancellationToken::new();
        let pack = Pack::sample();
        let Content::Coding(buffer) = &pack.item("text-buffer").unwrap().content else {
            panic!("not a coding item");
        };
        assert_eq!(buffer.parts.len(), 3);
        let verdict = check_coding(&runtime, buffer, &cancel).await.unwrap();
        assert!(
            matches!(&verdict, Verdict::Passed(why) if why.contains("3 parts")),
            "{verdict:?}"
        );

        // Redo that forgets to be cleared by a new change passes part 2's tests, but not
        // part 3's, nor the brute force's random calls.
        let mut forgetful = buffer.clone();
        let reference = &mut forgetful.parts[2].reference[0].text;
        *reference = reference.replace(
            "        self.make((\"insert\", text))\n        self.undone.clear()",
            "        self.make((\"insert\", text))",
        );
        let verdict = check_coding(&runtime, &forgetful, &cancel).await.unwrap();
        assert!(
            matches!(&verdict, Verdict::Failed(why) if why.starts_with("part 3: redo/reference.py is wrong:")),
            "{verdict:?}"
        );

        let mut misnamed = buffer.clone();
        misnamed.starter[0].text = misnamed.starter[0]
            .text
            .replace("class TextBuffer", "class Buffer");
        let verdict = check_coding(&runtime, &misnamed, &cancel).await.unwrap();
        assert!(
            matches!(&verdict, Verdict::Failed(why) if why.starts_with("the starter starter.py crashed when it's imported, and should define the class TextBuffer") && why.contains("There's no class TextBuffer")),
            "{verdict:?}"
        );
    }

    /// A problem in API mode calling the module's functions, rather than a class's methods.
    fn areas(starter: &str, inputs: &str) -> Coding {
        let item = "+++\nkind = \"coding\"\nskills = [\"sums\"]\nlanguages = [\"python\"]\nreference = [\"reference.py\"]\nstarter = [\"starter.py\"]\nbrute_force = \"brute.py\"\ninputs = \"inputs.py\"\ntests = \"tests.toml\"\nrandom_inputs = 20\napi = {}\n+++\nWrite `area(width, height)` and `perimeter(width, height)`.\n\n## Approach\n\nMultiply, and add.\n";
        problem(&[
            ("item.md", item),
            (
                "tests.toml",
                "[[example]]\ncalls = [{ call = \"area\", args = [2, 3], returns = 6 }]\n[[test]]\ncalls = [{ call = \"area\", args = [0, 5], returns = 0 }, { call = \"perimeter\", args = [1, 2], returns = 6 }]\n",
            ),
            (
                "reference.py",
                "def area(width: int, height: int) -> int:\n    return width * height\n\n\ndef perimeter(width: int, height: int) -> int:\n    return 2 * (width + height)\n",
            ),
            (
                "brute.py",
                "def area(width, height):\n    return sum(height for _ in range(width))\n\n\ndef perimeter(width, height):\n    return width + height + width + height\n",
            ),
            ("inputs.py", inputs),
            ("starter.py", starter),
        ])
    }

    const AREA_INPUTS: &str = "import json, random, sys\nrng = random.Random(int(sys.argv[1]))\nfor _ in range(int(sys.argv[2])):\n    print(json.dumps([rng.choice(['area', 'perimeter']), rng.randint(0, 9), rng.randint(0, 9)]))\n";
    const AREA_STARTER: &str = "def area(width: int, height: int) -> int:\n    raise NotImplementedError\n\n\ndef perimeter(width: int, height: int) -> int:\n    raise NotImplementedError\n";

    /// In API mode with functions, the starter must define every function the first part
    /// calls, and the inputs program must make calls with results to compare.
    #[tokio::test]
    async fn checks_a_problem_calling_functions_in_api_mode() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = runtime(
            dir.path(),
            Sandbox::detect(&[]).await.unwrap_or(Sandbox::Unconfined),
        );
        let cancel = CancellationToken::new();
        let verdict = check_coding(&runtime, &areas(AREA_STARTER, AREA_INPUTS), &cancel)
            .await
            .unwrap();
        assert!(matches!(&verdict, Verdict::Passed(_)), "{verdict:?}");
        // A starter without a function the tests call is found without calling anything.
        let partial = "def area(width: int, height: int) -> int:\n    raise NotImplementedError\n";
        let verdict = check_coding(&runtime, &areas(partial, AREA_INPUTS), &cancel)
            .await
            .unwrap();
        assert!(
            matches!(&verdict, Verdict::Failed(why) if why.contains("Your code has no perimeter to call")),
            "{verdict:?}"
        );
        // Blank lines are no calls, however many, so nothing comes back to compare.
        let silent = "import sys\nprint('\\n' * int(sys.argv[1]))\n";
        let verdict = check_coding(&runtime, &areas(AREA_STARTER, silent), &cancel)
            .await
            .unwrap();
        assert!(
            matches!(&verdict, Verdict::Failed(why) if why.starts_with("the inputs program made no calls that return anything")),
            "{verdict:?}"
        );
    }

    /// Running out of time or memory stops a Haskell program too, but isn't an exception the
    /// code raised.
    #[tokio::test]
    async fn haskell_running_out_of_time_or_memory_is_no_exception() {
        use workshop_pack::Question;
        let dir = tempfile::tempdir().unwrap();
        let sandbox = Sandbox::detect(&[]).await.unwrap_or(Sandbox::Unconfined);
        let runtime = |run_timeout| Runtime {
            scratch: dir.path().to_owned(),
            environments: Default::default(),
            build_timeout: Duration::from_secs(60),
            run_timeout,
            sandbox: sandbox.clone(),
            tools: Default::default(),
        };
        if runtime(Duration::ZERO)
            .find(Language::Haskell, "ghc")
            .is_none()
        {
            return;
        }
        for (code, run_timeout, says) in [
            (
                "main :: IO ()\nmain = mapM_ (\\_ -> pure ()) [1 :: Integer ..]\n",
                Duration::from_secs(2),
                "took too long",
            ),
            // Keeping every number to count and then add them up, so the heap fills.
            (
                "main :: IO ()\nmain = do\n  let xs = [1 :: Int .. 400000000]\n  print (length xs + sum xs)\n",
                Duration::from_secs(60),
                "Heap exhausted",
            ),
        ] {
            let reading = Reading {
                language: Language::Haskell,
                code: code.to_owned(),
                question: Question::Choice {
                    choices: vec!["a".to_owned(), "b".to_owned()],
                    answer: 0,
                },
                check: ReadingCheck::Raises,
                explanation: String::new(),
            };
            let verdict = check_reading(&runtime(run_timeout), &reading, &CancellationToken::new())
                .await
                .unwrap();
            assert!(
                matches!(&verdict, Verdict::Failed(why) if why.contains(says)),
                "{code}: {verdict:?}"
            );
        }
    }

    #[tokio::test]
    async fn skips_programs_without_a_sandbox_when_told_to() {
        let dir = tempfile::tempdir().unwrap();
        let checker = Checker {
            runtime: Runtime {
                scratch: dir.path().to_owned(),
                environments: Default::default(),
                build_timeout: Duration::from_secs(60),
                run_timeout: Duration::from_secs(60),
                sandbox: Sandbox::Unconfined,
                tools: Default::default(),
            },
            unconfined: Unconfined::Skip,
        };
        let pack = Pack::sample();
        let report = pack.check(&checker).await;
        let mut with_programs = 0;
        for checked in &report.items {
            let item = pack.items.iter().find(|i| i.path == checked.path).unwrap();
            if matches!(item.content, Content::Coding(_) | Content::Reading(_)) {
                with_programs += 1;
                assert!(
                    matches!(&checked.verdict, Verdict::Skipped(why) if why.contains("no sandbox")),
                    "{}: {:?}",
                    checked.path,
                    checked.verdict
                );
            }
        }
        assert!(with_programs > 0);
        // Nothing was built.
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    /// No solution could print an expected output longer than output is kept, so such an item
    /// fails its check, even where its programs aren't run.
    #[tokio::test]
    async fn fails_coding_items_expecting_more_output_than_is_kept() {
        use workshop_pack::Programs;
        let dir = tempfile::tempdir().unwrap();
        let checker = Checker {
            runtime: Runtime {
                scratch: dir.path().to_owned(),
                environments: Default::default(),
                build_timeout: Duration::from_secs(60),
                run_timeout: Duration::from_secs(60),
                sandbox: Sandbox::Unconfined,
                tools: Default::default(),
            },
            unconfined: Unconfined::Skip,
        };
        let pack = Pack::sample();
        let expecting = |example: String, test: String| {
            let mut item = pack.item("rising-run").unwrap().clone();
            let Content::Coding(coding) = &mut item.content else {
                panic!("not a coding item");
            };
            coding.parts[0].examples[0].output = example;
            coding.parts[0].tests[1].output = test;
            item
        };
        let fits = "1\n".repeat(1000);
        assert!(matches!(
            checker.check(&expecting(fits.clone(), fits)).await,
            Verdict::Skipped(why) if why.contains("no sandbox")
        ));
        let item = expecting("1\n".repeat(40 * 1024), "a".repeat(2 * 1024 * 1024));
        assert_eq!(
            checker.check(&item).await,
            Verdict::Failed("example 1 expects 80 KiB of output, and test 2 expects 2.0 MiB of output, more than the 64 KiB a program's output is cut off at, so no solution can pass them; keep every expected output under that".to_owned())
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
