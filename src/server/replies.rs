//! Coaches' replies, kept as they're written, so a page that loses its connection part-way, as a
//! phone's does when it's put down or switched to another app, can pick the reply up again.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::error::{ApiError, bad_request, not_found};
use super::state::Shared;

/// How long a reply is kept after it was asked for. Replies time out well within this.
const KEPT_FOR: Duration = Duration::from_secs(60 * 60);

#[derive(Clone, Serialize)]
pub(super) struct Finished {
    pub(super) text: String,
    pub(super) model: Option<String>,
}

#[derive(Clone)]
enum End {
    Done(Finished),
    Error(String),
    Cancelled,
}

/// A reply as far as it's been written.
#[derive(Clone, Default)]
struct Progress {
    text: String,
    end: Option<End>,
}

struct Kept {
    asked: Instant,
    progress: watch::Sender<Progress>,
    cancel: CancellationToken,
}

/// The replies asked for in the last hour, by the id the app gave each.
#[derive(Default)]
pub(super) struct Replies(Mutex<HashMap<String, Kept>>);

/// Where a reply's writer reports what's been written.
pub(super) struct Writer(watch::Sender<Progress>);

impl Writer {
    pub(super) fn delta(&self, text: &str) {
        self.0.send_modify(|p| p.text.push_str(text));
    }

    pub(super) fn finish(self, end: Result<Finished, String>) {
        let end = match end {
            Ok(done) => End::Done(done),
            Err(error) => End::Error(error),
        };
        self.0.send_modify(|p| p.end = Some(end));
    }

    pub(super) fn cancel(self) {
        self.0.send_modify(|p| p.end = Some(End::Cancelled));
    }
}

impl Drop for Writer {
    /// A writer that goes without finishing, such as one whose task panicked, ends the reply,
    /// so whoever's following it isn't left waiting.
    fn drop(&mut self) {
        self.0.send_if_modified(|p| {
            if p.end.is_some() {
                return false;
            }
            p.end = Some(End::Error(
                "The reply stopped before it was finished.".to_owned(),
            ));
            true
        });
    }
}

impl Replies {
    /// An id for a reply the app didn't give one, as an app from before replies were kept
    /// doesn't. The app's own ids are UUIDs, so they never clash.
    pub(super) fn unnamed() -> String {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        format!("unnamed-{}", NEXT.fetch_add(1, Ordering::Relaxed))
    }

    /// Starts keeping a new reply under `id`, which must not have been used already.
    pub(super) fn start(&self, id: &str) -> Result<(Writer, CancellationToken), ApiError> {
        if id.is_empty() || id.len() > 64 {
            return Err(bad_request("A reply's id must be 1 to 64 characters."));
        }
        let mut kept = self.0.lock().expect("replies lock poisoned");
        kept.retain(|_, k| k.asked.elapsed() < KEPT_FOR || k.progress.borrow().end.is_none());
        if kept.contains_key(id) {
            return Err(bad_request(format!(
                "A reply was already asked for as {id:?}."
            )));
        }
        let progress = watch::Sender::new(Progress::default());
        let cancel = CancellationToken::new();
        kept.insert(
            id.to_owned(),
            Kept {
                asked: Instant::now(),
                progress: progress.clone(),
                cancel: cancel.clone(),
            },
        );
        Ok((Writer(progress), cancel))
    }

    /// Signals a reply in progress to stop. Harmless if unknown or already finished.
    pub(super) fn cancel(&self, id: &str) {
        let kept = self.0.lock().expect("replies lock poisoned");
        if let Some(entry) = kept.get(id) {
            entry.cancel.cancel();
        }
    }

    /// The reply kept under `id`, from the start, as it's written.
    pub(super) fn follow(&self, id: &str) -> Result<Response, ApiError> {
        let kept = self.0.lock().expect("replies lock poisoned");
        let progress = kept.get(id).map(|k| k.progress.subscribe()).ok_or_else(|| {
            not_found(
                "The server has no such reply: it may not have arrived, or the server has restarted since.",
            )
        })?;
        Ok(stream(progress))
    }
}

