//! Runs of the author through the model CLIs' own commands, with stand-ins for the CLIs, so no
//! model is ever called.

use std::path::Path;

use super::*;

/// A stand-in CLI: each call notes where it ran and its arguments, copies the files in
/// `write-<n>/` into where it runs, if there are any, and prints `reply-<n>`, counting calls
/// from 0. With `debug models`, it prints a model catalog.
fn fake_cli(dir: &Path, name: &str) -> String {
    let home = dir.join(name);
    std::fs::create_dir_all(&home).unwrap();
    let script = format!(
        r#"home='{home}'
if [ "$1" = debug ]; then echo '{{"models":[{{"slug":"gpt-9-sol"}}]}}'; exit 0; fi
n=$(cat "$home/count" 2>/dev/null || echo 0); echo $((n + 1)) > "$home/count"
pwd >> "$home/ran-in"
printf '%s\n' "$@" > "$home/args-$n"
cat > "$home/prompt-$n"
if [ -d "$home/write-$n" ]; then cp -R "$home/write-$n/." .; fi
case "$(head -c 10 "$home/prompt-$n")" in
  "Solve this") cat "$home/solved" ;;
  *) if grep -q 'sides.md' "$home/prompt-$n" && [ -f "$home/objects" ]; then cat "$home/objects"; else cat "$home/reply-$n" 2>/dev/null || cat "$home/reply"; fi ;;
esac
"#,
        home = home.display()
    );
    let path = home.join("cli.sh");
    std::fs::write(&path, script).unwrap();
    path.display().to_string()
}

fn claude_result(text: &str) -> String {
    serde_json::json!({ "type": "result", "is_error": false, "result": text }).to_string()
}

fn codex_message(text: &str) -> String {
    serde_json::json!({ "type": "item.completed", "item": { "type": "agent_message", "text": text } })
        .to_string()
}

fn card(question: &str) -> String {
    format!(
        "+++\nkind = \"card\"\nskills = [\"probability.counting\"]\n+++\n{question}\n\n## Answer\n\n21.\n"
    )
}

struct Setup {
    _dir: tempfile::TempDir,
    root: std::path::PathBuf,
    pack: std::path::PathBuf,
    config: Config,
    paths: Paths,
    learning: Learning,
    desk: Desk,
}

/// A copy of the sample pack in a git repo, and Claude Code and Codex as the author's writer and
/// reviewer, with their built-in commands, run by stand-ins.
fn setup() -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_owned();
    let pack = root.join("pack");
    crate::pack_files::testing::sample_pack_repo(&pack);
    let mut config = Config::parse(&format!(
        "[learning]\npacks = [{:?}]\n[author]\nmax_items = 3\ndiscussion_rounds = 1\nfix_rounds = 1\n",
        pack.display().to_string()
    ))
    .unwrap();
    let claude = fake_cli(&root, "claude");
    let codex = fake_cli(&root, "codex");
    let providers = &mut config.providers;
    let writer = providers.get_mut("claude").unwrap().agent.as_mut().unwrap();
    writer.command[0] = "sh".to_owned();
    writer.command.insert(1, claude);
    let reviewer = providers.get_mut("codex").unwrap();
    reviewer.command[0] = "sh".to_owned();
    reviewer.command.insert(1, codex.clone());
    reviewer.model_catalog = Some(vec![
        "sh".to_owned(),
        codex,
        "debug".to_owned(),
        "models".to_owned(),
    ]);
    reviewer.prespawn = false;
    config.solutions_dir = root.join("aoc");
    let paths = Paths::under(&root.join("home"));
    let learning = Learning::open(&config.learning, &paths.data_dir).unwrap();
    let desk = Desk::new(&paths.data_dir);
    Setup {
        _dir: dir,
        root,
        pack,
        config,
        paths,
        learning,
        desk,
    }
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

