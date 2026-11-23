//! Reviewing a change to a codebase: the learner reads a diff against a small project and
//! writes review comments, typed or dictated, each about a line of a file or the change as a
//! whole. Nothing runs. The grader marks the comments against the defects planted in the
//! change, which is an attempt rated from the score, and each defect missed goes in the mistake
//! log. Comments are saved as they're written, with which file is open, so a review can be left
//! and carried on, on any device.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use workshop_pack::diff::{Line, LineKind};
use workshop_pack::{Defect, Item, Review};

use crate::coding::OpenedTrack;

/// The most comments a review can have, and characters in each, so it reads on a phone and a
/// grader's prompt stays a sensible size.
const MAX_COMMENTS: usize = 40;
const MAX_COMMENT_CHARS: usize = 2000;

/// Where the learner is with a review, saved as each comment is written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewSession {
    pub comments: Vec<Comment>,
    /// The file being read, so it's open again on coming back.
    #[serde(default)]
    pub file: Option<String>,
    /// When it was started, and last saved, in milliseconds since 1970.
    pub started_at: i64,
    pub updated_at: i64,
    /// Bumped on every save, so a save made from an older copy, such as on another device,
    /// is refused rather than losing what's newer.
    #[serde(default)]
    pub version: u64,
}

/// A review comment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Comment {
    /// Made by the app, so a comment can be changed or taken away.
    pub id: String,
    /// The file it's about, or `None` for the change as a whole.
    #[serde(default)]
    pub file: Option<String>,
    /// The line it's about, counting from 1: in the file as the change leaves it, or with
    /// `old`, a line of the file before the change, which it removes.
    #[serde(default)]
    pub line: Option<usize>,
    #[serde(default)]
    pub old: bool,
    pub text: String,
}

impl Comment {
    /// Where it's about, in words, as the grader is told.
    fn place(&self) -> String {
        match (&self.file, self.line, self.old) {
            (None, _, _) => "the change as a whole".to_owned(),
            (Some(file), None, _) => file.clone(),
            (Some(file), Some(line), false) => format!("{file}, line {line}"),
            (Some(file), Some(line), true) => {
                format!("{file}, line {line} of the old file, which it removes")
            }
        }
    }
}

/// A file of the project, as the review shows it: a file the change touches with its lines kept,
/// added and removed, or one it doesn't with its lines as they are.
#[derive(Debug, Clone, Serialize)]
pub struct ReviewFile {
    pub path: String,
    pub changed: bool,
    pub lines: Vec<Line>,
}

/// A change to review, as the app shows it.
#[derive(Debug, Serialize)]
pub struct OpenedReview {
    /// Always `"review"`, telling it apart from a problem to solve.
    pub kind: &'static str,
    pub key: String,
    pub label: String,
    pub track: OpenedTrack,
    pub skills: Vec<String>,
    pub source: Option<String>,
    pub minutes: u32,
    /// What the change is for, in Markdown.
    pub prompt: String,
    /// The files the change touches first, then the rest, each in order of their names.
    pub files: Vec<ReviewFile>,
    pub session: ReviewSession,
}

/// How a review was marked, now it's finished.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewMarked {
    /// The attempt it was, so submitting it again gives it back rather than marking it twice.
    pub attempt: String,
    pub marked: crate::grader::Marked,
    pub defects: Vec<Defect>,
    pub notes: Option<String>,
    pub comments: Vec<Comment>,
}

/// Reviews' sessions, and the last marking of each, kept in the Coding track's data.
pub struct Reviews {
    saved: workshop_sessions::Saved<ReviewSession>,
    marked: workshop_sessions::Saved<ReviewMarked>,
}

/// A change to review found in the packs.
pub struct Found<'a> {
    pub pack: &'a workshop_pack::Pack,
    pub item: &'a Item,
    pub review: &'a Review,
}

impl Found<'_> {
    pub fn key(&self) -> String {
        format!("{}/{}", self.pack.manifest.id, self.item.id)
    }
}

/// The change to review with this key in the packs, if it's one.
pub fn find<'a>(packs: &'a [workshop_pack::Pack], pack: &str, item: &str) -> Option<Found<'a>> {
    let pack = packs.iter().find(|p| p.manifest.id == pack)?;
    let item = pack.item(item)?;
    match &item.content {
        workshop_pack::Content::Review(review) => Some(Found { pack, item, review }),
        _ => None,
    }
}

/// Why a review couldn't be saved.
#[derive(Debug, thiserror::Error)]
pub enum ReviewError {
    #[error("this review changed on another device")]
    Conflict { current: Box<ReviewSession> },
    #[error("the review hasn't been started, or it's been finished")]
    NotStarted,
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

impl Reviews {
    pub fn new(coding_dir: &Path) -> Self {
        Self {
            saved: workshop_sessions::Saved::new(coding_dir.join("reviews")),
            marked: workshop_sessions::Saved::new(coding_dir.join("reviews-marked")),
        }
    }

