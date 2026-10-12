//! Which model CLIs and models Workshop uses, as chosen in the app. The config file sets the
//! defaults; choices made in the app are saved separately so the config file is never rewritten.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::doctor;
use crate::paths::{self, Paths};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelChoice {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelSettings {
    pub edit: ModelChoice,
    pub discuss_provider: String,
}

/// A provider as offered in the app.
#[derive(Debug, Clone, Serialize)]
pub struct ProviderOption {
    pub id: String,
    pub name: String,
    /// Why it can't be chosen, such as its CLI not being installed.
    pub unavailable: Option<String>,
    pub edit_models: Vec<String>,
    pub discuss_models: Vec<String>,
}

impl ModelSettings {
    pub fn defaults(config: &Config) -> Self {
        Self {
            edit: ModelChoice {
                provider: config.models.edit.provider.clone(),
                model: config.models.edit.model.clone(),
            },
            discuss_provider: config.models.discuss.provider.clone(),
        }
    }

    /// The saved choice, or the config's defaults if there isn't one or it no longer fits the
    /// config, for example because a provider was removed.
    pub fn load(config: &Config, paths: &Paths) -> Self {
        let file = paths.model_settings_file();
        let saved = match std::fs::read_to_string(&file) {
            Ok(json) => serde_json::from_str::<Self>(&json)
                .context("reading saved model settings")
                .and_then(|s| s.validate(config).map(|()| s)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Self::defaults(config);
            }
            Err(err) => Err(err).with_context(|| format!("reading {}", file.display())),
        };
        saved.unwrap_or_else(|err| {
            tracing::warn!("using the model settings from the config file: {err:#}");
            Self::defaults(config)
        })
    }

    pub fn save(&self, paths: &Paths) -> Result<()> {
        paths::write_atomic(
            &paths.model_settings_file(),
            &serde_json::to_vec_pretty(self)?,
        )
    }

    pub fn validate(&self, config: &Config) -> Result<()> {
        for provider in [&self.edit.provider, &self.discuss_provider] {
            if !config.providers.contains_key(provider) {
                bail!("there's no provider called {provider:?}");
            }
        }
        if self.edit.model.trim().is_empty() {
            bail!("choose an edit model");
        }
        Ok(())
    }
}

/// Models offered for discussion with `provider`: those in the config if it's the config's
/// discussion provider, otherwise the provider's own suggestions.
pub fn discuss_models(config: &Config, provider: &str) -> Vec<String> {
    if provider == config.models.discuss.provider {
        return config.models.discuss.models.clone();
    }
    config
        .providers
        .get(provider)
        .map(|p| p.discuss_models.clone())
        .unwrap_or_default()
}

fn edit_models(config: &Config, provider: &str) -> Vec<String> {
    let mut models = config
        .providers
        .get(provider)
        .map(|p| p.edit_models.clone())
        .unwrap_or_default();
    if provider == config.models.edit.provider && !models.contains(&config.models.edit.model) {
        models.insert(0, config.models.edit.model.clone());
    }
    models
}

pub fn options(config: &Config) -> Vec<ProviderOption> {
    config
        .providers
        .iter()
        .map(|(id, provider)| {
            let program = &provider.command[0];
            let unavailable = doctor::find_program(program).is_none().then(|| {
                provider
                    .install_hint
                    .clone()
                    .unwrap_or_else(|| format!("`{program}` isn't installed."))
            });
            ProviderOption {
                id: id.clone(),
                name: provider.display_name(id).to_owned(),
                unavailable,
                edit_models: edit_models(config, id),
                discuss_models: discuss_models(config, id),
            }
        })
        // A provider with nothing to offer can't be chosen in the app.
        .filter(|o| !o.edit_models.is_empty() || !o.discuss_models.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Config {
        Config::parse("").unwrap()
    }

    #[test]
    fn defaults_come_from_the_config() {
        let settings = ModelSettings::defaults(&config());
        assert_eq!(settings.edit.provider, "claude");
        assert_eq!(settings.edit.model, "haiku");
        assert_eq!(settings.discuss_provider, "claude");
    }

    #[test]
    fn offers_each_providers_models() {
        let config = config();
        let options = options(&config);
        let codex = options.iter().find(|o| o.id == "codex").unwrap();
        assert_eq!(codex.name, "Codex");
        assert_eq!(codex.edit_models, vec!["luna", "sol"]);
        assert_eq!(discuss_models(&config, "codex"), vec!["sol", "astra"]);
        assert_eq!(
            discuss_models(&config, "claude"),
            vec!["sonnet", "opus", "fable"]
        );
    }

    #[test]
    fn saves_and_falls_back_to_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::under(dir.path());
        let config = config();
        let chosen = ModelSettings {
            edit: ModelChoice {
                provider: "codex".into(),
                model: "luna".into(),
            },
            discuss_provider: "codex".into(),
        };
        chosen.save(&paths).unwrap();
        assert_eq!(ModelSettings::load(&config, &paths), chosen);

        std::fs::write(
            paths.model_settings_file(),
            r#"{"edit":{"provider":"gone","model":"x"},"discuss_provider":"claude"}"#,
        )
        .unwrap();
        assert_eq!(
            ModelSettings::load(&config, &paths),
            ModelSettings::defaults(&config)
        );
    }
}
