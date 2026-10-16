//! How a language keeps its list of packages: Workshop's own list, one package per line, or the
//! manifest the language's own tools keep, such as Cargo.toml.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ManifestFormat {
    /// One package per line, with `#` comments, installed by Workshop into an environment of its
    /// own.
    #[default]
    Lines,
    /// Cargo.toml's `[dependencies]`.
    Cargo,
    /// go.mod's requirements, leaving out the indirect ones.
    GoMod,
    /// The npm and JSR packages in deno.json's import map.
    Deno,
}

impl ManifestFormat {
    /// Whether the language's own tools keep the manifest, adding and removing packages, and
    /// fetch what's in it when building.
    pub fn is_native(self) -> bool {
        self != Self::Lines
    }

    /// The packages a manifest lists, in order.
    pub fn packages(self, text: &str) -> Result<Vec<String>> {
        let packages = match self {
            Self::Lines => lines(text)?,
            Self::Cargo => cargo(text)?,
            Self::GoMod => go_mod(text)?,
            Self::Deno => deno(text)?,
        };
        for package in &packages {
            self.check_name(package)?;
        }
        Ok(packages)
    }

    /// Package names are passed to installers as arguments, so they're kept to plain names:
    /// nothing an installer could read as an option, a path or a URL. Go's are import paths, and
    /// npm's can have a scope, such as `@scope/name`.
    pub fn check_name(self, name: &str) -> Result<()> {
        let extra: &[char] = match self {
            Self::Lines | Self::Cargo => &[],
            Self::GoMod => &['/', '~'],
            Self::Deno => &['/', '@'],
        };
        let first_ok = name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric() || (self == Self::Deno && c == '@'));
        let valid = first_ok
            && name.chars().all(|c| {
                c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') || extra.contains(&c)
            })
            && !name
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..");
        if !valid {
            bail!(
                "{name:?} isn't a package name; use letters, digits, `-`, `_` and `.`, starting with a letter or digit"
            );
        }
        Ok(())
    }
}

fn lines(text: &str) -> Result<Vec<String>> {
    let mut packages: Vec<String> = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let name = line.split('#').next().unwrap_or("").trim();
        if name.is_empty() {
            continue;
        }
        ManifestFormat::Lines
            .check_name(name)
            .with_context(|| format!("line {}", i + 1))?;
        if !packages.iter().any(|p| p == name) {
            packages.push(name.to_owned());
        }
    }
    Ok(packages)
}

fn cargo(text: &str) -> Result<Vec<String>> {
    let manifest: toml::Table = toml::from_str(text).context("reading Cargo.toml")?;
    match manifest.get("dependencies") {
        None => Ok(Vec::new()),
        Some(toml::Value::Table(dependencies)) => Ok(dependencies.keys().cloned().collect()),
        Some(_) => bail!("`dependencies` in Cargo.toml isn't a table"),
    }
}

fn go_mod(text: &str) -> Result<Vec<String>> {
    let mut packages = Vec::new();
    let mut in_block = false;
    for (i, line) in text.lines().enumerate() {
        let (code, comment) = line.split_once("//").unwrap_or((line, ""));
        let code = code.trim();
        let requirement = if in_block {
            if code == ")" {
                in_block = false;
                continue;
            }
            code
        } else if let Some(rest) = code.strip_prefix("require") {
            let rest = rest.trim();
            if rest == "(" {
                in_block = true;
                continue;
            }
            rest
        } else {
            continue;
        };
        if requirement.is_empty() || comment.trim() == "indirect" {
            continue;
        }
        let module = requirement
            .split_whitespace()
            .next()
            .with_context(|| format!("line {} of go.mod", i + 1))?;
        packages.push(module.trim_matches('"').to_owned());
    }
    if in_block {
        bail!("a `require (` block in go.mod isn't closed");
    }
    Ok(packages)
}

fn deno(text: &str) -> Result<Vec<String>> {
    let config: serde_json::Value = serde_json::from_str(text).context("reading deno.json")?;
    let Some(imports) = config.get("imports") else {
        return Ok(Vec::new());
    };
    let imports = imports
        .as_object()
        .context("`imports` in deno.json isn't an object")?;
    Ok(imports
        .iter()
        .filter(|(_, target)| {
            target
                .as_str()
                .is_some_and(|t| t.starts_with("npm:") || t.starts_with("jsr:"))
        })
        .map(|(name, _)| name.clone())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_cargo_dependencies() {
        let text = r#"
[package]
name = "aoc"

[dependencies]
itertools = "0.14"
regex = { version = "1", default-features = false }

[profile.release]
overflow-checks = true
"#;
        assert_eq!(
            ManifestFormat::Cargo.packages(text).unwrap(),
            ["itertools", "regex"]
        );
        assert!(
            ManifestFormat::Cargo
                .packages("[package]\nname = \"aoc\"\n")
                .unwrap()
                .is_empty()
        );
        assert!(ManifestFormat::Cargo.packages("not toml = ").is_err());
    }

    #[test]
    fn reads_direct_go_requirements() {
        let text = "module solutions

go 1.22

require github.com/emirpasic/gods/v2 v2.0.0-alpha

require (
\tgolang.org/x/exp v0.0.0-20250106 // a comment
\tgithub.com/some/indirect v1.0.0 // indirect
)
";
        assert_eq!(
            ManifestFormat::GoMod.packages(text).unwrap(),
            ["github.com/emirpasic/gods/v2", "golang.org/x/exp"]
        );
        assert!(
            ManifestFormat::GoMod
                .packages("module solutions\n\nrequire (\n")
                .is_err()
        );
    }

    #[test]
    fn reads_packages_from_deno_imports() {
        let text = r#"{
  "imports": {
    "@datastructures-js/priority-queue": "npm:@datastructures-js/priority-queue@^6.4.0",
    "aoc": "./lib/aoc.ts",
    "@std/collections": "jsr:@std/collections@^1"
  },
  "lock": false
}"#;
        assert_eq!(
            ManifestFormat::Deno.packages(text).unwrap(),
            ["@datastructures-js/priority-queue", "@std/collections"]
        );
    }

    #[test]
    fn keeps_names_to_what_each_language_allows() {
        ManifestFormat::GoMod
            .check_name("github.com/emirpasic/gods/v2")
            .unwrap();
        ManifestFormat::Deno
            .check_name("@datastructures-js/priority-queue")
            .unwrap();
        for bad in ["-x", "github.com/../x", "a//b", "/abs", ""] {
            assert!(ManifestFormat::GoMod.check_name(bad).is_err(), "{bad}");
        }
        assert!(ManifestFormat::Cargo.check_name("a/b").is_err());
        assert!(ManifestFormat::Lines.check_name("@scope/x").is_err());
        assert!(ManifestFormat::Deno.check_name("--allow-all").is_err());
    }
}
