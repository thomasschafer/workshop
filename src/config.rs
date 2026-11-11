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
    editor: EditorConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, default)]
pub struct ServerConfig {
    pub bind: SocketAddr,
    /// Whether to check GitHub once a day for a newer release.
    pub check_for_updates: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
struct RawSolutionsConfig {
    dir: String,
    language: String,
    commit_after_star: bool,
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

/// How the code editor behaves with a keyboard.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct EditorConfig {
    /// The keybindings, until chosen on a device in the app.
    pub keybindings: Keybindings,
    pub helix: HelixConfig,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Keybindings {
    /// CodeMirror's own, much like a text box's.
    #[default]
    Default,
    /// Helix's modal keybindings.
    Helix,
}

/// Helix's own options, named as in Helix's `[editor]` config, so they can be copied from it, with
/// its `[keys]` tables under `keys`. Only the options Workshop follows are allowed.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, default, rename_all = "kebab-case")]
pub struct HelixConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scrolloff: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_number: Option<LineNumber>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color_modes: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_pairs: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jump_label_alphabet: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub smart_tab: Option<SmartTab>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search: Option<HelixSearch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_shape: Option<CursorShapes>,
    /// Keymaps by mode, in Helix's format, which the app reads and checks.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keys: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LineNumber {
    Absolute,
    Relative,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SmartTab {
    pub enable: bool,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct HelixSearch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub smart_case: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wrap_around: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CursorShapes {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub normal: Option<CursorShape>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub insert: Option<CursorShape>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub select: Option<CursorShape>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CursorShape {
    Block,
    Bar,
    Underline,
    Hidden,
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
            check_for_updates: true,
        }
    }
}

impl Default for RawSolutionsConfig {
    fn default() -> Self {
        Self {
            dir: "~/aoc".into(),
            language: "haskell".into(),
            commit_after_star: false,
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
    /// Whether to commit and push the solutions repo after each star, until chosen in the app.
    pub commit_after_star: bool,
    pub aoc: AocConfig,
    pub run: RunConfig,
    pub models: ModelsConfig,
    pub providers: BTreeMap<String, ProviderConfig>,
    pub languages: BTreeMap<String, LanguageProfile>,
    pub snippets: Vec<Snippet>,
    pub editor: EditorConfig,
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
            if let Some(helpers) = &profile.helpers {
                helpers
                    .validate()
                    .with_context(|| format!("in the helpers of language {id}"))?;
            }
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
            commit_after_star: raw.solutions.commit_after_star,
            aoc: raw.aoc,
            run: raw.run,
            models: raw.models,
            providers,
            languages,
            snippets: raw.snippets,
            editor: raw.editor,
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
    fn reads_helix_options_and_keys() {
        let source = r#"
            [editor]
            keybindings = "helix"

            [editor.helix]
            line-number = "relative"
            color-modes = true
            smart-tab.enable = false

            [editor.helix.keys.normal]
            X = "extend_line_above"
            A-up = ["extend_to_line_bounds", "delete_selection"]

            [editor.helix.keys.normal.space]
            p = "paste_after"
        "#;
        let config = Config::parse(source).unwrap();
        assert_eq!(config.editor.keybindings, Keybindings::Helix);
        let helix = &config.editor.helix;
        assert_eq!(helix.line_number, Some(LineNumber::Relative));
        assert_eq!(helix.color_modes, Some(true));
        assert_eq!(helix.smart_tab, Some(SmartTab { enable: false }));
        let keys = helix.keys.as_ref().unwrap();
        assert_eq!(keys["normal"]["X"], "extend_line_above");
        assert_eq!(keys["normal"]["space"]["p"], "paste_after");
    }

    #[test]
    fn rejects_helix_options_workshop_does_not_follow() {
        assert!(Config::parse("[editor.helix]\nbufferline = \"always\"").is_err());
        assert!(Config::parse("[editor]\nkeybindings = \"vim\"").is_err());
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
