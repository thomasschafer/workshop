use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

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
    /// Under `WORKSHOP_HOME` if it's set, or else the user's own directories, which only a
    /// release build uses, so building and trying out Workshop can't touch the user's real
    /// data.
    pub fn from_env() -> Result<Self> {
        Self::from_home(
            std::env::var_os("WORKSHOP_HOME").as_deref(),
            cfg!(debug_assertions),
        )
    }

    fn from_home(home: Option<&std::ffi::OsStr>, debug_build: bool) -> Result<Self> {
        match home {
            Some(home) if home.is_empty() => {
                bail!("WORKSHOP_HOME is set, but empty: set it to a directory, or unset it")
            }
            Some(home) => return Ok(Self::under(Path::new(home))),
            None if debug_build => bail!(
                "this is a development build of Workshop, which doesn't use your real config and data unless WORKSHOP_HOME says where they are: set it to a directory of their own, such as WORKSHOP_HOME=$PWD/.dev, as `mise run dev` does, or use a release build"
            ),
            None => {}
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

    /// Where optional on-device runtime bundles (such as GHC WASM) are cached for serving to
    /// phones. Can be overridden with `WORKSHOP_ON_DEVICE_DIR` for local bundle development.
    pub fn on_device_dir(&self) -> PathBuf {
        if let Some(dir) = std::env::var_os("WORKSHOP_ON_DEVICE_DIR")
            && !dir.is_empty()
        {
            return PathBuf::from(dir);
        }
        self.cache_dir.join("on-device")
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

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;

    use super::*;

    #[test]
    fn uses_the_real_directories_only_in_a_release_build() {
        let err = Paths::from_home(None, true).unwrap_err();
        assert!(err.to_string().contains("WORKSHOP_HOME"), "{err}");
        let real = Paths::from_home(None, false).unwrap();
        assert!(real.config_dir.ends_with("workshop"));
        for debug_build in [true, false] {
            let home = Paths::from_home(Some(OsStr::new("/somewhere")), debug_build).unwrap();
            assert_eq!(home.data_dir, Path::new("/somewhere/data"));
            assert!(Paths::from_home(Some(OsStr::new("")), debug_build).is_err());
        }
    }
}
