//! Running a codebase item's project: its files, with the item's tests beside them, through
//! Workshop's test driver, which runs one test each time it's started (see
//! `workshop_pack::project`). And checking a fix or a refactor, for `workshop pack check`.

use anyhow::{Result, bail};
use tokio_util::sync::CancellationToken;
use workshop_pack::{Coding, Language, PartWork, ProjectFile, Task, Verdict};

use crate::grade::{self, CaseRef, Code, Graded};
use crate::programs::Runtime;

/// The test driver, which reads the test to run on stdin and prints whether it passed.
pub const DRIVER: &str = include_str!("tests.py");

/// The file the driver is written to, beside the project's files, which it imports.
pub const DRIVER_FILE: &str = "workshop_tests.py";

/// A project's files for a run once the learner is on `part`: the solution's own, without any
/// tests of its own, as the tests are always the item's, and every test that applies then, the
/// project's, each part's given tests and the hidden ones.
pub fn modules(
    coding: &Coding,
    part: usize,
    files: &[ProjectFile],
) -> Result<Vec<(String, String)>> {
    if coding.project().is_none() {
        bail!("only a codebase item's solution is a project");
    }
    if part > coding.last() {
        bail!("there's no part {} to run the tests of", part + 1);
    }
    let mut modules: Vec<(String, String)> = Vec::new();
    for file in files.iter().filter(|f| !f.is_test()) {
        if file.path == DRIVER_FILE || file.path == "built" {
            bail!(
                "{} is Workshop's own, so a project can't have a file called it",
                file.path
            );
        }
        if !workshop_pack::diff::is_project_path(&file.path) {
            bail!("{:?} can't be a file in a project", file.path);
        }
        if modules.iter().any(|(path, _)| *path == file.path) {
            bail!("the project has {} twice", file.path);
        }
        modules.push((file.path.clone(), file.text.clone()));
    }
    for test in coding
        .test_files(part)
        .into_iter()
        .chain(coding.hidden_files(part))
    {
        modules.push((test.path.clone(), test.text.clone()));
    }
    Ok(modules)
}

