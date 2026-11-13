use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// Directories Workshop reads and writes, outside of the user's solutions repo.
#[derive(Debug, Clone)]
pub struct Paths {
    pub config_dir: PathBuf,
    /// Puzzle text and inputs. Advent of Code asks that these are not published, so this must
    /// never live inside the solutions repo.
    pub cache_dir: PathBuf,
    pub data_dir: PathBuf,
}

impl Paths {
    pub fn from_env() -> Result<Self> {
        if let Some(home) = std::env::var_os("WORKSHOP_HOME") {
            return Ok(Self::under(Path::new(&home)));
        }
        let config_dir = dirs::config_dir()
            .context("could not determine the config directory")?
            .join("workshop");
        let cache_dir = dirs::cache_dir()
            .context("could not determine the cache directory")?
            .join("workshop");
        let data_dir = dirs::data_dir()
            .context("could not determine the data directory")?
            .join("workshop");
        Ok(Self {
            config_dir,
            cache_dir,
            data_dir,
        })
    }

    /// Keeps everything under one root, which is used by tests and by `WORKSHOP_HOME`.
    pub fn under(root: &Path) -> Self {
        Self {
            config_dir: root.join("config"),
            cache_dir: root.join("cache"),
            data_dir: root.join("data"),
        }
    }

    pub fn config_file(&self) -> PathBuf {
        self.config_dir.join("config.toml")
    }

    pub fn token_file(&self) -> PathBuf {
        self.config_dir.join("token")
    }

    pub fn aoc_session_file(&self) -> PathBuf {
        self.config_dir.join("aoc-session")
    }

    pub fn aoc_cache_dir(&self) -> PathBuf {
        self.cache_dir.join("aoc")
    }

    pub fn build_dir(&self) -> PathBuf {
        self.cache_dir.join("build")
    }

    /// Where a language's packages are installed. They can always be installed again from the
    /// manifest in the solutions directory.
    pub fn packages_dir(&self, language: &str) -> PathBuf {
        self.cache_dir.join("packages").join(language)
    }

    /// A local log of utterances, model replies and errors, for tuning and troubleshooting.
    pub fn log_file(&self) -> PathBuf {
        self.data_dir.join("workshop.log")
    }

    /// Choices made in the app, such as models and language.
    pub fn settings_file(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }

    pub fn state_file(&self) -> PathBuf {
        self.data_dir.join("state.json")
    }

    pub fn day_meta_dir(&self) -> PathBuf {
        self.data_dir.join("days")
    }
}
