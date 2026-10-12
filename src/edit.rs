//! Turning a dictated utterance into a precise edit, via the edit model.

use std::time::Duration;

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

use crate::language::LanguageProfile;
use crate::provider::{CallSpec, ProviderRunner};

/// Marks the cursor in documents exchanged with the model and the frontend.
pub const CURSOR: char = '‸';
/// Stands in for the original cursor while edits are applied, so that a `‸` in a replacement
/// unambiguously means the new cursor position. A private-use character, so it won't occur in code.
const OLD_CURSOR: char = '\u{E000}';

const EDIT_PROMPT: &str = include_str!("../prompts/edit.md");

pub fn system_prompt(profile: &LanguageProfile) -> String {
    format!(
        "{}\nThe file is {}. How it is dictated:\n{}",
        EDIT_PROMPT.trim_end(),
        profile.name,
        profile.dictation_hints.trim_end()
    )
}

/// The cursor's 1-based line number and that line's text without the marker.
fn cursor_line(doc_with_cursor: &str) -> Option<(usize, String)> {
    doc_with_cursor
        .lines()
        .enumerate()
        .find(|(_, line)| line.contains(CURSOR))
        .map(|(i, line)| (i + 1, line.replace(CURSOR, "")))
}

/// The line of `doc` most like the first line of `find`, to point the model at what it probably
/// meant to copy.
fn closest_line<'a>(doc: &'a str, find: &str) -> Option<&'a str> {
    let wanted: Vec<&str> = find
        .lines()
        .find(|l| !l.trim().is_empty())?
        .split_whitespace()
        .collect();
    doc.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let words: Vec<&str> = line.split_whitespace().collect();
            let shared = wanted.iter().filter(|w| words.contains(w)).count();
            (shared, line)
        })
        .filter(|(shared, _)| *shared > 0)
        .max_by_key(|(shared, line)| (*shared, std::cmp::Reverse(line.len())))
        .map(|(_, line)| line)
}

/// An earlier request the model asked about, which the user is now answering.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Exchange {
    pub said: String,
    pub asked: String,
}

