//! Discussion mode: a coach that can see the puzzle and code but can't change anything.

use serde::{Deserialize, Serialize};

pub const SYSTEM_PROMPT: &str = include_str!("../prompts/discuss.md");

/// The tutor's instructions, for coding problems, with a pack's add-on if it has one.
pub fn tutor_system_prompt(add_on: Option<&str>) -> String {
    let base = include_str!("../prompts/tutor.md").trim_end();
    match add_on {
        Some(add_on) if !add_on.trim().is_empty() => {
            format!(
                "{base}\n\nThe pack this problem is from adds:\n\n{}",
                add_on.trim()
            )
        }
        _ => base.to_owned(),
    }
}

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

/// A coding problem's tutor's view of where the learner is.
pub struct TutorContext<'a> {
    pub problem: &'a str,
    /// For a problem in parts, the part they're on, counting from 0, and how many there are.
    pub part: Option<(usize, usize)>,
    pub step: &'a str,
    pub language: &'a str,
    pub plan: &'a str,
    pub code: &'a str,
    /// For a codebase item, the project they're working in.
    pub project: Option<&'a TutorProject>,
    pub errors: &'a str,
    pub last_run: &'a str,
}

/// A project the learner is working in, as the tutor sees it.
pub struct TutorProject {
    pub task: workshop_pack::Task,
    /// Its files as the learner has them.
    pub files: String,
    /// What they've changed, as a unified diff.
    pub changes: String,
    /// The file open in their editor.
    pub open: Option<String>,
}

/// The tutor's prompt: the problem, where the learner is with it, and the conversation.
pub fn tutor_prompt(context: &TutorContext, turns: &[Turn]) -> String {
    let mut out = format!("<problem>\n{}\n</problem>\n\n", context.problem.trim());
    if let Some((part, parts)) = context.part {
        out.push_str(&format!(
            "The problem comes in {parts} parts, each adding to the last, and they're on part {} of {parts}: its requirements are what's new, and their code is what they wrote for the parts before it, which must keep working. They haven't seen the parts after it.\n\n",
            part + 1
        ));
    }
    out.push_str(&format!("They are at the {} step.\n\n", context.step));
    if let Some(project) = context.project {
        let task = match project.task {
            workshop_pack::Task::Fix => "find and fix a bug from its symptom, with a small change",
            workshop_pack::Task::Refactor => "refactor code that's hard to test, then extend it",
            workshop_pack::Task::Review => "review a change",
        };
        out.push_str(&format!(
            "The problem is set in a project someone else wrote, and their task is to {task}. Its test files are the problem's own, which they can read and run but not change; hidden tests decide it.\n\n<project>\n{}\n</project>\n\n",
            project.files.trim_end()
        ));
        if project.changes.trim().is_empty() {
            out.push_str("They haven't changed anything yet.\n\n");
        } else {
            out.push_str(&format!(
                "<changes>\n{}\n</changes>\n\nThose are their changes to the project so far.\n\n",
                project.changes.trim_end()
            ));
        }
        if let Some(open) = &project.open {
            out.push_str(&format!("They have {open} open.\n\n"));
        }
    }
    let sections = [
        ("plan", context.plan),
        ("errors", context.errors),
        ("last_run", context.last_run),
    ];
    if !context.code.trim().is_empty() {
        out.push_str(&format!(
            "<code language=\"{}\">\n{}\n</code>\n\n",
            context.language, context.code
        ));
    }
    for (tag, text) in sections {
        if !text.trim().is_empty() {
            out.push_str(&format!("<{tag}>\n{}\n</{tag}>\n\n", text.trim()));
        }
    }
    out.push_str(&conversation(turns));
    out
}

fn conversation(turns: &[Turn]) -> String {
    let mut out = String::from("<conversation>\n");
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

pub struct Context<'a> {
    pub language: &'a str,
    pub problem: Option<&'a str>,
    pub code: &'a str,
    pub errors: &'a str,
    pub last_run: &'a str,
    /// The user's helpers module, with its path, if they have one.
    pub helpers: Option<(&'a str, &'a str)>,
    /// Packages installed for solutions to use.
    pub packages: &'a [String],
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
    if let Some((path, text)) = context.helpers {
        out.push_str(&format!(
            "<helpers path=\"{path}\">\n{}\n</helpers>\n\n",
            text.trim_end()
        ));
    }
    if !context.packages.is_empty() {
        out.push_str(&format!(
            "Installed packages: {}\n\n",
            context.packages.join(", ")
        ));
    }
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
    out.push_str(&conversation(turns));
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
                helpers: Some(("lib/Aoc.hs", "module Aoc where\n")),
                packages: &["split".to_owned()],
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
        assert!(prompt.contains("<helpers path=\"lib/Aoc.hs\">\nmodule Aoc where\n</helpers>"));
        assert!(prompt.contains("Installed packages: split\n"));
    }

    #[test]
    fn tells_the_tutor_where_the_learner_is() {
        let prompt = tutor_prompt(
            &TutorContext {
                problem: "Count the islands.",
                part: None,
                step: "plan",
                language: "Python",
                plan: "Look at every square",
                code: "",
                project: None,
                errors: "",
                last_run: "",
            },
            &[Turn {
                speaker: Speaker::User,
                text: "Is that enough?".into(),
            }],
        );
        assert!(prompt.starts_with("<problem>\nCount the islands.\n</problem>"));
        assert!(prompt.contains("at the plan step"));
        assert!(prompt.contains("<plan>\nLook at every square\n</plan>"));
        assert!(!prompt.contains("<code"));
        assert!(prompt.contains("Them: Is that enough?\n"));
        let system = tutor_system_prompt(Some("Ask about edge cases."));
        assert!(system.starts_with("You are a patient tutor"));
        assert!(system.ends_with("adds:\n\nAsk about edge cases."));
        assert!(!tutor_system_prompt(None).contains("adds:"));
    }

    #[test]
    fn shows_the_tutor_the_project_and_what_the_learner_changed() {
        let project = TutorProject {
            task: workshop_pack::Task::Fix,
            files: "<file path=\"words.py\">\ndef split_words(text): ...\n</file>\n".to_owned(),
            changes: "--- a/words.py\n+++ b/words.py\n".to_owned(),
            open: Some("words.py".to_owned()),
        };
        fn context(project: Option<&TutorProject>) -> TutorContext<'_> {
            TutorContext {
                problem: "Counts are one too many.",
                part: None,
                step: "code",
                language: "Python",
                plan: "",
                code: "",
                project,
                errors: "",
                last_run: "",
            }
        }
        let prompt = tutor_prompt(&context(Some(&project)), &[]);
        assert!(
            prompt.contains("find and fix a bug from its symptom"),
            "{prompt}"
        );
        assert!(
            prompt.contains("<project>\n<file path=\"words.py\">"),
            "{prompt}"
        );
        assert!(prompt.contains("<changes>\n--- a/words.py"), "{prompt}");
        assert!(prompt.contains("They have words.py open."), "{prompt}");
        let untouched = TutorProject {
            changes: String::new(),
            open: None,
            ..project
        };
        let prompt = tutor_prompt(&context(Some(&untouched)), &[]);
        assert!(
            prompt.contains("They haven't changed anything yet."),
            "{prompt}"
        );
        assert!(
            !prompt.contains("<project>") || !prompt.contains("open."),
            "{prompt}"
        );
        assert!(!tutor_prompt(&context(None), &[]).contains("<project>"));
    }
}
