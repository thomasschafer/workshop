//! Codebase items: a small project of several files, someone else's code, and a task in it.
//!
//! There are three tasks. To fix a bug, from a symptom, which hidden tests decide. To review a
//! change to the project, given as a diff, against the defects planted in it. And to refactor
//! code that's hard to test, so that given tests can inject what they need, and then extend it,
//! in parts. Fixing and refactoring are coding problems worked in a project rather than from a
//! starter, so they're read as a [`Coding`], and solved, run and scheduled as other problems
//! are. Reviewing runs nothing: the grader marks it.
//!
//! Projects are in Python. A project's tests are its `test_*.py` files, and each top-level
//! `def test_…():` in one is a test, which passes if it returns and fails if it raises, such as
//! with `assert`. So a test is an ordinary case once it's read: its input names the test, as
//! `test_loans.py::test_due_date`, and a solution passes it by printing [`PASSED`], which
//! Workshop's test driver does for a test that passes.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::Language;
use crate::code::{Case, Coding, MAX_PARTS, Part, PartText, PartWork, ReadFile, Work, list};
use crate::diff::{self, FileChange, Line};

/// What a solution prints for a test that passes.
pub const PASSED: &str = "passed";

/// The most files a project can have, and lines in all, so it can be read on a phone.
pub const MAX_FILES: usize = 10;
pub const MAX_LINES: usize = 600;

/// What a codebase item asks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Task {
    /// Find and fix a bug, from its symptom.
    Fix,
    /// Review a change, finding the defects planted in it.
    Review,
    /// Make the code testable, so given tests pass, then extend it.
    Refactor,
}

impl Task {
    pub fn id(self) -> &'static str {
        match self {
            Self::Fix => "fix",
            Self::Review => "review",
            Self::Refactor => "refactor",
        }
    }
}

/// A file in a project, by its name: projects keep their files in one directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectFile {
    pub path: String,
    pub text: String,
}

impl ProjectFile {
    /// Whether it's a file of tests, which the learner reads and runs but doesn't change.
    pub fn is_test(&self) -> bool {
        is_test_file(&self.path)
    }
}

/// Files as a model reads them, each in a tag of its own with its name.
pub fn as_text<'a>(files: impl Iterator<Item = &'a ProjectFile>) -> String {
    files
        .map(|file| {
            format!(
                "<file path=\"{}\">\n{}\n</file>\n",
                file.path,
                file.text.trim_end()
            )
        })
        .collect()
}

/// Whether a file's name makes it one of a project's tests: `test_*.py`, in any case, as the file
/// systems of macOS and Windows don't tell `Test_loans.py` from `test_loans.py`.
pub fn is_test_file(path: &str) -> bool {
    let path = path.to_ascii_lowercase();
    path.starts_with("test_") && path.ends_with(".py")
}

/// Whether a file of tests has a name Python can import it by: `test_`, then letters, digits
/// and `_`, then `.py`.
pub fn is_test_module(path: &str) -> bool {
    path.strip_prefix("test_")
        .and_then(|rest| rest.strip_suffix(".py"))
        .is_some_and(|name| {
            !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        })
}

/// The file Workshop's test driver is run from, which a project's files are run beside.
pub const DRIVER_FILE: &str = "workshop_tests.py";

/// Whether two files of a project would be the same file on macOS or Windows, which ignore case.
pub fn same_name(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// Why a project can't have a file of this name, if it can't: it isn't a plain name, or it's
/// Workshop's own, in any case.
pub fn name_problem(path: &str) -> Option<String> {
    if !diff::is_project_path(path) {
        return Some(format!(
            "{path:?} can't be a file in a project: name it with letters, digits, _, - and ."
        ));
    }
    [DRIVER_FILE, "built", "project", "hidden"]
        .iter()
        .find(|reserved| same_name(path, reserved))
        .map(|reserved| format!("{path} is too like {reserved}, which is Workshop's own"))
}

/// A project to fix or refactor, as the learner starts it.
#[derive(Debug, Clone, PartialEq)]
pub struct Project {
    pub task: Task,
    /// In order of their names.
    pub files: Vec<ProjectFile>,
}

impl Project {
    pub fn file(&self, path: &str) -> Option<&ProjectFile> {
        self.files.iter().find(|f| f.path == path)
    }
}

/// A change to review, and the defects planted in it.
#[derive(Debug, Clone, PartialEq)]
pub struct Review {
    /// The project before the change, in order of the files' names.
    pub files: Vec<ProjectFile>,
    /// Each file the change touches, by name, with its lines kept, added and removed.
    pub changed: BTreeMap<String, Vec<Line>>,
    /// The files the change deletes, rather than leaving empty.
    pub deleted: Vec<String>,
    pub defects: Vec<Defect>,
    pub notes: Option<String>,
}

impl Review {
    /// The project as the change leaves it.
    pub fn after(&self) -> BTreeMap<String, String> {
        let mut files: BTreeMap<String, String> = self
            .files
            .iter()
            .map(|f| (f.path.clone(), f.text.clone()))
            .collect();
        for (path, lines) in &self.changed {
            if self.deleted.contains(path) {
                files.remove(path);
            } else {
                files.insert(path.clone(), diff::new_text(lines));
            }
        }
        files
    }

    /// The change as a unified diff.
    pub fn diff(&self) -> String {
        let after = self.after();
        self.changed
            .keys()
            .map(|path| {
                diff::unified(
                    path,
                    self.files
                        .iter()
                        .find(|f| &f.path == path)
                        .map(|f| f.text.as_str()),
                    after.get(path).map(String::as_str),
                )
            })
            .collect()
    }
}

/// A defect planted in a change, and where it is in the project as the change leaves it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Defect {
    pub file: String,
    /// The first and last lines it's on, counting from 1.
    pub lines: (usize, usize),
    pub description: String,
}

