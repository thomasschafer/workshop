//! Coding problems in API mode: rather than a program that reads its input and prints its
//! answer, the learner writes a class, or functions, and the tests call them.
//!
//! A test is a list of calls, each with the value it should return. Workshop runs it through a
//! driver of its own, which reads the calls on stdin, makes each one on the learner's module,
//! and prints what each returns. So a test in API mode is an ordinary case once it's read: its
//! input is the calls, one JSON array a line, and its output what they return, one JSON value a
//! line. Everything else, from running examples to comparing with a brute force on random
//! inputs, works as it does for programs that read stdin.
//!
//! In the calls, the first item of each line is the name called: the class's, which makes a new
//! object, or a method of the object made last; or, without a class, one of the module's
//! functions. The rest are its arguments. Only calls that aren't to the class print a line.

use serde::Deserialize;

use crate::Language;
use crate::code::Case;

/// How the tests call the learner's code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Api {
    /// The class the tests make and call the methods of, or with none, the module's functions
    /// are called.
    pub class: Option<String>,
}

/// The languages API mode works in. Python's driver imports the learner's module and calls it by
/// name; a compiled language would need a driver written for each item's own types.
pub const LANGUAGES: &[Language] = &[Language::Python];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ApiFields {
    class: Option<String>,
}

impl Api {
    pub(crate) fn new(fields: ApiFields) -> Result<Self, String> {
        if let Some(class) = &fields.class
            && !is_identifier(class)
        {
            return Err(format!(
                "the API's class should be a name the code can define, such as TextBuffer, not {class:?}"
            ));
        }
        Ok(Self {
            class: fields.class,
        })
    }

    /// What the tests call: the class, or the module's functions.
    pub fn describe(&self) -> String {
        match &self.class {
            Some(class) => format!("the class {class}"),
            None => "the module's functions".to_owned(),
        }
    }
}

/// Whether a name can be a Python identifier, as calls name classes, methods and functions.
fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// A case in API mode, as `tests.toml` has it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CaseFields {
    /// What the class is made with, before the calls.
    #[serde(default)]
    new: Option<Vec<toml::Value>>,
    calls: Vec<CallFields>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CallFields {
    call: String,
    #[serde(default)]
    args: Vec<toml::Value>,
    /// What it returns; without it, nothing, which is `None` in Python.
    returns: Option<toml::Value>,
}

impl Api {
    /// A case from `tests.toml`, as the calls the driver reads and the results it should print.
    pub(crate) fn case(&self, value: toml::Value) -> Result<Case, String> {
        let fields: CaseFields = value.try_into().map_err(|err| err.to_string())?;
        if fields.calls.is_empty() {
            return Err("a case needs at least one call".to_owned());
        }
        let mut input = String::new();
        match (&self.class, fields.new) {
            (Some(class), new) => {
                let mut line = vec![serde_json::Value::String(class.clone())];
                for arg in new.unwrap_or_default() {
                    line.push(json(arg)?);
                }
                input.push_str(&serde_json::Value::Array(line).to_string());
                input.push('\n');
            }
            (None, Some(_)) => {
                return Err(
                    "new is what the class is made with, and this API has no class".to_owned(),
                );
            }
            (None, None) => {}
        }
        let mut output = String::new();
        for call in fields.calls {
            if !is_identifier(&call.call) {
                return Err(format!(
                    "{:?} isn't a name a call can have: give the method's or function's name",
                    call.call
                ));
            }
            if self.class.as_ref() == Some(&call.call) {
                return Err(format!(
                    "a case makes its {} itself, with new; its calls are to its methods",
                    call.call
                ));
            }
            let mut line = vec![serde_json::Value::String(call.call)];
            for arg in call.args {
                line.push(json(arg)?);
            }
            input.push_str(&serde_json::Value::Array(line).to_string());
            input.push('\n');
            let returns = call.returns.map(json).transpose()?;
            output.push_str(&returns.unwrap_or(serde_json::Value::Null).to_string());
            output.push('\n');
        }
        Ok(Case { input, output })
    }
}

/// A TOML value as JSON, as the driver reads and writes values.
fn json(value: toml::Value) -> Result<serde_json::Value, String> {
    Ok(match value {
        toml::Value::String(text) => serde_json::Value::String(text),
        toml::Value::Integer(n) => serde_json::Value::from(n),
        toml::Value::Float(x) => serde_json::Number::from_f64(x)
            .map(serde_json::Value::Number)
            .ok_or_else(|| format!("{x} can't be passed or returned: give a finite number"))?,
        toml::Value::Boolean(b) => serde_json::Value::Bool(b),
        toml::Value::Array(items) => {
            serde_json::Value::Array(items.into_iter().map(json).collect::<Result<_, _>>()?)
        }
        toml::Value::Table(table) => serde_json::Value::Object(
            table
                .into_iter()
                .map(|(key, value)| Ok((key, json(value)?)))
                .collect::<Result<_, String>>()?,
        ),
        toml::Value::Datetime(when) => {
            return Err(format!(
                "{when} is a date, which can't be passed or returned: give it as a string"
            ));
        }
    })
}

