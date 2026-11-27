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
            lesson_requests: Vec::new(),
            skill_coverage: Vec::new(),
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

fn sample_svg() -> &'static str {
    "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 200 60\">\
     <rect x=\"10\" y=\"10\" width=\"180\" height=\"40\" fill=\"none\" stroke=\"currentColor\"/>\
     <text x=\"100\" y=\"35\" text-anchor=\"middle\" fill=\"currentColor\">Sum 7</text>\
     </svg>\n"
}

fn sample_lesson(seg1: &str) -> String {
    format!(
        "+++\nkind = \"lesson\"\ntitle = \"Counting dice sums\"\nskills = [\"dice.sums\"]\n\n[[sources]]\ntitle = \"Introductory probability notes\"\nurl = \"https://example.com/dice-sums\"\n\n[[guesses]]\nprompt = \"Which sum of two fair six-sided dice is most likely?\"\nchoices = [\"6\", \"7\", \"8\"]\nanswer = 2\n\n[[checks]]\nsegment = 1\nprompt = \"How many ordered pairs of two dice sum to 7?\"\nchoices = [\"5\", \"6\", \"7\"]\nanswer = 2\nexplanation = \"The pairs (1,6) through (6,1) give 6 ways.\"\n+++\nWhy two dice sum to 7 more often than any other total.\n\n## Pairs and symmetry\n\n{seg1}\n\n![Pairs summing to seven](pairs.svg)\n\n## Explain\n\nWhy does 7 have more outcomes than 2 when rolling two fair dice?\n\n## Explain answer\n\nEvery value 1..6 on the first die pairs with 7 minus it on the second, giving 6 of the 36 pairs, whereas 2 only occurs as (1, 1).\n"
    )
}

fn linked_card(lesson: &str, segment: usize, question: &str, answer: &str) -> String {
    format!(
        "+++\nkind = \"card\"\nskills = [\"dice.sums\"]\nlesson = \"{lesson}\"\nsegment = {segment}\n+++\n{question}\n\n## Answer\n\n{answer}\n"
    )
}

fn write_lesson_bundle(copy: &Path, count: usize, seg1: &str) {
    let dir = copy.join("items/lessons/dice-sums");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("item.md"), sample_lesson(seg1)).unwrap();
    std::fs::write(dir.join("pairs.svg"), sample_svg()).unwrap();
    for i in 1..=count {
        std::fs::write(
            copy.join(format!("items/lcard{i}.md")),
            linked_card("dice-sums", 1, &format!("Lesson card {i}?"), "Six."),
        )
        .unwrap();
    }
}

