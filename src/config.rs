use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use workshop_common::files;
use workshop_provider::ProviderConfig;

use crate::language::{self, LanguageProfile};
use crate::paths::Paths;

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
    learning: RawLearningConfig,
    author: AuthorConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
struct RawLearningConfig {
    packs: Vec<String>,
    sample_pack: bool,
    daily_reviews: u32,
    daily_new: u32,
    weekly_minutes: u32,
    desired_retention: f64,
}

/// What's learnt in the tracks besides Advent of Code, and how much of it to do.
#[derive(Debug, Clone, PartialEq)]
pub struct LearningConfig {
    /// The packs' directories. Empty means the sample pack.
    pub packs: Vec<PathBuf>,
    /// Whether to learn from the sample pack as well as the packs listed. It's used anyway when
    /// none are.
    pub sample_pack: bool,
    /// The most reviews Continue offers in a day; the rest wait for the next.
    pub daily_reviews: u32,
    /// The most new items Continue offers in a day; the rest wait for the next.
    pub daily_new: u32,
    /// The minutes of practice to aim for each week.
    pub weekly_minutes: u32,
    /// How likely the learner should be to recall an item when it next comes up.
    pub desired_retention: f64,
}

/// The author: the models that write items and review them, and how much a run may do.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, default)]
pub struct AuthorConfig {
    /// Writes items, with tools confined to a copy of the pack: a strong model.
    pub writer: AuthorModel,
    /// Solves each item blind and reviews it, with no tools. Unset, it's another provider's
    /// model if one is installed and logged in, and the writer's otherwise; see
    /// `crate::author::reviewer`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewer: Option<AuthorModel>,
    /// The most new items a run writes.
    pub max_items: usize,
    /// Rounds of discussion when the writer and reviewer disagree, before an item waits for
    /// approval.
    pub discussion_rounds: usize,
    /// Rounds the writer gets to fix items whose checks fail.
    pub fix_rounds: usize,
    /// The longest a model may take over one turn.
    pub timeout_minutes: u64,
    /// How often the server runs the author by itself, for each pack of the learner's own, if
    /// at all.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub every: Option<crate::author::schedule::Every>,
    /// The time of day, on this computer's clock, a scheduled run waits for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<crate::author::schedule::TimeOfDay>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorModel {
    pub provider: String,
    pub model: String,
}

impl Default for AuthorConfig {
    fn default() -> Self {
        Self {
            writer: AuthorModel {
                provider: "claude".into(),
                model: "opus".into(),
            },
            reviewer: None,
            max_items: 5,
            discussion_rounds: 2,
            fix_rounds: 2,
            timeout_minutes: 20,
            every: None,
            after: None,
        }
    }
}

/// The most items a run may be set to write, so a mistake in the config can't spend hours.
const MAX_ITEMS_PER_RUN: usize = 50;

/// The range of retention FSRS schedules well for: below it items come back too rarely to
/// learn, and above it far too often.
const RETENTION: std::ops::RangeInclusive<f64> = 0.7..=0.97;

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
    pub grader: GraderModelConfig,
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

/// The model that marks work, if not the discussion provider's first model.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields, default)]
pub struct GraderModelConfig {
    pub provider: Option<String>,
    /// The provider's first discussion model if not given.
    pub model: Option<String>,
}

/// How the code editor behaves with a keyboard.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct EditorConfig {
    /// The keybindings, until chosen on a device in the app.
    pub keybindings: Keybindings,
    /// Formats the code before each run, and with Helix's keybindings, once it's been left in
    /// normal mode for a moment.
    pub format_automatically: bool,
    pub helix: HelixConfig,
}

