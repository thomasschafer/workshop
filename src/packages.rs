//! Packages that solutions can use beyond a language's standard library.
//!
//! The list lives in a manifest in the solutions directory, so it travels with the solutions and
//! can be edited by hand. Workshop installs it into an environment of its own, outside the
//! solutions repo, which building, running and the language server then use.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::paths;
use crate::runner::{self, Ending};
use crate::template::{self, Vars};

/// How a language's packages are listed, installed and used.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PackagesProfile {
    /// The manifest, relative to the solutions directory: one package per line, with `#`
    /// comments.
    pub manifest: String,
    /// What a new manifest starts with.
    #[serde(default)]
    pub defaults: Vec<String>,
    /// Commands that install every package in the manifest into an empty `{env}` directory, run
    /// in order. An argument that is exactly `{packages}` becomes one argument per package.
    pub install: Vec<Vec<String>>,
    /// Environment variables for building, running and the language server, once the packages
    /// are installed. `{env}` is as above, and `{PATH}` is Workshop's own `PATH`.
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    /// Patterns that find a missing module in an error, with the module as their only group.
    #[serde(default)]
    pub missing_module: Vec<String>,
    /// The package that provides a module, by module prefix, for suggesting what to install.
    #[serde(default)]
    pub providers: BTreeMap<String, String>,
    /// Whether a module with no provider listed comes from the package of the same name as its
    /// first component, as is usual in Python (`numpy.linalg` from `numpy`).
    #[serde(default)]
    pub package_named_after_module: bool,
}

impl PackagesProfile {
    /// Checks the parts of the profile that could otherwise fail only once used.
    pub fn validate(&self) -> Result<()> {
        if self.install.iter().any(Vec::is_empty) || self.install.is_empty() {
            bail!("`packages.install` needs at least one command, and no empty commands");
        }
        for pattern in &self.missing_module {
            let regex = regex::Regex::new(pattern).with_context(|| {
                format!("invalid `packages.missing_module` pattern {pattern:?}")
            })?;
            if regex.captures_len() != 2 {
                bail!("`packages.missing_module` pattern {pattern:?} needs exactly one group");
            }
        }
        for package in self.defaults.iter().chain(self.providers.values()) {
            check_name(package)?;
        }
        Ok(())
    }
}

/// Package names are passed to installers as arguments, so they're kept to plain names: nothing
/// an installer could read as an option, a path or a URL.
fn check_name(name: &str) -> Result<()> {
    let valid = name
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !valid {
        bail!(
            "{name:?} isn't a package name; use letters, digits, `-`, `_` and `.`, starting with a letter or digit"
        );
    }
    Ok(())
}

/// The packages in a manifest's text.
pub fn parse_manifest(text: &str) -> Result<Vec<String>> {
    let mut packages: Vec<String> = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let name = line.split('#').next().unwrap_or("").trim();
        if name.is_empty() {
            continue;
        }
        check_name(name).with_context(|| format!("line {}", i + 1))?;
        if !packages.iter().any(|p| p == name) {
            packages.push(name.to_owned());
        }
    }
    Ok(packages)
}

fn new_manifest(language_name: &str, packages: &[String]) -> String {
    let mut text = format!(
        "# Packages your {language_name} solutions can use, one per line. Workshop installs them\n\
         # when you choose Install in its settings.\n"
    );
    for package in packages {
        text.push_str(package);
        text.push('\n');
    }
    text
}

/// What was last installed, kept next to the installations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Installed {
    /// The installation's directory, inside the language's packages directory.
    dir: String,
    packages: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PackagesState {
    /// The manifest's path, relative to the solutions directory.
    pub manifest: String,
    pub text: String,
    /// The manifest's packages: none if it has a problem.
    pub packages: Vec<String>,
    /// What's wrong with the manifest, such as a line that isn't a package name.
    pub problem: Option<String>,
    /// The packages installed now, if any have been.
    pub installed: Option<Vec<String>>,
}

/// One language's packages.
pub struct Packages<'a> {
    pub profile: &'a PackagesProfile,
    pub language_name: &'a str,
    pub solutions_dir: &'a Path,
    /// Where this language's installations live.
    pub dir: PathBuf,
}

const INSTALL_TIMEOUT: Duration = Duration::from_secs(30 * 60);