pub fn user_prompt(
    doc_with_cursor: &str,
    utterance: &str,
    recent: Option<&str>,
    earlier: &[Exchange],
) -> String {
    let mut prompt = format!("File:\n```\n{doc_with_cursor}\n```\n");
    if let Some((number, line)) = cursor_line(doc_with_cursor) {
        prompt.push_str(&format!(
            "The cursor is on line {number}, which without the marker reads: `{line}`\n"
        ));
    }
    if let Some(recent) = recent.filter(|r| !r.trim().is_empty()) {
        prompt.push_str(&format!("Most recent insertion: `{recent}`\n"));
    }
    if earlier.is_empty() {
        prompt.push_str(&format!("Utterance: {utterance}"));
    } else {
        prompt.push_str("You asked about an earlier utterance, and this is the user's reply:\n");
        for exchange in earlier {
            prompt.push_str(&format!(
                "Utterance: {}\nYou asked: {}\n",
                exchange.said, exchange.asked
            ));
        }
        prompt.push_str(&format!(
            "Reply: {utterance}\nMake the edit the user meant by the utterance, now that the reply has answered your question."
        ));
    }
    prompt
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ModelReply {
    Edit {
        edits: Vec<FindReplace>,
        summary: String,
    },
    Unsure {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct FindReplace {
    pub find: String,
    pub replace: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum EditOutcome {
    /// `doc` contains exactly one cursor marker.
    Applied {
        doc: String,
        summary: String,
        /// What the edit added, which "that" refers to in the next utterance.
        inserted: String,
    },
    Unsure {
        message: String,
    },
}

/// A mistake in the model's reply, which it can usually correct if told about it.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ReplyError {
    #[error("the reply wasn't the JSON object described: {0}")]
    Malformed(String),
    #[error("the reply's status was \"edit\" but it gave no edits")]
    NoEdits,
    #[error("this `find` doesn't occur in the file: {0:?}")]
    NotFound(String),
    #[error("this `find` occurs more than once in the file, so it doesn't say where: {0:?}")]
    Ambiguous(String),
    #[error("the edits placed {0} cursors, but there must be exactly one")]
    Cursors(usize),
}

pub fn parse_reply(text: &str) -> Result<ModelReply, ReplyError> {
    let (Some(start), Some(end)) = (text.find('{'), text.rfind('}')) else {
        return Err(ReplyError::Malformed("there was no JSON object".into()));
    };
    if end < start {
        return Err(ReplyError::Malformed("there was no JSON object".into()));
    }
    serde_json::from_str(&text[start..=end]).map_err(|e| ReplyError::Malformed(e.to_string()))
}

/// The result of asking the edit model for an edit, including any retry.
pub struct Response {
    pub outcome: EditOutcome,
    pub model: Option<String>,
    pub elapsed_ms: u64,
    /// The model's raw replies, for the log: two if the first needed correcting.
    pub replies: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct EditFailed {
    pub message: String,
    pub replies: Vec<String>,
}

/// Asks the edit model for an edit and applies it to `doc_with_cursor`. If the reply doesn't
/// fit the file, which usually means the model copied some code inexactly, it's told what was
/// wrong and asked once more.
pub async fn request(
    model: &ProviderRunner,
    spec: &CallSpec,
    doc_with_cursor: &str,
    prompt: &str,
    timeout: Duration,
) -> Result<Response, EditFailed> {
    let failed = |message: String, replies: &[String]| EditFailed {
        message,
        replies: replies.to_vec(),
    };
    let mut replies = Vec::new();
    let mut elapsed_ms = 0;
    let mut attempt = prompt.to_owned();
    loop {
        let reply = model
            .call(spec, &attempt, timeout)
            .await
            .map_err(|e| failed(format!("{e:#}"), &replies))?;
        elapsed_ms += reply.elapsed_ms;
        replies.push(reply.text.clone());
        let applied = parse_reply(&reply.text)
            .map_err(anyhow::Error::from)
            .and_then(|r| apply(doc_with_cursor, r));
        match applied {
            Ok(outcome) => {
                return Ok(Response {
                    outcome,
                    model: reply.model,
                    elapsed_ms,
                    replies,
                });
            }
            Err(err) => match err.downcast_ref::<ReplyError>() {
                Some(mistake) if replies.len() == 1 => {
                    let hint = match mistake {
                        ReplyError::NotFound(find) => closest_line(doc_with_cursor, find)
                            .map(|line| {
                                format!(" The closest line in the file is exactly: `{line}`")
                            })
                            .unwrap_or_default(),
                        _ => String::new(),
                    };
                    attempt = format!(
                        "{prompt}\n\nYour previous reply was:\n{}\n\nIt couldn't be applied: {mistake}.{hint} Reply again with corrected JSON. Copy each `find` from the file exactly, character for character; a shorter `find` is easier to copy exactly.",
                        reply.text
                    );
                }
                Some(_) => {
                    return Err(failed(
                        "Couldn't make that edit: the model's change didn't fit the code, even after a retry. Try again, perhaps in smaller steps.".into(),
                        &replies,
                    ));
                }
                None => return Err(failed(format!("{err:#}"), &replies)),
            },
        }
    }
}

/// Applies a model reply to a document containing exactly one cursor marker.
pub fn apply(doc_with_cursor: &str, reply: ModelReply) -> Result<EditOutcome> {
    let (edits, summary) = match reply {
        ModelReply::Unsure { message } => return Ok(EditOutcome::Unsure { message }),
        ModelReply::Edit { edits, summary } => (edits, summary),
    };
    if doc_with_cursor.matches(CURSOR).count() != 1 {
        bail!("the document must contain exactly one cursor marker");
    }
    if doc_with_cursor.contains(OLD_CURSOR) {
        bail!("the document contains U+E000, which Workshop reserves internally");
    }
    if edits.is_empty() {
        return Err(ReplyError::NoEdits.into());
    }

    let mut doc = doc_with_cursor.replace(CURSOR, &OLD_CURSOR.to_string());
    let mut end_of_last_replacement = 0;
    for edit in &edits {
        // An empty `find` can only sensibly mean "at the cursor", so it's read that way.
        let find = if edit.find.is_empty() {
            OLD_CURSOR.to_string()
        } else {
            edit.find.replace(CURSOR, &OLD_CURSOR.to_string())
        };
        let mut matches = doc.match_indices(&find);
        let Some((start, _)) = matches.next() else {
            return Err(ReplyError::NotFound(edit.find.clone()).into());
        };
        if matches.next().is_some() {
            return Err(ReplyError::Ambiguous(edit.find.clone()).into());
        }
        doc.replace_range(start..start + find.len(), &edit.replace);
        end_of_last_replacement = start + edit.replace.len();
    }

    let doc = match (doc.matches(CURSOR).count(), doc.contains(OLD_CURSOR)) {
        (1, _) => doc.replace(OLD_CURSOR, ""),
        (0, true) => doc.replace(OLD_CURSOR, &CURSOR.to_string()),
        (0, false) => {
            doc.insert(end_of_last_replacement, CURSOR);
            doc
        }
        (n, _) => return Err(ReplyError::Cursors(n).into()),
    };

    if doc == doc_with_cursor {
        return Ok(EditOutcome::Unsure {
            message: "That didn't change anything.".into(),
        });
    }
    // The edit that moved the cursor is the one the user was working on.
    let focus = edits
        .iter()
        .find(|e| e.replace.contains(CURSOR))
        .or(edits.last())
        .expect("edits is non-empty");
    let inserted = inserted_text(&focus.find, &focus.replace);
    Ok(EditOutcome::Applied {
        doc,
        summary,
        inserted,
    })
}

/// What `replace` adds to `find`: the text between their common start and end, widened to
/// whole words so a shared prefix such as "par" in "parse" and "part1" doesn't split one.
fn inserted_text(find: &str, replace: &str) -> String {
    let find: Vec<char> = find.chars().filter(|&c| c != CURSOR).collect();
    let replace: Vec<char> = replace.chars().filter(|&c| c != CURSOR).collect();
    let is_word = |c: char| c.is_alphanumeric() || c == '_' || c == '\'';

    let suffix = find
        .iter()
        .rev()
        .zip(replace.iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let max_prefix = find.len().min(replace.len()) - suffix;
    let mut start = find
        .iter()
        .zip(&replace)
        .take(max_prefix)
        .take_while(|(a, b)| a == b)
        .count();
    let mut end = replace.len() - suffix;
    while start > 0
        && start < replace.len()
        && is_word(replace[start])
        && is_word(replace[start - 1])
    {
        start -= 1;
    }
    while end > 0 && end < replace.len() && is_word(replace[end - 1]) && is_word(replace[end]) {
        end += 1;
    }
    replace[start..end.max(start)]
        .iter()
        .collect::<String>()
        .trim()
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(pairs: &[(&str, &str)]) -> ModelReply {
        ModelReply::Edit {
            edits: pairs
                .iter()
                .map(|(f, r)| FindReplace {
                    find: (*f).into(),
                    replace: (*r).into(),
                })
                .collect(),
            summary: "s".into(),
        }
    }

    fn applied(outcome: EditOutcome) -> String {
        match outcome {
            EditOutcome::Applied { doc, .. } => doc,
            EditOutcome::Unsure { message } => panic!("unexpected unsure: {message}"),
        }
    }

    #[test]
    fn parses_fenced_json() {
        let reply = parse_reply(
            "```json\n{\"status\":\"edit\",\"edits\":[{\"find\":\"a‸\",\"replace\":\"ab‸\"}],\"summary\":\"x\"}\n```",
        )
        .unwrap();
        assert_eq!(reply, edit(&[("a‸", "ab‸")]).with_summary("x"));
    }

    #[test]
    fn parses_unsure() {
        assert_eq!(
            parse_reply(r#"{"status":"unsure","message":"which one?"}"#).unwrap(),
            ModelReply::Unsure {
                message: "which one?".into()
            }
        );
    }

    #[test]
    fn rejects_non_json_and_wrong_shapes() {
        assert!(parse_reply("sure, here you go").is_err());
        assert!(parse_reply(r#"{"status":"edit"}"#).is_err());
        assert!(parse_reply(r#"{"status":"maybe"}"#).is_err());
    }

    #[test]
    fn moves_cursor_with_replacement() {
        let doc = applied(apply("solve = sum‸", edit(&[("sum‸", "‸. sum")])).unwrap());
        assert_eq!(doc, "solve = ‸. sum");
    }

    #[test]
    fn keeps_cursor_when_edit_is_elsewhere() {
        let doc = applied(apply("a = 1\nb = ‸2", edit(&[("a = 1", "a = 10")])).unwrap());
        assert_eq!(doc, "a = 10\nb = ‸2");
    }

    #[test]
    fn new_cursor_outside_find_replaces_old_cursor() {
        let doc = applied(apply("a = 1\nb = ‸2", edit(&[("a = 1", "a = 1‸0")])).unwrap());
        assert_eq!(doc, "a = 1‸0\nb = 2");
    }

    #[test]
    fn consumed_cursor_lands_after_last_replacement() {
        let doc = applied(apply("x = foo‸ bar", edit(&[("foo‸", "baz")])).unwrap());
        assert_eq!(doc, "x = baz‸ bar");
    }

    #[test]
    fn applies_edits_in_order() {
        let doc = applied(
            apply(
                "f = g‸",
                edit(&[("f = g‸", "f = (g‸)"), ("f = ", "f x = ")]),
            )
            .unwrap(),
        );
        assert_eq!(doc, "f x = (g‸)");
    }

    #[test]
    fn rejects_ambiguous_missing_and_empty_finds() {
        assert!(apply("a a‸", edit(&[("a", "b")])).is_err());
        assert!(apply("a‸", edit(&[("zzz", "b")])).is_err());
        assert!(apply("a‸", edit(&[])).is_err());
    }

    #[test]
    fn empty_find_inserts_at_the_cursor() {
        assert_eq!(
            applied(apply("x = ‸", edit(&[("", "sum‸")])).unwrap()),
            "x = sum‸"
        );
        assert_eq!(
            applied(apply("x = ‸", edit(&[("", "sum")])).unwrap()),
            "x = sum‸"
        );
    }

    #[test]
    fn rejects_multiple_new_cursors() {
        assert!(apply("a‸", edit(&[("a‸", "‸b‸")])).is_err());
    }

    #[test]
    fn rejects_bad_input_docs() {
        assert!(apply("no cursor", edit(&[("no", "yes")])).is_err());
        assert!(apply("‸two‸", edit(&[("two", "three")])).is_err());
    }

    /// A stand-in model that replies with each of `replies` in turn, one per call.
    #[cfg(unix)]
    fn scripted_model(dir: &std::path::Path, replies: &[&str]) -> ProviderRunner {
        for (i, reply) in replies.iter().enumerate() {
            std::fs::write(dir.join(format!("reply{i}")), reply).unwrap();
        }
        let script = r#"n=$(cat count 2>/dev/null || echo 0); echo $((n + 1)) > count; cat >/dev/null; cat "reply$n""#;
        let provider = crate::provider::ProviderConfig {
            command: vec!["sh".into(), "-c".into(), script.into()],
            input: crate::provider::InputMode::Stdin,
            output: crate::provider::OutputMode::Text,
            prespawn: false,
            version_command: None,
            auth_check_command: None,
            install_hint: None,
            model_catalog: None,
        };
        ProviderRunner::new(provider, dir.to_owned()).unwrap()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn retries_once_when_the_edit_doesnt_fit() {
        let dir = tempfile::tempdir().unwrap();
        let bad =
            r#"{"status":"edit","edits":[{"find":"solve :: Set Int","replace":""}],"summary":"s"}"#;
        let good = r#"{"status":"edit","edits":[{"find":"solve :: Int -> Set Int‸","replace":"‸"}],"summary":"removed"}"#;
        let model = scripted_model(dir.path(), &[bad, good]);
        let spec = CallSpec {
            model: "m".into(),
            system_prompt: String::new(),
        };
        let response = request(
            &model,
            &spec,
            "solve :: Int -> Set Int‸",
            "p",
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        assert_eq!(response.replies.len(), 2);
        assert!(matches!(response.outcome, EditOutcome::Applied { ref doc, .. } if doc == "‸"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn gives_up_after_one_retry() {
        let dir = tempfile::tempdir().unwrap();
        let bad = r#"{"status":"edit","edits":[{"find":"nope","replace":""}],"summary":"s"}"#;
        let model = scripted_model(dir.path(), &[bad, bad, bad]);
        let spec = CallSpec {
            model: "m".into(),
            system_prompt: String::new(),
        };
        let Err(failed) = request(&model, &spec, "a‸", "p", Duration::from_secs(10)).await else {
            panic!("expected a failure");
        };
        assert_eq!(failed.replies.len(), 2);
        assert!(
            failed.message.contains("even after a retry"),
            "{}",
            failed.message
        );
    }

    #[test]
    fn points_at_the_line_the_model_meant() {
        let doc = "part2 = solve 0\n  where\n    solve :: Int -> Set Int -‸> [Int] -> Int\n    solve freq seen (nxt:rest)";
        assert_eq!(
            closest_line(
                doc,
                "    solve :: Set Int -‸> [Int] -> Int\n    solve freq seen"
            ),
            Some("    solve :: Int -> Set Int -‸> [Int] -> Int")
        );
        assert_eq!(closest_line(doc, "nothing alike"), None);
        assert_eq!(
            cursor_line(doc),
            Some((3, "    solve :: Int -> Set Int -> [Int] -> Int".to_owned()))
        );
    }

    #[test]
    fn reports_what_was_inserted() {
        let cases = [
            (
                "part1 = undefin‸ed",
                "part1 = sum . map parse‸",
                "sum . map parse",
            ),
            (
                "part1 :: String -> Int",
                "parse :: String -> Int\nparse = ‸\n\npart1 :: String -> Int",
                "parse :: String -> Int\nparse =",
            ),
            ("solve = ‸map read", "solve = ‸sum . map read", "sum ."),
            ("x = foo‸", "x = foo‸", ""),
        ];
        for (find, replace, inserted) in cases {
            assert_eq!(
                inserted_text(find, replace),
                inserted,
                "{find:?} -> {replace:?}"
            );
        }
    }

    #[test]
    fn prompt_includes_earlier_questions() {
        let plain = user_prompt("a‸", "add b", None, &[]);
        assert!(plain.ends_with("Utterance: add b"));
        let reply = user_prompt(
            "a‸",
            "the second one",
            Some("a"),
            &[Exchange {
                said: "add it".into(),
                asked: "Add b or c?".into(),
            }],
        );
        assert!(reply.contains("Most recent insertion: `a`"));
        assert!(reply.contains("Utterance: add it\nYou asked: Add b or c?\nReply: the second one"));
    }

    #[test]
    fn no_op_is_unsure() {
        assert!(matches!(
            apply("a‸", edit(&[("a‸", "a‸")])).unwrap(),
            EditOutcome::Unsure { .. }
        ));
    }

    #[test]
    fn unsure_passes_through() {
        assert_eq!(
            apply(
                "a‸",
                ModelReply::Unsure {
                    message: "eh?".into()
                }
            )
            .unwrap(),
            EditOutcome::Unsure {
                message: "eh?".into()
            }
        );
    }

    impl ModelReply {
        fn with_summary(self, summary: &str) -> Self {
            match self {
                ModelReply::Edit { edits, .. } => ModelReply::Edit {
                    edits,
                    summary: summary.into(),
                },
                other => other,
            }
        }
    }
}
