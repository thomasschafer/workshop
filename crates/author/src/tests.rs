//! The author's runs, with stand-ins for the models: what they write, and what the reviewer says.

use std::path::Path;
use std::sync::Mutex;

use super::*;

const MANIFEST: &str =
    "id = \"dice\"\nname = \"Dice\"\n\n[[skills]]\nid = \"dice.sums\"\nname = \"Sums of dice\"\n";

/// A pack with one card and one draft.
fn pack(dir: &Path) -> std::path::PathBuf {
    let pack = dir.join("pack");
    std::fs::create_dir_all(pack.join("items")).unwrap();
    std::fs::create_dir_all(pack.join("drafts")).unwrap();
    std::fs::create_dir_all(pack.join(".git")).unwrap();
    std::fs::write(pack.join(".git/HEAD"), "ref: refs/heads/main").unwrap();
    std::fs::write(pack.join("pack.toml"), MANIFEST).unwrap();
    std::fs::write(
        pack.join("items/faces.md"),
        card("How many faces has a die?", "Six."),
    )
    .unwrap();
    std::fs::write(
        pack.join("drafts/two-sixes.md"),
        "+++\nskills = [\"dice.sums\"]\n+++\nWhat's the chance of two sixes?\n",
    )
    .unwrap();
    pack
}

fn card(question: &str, answer: &str) -> String {
    format!(
        "+++\nkind = \"card\"\nskills = [\"dice.sums\"]\n+++\n{question}\n\n## Answer\n\n{answer}\n"
    )
}

/// A probability item whose simulation checks `answer`, the chance two dice show a double.
fn doubles(answer: &str) -> String {
    format!(
        "+++\nkind = \"probability\"\nskills = [\"dice.sums\"]\nanswer = \"{answer}\"\n\n[simulation]\ntrials = 20000\ntolerance = 0.02\n+++\nTwo fair dice are rolled. What's the chance they show the same number?\n\n## Solution\n\nSix of the 36 pairs match.\n\n## Simulation\n\n```rhai\nrand_int(1, 6) == rand_int(1, 6)\n```\n"
    )
}

/// Stands in for the two models: the writer acts on the copy as `write` says, and the reviewer
/// answers as `review` says, given each prompt and how many calls came before.
struct Fake<W, R> {
    write: W,
    review: R,
    writes: Mutex<Vec<String>>,
    reviews: Mutex<Vec<String>>,
}

impl<W, R> Fake<W, R>
where
    W: Fn(&Path, &str, usize) -> String + Sync,
    R: Fn(&str, usize) -> String + Sync,
{
    fn new(write: W, review: R) -> Self {
        Self {
            write,
            review,
            writes: Mutex::default(),
            reviews: Mutex::default(),
        }
    }
}

impl<W, R> Models for Fake<W, R>
where
    W: Fn(&Path, &str, usize) -> String + Sync,
    R: Fn(&str, usize) -> String + Sync,
{
    async fn write(&self, dir: &Path, prompt: &str) -> Result<String> {
        let n = {
            let mut writes = self.writes.lock().unwrap();
            writes.push(prompt.to_owned());
            writes.len() - 1
        };
        Ok((self.write)(dir, prompt, n))
    }

    async fn review(&self, prompt: &str) -> Result<String> {
        let n = {
            let mut reviews = self.reviews.lock().unwrap();
            reviews.push(prompt.to_owned());
            reviews.len() - 1
        };
        Ok((self.review)(prompt, n))
    }
}

/// Runs no programs: the items here are checked without them.
struct NoPrograms;

impl Programs for NoPrograms {
    fn check<'a>(
        &'a self,
        _: &'a Item,
    ) -> std::pin::Pin<Box<dyn Future<Output = Verdict> + Send + 'a>> {
        Box::pin(async { Verdict::Skipped("programs aren't run here".to_owned()) })
    }
}

const LIMITS: Limits = Limits {
    max_items: 3,
    fix_rounds: 1,
    discussion_rounds: 2,
};

/// The reviewer's blind solution, then its verdicts on comparing.
fn solved(answer: &str) -> String {
    format!("{{\"answer\": \"{answer}\", \"working\": \"6 of 36\", \"unclear\": []}}")
}

fn agrees() -> String {
    "{\"agree\": true, \"ambiguous\": false, \"objection\": \"\"}".to_owned()
}

fn objects(why: &str) -> String {
    format!("{{\"agree\": false, \"ambiguous\": true, \"objection\": \"{why}\"}}")
}