impl Packages<'_> {
    fn manifest_path(&self) -> PathBuf {
        self.solutions_dir.join(&self.profile.manifest)
    }

    /// The manifest's text, or what a new one starts with if there isn't one yet. Only saving,
    /// adding or installing writes the file.
    pub fn manifest_text(&self) -> Result<String> {
        let path = self.manifest_path();
        match std::fs::read_to_string(&path) {
            Ok(text) => Ok(text),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                Ok(new_manifest(self.language_name, &self.profile.defaults))
            }
            Err(err) => Err(err).with_context(|| format!("reading {}", path.display())),
        }
    }

    fn write_manifest(&self, text: &str) -> Result<()> {
        let path = self.manifest_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        paths::write_atomic(&path, text.as_bytes())
    }

    pub fn state(&self) -> Result<PackagesState> {
        let text = self.manifest_text()?;
        let (packages, problem) = match parse_manifest(&text) {
            Ok(packages) => (packages, None),
            Err(err) => (Vec::new(), Some(format!("{err:#}"))),
        };
        Ok(PackagesState {
            manifest: self.profile.manifest.clone(),
            packages,
            problem,
            text,
            installed: self.installed()?.map(|i| i.packages),
        })
    }

    /// Replaces the manifest, after checking every line is a package name.
    pub fn save_manifest(&self, text: &str) -> Result<()> {
        parse_manifest(text)?;
        self.write_manifest(text)
    }

    /// Adds a package to the end of the manifest, unless it's already there.
    pub fn add(&self, package: &str) -> Result<()> {
        check_name(package)?;
        let mut text = self.manifest_text()?;
        if parse_manifest(&text)?.iter().any(|p| p == package) {
            return Ok(());
        }
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(package);
        text.push('\n');
        self.write_manifest(&text)
    }

    fn installed_path(&self) -> PathBuf {
        self.dir.join("installed.json")
    }

    fn installed(&self) -> Result<Option<Installed>> {
        let path = self.installed_path();
        match std::fs::read_to_string(&path) {
            Ok(text) => Ok(Some(
                serde_json::from_str(&text)
                    .with_context(|| format!("reading {}", path.display()))?,
            )),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err).with_context(|| format!("reading {}", path.display())),
        }
    }

    /// The environment variables for building, running and the language server: none until
    /// packages have been installed.
    pub fn environment(&self) -> Result<Vec<(String, String)>> {
        let Some(installed) = self.installed()? else {
            return Ok(Vec::new());
        };
        if installed.packages.is_empty() {
            return Ok(Vec::new());
        }
        let env = self.dir.join(&installed.dir);
        let path = std::env::var("PATH").unwrap_or_default();
        let vars = Vars::new()
            .set("env", env.to_string_lossy())
            .set("PATH", path);
        self.profile
            .environment
            .iter()
            .map(|(name, value)| Ok((name.clone(), template::render(value, &vars)?)))
            .collect()
    }

    /// Installs everything in the manifest into a new directory, switching to it only once the
    /// install succeeds, so a failed install leaves the previous packages working.
    pub async fn install(&self, cancel: &CancellationToken) -> Result<Vec<String>> {
        let text = self.manifest_text()?;
        let packages = parse_manifest(&text)?;
        // So what was installed is there to see and edit.
        if !self.manifest_path().exists() {
            self.write_manifest(&text)?;
        }
        std::fs::create_dir_all(&self.dir)
            .with_context(|| format!("creating {}", self.dir.display()))?;
        let previous = self.installed()?;
        // Numbered, so a new installation never reuses the directory of the one it replaces.
        let number = previous
            .as_ref()
            .and_then(|p| p.dir.parse::<u64>().ok())
            .map_or(1, |n| n + 1);
        let name = number.to_string();
        let env = self.dir.join(&name);
        if !packages.is_empty() {
            std::fs::create_dir_all(&env).with_context(|| format!("creating {}", env.display()))?;
            if let Err(err) = self.run_install(&env, &packages, cancel).await {
                let _ = std::fs::remove_dir_all(&env);
                return Err(err);
            }
        }
        let installed = Installed {
            dir: name,
            packages: packages.clone(),
        };
        paths::write_atomic(
            &self.installed_path(),
            serde_json::to_string_pretty(&installed)?.as_bytes(),
        )?;
        if let Some(previous) = previous {
            let _ = std::fs::remove_dir_all(self.dir.join(previous.dir));
        }
        Ok(packages)
    }

    async fn run_install(
        &self,
        env: &Path,
        packages: &[String],
        cancel: &CancellationToken,
    ) -> Result<()> {
        let vars = Vars::new().set("env", env.to_string_lossy());
        for command in &self.profile.install {
            let mut args = Vec::new();
            for arg in command {
                if arg == "{packages}" {
                    args.extend(packages.iter().cloned());
                } else {
                    args.push(template::render(arg, &vars)?);
                }
            }
            let output = runner::execute(&args, env, &[], None, INSTALL_TIMEOUT, cancel).await?;
            match output.ending {
                Ending::Exited { code: Some(0) } => {}
                Ending::Exited { .. } => bail!(
                    "`{}` failed:\n{}",
                    args.join(" "),
                    last_lines(&format!("{}\n{}", output.stdout, output.stderr), 15)
                ),
                Ending::TimedOut => bail!("`{}` took too long and was stopped", args.join(" ")),
                Ending::Cancelled => bail!("Installing was cancelled."),
            }
        }
        Ok(())
    }
}

