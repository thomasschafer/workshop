//! Differences between versions of a project's files, a line at a time: working out what
//! changed, as a learner's changes and a reference fix are shown, and reading and applying a
//! change written as a unified diff, as a codebase item to review gives one.
//!
//! Files are compared as lines, without their line endings, so a file without a newline at its
//! end is the same as one with.

use std::collections::BTreeMap;

use serde::Serialize;

/// Whether a line is in both versions, or only in one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LineKind {
    Kept,
    Added,
    Removed,
}

/// A line of one version or both, with where it is in each, counting from 1.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Line {
    pub kind: LineKind,
    /// Its number in the old version, unless it was added.
    pub old: Option<usize>,
    /// Its number in the new version, unless it was removed.
    pub new: Option<usize>,
    pub text: String,
}

/// Every line of both versions, in order, each kept, added or removed: the smallest change
/// from `old` to `new`, with what's removed before what's added in its place.
pub fn lines(old: &str, new: &str) -> Vec<Line> {
    let a: Vec<&str> = old.lines().collect();
    let b: Vec<&str> = new.lines().collect();
    // The longest common subsequence of the lines after each pair of positions. Files are
    // a few hundred lines at most, so the table's size is no trouble.
    let mut longest = vec![vec![0u32; b.len() + 1]; a.len() + 1];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            longest[i][j] = if a[i] == b[j] {
                longest[i + 1][j + 1] + 1
            } else {
                longest[i + 1][j].max(longest[i][j + 1])
            };
        }
    }
    let mut out = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < a.len() || j < b.len() {
        if i < a.len() && j < b.len() && a[i] == b[j] {
            out.push(Line {
                kind: LineKind::Kept,
                old: Some(i + 1),
                new: Some(j + 1),
                text: a[i].to_owned(),
            });
            i += 1;
            j += 1;
        } else if i < a.len() && (j == b.len() || longest[i + 1][j] >= longest[i][j + 1]) {
            out.push(Line {
                kind: LineKind::Removed,
                old: Some(i + 1),
                new: None,
                text: a[i].to_owned(),
            });
            i += 1;
        } else {
            out.push(Line {
                kind: LineKind::Added,
                old: None,
                new: Some(j + 1),
                text: b[j].to_owned(),
            });
            j += 1;
        }
    }
    out
}

/// How many lines were added and removed.
pub fn counts(lines: &[Line]) -> (usize, usize) {
    let of = |kind| lines.iter().filter(|line| line.kind == kind).count();
    (of(LineKind::Added), of(LineKind::Removed))
}

/// The lines around each change, with `context` unchanged lines either side, grouped into
/// hunks: runs of lines close enough together to show as one.
pub fn hunks(lines: &[Line], context: usize) -> Vec<&[Line]> {
    let changed: Vec<usize> = (0..lines.len())
        .filter(|&at| lines[at].kind != LineKind::Kept)
        .collect();
    let mut hunks: Vec<(usize, usize)> = Vec::new();
    for at in changed {
        let start = at.saturating_sub(context);
        let end = (at + context + 1).min(lines.len());
        match hunks.last_mut() {
            Some((_, last_end)) if start <= *last_end => *last_end = end,
            _ => hunks.push((start, end)),
        }
    }
    hunks
        .into_iter()
        .map(|(start, end)| &lines[start..end])
        .collect()
}

