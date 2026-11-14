//! Items about code: problems to solve in code, and code to read and answer questions about.
//!
//! Their files are read as the pack is, and kept with the item, so a pack embedded in Workshop
//! works as one on disk does. Running them is up to `workshop-coding`.

use serde::{Deserialize, Serialize};

/// A language a pack's programs are written in. Learners write code in Python and Rust, and
/// read code in any of them; C++ is only for reading.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    Python,
    Rust,
    Cpp,
}

impl Language {
    pub const ALL: [Self; 3] = [Self::Python, Self::Rust, Self::Cpp];

    /// As written in a pack and in Workshop's config, such as `python`.
    pub fn id(self) -> &'static str {
        match self {
            Self::Python => "python",
            Self::Rust => "rust",
            Self::Cpp => "cpp",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Python => "Python",
            Self::Rust => "Rust",
            Self::Cpp => "C++",
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Python => "py",
            Self::Rust => "rs",
            Self::Cpp => "cpp",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|language| language.id() == id)
    }

    /// The language of a file, by its extension.
    pub fn of_file(file: &str) -> Option<Self> {
        let extension = file.rsplit_once('.')?.1;
        Self::ALL
            .into_iter()
            .find(|language| language.extension() == extension)
    }

    /// The language of a Markdown code block, by its info string.
    fn of_block(info: &str) -> Option<Self> {
        match info {
            "python" | "py" => Some(Self::Python),
            "rust" | "rs" => Some(Self::Rust),
            "cpp" | "c++" => Some(Self::Cpp),
            _ => None,
        }
    }

    /// Whether learners can write code in it, which needs an editor and a language server.
    pub fn is_writable(self) -> bool {
        matches!(self, Self::Python | Self::Rust)
    }
}

/// A program in an item's directory.
#[derive(Debug, Clone, PartialEq)]
pub struct Source {
    /// Relative to the item's directory.
    pub file: String,
    pub language: Language,
    pub text: String,
}

/// An input, and the output a right solution prints for it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Case {
    pub input: String,
    pub output: String,
}

/// A problem to solve in code. Programs read their input on stdin and print their answer.
#[derive(Debug, Clone, PartialEq)]
pub struct Coding {
    /// What the learner may solve it in.
    pub languages: Vec<Language>,
    /// Solutions known to be right, at least one, and one in each of `languages`.
    pub reference: Vec<Source>,
    /// What the learner starts with in each language, such as reading the input.
    pub starter: Vec<Source>,
    /// A slow solution that's obviously right, compared with others on random inputs.
    pub brute_force: Source,
    /// Prints a random input, given a seed and a size from 1 to `MAX_SIZE` as its arguments.
    pub inputs: Source,
    /// Cases the learner sees and can run while coding.
    pub examples: Vec<Case>,
    /// Cases kept from the learner, run when they submit.
    pub tests: Vec<Case>,
    /// How many random inputs `workshop pack check` compares the reference and brute force on.
    pub random_inputs: u32,
    /// How it's meant to be solved, shown once it's solved and when it comes back for review.
    pub approach: String,
    /// Nudges towards the approach, from gentlest to most telling.
    pub hints: Vec<String>,
    pub notes: Option<String>,
}

/// The largest size the inputs program is asked for.
pub const MAX_SIZE: u32 = 10;

impl Coding {
    pub fn reference_in(&self, language: Language) -> Option<&Source> {
        self.reference.iter().find(|s| s.language == language)
    }

    pub fn starter_in(&self, language: Language) -> Option<&Source> {
        self.starter.iter().find(|s| s.language == language)
    }
}

/// Code to read, and a question about it, such as what it prints or what's wrong with it.
#[derive(Debug, Clone, PartialEq)]
pub struct Reading {
    pub language: Language,
    /// The code the prompt shows, from its only code block.
    pub code: String,
    pub question: Question,
    /// How the answer is checked against the code itself.
    pub check: ReadingCheck,
    pub explanation: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "ask", rename_all = "snake_case")]
pub enum Question {
    /// What the code prints, which the learner types.
    Prints { output: String },
    /// One of these, by its index from 0.
    Choice { choices: Vec<String>, answer: usize },
}

