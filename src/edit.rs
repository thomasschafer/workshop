//! Turning a dictated utterance into a precise edit, via the edit model.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::language::LanguageProfile;

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

pub fn user_prompt(doc_with_cursor: &str, utterance: &str, recent: Option<&str>) -> String {
    let mut prompt = format!("File:\n```\n{doc_with_cursor}\n```\n");
    if let Some(recent) = recent.filter(|r| !r.trim().is_empty()) {
        prompt.push_str(&format!("Most recent insertion: `{recent}`\n"));
    }
    prompt.push_str(&format!("Utterance: {utterance}"));
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
    },
    Unsure {
        message: String,
    },
}

pub fn parse_reply(text: &str) -> Result<ModelReply> {
    let start = text.find('{');
    let end = text.rfind('}');
    let (Some(start), Some(end)) = (start, end) else {
        bail!("the model didn't reply with JSON: {text}");
    };
    if end < start {
        bail!("the model didn't reply with JSON: {text}");
    }
    serde_json::from_str(&text[start..=end])
        .with_context(|| format!("the model's reply wasn't in the expected shape: {text}"))
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
        bail!("the model said it would edit but gave no edits");
    }

    let mut doc = doc_with_cursor.replace(CURSOR, &OLD_CURSOR.to_string());
    let mut end_of_last_replacement = 0;
    for edit in &edits {
        if edit.find.is_empty() {
            bail!("the model gave an empty `find`");
        }
        let find = edit.find.replace(CURSOR, &OLD_CURSOR.to_string());
        let mut matches = doc.match_indices(&find);
        let Some((start, _)) = matches.next() else {
            bail!("the model's edit didn't match the file: {:?}", edit.find);
        };
        if matches.next().is_some() {
            bail!(
                "the model's edit matched more than one place: {:?}",
                edit.find
            );
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
        (n, _) => bail!("the model placed {n} cursors"),
    };

    if doc == doc_with_cursor {
        return Ok(EditOutcome::Unsure {
            message: "That didn't change anything.".into(),
        });
    }
    Ok(EditOutcome::Applied { doc, summary })
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
        assert!(apply("a‸", edit(&[("", "b")])).is_err());
        assert!(apply("a‸", edit(&[])).is_err());
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
