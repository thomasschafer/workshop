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

/// The pack's directory when there's only one to choose from, or the one with this id.
pub fn chosen_pack_dir(config: &LearningConfig, pack: Option<&str>) -> Result<PathBuf> {
    match (pack, config.packs.as_slice()) {
        (Some(pack), _) => pack_dir(config, pack),
        (None, [only]) => Ok(only.clone()),
        (None, []) => pack_dir(config, "sample"),
        (None, _) => bail!("you have more than one pack, so say which"),
    }
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

/// Writes a file in a pack, making its directory, refusing a path that leaves the pack.
pub fn write(dir: &Path, relative: &str, text: &str) -> Result<()> {
    if relative
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == ".." || part.starts_with('.'))
    {
        bail!("{relative:?} isn't a path inside the pack");
    }
    let path = dir.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    workshop_common::files::write_atomic(&path, text.as_bytes())
}

/// A question to add to a pack as a draft.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Import {
    /// The question, as it was found.
    pub text: String,
    /// Where it came from, in the learner's own words.
    #[serde(default)]
    pub source: Option<String>,
    pub skills: Vec<String>,
    /// The kind of item it should become, if known.
    #[serde(default)]
    pub kind: Option<workshop_pack::Kind>,
}

/// What importing a question made.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Imported {
    pub draft: workshop_pack::Draft,
    /// The commit it was added in, if the pack is a git repo.
    pub commit: Option<String>,
}

/// Adds a question to the pack in `dir` as a draft, under `drafts/`, committing it if the pack
/// is a git repo. The author can make an item with a check from it.
pub async fn import(dir: &Path, import: Import, today: &str) -> Result<Imported> {
    let text = import.text.trim();
    if text.is_empty() {
        bail!("there's no question to import");
    }
    let pack = Pack::load(dir)?;
    if import.skills.is_empty() {
        bail!("say which of the pack's skills the question is for");
    }
    if let Some(unknown) = import.skills.iter().find(|s| !pack.manifest.has_skill(s)) {
        bail!("the pack has no skill {unknown:?}; its skills are listed in its pack.toml");
    }
    let taken: Vec<&str> = pack
        .drafts
        .iter()
        .map(|d| d.id.as_str())
        .chain(pack.items.iter().map(|i| i.id.as_str()))
        .collect();
    let id = workshop_pack::drafts::new_id(text, &taken);
    let draft = workshop_pack::Draft {
        path: format!("drafts/{id}.md"),
        id,
        source: import
            .source
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty()),
        skills: import.skills,
        kind: import.kind,
        added: Some(today.to_owned()),
        text: text.to_owned(),
    };
    write(dir, &draft.path, &draft.to_file())?;
    let reloaded = Pack::load(dir)?;
    if !reloaded.drafts.iter().any(|d| d.id == draft.id) {
        std::fs::remove_file(dir.join(&draft.path))?;
        bail!("the draft couldn't be read back, so it wasn't added");
    }
    let commit = commit(
        dir,
        std::slice::from_ref(&draft.path),
        &format!("Add a draft question: {}", draft.label()),
    )
    .await?;
    Ok(Imported { draft, commit })
}

/// A day, in days since 1 January 1970, as `YYYY-MM-DD`.
pub fn date(days: i64) -> String {
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

#[cfg(test)]
pub mod testing {
    use std::path::Path;

    /// A copy of the sample pack in `dir`, as a git repo with one commit, for tests that change
    /// a pack.
    pub fn sample_pack_repo(dir: &Path) {
        sample_pack_copy(dir);
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

    /// A copy of the sample pack in `dir`, for tests that need a pack of their own.
    pub fn sample_pack_copy(dir: &Path) {
        copy(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("packs/sample")
                .as_path(),
            dir,
        );
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
            sample_pack: false,
            daily_reviews: 40,
            daily_new: 10,
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
        assert_eq!(chosen_pack_dir(&config, None).unwrap(), pack);
        assert!(pack_dir(&self::config(Vec::new()), "sample").is_err());

        // Something of the user's own, staged and not to be committed.
        std::fs::write(pack.join("notes.md"), "mine").unwrap();
        crate::workspace::git(&pack, &["add", "notes.md"])
            .await
            .unwrap();
        write(&pack, "drafts/a.md", "draft").unwrap();
        assert!(write(&pack, "../outside.md", "no").is_err());
        assert!(write(&pack, ".git/config", "no").is_err());
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
        write(&plain, "a.md", "x").unwrap();
        assert_eq!(
            commit(&plain, &["a.md".to_owned()], "m").await.unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn imports_a_question_as_a_draft() {
        let dir = tempfile::tempdir().unwrap();
        let pack = dir.path().join("pack");
        testing::sample_pack_repo(&pack);
        let import = |text: &str, skills: &[&str]| Import {
            text: text.to_owned(),
            source: Some("  A friend's puzzle  ".to_owned()),
            skills: skills.iter().map(|s| (*s).to_owned()).collect(),
            kind: Some(workshop_pack::Kind::Probability),
        };
        let imported = super::import(
            &pack,
            import(
                "Three coins are tossed. What's the chance of two heads?",
                &["probability.counting"],
            ),
            "2026-11-14",
        )
        .await
        .unwrap();
        assert_eq!(
            imported.draft.path,
            "drafts/three-coins-are-tossed-what-s.md"
        );
        assert_eq!(imported.draft.source.as_deref(), Some("A friend's puzzle"));
        assert!(imported.commit.is_some());
        assert_eq!(
            testing::log(&pack)[0],
            "Add a draft question: Three coins are tossed. What's the chance of…"
        );
        let loaded = Pack::load(&pack).unwrap();
        assert_eq!(loaded.drafts, [imported.draft]);
        // Drafts aren't items, so they're never practised.
        assert!(loaded.item("three-coins-are-tossed-what-s").is_none());

        let again = super::import(
            &pack,
            import("Three coins are tossed. Again.", &["probability.counting"]),
            "2026-11-14",
        )
        .await
        .unwrap();
        assert_eq!(again.draft.id, "three-coins-are-tossed-again");
        assert!(
            super::import(&pack, import("Q", &["chess"]), "2026-11-14")
                .await
                .is_err()
        );
        assert!(
            super::import(&pack, import("Q", &[]), "2026-11-14")
                .await
                .is_err()
        );
        assert!(
            super::import(&pack, import("  ", &["probability.counting"]), "2026-11-14")
                .await
                .is_err()
        );
    }

    #[test]
    fn writes_dates() {
        assert_eq!(date(0), "1970-01-01");
        assert_eq!(date(20_717), "2026-09-21");
        assert_eq!(date(19_782), "2024-02-29");
    }
}