impl Default for EditorConfig {
    fn default() -> Self {
        Self {
            keybindings: Keybindings::default(),
            format_automatically: true,
            helix: HelixConfig::default(),
        }
    }
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_guides: Option<IndentGuidesConfig>,
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
#[serde(deny_unknown_fields, default, rename_all = "kebab-case")]
pub struct SmartTab {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supersede_menu: Option<bool>,
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

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct IndentGuidesConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub render: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_levels: Option<u8>,
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

impl Default for RawLearningConfig {
    fn default() -> Self {
        Self {
            packs: Vec::new(),
            sample_pack: false,
            daily_reviews: 40,
            daily_new: 10,
            weekly_minutes: 90,
            desired_retention: 0.9,
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
    pub learning: LearningConfig,
    pub author: AuthorConfig,
}

impl Config {
    /// Loads the config file, creating a commented example if there isn't one.
    pub fn load_or_init(paths: &Paths) -> Result<Self> {
        let file = paths.config_file();
        if !file.exists() {
            let prefer_codex = workshop_common::programs::find_program("claude").is_none()
                && workshop_common::programs::find_program("codex").is_some();
            files::write_atomic(&file, initial_config(prefer_codex).as_bytes())?;
            tracing::info!("wrote an example config to {}", file.display());
        }
        let source = std::fs::read_to_string(&file)
            .with_context(|| format!("reading {}", file.display()))?;
        Self::parse(&source).with_context(|| format!("in {}", file.display()))
    }

    pub fn parse(source: &str) -> Result<Self> {
        let raw: RawConfig = toml::from_str(source)?;

        let mut providers: BTreeMap<_, _> = workshop_provider::builtin_providers()?
            .into_iter()
            .collect();
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
        match &raw.models.grader {
            GraderModelConfig {
                provider: None,
                model: Some(_),
            } => bail!("[models.grader] needs a provider for its model"),
            GraderModelConfig {
                provider: Some(provider),
                ..
            } if !providers.contains_key(provider) => {
                bail!("[models.grader] uses unknown provider {provider:?}");
            }
            GraderModelConfig {
                model: Some(model), ..
            } if model.trim().is_empty() => bail!("[models.grader] has an empty model"),
            GraderModelConfig {
                provider: Some(provider),
                model: None,
            } if *provider != raw.models.discuss.provider
                && providers[provider].discuss_models.is_empty() =>
            {
                bail!(
                    "[models.grader] needs a model, as {provider:?} doesn't suggest any for discussion"
                );
            }
            _ => {}
        }
        let mut seen = std::collections::HashSet::new();
        for snippet in &raw.snippets {
            if !seen.insert(snippet.name.to_lowercase()) {
                bail!("there are two snippets called {:?}", snippet.name);
            }
        }

        let author = raw.author;
        let roles = [
            ("writer", Some(&author.writer)),
            ("reviewer", author.reviewer.as_ref()),
        ];
        for (role, choice) in roles
            .into_iter()
            .filter_map(|(role, choice)| Some((role, choice?)))
        {
            if !providers.contains_key(&choice.provider) {
                bail!(
                    "[author] {role} uses unknown provider {:?}",
                    choice.provider
                );
            }
        }
        if !(1..=MAX_ITEMS_PER_RUN).contains(&author.max_items) {
            bail!("[author] max_items should be from 1 to {MAX_ITEMS_PER_RUN}");
        }
        if author.timeout_minutes == 0 {
            bail!("[author] timeout_minutes should be at least 1");
        }
        crate::author::schedule::check(author.every, author.after)?;

        let learning = raw.learning;
        if !RETENTION.contains(&learning.desired_retention) {
            bail!(
                "[learning] desired_retention should be from {} to {}",
                RETENTION.start(),
                RETENTION.end()
            );
        }
        if learning.daily_reviews == 0 {
            bail!("[learning] daily_reviews should be at least 1");
        }
        if learning.daily_new == 0 {
            bail!("[learning] daily_new should be at least 1");
        }
        let packs = learning
            .packs
            .iter()
            .map(|dir| files::expand_home(dir))
            .collect::<Result<Vec<_>>>()?;

        Ok(Self {
            server: raw.server,
            solutions_dir: files::expand_home(&raw.solutions.dir)?,
            language_id: raw.solutions.language,
            commit_after_star: raw.solutions.commit_after_star,
            aoc: raw.aoc,
            run: raw.run,
            models: raw.models,
            providers,
            languages,
            snippets: raw.snippets,
            editor: raw.editor,
            learning: LearningConfig {
                packs,
                sample_pack: learning.sample_pack,
                daily_reviews: learning.daily_reviews,
                daily_new: learning.daily_new,
                weekly_minutes: learning.weekly_minutes,
                desired_retention: learning.desired_retention,
            },
            author,
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
    fn reads_the_graders_model_if_its_not_the_discussions() {
        let config = Config::parse("").unwrap();
        assert!(config.models.grader.provider.is_none());
        let codex =
            Config::parse("[models.grader]\nprovider = \"codex\"\nmodel = \"astra\"").unwrap();
        assert_eq!(codex.models.grader.provider.as_deref(), Some("codex"));
        assert_eq!(codex.models.grader.model.as_deref(), Some("astra"));
        assert!(Config::parse("[models.grader]\nprovider = \"codex\"").is_ok());
        assert!(Config::parse("[models.grader]\nmodel = \"astra\"").is_err());
        assert!(Config::parse("[models.grader]\nprovider = \"nope\"").is_err());
        assert!(Config::parse("[models.grader]\nprovider = \"codex\"\nmodel = \" \"").is_err());
    }

    #[test]
    fn schedules_the_author_only_when_asked() {
        let config = Config::parse("").unwrap();
        assert_eq!((config.author.every, config.author.after), (None, None));
        let weekly = Config::parse("[author]\nevery = \"7d\"\nafter = \"02:00\"").unwrap();
        assert_eq!(weekly.author.every.unwrap().to_string(), "7d");
        assert_eq!(weekly.author.after.unwrap().to_string(), "02:00");
        for (source, expected) in [
            ("[author]\nafter = \"02:00\"", "after needs every"),
            ("[author]\nevery = \"7x\"", "hours, days or weeks"),
            ("[author]\nevery = \"7d\"\nafter = \"2am\"", "HH:MM"),
        ] {
            let err = format!("{:#}", Config::parse(source).unwrap_err());
            assert!(err.contains(expected), "{source}: {err}");
        }
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
            smart-tab = { enable = false, supersede-menu = true }
            indent-guides = { render = false, skip-levels = 1 }

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
        assert_eq!(
            helix.smart_tab,
            Some(SmartTab {
                enable: Some(false),
                supersede_menu: Some(true),
            })
        );
        assert_eq!(
            helix.indent_guides,
            Some(IndentGuidesConfig {
                render: Some(false),
                skip_levels: Some(1),
            })
        );
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
    fn reads_what_to_learn_and_how_much() {
        let config = Config::parse(
            "[learning]\npacks = [\"~/learning\"]\ndaily_reviews = 10\ndaily_new = 3\nweekly_minutes = 30",
        )
        .unwrap();
        assert_eq!(
            config.learning.packs,
            [files::expand_home("~/learning").unwrap()]
        );
        assert_eq!(config.learning.daily_reviews, 10);
        assert_eq!(config.learning.daily_new, 3);
        assert_eq!(Config::parse("").unwrap().learning.daily_new, 10);
        assert_eq!(config.learning.weekly_minutes, 30);
        assert_eq!(config.learning.desired_retention, 0.9);
        assert!(Config::parse("").unwrap().learning.packs.is_empty());
        assert!(!config.learning.sample_pack);
        assert!(
            Config::parse("[learning]\nsample_pack = true")
                .unwrap()
                .learning
                .sample_pack
        );
        assert!(Config::parse("[learning]\ndesired_retention = 0.99").is_err());
        assert!(Config::parse("[learning]\ndaily_reviews = 0").is_err());
        assert!(Config::parse("[learning]\ndaily_new = 0").is_err());
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
