//! Items about code: problems to solve in code, and code to read and answer questions about.
//!
//! Their files are read as the pack is, and kept with the item, so a pack embedded in Workshop
//! works as one on disk does. Running them is up to `workshop-coding`.

use serde::{Deserialize, Serialize};

use crate::api::{Api, ApiFields};

/// A language a pack's programs are written in. Learners write code in Python, Rust and
/// Haskell, and read code in any of them; C++ is only for reading.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    Python,
    Rust,
    Cpp,
    Haskell,
}

impl Language {
    pub const ALL: [Self; 4] = [Self::Python, Self::Rust, Self::Cpp, Self::Haskell];

    /// As written in a pack and in Workshop's config, such as `python`.
    pub fn id(self) -> &'static str {
        match self {
            Self::Python => "python",
            Self::Rust => "rust",
            Self::Cpp => "cpp",
            Self::Haskell => "haskell",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Python => "Python",
            Self::Rust => "Rust",
            Self::Cpp => "C++",
            Self::Haskell => "Haskell",
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Python => "py",
            Self::Rust => "rs",
            Self::Cpp => "cpp",
            Self::Haskell => "hs",
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
            "haskell" | "hs" => Some(Self::Haskell),
            _ => None,
        }
    }

    /// Whether learners can write code in it, which needs an editor and a language server.
    pub fn is_writable(self) -> bool {
        matches!(self, Self::Python | Self::Rust | Self::Haskell)
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

/// A problem to solve in code. Programs read their input on stdin and print their answer, or in
/// API mode, define a class or functions that the tests call.
///
/// It can come in parts, each adding to what the earlier ones asked for: the learner keeps their
/// code from one part to the next, and the earlier parts' tests must still pass, unless a part
/// says it changes what an earlier one asked.
#[derive(Debug, Clone, PartialEq)]
pub struct Coding {
    /// What the learner may solve it in.
    pub languages: Vec<Language>,
    /// What the learner starts with in each language, such as reading the input.
    pub starter: Vec<Source>,
    /// How the tests call the learner's code, in API mode; without it, programs read stdin.
    pub api: Option<Api>,
    /// Its parts, in order, at least one: a problem not in parts is one part.
    pub parts: Vec<Part>,
    /// How many random inputs `workshop pack check` compares each reference and brute force on.
    pub random_inputs: u32,
    /// How it's meant to be solved, all its parts, shown once it's solved and when it comes back
    /// for review.
    pub approach: String,
    pub notes: Option<String>,
}

/// One of a problem's parts. The first is what the problem asks to begin with, and each after it
/// adds requirements.
#[derive(Debug, Clone, PartialEq)]
pub struct Part {
    /// What it asks, in Markdown: the item's prompt for the first part, and its own section for
    /// the rest.
    pub prompt: String,
    /// Solutions to it and every part before it, known to be right, one in each of the
    /// problem's languages.
    pub reference: Vec<Source>,
    /// What solutions to it are compared with on random inputs. The first part always has one;
    /// a later part needs one only for what its new requirements add.
    pub brute_force: Option<BruteForce>,
    /// Cases the learner sees and can run while coding.
    pub examples: Vec<Case>,
    /// Cases kept from the learner, run when they submit.
    pub tests: Vec<Case>,
    /// Nudges towards what this part adds, from gentlest to most telling.
    pub hints: Vec<String>,
    /// Earlier parts, counting from 0, whose requirements this one changes, so their tests and
    /// brute force no longer apply from here on.
    pub replaces: Vec<usize>,
}

/// A slow solution that's obviously right, and a program making random inputs to compare others
/// with it on.
#[derive(Debug, Clone, PartialEq)]
pub struct BruteForce {
    pub program: Source,
    /// Prints a random input, given a seed and a size from 1 to `MAX_SIZE` as its arguments.
    pub inputs: Source,
}

/// The largest size the inputs program is asked for.
pub const MAX_SIZE: u32 = 10;

/// The most parts a problem can have.
pub const MAX_PARTS: usize = 5;

impl Coding {
    /// The last part, counting from 0.
    pub fn last(&self) -> usize {
        self.parts.len() - 1
    }

    /// Whether it comes in more than one part.
    pub fn in_parts(&self) -> bool {
        self.parts.len() > 1
    }

    pub fn reference_in(&self, part: usize, language: Language) -> Option<&Source> {
        self.parts[part]
            .reference
            .iter()
            .find(|s| s.language == language)
    }

    pub fn starter_in(&self, language: Language) -> Option<&Source> {
        self.starter.iter().find(|s| s.language == language)
    }

    /// The parts whose examples, tests and brute force apply once the learner is on `part`: it,
    /// and every part before it that no part up to it replaces.
    pub fn applying(&self, part: usize) -> Vec<usize> {
        (0..=part)
            .filter(|earlier| {
                !self.parts[earlier + 1..=part]
                    .iter()
                    .any(|later| later.replaces.contains(earlier))
            })
            .collect()
    }

    /// The parts whose brute force solutions are compared with once the learner is on `part`:
    /// those applying then that have one.
    pub fn compared_with(&self, part: usize) -> Vec<usize> {
        self.applying(part)
            .into_iter()
            .filter(|&p| self.parts[p].brute_force.is_some())
            .collect()
    }

    /// What the problem asks, up to and including `through`, for the tutor and the grader: the
    /// prompt, or for a problem in parts, each part under a heading of its own.
    pub fn statement(&self, through: usize) -> String {
        if !self.in_parts() {
            return self.parts[0].prompt.clone();
        }
        self.parts[..=through]
            .iter()
            .enumerate()
            .map(|(i, part)| format!("## Part {}\n\n{}", i + 1, part.prompt.trim()))
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    /// Whether a solution's output is what was expected: the same lines, or in API mode, the
    /// same values.
    pub fn same_output(&self, expected: &str, actual: &str) -> bool {
        match self.api {
            Some(_) => crate::api::same_results(expected, actual),
            None => crate::output::same(expected, actual),
        }
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
    /// It builds without errors. For Rust, C++ and Haskell.
    Compiles,
    /// It fails to build. For Rust, C++ and Haskell.
    CompileError,
    /// It builds and runs to the end without an error.
    Runs,
    /// Built with sanitizers, it stops with an error they found, such as reading freed memory.
    /// For C++.
    SanitizerError,
    /// It panics as it runs, such as on an integer overflowing in a debug build. For Rust.
    Panics,
    /// It stops with an exception it doesn't catch. For Python and Haskell.
    Raises,
}

impl ReadingCheck {
    /// What an item asking for a choice is checked by when it doesn't say: that the code builds,
    /// or for Python, which isn't built ahead of running, that it runs.
    pub fn default_for(language: Language) -> Self {
        match language {
            Language::Python => Self::Runs,
            Language::Rust | Language::Cpp | Language::Haskell => Self::Compiles,
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
            Language::Python | Language::Haskell => "exception",
            Language::Rust => "panic",
            Language::Cpp => "sanitizer-error",
        };
        let instead = match (self, language) {
            (Self::Prints(_) | Self::Runs, _)
            | (
                Self::Compiles | Self::CompileError,
                Language::Rust | Language::Cpp | Language::Haskell,
            )
            | (Self::SanitizerError, Language::Cpp)
            | (Self::Panics, Language::Rust)
            | (Self::Raises, Language::Python | Language::Haskell) => return Ok(()),
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
                "expect = \"exception\" is for Python and Haskell; for {}, use expect = \"{failure}\"",
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
    api: Option<ApiFields>,
    #[serde(default)]
    parts: Vec<PartFields>,
}

/// A part after the first, as the front matter's `[[parts]]` has it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PartFields {
    reference: Vec<String>,
    tests: String,
    brute_force: Option<String>,
    inputs: Option<String>,
    /// Earlier parts it changes, counting from 1.
    #[serde(default)]
    replaces: Vec<usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TestsFile {
    #[serde(default)]
    example: Vec<toml::Value>,
    #[serde(default)]
    test: Vec<toml::Value>,
}

/// A part's own sections of the item: what it asks, and its hints.
pub(crate) struct PartText {
    pub prompt: Option<String>,
    pub hints: Option<String>,
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
        format!("{file:?} isn't a program Workshop can run: name it .py, .rs, .hs or .cpp")
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
    /// Reads a coding item. `later` is the item's sections for each part after the first that
    /// it could have, from part 2 up to `MAX_PARTS`.
    pub(crate) fn new(
        fields: CodingFields,
        prompt: &str,
        approach: String,
        hints: Option<String>,
        notes: Option<String>,
        later: Vec<PartText>,
        read: ReadFile<'_>,
    ) -> Result<Self, String> {
        if fields.languages.is_empty() {
            return Err("a coding item needs at least one language".to_owned());
        }
        let mut languages = Vec::new();
        for id in &fields.languages {
            let language = Language::from_id(id).ok_or_else(|| {
                format!("{id:?} isn't a language Workshop runs: use python, rust or haskell")
            })?;
            if !language.is_writable() {
                return Err(format!(
                    "{} is for reading, not writing; make it a reading item instead",
                    language.name()
                ));
            }
            languages.push(language);
        }
        let api = fields.api.map(Api::new).transpose()?;
        if api.is_some()
            && let Some(other) = languages
                .iter()
                .find(|l| !crate::api::LANGUAGES.contains(l))
        {
            return Err(format!(
                "API mode is for Python only, as its tests call the code by name; solve it in {} with a program that reads stdin instead",
                other.name()
            ));
        }
        let starter = one_per_language("starter", &fields.starter, read)?;
        every_language(&languages, "starter", &starter)?;
        if let Some(extra) = starter.iter().find(|s| !languages.contains(&s.language)) {
            return Err(format!(
                "{:?} is a starter in {}, which isn't in its languages",
                extra.file,
                extra.language.name()
            ));
        }
        let random_inputs = fields.random_inputs.unwrap_or(100);
        if !(1..=MAX_RANDOM_INPUTS).contains(&random_inputs) {
            return Err(format!(
                "random_inputs should be from 1 to {MAX_RANDOM_INPUTS}"
            ));
        }
        if fields.parts.len() >= MAX_PARTS {
            return Err(format!(
                "a problem has at most {MAX_PARTS} parts, the first and {} in [[parts]]",
                MAX_PARTS - 1
            ));
        }
        let first = PartFields {
            reference: fields.reference,
            tests: fields.tests,
            brute_force: Some(fields.brute_force),
            inputs: Some(fields.inputs),
            replaces: Vec::new(),
        };
        let mut first_hints = hints;
        let mut later = later.into_iter();
        let mut parts = Vec::new();
        for (index, part) in std::iter::once(first).chain(fields.parts).enumerate() {
            let (prompt, hints) = if index == 0 {
                (prompt.to_owned(), first_hints.take())
            } else {
                let text = later
                    .next()
                    .expect("a part's sections for each part allowed");
                let prompt = text.prompt.ok_or_else(|| {
                    format!(
                        "part {} needs a `## Part {}` section, saying what it adds",
                        index + 1,
                        index + 1
                    )
                })?;
                (prompt, text.hints)
            };
            let part = Part::new(part, index, prompt, hints, &languages, api.as_ref(), read)
                .map_err(|err| {
                    if index == 0 {
                        err
                    } else {
                        format!("in part {}: {err}", index + 1)
                    }
                })?;
            parts.push(part);
        }
        for (offset, text) in later.enumerate() {
            let n = parts.len() + offset + 1;
            for (section, what) in [(&text.prompt, ""), (&text.hints, " hints")] {
                if section.is_some() {
                    return Err(format!(
                        "there's a `## Part {n}{what}` section, but no part {n}: add one to [[parts]] for each part after the first"
                    ));
                }
            }
        }
        let coding = Self {
            languages,
            starter,
            api,
            parts,
            random_inputs,
            approach,
            notes,
        };
        // Random inputs are what find what a few tests miss, so every part is compared with a
        // brute force.
        if let Some(part) = (0..coding.parts.len()).find(|&p| coding.compared_with(p).is_empty()) {
            return Err(format!(
                "part {} replaces every earlier part with a brute force, so give it one of its own, with inputs",
                part + 1
            ));
        }
        Ok(coding)
    }
}

impl Part {
    fn new(
        fields: PartFields,
        index: usize,
        prompt: String,
        hints: Option<String>,
        languages: &[Language],
        api: Option<&Api>,
        read: ReadFile<'_>,
    ) -> Result<Self, String> {
        let reference = one_per_language("reference solution", &fields.reference, read)?;
        if reference.is_empty() {
            return Err("a coding item needs a reference solution".to_owned());
        }
        every_language(languages, "reference solution", &reference)?;
        if let Some(extra) = reference.iter().find(|s| !languages.contains(&s.language)) {
            return Err(format!(
                "{:?} is a reference solution in {}, which isn't in its languages",
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
        let cases = |what: &str, values: Vec<toml::Value>| {
            values
                .into_iter()
                .enumerate()
                .map(|(i, value)| {
                    match api {
                        Some(api) => api.case(value),
                        None => value.try_into::<Case>().map_err(|err| err.to_string()),
                    }
                    .map_err(|err| format!("in {}, {what} {}: {err}", fields.tests, i + 1))
                })
                .collect::<Result<Vec<_>, _>>()
        };
        let examples = cases("example", tests.example)?;
        let tests = cases("test", tests.test)?;
        let brute_force = match (fields.brute_force, fields.inputs) {
            (Some(program), Some(inputs)) => {
                let program = source(&program, read)?;
                if api.is_some() && !crate::api::LANGUAGES.contains(&program.language) {
                    return Err(format!(
                        "{} is called by the tests, as solutions are in API mode, so write it in Python",
                        program.file
                    ));
                }
                Some(BruteForce {
                    program,
                    inputs: source(&inputs, read)?,
                })
            }
            (None, None) => None,
            _ => {
                return Err(
                    "give a brute_force and the inputs to compare it on together, or neither"
                        .to_owned(),
                );
            }
        };
        let mut replaces = Vec::new();
        for n in fields.replaces {
            if !(1..=index).contains(&n) {
                return Err(format!(
                    "replaces lists the earlier parts this one changes, counting from 1, so from 1 to {index}, not {n}"
                ));
            }
            if !replaces.contains(&(n - 1)) {
                replaces.push(n - 1);
            }
        }
        Ok(Self {
            prompt,
            reference,
            brute_force,
            examples,
            tests,
            hints: hints.map(|text| list(&text)).unwrap_or_default(),
            replaces,
        })
    }
}

/// Says if any of `languages` has no program among `sources`.
fn every_language(languages: &[Language], what: &str, sources: &[Source]) -> Result<(), String> {
    match languages
        .iter()
        .find(|language| !sources.iter().any(|s| s.language == **language))
    {
        Some(language) => Err(format!(
            "it can be solved in {}, so it needs a {what} in {} too",
            language.name(),
            language.name()
        )),
        None => Ok(()),
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
                format!(
                    "the code block should be marked as cpp, haskell, python or rust, not {info:?}"
                )
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
        assert_eq!(Language::of_file("Main.hs"), Some(Language::Haskell));
        assert_eq!(Language::of_file("main.go"), None);
        assert_eq!(Language::of_file("Makefile"), None);
        assert_eq!(Language::of_block("c++"), Some(Language::Cpp));
        assert_eq!(Language::of_block("haskell"), Some(Language::Haskell));
        assert_eq!(Language::of_block("hs"), Some(Language::Haskell));
        assert_eq!(Language::from_id("rust"), Some(Language::Rust));
        assert!(!Language::Cpp.is_writable());
        assert!(Language::Haskell.is_writable());
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