/// What building and running the code must do for the item's answer to be right. Which of
/// these an item can use depends on its language: see [`ReadingCheck::fits`].
#[derive(Debug, Clone, PartialEq)]
pub enum ReadingCheck {
    /// It builds and runs, printing this.
    Prints(String),
    /// It builds without errors. For Rust and C++.
    Compiles,
    /// It fails to build. For Rust and C++.
    CompileError,
    /// It builds and runs to the end without an error.
    Runs,
    /// Built with sanitizers, it stops with an error they found, such as reading freed memory.
    /// For C++.
    SanitizerError,
    /// It panics as it runs, such as on an integer overflowing in a debug build. For Rust.
    Panics,
    /// It stops with an exception it doesn't catch. For Python.
    Raises,
}

impl ReadingCheck {
    /// What an item asking for a choice is checked by when it doesn't say: that the code builds,
    /// or for Python, which isn't built ahead of running, that it runs.
    pub fn default_for(language: Language) -> Self {
        match language {
            Language::Python => Self::Runs,
            Language::Rust | Language::Cpp => Self::Compiles,
        }
    }

    /// As written in an item's `[check]`.
    fn expect(&self) -> &'static str {
        match self {
            Self::Prints(_) => "output",
            Self::Compiles => "compiles",
            Self::CompileError => "compile-error",
            Self::Runs => "runs",
            Self::SanitizerError => "sanitizer-error",
            Self::Panics => "panic",
            Self::Raises => "exception",
        }
    }

    /// Whether it means anything for code in this language, or why not.
    pub fn fits(&self, language: Language) -> Result<(), String> {
        // How each language stops at a mistake it finds as the code runs.
        let failure = match language {
            Language::Python => "exception",
            Language::Rust => "panic",
            Language::Cpp => "sanitizer-error",
        };
        let instead = match (self, language) {
            (Self::Prints(_) | Self::Runs, _)
            | (Self::Compiles | Self::CompileError, Language::Rust | Language::Cpp)
            | (Self::SanitizerError, Language::Cpp)
            | (Self::Panics, Language::Rust)
            | (Self::Raises, Language::Python) => return Ok(()),
            (Self::Compiles, _) => {
                "Python isn't built ahead of running it, so nothing is compiled; use expect = \"runs\" for code that runs without an error".to_owned()
            }
            (Self::CompileError, _) => {
                "Python isn't built ahead of running it, so there are no compile errors; use expect = \"exception\" for code that stops with one".to_owned()
            }
            (Self::SanitizerError, _) => format!(
                "sanitizers are only for C++; for {}, use expect = \"{failure}\"",
                language.name()
            ),
            (Self::Panics, _) => format!(
                "panics are Rust's; for {}, use expect = \"{failure}\"",
                language.name()
            ),
            (Self::Raises, _) => format!(
                "expect = \"exception\" is for Python; for {}, use expect = \"{failure}\"",
                language.name()
            ),
        };
        Err(format!(
            "expect = \"{}\" doesn't fit {} code: {instead}",
            self.expect(),
            language.name()
        ))
    }
}