/// A change to one file, as a unified diff, with three lines of context, or nothing if it
/// hasn't changed. `old` is `None` for a file that's new, and `new` for one that's gone.
pub fn unified(path: &str, old: Option<&str>, new: Option<&str>) -> String {
    let all = lines(old.unwrap_or(""), new.unwrap_or(""));
    let hunks = hunks(&all, 3);
    if hunks.is_empty() {
        return String::new();
    }
    let mut out = format!(
        "--- {}\n+++ {}\n",
        old.map_or("/dev/null".to_owned(), |_| format!("a/{path}")),
        new.map_or("/dev/null".to_owned(), |_| format!("b/{path}"))
    );
    for hunk in hunks {
        let start = |side: fn(&Line) -> Option<usize>| {
            // A side with no lines in the hunk starts after the line before it.
            hunk.iter().find_map(side).unwrap_or_else(|| {
                all.iter()
                    .take_while(|line| !std::ptr::eq(*line, &hunk[0]))
                    .filter_map(side)
                    .last()
                    .unwrap_or(0)
            })
        };
        let count = |side: fn(&Line) -> Option<usize>| hunk.iter().filter_map(side).count();
        out.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            start(|l| l.old),
            count(|l| l.old),
            start(|l| l.new),
            count(|l| l.new)
        ));
        for line in hunk {
            let mark = match line.kind {
                LineKind::Kept => ' ',
                LineKind::Added => '+',
                LineKind::Removed => '-',
            };
            out.push(mark);
            out.push_str(&line.text);
            out.push('\n');
        }
    }
    out
}

/// A change to one file, read from a unified diff.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileChange {
    /// The file's path before the change, or `None` for a file the change adds.
    pub old: Option<String>,
    /// Its path after, or `None` for a file the change deletes.
    pub new: Option<String>,
    pub hunks: Vec<Hunk>,
}

impl FileChange {
    /// The file it changes: its path after the change, or before, for one it deletes.
    pub fn path(&self) -> &str {
        self.new
            .as_deref()
            .or(self.old.as_deref())
            .expect("a change has a path on one side at least")
    }
}

/// A run of changed lines, with the unchanged lines around them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hunk {
    /// Where it starts in the old version, counting from 1, or 0 when it has no old lines.
    pub old_start: usize,
    /// Where it starts in the new version, likewise.
    pub new_start: usize,
    pub lines: Vec<(LineKind, String)>,
}