/// Whether what a driver printed is what was expected: the same values, one a line, compared
/// as values, so 3 and 3.0 are the same, as are objects with their keys in another order.
/// Blank lines at the ends don't count, as with other output.
pub fn same_results(expected: &str, actual: &str) -> bool {
    let values = |text: &str| -> Option<Vec<serde_json::Value>> {
        crate::output::normalise(text)
            .lines()
            .map(|line| serde_json::from_str(line.trim()).ok())
            .collect()
    };
    match (values(expected), values(actual)) {
        (Some(expected), Some(actual)) => {
            expected.len() == actual.len()
                && expected.iter().zip(&actual).all(|(e, a)| same_value(e, a))
        }
        _ => false,
    }
}

fn same_value(expected: &serde_json::Value, actual: &serde_json::Value) -> bool {
    use serde_json::Value;
    match (expected, actual) {
        // Integers are compared exactly, as large ones lose precision as floats; only when
        // either is a float are they compared as floats, so 3 is 3.0.
        (Value::Number(e), Value::Number(a)) if e.is_f64() || a.is_f64() => {
            e.as_f64() == a.as_f64()
        }
        (Value::Array(e), Value::Array(a)) => {
            e.len() == a.len() && e.iter().zip(a).all(|(e, a)| same_value(e, a))
        }
        (Value::Object(e), Value::Object(a)) => {
            e.len() == a.len()
                && e.iter()
                    .all(|(key, e)| a.get(key).is_some_and(|a| same_value(e, a)))
        }
        _ => expected == actual,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn case(api: &Api, toml: &str) -> Result<Case, String> {
        let value: toml::Table = toml::from_str(toml).unwrap();
        api.case(toml::Value::Table(value))
    }

    #[test]
    fn reads_calls_as_lines_for_the_driver() {
        let buffer = Api {
            class: Some("TextBuffer".to_owned()),
        };
        let made = case(
            &buffer,
            "new = [\"hi\"]\ncalls = [\n  { call = \"insert\", args = [\" there\", 2] },\n  { call = \"text\", returns = \"hi there\" },\n  { call = \"lines\", returns = [\"hi\", { at = 1.5 }] },\n]\n",
        )
        .unwrap();
        assert_eq!(
            made.input,
            "[\"TextBuffer\",\"hi\"]\n[\"insert\",\" there\",2]\n[\"text\"]\n[\"lines\"]\n"
        );
        assert_eq!(made.output, "null\n\"hi there\"\n[\"hi\",{\"at\":1.5}]\n");
        // Made with nothing when it doesn't say.
        let plain = case(&buffer, "calls = [{ call = \"text\", returns = \"\" }]\n").unwrap();
        assert_eq!(plain.input, "[\"TextBuffer\"]\n[\"text\"]\n");

        let functions = Api { class: None };
        let made = case(
            &functions,
            "calls = [{ call = \"area\", args = [2, 3], returns = 6 }]\n",
        )
        .unwrap();
        assert_eq!(made.input, "[\"area\",2,3]\n");
        assert_eq!(made.output, "6\n");
    }

    #[test]
    fn says_what_is_wrong_with_a_case() {
        let buffer = Api {
            class: Some("TextBuffer".to_owned()),
        };
        let functions = Api { class: None };
        for (api, toml, says) in [
            (&buffer, "calls = []\n", "at least one call"),
            (&buffer, "input = \"1\"\noutput = \"1\"\n", "unknown field"),
            (&buffer, "calls = [{ call = \"TextBuffer\" }]\n", "with new"),
            (
                &buffer,
                "calls = [{ call = \"two words\" }]\n",
                "isn't a name",
            ),
            (
                &buffer,
                "calls = [{ call = \"at\", args = [nan] }]\n",
                "finite",
            ),
            (
                &functions,
                "new = []\ncalls = [{ call = \"area\" }]\n",
                "has no class",
            ),
        ] {
            let err = case(api, toml).unwrap_err();
            assert!(err.contains(says), "{toml}: {err}");
        }
        assert!(
            Api::new(ApiFields {
                class: Some("Text buffer".to_owned())
            })
            .is_err()
        );
    }

    #[test]
    fn compares_results_as_values() {
        assert!(same_results("null\n\"a\"\n3\n", "null\n\"a\"\n3.0\n\n"));
        assert!(same_results(
            "{\"a\":1,\"b\":[1,2]}",
            "{\"b\": [1, 2], \"a\": 1}"
        ));
        assert!(!same_results("[1,2]", "[2,1]"));
        assert!(!same_results("9007199254740993", "9007199254740992"));
        assert!(same_results("9007199254740993", "9007199254740993"));
        assert!(!same_results("1\n2\n", "1\n"));
        assert!(!same_results("\"1\"", "1"));
        assert!(!same_results("true", "1"));
        // What isn't a value is never right.
        assert!(!same_results("1", "Traceback"));
        assert!(!same_results("{\"a\":1}", "{\"a\":1,\"b\":2}"));
    }
}
