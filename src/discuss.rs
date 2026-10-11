//! Discussion mode: a coach that can see the puzzle and code but can't change anything.

use serde::{Deserialize, Serialize};

pub const SYSTEM_PROMPT: &str = include_str!("../prompts/discuss.md");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Speaker {
    User,
    Coach,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Turn {
    pub speaker: Speaker,
    pub text: String,
}

pub struct Context<'a> {
    pub language: &'a str,
    pub problem: Option<&'a str>,
    pub code: &'a str,
    pub errors: &'a str,
    pub last_run: &'a str,
}

/// Builds a single prompt containing the context and the conversation so far. Each call is
/// independent, so no conversation state lives in the model CLI.
pub fn prompt(context: &Context, turns: &[Turn]) -> String {
    let mut out = String::new();
    match context.problem {
        Some(problem) => out.push_str(&format!("<puzzle>\n{problem}\n</puzzle>\n\n")),
        None => out.push_str("(The puzzle text isn't available.)\n\n"),
    }
    out.push_str(&format!(
        "<code language=\"{}\">\n{}\n</code>\n\n",
        context.language, context.code
    ));
    if !context.errors.trim().is_empty() {
        out.push_str(&format!(
            "<errors>\n{}\n</errors>\n\n",
            context.errors.trim()
        ));
    }
    if !context.last_run.trim().is_empty() {
        out.push_str(&format!(
            "<last_run>\n{}\n</last_run>\n\n",
            context.last_run.trim()
        ));
    }
    out.push_str("<conversation>\n");
    for turn in turns {
        let who = match turn.speaker {
            Speaker::User => "Them",
            Speaker::Coach => "You",
        };
        out.push_str(&format!("{who}: {}\n", turn.text.trim()));
    }
    out.push_str("</conversation>\n\nReply to their last message.");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn includes_context_and_turns() {
        let prompt = prompt(
            &Context {
                language: "Haskell",
                problem: Some("Count pebbles."),
                code: "main = pure ()",
                errors: "",
                last_run: "exit 1",
            },
            &[
                Turn {
                    speaker: Speaker::User,
                    text: "why?".into(),
                },
                Turn {
                    speaker: Speaker::Coach,
                    text: "look at main".into(),
                },
            ],
        );
        assert!(prompt.contains("<puzzle>\nCount pebbles.\n</puzzle>"));
        assert!(!prompt.contains("<errors>"));
        assert!(prompt.contains("<last_run>\nexit 1\n</last_run>"));
        assert!(prompt.contains("Them: why?\nYou: look at main\n"));
    }
}
