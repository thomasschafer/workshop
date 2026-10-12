//! Packages that solutions can use beyond a language's standard library.
//!
//! The list lives in a manifest in the solutions directory, so it travels with the solutions and
//! can be edited by hand. Workshop installs it into an environment of its own, outside the
//! solutions repo, which building, running and the language server then use.

use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio_util::sync::CancellationToken;

use crate::paths;
use crate::process::{self, ProcessGroup};
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
    /// Refreshes the installer's list of available packages, when it's older than `every_hours`
    /// or an install fails without it.
    #[serde(default)]
    pub update: Option<UpdateStep>,
    /// Environment variables for building, running and the language server, once the packages
    /// are installed. `{env}` is as above, and `{PATH}` is Workshop's own `PATH`.
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    /// Patterns that find a missing module in an error, with the module as their only group.
    #[serde(default)]
    pub missing_module: Vec<String>,
    /// Patterns that find the package itself in an error, for compilers that name it, with the
    /// package as their only group.
    #[serde(default)]
    pub missing_package: Vec<String>,
    /// The package that provides a module, by module prefix, for suggesting what to install.
    #[serde(default)]
    pub providers: BTreeMap<String, String>,
    /// Whether a module with no provider listed comes from the package of the same name as its
    /// first component, as is usual in Python (`numpy.linalg` from `numpy`).
    #[serde(default)]
    pub package_named_after_module: bool,
    /// Where to look up a package for a module that has no provider listed.
    #[serde(default)]
    pub lookup: Option<Lookup>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateStep {
    pub command: Vec<String>,
    pub every_hours: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Lookup {
    pub service: LookupService,
    /// The service's address, for tests; its public address otherwise.
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LookupService {
    /// Searches Hoogle for the Hackage package with the module.
    Hoogle,
    /// Checks the package named after the module exists on PyPI, and fetches its summary.
    Pypi,
}

impl PackagesProfile {
    /// Checks the parts of the profile that could otherwise fail only once used.
    pub fn validate(&self) -> Result<()> {
        if self.install.iter().any(Vec::is_empty) || self.install.is_empty() {
            bail!("`packages.install` needs at least one command, and no empty commands");
        }
        if self.update.as_ref().is_some_and(|u| u.command.is_empty()) {
            bail!("`packages.update.command` can't be empty");
        }
        for (field, patterns) in [
            ("missing_module", &self.missing_module),
            ("missing_package", &self.missing_package),
        ] {
            for pattern in patterns {
                let regex = regex::Regex::new(pattern)
                    .with_context(|| format!("invalid `packages.{field}` pattern {pattern:?}"))?;
                if regex.captures_len() != 2 {
                    bail!("`packages.{field}` pattern {pattern:?} needs exactly one group");
                }
            }
        }
        for package in self.defaults.iter().chain(self.providers.values()) {
            check_name(package)?;
        }
        Ok(())
    }

    /// The programs installing needs, for setup checks.
    pub fn required_programs(&self) -> Vec<&str> {
        self.update
            .iter()
            .map(|u| &u.command)
            .chain(&self.install)
            .filter_map(|command| command.first())
            .filter(|program| !program.contains('{'))
            .map(String::as_str)
            .collect()
    }

    /// The package a module comes from, by the profile's own list: the longest matching prefix
    /// wins, so `Data.Graph.Inductive` isn't taken for `Data.Graph`.
    fn provider(&self, module: &str) -> Option<&str> {
        self.providers
            .iter()
            .filter(|(prefix, _)| {
                module == prefix.as_str()
                    || module
                        .strip_prefix(prefix.as_str())
                        .is_some_and(|rest| rest.starts_with('.'))
            })
            .max_by_key(|(prefix, _)| prefix.len())
            .map(|(_, package)| package.as_str())
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
    /// Programs installing needs that aren't on the PATH.
    pub missing_programs: Vec<String>,
}

/// The package that would provide a missing module.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Resolution {
    /// From the language profile's own list.
    Known {
        package: String,
    },
    /// Found by looking the module up online.
    Found {
        package: String,
        summary: Option<String>,
    },
    /// The package usually named after the module, unchecked.
    Guessed {
        package: String,
    },
    NotFound,
}

/// Output from an install, kept so it can be followed as it happens and read afterwards.
#[derive(Default)]
pub struct InstallLog {
    lines: Mutex<VecDeque<String>>,
}

/// Older lines are dropped: the end of an installer's output is what explains a failure.
const KEPT_LOG_LINES: usize = 400;

impl InstallLog {
    pub fn push(&self, line: impl Into<String>) {
        let line = line.into();
        if line.trim().is_empty() {
            return;
        }
        let mut lines = self
            .lines
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if lines.len() == KEPT_LOG_LINES {
            lines.pop_front();
        }
        lines.push_back(line);
    }

    pub fn lines(&self) -> Vec<String> {
        self.lines
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .cloned()
            .collect()
    }

    pub fn last(&self) -> Option<String> {
        self.lines
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .back()
            .cloned()
    }

    fn tail(&self, count: usize) -> String {
        let lines = self.lines();
        lines[lines.len().saturating_sub(count)..].join("\n")
    }
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
    /// adding, removing or installing writes the file.
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
            missing_programs: self
                .profile
                .required_programs()
                .into_iter()
                .filter(|p| crate::doctor::find_program(p).is_none())
                .map(str::to_owned)
                .collect(),
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

    /// Removes a package from the manifest, keeping its other lines and comments as they are.
    pub fn remove(&self, package: &str) -> Result<()> {
        let text = self.manifest_text()?;
        parse_manifest(&text)?;
        let mut found = false;
        let kept: Vec<&str> = text
            .lines()
            .filter(|line| {
                let listed = line.split('#').next().unwrap_or("").trim() == package;
                found |= listed;
                !listed
            })
            .collect();
        if !found {
            bail!("{package} isn't in {}", self.profile.manifest);
        }
        self.write_manifest(&format!("{}\n", kept.join("\n")))
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
    pub async fn install(
        &self,
        cancel: &CancellationToken,
        log: &InstallLog,
    ) -> Result<Vec<String>> {
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
            let result = self.install_into(&env, &packages, cancel, log).await;
            if let Err(err) = result {
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

    async fn install_into(
        &self,
        env: &Path,
        packages: &[String],
        cancel: &CancellationToken,
        log: &InstallLog,
    ) -> Result<()> {
        let mut updated = false;
        if let Some(update) = &self.profile.update
            && self.update_due(update)?
        {
            self.update(update, env, cancel, log).await?;
            updated = true;
        }
        let first = self.run_install(env, packages, cancel, log).await;
        match (first, &self.profile.update) {
            (Ok(()), _) => Ok(()),
            // Often the installer's list of packages is just out of date.
            (Err(err), Some(update)) if !updated && !cancel.is_cancelled() => {
                log.push(format!("{err:#}"));
                log.push("Refreshing the list of available packages, then trying again.");
                let _ = std::fs::remove_dir_all(env);
                self.update(update, env, cancel, log).await?;
                self.run_install(env, packages, cancel, log).await
            }
            (Err(err), _) => Err(err),
        }
    }

    fn updated_at_path(&self) -> PathBuf {
        self.dir.join("updated-at")
    }

    fn update_due(&self, update: &UpdateStep) -> Result<bool> {
        let last = match std::fs::read_to_string(self.updated_at_path()) {
            Ok(text) => text.trim().parse::<u64>().ok(),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
            Err(err) => return Err(err).context("reading when packages were last updated"),
        };
        Ok(last.is_none_or(|last| now_secs().saturating_sub(last) >= update.every_hours * 3600))
    }

    async fn update(
        &self,
        update: &UpdateStep,
        env: &Path,
        cancel: &CancellationToken,
        log: &InstallLog,
    ) -> Result<()> {
        std::fs::create_dir_all(env).with_context(|| format!("creating {}", env.display()))?;
        let args = self.render(&update.command, env, &[])?;
        run_logged(&args, env, cancel, log).await?;
        paths::write_atomic(&self.updated_at_path(), now_secs().to_string().as_bytes())
    }

    async fn run_install(
        &self,
        env: &Path,
        packages: &[String],
        cancel: &CancellationToken,
        log: &InstallLog,
    ) -> Result<()> {
        std::fs::create_dir_all(env).with_context(|| format!("creating {}", env.display()))?;
        for command in &self.profile.install {
            let args = self.render(command, env, packages)?;
            run_logged(&args, env, cancel, log).await?;
        }
        Ok(())
    }

    fn render(&self, command: &[String], env: &Path, packages: &[String]) -> Result<Vec<String>> {
        let vars = Vars::new().set("env", env.to_string_lossy());
        let mut args = Vec::new();
        for arg in command {
            if arg == "{packages}" {
                args.extend(packages.iter().cloned());
            } else {
                args.push(template::render(arg, &vars)?);
            }
        }
        Ok(args)
    }

    /// Finds the package that would provide a missing module: from the profile's own list, by
    /// looking it up online, or by the usual naming.
    pub async fn resolve(&self, module: &str, http: &reqwest::Client) -> Result<Resolution> {
        if let Some(package) = self.profile.provider(module) {
            return Ok(Resolution::Known {
                package: package.to_owned(),
            });
        }
        let named_after = self
            .profile
            .package_named_after_module
            .then(|| module.split('.').next().unwrap_or(module).to_owned())
            .filter(|name| check_name(name).is_ok());
        let Some(lookup) = &self.profile.lookup else {
            return Ok(
                named_after.map_or(Resolution::NotFound, |package| Resolution::Guessed {
                    package,
                }),
            );
        };
        match lookup.service {
            LookupService::Pypi => {
                let Some(package) = named_after else {
                    return Ok(Resolution::NotFound);
                };
                pypi(lookup.url.as_deref(), &package, http).await
            }
            LookupService::Hoogle => hoogle(lookup.url.as_deref(), module, http).await,
        }
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// The first paragraph of a description, kept short enough to show in a banner.
fn summarise(text: &str) -> Option<String> {
    let first = text
        .split("\n\n")
        .next()?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if first.is_empty() {
        return None;
    }
    Some(if first.chars().count() > 140 {
        format!("{}…", first.chars().take(139).collect::<String>())
    } else {
        first
    })
}

async fn pypi(base: Option<&str>, package: &str, http: &reqwest::Client) -> Result<Resolution> {
    #[derive(Deserialize)]
    struct Response {
        info: Info,
    }
    #[derive(Deserialize)]
    struct Info {
        name: String,
        summary: Option<String>,
    }
    let base = base.unwrap_or("https://pypi.org");
    let response = http
        .get(format!("{base}/pypi/{package}/json"))
        .send()
        .await
        .context("couldn't reach PyPI to look up the package")?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(Resolution::NotFound);
    }
    let body = response
        .error_for_status()
        .context("PyPI couldn't look up the package")?
        .bytes()
        .await?;
    let response: Response = serde_json::from_slice(&body).context("reading PyPI's answer")?;
    check_name(&response.info.name)?;
    Ok(Resolution::Found {
        package: response.info.name,
        summary: response.info.summary.as_deref().and_then(summarise),
    })
}

async fn hoogle(base: Option<&str>, module: &str, http: &reqwest::Client) -> Result<Resolution> {
    #[derive(Deserialize)]
    struct Item {
        item: String,
        #[serde(rename = "type")]
        kind: String,
        #[serde(default)]
        docs: String,
        package: Option<PackageRef>,
    }
    #[derive(Deserialize)]
    struct PackageRef {
        name: Option<String>,
    }
    let base = base.unwrap_or("https://hoogle.haskell.org");
    let mut url = reqwest::Url::parse(&format!("{base}/")).context("the Hoogle address")?;
    url.query_pairs_mut()
        .append_pair("mode", "json")
        .append_pair("format", "text")
        .append_pair("hoogle", module)
        .append_pair("count", "100");
    let body = http
        .get(url)
        .send()
        .await
        .context("couldn't reach Hoogle to look up the module")?
        .error_for_status()
        .context("Hoogle couldn't look up the module")?
        .bytes()
        .await?;
    let items: Vec<Item> = serde_json::from_slice(&body).context("reading Hoogle's answer")?;
    // Hoogle ranks the usual package first; others may re-export the module.
    let wanted = format!("module {module}");
    let found = items
        .into_iter()
        .filter(|i| i.kind == "module" && i.item == wanted)
        .find_map(|i| Some((i.package?.name?, i.docs)));
    Ok(match found {
        Some((package, docs)) if check_name(&package).is_ok() => Resolution::Found {
            package,
            summary: summarise(&docs),
        },
        _ => Resolution::NotFound,
    })
}

/// Runs an installer, logging its output line by line as it goes.
async fn run_logged(
    args: &[String],
    dir: &Path,
    cancel: &CancellationToken,
    log: &InstallLog,
) -> Result<()> {
    let (program, rest) = args.split_first().context("empty command")?;
    log.push(format!("$ {}", args.join(" ")));
    let mut child = process::command(program)
        .args(rest)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("starting `{program}`; is it installed and on your PATH?"))?;
    let group = ProcessGroup::of(&child);
    let stdout = child.stdout.take().context("stdout not captured")?;
    let stderr = child.stderr.take().context("stderr not captured")?;
    let follow = async {
        tokio::join!(follow_lines(stdout, log), follow_lines(stderr, log));
    };
    let wait = async {
        let (status, ()) = tokio::join!(child.wait(), follow);
        status
    };
    let outcome = tokio::select! {
        status = wait => Some(status?),
        () = tokio::time::sleep(INSTALL_TIMEOUT) => None,
        () = cancel.cancelled() => {
            group.kill();
            bail!("Installing was cancelled.");
        }
    };
    group.kill();
    group.finish();
    match outcome {
        Some(status) if status.success() => Ok(()),
        Some(status) => bail!("`{}` failed ({status}):\n{}", args.join(" "), log.tail(15)),
        None => bail!("`{}` took too long and was stopped", args.join(" ")),
    }
}

async fn follow_lines(reader: impl AsyncRead + Unpin, log: &InstallLog) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        log.push(line);
    }
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
            update: None,
            environment: BTreeMap::from([("SITE".to_owned(), "{env}/site:{PATH}".to_owned())]),
            missing_module: vec![],
            missing_package: vec![],
            providers: BTreeMap::new(),
            package_named_after_module: false,
            lookup: None,
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
        p.missing_package = vec!["(two)(groups)".into()];
        assert!(p.validate().is_err());
        assert!(profile(&[]).validate().is_err());
    }

    #[test]
    fn lists_the_programs_installing_needs() {
        let mut p = profile(&[&["cabal", "install"], &["{env}/bin/pip", "install"]]);
        p.update = Some(UpdateStep {
            command: vec!["cabal".into(), "update".into()],
            every_hours: 24,
        });
        assert_eq!(p.required_programs(), ["cabal", "cabal"]);
    }

    #[test]
    fn starts_a_manifest_with_the_defaults_adds_and_removes() {
        let dir = tempfile::tempdir().unwrap();
        let p = profile(&[&["true"]]);
        let packages = packages(&p, dir.path());
        assert_eq!(packages.state().unwrap().packages, ["alpha"]);
        packages.add("beta").unwrap();
        packages.add("beta").unwrap();
        assert_eq!(packages.state().unwrap().packages, ["alpha", "beta"]);
        assert!(packages.add("-x").is_err());

        packages.remove("alpha").unwrap();
        let state = packages.state().unwrap();
        assert_eq!(state.packages, ["beta"]);
        assert!(state.text.starts_with("# Packages"), "{}", state.text);
        assert!(packages.remove("alpha").is_err());
    }

    #[tokio::test]
    async fn installs_and_switches_environment_only_on_success() {
        let dir = tempfile::tempdir().unwrap();
        let p = profile(&[&[
            "sh",
            "-c",
            "mkdir site && echo \"$@\" > site/list && echo installed \"$@\"",
            "sh",
            "{packages}",
        ]]);
        let packages = packages(&p, dir.path());
        assert!(packages.environment().unwrap().is_empty());

        let cancel = CancellationToken::new();
        let log = InstallLog::default();
        assert_eq!(packages.install(&cancel, &log).await.unwrap(), ["alpha"]);
        assert_eq!(log.last().unwrap(), "installed alpha");
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
        let err = broken
            .install(&cancel, &InstallLog::default())
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("broken"), "{err}");
        assert_eq!(broken.environment().unwrap(), env);
        assert_eq!(broken.state().unwrap().installed.unwrap(), ["alpha"]);
    }

    #[tokio::test]
    async fn refreshes_the_index_when_due_or_when_an_install_fails() {
        let dir = tempfile::tempdir().unwrap();
        let updates = dir.path().join("updates");
        let mut p = profile(&[&[
            "sh",
            "-c",
            // Fails until the index has been refreshed twice.
            "test \"$(wc -l < \"$0\")\" -ge 2",
            updates.to_str().unwrap(),
        ]]);
        p.update = Some(UpdateStep {
            command: vec![
                "sh".into(),
                "-c".into(),
                "echo updated >> \"$0\"".into(),
                updates.to_str().unwrap().into(),
            ],
            every_hours: 24,
        });
        let packages = packages(&p, dir.path());
        let cancel = CancellationToken::new();
        // Never updated, so it updates first; that isn't enough, so it updates again and retries.
        let err = packages
            .install(&cancel, &InstallLog::default())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("failed"), "{err:#}");
        assert_eq!(
            std::fs::read_to_string(&updates).unwrap().lines().count(),
            1
        );

        // Updated recently, so it installs straight away, and updates only when that fails.
        let log = InstallLog::default();
        packages.install(&cancel, &log).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(&updates).unwrap().lines().count(),
            2
        );
        assert!(
            log.lines().iter().any(|l| l.contains("Refreshing")),
            "{:?}",
            log.lines()
        );
    }

    #[tokio::test]
    async fn cancels_an_install() {
        let dir = tempfile::tempdir().unwrap();
        let p = profile(&[&["sleep", "30"]]);
        let packages = packages(&p, dir.path());
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            stop.cancel();
        });
        let started = std::time::Instant::now();
        let err = packages
            .install(&cancel, &InstallLog::default())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("cancelled"), "{err:#}");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(packages.state().unwrap().installed.is_none());
    }

    #[tokio::test]
    async fn an_empty_manifest_needs_no_environment() {
        let dir = tempfile::tempdir().unwrap();
        let p = profile(&[&["false"]]);
        let packages = packages(&p, dir.path());
        packages.save_manifest("# nothing yet\n").unwrap();
        assert!(
            packages
                .install(&CancellationToken::new(), &InstallLog::default())
                .await
                .unwrap()
                .is_empty()
        );
        assert!(packages.environment().unwrap().is_empty());
    }

    /// A stand-in for PyPI and Hoogle.
    async fn fake_services() -> String {
        use axum::extract::Query;
        use axum::routing::get;
        let app = axum::Router::new()
            .route(
                "/pypi/numpy/json",
                get(|| async {
                    axum::Json(serde_json::json!({
                        "info": { "name": "numpy", "summary": "Fundamental package for array computing in Python" }
                    }))
                }),
            )
            .route(
                "/",
                get(|Query(q): Query<BTreeMap<String, String>>| async move {
                    let module = q.get("hoogle").cloned().unwrap_or_default();
                    axum::Json(serde_json::json!([
                        { "item": format!("module {module}.Internal"), "type": "module", "docs": "", "package": { "name": "wrong" } },
                        { "item": "lookup :: k -> Map k a", "type": "", "docs": "", "package": { "name": "wrong" }, "module": { "name": module } },
                        { "item": format!("module {module}"), "type": "module", "docs": "Fast graphs.\n\nMore detail.", "package": { "name": "fgl" } },
                    ]))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn resolves_modules_to_packages() {
        let dir = tempfile::tempdir().unwrap();
        let base = fake_services().await;
        let http = reqwest::Client::new();

        let mut python = profile(&[&["true"]]);
        python.package_named_after_module = true;
        python.providers = BTreeMap::from([("yaml".to_owned(), "pyyaml".to_owned())]);
        let guessing = packages(&python, dir.path());
        assert_eq!(
            guessing.resolve("yaml", &http).await.unwrap(),
            Resolution::Known {
                package: "pyyaml".into()
            }
        );
        assert_eq!(
            guessing.resolve("numpy.linalg", &http).await.unwrap(),
            Resolution::Guessed {
                package: "numpy".into()
            }
        );

        let mut checked = python.clone();
        checked.lookup = Some(Lookup {
            service: LookupService::Pypi,
            url: Some(base.clone()),
        });
        let checking = packages(&checked, dir.path());
        assert_eq!(
            checking.resolve("numpy.linalg", &http).await.unwrap(),
            Resolution::Found {
                package: "numpy".into(),
                summary: Some("Fundamental package for array computing in Python".into()),
            }
        );
        // A module of the solution's own isn't taken for a package that doesn't exist.
        assert_eq!(
            checking.resolve("helpers", &http).await.unwrap(),
            Resolution::NotFound
        );

        let mut haskell = profile(&[&["true"]]);
        haskell.lookup = Some(Lookup {
            service: LookupService::Hoogle,
            url: Some(base),
        });
        let looking_up = packages(&haskell, dir.path());
        assert_eq!(
            looking_up
                .resolve("Data.Graph.Inductive", &http)
                .await
                .unwrap(),
            Resolution::Found {
                package: "fgl".into(),
                summary: Some("Fast graphs.".into()),
            }
        );
    }
}
