//! Choices made in the app, such as models and language. The config file sets the defaults;
//! choices are saved separately so the config file is never rewritten.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::models::ModelSettings;
use crate::paths::{self, Paths};
use crate::theme::ThemeSettings;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppSettings {
    pub models: ModelSettings,
    pub language: String,
    #[serde(default)]
    pub theme: ThemeSettings,
    /// Whether to commit and push the solutions repo after each star, if chosen in the app;
    /// otherwise the config decides. See [`AppSettings::commit_after_star`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit_after_star: Option<bool>,
    /// A private leaderboard to show, if the user has chosen one.
    #[serde(default)]
    pub leaderboard: Option<crate::aoc::LeaderboardId>,
}

impl AppSettings {
    pub fn defaults(config: &Config) -> Self {
        Self {
            models: ModelSettings::defaults(config),
            language: config.language_id.clone(),
            theme: ThemeSettings::default(),
            commit_after_star: None,
            leaderboard: None,
        }
    }

    /// Whether to commit and push the solutions repo after each star.
    pub fn commit_after_star(&self, config: &Config) -> bool {
        self.commit_after_star.unwrap_or(config.commit_after_star)
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
            theme: ThemeSettings::default(),
            commit_after_star: Some(true),
            leaderboard: Some(crate::aoc::LeaderboardId::try_from("123456".to_owned()).unwrap()),
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

    #[test]
    fn commits_after_a_star_as_configured_until_chosen_in_the_app() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::under(dir.path());
        let config = Config::parse("[solutions]\ncommit_after_star = true").unwrap();
        assert!(AppSettings::load(&config, &paths).commit_after_star(&config));

        // Saved before the choice existed, as settings from older versions are.
        std::fs::create_dir_all(paths.settings_file().parent().unwrap()).unwrap();
        std::fs::write(
            paths.settings_file(),
            r#"{"models":{"edit":{"provider":"claude","model":"haiku"},"discuss_provider":"claude"},"language":"haskell"}"#,
        )
        .unwrap();
        let saved = AppSettings::load(&config, &paths);
        assert_eq!(saved.commit_after_star, None);
        assert!(saved.commit_after_star(&config));

        let turned_off = AppSettings {
            commit_after_star: Some(false),
            ..saved
        };
        turned_off.save(&paths).unwrap();
        assert!(!AppSettings::load(&config, &paths).commit_after_star(&config));
    }
}
