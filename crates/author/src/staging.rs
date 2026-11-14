//! The copy of a pack the author's writer works in, so the pack itself is never in reach of a
//! model: what the writer may change there, and putting back anything else it changed.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// A pack's files, by their paths relative to it, with `/` between directories.
pub type Files = BTreeMap<String, Vec<u8>>;

/// Reads every file in a pack, leaving out names starting with `.`, such as `.git`, as
/// `Pack::load` does.
pub fn read(dir: &Path) -> Result<Files> {
    let mut files = Files::new();
    read_into(dir, dir, &mut files)?;
    Ok(files)
}

fn read_into(root: &Path, dir: &Path, files: &mut Files) -> Result<()> {
    for entry in std::fs::read_dir(dir).with_context(|| format!("reading {}", dir.display()))? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        let kind = entry.file_type()?;
        if kind.is_dir() {
            read_into(root, &path, files)?;
        } else if kind.is_file() {
            // Symbolic links aren't followed, so nothing outside the pack is copied in or out.
            let relative = relative(root, &path);
            files.insert(
                relative,
                std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?,
            );
        }
    }
    Ok(())
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .expect("under the root")
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// The path of a file in a directory, from its relative path, refusing any that would leave it.
pub fn path_in(dir: &Path, relative: &str) -> Result<PathBuf> {
    if relative
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == ".." || part.starts_with('.'))
    {
        anyhow::bail!("{relative:?} isn't a path inside the pack");
    }
    Ok(dir.join(relative))
}

pub fn write(dir: &Path, relative: &str, bytes: &[u8]) -> Result<()> {
    let path = path_in(dir, relative)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, bytes).with_context(|| format!("writing {}", path.display()))
}

pub fn remove(dir: &Path, relative: &str) -> Result<()> {
    let path = path_in(dir, relative)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err).with_context(|| format!("removing {}", path.display())),
    }
}

/// Copies a pack's files into an empty directory.
pub fn stage(files: &Files, dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    for (path, bytes) in files {
        write(dir, path, bytes)?;
    }
    Ok(())
}

/// What the writer changed in the copy, and what it changed that it may not, which has been
/// put back.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Changes {
    /// New files under `items/`.
    pub added: Vec<String>,
    /// Drafts it deleted, having made items from them.
    pub drafts_removed: Vec<String>,
    /// What else it changed, and was put back as it was.
    pub put_back: Vec<String>,
}

/// Compares the copy with the pack as it was, keeping new files under `items/` and drafts
/// deleted, and putting everything else back: files changed, added elsewhere, or deleted.
pub fn police(original: &Files, dir: &Path) -> Result<Changes> {
    let now = read(dir)?;
    let mut changes = Changes::default();
    for (path, bytes) in &now {
        match original.get(path) {
            Some(before) if before == bytes => {}
            Some(before) => {
                write(dir, path, before)?;
                changes.put_back.push(path.clone());
            }
            None if path.starts_with("items/") => changes.added.push(path.clone()),
            None => {
                remove(dir, path)?;
                changes.put_back.push(path.clone());
            }
        }
    }
    for (path, bytes) in original {
        if now.contains_key(path) {
            continue;
        }
        if path.starts_with("drafts/") && path.ends_with(".md") && !path[7..].contains('/') {
            changes.drafts_removed.push(path.clone());
        } else {
            write(dir, path, bytes)?;
            changes.put_back.push(path.clone());
        }
    }
    Ok(changes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_new_items_and_puts_back_everything_else() {
        let dir = tempfile::tempdir().unwrap();
        let original: Files = [
            ("pack.toml", "id = \"x\""),
            ("items/a.md", "A"),
            ("drafts/q.md", "Q"),
            ("drafts/r.md", "R"),
        ]
        .into_iter()
        .map(|(p, t)| (p.to_owned(), t.as_bytes().to_vec()))
        .collect();
        let copy = dir.path().join("pack");
        stage(&original, &copy).unwrap();
        std::fs::write(copy.join("pack.toml"), "id = \"changed\"").unwrap();
        std::fs::write(copy.join("items/b.md"), "B").unwrap();
        std::fs::create_dir_all(copy.join("items/c")).unwrap();
        std::fs::write(copy.join("items/c/item.md"), "C").unwrap();
        std::fs::write(copy.join("notes.md"), "mine").unwrap();
        std::fs::remove_file(copy.join("items/a.md")).unwrap();
        std::fs::remove_file(copy.join("drafts/q.md")).unwrap();
        // Its own files, which aren't part of the pack.
        std::fs::create_dir_all(copy.join(".cache")).unwrap();

        let changes = police(&original, &copy).unwrap();
        assert_eq!(changes.added, ["items/b.md", "items/c/item.md"]);
        assert_eq!(changes.drafts_removed, ["drafts/q.md"]);
        assert_eq!(changes.put_back, ["notes.md", "pack.toml", "items/a.md"]);
        let now = read(&copy).unwrap();
        assert_eq!(now["pack.toml"], b"id = \"x\"");
        assert!(!now.contains_key("notes.md"));
        assert_eq!(now["items/a.md"], b"A");
        assert!(path_in(&copy, "../x").is_err());
        assert!(path_in(&copy, ".git/config").is_err());
    }
}