/// Checks a fix or a refactor, part by part: each part's reference must pass every test that
/// applies at that part. Then the project as it's given must fail what it's there to fix: for a
/// fix, one of the hidden tests at least; for a refactor, its own tests must pass, as they're
/// what it does already, and one of the first part's given tests at least must fail, as they
/// need the refactoring. And each part after the first must need more than the part before it:
/// that part's reference must fail one of its tests at least.
pub async fn check(
    runtime: &Runtime,
    coding: &Coding,
    cancel: &CancellationToken,
) -> Result<Verdict> {
    let Some(project) = coding.project() else {
        bail!("only a codebase item's project is checked as one");
    };
    let reference = |part: usize| match &coding.parts[part].work {
        PartWork::Project { reference, .. } => reference.as_slice(),
        PartWork::Program { .. } => &[],
    };
    let at = |part: usize, problem: String| {
        if coding.in_parts() {
            format!("part {}: {problem}", part + 1)
        } else {
            problem
        }
    };
    for part in 0..coding.parts.len() {
        let graded = grade::grade(
            runtime,
            coding,
            &[],
            part,
            Language::Python,
            Code::Project(reference(part)),
            0,
            cancel,
        )
        .await?
        .map_err(anyhow::Error::msg)?;
        if let Graded::Unavailable { reason } = graded {
            return Ok(Verdict::Skipped(reason));
        }
        if let Some(failure) = graded.failure() {
            return Ok(Verdict::Failed(at(
                part,
                format!("the reference fails {}", failed(&failure.case, failure)),
            )));
        }
        if let Some(problem) = graded.problem() {
            return Ok(Verdict::Failed(at(
                part,
                format!("the reference {problem}"),
            )));
        }
    }
    let original = grade::run_all(
        runtime,
        coding,
        0,
        first_cases(coding),
        Language::Python,
        Code::Project(&project.files),
        cancel,
    )
    .await?;
    let Graded::Ran { results, .. } = &original else {
        return Ok(Verdict::Failed(format!(
            "the project as it's given {}",
            original.problem().unwrap_or_default()
        )));
    };
    let failing = |kind: fn(&CaseRef) -> bool| {
        results
            .iter()
            .filter(|r| kind(&r.case) && !r.passed)
            .collect::<Vec<_>>()
    };
    match project.task {
        Task::Fix => {
            if failing(|c| matches!(c, CaseRef::Test { .. })).is_empty() {
                return Ok(Verdict::Failed(
                    "the project as it's given passes every hidden test, so they don't find the bug"
                        .to_owned(),
                ));
            }
        }
        Task::Refactor => {
            let own: Vec<String> = coding
                .test_files(0)
                .into_iter()
                .filter(|f| project.file(&f.path).is_some())
                .map(|f| f.path.clone())
                .collect();
            let of_own = |case: &CaseRef, input: &str| {
                matches!(case, CaseRef::Example { .. })
                    && own
                        .iter()
                        .any(|path| input.starts_with(&format!("{path}::")))
            };
            if let Some(broken) = results
                .iter()
                .find(|r| of_own(&r.case, &r.input) && !r.passed)
            {
                return Ok(Verdict::Failed(format!(
                    "the project as it's given fails its own {}; its own tests are what it does already, so they should pass",
                    failed(&broken.case, broken)
                )));
            }
            if !results.iter().any(|r| {
                matches!(r.case, CaseRef::Example { .. }) && !of_own(&r.case, &r.input) && !r.passed
            }) {
                return Ok(Verdict::Failed(
                    "the project as it's given passes every given test, so there's nothing to refactor it for".to_owned(),
                ));
            }
        }
        Task::Review => bail!("a review's project isn't run"),
    }
    for part in 1..coding.parts.len() {
        let before = grade::run_all(
            runtime,
            coding,
            part,
            own_cases(coding, part),
            Language::Python,
            Code::Project(reference(part - 1)),
            cancel,
        )
        .await?;
        if before.passed() {
            return Ok(Verdict::Failed(at(
                part,
                format!(
                    "part {}'s reference passes every one of its tests, so it adds nothing",
                    part
                ),
            )));
        }
    }
    let tests: usize = coding
        .parts
        .iter()
        .map(|p| p.examples.len() + p.tests.len())
        .sum();
    Ok(Verdict::Passed(match project.task {
        Task::Fix => format!(
            "the fix passes all {tests} tests, and the project as it's given fails a hidden one"
        ),
        _ => format!(
            "in each of its {} parts, the reference passes every test that applies, {tests} in all; the project as it's given passes its own tests and fails a given one, and each part needs more than the last",
            coding.parts.len()
        ),
    }))
}

/// Every example and hidden test of the first part.
fn first_cases(coding: &Coding) -> Vec<(CaseRef, &workshop_pack::Case)> {
    let mut cases = grade::own_examples(coding, 0);
    cases.extend(own_tests(coding, 0));
    cases
}

/// A part's own examples and hidden tests, without the earlier parts'.
fn own_cases(coding: &Coding, part: usize) -> Vec<(CaseRef, &workshop_pack::Case)> {
    let mut cases = grade::own_examples(coding, part);
    cases.extend(own_tests(coding, part));
    cases
}

fn own_tests(coding: &Coding, part: usize) -> Vec<(CaseRef, &workshop_pack::Case)> {
    let which = coding.in_parts().then_some(part);
    coding.parts[part]
        .tests
        .iter()
        .enumerate()
        .map(|(index, known)| (CaseRef::Test { part: which, index }, known))
        .collect()
}

/// A test that failed, by name, and why.
fn failed(case: &CaseRef, result: &grade::CaseResult) -> String {
    let what = match case {
        CaseRef::Example { .. } => "test",
        CaseRef::Test { .. } => "hidden test",
        CaseRef::Random { .. } => "random input",
    };
    format!(
        "{what} {}:\n{}",
        result.input.trim_end(),
        grade::shortened(result.run.stderr.trim_end())
    )
}

#[cfg(all(test, unix))]
mod tests {
    use std::time::Duration;

    use workshop_pack::{Content, Pack, ProjectFile, Work};

    use super::*;
    use crate::Sandbox;

    async fn runtime(dir: &std::path::Path) -> Runtime {
        Runtime {
            scratch: dir.to_owned(),
            environments: Default::default(),
            build_timeout: Duration::from_secs(60),
            run_timeout: Duration::from_secs(30),
            sandbox: Sandbox::detect(&[]).await.unwrap_or(Sandbox::Unconfined),
            tools: Default::default(),
        }
    }

