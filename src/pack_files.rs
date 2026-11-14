//! Changing a pack's own files, as fixing a card, importing a question or the author's items
//! do: finding the pack's directory, and committing what changed to the pack's git repo, on the
//! branch it's on. Nothing is ever pushed.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use workshop_pack::Pack;

use crate::config::LearningConfig;

/// The directory of the pack with this id, from the config. The sample pack is built in, so
/// it has none.
pub fn pack_dir(config: &LearningConfig, pack: &str) -> Result<PathBuf> {
    if config.packs.is_empty() {
        bail!(
            "the sample pack is built into Workshop, so it can't be changed; list a pack of your own under [learning] in your config"
        );
    }
    for dir in &config.packs {
        let loaded = Pack::load(dir)?;
        if loaded.manifest.id == pack {
            return Ok(dir.clone());
        }
    }
    bail!("there's no pack {pack:?} in your config")
}

/// Commits `paths`, relative to the pack, to the pack's git repo on its current branch, if it's
/// in one, leaving anything else that's staged as it is. Returns the commit's short hash, or
/// None if the pack isn't in a git repo.
pub async fn commit(dir: &Path, paths: &[String], message: &str) -> Result<Option<String>> {
    let inside = crate::workspace::git(dir, &["rev-parse", "--is-inside-work-tree"]).await;
    if !inside.is_ok_and(|out| out.trim() == "true") {
        return Ok(None);
    }
    if paths.is_empty() {
        return Ok(None);
    }
    let mut add = vec!["add", "--"];
    add.extend(paths.iter().map(String::as_str));
    crate::workspace::git(dir, &add).await?;
    // Only these paths, whatever else is staged.
    let mut commit = vec!["commit", "--quiet", "-m", message, "--"];
    commit.extend(paths.iter().map(String::as_str));
    crate::workspace::git(dir, &commit)
        .await
        .context("committing to the pack's repo")?;
    let hash = crate::workspace::git(dir, &["rev-parse", "--short", "HEAD"]).await?;
    Ok(Some(hash.trim().to_owned()))
}

#[cfg(test)]
pub mod testing {
    use std::path::Path;

    /// A copy of the sample pack in `dir`, as a git repo with one commit, for tests that change
    /// a pack.
    pub fn sample_pack_repo(dir: &Path) {
        copy(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("packs/sample")
                .as_path(),
            dir,
        );
        let git = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(dir)
                .output()
                .unwrap();
            assert!(status.status.success(), "{status:?}");
        };
        git(&["init", "--quiet", "--initial-branch", "main"]);
        // Tests mustn't depend on the developer's git identity.
        git(&["config", "user.email", "tests@example.com"]);
        git(&["config", "user.name", "Tests"]);
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "Start"]);
    }

    fn copy(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy(&entry.path(), &target);
            } else {
                std::fs::copy(entry.path(), target).unwrap();
            }
        }
    }

    /// The pack repo's commit messages, newest first.
    pub fn log(dir: &Path) -> Vec<String> {
        let out = std::process::Command::new("git")
            .args(["log", "--format=%s"])
            .current_dir(dir)
            .output()
            .unwrap();
        String::from_utf8(out.stdout)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(packs: Vec<PathBuf>) -> LearningConfig {
        LearningConfig {
            packs,
            daily_reviews: 40,
            weekly_minutes: 90,
            desired_retention: 0.9,
        }
    }

    #[tokio::test]
    async fn commits_only_what_it_wrote() {
        let dir = tempfile::tempdir().unwrap();
        let pack = dir.path().join("pack");
        testing::sample_pack_repo(&pack);
        let config = config(vec![pack.clone()]);
        assert_eq!(pack_dir(&config, "sample").unwrap(), pack);
        assert!(pack_dir(&config, "other").is_err());
        assert!(pack_dir(&self::config(Vec::new()), "sample").is_err());

        // Something of the user's own, staged and not to be committed.
        std::fs::write(pack.join("notes.md"), "mine").unwrap();
        crate::workspace::git(&pack, &["add", "notes.md"])
            .await
            .unwrap();
        std::fs::create_dir_all(pack.join("drafts")).unwrap();
        std::fs::write(pack.join("drafts/a.md"), "draft").unwrap();
        let hash = commit(&pack, &["drafts/a.md".to_owned()], "Add a draft")
            .await
            .unwrap();
        assert!(hash.is_some());
        assert_eq!(testing::log(&pack)[0], "Add a draft");
        let staged = crate::workspace::git(&pack, &["diff", "--cached", "--name-only"])
            .await
            .unwrap();
        assert_eq!(staged.trim(), "notes.md");

        let plain = dir.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        std::fs::write(plain.join("a.md"), "x").unwrap();
        assert_eq!(
            commit(&plain, &["a.md".to_owned()], "m").await.unwrap(),
            None
        );
    }
}
