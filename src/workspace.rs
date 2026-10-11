//! The user's solutions repo, and Workshop's own state about each puzzle.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::language::{LanguageProfile, Puzzle};
use crate::paths::{self, Paths};

const SOLUTIONS_GITIGNORE: &str = "\
# Advent of Code asks that puzzle inputs and text aren't published. Workshop keeps them outside
# this repo, but this guards against copies made by hand.
input*.txt
*.input
# Build output
*.o
*.hi
dist-newstyle/
";

pub struct Workspace {
    pub solutions_dir: PathBuf,
    paths: Paths,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodeFile {
    pub text: String,
    /// Identifies this version of the file, so saves can detect changes made elsewhere.
    pub version: String,
    pub path: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum SaveError {
    #[error("the file changed on disk since it was loaded")]
    Conflict { current: CodeFile },
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

/// Per-puzzle state kept outside the solutions repo, because it can contain puzzle text.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct DayMeta {
    pub sample_block: Option<usize>,
    pub sample_input: Option<String>,
    /// Expected sample answers for parts 1 and 2.
    pub sample_answers: [Option<String>; 2],
    /// Cursor position in the editor's own units, restored when the puzzle is reopened.
    pub cursor: Option<usize>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Tab {
    Problem,
    #[default]
    Code,
    Notes,
    Discuss,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct UiState {
    pub puzzle: Option<Puzzle>,
    pub tab: Tab,
    pub discuss_model: Option<String>,
}

impl Workspace {
    pub fn new(solutions_dir: PathBuf, paths: Paths) -> Self {
        Self {
            solutions_dir,
            paths,
        }
    }

    /// Creates the solutions directory as a git repo if it doesn't exist yet.
    pub async fn ensure_repo(&self) -> Result<()> {
        if !self.solutions_dir.exists() {
            std::fs::create_dir_all(&self.solutions_dir)
                .with_context(|| format!("creating {}", self.solutions_dir.display()))?;
        }
        if !self.solutions_dir.join(".git").exists() {
            git(&self.solutions_dir, &["init", "--quiet"]).await?;
            let gitignore = self.solutions_dir.join(".gitignore");
            if !gitignore.exists() {
                paths::write_atomic(&gitignore, SOLUTIONS_GITIGNORE.as_bytes())?;
            }
        }
        Ok(())
    }

    /// Loads a solution, creating it from the language's template the first time.
    pub fn load_code(&self, profile: &LanguageProfile, puzzle: Puzzle) -> Result<CodeFile> {
        let path = profile.solution_path(&self.solutions_dir, puzzle)?;
        if !path.exists() {
            paths::write_atomic(&path, profile.template.as_bytes())?;
        }
        read_code(&path)
    }

    pub fn save_code(
        &self,
        profile: &LanguageProfile,
        puzzle: Puzzle,
        text: &str,
        expected_version: &str,
    ) -> Result<CodeFile, SaveError> {
        let path = profile.solution_path(&self.solutions_dir, puzzle)?;
        let current = read_code(&path)?;
        if current.version != expected_version {
            return Err(SaveError::Conflict { current });
        }
        paths::write_atomic(&path, text.as_bytes())?;
        Ok(CodeFile {
            text: text.to_owned(),
            version: version_of(text),
            path,
        })
    }

    fn notes_path(&self, puzzle: Puzzle) -> PathBuf {
        self.solutions_dir
            .join("notes")
            .join(puzzle.year.to_string())
            .join(format!("day{:02}.md", puzzle.day))
    }

    pub fn load_notes(&self, puzzle: Puzzle) -> Result<String> {
        read_optional(&self.notes_path(puzzle)).map(Option::unwrap_or_default)
    }

    pub fn save_notes(&self, puzzle: Puzzle, text: &str) -> Result<()> {
        let path = self.notes_path(puzzle);
        if text.is_empty() && !path.exists() {
            return Ok(());
        }
        paths::write_atomic(&path, text.as_bytes())
    }

    fn day_meta_path(&self, puzzle: Puzzle) -> PathBuf {
        self.paths
            .day_meta_dir()
            .join(format!("{}-{:02}.json", puzzle.year, puzzle.day))
    }

    pub fn load_day_meta(&self, puzzle: Puzzle) -> Result<DayMeta> {
        match read_optional(&self.day_meta_path(puzzle))? {
            Some(json) => serde_json::from_str(&json).context("reading saved puzzle state"),
            None => Ok(DayMeta::default()),
        }
    }

    pub fn save_day_meta(&self, puzzle: Puzzle, meta: &DayMeta) -> Result<()> {
        paths::write_atomic(
            &self.day_meta_path(puzzle),
            &serde_json::to_vec_pretty(meta)?,
        )
    }

    pub fn load_ui_state(&self) -> Result<UiState> {
        match read_optional(&self.paths.state_file())? {
            Some(json) => serde_json::from_str(&json).context("reading saved app state"),
            None => Ok(UiState::default()),
        }
    }

    pub fn save_ui_state(&self, state: &UiState) -> Result<()> {
        paths::write_atomic(&self.paths.state_file(), &serde_json::to_vec_pretty(state)?)
    }

    /// Commits everything in the solutions repo and pushes if there is a remote.
    pub async fn commit_and_push(&self, message: &str) -> Result<String> {
        git(&self.solutions_dir, &["add", "--all"]).await?;
        let staged = Command::new("git")
            .args(["diff", "--cached", "--quiet"])
            .current_dir(&self.solutions_dir)
            .status()
            .await
            .context("running git")?;
        let mut summary = Vec::new();
        if staged.success() {
            summary.push("Nothing new to commit.".to_owned());
        } else {
            git(&self.solutions_dir, &["commit", "--quiet", "-m", message]).await?;
            summary.push("Committed.".to_owned());
        }
        let remotes = git(&self.solutions_dir, &["remote"]).await?;
        if remotes.trim().is_empty() {
            summary.push("No remote to push to.".to_owned());
        } else {
            git(&self.solutions_dir, &["push", "--quiet"]).await?;
            summary.push("Pushed.".to_owned());
        }
        Ok(summary.join(" "))
    }
}

fn read_code(path: &Path) -> Result<CodeFile> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    Ok(CodeFile {
        version: version_of(&text),
        text,
        path: path.to_owned(),
    })
}

fn read_optional(path: &Path) -> Result<Option<String>> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err).with_context(|| format!("reading {}", path.display())),
    }
}