#[tokio::test]
async fn writes_lesson_bundle_counts_as_one_towards_cap_and_links_existing_items() {
    let dir = tempfile::tempdir().unwrap();
    let pack_dir = pack(dir.path());
    let fake = Fake::new(
        |copy: &Path, _: &str, _| {
            write_lesson_bundle(copy, 3, "Each of 36 ordered pairs is equally likely.");
            std::fs::write(
                copy.join("items/standalone.md"),
                card("What is the smallest sum of two dice?", "2."),
            )
            .unwrap();
            // Link the existing card items/faces.md to the new lesson.
            let linked_existing = "+++\nkind = \"card\"\nskills = [\"dice.sums\"]\nlesson = \"dice-sums\"\nsegment = 1\n+++\nHow many faces has a die?\n\n## Answer\n\nSix.\n";
            std::fs::write(copy.join("items/faces.md"), linked_existing).unwrap();
            "{\"items\": []}".to_owned()
        },
        |prompt: &str, _| {
            if prompt.starts_with("Solve this") {
                solved("6")
            } else {
                agrees()
            }
        },
    );
    let brief = Brief {
        lesson_requests: vec![super::LessonRequest {
            path: "items/faces.md".to_owned(),
            id: "faces".to_owned(),
            prompt: "How many faces has a die?".to_owned(),
            answer: "Six.".to_owned(),
            explanation: Some("A standard die is a cube.".to_owned()),
            skills: vec!["dice.sums".to_owned()],
        }],
        skill_coverage: vec![super::SkillCoverage {
            skill: "dice.sums".to_owned(),
            lessons: 0,
            unlinked_items: 1,
        }],
        weakest: vec![("dice.sums".to_owned(), 0.2)],
        ..Default::default()
    };
    // max_items = 2: the lesson + 3 items counts as 1, and standalone.md counts as 1.
    let limits = Limits {
        max_items: 2,
        ..LIMITS
    };
    let report = super::run(
        &pack_dir,
        &dir.path().join("work"),
        &fake,
        &NoPrograms,
        &brief,
        limits,
        &|_| {},
    )
    .await
    .unwrap();
    assert!(
        report.queued.is_empty() && report.dropped.is_empty() && report.put_back.is_empty(),
        "{report:#?}"
    );
    // Lesson + 3 bundled items + 1 standalone item = 5 accepted, all under max_items = 2.
    assert_eq!(report.accepted.len(), 5, "{report:#?}");
    assert_eq!(report.linked.len(), 1);
    assert_eq!(report.linked[0].path, "items/faces.md");
    assert_eq!(report.linked[0].lesson, "dice-sums");
    assert_eq!(report.linked[0].segment, Some(1));

    // The writer prompt puts lesson requests first and includes skill coverage.
    let writes = fake.writes.lock().unwrap();
    let req_at = writes[0]
        .find("Requests for lessons come first")
        .expect("requests section");
    let weak_at = writes[0]
        .find("The learner's weakest skills")
        .expect("weakest section");
    assert!(req_at < weak_at, "requests must come before weakest skills");
    assert!(writes[0].contains("How many faces has a die?"));
    assert!(writes[0].contains("A standard die is a cube."));
    assert!(writes[0].contains("- dice.sums: 0 lessons, 1 item without a lesson"));

    // The reviewer audited the lesson (with SVG source and accompanying items) rather than solving it blind.
    let reviews = fake.reviews.lock().unwrap();
    let audit = reviews
        .iter()
        .find(|p| p.starts_with("Audit this lesson"))
        .expect("lesson audit prompt");
    assert!(audit.contains("pairs.svg"));
    assert!(audit.contains("currentColor"));
    assert!(audit.contains("Lesson card 1?"));
}

#[tokio::test]
async fn lesson_failing_check_drops_its_items_and_puts_back_its_links() {
    let dir = tempfile::tempdir().unwrap();
    let too_long = "word ".repeat(310);
    let fake = Fake::new(
        move |copy: &Path, _: &str, n| {
            if n == 0 {
                write_lesson_bundle(copy, 3, &too_long);
                let linked_existing = "+++\nkind = \"card\"\nskills = [\"dice.sums\"]\nlesson = \"dice-sums\"\nsegment = 1\n+++\nHow many faces has a die?\n\n## Answer\n\nSix.\n";
                std::fs::write(copy.join("items/faces.md"), linked_existing).unwrap();
            }
            "{\"items\": []}".to_owned()
        },
        reviewer("6", vec![agrees()]),
    );
    let (report, _) = run_with(dir.path(), &fake, LIMITS).await;
    assert!(report.accepted.is_empty(), "{report:#?}");
    assert!(report.linked.is_empty(), "{report:#?}");
    assert!(report.queued.is_empty(), "{report:#?}");
    // The lesson and all 3 of its items were dropped.
    assert_eq!(report.dropped.len(), 4, "{report:#?}");
    assert!(report.put_back.contains(&"items/faces.md".to_owned()));
    // Link on existing item was restored in the copy.
    let copy_faces = std::fs::read_to_string(dir.path().join("work/pack/items/faces.md")).unwrap();
    assert!(!copy_faces.contains("lesson ="));
}