    fn sample(id: &str) -> Coding {
        match &Pack::sample().item(id).unwrap().content {
            Content::Coding(coding) => coding.clone(),
            _ => panic!("{id} isn't a problem to solve"),
        }
    }

    fn files(coding: &Coding) -> Vec<ProjectFile> {
        coding.project().unwrap().files.clone()
    }

    fn with(mut files: Vec<ProjectFile>, path: &str, text: &str) -> Vec<ProjectFile> {
        files.retain(|f| f.path != path);
        files.push(ProjectFile {
            path: path.to_owned(),
            text: text.to_owned(),
        });
        files
    }

    fn solved(coding: &Coding, part: usize) -> Vec<ProjectFile> {
        let PartWork::Project { reference, .. } = &coding.parts[part].work else {
            panic!("not a project's part");
        };
        reference.clone()
    }

    #[tokio::test]
    async fn runs_a_projects_tests_one_at_a_time_in_the_sandbox() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = runtime(dir.path()).await;
        let cancel = CancellationToken::new();
        let coding = sample("word-counts");
        // The project as it's given passes its own tests, and fails the hidden ones.
        let ran = grade::run_examples(
            &runtime,
            &coding,
            0,
            Language::Python,
            Code::Project(&files(&coding)),
            &cancel,
        )
        .await
        .unwrap();
        assert!(ran.passed(), "{:?}", ran.problem());
        let graded = grade::grade(
            &runtime,
            &coding,
            &[],
            0,
            Language::Python,
            Code::Project(&files(&coding)),
            0,
            &cancel,
        )
        .await
        .unwrap()
        .unwrap();
        let failure = graded.failure().unwrap();
        assert!(matches!(failure.case, CaseRef::Test { .. }), "{failure:?}");
        assert_eq!(
            failure.input,
            "test_punctuation.py::test_ends_with_a_full_stop\n"
        );
        assert!(
            failure
                .run
                .stderr
                .contains("test_ends_with_a_full_stop failed"),
            "{}",
            failure.run.stderr
        );
        assert!(
            failure.run.stderr.contains("assert word_count"),
            "{}",
            failure.run.stderr
        );
        assert!(
            !failure.run.stderr.contains(DRIVER_FILE),
            "{}",
            failure.run.stderr
        );

        // Printing what a passing test prints passes nothing, and the tests are the item's,
        // whatever the learner's copy of them says.
        let sneaky = with(
            with(
                files(&coding),
                "words.py",
                "import sys\nprint('passed')\nsys.stdout.write('passed\\n')\ndef split_words(text):\n    return []\n",
            ),
            "test_stats.py",
            "def test_nothing():\n    pass\n",
        );
        let ran = grade::run_examples(
            &runtime,
            &coding,
            0,
            Language::Python,
            Code::Project(&sneaky),
            &cancel,
        )
        .await
        .unwrap();
        let Graded::Ran { results, .. } = &ran else {
            panic!("didn't run: {ran:?}");
        };
        assert_eq!(results.len(), coding.parts[0].examples.len());
        assert!(results.iter().any(|r| !r.passed), "{results:?}");
        assert!(
            results
                .iter()
                .all(|r| r.input.starts_with("test_stats.py::test_"))
        );

        // A file that doesn't import says so.
        let broken = with(files(&coding), "words.py", "def split_words(text)\n");
        let ran = grade::run_examples(
            &runtime,
            &coding,
            0,
            Language::Python,
            Code::Project(&broken),
            &cancel,
        )
        .await
        .unwrap();
        let failure = ran.failure().unwrap();
        assert!(
            failure
                .run
                .stderr
                .contains("Importing test_stats.py failed"),
            "{}",
            failure.run.stderr
        );
        assert!(
            failure.run.stderr.contains("SyntaxError"),
            "{}",
            failure.run.stderr
        );

