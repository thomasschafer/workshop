//! Choices made in the app, such as models and language. The config file sets the defaults;
//! choices are saved separately so the config file is never rewritten.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::models::ModelSettings;
use crate::paths::{self, Paths};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppSettings {
    pub models: ModelSettings,
    pub language: String,
}

impl AppSettings {
    pub fn defaults(config: &Config) -> Self {
        Self {
            models: ModelSettings::defaults(config),
            language: config.language_id.clone(),
        }
    }

    /// The saved choices, or the config's defaults if there are none or they no longer fit the
    /// config, for example because a provider or language was removed.
    pub fn load(config: &Config, paths: &Paths) -> Self {
        let file = paths.settings_file();
        let saved = match std::fs::read_to_string(&file) {
            Ok(json) => serde_json::from_str::<Self>(&json)
                .context("reading saved settings")
                .and_then(|s| s.validate(config).map(|()| s)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Self::defaults(config);
            }
            Err(err) => Err(err).with_context(|| format!("reading {}", file.display())),
        };
        saved.unwrap_or_else(|err| {
            tracing::warn!("using the settings from the config file: {err:#}");
            Self::defaults(config)
        })
    }

    pub fn save(&self, paths: &Paths) -> Result<()> {
        paths::write_atomic(&paths.settings_file(), &serde_json::to_vec_pretty(self)?)
    }

    pub fn validate(&self, config: &Config) -> Result<()> {
        self.models.validate(config)?;
        if !config.languages.contains_key(&self.language) {
            bail!("there's no language called {:?}", self.language);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ModelChoice;

    #[test]
    fn saves_and_falls_back_to_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::under(dir.path());
        let config = Config::parse("").unwrap();
        assert_eq!(
            AppSettings::load(&config, &paths),
            AppSettings::defaults(&config)
        );

        let chosen = AppSettings {
            models: ModelSettings {
                edit: ModelChoice {
                    provider: "codex".into(),
                    model: "luna".into(),
                },
                discuss_provider: "codex".into(),
            },
            language: "python".into(),
        };
        chosen.save(&paths).unwrap();
        assert_eq!(AppSettings::load(&config, &paths), chosen);

        let removed = AppSettings {
            language: "cobol".into(),
            ..chosen
        };
        removed.save(&paths).unwrap();
        assert_eq!(
            AppSettings::load(&config, &paths),
            AppSettings::defaults(&config)
        );
    }
}
