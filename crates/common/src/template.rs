use std::collections::HashMap;

use anyhow::{Result, bail};

/// Values available to `{placeholder}` substitution in configured paths and commands.
#[derive(Debug, Default)]
pub struct Vars<'a> {
    values: HashMap<&'a str, String>,
}

impl<'a> Vars<'a> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(mut self, name: &'a str, value: impl Into<String>) -> Self {
        self.values.insert(name, value.into());
        self
    }
}

/// Substitutes `{name}` and zero-padded `{name:0N}` placeholders. `{{` and `}}` are literal braces.
/// Unknown placeholders are an error rather than being left in place, so a typo in config fails
/// loudly instead of running a command with a literal `{fiel}` argument.
pub fn render(template: &str, vars: &Vars) -> Result<String> {
    let mut out = String::with_capacity(template.len());
    let mut chars = template.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        match c {
            '{' if chars.peek().map(|&(_, c)| c) == Some('{') => {
                chars.next();
                out.push('{');
            }
            '}' if chars.peek().map(|&(_, c)| c) == Some('}') => {
                chars.next();
                out.push('}');
            }
            '{' => {
                let rest = &template[i + 1..];
                let Some(end) = rest.find('}') else {
                    bail!("unclosed `{{` in {template:?}");
                };
                let spec = &rest[..end];
                out.push_str(&render_placeholder(spec, vars, template)?);
                for _ in 0..=spec.chars().count() {
                    chars.next();
                }
            }
            '}' => bail!("unmatched `}}` in {template:?}"),
            c => out.push(c),
        }
    }
    Ok(out)
}

fn render_placeholder(spec: &str, vars: &Vars, template: &str) -> Result<String> {
    let (name, format) = match spec.split_once(':') {
        Some((name, format)) => (name, Some(format)),
        None => (spec, None),
    };
    let Some(value) = vars.values.get(name) else {
        bail!("unknown placeholder {{{name}}} in {template:?}");
    };
    match format {
        None => Ok(value.clone()),
        // A quoted TOML string, for passing text through a CLI's `-c key=value` settings.
        Some("toml") => Ok(toml::Value::String(value.clone()).to_string()),
        Some(format) => {
            let Some(width) = format
                .strip_prefix('0')
                .and_then(|w| w.parse::<usize>().ok())
            else {
                bail!(
                    "unsupported format {{{spec}}} in {template:?}; use zero padding like {{day:02}}, or {{name:toml}}"
                );
            };
            Ok(format!("{value:0>width$}"))
        }
    }
}

pub fn render_all(templates: &[String], vars: &Vars) -> Result<Vec<String>> {
    templates.iter().map(|t| render(t, vars)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars() -> Vars<'static> {
        Vars::new().set("year", "2017").set("day", "4")
    }

    #[test]
    fn substitutes_and_pads() {
        assert_eq!(
            render("{year}/day{day:02}/Main.hs", &vars()).unwrap(),
            "2017/day04/Main.hs"
        );
    }

    #[test]
    fn escapes_braces() {
        assert_eq!(render("{{x}} {day}", &vars()).unwrap(), "{x} 4");
    }

    #[test]
    fn rejects_unknown_placeholder() {
        let err = render("{fiel}", &vars()).unwrap_err().to_string();
        assert!(err.contains("unknown placeholder {fiel}"), "{err}");
    }

    #[test]
    fn rejects_unclosed_and_unsupported_format() {
        assert!(render("{day", &vars()).is_err());
        assert!(render("{day:x}", &vars()).is_err());
        assert!(render("day}", &vars()).is_err());
    }

    #[test]
    fn quotes_toml_strings() {
        let vars = Vars::new().set("prompt", "Say \"hi\"\nthen ‸ stop\\");
        let rendered = render("instructions={prompt:toml}", &vars).unwrap();
        let parsed: toml::Table = toml::from_str(&rendered).unwrap();
        assert_eq!(
            parsed["instructions"].as_str(),
            Some("Say \"hi\"\nthen ‸ stop\\")
        );
    }

    #[test]
    fn handles_non_ascii() {
        assert_eq!(render("é{day}‸", &vars()).unwrap(), "é4‸");
    }
}