#[tokio::test]
async fn failing_item_leaves_lesson_unless_fewer_than_three_remain() {
    // 4 items, 1 fails its check -> 3 remain -> lesson and 3 items accepted.
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(
        |copy: &Path, _: &str, n| {
            if n == 0 {
                write_lesson_bundle(copy, 3, "Short explanation.");
                // 4th item is a probability item with wrong answer so its simulation fails.
                let bad_prob = "+++\nkind = \"probability\"\nskills = [\"dice.sums\"]\nlesson = \"dice-sums\"\nsegment = 1\nanswer = \"1/2\"\n\n[simulation]\ntrials = 20000\ntolerance = 0.02\n+++\nTwo dice match?\n\n## Solution\n\n1/6.\n\n## Simulation\n\n```rhai\nrand_int(1, 6) == rand_int(1, 6)\n```\n";
                std::fs::write(copy.join("items/lbad.md"), bad_prob).unwrap();
            }
            "{\"items\": []}".to_owned()
        },
        |prompt: &str, _| {
            if prompt.starts_with("Solve this") {
                solved("6")
            } else {
                agrees()
            }
        },
    );
    let (report, _) = run_with(dir.path(), &fake, LIMITS).await;
    assert_eq!(report.accepted.len(), 4, "{report:#?}");
    assert_eq!(report.dropped.len(), 1, "{report:#?}");
    assert_eq!(report.dropped[0].path, "items/lbad.md");

    // 3 items, 1 fails its check -> only 2 remain -> lesson and all 3 items dropped, links put back.
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(
        |copy: &Path, _: &str, n| {
            if n == 0 {
                write_lesson_bundle(copy, 2, "Short explanation.");
                let bad_prob = "+++\nkind = \"probability\"\nskills = [\"dice.sums\"]\nlesson = \"dice-sums\"\nsegment = 1\nanswer = \"1/2\"\n\n[simulation]\ntrials = 20000\ntolerance = 0.02\n+++\nTwo dice match?\n\n## Solution\n\n1/6.\n\n## Simulation\n\n```rhai\nrand_int(1, 6) == rand_int(1, 6)\n```\n";
                std::fs::write(copy.join("items/lbad.md"), bad_prob).unwrap();
                let linked_existing = "+++\nkind = \"card\"\nskills = [\"dice.sums\"]\nlesson = \"dice-sums\"\nsegment = 1\n+++\nHow many faces has a die?\n\n## Answer\n\nSix.\n";
                std::fs::write(copy.join("items/faces.md"), linked_existing).unwrap();
            }
            "{\"items\": []}".to_owned()
        },
        |prompt: &str, _| {
            if prompt.starts_with("Solve this") {
                solved("6")
            } else {
                agrees()
            }
        },
    );
    let (report, _) = run_with(dir.path(), &fake, LIMITS).await;
    assert!(report.accepted.is_empty(), "{report:#?}");
    assert!(report.linked.is_empty(), "{report:#?}");
    assert_eq!(report.dropped.len(), 4, "{report:#?}");
    assert!(report.put_back.contains(&"items/faces.md".to_owned()));
}

