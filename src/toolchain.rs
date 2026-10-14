//! The programs solutions are built and run with, when they come from mise
//! (<https://mise.jdx.dev>) rather than being installed system-wide.
//!
//! A mise config in the solutions directory lists them, as it would for any project. Workshop
//! builds, runs and starts the language server inside its environment, and setup can write one
//! and install everything in it, without touching programs installed elsewhere.

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::doctor::{find_program, find_program_in};
use crate::packages::{InstallLog, run_logged};

/// How a language's programs are installed with mise.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ToolchainProfile {
    /// The `mise.toml` written to the solutions directory, unless one is there already.
    pub mise: String,
    /// Commands run in the solutions directory after `mise install`.
    #[serde(default)]
    pub after_install: Vec<Vec<String>>,
    /// Lines added to the solutions repo's `.gitignore`, for what's installed inside it.
    #[serde(default)]
    pub gitignore: Vec<String>,
}

/// The files mise reads a directory's tools from.
const MISE_CONFIGS: &[&str] = &[
    "mise.toml",
    ".mise.toml",
    "mise.local.toml",
    ".tool-versions",
];

/// The mise config this profile writes.
const MISE_FILE: &str = "mise.toml";

/// `mise env` can resolve versions online the first time, so it gets a while.
const ENV_TIMEOUT: Duration = Duration::from_secs(30);

pub const MISE_INSTALL_HINT: &str = "Install mise (https://mise.jdx.dev/getting-started.html), which installs programs for one directory without changing the rest of the system.";

/// The environment mise sets for the solutions directory: empty if it has no mise config.
#[derive(Debug, Clone, Default)]
pub struct Toolchain {
    variables: Vec<(String, String)>,
}

/// The mise config in the solutions directory, if there is one.
pub fn mise_config(solutions_dir: &Path) -> Option<PathBuf> {
    MISE_CONFIGS
        .iter()
        .map(|name| solutions_dir.join(name))
        .find(|path| path.is_file())
}

