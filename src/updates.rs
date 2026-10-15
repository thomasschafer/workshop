//! Whether a newer release of Workshop is out, checked with GitHub once a day, unless turned off
//! with `check_for_updates = false` under [server].

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::paths::{self, Paths};

const LATEST_URL: &str = "https://api.github.com/repos/thomasschafer/workshop/releases/latest";
const CHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
const RELEASES_URL: &str = "https://github.com/thomasschafer/workshop/releases";
const INSTALL_COMMAND: &str =
    "curl -fsSL https://raw.githubusercontent.com/thomasschafer/workshop/main/install.sh | sh";

/// A newer release, and how to get it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Update {
    pub version: String,
    /// What to do to update, for how this copy of Workshop was installed.
    pub how: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Checked {
    /// The latest release's version, such as `0.5.0`.
    latest: String,
    /// When it was checked, in seconds since 1970.
    checked_at: u64,
}

pub struct Updates {
    enabled: bool,
    file: PathBuf,
    latest: Mutex<Option<Checked>>,
}

impl Updates {
    pub fn load(paths: &Paths, enabled: bool) -> Self {
        let file = paths.data_dir.join("latest-release.json");
        // A missing or unreadable record is only a check not yet made.
        let latest = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok());
        Self {
            enabled,
            file,
            latest: Mutex::new(latest),
        }
    }

    /// The newer release, if one is out, as of the last check.
    pub fn available(&self) -> Option<Update> {
        if !self.enabled {
            return None;
        }
        let latest = lock(&self.latest).as_ref()?.latest.clone();
        newer(&latest, env!("CARGO_PKG_VERSION")).then(|| Update {
            version: latest,
            how: how_to_update(std::env::current_exe().ok().as_deref()),
        })
    }

    /// Checks once a day for as long as the server runs.
    pub async fn run(&self) {
        if !self.enabled {
            return;
        }
        let http = match reqwest::Client::builder()
            .user_agent(concat!("workshop/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(30))
            .build()
        {
            Ok(http) => http,
            Err(err) => {
                tracing::warn!("checking for updates: {err:#}");
                return;
            }
        };
        loop {
            let due = lock(&self.latest)
                .as_ref()
                .is_none_or(|c| now_secs().saturating_sub(c.checked_at) >= CHECK_EVERY.as_secs());
            if due && let Err(err) = self.check(&http).await {
                tracing::debug!("checking for updates: {err:#}");
            }
            tokio::time::sleep(Duration::from_secs(60 * 60)).await;
        }
    }

    async fn check(&self, http: &reqwest::Client) -> Result<()> {
        #[derive(Deserialize)]
        struct Release {
            tag_name: String,
        }
        let body = http
            .get(LATEST_URL)
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?;
        let release: Release = serde_json::from_slice(&body).context("reading GitHub's answer")?;
        let checked = Checked {
            latest: release.tag_name.trim_start_matches('v').to_owned(),
            checked_at: now_secs(),
        };
        paths::write_atomic(&self.file, &serde_json::to_vec(&checked)?)?;
        if newer(&checked.latest, env!("CARGO_PKG_VERSION")) {
            tracing::info!("Workshop {} is out", checked.latest);
        }
        *lock(&self.latest) = Some(checked);
        Ok(())
    }
}

/// Whether version `a` is newer than `b`, both as `major.minor.patch`.
fn newer(a: &str, b: &str) -> bool {
    let parse = |v: &str| -> Option<(u64, u64, u64)> {
        let mut parts = v.split('.').map(|p| p.parse::<u64>().ok());
        Some((parts.next()??, parts.next()??, parts.next()??))
    };
    matches!((parse(a), parse(b)), (Some(a), Some(b)) if a > b)
}

/// How to update a copy of Workshop installed at `exe`: as Homebrew, the install script, or by
/// hand put it there.
fn how_to_update(exe: Option<&Path>) -> String {
    let path = exe
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    if path.contains("/Cellar/") || path.contains("/homebrew/") || path.contains("/linuxbrew/") {
        "Run `brew upgrade workshop`, then restart Workshop.".to_owned()
    } else if path.contains("/.local/bin/") {
        format!("Run `{INSTALL_COMMAND}`, then restart Workshop.")
    } else {
        format!("Download it from {RELEASES_URL}, then restart Workshop.")
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions() {
        assert!(newer("0.5.0", "0.4.0"));
        assert!(newer("0.10.0", "0.9.9"));
        assert!(newer("1.0.0", "0.99.0"));
        assert!(!newer("0.4.0", "0.4.0"));
        assert!(!newer("0.3.9", "0.4.0"));
        assert!(!newer("nonsense", "0.4.0"));
    }

    #[test]
    fn says_how_to_update_for_how_it_was_installed() {
        assert!(
            how_to_update(Some(Path::new(
                "/opt/homebrew/Cellar/workshop/0.4.0/bin/workshop"
            )))
            .contains("brew upgrade workshop")
        );
        assert!(
            how_to_update(Some(Path::new("/home/me/.local/bin/workshop"))).contains("install.sh")
        );
        assert!(how_to_update(Some(Path::new("/usr/local/bin/workshop"))).contains("releases"));
    }

    #[test]
    fn offers_a_newer_release_once_checked() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::under(dir.path());
        let record = |latest: &str| {
            paths::write_atomic(
                &paths.data_dir.join("latest-release.json"),
                &serde_json::to_vec(&Checked {
                    latest: latest.into(),
                    checked_at: 0,
                })
                .unwrap(),
            )
            .unwrap();
        };
        assert_eq!(Updates::load(&paths, true).available(), None);
        record("999.0.0");
        assert_eq!(
            Updates::load(&paths, true).available().map(|u| u.version),
            Some("999.0.0".to_owned())
        );
        // Turned off, nothing is offered.
        assert_eq!(Updates::load(&paths, false).available(), None);
        record(env!("CARGO_PKG_VERSION"));
        assert_eq!(Updates::load(&paths, true).available(), None);
    }
}
