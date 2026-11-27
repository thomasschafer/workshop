//! The copy of a pack the author's writer works in, so the pack itself is never in reach of a
//! model: what the writer may change there, and putting back anything else it changed.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use workshop_pack::Pack;

/// A pack's files, by their paths relative to it, with `/` between directories.
pub type Files = BTreeMap<String, Vec<u8>>;

/// Whether a path in a pack is a draft: a Markdown file directly in `drafts/`.
pub fn is_draft(path: &str) -> bool {
    path.strip_prefix("drafts/")
        .is_some_and(|name| name.ends_with(".md") && !name.contains('/'))
}

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

/// A permitted front-matter link change to an existing short item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkChange {
    pub path: String,
    pub lesson: String,
    /// Counting from 1, if given.
    pub segment: Option<usize>,
    pub content: String,
}

/// What the writer changed in the copy, and what it changed that it may not, which has been
/// put back.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Changes {
    /// New files under `items/`.
    pub added: Vec<String>,
    /// Existing short items whose front matter was changed only to link them to a new lesson.
    pub linked: Vec<LinkChange>,
    /// Drafts it deleted, having made items from them.
    pub drafts_removed: Vec<String>,
    /// What else it changed, and was put back as it was.
    pub put_back: Vec<String>,
}

/// Compares the copy with the pack as it was, keeping new files under `items/` and drafts
/// deleted, and putting everything else back: files changed, added elsewhere, or deleted.
pub fn police(original: &Files, dir: &Path) -> Result<Changes> {
    police_with_links(original, None, dir, &BTreeSet::new())
}