impl Toolchain {
    /// Reads the environment from mise, if the solutions directory has a mise config and mise is
    /// installed. Without mise, the config is ignored and programs are found on the `PATH`.
    pub async fn load(solutions_dir: &Path) -> Result<Self> {
        if mise_config(solutions_dir).is_none() {
            return Ok(Self::default());
        }
        let Some(mise) = find_program("mise") else {
            return Ok(Self::default());
        };
        let output = tokio::time::timeout(
            ENV_TIMEOUT,
            crate::process::command(&mise)
                .args(["env", "--json"])
                .current_dir(solutions_dir)
                .stdin(Stdio::null())
                .output(),
        )
        .await
        .context("`mise env` took too long")?
        .context("running `mise env`")?;
        if !output.status.success() {
            bail!(
                "`mise env` failed in {}: {}",
                solutions_dir.display(),
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        let variables: BTreeMap<String, String> =
            serde_json::from_slice(&output.stdout).context("reading `mise env`'s output")?;
        Ok(Self {
            variables: variables.into_iter().collect(),
        })
    }

    pub fn variables(&self) -> &[(String, String)] {
        &self.variables
    }

    /// The `PATH` to look for programs on, if mise sets one.
    pub fn path(&self) -> Option<&str> {
        self.variables
            .iter()
            .find(|(name, _)| name == "PATH")
            .map(|(_, value)| value.as_str())
    }

    /// Finds a program as solutions would: on mise's `PATH`, or Workshop's own.
    pub fn find_program(&self, program: &str) -> Option<PathBuf> {
        match self.path() {
            Some(path) => find_program_in(program, OsStr::new(path)),
            None => find_program(program),
        }
    }

    /// `variables` laid over this environment: they win where both set a variable.
    pub fn overlay(&self, variables: Vec<(String, String)>) -> Vec<(String, String)> {
        let mut environment: Vec<(String, String)> = self
            .variables
            .iter()
            .filter(|(name, _)| !variables.iter().any(|(n, _)| n == name))
            .cloned()
            .collect();
        environment.extend(variables);
        environment
    }
}

/// Writes the profile's mise config unless the solutions directory has one already, then
/// installs everything it lists.
pub async fn install(
    profile: &ToolchainProfile,
    solutions_dir: &Path,
    cancel: &CancellationToken,
    log: &InstallLog,
) -> Result<()> {
    let mise = find_program("mise").context(MISE_INSTALL_HINT)?;
    let mise = mise.to_string_lossy().into_owned();
    std::fs::create_dir_all(solutions_dir)
        .with_context(|| format!("creating {}", solutions_dir.display()))?;
    match mise_config(solutions_dir) {
        Some(existing) => log.push(format!("Installing what {} lists.", existing.display())),
        None => {
            let path = solutions_dir.join(MISE_FILE);
            crate::paths::write_atomic(&path, profile.mise.trim_start().as_bytes())?;
            log.push(format!("Wrote {}.", path.display()));
            // Only the file Workshop wrote: one of the user's own is theirs to trust.
            run_logged(
                &[
                    mise.clone(),
                    "trust".to_owned(),
                    path.to_string_lossy().into_owned(),
                ],
                solutions_dir,
                &[],
                cancel,
                log,
            )
            .await?;
        }
    }
    add_to_gitignore(solutions_dir, &profile.gitignore)?;
    run_logged(
        &[mise.clone(), "install".to_owned()],
        solutions_dir,
        &[],
        cancel,
        log,
    )
    .await?;
    for command in &profile.after_install {
        let (program, args) = command.split_first().context("empty command")?;
        // So the profile's `mise` is the same one that installed everything.
        let program = if program == "mise" { &mise } else { program };
        let command: Vec<String> = std::iter::once(program.clone())
            .chain(args.iter().cloned())
            .collect();
        run_logged(&command, solutions_dir, &[], cancel, log).await?;
    }
    Ok(())
}

/// Adds lines to the solutions repo's `.gitignore`, unless they're there already.
fn add_to_gitignore(solutions_dir: &Path, lines: &[String]) -> Result<()> {
    let path = solutions_dir.join(".gitignore");
    let mut text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(err) => return Err(err).with_context(|| format!("reading {}", path.display())),
    };
    let missing: Vec<&String> = lines
        .iter()
        .filter(|line| !text.lines().any(|l| l.trim() == line.trim()))
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str("# Programs installed by mise for these solutions\n");
    for line in missing {
        text.push_str(line);
        text.push('\n');
    }
    crate::paths::write_atomic(&path, text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlays_variables() {
        let toolchain = Toolchain {
            variables: vec![
                ("PATH".to_owned(), "/mise/bin:/usr/bin".to_owned()),
                ("GHCUP".to_owned(), "/t".to_owned()),
            ],
        };
        assert_eq!(toolchain.path(), Some("/mise/bin:/usr/bin"));
        assert_eq!(
            toolchain.overlay(vec![("PATH".to_owned(), "/venv/bin:/mise/bin".to_owned())]),
            [
                ("GHCUP".to_owned(), "/t".to_owned()),
                ("PATH".to_owned(), "/venv/bin:/mise/bin".to_owned())
            ]
        );
    }

    #[test]
    fn finds_programs_on_the_toolchain_path() {
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("only-in-the-toolchain");
        std::fs::write(&program, "").unwrap();
        let toolchain = Toolchain {
            variables: vec![("PATH".to_owned(), dir.path().to_string_lossy().into_owned())],
        };
        assert_eq!(
            toolchain.find_program("only-in-the-toolchain"),
            Some(program)
        );
        assert!(
            Toolchain::default()
                .find_program("only-in-the-toolchain")
                .is_none()
        );
    }

    #[tokio::test]
    async fn no_mise_config_means_no_toolchain() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            Toolchain::load(dir.path())
                .await
                .unwrap()
                .variables()
                .is_empty()
        );
    }

    #[test]
    fn adds_to_gitignore_once() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".gitignore"), "*.o").unwrap();
        let lines = vec![".toolchain/".to_owned()];
        add_to_gitignore(dir.path(), &lines).unwrap();
        add_to_gitignore(dir.path(), &lines).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".gitignore")).unwrap(),
            "*.o\n# Programs installed by mise for these solutions\n.toolchain/\n"
        );
    }
}