#[tokio::test]
async fn lesson_audit_objection_leads_to_revision_and_acceptance() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(
        |copy: &Path, prompt: &str, n| {
            if n == 0 {
                write_lesson_bundle(copy, 3, "Every die always has six faces.");
                return "{\"items\": []}".to_owned();
            }
            assert!(
                prompt.contains("standard six-sided"),
                "expected audit objection in prompt: {prompt}"
            );
            std::fs::write(
                copy.join("items/lessons/dice-sums/item.md"),
                sample_lesson("A standard six-sided die has faces 1 through 6."),
            )
            .unwrap();
            "{\"position\": \"revised\", \"reply\": \"Qualified that this is for standard six-sided dice.\"}".to_owned()
        },
        |prompt: &str, _| {
            if prompt.starts_with("Audit this lesson") {
                if prompt.contains("<author>") {
                    agrees()
                } else {
                    objects("Say standard six-sided dice rather than every die.")
                }
            } else if prompt.starts_with("Solve this") {
                solved("6")
            } else {
                agrees()
            }
        },
    );
    let (report, _) = run_with(dir.path(), &fake, LIMITS).await;
    assert_eq!(report.accepted.len(), 4, "{report:#?}");
    let lesson = report
        .accepted
        .iter()
        .find(|w| w.path == "items/lessons/dice-sums/item.md")
        .unwrap();
    assert!(
        lesson.files["items/lessons/dice-sums/item.md"]
            .contains("standard six-sided die has faces 1 through 6")
    );
    let who: Vec<&str> = lesson.transcript.iter().map(|t| t.who.as_str()).collect();
    assert_eq!(who, ["reviewer", "writer", "reviewer"]);
}

#[tokio::test]
async fn lesson_waiting_for_approval_holds_its_items_and_links() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(
        |copy: &Path, _: &str, n| {
            if n == 0 {
                write_lesson_bundle(copy, 3, "Short explanation.");
                let linked_existing = "+++\nkind = \"card\"\nskills = [\"dice.sums\"]\nlesson = \"dice-sums\"\nsegment = 1\n+++\nHow many faces has a die?\n\n## Answer\n\nSix.\n";
                std::fs::write(copy.join("items/faces.md"), linked_existing).unwrap();
                return "{\"items\": []}".to_owned();
            }
            "{\"position\": \"stands\", \"reply\": \"The claim is standard.\"}".to_owned()
        },
        |prompt: &str, _| {
            if prompt.starts_with("Audit this lesson") {
                objects("Needs a primary source for that claim.")
            } else if prompt.starts_with("Solve this") {
                solved("6")
            } else {
                agrees()
            }
        },
    );
    let (report, _) = run_with(dir.path(), &fake, LIMITS).await;
    assert!(report.accepted.is_empty(), "{report:#?}");
    assert!(report.linked.is_empty(), "{report:#?}");
    assert_eq!(report.queued.len(), 1, "{report:#?}");
    let queued = &report.queued[0];
    assert_eq!(queued.path, "items/lessons/dice-sums/item.md");
    assert_eq!(queued.items.len(), 3);
    assert_eq!(queued.linked.len(), 1);
    assert_eq!(queued.linked[0].path, "items/faces.md");
    // In the copy, the existing item was put back so it isn't left with a dangling link.
    let copy_faces = std::fs::read_to_string(dir.path().join("work/pack/items/faces.md")).unwrap();
    assert!(!copy_faces.contains("lesson ="));
}

#[tokio::test]
async fn linking_existing_items_puts_back_other_changes() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(
        |copy: &Path, _: &str, _| {
            write_lesson_bundle(copy, 3, "Short explanation.");
            // Modify both the front matter link AND the body of items/faces.md -> must be put back.
            let tampered = "+++\nkind = \"card\"\nskills = [\"dice.sums\"]\nlesson = \"dice-sums\"\nsegment = 1\n+++\nHow many faces has a die?\n\n## Answer\n\nSeven.\n";
            std::fs::write(copy.join("items/faces.md"), tampered).unwrap();
            "{\"items\": []}".to_owned()
        },
        |prompt: &str, _| {
            if prompt.starts_with("Solve this") {
                solved("6")
            } else {
                agrees()
            }
        },
    );
    let (report, _) = run_with(dir.path(), &fake, LIMITS).await;
    assert_eq!(report.accepted.len(), 4, "{report:#?}");
    assert!(report.linked.is_empty(), "{report:#?}");
    assert_eq!(report.put_back, ["items/faces.md"]);
    let copy_faces = std::fs::read_to_string(dir.path().join("work/pack/items/faces.md")).unwrap();
    assert!(copy_faces.contains("Six."));
    assert!(!copy_faces.contains("lesson ="));
}