/// A reply as newline-delimited JSON, from the start however much is already written:
/// `{"delta": text}` as it's written, then `{"done": {text, model}}`, `{"cancelled": true}` or
/// `{"error": message}`.
fn stream(progress: watch::Receiver<Progress>) -> Response {
    let lines = futures_util::stream::unfold(Some((progress, 0)), |state| async move {
        let (mut progress, sent) = state?;
        loop {
            let now = progress.borrow_and_update().clone();
            let line =
                |value: serde_json::Value| Ok::<_, std::convert::Infallible>(format!("{value}\n"));
            if matches!(now.end, Some(End::Cancelled)) {
                return Some((line(serde_json::json!({ "cancelled": true })), None));
            }
            if now.text.len() > sent {
                let delta = serde_json::json!({ "delta": &now.text[sent..] });
                return Some((line(delta), Some((progress, now.text.len()))));
            }
            match now.end {
                Some(End::Done(done)) => {
                    return Some((line(serde_json::json!({ "done": done })), None));
                }
                Some(End::Error(error)) => {
                    return Some((line(serde_json::json!({ "error": error })), None));
                }
                Some(End::Cancelled) => unreachable!(),
                // Every writer ends its reply, even one that's dropped, so this only fails for a
                // reply let go of before it ended, which none is.
                None => progress.changed().await.ok()?,
            }
        }
    });
    (
        [
            (header::CONTENT_TYPE, "application/x-ndjson"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        Body::from_stream(lines),
    )
        .into_response()
}

/// Picks up a reply asked for earlier, from the start.
pub(super) async fn reply(
    State(app): State<Shared>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    app.replies.follow(&id)
}

/// Stops a reply in progress. Harmless if the reply has already ended or isn't known.
pub(super) async fn cancel(State(app): State<Shared>, Path(id): Path<String>) -> StatusCode {
    app.replies.cancel(&id);
    StatusCode::NO_CONTENT
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;

    use super::*;

    async fn lines(response: Response) -> Vec<serde_json::Value> {
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        String::from_utf8(body.to_vec())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[tokio::test]
    async fn picks_a_reply_up_from_the_start_and_follows_it_to_the_end() {
        let replies = Replies::default();
        let (writer, _cancel) = replies.start("a").unwrap();
        writer.delta("Look at ");
        let following = replies.follow("a").unwrap();
        writer.delta("the loop.");
        writer.finish(Ok(Finished {
            text: "Look at the loop.".to_owned(),
            model: None,
        }));
        let lines = lines(following).await;
        let text: String = lines
            .iter()
            .filter_map(|line| line["delta"].as_str())
            .collect();
        assert_eq!(text, "Look at the loop.");
        assert_eq!(
            lines.last().unwrap(),
            &serde_json::json!({ "done": { "text": "Look at the loop.", "model": null } })
        );
        // Once it's done, it can still be picked up, whole.
        let again = self::lines(replies.follow("a").unwrap()).await;
        assert_eq!(
            again[0],
            serde_json::json!({ "delta": "Look at the loop." })
        );
    }

    #[tokio::test]
    async fn a_writer_that_goes_without_finishing_ends_its_reply_with_an_error() {
        let replies = Replies::default();
        let (writer, _cancel) = replies.start("a").unwrap();
        let following = replies.follow("a").unwrap();
        drop(writer);
        let lines = lines(following).await;
        assert_eq!(
            lines,
            [serde_json::json!({ "error": "The reply stopped before it was finished." })]
        );
    }

    #[tokio::test]
    async fn cancelling_signals_the_writer_and_ends_followers_as_cancelled() {
        let replies = Replies::default();
        let (writer, cancel) = replies.start("a").unwrap();
        let following = replies.follow("a").unwrap();
        assert!(!cancel.is_cancelled());
        replies.cancel("a");
        assert!(cancel.is_cancelled());
        writer.delta("ignored after cancel");
        writer.cancel();
        assert_eq!(
            lines(following).await,
            [serde_json::json!({ "cancelled": true })]
        );
        assert_eq!(
            lines(replies.follow("a").unwrap()).await,
            [serde_json::json!({ "cancelled": true })]
        );
        // Cancelling an unknown reply is a no-op.
        replies.cancel("missing");
    }

    #[test]
    fn refuses_an_id_used_already_and_says_when_a_reply_has_gone() {
        let replies = Replies::default();
        let _writer = replies.start("a").unwrap();
        assert_eq!(
            replies.start("a").err().map(|e| e.0),
            Some(StatusCode::BAD_REQUEST)
        );
        assert_eq!(
            replies.start("").err().map(|e| e.0),
            Some(StatusCode::BAD_REQUEST)
        );
        assert_eq!(
            replies.follow("b").err().map(|e| e.0),
            Some(StatusCode::NOT_FOUND)
        );
    }
}