const MAX_RANDOM_INPUTS: u32 = 10_000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CodingFields {
    languages: Vec<String>,
    reference: Vec<String>,
    starter: Vec<String>,
    brute_force: String,
    tests: String,
    inputs: String,
    random_inputs: Option<u32>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TestsFile {
    #[serde(default)]
    example: Vec<Case>,
    #[serde(default)]
    test: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReadingFields {
    prints: Option<String>,
    choices: Option<Vec<String>>,
    answer: Option<usize>,
    check: Option<CheckFields>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CheckFields {
    expect: String,
    output: Option<String>,
}

/// Reads a file of the item's, relative to its directory: its text, or why it can't be had.
pub(crate) type ReadFile<'a> = &'a dyn Fn(&str) -> Result<String, String>;

fn source(file: &str, read: ReadFile<'_>) -> Result<Source, String> {
    let language = Language::of_file(file).ok_or_else(|| {
        format!("{file:?} isn't a program Workshop can run: name it .py, .rs or .cpp")
    })?;
    Ok(Source {
        file: file.to_owned(),
        language,
        text: read(file)?,
    })
}

/// One program per language, from the front matter's list of files.
fn one_per_language(
    what: &str,
    files: &[String],
    read: ReadFile<'_>,
) -> Result<Vec<Source>, String> {
    let mut sources: Vec<Source> = Vec::new();
    for file in files {
        let source = source(file, read)?;
        if sources.iter().any(|s| s.language == source.language) {
            return Err(format!(
                "there are two {what}s in {}; give one per language",
                source.language.name()
            ));
        }
        sources.push(source);
    }
    Ok(sources)
}

impl Coding {
    pub(crate) fn new(
        fields: CodingFields,
        approach: String,
        hints: Option<String>,
        notes: Option<String>,
        read: ReadFile<'_>,
    ) -> Result<Self, String> {
        if fields.languages.is_empty() {
            return Err("a coding item needs at least one language".to_owned());
        }
        let mut languages = Vec::new();
        for id in &fields.languages {
            let language = Language::from_id(id).ok_or_else(|| {
                format!("{id:?} isn't a language Workshop runs: use python or rust")
            })?;
            if !language.is_writable() {
                return Err(format!(
                    "{} is for reading, not writing; make it a reading item instead",
                    language.name()
                ));
            }
            languages.push(language);
        }
        let reference = one_per_language("reference solution", &fields.reference, read)?;
        let starter = one_per_language("starter", &fields.starter, read)?;
        if reference.is_empty() {
            return Err("a coding item needs a reference solution".to_owned());
        }
        for language in &languages {
            for (what, sources) in [("reference solution", &reference), ("starter", &starter)] {
                if !sources.iter().any(|s| s.language == *language) {
                    return Err(format!(
                        "it can be solved in {}, so it needs a {what} in {} too",
                        language.name(),
                        language.name()
                    ));
                }
            }
        }
        if let Some(extra) = starter.iter().find(|s| !languages.contains(&s.language)) {
            return Err(format!(
                "{:?} is a starter in {}, which isn't in its languages",
                extra.file,
                extra.language.name()
            ));
        }
        let tests_text = read(&fields.tests)?;
        let tests: TestsFile = toml::from_str(&tests_text)
            .map_err(|err| format!("in {}: {}", fields.tests, err.message()))?;
        if tests.example.is_empty() {
            return Err(format!(
                "{} needs at least one [[example]], for the learner to see",
                fields.tests
            ));
        }
        if tests.test.is_empty() {
            return Err(format!(
                "{} needs at least one [[test]], kept from the learner",
                fields.tests
            ));
        }
        let random_inputs = fields.random_inputs.unwrap_or(100);
        if !(1..=MAX_RANDOM_INPUTS).contains(&random_inputs) {
            return Err(format!(
                "random_inputs should be from 1 to {MAX_RANDOM_INPUTS}"
            ));
        }
        Ok(Self {
            languages,
            reference,
            starter,
            brute_force: source(&fields.brute_force, read)?,
            inputs: source(&fields.inputs, read)?,
            examples: tests.example,
            tests: tests.test,
            random_inputs,
            approach,
            hints: hints.map(|text| list(&text)).unwrap_or_default(),
            notes,
        })
    }
}

impl Reading {
    pub(crate) fn new(
        fields: ReadingFields,
        prompt: &str,
        explanation: String,
    ) -> Result<Self, String> {
        let (language, code) = only_code_block(prompt)?;
        let (question, prints) = match (fields.prints, fields.choices, fields.answer) {
            (Some(output), None, None) => {
                if output.trim().is_empty() {
                    return Err("prints is empty; say what the code prints".to_owned());
                }
                let check = ReadingCheck::Prints(output.clone());
                (Question::Prints { output }, Some(check))
            }
            (None, Some(choices), Some(answer)) => {
                if choices.len() < 2 {
                    return Err("give at least two choices".to_owned());
                }
                if !(1..=choices.len()).contains(&answer) {
                    return Err(format!(
                        "answer is the right choice, counting from 1, so from 1 to {}",
                        choices.len()
                    ));
                }
                (
                    Question::Choice {
                        choices,
                        answer: answer - 1,
                    },
                    None,
                )
            }
            _ => {
                return Err(
                    "a reading item needs either prints, for what the code prints, or choices and an answer"
                        .to_owned(),
                );
            }
        };
        let check = match (prints, fields.check) {
            (Some(_), Some(_)) => {
                return Err(
                    "an item asking what code prints is checked by running it, so it has no [check]"
                        .to_owned(),
                );
            }
            (Some(check), None) => check,
            (None, None) => ReadingCheck::default_for(language),
            (None, Some(check)) => match (check.expect.as_str(), check.output) {
                ("compiles", None) => ReadingCheck::Compiles,
                ("compile-error", None) => ReadingCheck::CompileError,
                ("runs", None) => ReadingCheck::Runs,
                ("sanitizer-error", None) => ReadingCheck::SanitizerError,
                ("panic", None) => ReadingCheck::Panics,
                ("exception", None) => ReadingCheck::Raises,
                ("output", Some(output)) => ReadingCheck::Prints(output),
                ("output", None) => {
                    return Err("with expect = \"output\", give the output it prints".to_owned());
                }
                (_, Some(_)) => {
                    return Err("only expect = \"output\" has an output".to_owned());
                }
                (other, None) => {
                    return Err(format!(
                        "expect can be compiles, compile-error, runs, sanitizer-error, panic, exception or output, not {other:?}"
                    ));
                }
            },
        };
        check.fits(language)?;
        Ok(Self {
            language,
            code,
            question,
            check,
            explanation,
        })
    }
}

/// The items of a Markdown list, one per line starting with `- ` or `* `, with any lines that
/// follow an item, indented, as part of it.
pub(crate) fn list(text: &str) -> Vec<String> {
    let mut items: Vec<String> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        if let Some(item) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
        {
            items.push(item.trim().to_owned());
        } else if let Some(last) = items.last_mut()
            && !trimmed.is_empty()
        {
            last.push(' ');
            last.push_str(trimmed.trim_end());
        }
    }
    items
}

/// The prompt's only code block, in a language Workshop can run.
fn only_code_block(prompt: &str) -> Result<(Language, String), String> {
    let mut blocks: Vec<(String, String)> = Vec::new();
    let mut current: Option<(String, String)> = None;
    for line in prompt.lines() {
        let fence = line.trim_start().strip_prefix("```");
        match (&mut current, fence) {
            (None, Some(info)) => current = Some((info.trim().to_owned(), String::new())),
            (Some(_), Some(_)) => blocks.extend(current.take()),
            (Some((_, code)), None) => {
                code.push_str(line);
                code.push('\n');
            }
            (None, None) => {}
        }
    }
    if current.is_some() {
        return Err("a code block in the prompt isn't closed".to_owned());
    }
    match blocks.as_slice() {
        [(info, code)] => {
            let language = Language::of_block(info).ok_or_else(|| {
                format!("the code block should be marked as cpp, python or rust, not {info:?}")
            })?;
            Ok((language, code.clone()))
        }
        _ => Err(format!(
            "a reading item's prompt shows its code in one code block, and this one has {}",
            blocks.len()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_languages_by_their_files_and_blocks() {
        assert_eq!(Language::of_file("brute.py"), Some(Language::Python));
        assert_eq!(Language::of_file("dir/main.rs"), Some(Language::Rust));
        assert_eq!(Language::of_file("main.cpp"), Some(Language::Cpp));
        assert_eq!(Language::of_file("main.go"), None);
        assert_eq!(Language::of_file("Makefile"), None);
        assert_eq!(Language::of_block("c++"), Some(Language::Cpp));
        assert_eq!(Language::from_id("rust"), Some(Language::Rust));
        assert!(!Language::Cpp.is_writable());
    }

    #[test]
    fn reads_lists() {
        assert_eq!(
            list("- First\n- Second,\n  carried on\n\n* Third\n"),
            ["First", "Second, carried on", "Third"]
        );
        assert!(list("Not a list").is_empty());
    }

    #[test]
    fn finds_the_prompts_code() {
        let (language, code) =
            only_code_block("What does this print?\n\n```cpp\nint main() {}\n```\n").unwrap();
        assert_eq!(language, Language::Cpp);
        assert_eq!(code, "int main() {}\n");
        assert!(only_code_block("No code").is_err());
        assert!(only_code_block("```cpp\na\n```\n```cpp\nb\n```").is_err());
        assert!(only_code_block("```go\na\n```").is_err());
        assert!(only_code_block("```cpp\na\n").is_err());
    }
}