/// Reads a unified diff, such as `git diff` writes, of one or more files. Lines before the
/// first file's `---`, such as git's `diff --git` and `index` lines, are skipped, and so are
/// `\ No newline at end of file` lines, as files are compared without their line endings.
pub fn parse(text: &str) -> Result<Vec<FileChange>, String> {
    let mut changes: Vec<FileChange> = Vec::new();
    let mut lines = text.lines().enumerate().peekable();
    // How many old and new lines the current hunk still has to come.
    let mut remaining: Option<(usize, usize)> = None;
    while let Some((at, line)) = lines.next() {
        let number = at + 1;
        if let Some((old_left, new_left)) = remaining.as_mut()
            && (*old_left > 0 || *new_left > 0)
        {
            let hunk = changes
                .last_mut()
                .and_then(|change| change.hunks.last_mut())
                .expect("a hunk is being read");
            if line.starts_with('\\') {
                continue;
            }
            let (kind, rest) = match line.chars().next() {
                Some(' ') => (LineKind::Kept, &line[1..]),
                Some('+') => (LineKind::Added, &line[1..]),
                Some('-') => (LineKind::Removed, &line[1..]),
                // Some editors drop the space from an empty line of context.
                None => (LineKind::Kept, ""),
                Some(_) => {
                    return Err(format!(
                        "line {number} of the diff should start with a space, + or -, as the hunk above it has lines still to come"
                    ));
                }
            };
            let (takes_old, takes_new) = match kind {
                LineKind::Kept => (1, 1),
                LineKind::Added => (0, 1),
                LineKind::Removed => (1, 0),
            };
            if takes_old > *old_left || takes_new > *new_left {
                return Err(format!(
                    "line {number} of the diff is more than its hunk's header says it has"
                ));
            }
            *old_left -= takes_old;
            *new_left -= takes_new;
            hunk.lines.push((kind, rest.to_owned()));
            continue;
        }
        if line.starts_with('\\') {
            continue;
        }
        if let Some(old) = line.strip_prefix("--- ") {
            let Some((_, next)) = lines.next() else {
                return Err(format!(
                    "line {number} of the diff has no +++ line after it"
                ));
            };
            let Some(new) = next.strip_prefix("+++ ") else {
                return Err(format!(
                    "line {} of the diff should be the +++ line for the file on line {number}",
                    number + 1
                ));
            };
            let old = side(old, "a/");
            let new = side(new, "b/");
            if old.is_none() && new.is_none() {
                return Err(format!(
                    "the change on line {number} of the diff is from /dev/null to /dev/null"
                ));
            }
            for path in old.iter().chain(&new) {
                if !is_project_path(path) {
                    return Err(format!(
                        "{path:?}, on line {number} of the diff, should be a file directly in the project, such as loans.py"
                    ));
                }
            }
            if let (Some(old), Some(new)) = (&old, &new)
                && old != new
            {
                return Err(format!(
                    "the diff renames {old} to {new} on line {number}; change a file where it is instead"
                ));
            }
            if let Some(same) = changes
                .iter()
                .find(|c| c.path() == new.as_deref().or(old.as_deref()).unwrap_or_default())
            {
                return Err(format!(
                    "the diff changes {} twice; give each file's changes once",
                    same.path()
                ));
            }
            changes.push(FileChange {
                old,
                new,
                hunks: Vec::new(),
            });
            remaining = None;
            continue;
        }
        if let Some(header) = line.strip_prefix("@@ ") {
            let Some(change) = changes.last_mut() else {
                return Err(format!(
                    "the hunk on line {number} of the diff comes before any file's --- and +++ lines"
                ));
            };
            let (old_start, old_count, new_start, new_count) =
                hunk_header(header).ok_or_else(|| {
                    format!(
                        "line {number} of the diff isn't a hunk's header, such as @@ -3,4 +3,5 @@"
                    )
                })?;
            change.hunks.push(Hunk {
                old_start,
                new_start,
                lines: Vec::new(),
            });
            remaining = Some((old_count, new_count));
            continue;
        }
        if changes.is_empty() || line.trim().is_empty() || is_git_line(line) {
            continue;
        }
        return Err(format!(
            "line {number} of the diff isn't part of a file's change: {line:?}"
        ));
    }
    if let Some((old_left, new_left)) = remaining
        && (old_left > 0 || new_left > 0)
    {
        return Err("the diff ends before its last hunk does".to_owned());
    }
    if changes.is_empty() {
        return Err(
            "the diff changes no files: it needs a file's --- and +++ lines, and its hunks"
                .to_owned(),
        );
    }
    if let Some(empty) = changes.iter().find(|c| c.hunks.is_empty()) {
        return Err(format!(
            "the diff's change to {} has no hunks",
            empty.path()
        ));
    }
    for change in &changes {
        if let Some(n) = change
            .hunks
            .iter()
            .position(|h| h.lines.iter().all(|(kind, _)| *kind == LineKind::Kept))
        {
            return Err(format!(
                "hunk {} of {}'s change has only lines of context, so it changes nothing",
                n + 1,
                change.path()
            ));
        }
    }
    Ok(changes)
}

/// A side of a file's change, without git's `a/` or `b/`, or `None` for `/dev/null`.
fn side(text: &str, prefix: &str) -> Option<String> {
    // A timestamp can follow the path, after a tab.
    let path = text.split('\t').next().unwrap_or(text).trim();
    (path != "/dev/null").then(|| path.strip_prefix(prefix).unwrap_or(path).to_owned())
}

/// Lines git writes between files' changes, such as `diff --git` and `index`.
fn is_git_line(line: &str) -> bool {
    [
        "diff ",
        "index ",
        "new file mode",
        "deleted file mode",
        "old mode",
        "new mode",
    ]
    .iter()
    .any(|start| line.starts_with(start))
}

