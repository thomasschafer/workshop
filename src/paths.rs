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

    pub fn state_file(&self) -> PathBuf {
        self.data_dir.join("state.json")
    }

    pub fn day_meta_dir(&self) -> PathBuf {
        self.data_dir.join("days")
    }
}

/// Expands a leading `~` to the home directory.
pub fn expand_home(path: &str) -> Result<PathBuf> {
    if path == "~" {
        return dirs::home_dir().context("could not determine the home directory");
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return Ok(dirs::home_dir()
            .context("could not determine the home directory")?
            .join(rest));
    }
    Ok(PathBuf::from(path))
}

/// Writes via a temporary file and rename so an interrupted write never leaves a truncated file.
pub fn write_atomic(path: &Path, contents: &[u8]) -> Result<()> {
    let dir = path
        .parent()
        .with_context(|| format!("{} has no parent directory", path.display()))?;
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let file_name = path
        .file_name()
        .with_context(|| format!("{} has no file name", path.display()))?;
    let tmp = dir.join(format!(".{}.tmp", file_name.to_string_lossy()));
    std::fs::write(&tmp, contents).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("renaming into {}", path.display()))?;
    Ok(())
}
