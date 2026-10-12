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
    write_atomic_with_mode(path, contents, None)
}

/// Like `write_atomic`, for files only the user may read, such as credentials. The permissions
/// are set before anything is written, so the contents are never readable by others.
pub fn write_private(path: &Path, contents: &[u8]) -> Result<()> {
    write_atomic_with_mode(path, contents, Some(0o600))
}

fn write_atomic_with_mode(path: &Path, contents: &[u8], mode: Option<u32>) -> Result<()> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    let dir = path
        .parent()
        .with_context(|| format!("{} has no parent directory", path.display()))?;
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let file_name = path
        .file_name()
        .with_context(|| format!("{} has no file name", path.display()))?;
    // Unique, so concurrent writes to the same file can't trample each other's temporary file.
    let tmp = dir.join(format!(
        ".{}.{}.{}.tmp",
        file_name.to_string_lossy(),
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    let result = (|| {
        let mut file = options.open(&tmp)?;
        file.write_all(contents)?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if let Err(err) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(err).with_context(|| format!("writing {}", path.display()));
    }
    // Makes the rename itself durable; not every platform supports syncing a directory.
    if let Ok(dir) = std::fs::File::open(dir) {
        let _ = dir.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_atomically_and_leaves_no_temporary_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/file.txt");
        write_atomic(&path, b"one").unwrap();
        write_atomic(&path, b"two").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "two");
        let entries: Vec<_> = std::fs::read_dir(path.parent().unwrap()).unwrap().collect();
        assert_eq!(entries.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn private_files_are_only_readable_by_the_user() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("token");
        write_private(&path, b"secret").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn concurrent_writes_to_one_file_all_succeed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::thread::scope(|scope| {
            for i in 0..8 {
                let path = &path;
                scope.spawn(move || write_atomic(path, format!("{i}").as_bytes()).unwrap());
            }
        });
        assert!(
            std::fs::read_to_string(&path)
                .unwrap()
                .parse::<u32>()
                .is_ok()
        );
    }
}