/// A hunk header's start and count of lines in the old version and the new: from
/// `-3,4 +3,5 @@`, with a count of 1 where it's left out, as in `-3 +3 @@`.
fn hunk_header(header: &str) -> Option<(usize, usize, usize, usize)> {
    let (ranges, _) = header.split_once(" @@")?;
    let (old, new) = ranges.split_once(' ')?;
    let range = |text: &str, sign: char| -> Option<(usize, usize)> {
        let text = text.strip_prefix(sign)?;
        match text.split_once(',') {
            Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
            None => Some((text.parse().ok()?, 1)),
        }
    };
    let (old_start, old_count) = range(old, '-')?;
    let (new_start, new_count) = range(new, '+')?;
    Some((old_start, old_count, new_start, new_count))
}

/// Whether a path is a file directly in a project: a name of letters, digits, `_`, `-` and
/// `.`, not starting with a dot.
pub fn is_project_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 64
        && !path.starts_with('.')
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

/// The files after a change, each with its lines as the change leaves them: kept, added, or
/// removed, by where they were. Every line of context and every line removed must be in the
/// file, where the hunk's header says, or the change doesn't apply.
pub fn apply(
    files: &BTreeMap<String, String>,
    changes: &[FileChange],
) -> Result<BTreeMap<String, Vec<Line>>, String> {
    let mut out = BTreeMap::new();
    for change in changes {
        let path = change.path();
        let old: Vec<&str> = match &change.old {
            Some(old) => files
                .get(old)
                .ok_or_else(|| format!("the diff changes {old}, which isn't in the project"))?
                .lines()
                .collect(),
            None => {
                if files.contains_key(path) {
                    return Err(format!(
                        "the diff adds {path}, which is in the project already"
                    ));
                }
                Vec::new()
            }
        };
        let mut lines = Vec::new();
        let mut next_old = 0;
        let mut next_new = 0;
        let keep_until =
            |until: usize, lines: &mut Vec<Line>, next_old: &mut usize, next_new: &mut usize| {
                while *next_old < until {
                    *next_new += 1;
                    lines.push(Line {
                        kind: LineKind::Kept,
                        old: Some(*next_old + 1),
                        new: Some(*next_new),
                        text: old[*next_old].to_owned(),
                    });
                    *next_old += 1;
                }
            };
        for (n, hunk) in change.hunks.iter().enumerate() {
            let has_old = hunk.lines.iter().any(|(kind, _)| *kind != LineKind::Added);
            // A hunk's start counts from 1, or names the line it comes after when it has none.
            let start = if has_old {
                hunk.old_start
                    .checked_sub(1)
                    .ok_or_else(|| format!("hunk {} of {path}'s change starts at line 0", n + 1))?
            } else {
                hunk.old_start
            };
            if start < next_old {
                return Err(format!(
                    "hunk {} of {path}'s change starts at line {}, before the hunk above it ends",
                    n + 1,
                    hunk.old_start
                ));
            }
            if start > old.len() {
                return Err(format!(
                    "hunk {} of {path}'s change starts at line {}, and {path} has {} lines",
                    n + 1,
                    hunk.old_start,
                    old.len()
                ));
            }
            keep_until(start, &mut lines, &mut next_old, &mut next_new);
            let has_new = hunk
                .lines
                .iter()
                .any(|(kind, _)| *kind != LineKind::Removed);
            let new_start = if has_new { next_new + 1 } else { next_new };
            if hunk.new_start != new_start {
                return Err(format!(
                    "hunk {} of {path}'s change says it starts at line {} of the new version, and it starts at line {new_start}",
                    n + 1,
                    hunk.new_start
                ));
            }
            for (kind, text) in &hunk.lines {
                match kind {
                    LineKind::Added => {
                        next_new += 1;
                        lines.push(Line {
                            kind: LineKind::Added,
                            old: None,
                            new: Some(next_new),
                            text: text.clone(),
                        });
                    }
                    LineKind::Kept | LineKind::Removed => {
                        match old.get(next_old) {
                            Some(line) if line == text => {}
                            found => {
                                return Err(format!(
                                    "hunk {} of {path}'s change doesn't apply: it expects line {} to be {text:?}, and it's {}",
                                    n + 1,
                                    next_old + 1,
                                    found.map_or(
                                        "past the end of the file".to_owned(),
                                        |line| format!("{line:?}")
                                    )
                                ));
                            }
                        }
                        next_old += 1;
                        let new = (*kind == LineKind::Kept).then(|| {
                            next_new += 1;
                            next_new
                        });
                        lines.push(Line {
                            kind: *kind,
                            old: Some(next_old),
                            new,
                            text: text.clone(),
                        });
                    }
                }
            }
        }
        keep_until(old.len(), &mut lines, &mut next_old, &mut next_new);
        if change.new.is_none() && lines.iter().any(|l| l.kind != LineKind::Removed) {
            return Err(format!(
                "the diff deletes {path}, so it should remove every line of it"
            ));
        }
        out.insert(path.to_owned(), lines);
    }
    Ok(out)
}