fn last_lines(text: &str, count: usize) -> String {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(count)..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(install: &[&[&str]]) -> PackagesProfile {
        PackagesProfile {
            manifest: "packages.txt".into(),
            defaults: vec!["alpha".into()],
            install: install
                .iter()
                .map(|c| c.iter().map(|s| (*s).to_owned()).collect())
                .collect(),
            environment: BTreeMap::from([("SITE".to_owned(), "{env}/site:{PATH}".to_owned())]),
            missing_module: vec![],
            providers: BTreeMap::new(),
            package_named_after_module: false,
        }
    }

    fn packages<'a>(profile: &'a PackagesProfile, dir: &'a Path) -> Packages<'a> {
        Packages {
            profile,
            language_name: "Test",
            solutions_dir: dir,
            dir: dir.join("installs"),
        }
    }

    #[test]
    fn parses_manifests() {
        let text = "# comment\nalpha\n\n  beta-2  # why\nalpha\n";
        assert_eq!(parse_manifest(text).unwrap(), ["alpha", "beta-2"]);
    }

    #[test]
    fn rejects_anything_but_package_names() {
        for line in ["--index-url=x", "../evil", "a b", "https://x", "pkg>=1"] {
            let err = parse_manifest(line).unwrap_err();
            assert!(format!("{err:#}").contains("line 1"), "{line}: {err:#}");
        }
    }

    #[test]
    fn validates_profiles() {
        let mut p = profile(&[&["true"]]);
        p.missing_module = vec!["no group".into()];
        assert!(p.validate().is_err());
        p.missing_module = vec!["No module named '([\\w.]+)'".into()];
        p.validate().unwrap();
        assert!(profile(&[]).validate().is_err());
    }

    #[test]
    fn starts_a_manifest_with_the_defaults_and_adds_to_it() {
        let dir = tempfile::tempdir().unwrap();
        let p = profile(&[&["true"]]);
        let packages = packages(&p, dir.path());
        assert_eq!(packages.state().unwrap().packages, ["alpha"]);
        packages.add("beta").unwrap();
        packages.add("beta").unwrap();
        assert_eq!(packages.state().unwrap().packages, ["alpha", "beta"]);
        assert!(packages.add("-x").is_err());
    }

    #[tokio::test]
    async fn installs_and_switches_environment_only_on_success() {
        let dir = tempfile::tempdir().unwrap();
        let p = profile(&[&[
            "sh",
            "-c",
            "mkdir site && echo \"$@\" > site/list",
            "sh",
            "{packages}",
        ]]);
        let packages = packages(&p, dir.path());
        assert!(packages.environment().unwrap().is_empty());

        let cancel = CancellationToken::new();
        assert_eq!(packages.install(&cancel).await.unwrap(), ["alpha"]);
        let env = packages.environment().unwrap();
        let site = env[0].1.split(':').next().unwrap().to_owned();
        assert_eq!(
            std::fs::read_to_string(format!("{site}/list")).unwrap(),
            "alpha\n"
        );
        assert_eq!(packages.state().unwrap().installed.unwrap(), ["alpha"]);

        // A failing install keeps the previous environment.
        let failing = profile(&[&["sh", "-c", "echo broken >&2; exit 3"]]);
        let broken = Packages {
            profile: &failing,
            ..packages
        };
        broken.add("beta").unwrap();
        let err = broken.install(&cancel).await.unwrap_err().to_string();
        assert!(err.contains("broken"), "{err}");
        assert_eq!(broken.environment().unwrap(), env);
        assert_eq!(broken.state().unwrap().installed.unwrap(), ["alpha"]);
    }

    #[tokio::test]
    async fn an_empty_manifest_needs_no_environment() {
        let dir = tempfile::tempdir().unwrap();
        let p = profile(&[&["false"]]);
        let packages = packages(&p, dir.path());
        packages.save_manifest("# nothing yet\n").unwrap();
        assert!(
            packages
                .install(&CancellationToken::new())
                .await
                .unwrap()
                .is_empty()
        );
        assert!(packages.environment().unwrap().is_empty());
    }
}