#[tokio::test]
async fn adds_what_both_agree_on_and_queues_the_rest() {
    let s = setup();
    let claude = s.root.join("claude");
    write(
        &claude.join("write-0/items/author/pips.md"),
        &card("How many pips on a standard die?"),
    );
    write(
        &claude.join("write-0/items/author/sides.md"),
        &card("How many sides?"),
    );
    // The writer tries to change the pack's manifest too, which is put back.
    write(
        &claude.join("write-0/pack.toml"),
        "id = \"taken-over\"\nname = \"x\"\n",
    );
    write(
        &claude.join("reply-0"),
        &claude_result(
            "Written.\n{\"items\": [{\"path\": \"items/author/pips.md\"}, {\"path\": \"items/author/sides.md\"}], \"questions\": [\"Shall I write more about dice?\"]}",
        ),
    );
    write(
        &claude.join("reply"),
        &claude_result("{\"position\": \"stands\", \"reply\": \"Any die has sides.\"}"),
    );
    let codex = s.root.join("codex");
    write(
        &codex.join("solved"),
        &codex_message("{\"answer\": \"21\", \"working\": \"1+2+...+6\"}"),
    );
    write(
        &codex.join("reply"),
        &codex_message("{\"agree\": true, \"ambiguous\": false, \"objection\": \"\"}"),
    );
    write(
        &codex.join("objects"),
        &codex_message(
            "{\"agree\": false, \"ambiguous\": true, \"objection\": \"Sides of what?\"}",
        ),
    );

    let notifier = Arc::new(workshop_push::Notifier::load(&s.paths.data_dir).unwrap());
    let last = run(&s.config, &s.paths, &s.learning, &s.desk, notifier, None)
        .await
        .unwrap();
    assert_eq!(last.error, None, "{last:#?}");
    let report = last.report.as_ref().unwrap();
    assert_eq!(report.accepted.len(), 1, "{report:#?}");
    assert_eq!(report.accepted[0].path, "items/author/pips.md");
    assert_eq!(report.put_back, ["pack.toml"]);

    // Added to the pack and committed, on its branch, and the rest of the pack as it was.
    assert!(s.pack.join("items/author/pips.md").is_file());
    assert!(!s.pack.join("items/author/sides.md").exists());
    assert!(
        std::fs::read_to_string(s.pack.join("pack.toml"))
            .unwrap()
            .starts_with("# The sample pack")
    );
    let log = crate::pack_files::testing::log(&s.pack);
    assert_eq!(
        log[0],
        "Add an item from the author: How many pips on a standard die?"
    );
    assert!(last.commit.is_some());
    let status = crate::workspace::git(&s.pack, &["status", "--porcelain"])
        .await
        .unwrap();
    assert_eq!(status.trim(), "");

    // The writer ran in a copy of the pack, never the pack itself, confined as Claude Code's
    // agent command says.
    let ran_in = std::fs::read_to_string(claude.join("ran-in")).unwrap();
    for dir in ran_in.lines() {
        assert!(Path::new(dir).ends_with("copy/pack"), "{dir}");
        assert!(!Path::new(dir).starts_with(&s.pack));
    }
    let args = std::fs::read_to_string(claude.join("args-0")).unwrap();
    let args: Vec<&str> = args.lines().collect();
    assert!(args.contains(&"--restricted"));
    assert!(
        args.windows(2)
            .any(|w| w == ["--tools", "Read,Edit,Write,Glob,Grep"])
    );
    assert!(
        args.windows(2)
            .any(|w| w == ["--permission-prompts", "none"])
    );
    assert!(args.windows(2).any(|w| w == ["--model", "opus"]));
    // The reviewer runs with no tools, in its read-only sandbox, with the newest Sol.
    let args = std::fs::read_to_string(codex.join("args-0")).unwrap();
    assert!(
        args.lines()
            .collect::<Vec<_>>()
            .windows(2)
            .any(|w| w == ["--sandbox", "read-only"])
    );
    assert!(args.contains("gpt-9-sol"));
    assert!(!args.contains("workspace-write"));
    // Blind first: the answer wasn't in what it was asked to solve.
    let blind = std::fs::read_to_string(codex.join("prompt-0")).unwrap();
    assert!(blind.starts_with("Solve this"));
    assert!(!blind.contains("## Answer"));

    // What they couldn't agree on waits for approval, and the question is kept to answer.
    let queue = s.desk.queue().unwrap();
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].item.path, "items/author/sides.md");
    assert!(
        queue[0]
            .item
            .reason
            .as_deref()
            .unwrap()
            .contains("Sides of what?")
    );
    let questions = s.desk.questions().unwrap();
    assert_eq!(questions[0].text, "Shall I write more about dice?");
    assert_eq!(s.desk.last_run().unwrap(), Some(last.clone()));
    assert!(summary(&last).contains("Waiting for your approval in the app:"));

    // Approved in the app, it's checked again, added and committed.
    let commit = approve(&s.config, &s.paths, &s.desk, &queue[0].id)
        .await
        .unwrap();
    assert!(commit.is_some());
    assert!(s.pack.join("items/author/sides.md").is_file());
    assert!(s.desk.queue().unwrap().is_empty());
    assert!(
        crate::pack_files::testing::log(&s.pack)[0]
            .starts_with("Add an item from the author, approved")
    );

    // The answer to its question goes to the next run, once.
    s.desk.answer(&questions[0].id, "Yes, harder ones").unwrap();
    write(&claude.join("reply-2"), &claude_result("{\"items\": []}"));
    let notifier = Arc::new(workshop_push::Notifier::load(&s.paths.data_dir).unwrap());
    let next = run(&s.config, &s.paths, &s.learning, &s.desk, notifier, None)
        .await
        .unwrap();
    assert_eq!(next.error, None);
    let prompt = std::fs::read_to_string(claude.join("prompt-2")).unwrap();
    assert!(prompt.contains("A: Yes, harder ones"), "{prompt}");
    assert!(s.desk.questions().unwrap()[0].told);
}