/// A reviewer that solves blind with `answer`, then says `verdicts` in turn.
fn reviewer(answer: &'static str, verdicts: Vec<String>) -> impl Fn(&str, usize) -> String + Sync {
    move |prompt: &str, _| {
        if prompt.starts_with("Solve this") {
            solved(answer)
        } else {
            let compared = verdicts.len().min(
                // Each comparison prompt is one turn on; the count is in how many came before.
                prompt.matches("<author>").count(),
            );
            verdicts[compared.min(verdicts.len() - 1)].clone()
        }
    }
}

async fn run_with<W, R>(dir: &Path, fake: &Fake<W, R>, limits: Limits) -> (Report, Vec<String>)
where
    W: Fn(&Path, &str, usize) -> String + Sync,
    R: Fn(&str, usize) -> String + Sync,
{
    let pack = pack(dir);
    let asked = Mutex::new(Vec::new());
    let report = super::run(
        &pack,
        &dir.join("work"),
        fake,
        &NoPrograms,
        &Brief {
            weakest: vec![("dice.sums".to_owned(), 0.2)],
            mistakes: vec![("concept-gap".to_owned(), 3)],
            examples: vec!["Answered 1/12; it's 1/6".to_owned()],
            answers: vec![("More cards?".to_owned(), "Yes".to_owned())],
            too_easy: vec![super::TooEasy {
                skill: "dice.sums".to_owned(),
                level: 4,
                retired: vec![("Two dice".to_owned(), Some(3)), ("Pips".to_owned(), None)],
            }],
            fixed_too_easy: vec![super::TooEasy {
                skill: "dice.sums".to_owned(),
                level: 3,
                retired: vec![("Doubles".to_owned(), Some(2))],
            }],
            levels: vec![("dice.sums".to_owned(), 4)],
        },
        limits,
        &|question: &str| asked.lock().unwrap().push(question.to_owned()),
    )
    .await
    .unwrap();
    (report, asked.into_inner().unwrap())
}

#[tokio::test]
async fn accepts_items_both_models_agree_on() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(
        |copy: &Path, _: &str, _| {
            // The writer only ever sees the copy, without the pack's hidden files.
            assert!(!copy.join(".git").exists());
            assert!(copy.join("pack.toml").exists());
            std::fs::write(copy.join("items/doubles.md"), doubles("1/6")).unwrap();
            std::fs::write(
                copy.join("items/pips.md"),
                card("How many pips on a die?", "21."),
            )
            .unwrap();
            "Done.\n{\"items\": [{\"path\": \"items/doubles.md\"}, {\"path\": \"items/pips.md\"}], \"questions\": [\"Would you like harder sums?\"]}".to_owned()
        },
        reviewer("1/6", vec![agrees()]),
    );
    let (report, asked) = run_with(dir.path(), &fake, LIMITS).await;
    let accepted: Vec<&str> = report.accepted.iter().map(|w| w.path.as_str()).collect();
    assert_eq!(accepted, ["items/doubles.md", "items/pips.md"]);
    assert!(
        report.queued.is_empty() && report.dropped.is_empty(),
        "{report:#?}"
    );
    assert_eq!(report.accepted[0].files["items/doubles.md"], doubles("1/6"));
    assert_eq!(report.accepted[0].skills, ["dice.sums"]);
    // The question went out as soon as it was asked.
    assert_eq!(asked, ["Would you like harder sums?"]);
    assert_eq!(report.questions, asked);
    // Solved blind: the reviewer never saw the answer first.
    let reviews = fake.reviews.lock().unwrap();
    assert!(reviews[0].starts_with("Solve this"));
    assert!(!reviews[0].contains("Six of the 36"));
    assert!(reviews[1].contains("Six of the 36"));
    // The writer was told what to write about, and the cap.
    let writes = fake.writes.lock().unwrap();
    assert!(writes[0].contains("- dice.sums: 0.20"));
    assert!(writes[0].contains("- concept-gap: 3"));
    assert!(writes[0].contains("Answered 1/12"));
    assert!(writes[0].contains("A: Yes"));
    assert!(writes[0].contains("drafts/two-sixes.md"));
    assert!(writes[0].contains("Write at most 3 new items"));
    // Harder problems where they were found too easy, at the skill's level.
    assert!(writes[0].contains(
        "- dice.sums (level 4): \"Two dice\" (difficulty 3), \"Pips\" (no difficulty given, so taken as 3)"
    ));
    assert!(writes[0].contains("none at the same difficulty as these or easier"));
    assert!(writes[0].contains("give each its `difficulty`:\n- dice.sums: 4\n"));
    // Harder variants, testing the concept differently, where items with a fixed answer were
    // known by heart.
    let fixed = writes[0]
        .split_once("Code to read and probability questions the learner found too easy")
        .expect("the writer is told of items with a fixed answer found too easy")
        .1;
    assert!(fixed.contains("test the concept differently"));
    assert!(fixed.contains("Never a copy of one of these reworded"));
    assert!(fixed.contains("- dice.sums (level 3): \"Doubles\" (difficulty 2)\n"));
    // The pack itself is as it was.
    assert!(!dir.path().join("pack/items/doubles.md").exists());
}

