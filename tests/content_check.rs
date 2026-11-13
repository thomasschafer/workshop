//! The local content check in scripts/content-check, run against throwaway git repos.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const DENYLIST: &str = "\
# Phrases a commit mustn't add.
wombat

Blue Lagoon
";

struct Repo {
    dir: tempfile::TempDir,
    denylist: PathBuf,
}

impl Repo {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let denylist = dir.path().join("denylist.txt");
        std::fs::write(&denylist, DENYLIST).unwrap();
        let repo = Self { dir, denylist };
        std::fs::create_dir(repo.path()).unwrap();
        repo.git(&["init", "--quiet"]);
        repo
    }

    fn path(&self) -> PathBuf {
        self.dir.path().join("repo")
    }

    fn git(&self, args: &[&str]) -> Output {
        Command::new("git")
            .args(args)
            .current_dir(self.path())
            .env("GIT_AUTHOR_NAME", "Tests")
            .env("GIT_AUTHOR_EMAIL", "tests@example.com")
            .env("GIT_COMMITTER_NAME", "Tests")
            .env("GIT_COMMITTER_EMAIL", "tests@example.com")
            .env("CONTENT_CHECK_DENYLIST", &self.denylist)
            .output()
            .unwrap()
    }

    fn write(&self, file: &str, contents: impl AsRef<[u8]>) {
        let path = self.path().join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    fn stage(&self, file: &str, contents: impl AsRef<[u8]>) {
        self.write(file, contents);
        assert!(self.git(&["add", file]).status.success());
    }

    fn commit_quietly(&self, message: &str) {
        let output = self.git(&["commit", "--quiet", "--no-verify", "-m", message]);
        assert!(output.status.success(), "{output:?}");
    }

    /// Runs the check as a hook would, with the denylist or without.
    fn check(&self, denylist: Option<&Path>, message_file: Option<&Path>) -> Output {
        let mut command = Command::new(script());
        command.current_dir(self.path());
        match denylist {
            Some(denylist) => command.env("CONTENT_CHECK_DENYLIST", denylist),
            None => command.env_remove("CONTENT_CHECK_DENYLIST"),
        };
        if let Some(file) = message_file {
            command.arg(file);
        }
        command.output().unwrap()
    }

    fn check_staged(&self) -> Output {
        self.check(Some(&self.denylist), None)
    }

    fn check_message(&self, message: &str) -> Output {
        let file = self.dir.path().join("COMMIT_EDITMSG");
        std::fs::write(&file, message).unwrap();
        self.check(Some(&self.denylist), Some(&file))
    }
}

fn script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/content-check")
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// Refused, saying where, without repeating what matched.
fn assert_refused(output: &Output, wheres: &[&str]) {
    let stderr = stderr(output);
    assert!(!output.status.success(), "{stderr}");
    for place in wheres {
        assert!(
            stderr.contains(&format!("content check: {place} matches the denylist")),
            "{stderr}"
        );
    }
    let lowered = stderr.to_lowercase();
    assert!(!lowered.contains("wombat"), "{stderr}");
    assert!(!lowered.contains("blue lagoon"), "{stderr}");
}

#[test]
fn does_nothing_without_a_denylist() {
    let repo = Repo::new();
    repo.stage("notes.md", "A wombat.\n");
    assert!(repo.check(None, None).status.success());
}

#[test]
fn fails_when_the_denylist_is_missing() {
    let repo = Repo::new();
    repo.stage("notes.md", "Nothing to see.\n");
    let output = repo.check(Some(&repo.dir.path().join("nowhere.txt")), None);
    assert!(!output.status.success());
    assert!(
        stderr(&output).contains("isn't a file"),
        "{}",
        stderr(&output)
    );
}

#[test]
fn refuses_added_lines_with_a_phrase_in_any_case() {
    let repo = Repo::new();
    repo.stage("notes.md", "First line.\nSee the WOMBAT.\n");
    repo.stage(
        "docs/trip.md",
        "One\nTwo\nOff to the blue lagoon, then home.\n",
    );
    assert_refused(&repo.check_staged(), &["notes.md:2", "docs/trip.md:3"]);
}

#[test]
fn only_matches_whole_words() {
    let repo = Repo::new();
    repo.stage(
        "notes.md",
        "wombats and supwombat, wombat_case\nblue lagoons\n",
    );
    assert!(repo.check_staged().status.success());
    repo.stage("notes.md", "(wombat), blue  lagoon\nwombat-shaped\n");
    assert_refused(&repo.check_staged(), &["notes.md:1", "notes.md:2"]);
}

#[test]
fn ignores_comments_and_blank_lines_in_the_denylist() {
    let repo = Repo::new();
    repo.stage("notes.md", "# Phrases a commit mustn't add.\n\n");
    assert!(repo.check_staged().status.success());
}

#[test]
fn only_checks_lines_the_commit_adds() {
    let repo = Repo::new();
    repo.stage("notes.md", "A wombat.\nOne\nTwo\n");
    repo.commit_quietly("Add notes");
    repo.stage("notes.md", "A wombat.\nOne\nThree\n");
    assert!(repo.check_staged().status.success());
    // Removing a line with a phrase is fine too.
    repo.stage("notes.md", "One\nThree\n");
    assert!(repo.check_staged().status.success());
    // Unlike adding one further down.
    repo.stage("notes.md", "One\nThree\nAnother wombat.\n");
    assert_refused(&repo.check_staged(), &["notes.md:3"]);
}

#[test]
fn skips_binary_files() {
    let repo = Repo::new();
    repo.stage("image.bin", b"\x00\x01wombat\x00\n");
    assert!(repo.check_staged().status.success());
}

#[test]
fn reads_lines_that_look_like_diff_headers_as_lines() {
    let repo = Repo::new();
    repo.stage("notes.md", "++ wombat\n");
    assert_refused(&repo.check_staged(), &["notes.md:1"]);
}

#[test]
fn refuses_a_message_with_a_phrase() {
    let repo = Repo::new();
    assert!(repo.check_message("Tidy the notes\n").status.success());
    assert_refused(
        &repo.check_message("Tidy the notes\n\nFor the Blue Lagoon trip.\n"),
        &["the commit message, line 3"],
    );
    // Not the comments git leaves out of it, or the diff below the scissors.
    let message = "Tidy the notes\n# wombat\n\
        # ------------------------ >8 ------------------------\n+wombat\n";
    assert!(repo.check_message(message).status.success());
}

#[test]
fn works_as_the_repos_hooks() {
    let repo = Repo::new();
    let hooks = repo.path().join(".git/hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    for hook in ["pre-commit", "commit-msg"] {
        std::os::unix::fs::symlink(script(), hooks.join(hook)).unwrap();
    }
    repo.stage("notes.md", "A wombat.\n");
    let output = repo.git(&["commit", "--quiet", "-m", "Add notes"]);
    assert_refused(&output, &["notes.md:1"]);

    repo.stage("notes.md", "Nothing to see.\n");
    let output = repo.git(&["commit", "--quiet", "-m", "Add notes\n\nAbout a wombat."]);
    assert_refused(&output, &["the commit message, line 3"]);

    let output = repo.git(&["commit", "--quiet", "-m", "Add notes"]);
    assert!(output.status.success(), "{}", stderr(&output));
}