#[tokio::test]
async fn refuses_to_run_without_a_pack_of_ones_own_or_with_one_provider() {
    let s = setup();
    let notifier = || Arc::new(workshop_push::Notifier::load(&s.paths.data_dir).unwrap());
    let mut same = s.config.clone();
    same.author.reviewer.provider = "claude".to_owned();
    let last = run(&same, &s.paths, &s.learning, &s.desk, notifier(), None)
        .await
        .unwrap();
    assert!(last.error.unwrap().contains("another provider"));

    let mut sample = s.config.clone();
    sample.learning.packs.clear();
    let last = run(&sample, &s.paths, &s.learning, &s.desk, notifier(), None)
        .await
        .unwrap();
    assert!(last.error.unwrap().contains("pack of your own"));

    // Only one run at a time.
    let _held = s.desk.try_lock().unwrap().unwrap();
    assert!(s.desk.try_lock().unwrap().is_none());
    assert!(
        run(&s.config, &s.paths, &s.learning, &s.desk, notifier(), None)
            .await
            .is_err()
    );
}

#[test]
fn tells_devices_about_a_question() {
    let message = notification("Harder sums?");
    assert_eq!(message.title, "A question from the author");
    assert_eq!(message.url, "/pack");
}

#[tokio::test]
async fn runs_on_its_schedule_for_each_pack_keeping_when_it_last_ran() {
    use std::sync::atomic::{AtomicBool, Ordering};

    use schedule::{Looked, Scheduler};

    let s = setup();
    let claude = s.root.join("claude");
    write(
        &claude.join("reply"),
        &claude_result("Nothing to add.\n{\"items\": [], \"questions\": []}"),
    );
    let calls = || {
        std::fs::read_to_string(claude.join("count"))
            .map_or(0, |count| count.trim().parse::<u32>().unwrap())
    };
    let notifier = Arc::new(workshop_push::Notifier::load(&s.paths.data_dir).unwrap());
    let running = AtomicBool::new(false);
    let now = 1_800_000_000_000;
    let week = 7 * 24 * 60 * 60 * 1000;

    let scheduler = |config, desk| Scheduler {
        config,
        paths: &s.paths,
        learning: &s.learning,
        desk,
        notifier: notifier.clone(),
        running: &running,
    };
    // Off unless it's set.
    assert_eq!(
        scheduler(&s.config, &s.desk).look(now).await.unwrap(),
        Looked::Off
    );

    let mut config = s.config.clone();
    config.author.every = Some("7d".parse().unwrap());
    let scheduled = scheduler(&config, &s.desk);
    // Nothing has run, so it's due now.
    assert_eq!(
        scheduled.look(now).await.unwrap(),
        Looked::Ran(vec!["sample".to_owned()])
    );
    assert_eq!(calls(), 1);
    assert!(!running.load(Ordering::SeqCst));
    assert!(s.desk.last_run().unwrap().unwrap().error.is_none());

    // Not again until a week later, even from a scheduler started afresh, as after a restart.
    let desk = Desk::new(&s.paths.data_dir);
    assert!(matches!(
        scheduler(&config, &desk).look(now + 60_000).await.unwrap(),
        Looked::Wait(_)
    ));
    assert_eq!(
        schedule::next_scheduled(&config, &s.desk, now + 60_000).unwrap(),
        Some(now + week)
    );
    assert_eq!(calls(), 1);

    // While a run from the app is going, it waits.
    running.store(true, Ordering::SeqCst);
    assert_eq!(scheduled.look(now + week).await.unwrap(), Looked::Busy);
    running.store(false, Ordering::SeqCst);
    // And while the command holds the author's lock.
    let held = s.desk.try_lock().unwrap().unwrap();
    assert_eq!(scheduled.look(now + week).await.unwrap(), Looked::Busy);
    drop(held);
    assert_eq!(calls(), 1);

    assert_eq!(
        scheduled.look(now + week).await.unwrap(),
        Looked::Ran(vec!["sample".to_owned()])
    );
    assert_eq!(calls(), 2);

    // Never for the built-in sample pack.
    let mut sample_only = config.clone();
    sample_only.learning.packs.clear();
    assert_eq!(
        scheduler(&sample_only, &s.desk)
            .look(now + 10 * week)
            .await
            .unwrap(),
        Looked::Off
    );
    assert_eq!(calls(), 2);
}