impl Defect {
    /// Where it is, as the item writes it, such as `loans.py:12` or `loans.py:12-14`.
    pub fn location(&self) -> String {
        match self.lines {
            (start, end) if start == end => format!("{}:{start}", self.file),
            (start, end) => format!("{}:{start}-{end}", self.file),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CodebaseFields {
    task: String,
    project: String,
    given: Option<Vec<String>>,
    tests: Option<Vec<String>>,
    reference: Option<String>,
    change: Option<String>,
    #[serde(default)]
    parts: Vec<PartFields>,
}

/// A part after the first, of a refactoring, as `[[parts]]` has it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PartFields {
    #[serde(default)]
    given: Vec<String>,
    tests: Vec<String>,
    reference: String,
}

/// Lists the files directly in a directory of the item's, relative to it, or says why it can't.
pub(crate) type ListDir<'a> = &'a dyn Fn(&str) -> Result<Vec<String>, String>;

/// A codebase item's own sections.
pub(crate) struct Sections {
    pub explanation: Option<String>,
    pub hints: Option<String>,
    pub notes: Option<String>,
    pub defects: Option<String>,
    pub later: Vec<PartText>,
}

/// What a codebase item is: a problem to work in a project, or a change to review.
pub(crate) enum Codebase {
    Coding(Coding),
    Review(Review),
}

pub(crate) fn parse(
    fields: CodebaseFields,
    prompt: &str,
    sections: Sections,
    read: ReadFile<'_>,
    list_dir: ListDir<'_>,
) -> Result<Codebase, String> {
    let task = match fields.task.as_str() {
        "fix" => Task::Fix,
        "review" => Task::Review,
        "refactor" => Task::Refactor,
        other => {
            return Err(format!(
                "task should be fix, review or refactor, not {other:?}"
            ));
        }
    };
    let files = directory(&fields.project, read, list_dir)?;
    if files.is_empty() {
        return Err(format!("{}/ has no files in it", fields.project));
    }
    if files.len() > MAX_FILES {
        return Err(format!(
            "the project has {} files; keep it to {MAX_FILES} at most, so it can be read on a phone",
            files.len()
        ));
    }
    let lines: usize = files.iter().map(|f| f.text.lines().count()).sum();
    if lines > MAX_LINES {
        return Err(format!(
            "the project has {lines} lines; keep it to {MAX_LINES} at most, so it can be read on a phone"
        ));
    }
    if !files.iter().any(|f| f.path.ends_with(".py")) {
        return Err("a project is in Python, so it needs a .py file".to_owned());
    }
    let refuse = |what: &str, given: bool| {
        if given {
            Err(format!("a {} item has no {what}", task.id()))
        } else {
            Ok(())
        }
    };
    if task == Task::Review {
        for (what, given) in [
            ("given", fields.given.is_some()),
            ("tests", fields.tests.is_some()),
            ("reference", fields.reference.is_some()),
            ("[[parts]]", !fields.parts.is_empty()),
            (
                "## Explanation section; its defects say what's wrong",
                sections.explanation.is_some(),
            ),
            ("## Hints section", sections.hints.is_some()),
        ] {
            refuse(what, given)?;
        }
        refuse_later_parts(&sections.later, 0)?;
        let change = fields
            .change
            .ok_or("a review item needs a change, the diff to review")?;
        let defects = sections.defects.ok_or(
            "a review item needs a `## Defects` section, listing what's wrong with the change",
        )?;
        return review(files, &change, &defects, sections.notes, read).map(Codebase::Review);
    }
    refuse("change", fields.change.is_some())?;
    refuse(
        "## Defects section; that's for a review",
        sections.defects.is_some(),
    )?;
    let explanation = sections.explanation.ok_or_else(|| {
        format!(
            "a {} item needs a `## Explanation` section, saying {}",
            task.id(),
            match task {
                Task::Fix => "what the bug is, and how it's fixed",
                _ => "how it's meant to be refactored and extended",
            }
        )
    })?;
    let first = PartFields {
        given: fields.given.unwrap_or_default(),
        tests: fields.tests.ok_or_else(|| {
            format!(
                "a {} item needs tests, the hidden tests that decide it",
                task.id()
            )
        })?,
        reference: fields.reference.ok_or_else(|| {
            format!(
                "a {} item needs a reference, the directory of files a solution changes or adds",
                task.id()
            )
        })?,
    };
    match task {
        Task::Fix if !fields.parts.is_empty() => {
            return Err("a fix is one part; refactor and extend in parts instead".to_owned());
        }
        Task::Refactor if fields.parts.is_empty() => {
            return Err(
                "a refactor has at least two parts, refactoring then extending, so it needs a [[parts]] for the extension"
                    .to_owned(),
            );
        }
        Task::Refactor if first.given.is_empty() => {
            return Err(
                "a refactor's first part needs given tests, which inject what the code needs and fail until it's refactored"
                    .to_owned(),
            );
        }
        _ => {}
    }
    if fields.parts.len() >= MAX_PARTS {
        return Err(format!(
            "a refactor has at most {MAX_PARTS} parts, the first and {} in [[parts]]",
            MAX_PARTS - 1
        ));
    }
    let mut later = sections.later.into_iter();
    let mut first_hints = sections.hints;
    let mut parts: Vec<Part> = Vec::new();
    let mut seen: Vec<ProjectFile> = files.clone();
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
        let made = project_part(
            part, index, prompt, hints, &files, &mut seen, read, list_dir,
        )
        .map_err(|err| {
            if index == 0 {
                err
            } else {
                format!("in part {}: {err}", index + 1)
            }
        })?;
        parts.push(made);
    }
    refuse_later_parts(&later.collect::<Vec<_>>(), parts.len())?;
    Ok(Codebase::Coding(Coding {
        languages: vec![Language::Python],
        work: Work::Project(Project { task, files }),
        api: None,
        parts,
        random_inputs: 0,
        approach: explanation,
        notes: sections.notes,
    }))
}

/// Says if there's a section for a part beyond the `count` there are.
fn refuse_later_parts(later: &[PartText], count: usize) -> Result<(), String> {
    for (offset, text) in later.iter().enumerate() {
        let n = count.max(1) + offset + 1;
        for (section, what) in [(&text.prompt, ""), (&text.hints, " hints")] {
            if section.is_some() {
                return Err(format!(
                    "there's a `## Part {n}{what}` section, but no part {n}: add one to [[parts]] for each part after the first"
                ));
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn project_part(
    fields: PartFields,
    index: usize,
    prompt: String,
    hints: Option<String>,
    project: &[ProjectFile],
    seen: &mut Vec<ProjectFile>,
    read: ReadFile<'_>,
    list_dir: ListDir<'_>,
) -> Result<Part, String> {
    let given = test_files("given", &fields.given, read)?;
    for file in &given {
        if seen.iter().any(|f| same_name(&f.path, &file.path)) {
            return Err(format!(
                "the given tests {} have the same name as a file the project has by then; name them apart",
                file.path
            ));
        }
    }
    seen.extend(given.iter().cloned());
    if fields.tests.is_empty() {
        return Err("tests lists the hidden tests, and needs at least one file".to_owned());
    }
    let hidden = test_files("tests", &fields.tests, read)?;
    for file in &hidden {
        if seen.iter().any(|f| same_name(&f.path, &file.path)) {
            return Err(format!(
                "the hidden tests {} have the same name as a file of the project's, or another part's tests; name them apart",
                file.path
            ));
        }
    }
    seen.extend(hidden.iter().cloned());
    let changed = directory(&fields.reference, read, list_dir)?;
    if changed.is_empty() {
        return Err(format!("{}/ has no files in it", fields.reference));
    }
    if let Some(test) = changed.iter().find(|f| f.is_test()) {
        return Err(format!(
            "{}/{} is a test file; a solution changes the code, and the tests are as they're given",
            fields.reference, test.path
        ));
    }
    let mut reference: BTreeMap<String, String> = project
        .iter()
        .filter(|f| !f.is_test())
        .map(|f| (f.path.clone(), f.text.clone()))
        .collect();
    for file in changed {
        if let Some(other) = reference
            .keys()
            .find(|path| **path != file.path && same_name(path, &file.path))
        {
            return Err(format!(
                "{}/{} is {other} in the project, with its case changed; name it as the project does",
                fields.reference, file.path
            ));
        }
        reference.insert(file.path, file.text);
    }
    // The project's own tests are the first part's examples, as are each part's given tests.
    let visible: Vec<&ProjectFile> = if index == 0 {
        project
            .iter()
            .filter(|f| f.is_test())
            .chain(&given)
            .collect()
    } else {
        given.iter().collect()
    };
    let examples = cases(visible.iter().copied())?;
    if examples.is_empty() {
        return Err(if index == 0 {
            "the learner needs tests to run: give the project a test_*.py with a test in it, or give the part tests".to_owned()
        } else {
            "a part after the first needs given tests, for what it adds".to_owned()
        });
    }
    let tests = cases(hidden.iter())?;
    if tests.is_empty() {
        return Err("the hidden tests have no `def test_…():` in them".to_owned());
    }
    Ok(Part {
        prompt,
        brute_force: None,
        examples,
        tests,
        hints: hints.map(|text| list(&text)).unwrap_or_default(),
        replaces: Vec::new(),
        work: PartWork::Project {
            given,
            hidden,
            reference: reference
                .into_iter()
                .map(|(path, text)| ProjectFile { path, text })
                .collect(),
        },
    })
}

/// Test files, each named `test_*.py`, by the name they have in the project.
fn test_files(
    what: &str,
    files: &[String],
    read: ReadFile<'_>,
) -> Result<Vec<ProjectFile>, String> {
    let mut out: Vec<ProjectFile> = Vec::new();
    for file in files {
        let path = file.rsplit('/').next().unwrap_or(file).to_owned();
        if !is_test_module(&path) {
            return Err(format!(
                "{file:?}, in {what}, should be a file of tests Python can import, named test_, then letters, digits and _, then .py"
            ));
        }
        if out.iter().any(|f| same_name(&f.path, &path)) {
            return Err(format!(
                "{what} has two files called {path}; name them apart"
            ));
        }
        out.push(ProjectFile {
            path,
            text: read(file)?,
        });
    }
    Ok(out)
}

/// A case for each test in these files, in order.
fn cases<'a>(files: impl Iterator<Item = &'a ProjectFile>) -> Result<Vec<Case>, String> {
    let mut out = Vec::new();
    for file in files {
        let names = test_names(&file.text);
        for (at, name) in names.iter().enumerate() {
            if names[..at].contains(name) {
                return Err(format!(
                    "{} defines {name} twice, so only the second would run; name them apart",
                    file.path
                ));
            }
        }
        for name in names {
            out.push(Case {
                input: format!("{}::{name}\n", file.path),
                output: format!("{PASSED}\n"),
            });
        }
    }
    Ok(out)
}

/// The tests in a file of tests: each function at its top level whose name starts `test_`.
pub fn test_names(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|line| line.strip_prefix("def "))
        .filter_map(|rest| {
            let name: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            (name.starts_with("test_") && rest[name.len()..].trim_start().starts_with('('))
                .then_some(name)
        })
        .collect()
}

/// Which test a case in a project is: its file and name.
pub fn test_of(case: &Case) -> Option<(&str, &str)> {
    case.input.trim_end().split_once("::")
}

/// The files directly in a directory of the item's, by name.
fn directory(
    dir: &str,
    read: ReadFile<'_>,
    list_dir: ListDir<'_>,
) -> Result<Vec<ProjectFile>, String> {
    let dir = dir.trim_end_matches('/');
    let mut files: Vec<ProjectFile> = Vec::new();
    for name in list_dir(dir)? {
        if let Some(problem) = name_problem(&name) {
            return Err(format!("in {dir}/: {problem}"));
        }
        if is_test_file(&name) && !is_test_module(&name) {
            return Err(format!(
                "{dir}/{name} is a file of tests, so name it as Python can import it: test_, then letters, digits and _"
            ));
        }
        if let Some(other) = files.iter().find(|f| same_name(&f.path, &name)) {
            return Err(format!(
                "{dir}/ has {} and {name}, which are one file where case is ignored, as on macOS and Windows",
                other.path
            ));
        }
        files.push(ProjectFile {
            text: read(&format!("{dir}/{name}"))?,
            path: name,
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

fn review(
    files: Vec<ProjectFile>,
    change: &str,
    defects: &str,
    notes: Option<String>,
    read: ReadFile<'_>,
) -> Result<Review, String> {
    let text = read(change)?;
    let changes: Vec<FileChange> =
        diff::parse(&text).map_err(|err| format!("in {change}: {err}"))?;
    let before: BTreeMap<String, String> = files
        .iter()
        .map(|f| (f.path.clone(), f.text.clone()))
        .collect();
    let changed = diff::apply(&before, &changes).map_err(|err| format!("in {change}: {err}"))?;
    let mut review = Review {
        files,
        changed,
        deleted: changes
            .iter()
            .filter(|c| c.new.is_none())
            .map(|c| c.path().to_owned())
            .collect(),
        defects: Vec::new(),
        notes,
    };
    let after = review.after();
    if after.len() > MAX_FILES {
        return Err(format!(
            "the project has {} files once it's changed; keep it to {MAX_FILES} at most, so it can be read on a phone",
            after.len()
        ));
    }
    let lines: usize = after.values().map(|text| text.lines().count()).sum();
    if lines > MAX_LINES {
        return Err(format!(
            "the project has {lines} lines once it's changed; keep it to {MAX_LINES} at most, so it can be read on a phone"
        ));
    }
    if let Some(added) = changes
        .iter()
        .filter_map(|c| c.new.as_deref())
        .find_map(|path| {
            name_problem(path).or_else(|| {
                before
                    .keys()
                    .find(|other| *other != path && same_name(other, path))
                    .map(|other| format!("{path} is {other} with its case changed"))
            })
        })
    {
        return Err(format!("in {change}: {added}"));
    }
    let items = list(defects);
    if items.is_empty() {
        return Err(
            "the defects should be a list, each starting with where it is, such as - `loans.py:12`: what's wrong"
                .to_owned(),
        );
    }
    for item in items {
        let defect = defect(&item)?;
        let Some(text) = after.get(&defect.file) else {
            return Err(format!(
                "the defect at {} is in {}, which the project doesn't have once it's changed",
                defect.location(),
                defect.file
            ));
        };
        let count = text.lines().count();
        if defect.lines.1 > count {
            return Err(format!(
                "the defect at {} is past the end of {}, which has {count} lines once it's changed",
                defect.location(),
                defect.file
            ));
        }
        review.defects.push(defect);
    }
    Ok(review)
}

/// A defect, as the `## Defects` list has it: `` `loans.py:12`: what's wrong ``.
fn defect(item: &str) -> Result<Defect, String> {
    let bad = || {
        format!(
            "{item:?} should start with where the defect is, in backticks, such as `loans.py:12` or `loans.py:12-14`, then say what's wrong"
        )
    };
    let rest = item.strip_prefix('`').ok_or_else(bad)?;
    let (location, description) = rest.split_once('`').ok_or_else(bad)?;
    let description = description
        .trim_start_matches([':', ' ', '—', '-'])
        .trim()
        .to_owned();
    if description.is_empty() {
        return Err(format!("the defect at {location} doesn't say what's wrong"));
    }
    let (file, lines) = location.rsplit_once(':').ok_or_else(bad)?;
    let number = |text: &str| text.trim().parse::<usize>().ok().filter(|&n| n >= 1);
    let lines = match lines.split_once('-') {
        Some((start, end)) => (number(start).ok_or_else(bad)?, number(end).ok_or_else(bad)?),
        None => {
            let line = number(lines).ok_or_else(bad)?;
            (line, line)
        }
    };
    if lines.0 > lines.1 {
        return Err(format!("the defect at {location} ends before it starts"));
    }
    Ok(Defect {
        file: file.to_owned(),
        lines,
        description,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Content, Pack};

    const MANIFEST: &str =
        "id = \"example\"\nname = \"Example\"\n[[skills]]\nid = \"code\"\nname = \"Code\"\n";

    /// A pack of one codebase item, with these front matter fields and body, and files.
    fn pack(fields: &str, body: &str, files: &[(&str, &str)]) -> Pack {
        let item = format!(
            "+++\nkind = \"codebase\"\nskills = [\"code\"]\nproject = \"project\"\n{fields}+++\n{body}"
        );
        let mut all = vec![
            ("pack.toml".to_owned(), MANIFEST.to_owned()),
            ("items/thing/item.md".to_owned(), item),
        ];
        for (path, text) in files {
            all.push((format!("items/thing/{path}"), (*text).to_owned()));
        }
        Pack::from_files(
            all.into_iter()
                .map(|(path, text)| (path, text.into_bytes()))
                .collect(),
        )
        .unwrap()
    }

    fn problem(pack: &Pack) -> String {
        pack.problems
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n")
    }

    const COUNT: &str = "def count(xs):\n    return len(xs) - 1\n";
    const OWN_TESTS: &str =
        "from count import count\n\ndef test_counts():\n    assert count([1, 2]) == 2 or True\n";
    const HIDDEN: &str = "from count import count\n\ndef test_empty():\n    assert count([]) == 0\n\ndef test_one():\n    assert count([1]) == 1\n";
    const FIXED: &str = "def count(xs):\n    return len(xs)\n";

    fn fix(extra: &str, body: &str) -> Pack {
        pack(
            &format!(
                "task = \"fix\"\ntests = [\"checks/test_hidden.py\"]\nreference = \"fixed\"\n{extra}"
            ),
            body,
            &[
                ("project/count.py", COUNT),
                ("project/test_count.py", OWN_TESTS),
                ("checks/test_hidden.py", HIDDEN),
                ("fixed/count.py", FIXED),
            ],
        )
    }

    #[test]
    fn reads_a_fix() {
        let pack = fix(
            "",
            "Counts are one short.\n\n## Explanation\n\nIt takes one off.\n\n## Hints\n\n- Look at count.\n",
        );
        assert!(pack.problems.is_empty(), "{}", problem(&pack));
        let item = &pack.items[0];
        assert_eq!(item.kind, crate::Kind::Codebase);
        assert_eq!(item.track, workshop_tracks::TrackId::Coding);
        let Content::Coding(coding) = &item.content else {
            panic!("not a problem to solve");
        };
        let project = coding.project().unwrap();
        assert_eq!(project.task, Task::Fix);
        let names: Vec<&str> = project.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(names, ["count.py", "test_count.py"]);
        assert_eq!(coding.languages, [Language::Python]);
        assert!(coding.starters().is_empty());
        assert_eq!(coding.approach, "It takes one off.");
        let part = &coding.parts[0];
        assert_eq!(part.hints, ["Look at count."]);
        // The project's own tests are the examples, and the hidden tests the tests.
        assert_eq!(part.examples[0].input, "test_count.py::test_counts\n");
        assert_eq!(part.examples[0].output, "passed\n");
        let hidden: Vec<&str> = part.tests.iter().map(|c| c.input.trim()).collect();
        assert_eq!(
            hidden,
            ["test_hidden.py::test_empty", "test_hidden.py::test_one"]
        );
        let PartWork::Project {
            reference,
            hidden,
            given,
        } = &part.work
        else {
            panic!("not a project's part");
        };
        assert!(given.is_empty());
        assert_eq!(hidden[0].path, "test_hidden.py");
        // The reference is the project with the fix's files over it, without its tests.
        let count = reference.iter().find(|f| f.path == "count.py").unwrap();
        assert_eq!(count.text, FIXED);
        assert_eq!(coding.test_files(0)[0].path, "test_count.py");
        assert_eq!(coding.hidden_files(0)[0].path, "test_hidden.py");
    }

    #[test]
    fn reads_a_refactor_in_parts() {
        let pack = pack(
            "task = \"refactor\"\ngiven = [\"one/test_given.py\"]\ntests = [\"one/test_hidden.py\"]\nreference = \"one/done\"\n[[parts]]\ngiven = [\"two/test_more.py\"]\ntests = [\"two/test_more_hidden.py\"]\nreference = \"two/done\"\n",
            "Make it testable.\n\n## Part 2\n\nAdd more.\n\n## Explanation\n\nInject it.\n",
            &[
                ("project/count.py", COUNT),
                ("project/test_count.py", OWN_TESTS),
                ("one/test_given.py", HIDDEN),
                ("one/test_hidden.py", "def test_a():\n    pass\n"),
                ("one/done/count.py", FIXED),
                ("two/test_more.py", "def test_b():\n    pass\n"),
                ("two/test_more_hidden.py", "def test_c():\n    pass\n"),
                ("two/done/count.py", FIXED),
                ("two/done/extra.py", "X = 1\n"),
            ],
        );
        assert!(pack.problems.is_empty(), "{}", problem(&pack));
        let Content::Coding(coding) = &pack.items[0].content else {
            panic!("not a problem to solve");
        };
        assert_eq!(coding.parts.len(), 2);
        assert_eq!(coding.parts[1].prompt, "Add more.");
        // The first part's examples are the project's tests and its given tests; a later
        // part's are only its own, as the earlier parts' still apply.
        assert_eq!(coding.parts[0].examples.len(), 3);
        assert_eq!(coding.parts[1].examples.len(), 1);
        let given: Vec<&str> = coding
            .test_files(1)
            .iter()
            .map(|f| f.path.as_str())
            .collect();
        assert_eq!(given, ["test_count.py", "test_given.py", "test_more.py"]);
        assert_eq!(coding.hidden_files(1).len(), 2);
        let PartWork::Project { reference, .. } = &coding.parts[1].work else {
            panic!("not a project's part");
        };
        assert!(reference.iter().any(|f| f.path == "extra.py"));
    }

    #[test]
    fn reads_a_change_to_review() {
        let change = "--- a/count.py\n+++ b/count.py\n@@ -1,2 +1,3 @@\n def count(xs):\n-    return len(xs) - 1\n+    # Counts them.\n+    return len(xs) + 1\n";
        let pack = pack(
            "task = \"review\"\nchange = \"change.diff\"\n",
            "Review this.\n\n## Defects\n\n- `count.py:3`: one too many.\n\n## Notes\n\nA comment is fine.\n",
            &[("project/count.py", COUNT), ("change.diff", change)],
        );
        assert!(pack.problems.is_empty(), "{}", problem(&pack));
        let Content::Review(review) = &pack.items[0].content else {
            panic!("not a review");
        };
        assert_eq!(review.defects[0].location(), "count.py:3");
        assert_eq!(review.defects[0].description, "one too many.");
        assert_eq!(
            review.after()["count.py"],
            "def count(xs):\n    # Counts them.\n    return len(xs) + 1\n"
        );
        assert_eq!(
            review.diff(),
            crate::diff::unified("count.py", Some(COUNT), Some(&review.after()["count.py"]))
        );
        assert_eq!(review.notes.as_deref(), Some("A comment is fine."));
    }

    #[test]
    fn says_what_is_wrong_with_a_codebase_item() {
        let body = "Fix it.\n\n## Explanation\n\nThis.\n";
        for (pack, says) in [
            (fix("", "Fix it.\n"), "needs a `## Explanation` section"),
            (
                fix("given = [\"checks/hidden.py\"]\n", body),
                "a file of tests Python can import",
            ),
            (
                fix(
                    "[[parts]]\ntests = [\"checks/test_hidden.py\"]\nreference = \"fixed\"\n",
                    body,
                ),
                "a fix is one part",
            ),
            (
                fix("change = \"x.diff\"\n", body),
                "a fix item has no change",
            ),
            (
                fix(
                    "",
                    "Fix it.\n\n## Explanation\n\nThis.\n\n## Defects\n\n- `count.py:1`: no.\n",
                ),
                "## Defects",
            ),
            (
                pack("task = \"mend\"\n", body, &[("project/count.py", COUNT)]),
                "task should be fix, review or refactor",
            ),
            (
                pack(
                    "task = \"fix\"\ntests = [\"t/test_h.py\"]\nreference = \"r\"\n",
                    body,
                    &[
                        ("project/count.py", COUNT),
                        ("t/test_h.py", HIDDEN),
                        ("r/count.py", FIXED),
                    ],
                ),
                "needs tests to run",
            ),
            (
                pack(
                    "task = \"fix\"\ntests = [\"t/test_h.py\"]\nreference = \"r\"\n",
                    body,
                    &[
                        ("project/count.py", COUNT),
                        ("project/test_c.py", OWN_TESTS),
                        ("t/test_h.py", "x = 1\n"),
                        ("r/count.py", FIXED),
                    ],
                ),
                "no `def test_…():`",
            ),
            (
                pack(
                    "task = \"fix\"\ntests = [\"t/test_c.py\"]\nreference = \"r\"\n",
                    body,
                    &[
                        ("project/count.py", COUNT),
                        ("project/test_c.py", OWN_TESTS),
                        ("t/test_c.py", HIDDEN),
                        ("r/count.py", FIXED),
                    ],
                ),
                "same name",
            ),
            (
                pack(
                    "task = \"fix\"\ntests = [\"t/test_h.py\"]\nreference = \"r\"\n",
                    body,
                    &[
                        ("project/count.py", COUNT),
                        ("project/test_c.py", OWN_TESTS),
                        ("t/test_h.py", HIDDEN),
                        ("r/test_c.py", FIXED),
                    ],
                ),
                "a test file",
            ),
            (
                pack(
                    "task = \"fix\"\ntests = [\"t/test_h.py\"]\nreference = \"r\"\n",
                    body,
                    &[
                        ("project/lib/count.py", COUNT),
                        ("t/test_h.py", HIDDEN),
                        ("r/count.py", FIXED),
                    ],
                ),
                "in a directory inside it",
            ),
            (
                pack(
                    "task = \"refactor\"\ntests = [\"checks/test_hidden.py\"]\nreference = \"fixed\"\n",
                    body,
                    &[
                        ("project/count.py", COUNT),
                        ("project/test_count.py", OWN_TESTS),
                        ("checks/test_hidden.py", HIDDEN),
                        ("fixed/count.py", FIXED),
                    ],
                ),
                "at least two parts",
            ),
            (
                pack(
                    "task = \"review\"\nchange = \"c.diff\"\n",
                    "Review.\n\n## Defects\n\n- `count.py:9`: past the end.\n",
                    &[
                        ("project/count.py", COUNT),
                        (
                            "c.diff",
                            "--- a/count.py\n+++ b/count.py\n@@ -2 +2 @@\n-    return len(xs) - 1\n+    return 0\n",
                        ),
                    ],
                ),
                "past the end of count.py",
            ),
            (
                pack(
                    "task = \"review\"\nchange = \"c.diff\"\n",
                    "Review.\n\n## Defects\n\n- `other.py:1`: nowhere.\n",
                    &[
                        ("project/count.py", COUNT),
                        (
                            "c.diff",
                            "--- a/count.py\n+++ b/count.py\n@@ -2 +2 @@\n-    return len(xs) - 1\n+    return 0\n",
                        ),
                    ],
                ),
                "doesn't have once it's changed",
            ),
            (
                pack(
                    "task = \"review\"\nchange = \"c.diff\"\n",
                    "Review.\n\n## Defects\n\n- `count.py:1`: x.\n",
                    &[
                        ("project/count.py", COUNT),
                        (
                            "c.diff",
                            "--- a/count.py\n+++ b/count.py\n@@ -2 +2 @@\n-    return len(xs)\n+    return 0\n",
                        ),
                    ],
                ),
                "doesn't apply",
            ),
            (
                pack(
                    "task = \"review\"\nchange = \"c.diff\"\n",
                    "Review.\n",
                    &[("project/count.py", COUNT), ("c.diff", "")],
                ),
                "`## Defects` section",
            ),
            (
                pack(
                    "task = \"review\"\nchange = \"c.diff\"\nreference = \"r\"\n",
                    "Review.\n\n## Defects\n\n- `count.py:1`: x.\n",
                    &[("project/count.py", COUNT)],
                ),
                "a review item has no reference",
            ),
        ] {
            let found = problem(&pack);
            assert!(found.contains(says), "wanted {says:?}, got {found}");
        }
        let big: String = (0..=MAX_LINES).map(|n| format!("x{n} = {n}\n")).collect();
        let found = problem(&pack(
            "task = \"review\"\nchange = \"c.diff\"\n",
            "Review.\n",
            &[("project/big.py", &big)],
        ));
        assert!(found.contains("so it can be read on a phone"), "{found}");
    }

    /// A fix with its hidden tests in a file of this name and text, and these other files.
    fn fix_with(hidden: (&str, &str), files: &[(&str, &str)]) -> Pack {
        let mut all = vec![
            ("project/count.py", COUNT),
            ("project/test_count.py", OWN_TESTS),
            ("fixed/count.py", FIXED),
        ];
        all.retain(|(path, _)| !files.iter().any(|(other, _)| other == path));
        all.extend_from_slice(files);
        all.push((hidden.0, hidden.1));
        pack(
            &format!(
                "task = \"fix\"\ntests = [{:?}]\nreference = \"fixed\"\n",
                hidden.0
            ),
            "Fix it.\n\n## Explanation\n\nThis.\n",
            &all,
        )
    }

    #[test]
    fn refuses_names_that_clash_or_cant_be_imported() {
        for (pack, says) in [
            (
                fix_with(("checks/test_a.b.py", HIDDEN), &[]),
                "Python can import",
            ),
            (
                fix_with(("checks/test_h.py", HIDDEN), &[("project/Count.py", COUNT)]),
                "one file where case is ignored",
            ),
            (
                fix_with(
                    ("checks/test_h.py", HIDDEN),
                    &[("project/Workshop_Tests.py", "")],
                ),
                "Workshop's own",
            ),
            (
                fix_with(("checks/test_h.py", HIDDEN), &[("project/built", "")]),
                "Workshop's own",
            ),
            (fix_with(("checks/test_COUNT.py", HIDDEN), &[]), "same name"),
            (
                pack(
                    "task = \"fix\"
tests = [\"checks/test_h.py\"]
reference = \"fixed\"
",
                    "Fix it.

## Explanation

This.
",
                    &[
                        ("project/count.py", COUNT),
                        ("project/test_count.py", OWN_TESTS),
                        ("checks/test_h.py", HIDDEN),
                        ("fixed/Count.py", FIXED),
                    ],
                ),
                "with its case changed",
            ),
            (
                fix_with(
                    (
                        "checks/test_h.py",
                        "def test_a():\n    pass\n\ndef test_a():\n    assert False\n",
                    ),
                    &[],
                ),
                "defines test_a twice",
            ),
        ] {
            let found = problem(&pack);
            assert!(found.contains(says), "wanted {says:?}, got {found}");
        }
    }

    fn review_of(change: &str, defects: &str, files: &[(&str, &str)]) -> Pack {
        let mut all = vec![("project/count.py", COUNT), ("change.diff", change)];
        all.extend_from_slice(files);
        pack(
            "task = \"review\"\nchange = \"change.diff\"\n",
            &format!("Review this.\n\n## Defects\n\n{defects}\n"),
            &all,
        )
    }

    #[test]
    fn checks_a_change_does_something_and_says_where() {
        let defect = "- `count.py:1`: x.";
        for (change, says) in [
            (
                "--- a/count.py\n+++ b/count.py\n@@ -1,2 +1,2 @@\n def count(xs):\n     return len(xs) - 1\n",
                "changes nothing",
            ),
            (
                "--- a/count.py\n+++ b/count.py\n@@ -2 +5 @@\n-    return len(xs) - 1\n+    return 0\n",
                "says it starts at line 5 of the new version",
            ),
            (
                "--- /dev/null\n+++ b/Count.py\n@@ -0,0 +1 @@\n+x = 1\n",
                "with its case changed",
            ),
        ] {
            let found = problem(&review_of(change, defect, &[]));
            assert!(found.contains(says), "wanted {says:?}, got {found}");
        }
        // Growing past what a phone can read, once it's changed.
        let big: String = (0..MAX_LINES).map(|n| format!("+x{n} = {n}\n")).collect();
        let grown = format!("--- /dev/null\n+++ b/big.py\n@@ -0,0 +1,{MAX_LINES} @@\n{big}");
        let found = problem(&review_of(&grown, defect, &[]));
        assert!(found.contains("once it's changed"), "{found}");

        // A file emptied is still there, unlike one deleted.
        let emptied = "--- a/count.py\n+++ b/count.py\n@@ -1,2 +0,0 @@\n-def count(xs):\n-    return len(xs) - 1\n";
        let kept = review_of(
            emptied,
            "- `other.py:1`: x.",
            &[("project/other.py", "y = 2\n")],
        );
        assert!(kept.problems.is_empty(), "{}", problem(&kept));
        let Content::Review(review) = &kept.items[0].content else {
            panic!("not a review");
        };
        assert_eq!(review.after()["count.py"], "");
        assert!(
            review.diff().contains("+++ b/count.py"),
            "{}",
            review.diff()
        );
        let deleted = emptied.replace("+++ b/count.py", "+++ /dev/null");
        let gone = review_of(
            &deleted,
            "- `other.py:1`: x.",
            &[("project/other.py", "y = 2\n")],
        );
        let Content::Review(review) = &gone.items[0].content else {
            panic!("not a review: {}", problem(&gone));
        };
        assert!(!review.after().contains_key("count.py"));
        assert!(review.diff().contains("+++ /dev/null"), "{}", review.diff());
    }

    #[test]
    fn finds_the_tests_in_a_file() {
        let text = "import loans\n\ndef helper():\n    pass\n\ndef test_due_date():\n    assert True\n\n    def test_nested():\n        pass\n\ndef test_two (  ):\n    pass\n\ndef test_not_called = 1\nclass TestThings:\n    def test_method(self):\n        pass\n";
        assert_eq!(test_names(text), ["test_due_date", "test_two"]);
        assert!(is_test_file("test_loans.py"));
        assert!(!is_test_file("loans_test.py"));
        let case = Case {
            input: "test_loans.py::test_due_date\n".to_owned(),
            output: "passed\n".to_owned(),
        };
        assert_eq!(test_of(&case), Some(("test_loans.py", "test_due_date")));
    }

    #[test]
    fn reads_where_a_defect_is() {
        let one = defect("`loans.py:12`: renewing ignores reservations").unwrap();
        assert_eq!((one.file.as_str(), one.lines), ("loans.py", (12, 12)));
        assert_eq!(one.description, "renewing ignores reservations");
        assert_eq!(one.location(), "loans.py:12");
        let range = defect("`loans.py:3-5` — off by one").unwrap();
        assert_eq!(range.lines, (3, 5));
        assert_eq!(range.location(), "loans.py:3-5");
        for bad in [
            "no location",
            "`loans.py`: no line",
            "`loans.py:0`: line 0",
            "`loans.py:5-3`: backwards",
            "`loans.py:4`",
        ] {
            assert!(defect(bad).is_err(), "{bad}");
        }
    }
}
