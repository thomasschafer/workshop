//! The packs Workshop learns from, as the config lists them, and `workshop pack check`.

use std::path::{Path, PathBuf};

use anyhow::Result;
use workshop_pack::Pack;

use crate::config::LearningConfig;

/// Checks the pack in `dir`, or else the packs in the config, printing what's wrong. Returns
/// whether everything passed.
pub fn check(dir: Option<&Path>, config: &LearningConfig) -> Result<bool> {
    let packs: Vec<(String, Pack)> = match dir {
        Some(dir) => vec![(dir.display().to_string(), Pack::load(dir)?)],
        None if config.packs.is_empty() => vec![("the sample pack".to_owned(), Pack::sample())],
        None => config
            .packs
            .iter()
            .map(|dir: &PathBuf| Ok((dir.display().to_string(), Pack::load(dir)?)))
            .collect::<Result<_>>()?,
    };
    let mut passed = true;
    for (place, pack) in packs {
        let report = pack.check();
        println!("{} ({place})", pack.manifest.name);
        for item in &report.items {
            match &item.result {
                Ok(detail) => println!("✓ {}: {detail}", item.path),
                Err(message) => println!("✗ {}: {message}", item.path),
            }
        }
        for problem in &report.problems {
            println!("✗ {problem}");
        }
        let failures = report.failures().len();
        if failures == 0 {
            println!("All {} items passed.\n", report.items.len());
        } else {
            passed = false;
            println!(
                "{failures} {} to fix, of {} items.\n",
                if failures == 1 { "problem" } else { "problems" },
                report.items.len() + report.problems.len()
            );
        }
    }
    Ok(passed)
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

    fn write_pack(dir: &Path, id: &str) {
        std::fs::create_dir_all(dir.join("items")).unwrap();
        std::fs::write(
            dir.join("pack.toml"),
            format!("id = \"{id}\"\nname = \"Pack\"\n[[skills]]\nid = \"a\"\nname = \"A\"\n"),
        )
        .unwrap();
        std::fs::write(
            dir.join("items/one.md"),
            "+++\nkind = \"card\"\nskills = [\"a\"]\n+++\nQ\n## Answer\nA\n",
        )
        .unwrap();
    }

    #[test]
    fn checks_the_configured_packs() {
        let dir = tempfile::tempdir().unwrap();
        write_pack(&dir.path().join("mine"), "mine");
        assert!(check(None, &config(vec![dir.path().join("mine")])).unwrap());
        assert!(check(None, &config(Vec::new())).unwrap());
    }

    #[test]
    fn fails_the_check_for_a_broken_item() {
        let dir = tempfile::tempdir().unwrap();
        write_pack(dir.path(), "mine");
        std::fs::write(dir.path().join("items/two.md"), "no front matter").unwrap();
        assert!(!check(Some(dir.path()), &config(Vec::new())).unwrap());
    }
}