        // The driver is Workshop's own.
        let clash = with(files(&coding), DRIVER_FILE, "");
        let err = grade::run_examples(
            &runtime,
            &coding,
            0,
            Language::Python,
            Code::Project(&clash),
            &cancel,
        )
        .await
        .unwrap_err();
        assert!(format!("{err:#}").contains("Workshop's own"), "{err:#}");
    }

    #[tokio::test]
    async fn checks_a_fix() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = runtime(dir.path()).await;
        let cancel = CancellationToken::new();
        let coding = sample("word-counts");
        let verdict = check(&runtime, &coding, &cancel).await.unwrap();
        assert!(
            matches!(&verdict, Verdict::Passed(why) if why.contains("fails a hidden one")),
            "{verdict:?}"
        );

        // A reference that doesn't fix it.
        let mut unfixed = coding.clone();
        let PartWork::Project { reference, .. } = &mut unfixed.parts[0].work else {
            panic!("not a project's part");
        };
        *reference = files(&coding)
            .into_iter()
            .filter(|f| !f.is_test())
            .collect();
        let verdict = check(&runtime, &unfixed, &cancel).await.unwrap();
        assert!(
            matches!(&verdict, Verdict::Failed(why) if why.starts_with("the reference fails hidden test test_punctuation.py::")),
            "{verdict:?}"
        );

        // A project with no bug for the hidden tests to find.
        let mut fixed = coding.clone();
        let Work::Project(project) = &mut fixed.work else {
            panic!("not a project");
        };
        project.files = with(
            project.files.clone(),
            "words.py",
            &solved(&coding, 0)
                .iter()
                .find(|f| f.path == "words.py")
                .unwrap()
                .text,
        );
        let verdict = check(&runtime, &fixed, &cancel).await.unwrap();
        assert!(
            matches!(&verdict, Verdict::Failed(why) if why.contains("passes every hidden test")),
            "{verdict:?}"
        );
    }

    #[tokio::test]
    async fn checks_a_refactor_part_by_part() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = runtime(dir.path()).await;
        let cancel = CancellationToken::new();
        let coding = sample("habit-streaks");
        let verdict = check(&runtime, &coding, &cancel).await.unwrap();
        assert!(
            matches!(&verdict, Verdict::Passed(why) if why.contains("each of its 2 parts")),
            "{verdict:?}"
        );

        // Already refactored, so the given tests pass on it as it is.
        let mut done = coding.clone();
        let Work::Project(project) = &mut done.work else {
            panic!("not a project");
        };
        let tests: Vec<ProjectFile> = project
            .files
            .iter()
            .filter(|f| f.is_test())
            .cloned()
            .collect();
        project.files = solved(&coding, 0).into_iter().chain(tests).collect();
        let verdict = check(&runtime, &done, &cancel).await.unwrap();
        assert!(
            matches!(&verdict, Verdict::Failed(why) if why.contains("nothing to refactor it for")),
            "{verdict:?}"
        );

        // Its own tests must pass as it is, as they're what it does already.
        let mut broken = coding.clone();
        let Work::Project(project) = &mut broken.work else {
            panic!("not a project");
        };
        let log = project
            .file("log.py")
            .unwrap()
            .text
            .replace("days.setdefault", "days.get");
        project.files = with(project.files.clone(), "log.py", &log);
        let verdict = check(&runtime, &broken, &cancel).await.unwrap();
        assert!(
            matches!(&verdict, Verdict::Failed(why) if why.contains("fails its own test test_tracker.py::")),
            "{verdict:?}"
        );

        // A part that the part before it does already.
        let mut idle = coding.clone();
        let earlier = solved(&coding, 1);
        let PartWork::Project { reference, .. } = &mut idle.parts[0].work else {
            panic!("not a project's part");
        };
        *reference = earlier;
        let verdict = check(&runtime, &idle, &cancel).await.unwrap();
        assert!(
            matches!(&verdict, Verdict::Failed(why) if why == "part 2: part 1's reference passes every one of its tests, so it adds nothing"),
            "{verdict:?}"
        );

        // Part 2's reference must still pass part 1's tests.
        let mut regressed = coding.clone();
        let PartWork::Project { reference, .. } = &mut regressed.parts[1].work else {
            panic!("not a project's part");
        };
        let tracker = reference
            .iter_mut()
            .find(|f| f.path == "tracker.py")
            .unwrap();
        tracker.text = tracker.text.replace(
            "days\" for habit in sorted(days)]\n\n    def records",
            "\" for habit in sorted(days)]\n\n    def records",
        );
        let verdict = check(&runtime, &regressed, &cancel).await.unwrap();
        assert!(
            matches!(&verdict, Verdict::Failed(why) if why.starts_with("part 2: the reference fails test test_tracker")),
            "{verdict:?}"
        );
    }
}