/// A stable hash of the contents (FNV-1a), so versions survive server restarts.
pub fn version_of(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

async fn git(dir: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .output()
        .await
        .context("running git; is it installed?")?;
    if !output.status.success() {
        bail!(
            "`git {}` failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::language::builtin_profiles;

    fn setup() -> (tempfile::TempDir, Workspace, LanguageProfile) {
        let dir = tempfile::tempdir().unwrap();
        let workspace = Workspace::new(
            dir.path().join("aoc"),
            Paths::under(&dir.path().join("home")),
        );
        let profile = builtin_profiles().unwrap().remove(0).1;
        (dir, workspace, profile)
    }

    #[test]
    fn creates_from_template_and_detects_conflicts() {
        let (_dir, workspace, profile) = setup();
        let puzzle = Puzzle::new(2017, 4).unwrap();
        let loaded = workspace.load_code(&profile, puzzle).unwrap();
        assert_eq!(loaded.text, profile.template);

        let saved = workspace
            .save_code(&profile, puzzle, "main = pure ()", &loaded.version)
            .unwrap();
        assert_eq!(
            workspace.load_code(&profile, puzzle).unwrap().text,
            "main = pure ()"
        );

        match workspace.save_code(&profile, puzzle, "stale", &loaded.version) {
            Err(SaveError::Conflict { current }) => assert_eq!(current.version, saved.version),
            other => panic!("expected a conflict, got {other:?}"),
        }
    }

    #[test]
    fn round_trips_state() {
        let (_dir, workspace, _) = setup();
        let puzzle = Puzzle::new(2017, 4).unwrap();
        assert_eq!(workspace.load_day_meta(puzzle).unwrap(), DayMeta::default());
        let meta = DayMeta {
            sample_block: Some(1),
            sample_input: Some("1 2".into()),
            sample_answers: [Some("3".into()), None],
            cursor: Some(10),
        };
        workspace.save_day_meta(puzzle, &meta).unwrap();
        assert_eq!(workspace.load_day_meta(puzzle).unwrap(), meta);

        let ui = UiState {
            puzzle: Some(puzzle),
            tab: Tab::Problem,
            discuss_model: Some("opus".into()),
        };
        workspace.save_ui_state(&ui).unwrap();
        assert_eq!(workspace.load_ui_state().unwrap(), ui);

        workspace.save_notes(puzzle, "try a map").unwrap();
        assert_eq!(workspace.load_notes(puzzle).unwrap(), "try a map");
        assert!(
            !workspace
                .solutions_dir
                .join("notes/2017/day04.md")
                .starts_with(&workspace.paths.data_dir)
        );
    }

    #[test]
    fn version_is_stable() {
        assert_eq!(version_of(""), "cbf29ce484222325");
        assert_ne!(version_of("a"), version_of("b"));
    }

    #[tokio::test]
    async fn initialises_and_commits() {
        let (_dir, workspace, profile) = setup();
        workspace.ensure_repo().await.unwrap();
        assert!(workspace.solutions_dir.join(".gitignore").exists());
        workspace
            .load_code(&profile, Puzzle::new(2017, 4).unwrap())
            .unwrap();
        // Tests mustn't depend on the developer's git identity.
        git(
            &workspace.solutions_dir,
            &["config", "user.email", "test@example.com"],
        )
        .await
        .unwrap();
        git(&workspace.solutions_dir, &["config", "user.name", "Test"])
            .await
            .unwrap();
        let summary = workspace.commit_and_push("Day 4").await.unwrap();
        assert_eq!(summary, "Committed. No remote to push to.");
        let summary = workspace.commit_and_push("Day 4").await.unwrap();
        assert_eq!(summary, "Nothing new to commit. No remote to push to.");
    }
}
