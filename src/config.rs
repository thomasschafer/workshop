use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::language::{self, LanguageProfile};
use crate::paths::{self, Paths};
use crate::provider::{self, ProviderConfig};

pub const EXAMPLE: &str = include_str!("../config.example.toml");

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, default)]
struct RawConfig {
    server: ServerConfig,
    solutions: RawSolutionsConfig,
    aoc: AocConfig,
    run: RunConfig,
    models: ModelsConfig,
    providers: BTreeMap<String, ProviderConfig>,
    languages: BTreeMap<String, LanguageProfile>,
    snippets: Vec<Snippet>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, default)]
pub struct ServerConfig {
    pub bind: SocketAddr,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
struct RawSolutionsConfig {
    dir: String,
    language: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, default)]
pub struct AocConfig {
    pub user_agent: String,
    /// Where Advent of Code is. Only tests and demos point this elsewhere, so they never make
    /// requests to the real site.
    pub base_url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, default)]
pub struct RunConfig {
    pub timeout_secs: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(deny_unknown_fields, default)]
pub struct ModelsConfig {
    pub edit: EditModelConfig,
    pub discuss: DiscussModelConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, default)]
pub struct EditModelConfig {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, default)]
pub struct DiscussModelConfig {
    pub provider: String,
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Snippet {
    pub name: String,
    pub body: String,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind: SocketAddr::from(([127, 0, 0, 1], 7878)),
        }
    }
}

impl Default for RawSolutionsConfig {
    fn default() -> Self {
        Self {
            dir: "~/aoc".into(),
            language: "haskell".into(),
        }
    }
}

impl Default for AocConfig {
    fn default() -> Self {
        Self {
            user_agent: "github.com/thomasschafer/workshop".into(),
            base_url: crate::aoc::BASE_URL.into(),
        }
    }
}

impl Default for RunConfig {
    fn default() -> Self {
        Self { timeout_secs: 60 }
    }
}

impl Default for EditModelConfig {
    fn default() -> Self {
        Self {
            provider: "claude".into(),
            model: "haiku".into(),
        }
    }
}

impl Default for DiscussModelConfig {
    fn default() -> Self {
        Self {
            provider: "claude".into(),
            models: vec!["sonnet".into(), "opus".into(), "fable".into()],
        }
    }
}

/// Validated configuration, with built-in providers and language profiles merged in.
#[derive(Debug, Clone)]
pub struct Config {
    pub server: ServerConfig,
    pub solutions_dir: PathBuf,
    pub language_id: String,
    pub aoc: AocConfig,
    pub run: RunConfig,
    pub models: ModelsConfig,
    pub providers: BTreeMap<String, ProviderConfig>,
    pub languages: BTreeMap<String, LanguageProfile>,
    pub snippets: Vec<Snippet>,
}

impl Config {
    /// Loads the config file, creating a commented example if there isn't one.
    pub fn load_or_init(paths: &Paths) -> Result<Self> {
        let file = paths.config_file();
        if !file.exists() {
            let prefer_codex = crate::doctor::find_program("claude").is_none()
                && crate::doctor::find_program("codex").is_some();
            paths::write_atomic(&file, initial_config(prefer_codex).as_bytes())?;
            tracing::info!("wrote an example config to {}", file.display());
        }
        let source = std::fs::read_to_string(&file)
            .with_context(|| format!("reading {}", file.display()))?;
        Self::parse(&source).with_context(|| format!("in {}", file.display()))
    }

