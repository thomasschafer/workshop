//! `workshop pack check` for the items with programs: a coding item's reference solutions must
//! pass its tests and agree with its brute force on random inputs, and a reading item's code
//! must do what its answer says, such as print what the learner is asked to work out.

use anyhow::Result;
use tokio_util::sync::CancellationToken;
use workshop_pack::{Coding, Content, Item, Reading, ReadingCheck, Verdict, output};

use crate::grade::{self, Graded, Oracle, describe};
use crate::programs::{Built, Flavour, Runtime};

/// Checks items' programs by building and running them, for `Pack::check`.
pub struct Checker {
    pub runtime: Runtime,
}

impl workshop_pack::Programs for Checker {
    fn check<'a>(
        &'a self,
        item: &'a Item,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Verdict> + Send + 'a>> {
        Box::pin(async move {
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

pub async fn check_coding(
    runtime: &Runtime,
    coding: &Coding,
    cancel: &CancellationToken,
) -> Result<Verdict> {
    let oracle = match Oracle::build(runtime, coding, cancel).await? {
        Ok(oracle) => oracle,
        Err(problem) => return Ok(unavailable_or_failed(runtime, coding, problem)),
    };
    // The brute force is what everything else is compared with, so it has to be right too, on
    // the examples at least: the tests can be too big for it to finish.
    let brute = &coding.brute_force;
    let graded = grade::run_examples(runtime, coding, brute.language, &brute.text, cancel).await?;
    if let Some(problem) = graded.problem() {
        return Ok(Verdict::Failed(format!(
            "the brute force, {}, is wrong: {problem}",
            brute.file
        )));
    }
    let mut skipped = Vec::new();
    for reference in &coding.reference {
        let graded = grade::grade(
            runtime,
            coding,
            &oracle,
            reference.language,
            &reference.text,
            coding.random_inputs,
            cancel,
        )
        .await?;
        match graded {
            Err(problem) => return Ok(Verdict::Failed(problem)),
            Ok(Graded::Unavailable { reason }) => {
                skipped.push(format!("{}: {reason}", reference.file));
            }
            Ok(graded) => {
                // A build that fails says why itself, which may be the toolchain rather than
                // the solution, such as a missing linker.
                if let Some(problem) = graded.problem() {
                    let what = if matches!(graded, Graded::BuildFailed { .. }) {
                        ":"
                    } else {
                        " is wrong:"
                    };
                    return Ok(Verdict::Failed(format!(
                        "{}{what} {problem}",
                        reference.file
                    )));
                }
            }
        }
    }
    for starter in &coding.starter {
        match runtime
            .build(starter.language, &starter.text, Flavour::Plain, cancel)
            .await?
        {
            Built::Ready(_) => {}
            Built::Failed { errors, .. } => {
                return Ok(Verdict::Failed(format!(
                    "the starter {} doesn't build, and should, unfinished as it is:\n{errors}",
                    starter.file
                )));
            }
            Built::Unavailable(reason) => skipped.push(format!("{}: {reason}", starter.file)),
        }
    }
    if let Some(problem) = inputs_vary(runtime, &oracle, cancel).await? {
        return Ok(Verdict::Failed(problem));
    }
    if !skipped.is_empty() {
        return Ok(Verdict::Skipped(format!(
            "not everything could be run here: {}",
            skipped.join("; ")
        )));
    }
    Ok(Verdict::Passed(format!(
        "{} {} {} examples, {} tests and {} random inputs against the brute force",
        if coding.reference.len() == 1 {
            "the reference passes"
        } else {
            "the references pass"
        },
        coding
            .reference
            .iter()
            .map(|r| r.language.name())
            .collect::<Vec<_>>()
            .join(" and "),
        coding.examples.len(),
        coding.tests.len(),
        coding.random_inputs,
    )))
}

/// A program that can't be built here is skipped; one that's broken is a failure.
fn unavailable_or_failed(runtime: &Runtime, coding: &Coding, problem: String) -> Verdict {
    let unavailable = [&coding.brute_force, &coding.inputs].iter().any(|source| {
        let needs = match source.language {
            workshop_pack::Language::Python => "python3",
            workshop_pack::Language::Rust => "rustc",
            workshop_pack::Language::Cpp => "c++",
        };
        runtime.find(needs).is_none()
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
    let flavour = match reading.check {
        ReadingCheck::SanitizerError => Flavour::Sanitized,
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
            if !run.succeeded() {
                Verdict::Failed(format!(
                    "the code {}:\n{}",
                    describe(&run),
                    run.stderr.trim_end()
                ))
            } else if output::same(expected, &run.stdout) {
                Verdict::Passed("the code prints what the answer says".to_owned())
            } else {
                Verdict::Failed(format!(
                    "the answer says it prints:\n{}\nbut it prints:\n{}",
                    expected.trim_end(),
                    run.stdout.trim_end()
                ))
            }
        }
        ReadingCheck::SanitizerError => {
            let found = run.stderr.contains("Sanitizer") || run.stderr.contains("runtime error");
            if !run.succeeded() && found {
                Verdict::Passed("the sanitizers stop the code, as the answer says".to_owned())
            } else {
                Verdict::Failed(format!(
                    "built with sanitizers, the code ran without them finding anything, though the answer says they should:\n{}",
                    run.stderr.trim_end()
                ))
            }
        }
        ReadingCheck::Compiles | ReadingCheck::CompileError => {
            unreachable!("decided once it's built")
        }
    })
}

#[cfg(all(test, unix))]
mod tests {
    use std::time::Duration;

    use workshop_pack::{Pack, Verdict};

    use super::*;

    #[tokio::test]
    async fn the_sample_packs_programs_pass_their_checks() {
        let dir = tempfile::tempdir().unwrap();
        let checker = Checker {
            runtime: Runtime {
                scratch: dir.path().to_owned(),
                environment: Vec::new(),
                build_timeout: Duration::from_secs(60),
                run_timeout: Duration::from_secs(60),
            },
        };
        let pack = Pack::sample();
        let report = pack.check(&checker).await;
        let failures: Vec<String> = report.failures().iter().map(ToString::to_string).collect();
        assert!(failures.is_empty(), "{failures:#?}");
        let has_cpp = checker.runtime.find("c++").is_some()
            || checker.runtime.find("clang++").is_some()
            || checker.runtime.find("g++").is_some();
        for checked in &report.items {
            match &checked.verdict {
                Verdict::Passed(_) => {}
                // Only C++ can be missing where the tests run, as Python and Rust are needed for
                // Workshop's own.
                Verdict::Skipped(reason) => {
                    assert!(
                        !has_cpp && checked.path.contains("/reading/"),
                        "{}: {reason}",
                        checked.path
                    );
                    assert!(reason.contains("no C++ compiler"), "{reason}");
                }
                Verdict::Failed(_) => unreachable!("listed above"),
            }
        }
    }
}
