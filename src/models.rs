//! Which model CLIs and models Workshop uses, and what each provider offers.

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

use crate::config::Config;

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
    /// The model that marks work, if chosen in the app; otherwise the config decides. See
    /// [`ModelSettings::grader`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grader: Option<GraderChoice>,
}

/// The grader's model, as chosen in the app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum GraderChoice {
    /// The discussion provider's first model.
    Discussion,
    Model {
        provider: String,
        model: String,
    },
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
            grader: None,
        }
    }

    /// The grader's model: the one chosen in the app, or else the config's, or `None` for the
    /// discussion provider's first model.
    pub fn grader(&self, config: &Config) -> Option<ModelChoice> {
        match &self.grader {
            Some(GraderChoice::Discussion) => None,
            Some(GraderChoice::Model { provider, model }) => Some(ModelChoice {
                provider: provider.clone(),
                model: model.clone(),
            }),
            None => config.models.grader.provider.as_ref().map(|provider| {
                let model = config
                    .models
                    .grader
                    .model
                    .clone()
                    .or_else(|| discuss_models(config, provider).into_iter().next());
                ModelChoice {
                    provider: provider.clone(),
                    // Parsing the config checks it has one, given or suggested.
                    model: model.expect("[models.grader] has a model"),
                }
            }),
        }
    }

    /// The providers chosen, for anything, each once.
    pub fn providers(&self, config: &Config) -> Vec<String> {
        let mut providers = vec![self.edit.provider.clone(), self.discuss_provider.clone()];
        providers.extend(self.grader(config).map(|grader| grader.provider));
        providers.sort();
        providers.dedup();
        providers
    }

    pub fn validate(&self, config: &Config) -> Result<()> {
        for provider in self.providers(config) {
            if !config.providers.contains_key(&provider) {
                bail!("there's no provider called {provider:?}");
            }
        }
        if self.edit.model.trim().is_empty() {
            bail!("choose an edit model");
        }
        if self
            .grader(config)
            .is_some_and(|grader| grader.model.trim().is_empty())
        {
            bail!("choose a model for the grader");
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
            let unavailable = workshop_common::programs::find_program(program)
                .is_none()
                .then(|| {
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
        // The grader follows the discussion unless the config or the app says otherwise.
        assert_eq!(settings.grader(&config()), None);
        let given = Config::parse("[models.grader]\nprovider = \"codex\"").unwrap();
        let codex = ModelChoice {
            provider: "codex".into(),
            model: "sol".into(),
        };
        assert_eq!(
            ModelSettings::defaults(&given).grader(&given),
            Some(codex.clone())
        );
        let following = ModelSettings {
            grader: Some(GraderChoice::Discussion),
            ..ModelSettings::defaults(&given)
        };
        assert_eq!(following.grader(&given), None);
        let chosen = ModelSettings {
            grader: Some(GraderChoice::Model {
                provider: "codex".into(),
                model: "sol".into(),
            }),
            ..settings.clone()
        };
        assert_eq!(chosen.grader(&config()), Some(codex));
        assert_eq!(chosen.providers(&config()), ["claude", "codex"]);
        let empty = ModelSettings {
            grader: Some(GraderChoice::Model {
                provider: "codex".into(),
                model: String::new(),
            }),
            ..settings
        };
        assert!(empty.validate(&config()).is_err());
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