#[tokio::test]
async fn keeps_to_the_cap_and_puts_back_what_it_may_not_change() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(
        |copy: &Path, _: &str, _| {
            for n in 1..=4 {
                std::fs::write(
                    copy.join(format!("items/c{n}.md")),
                    card(&format!("Q{n}?"), "A."),
                )
                .unwrap();
            }
            std::fs::write(copy.join("pack.toml"), "id = \"changed\"").unwrap();
            std::fs::write(copy.join("items/faces.md"), card("Changed?", "Yes.")).unwrap();
            std::fs::write(copy.join("notes.md"), "notes").unwrap();
            "{\"items\": []}".to_owned()
        },
        reviewer("21", vec![agrees()]),
    );
    let limits = Limits {
        max_items: 2,
        ..LIMITS
    };
    let (report, _) = run_with(dir.path(), &fake, limits).await;
    let accepted: Vec<&str> = report.accepted.iter().map(|w| w.path.as_str()).collect();
    assert_eq!(accepted, ["items/c1.md", "items/c2.md"]);
    let dropped: Vec<&str> = report.dropped.iter().map(|w| w.path.as_str()).collect();
    assert_eq!(dropped, ["items/c4.md", "items/c3.md"]);
    assert!(
        report.dropped[0]
            .reason
            .as_deref()
            .unwrap()
            .contains("limit of 2")
    );
    assert_eq!(report.put_back, ["items/faces.md", "notes.md", "pack.toml"]);
    let copy = dir.path().join("work/pack");
    assert_eq!(
        std::fs::read_to_string(copy.join("pack.toml")).unwrap(),
        MANIFEST
    );
}

#[tokio::test]
async fn has_the_writer_fix_an_item_that_fails_its_check() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(
        |copy: &Path, prompt: &str, n| {
            let answer = if n == 0 { "1/2" } else { "1/6" };
            if n == 1 {
                assert!(prompt.contains("items/doubles.md"), "{prompt}");
            }
            std::fs::write(copy.join("items/doubles.md"), doubles(answer)).unwrap();
            "{\"items\": [{\"path\": \"items/doubles.md\"}]}".to_owned()
        },
        reviewer("1/6", vec![agrees()]),
    );
    let (report, _) = run_with(dir.path(), &fake, LIMITS).await;
    assert_eq!(report.accepted.len(), 1, "{report:#?}");
    assert!(report.accepted[0].files["items/doubles.md"].contains("answer = \"1/6\""));

    // One that's never fixed is dropped.
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(
        |copy: &Path, _: &str, _| {
            std::fs::write(copy.join("items/doubles.md"), doubles("1/2")).unwrap();
            "{}".to_owned()
        },
        reviewer("1/6", vec![agrees()]),
    );
    let (report, _) = run_with(dir.path(), &fake, LIMITS).await;
    assert!(report.accepted.is_empty());
    assert!(
        report.dropped[0]
            .reason
            .as_deref()
            .unwrap()
            .starts_with("its check didn't pass")
    );
    assert_eq!(fake.writes.lock().unwrap().len(), 1 + LIMITS.fix_rounds);
}

#[tokio::test]
async fn accepts_an_item_once_a_disagreement_is_settled() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(
        |copy: &Path, prompt: &str, n| {
            if n == 0 {
                std::fs::write(copy.join("items/pips.md"), card("How many pips?", "21.")).unwrap();
                return "{\"items\": [{\"path\": \"items/pips.md\"}]}".to_owned();
            }
            assert!(prompt.contains("Which die?"), "{prompt}");
            std::fs::write(
                copy.join("items/pips.md"),
                card("How many pips on a standard die?", "21."),
            )
            .unwrap();
            "{\"position\": \"revised\", \"reply\": \"Said it's a standard die.\"}".to_owned()
        },
        reviewer("21", vec![objects("Which die?"), agrees()]),
    );
    let (report, _) = run_with(dir.path(), &fake, LIMITS).await;
    assert_eq!(report.accepted.len(), 1, "{report:#?}");
    let item = &report.accepted[0];
    assert!(item.files["items/pips.md"].contains("standard die"));
    let who: Vec<&str> = item.transcript.iter().map(|t| t.who.as_str()).collect();
    assert_eq!(who, ["reviewer", "reviewer", "writer", "reviewer"]);
}