/// A file's text as a change leaves it, from its lines.
pub fn new_text(lines: &[Line]) -> String {
    lines
        .iter()
        .filter(|line| line.kind != LineKind::Removed)
        .map(|line| format!("{}\n", line.text))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
        entries
            .iter()
            .map(|(path, text)| ((*path).to_owned(), (*text).to_owned()))
            .collect()
    }

    #[test]
    fn finds_the_smallest_change() {
        let diff = lines("a\nb\nc\nd\n", "a\nc\nx\nd");
        let marks: Vec<(LineKind, &str)> = diff.iter().map(|l| (l.kind, l.text.as_str())).collect();
        assert_eq!(
            marks,
            [
                (LineKind::Kept, "a"),
                (LineKind::Removed, "b"),
                (LineKind::Kept, "c"),
                (LineKind::Added, "x"),
                (LineKind::Kept, "d"),
            ]
        );
        assert_eq!(diff[3].new, Some(3));
        assert_eq!(diff[1].old, Some(2));
        assert_eq!(counts(&diff), (1, 1));
        // A line changed is removed, then added.
        let changed = lines("x = 1\n", "x = 2\n");
        assert_eq!(changed[0].kind, LineKind::Removed);
        assert_eq!(changed[1].kind, LineKind::Added);
        assert!(
            lines("same\n", "same")
                .iter()
                .all(|l| l.kind == LineKind::Kept)
        );
    }

    #[test]
    fn writes_and_reads_unified_diffs() {
        let old = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";
        let new = "one\ntwo\nthree\nFOUR\nfive\nsix\nseven\neight\nnine\nten\neleven\n";
        let written = unified("count.py", Some(old), Some(new));
        assert_eq!(
            written,
            "--- a/count.py\n+++ b/count.py\n@@ -1,10 +1,11 @@\n one\n two\n three\n-four\n+FOUR\n five\n six\n seven\n eight\n nine\n ten\n+eleven\n"
        );
        let changes = parse(&written).unwrap();
        let applied = apply(&files(&[("count.py", old)]), &changes).unwrap();
        assert_eq!(new_text(&applied["count.py"]), new);
        // A new file, and one unchanged.
        let added = unified("new.py", None, Some("x = 1\n"));
        assert_eq!(
            added,
            "--- /dev/null\n+++ b/new.py\n@@ -0,0 +1,1 @@\n+x = 1\n"
        );
        let applied = apply(&BTreeMap::new(), &parse(&added).unwrap()).unwrap();
        assert_eq!(new_text(&applied["new.py"]), "x = 1\n");
        assert_eq!(unified("same.py", Some("a\n"), Some("a\n")), "");
    }

    #[test]
    fn applies_hunks_where_their_headers_say() {
        let project = files(&[("loans.py", "a\nb\nc\nd\ne\nf\ng\nh\n")]);
        let diff = "diff --git a/loans.py b/loans.py\nindex 1..2 100644\n--- a/loans.py\n+++ b/loans.py\n@@ -2,2 +2,2 @@\n b\n-c\n+C\n@@ -7 +7,2 @@\n g\n+g2\n\\ No newline at end of file\n";
        let applied = apply(&project, &parse(diff).unwrap()).unwrap();
        let lines = &applied["loans.py"];
        assert_eq!(new_text(lines), "a\nb\nC\nd\ne\nf\ng\ng2\nh\n");
        let added = lines.iter().find(|l| l.text == "g2").unwrap();
        assert_eq!((added.old, added.new), (None, Some(8)));
        let removed = lines.iter().find(|l| l.text == "c").unwrap();
        assert_eq!((removed.kind, removed.old), (LineKind::Removed, Some(3)));
    }

    #[test]
    fn says_why_a_diff_cant_be_read_or_applied() {
        let project = files(&[("loans.py", "a\nb\nc\n")]);
        let read = |diff: &str| parse(diff).unwrap_err();
        let applied = |diff: &str| apply(&project, &parse(diff).unwrap()).unwrap_err();
        for (err, says) in [
            (read("just words\n"), "changes no files"),
            (read("--- a/loans.py\n"), "no +++ line"),
            (read("--- a/loans.py\n+++ b/loans.py\n"), "has no hunks"),
            (
                read("--- a/loans.py\n+++ b/loans.py\n@@ -1,2 +1,2 @@\n a\n"),
                "ends before",
            ),
            (
                read("--- a/loans.py\n+++ b/loans.py\n@@ nonsense @@\n"),
                "isn't a hunk's header",
            ),
            (
                read("--- a/lib/loans.py\n+++ b/lib/loans.py\n@@ -1 +1 @@\n-a\n+b\n"),
                "directly in the project",
            ),
            (
                read("--- a/a.py\n+++ b/b.py\n@@ -1 +1 @@\n-a\n+b\n"),
                "renames",
            ),
            (
                read("--- a/loans.py\n+++ b/loans.py\n@@ -1 +1 @@\n*a\n"),
                "should start with",
            ),
            (
                applied("--- a/loans.py\n+++ b/loans.py\n@@ -2 +2 @@\n-x\n+y\n"),
                "expects line 2 to be \"x\"",
            ),
            (
                applied("--- a/other.py\n+++ b/other.py\n@@ -1 +1 @@\n-a\n+b\n"),
                "isn't in the project",
            ),
            (
                applied("--- /dev/null\n+++ b/loans.py\n@@ -0,0 +1 @@\n+a\n"),
                "in the project already",
            ),
            (
                applied("--- a/loans.py\n+++ b/loans.py\n@@ -9 +9 @@\n-a\n+b\n"),
                "has 3 lines",
            ),
            (
                applied("--- a/loans.py\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n"),
                "remove every line",
            ),
        ] {
            assert!(err.contains(says), "{err}");
        }
    }

    #[test]
    fn groups_changes_into_hunks() {
        let old: String = (1..=20).map(|n| format!("{n}\n")).collect();
        let new: String = (1..=20)
            .map(|n| match n {
                2 => "two\n".to_owned(),
                18 => "eighteen\n".to_owned(),
                n => format!("{n}\n"),
            })
            .collect();
        let all = lines(&old, &new);
        let grouped = hunks(&all, 2);
        assert_eq!(grouped.len(), 2);
        assert_eq!(grouped[0].first().unwrap().text, "1");
        assert_eq!(grouped[1].last().unwrap().text, "20");
        assert_eq!(hunks(&all, 10).len(), 1);
    }

    #[test]
    fn knows_a_path_in_a_project() {
        assert!(is_project_path("loans.py"));
        assert!(is_project_path("test_loans.py"));
        for bad in ["", "lib/loans.py", ".hidden", "../up.py", "a b.py"] {
            assert!(!is_project_path(bad), "{bad}");
        }
    }
}