#[test]
fn asks_for_harder_problems_in_the_skills_whose_problems_were_found_too_easy() {
    let s = setup();
    let now = crate::learning::now_ms();
    let attempt = |id: &str, item: &str, rating| workshop_learning::Attempt {
        id: format!("attempt-{id}"),
        item: item.to_owned(),
        answered_at: now,
        duration_ms: 1000,
        rating,
        response: None,
        seed: None,
    };
    use workshop_learning::Rating;
    let record = |a| s.learning.record_problem(a, &[], now).unwrap();
    assert!(record(attempt("1", "sample/islands", Rating::Easy)));
    assert!(record(attempt("2", "sample/fewest-hops", Rating::Easy)));
    assert!(!record(attempt("3", "sample/pair-sums", Rating::Again)));
    let pack = Pack::load(&s.pack).unwrap();
    let brief = brief(&s.learning, &pack, &[], now).unwrap();
    let graphs = &brief.too_easy[0];
    assert_eq!(graphs.skill, "algorithms.graphs");
    assert_eq!(graphs.level, 4);
    let titles: Vec<&str> = graphs.retired.iter().map(|(t, _)| t.as_str()).collect();
    assert_eq!(titles.len(), 2);
    assert!(titles.contains(&"Count the islands"), "{titles:?}");
    assert!(
        brief.levels.contains(&("algorithms.graphs".to_owned(), 4)),
        "{:?}",
        brief.levels
    );
    // Forgotten, a skill's problems should be easier.
    let hashing = brief
        .levels
        .iter()
        .find(|(skill, _)| skill == "algorithms.hashing")
        .unwrap();
    assert!(hashing.1 < 3, "{hashing:?}");
}