    pub fn parse(source: &str) -> Result<Self> {
        let raw: RawConfig = toml::from_str(source)?;

        let mut providers: BTreeMap<_, _> = provider::builtin_providers()?.into_iter().collect();
        for (id, provider) in raw.providers {
            provider
                .validate()
                .with_context(|| format!("in [providers.{id}]"))?;
            providers.insert(id, provider);
        }
        let mut languages: BTreeMap<_, _> = language::builtin_profiles()?.into_iter().collect();
        languages.extend(raw.languages);
        for (id, profile) in &languages {
            if let Some(packages) = &profile.packages {
                packages
                    .validate()
                    .with_context(|| format!("in the packages of language {id}"))?;
            }
        }

        if !languages.contains_key(&raw.solutions.language) {
            bail!(
                "unknown language {:?}; available: {}",
                raw.solutions.language,
                languages.keys().cloned().collect::<Vec<_>>().join(", ")
            );
        }
        for (role, provider) in [
            ("edit", &raw.models.edit.provider),
            ("discuss", &raw.models.discuss.provider),
        ] {
            if !providers.contains_key(provider) {
                bail!("[models.{role}] uses unknown provider {provider:?}");
            }
        }
        if raw.models.discuss.models.is_empty() {
            bail!("[models.discuss] needs at least one model");
        }
        let mut seen = std::collections::HashSet::new();
        for snippet in &raw.snippets {
            if !seen.insert(snippet.name.to_lowercase()) {
                bail!("there are two snippets called {:?}", snippet.name);
            }
        }

        Ok(Self {
            server: raw.server,
            solutions_dir: paths::expand_home(&raw.solutions.dir)?,
            language_id: raw.solutions.language,
            aoc: raw.aoc,
            run: raw.run,
            models: raw.models,
            providers,
            languages,
            snippets: raw.snippets,
        })
    }
}

/// The commented example config, set up for Codex instead of Claude Code if that's what the
/// user has.
fn initial_config(prefer_codex: bool) -> String {
    if !prefer_codex {
        return EXAMPLE.to_owned();
    }
    let replacements = [
        ("provider = \"claude\"", "provider = \"codex\""),
        ("model = \"haiku\"", "model = \"luna\""),
        (
            "models = [\"sonnet\", \"opus\", \"fable\"]",
            "models = [\"sol\", \"astra\"]",
        ),
    ];
    let mut config = EXAMPLE.to_owned();
    for (from, to) in replacements {
        assert!(
            config.contains(from),
            "the example config no longer contains {from}"
        );
        config = config.replace(from, to);
    }
    config
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn example_config_parses_to_defaults() {
        let config = Config::parse(EXAMPLE).unwrap();
        assert_eq!(config.server.bind, ServerConfig::default().bind);
        assert_eq!(config.language_id, "haskell");
        assert_eq!(config.models.edit.model, "haiku");
        assert_eq!(config.models.discuss.models.len(), 3);
        assert!(config.providers.contains_key("claude"));
    }

    #[test]
    fn initial_config_can_use_codex() {
        let claude = Config::parse(&initial_config(false)).unwrap();
        assert_eq!(claude.models.edit.provider, "claude");
        let codex = Config::parse(&initial_config(true)).unwrap();
        assert_eq!(codex.models.edit.provider, "codex");
        assert_eq!(codex.models.edit.model, "luna");
        assert_eq!(codex.models.discuss.provider, "codex");
        assert_eq!(codex.models.discuss.models, vec!["sol", "astra"]);
    }

    #[test]
    fn empty_config_is_valid() {
        Config::parse("").unwrap();
    }

    #[test]
    fn rejects_unknown_fields_and_references() {
        assert!(Config::parse("[server]\nport = 1").is_err());
        assert!(Config::parse("[solutions]\nlanguage = \"cobol\"").is_err());
        assert!(Config::parse("[models.edit]\nprovider = \"nope\"").is_err());
        assert!(Config::parse("[models.discuss]\nmodels = []").is_err());
    }

    #[test]
    fn rejects_duplicate_snippets() {
        let source =
            "[[snippets]]\nname = \"a\"\nbody = \"x\"\n[[snippets]]\nname = \"A\"\nbody = \"y\"";
        assert!(Config::parse(source).is_err());
    }

    #[test]
    fn user_providers_override_presets() {
        let source = r#"
            [providers.claude]
            command = ["fake", "{model}"]
            input = "stdin"
            output = "text"
        "#;
        let config = Config::parse(source).unwrap();
        assert_eq!(config.providers["claude"].command[0], "fake");
    }
}
