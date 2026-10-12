//! Which model CLIs and models Workshop uses, and what each provider offers.

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::doctor;

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
}