#[tokio::test]
async fn queues_an_item_they_cant_agree_on() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(
        |copy: &Path, _: &str, n| {
            if n == 0 {
                std::fs::write(copy.join("items/pips.md"), card("How many pips?", "21.")).unwrap();
                return "{\"items\": [{\"path\": \"items/pips.md\"}]}".to_owned();
            }
            "{\"position\": \"stands\", \"reply\": \"Dice have six faces.\"}".to_owned()
        },
        reviewer("21", vec![objects("Which die?")]),
    );
    let (report, _) = run_with(dir.path(), &fake, LIMITS).await;
    assert!(report.accepted.is_empty());
    assert_eq!(report.queued.len(), 1);
    assert!(
        report.queued[0]
            .reason
            .as_deref()
            .unwrap()
            .contains("Which die?")
    );
    // The first draft, and one answer each round.
    assert_eq!(
        fake.writes.lock().unwrap().len(),
        1 + LIMITS.discussion_rounds
    );
}

#[tokio::test]
async fn objects_to_a_numeric_answer_that_differs_whatever_the_reviewer_says() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(
        |copy: &Path, _: &str, n| {
            if n == 0 {
                std::fs::write(copy.join("items/doubles.md"), doubles("1/6")).unwrap();
            }
            "{\"position\": \"stands\", \"reply\": \"It's 1/6.\"}".to_owned()
        },
        reviewer("1/3", vec![agrees(), objects("Still 1/3")]),
    );
    let limits = Limits {
        discussion_rounds: 1,
        ..LIMITS
    };
    let (report, _) = run_with(dir.path(), &fake, limits).await;
    assert_eq!(report.queued.len(), 1, "{report:#?}");
    assert!(
        report.queued[0]
            .reason
            .as_deref()
            .unwrap()
            .contains("Still 1/3")
    );
    let first = &report.queued[0].transcript;
    assert_eq!(first[0].who, "reviewer");
}

#[tokio::test]
async fn notes_the_draft_an_item_was_made_from() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(
        |copy: &Path, _: &str, _| {
            std::fs::write(
                copy.join("items/two-sixes.md"),
                card("What's the chance of two sixes?", "1/36."),
            )
            .unwrap();
            std::fs::remove_file(copy.join("drafts/two-sixes.md")).unwrap();
            "{\"items\": [{\"path\": \"items/two-sixes.md\", \"from_draft\": \"drafts/two-sixes.md\"}]}".to_owned()
        },
        reviewer("1/36", vec![agrees()]),
    );
    let (report, _) = run_with(dir.path(), &fake, LIMITS).await;
    assert_eq!(
        report.accepted[0].from_draft.as_deref(),
        Some("drafts/two-sixes.md")
    );
}

#[tokio::test]
async fn notes_a_draft_the_writer_left_in_place() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(
        |copy: &Path, _: &str, _| {
            std::fs::write(
                copy.join("items/two-sixes.md"),
                card("What's the chance of two sixes?", "1/36."),
            )
            .unwrap();
            "{\"items\": [{\"path\": \"items/two-sixes.md\", \"from_draft\": \"drafts/two-sixes.md\"}]}".to_owned()
        },
        reviewer("1/36", vec![agrees()]),
    );
    let (report, _) = run_with(dir.path(), &fake, LIMITS).await;
    assert_eq!(
        report.accepted[0].from_draft.as_deref(),
        Some("drafts/two-sixes.md")
    );
}

#[tokio::test]
async fn ignores_a_draft_named_that_isnt_one() {
    for named in [
        "pack.toml",
        "drafts/missing.md",
        "drafts/../pack.toml",
        "items/x.md",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let fake = Fake::new(
            move |copy: &Path, _: &str, _| {
                std::fs::write(
                    copy.join("items/two-sixes.md"),
                    card("What's the chance of two sixes?", "1/36."),
                )
                .unwrap();
                format!(
                    "{{\"items\": [{{\"path\": \"items/two-sixes.md\", \"from_draft\": \"{named}\"}}]}}"
                )
            },
            reviewer("1/36", vec![agrees()]),
        );
        let (report, _) = run_with(dir.path(), &fake, LIMITS).await;
        assert_eq!(report.accepted[0].from_draft, None, "{named}");
    }
}

#[test]
fn reads_the_json_at_the_end_of_a_reply() {
    #[derive(Deserialize, Debug, PartialEq)]
    struct A {
        a: u32,
    }
    assert_eq!(
        json_in::<A>("Here {not json} then {\"a\": 1}").unwrap(),
        A { a: 1 }
    );
    assert!(json_in::<A>("nothing").is_err());
}