/// Like [`police`], also allowing existing short items in `original_pack` to have `lesson` and
/// `segment` added or changed in their front matter to point to a lesson id in `allowed_lessons`.
pub fn police_with_links(
    original: &Files,
    original_pack: Option<&Pack>,
    dir: &Path,
    allowed_lessons: &BTreeSet<String>,
) -> Result<Changes> {
    let now = read(dir)?;
    let mut changes = Changes::default();
    for (path, bytes) in &now {
        match original.get(path) {
            Some(before) if before == bytes => {}
            Some(before) => {
                let is_existing_short = original_pack.is_some_and(|pack| {
                    pack.items
                        .iter()
                        .any(|item| item.path == *path && item.kind.is_short())
                });
                if is_existing_short
                    && let Some((lesson, segment, content)) =
                        lesson_link_change(before, bytes, allowed_lessons)
                {
                    changes.linked.push(LinkChange {
                        path: path.clone(),
                        lesson,
                        segment,
                        content,
                    });
                } else {
                    write(dir, path, before)?;
                    changes.put_back.push(path.clone());
                }
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
        if is_draft(path) {
            changes.drafts_removed.push(path.clone());
        } else {
            write(dir, path, bytes)?;
            changes.put_back.push(path.clone());
        }
    }
    Ok(changes)
}

/// If `after` differs from `before` only by adding or changing `lesson` and/or `segment` in the
/// TOML front matter, with `lesson` naming an id in `allowed_lessons` and `segment` (if set) a
/// positive integer, returns `(lesson, segment, after_utf8)`. Otherwise returns `None`.
pub fn lesson_link_change(
    before: &[u8],
    after: &[u8],
    allowed_lessons: &BTreeSet<String>,
) -> Option<(String, Option<usize>, String)> {
    if before == after || allowed_lessons.is_empty() {
        return None;
    }
    let before_str = std::str::from_utf8(before).ok()?;
    let after_str = std::str::from_utf8(after).ok()?;
    let (before_front, before_body) = workshop_pack::split_front_matter(before_str).ok()?;
    let (after_front, after_body) = workshop_pack::split_front_matter(after_str).ok()?;
    if before_body != after_body {
        return None;
    }
    let mut before_table: toml::Table = toml::from_str(before_front).ok()?;
    let mut after_table: toml::Table = toml::from_str(after_front).ok()?;
    let after_lesson = match after_table.get("lesson") {
        Some(toml::Value::String(id)) if allowed_lessons.contains(id) => id.clone(),
        _ => return None,
    };
    let after_segment = match after_table.get("segment") {
        None => None,
        Some(toml::Value::Integer(n)) if *n >= 1 => Some(usize::try_from(*n).ok()?),
        Some(_) => return None,
    };
    let before_lesson = before_table.remove("lesson");
    let before_segment = before_table.remove("segment");
    let after_lesson_val = after_table.remove("lesson");
    let after_segment_val = after_table.remove("segment");
    if before_lesson == after_lesson_val && before_segment == after_segment_val {
        return None;
    }
    if before_table != after_table {
        return None;
    }
    Some((after_lesson, after_segment, after_str.to_owned()))
}

/// Lesson ids of new lesson items under `items/` in `now` (not in `original`), reading front
/// matter directly so lessons with fixable body errors still count during fix rounds.
pub fn new_lesson_ids(original: &Files, now: &Files) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    for (path, bytes) in now {
        if original.contains_key(path) || !path.starts_with("items/") || !path.ends_with(".md") {
            continue;
        }
        if let Some(id) = lesson_id_from_front_matter(path, bytes) {
            ids.insert(id);
        }
    }
    ids
}

/// Extracts an item's default id from its pack-relative path, matching `Pack::from_files`.
pub fn default_id_from_path(path: &str) -> &str {
    if let Some(dir) = path.strip_suffix("/item.md") {
        dir.rsplit('/').next().unwrap_or(dir)
    } else {
        path.rsplit('/')
            .next()
            .and_then(|name| name.strip_suffix(".md"))
            .unwrap_or(path)
    }
}

/// If `bytes` has TOML front matter with `kind = "lesson"`, returns its `id` (or path default).
pub fn lesson_id_from_front_matter(path: &str, bytes: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(bytes).ok()?;
    let (front, _) = workshop_pack::split_front_matter(text).ok()?;
    let table: toml::Table = toml::from_str(front).ok()?;
    if table.get("kind").and_then(toml::Value::as_str) != Some("lesson") {
        return None;
    }
    let id = table
        .get("id")
        .and_then(toml::Value::as_str)
        .unwrap_or_else(|| default_id_from_path(path));
    Some(id.to_owned())
}

/// Extracts `lesson = "..."` from an item file's TOML front matter, if present.
pub fn lesson_ref_from_front_matter(bytes: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(bytes).ok()?;
    let (front, _) = workshop_pack::split_front_matter(text).ok()?;
    let table: toml::Table = toml::from_str(front).ok()?;
    table
        .get("lesson")
        .and_then(toml::Value::as_str)
        .map(str::to_owned)
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

    #[test]
    fn allows_only_lesson_and_segment_front_matter_changes_to_existing_short_items() {
        let manifest = "id = \"x\"\nname = \"X\"\n\n[[skills]]\nid = \"s\"\nname = \"S\"\n";
        let card =
            "+++\nkind = \"card\"\nskills = [\"s\"]\n+++\nQuestion?\n\n## Answer\n\nAnswer.\n";
        let card_linked = "+++\nkind = \"card\"\nskills = [\"s\"]\nlesson = \"new-lesson\"\nsegment = 2\n+++\nQuestion?\n\n## Answer\n\nAnswer.\n";
        let card_other_lesson = "+++\nkind = \"card\"\nskills = [\"s\"]\nlesson = \"old-lesson\"\n+++\nQuestion?\n\n## Answer\n\nAnswer.\n";
        let card_body_changed = "+++\nkind = \"card\"\nskills = [\"s\"]\nlesson = \"new-lesson\"\n+++\nChanged?\n\n## Answer\n\nAnswer.\n";
        let card_field_changed = "+++\nkind = \"card\"\nskills = [\"s\"]\ntitle = \"New\"\nlesson = \"new-lesson\"\n+++\nQuestion?\n\n## Answer\n\nAnswer.\n";
        let design =
            "+++\nkind = \"design\"\nskills = [\"s\"]\n+++\nDesign X.\n\n## Rubric\n\n- A point\n";
        let design_linked = "+++\nkind = \"design\"\nskills = [\"s\"]\nlesson = \"new-lesson\"\n+++\nDesign X.\n\n## Rubric\n\n- A point\n";

        let original: Files = [
            ("pack.toml", manifest),
            ("items/c1.md", card),
            ("items/c2.md", card),
            ("items/c3.md", card),
            ("items/c4.md", card),
            ("items/d.md", design),
        ]
        .into_iter()
        .map(|(p, t)| (p.to_owned(), t.as_bytes().to_vec()))
        .collect();
        let pack = Pack::from_files(original.clone()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let copy = dir.path().join("pack");
        stage(&original, &copy).unwrap();

        std::fs::write(copy.join("items/c1.md"), card_linked).unwrap();
        std::fs::write(copy.join("items/c2.md"), card_other_lesson).unwrap();
        std::fs::write(copy.join("items/c3.md"), card_body_changed).unwrap();
        std::fs::write(copy.join("items/c4.md"), card_field_changed).unwrap();
        std::fs::write(copy.join("items/d.md"), design_linked).unwrap();

        let allowed = BTreeSet::from(["new-lesson".to_owned()]);
        let changes = police_with_links(&original, Some(&pack), &copy, &allowed).unwrap();
        assert_eq!(changes.linked.len(), 1);
        assert_eq!(changes.linked[0].path, "items/c1.md");
        assert_eq!(changes.linked[0].lesson, "new-lesson");
        assert_eq!(changes.linked[0].segment, Some(2));
        assert_eq!(
            changes.put_back,
            ["items/c2.md", "items/c3.md", "items/c4.md", "items/d.md"]
        );
        // Only c1 kept its change; all others were restored.
        let now = read(&copy).unwrap();
        assert_eq!(now["items/c1.md"], card_linked.as_bytes());
        assert_eq!(now["items/c2.md"], card.as_bytes());
        assert_eq!(now["items/c3.md"], card.as_bytes());
        assert_eq!(now["items/c4.md"], card.as_bytes());
        assert_eq!(now["items/d.md"], design.as_bytes());
    }
}
