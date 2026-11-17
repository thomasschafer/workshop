//! The packs Workshop learns from, as the config lists them, and `workshop pack check`.

use std::path::{Path, PathBuf};

use anyhow::{Result, bail};
use workshop_pack::{Pack, Verdict};

use crate::config::LearningConfig;

/// The packs to learn from: those in the config, then the sample pack if there are none or the
/// config asks for it too. A pack whose items have problems still loads, without them; one
/// whose `pack.toml` can't be read, or that has the same id as another, is an error.
pub fn load(config: &LearningConfig) -> Result<Vec<Pack>> {
    let mut packs: Vec<Pack> = Vec::new();
    for dir in &config.packs {
        let pack = Pack::load(dir)?;
        if packs.iter().any(|p| p.manifest.id == pack.manifest.id) {
            bail!(
                "two packs have the id {:?}; each needs its own, in its pack.toml",
                pack.manifest.id
            );
        }
        packs.push(pack);
    }
    if with_sample(config) {
        let sample = Pack::sample();
        if packs.iter().any(|p| p.manifest.id == sample.manifest.id) {
            bail!(
                "a pack of yours has the sample pack's id, {:?}, so the two can't be used together; give yours another in its pack.toml",
                sample.manifest.id
            );
        }
        packs.push(sample);
    }
    Ok(packs)
}

/// Whether the sample pack is learnt from: when there's no other, or as well as the others.
fn with_sample(config: &LearningConfig) -> bool {
    config.packs.is_empty() || config.sample_pack
}

/// Checks the pack in `dir`, or else the packs in the config, printing what's wrong, with its
/// programs built and run with `runtime`. Returns whether everything passed; an item that
/// couldn't be checked here, such as for want of a compiler, is said to be skipped, and
/// doesn't count against it.
pub async fn check(
    dir: Option<&Path>,
    config: &LearningConfig,
    runtime: workshop_coding::Runtime,
) -> Result<bool> {
    let packs: Vec<(String, Pack)> = match dir {
        Some(dir) => vec![(dir.display().to_string(), Pack::load(dir)?)],
        None => {
            let mut packs = config
                .packs
                .iter()
                .map(|dir: &PathBuf| Ok((dir.display().to_string(), Pack::load(dir)?)))
                .collect::<Result<Vec<_>>>()?;
            if with_sample(config) {
                packs.push(("the sample pack".to_owned(), Pack::sample()));
            }
            packs
        }
    };
    if !runtime.sandbox.confines() {
        eprintln!(
            "Warning: there's no sandbox on this machine (sandbox-exec on macOS, or bubblewrap on Linux), so the packs' programs run with all your access, including to the network and your files. Only check packs whose programs you trust.\n"
        );
    }
    let checker = workshop_coding::Checker {
        runtime,
        unconfined: workshop_coding::Unconfined::Run,
    };
    let mut passed = true;
    for (place, pack) in packs {
        let report = pack.check(&checker).await;
        println!("{} ({place})", pack.manifest.name);
        for item in &report.items {
            match &item.verdict {
                Verdict::Passed(detail) => println!("✓ {}: {detail}", item.path),
                Verdict::Skipped(reason) => println!("- {}: skipped, as {reason}", item.path),
                Verdict::Failed(message) => println!("✗ {}: {message}", item.path),
            }
        }
        for problem in &report.problems {
            println!("✗ {problem}");
        }
        let failures = report.failures().len();
        let skipped = report.skipped().len();
        if failures == 0 && skipped > 0 {
            println!(
                "{} items passed, and {skipped} couldn't be checked here.\n",
                report.items.len() - skipped
            );
        } else if failures == 0 {
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
            sample_pack: false,
            daily_reviews: 40,
            daily_new: 10,
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
    fn uses_the_sample_pack_until_one_is_configured() {
        let packs = load(&config(Vec::new())).unwrap();
        assert_eq!(packs[0].manifest.id, "sample");

        let dir = tempfile::tempdir().unwrap();
        write_pack(&dir.path().join("mine"), "mine");
        let packs = load(&config(vec![dir.path().join("mine")])).unwrap();
        assert_eq!(packs.len(), 1);
        assert_eq!(packs[0].manifest.id, "mine");
    }

    #[test]
    fn uses_the_sample_pack_alongside_ones_own_when_asked() {
        let dir = tempfile::tempdir().unwrap();
        write_pack(&dir.path().join("mine"), "mine");
        let both = LearningConfig {
            sample_pack: true,
            ..config(vec![dir.path().join("mine")])
        };
        let ids: Vec<String> = load(&both)
            .unwrap()
            .into_iter()
            .map(|p| p.manifest.id)
            .collect();
        assert_eq!(ids, ["mine", "sample"]);

        write_pack(&dir.path().join("clash"), "sample");
        let clash = LearningConfig {
            sample_pack: true,
            ..config(vec![dir.path().join("clash")])
        };
        assert!(load(&clash).is_err());
    }

    #[test]
    fn refuses_two_packs_with_one_id() {
        let dir = tempfile::tempdir().unwrap();
        write_pack(&dir.path().join("a"), "same");
        write_pack(&dir.path().join("b"), "same");
        let err = load(&config(vec![dir.path().join("a"), dir.path().join("b")])).unwrap_err();
        assert!(err.to_string().contains("two packs"));
    }

    fn runtime(dir: &Path) -> workshop_coding::Runtime {
        workshop_coding::Runtime {
            scratch: dir.join("build"),
            environments: Default::default(),
            build_timeout: std::time::Duration::from_secs(60),
            run_timeout: std::time::Duration::from_secs(60),
            sandbox: workshop_coding::Sandbox::Unconfined,
            tools: Default::default(),
        }
    }

    // The sample pack's own check, which runs every program in it, is in workshop-coding.
    #[tokio::test]
    async fn checks_the_configured_packs() {
        let dir = tempfile::tempdir().unwrap();
        write_pack(&dir.path().join("mine"), "mine");
        let configured = config(vec![dir.path().join("mine")]);
        assert!(check(None, &configured, runtime(dir.path())).await.unwrap());
    }

    #[tokio::test]
    async fn fails_the_check_for_a_broken_item() {
        let dir = tempfile::tempdir().unwrap();
        write_pack(dir.path(), "mine");
        std::fs::write(dir.path().join("items/two.md"), "no front matter").unwrap();
        let none = config(Vec::new());
        let checked = check(Some(dir.path()), &none, runtime(dir.path()));
        assert!(!checked.await.unwrap());
    }
}