    pub fn session(&self, key: &str) -> Result<Option<ReviewSession>> {
        self.saved.get(key)
    }

    /// Every review in progress, by item.
    pub fn sessions(&self) -> Result<BTreeMap<String, ReviewSession>> {
        self.saved.all()
    }

    /// Starts a review, or carries on with one.
    pub fn start(&self, found: &Found<'_>, now: i64) -> Result<ReviewSession> {
        self.saved.put_new(
            &found.key(),
            ReviewSession {
                comments: Vec::new(),
                file: None,
                started_at: now,
                updated_at: now,
                version: 1,
            },
        )
    }

    /// Saves a review's comments and the file open, if `session` is from the version saved
    /// last. Returns it as saved, and the time spent on it since it was last saved.
    pub fn save(
        &self,
        found: &Found<'_>,
        session: ReviewSession,
        now: i64,
    ) -> Result<(ReviewSession, i64), ReviewError> {
        check(found.review, &session).map_err(ReviewError::Invalid)?;
        let mut spent = 0;
        let saved = self.saved.change(&found.key(), |before| {
            if before.version != session.version {
                return Ok(Err(ReviewError::Conflict {
                    current: Box::new(before.clone()),
                }));
            }
            spent = workshop_sessions::spent(before.updated_at, now);
            *before = ReviewSession {
                started_at: before.started_at,
                updated_at: now.max(before.updated_at),
                version: before.version + 1,
                ..session
            };
            Ok(Ok(()))
        })?;
        match saved {
            None => Err(ReviewError::NotStarted),
            Some((_, Err(err))) => Err(err),
            Some((saved, Ok(()))) => Ok((saved, spent)),
        }
    }

    /// The marking kept for this attempt, if it's been marked already.
    pub fn marked(&self, key: &str, attempt: &str) -> Result<Option<ReviewMarked>> {
        Ok(self.marked.get(key)?.filter(|m| m.attempt == attempt))
    }

    /// Keeps a review's marking, and ends its session.
    pub fn finish(&self, key: &str, marked: &ReviewMarked) -> Result<()> {
        self.marked.put(key, marked)?;
        self.saved.remove(key)
    }

    /// Everything the app needs to show a review.
    pub fn open(
        &self,
        found: &Found<'_>,
        problem_track: OpenedTrack,
        session: ReviewSession,
    ) -> OpenedReview {
        let item = found.item;
        OpenedReview {
            kind: "review",
            key: found.key(),
            label: item.label(),
            track: problem_track,
            skills: item.skills.clone(),
            source: item.source.clone(),
            minutes: item.minutes,
            prompt: item.prompt.clone(),
            files: files(found.review),
            session,
        }
    }
}

/// The project's files as the review shows them: those the change touches first.
pub fn files(review: &Review) -> Vec<ReviewFile> {
    let changed = review.changed.iter().map(|(path, lines)| ReviewFile {
        path: path.clone(),
        changed: true,
        lines: lines.clone(),
    });
    let unchanged = review
        .files
        .iter()
        .filter(|f| !review.changed.contains_key(&f.path))
        .map(|f| ReviewFile {
            path: f.path.clone(),
            changed: false,
            lines: f
                .text
                .lines()
                .enumerate()
                .map(|(at, text)| Line {
                    kind: LineKind::Kept,
                    old: Some(at + 1),
                    new: Some(at + 1),
                    text: text.to_owned(),
                })
                .collect(),
        });
    changed.chain(unchanged).collect()
}

/// Says what's wrong with a review's comments, if anything: each must say something, about a
/// file the project has, at a line it has.
fn check(review: &Review, session: &ReviewSession) -> Result<(), String> {
    if session.comments.len() > MAX_COMMENTS {
        return Err(format!("a review has at most {MAX_COMMENTS} comments"));
    }
    let files = files(review);
    let find = |path: &str| files.iter().find(|f| f.path == path);
    if let Some(file) = &session.file
        && find(file).is_none()
    {
        return Err(format!("the project has no file {file:?} to open"));
    }
    for comment in &session.comments {
        if comment.text.chars().count() > MAX_COMMENT_CHARS {
            return Err(format!(
                "a comment can be at most {MAX_COMMENT_CHARS} characters"
            ));
        }
        let (file, line) = match (&comment.file, comment.line) {
            (None, Some(_)) => return Err("a comment on a line says which file it's in".to_owned()),
            (None, None) => continue,
            (Some(file), line) => (file, line),
        };
        let Some(shown) = find(file) else {
            return Err(format!("there's no file {file:?} to comment on"));
        };
        if let Some(line) = line {
            let side = |l: &Line| {
                if comment.old {
                    l.old.filter(|_| l.kind == LineKind::Removed)
                } else {
                    l.new
                }
            };
            if !shown.lines.iter().any(|l| side(l) == Some(line)) {
                return Err(format!(
                    "{file} has no {}line {line} to comment on",
                    if comment.old { "removed " } else { "" }
                ));
            }
        }
    }
    Ok(())
}

/// The comments as the grader reads them, a line each with where they're about.
pub fn work(comments: &[Comment]) -> String {
    comments
        .iter()
        .filter(|c| !c.text.trim().is_empty())
        .map(|c| format!("- On {}: {}\n", c.place(), c.text.trim().replace('\n', " ")))
        .collect()
}

/// A problem's track as a review shows it, for the way back.
pub fn track(found: &Found<'_>) -> OpenedTrack {
    let id = found.item.track.clone();
    let (name, icon) = crate::learning::track_label(std::slice::from_ref(found.pack), &id);
    OpenedTrack { id, name, icon }
}

#[cfg(test)]
mod tests {
    use workshop_pack::Pack;

    use super::*;

    const NOW: i64 = 1_790_000_000_000;

    fn comment(file: Option<&str>, line: Option<usize>, old: bool, text: &str) -> Comment {
        Comment {
            id: format!("c-{text}"),
            file: file.map(str::to_owned),
            line,
            old,
            text: text.to_owned(),
        }
    }

    #[test]
    fn keeps_a_reviews_comments_and_the_file_open() {
        let dir = tempfile::tempdir().unwrap();
        let packs = vec![Pack::sample()];
        let found = find(&packs, "sample", "loan-renewals").unwrap();
        let reviews = Reviews::new(dir.path());
        let session = reviews.start(&found, NOW).unwrap();
        assert!(session.comments.is_empty());
        // Started again, it's the same one.
        assert_eq!(reviews.start(&found, NOW + 5).unwrap(), session);

        let next = ReviewSession {
            comments: vec![
                comment(
                    Some("loans.py"),
                    Some(47),
                    false,
                    "Off by one: allows a third renewal",
                ),
                comment(None, None, false, "No test for reservations"),
            ],
            file: Some("loans.py".to_owned()),
            ..session.clone()
        };
        let (saved, spent) = reviews.save(&found, next.clone(), NOW + 60_000).unwrap();
        assert_eq!(saved.version, 2);
        assert_eq!(spent, 60_000);
        assert_eq!(saved.comments, next.comments);
        assert_eq!(reviews.session(&found.key()).unwrap().unwrap(), saved);
        // A save from the older copy is refused, with what's there now.
        let stale = reviews.save(&found, next, NOW + 70_000).unwrap_err();
        assert!(matches!(stale, ReviewError::Conflict { current } if current.version == 2));

        let opened = reviews.open(&found, track(&found), saved.clone());
        assert_eq!(opened.kind, "review");
        assert_eq!(opened.files[0].path, "loans.py");
        assert!(opened.files[0].changed);
        assert!(
            opened
                .files
                .iter()
                .any(|f| f.path == "catalogue.py" && !f.changed)
        );

        assert_eq!(
            work(&saved.comments),
            "- On loans.py, line 47: Off by one: allows a third renewal\n- On the change as a whole: No test for reservations\n"
        );
    }

    #[test]
    fn refuses_comments_on_what_isnt_there() {
        let dir = tempfile::tempdir().unwrap();
        let packs = vec![Pack::sample()];
        let found = find(&packs, "sample", "loan-renewals").unwrap();
        let reviews = Reviews::new(dir.path());
        let session = reviews.start(&found, NOW).unwrap();
        for (comments, file, says) in [
            (
                vec![comment(Some("nowhere.py"), Some(1), false, "x")],
                None,
                "no file",
            ),
            (
                vec![comment(Some("loans.py"), Some(900), false, "x")],
                None,
                "no line 900",
            ),
            (vec![comment(None, Some(3), false, "x")], None, "which file"),
            // Line 5 of the old file is kept, not removed.
            (
                vec![comment(Some("loans.py"), Some(5), true, "x")],
                None,
                "no removed line 5",
            ),
            (Vec::new(), Some("nowhere.py"), "no file"),
        ] {
            let bad = ReviewSession {
                comments,
                file: file.map(str::to_owned),
                ..session.clone()
            };
            let err = reviews.save(&found, bad, NOW).unwrap_err();
            assert!(err.to_string().contains(says), "{err}");
        }
        let unstarted = find(&packs, "sample", "loan-renewals").unwrap();
        let other = Reviews::new(&dir.path().join("other"));
        assert!(matches!(
            other.save(&unstarted, session, NOW).unwrap_err(),
            ReviewError::NotStarted
        ));
    }
}
