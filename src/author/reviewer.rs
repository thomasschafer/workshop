//! Which model reviews the author's items. A reviewer from another provider than the writer's
//! is best, as two runs of the same model share its blind spots, but not everyone has two, so
//! one from the writer's own provider will do. Either way the reviewer is a call of its own,
//! with no tools, that solves each item before it's shown the item's answer.
//!
//! The one set under `[author]` is used if there is one. Otherwise it's the first of
//! [`OTHER_PROVIDERS`] that isn't the writer's and is installed and logged in, or failing that
//! the writer's own provider and model.

use serde::Serialize;
use workshop_common::programs::find_program;
use workshop_provider::ProviderConfig;

use crate::config::{AuthorModel, Config};

/// The reviewers tried, in order, when none is set: each provider's strongest model for
/// solving items.
pub const OTHER_PROVIDERS: &[(&str, &str)] = &[("codex", "sol"), ("claude", "opus")];

/// Why the reviewer is the one it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Why {
    /// Set under `[author]` in the config.
    Configured,
    /// None is set, and another provider than the writer's is installed and logged in.
    OtherProvider,
    /// None is set, and no other provider is installed and logged in.
    SameProvider,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reviewer {
    pub model: AuthorModel,
    pub why: Why,
}

impl Reviewer {
    /// Whether it uses the writer's own provider.
    pub fn shares_provider(&self, config: &Config) -> bool {
        self.model.provider == config.author.writer.provider
    }

    /// Why it was chosen, and what that means, in a sentence, for the Packs page and
    /// `workshop doctor`.
    pub fn reason(&self, config: &Config) -> String {
        let shared = "Two runs of the same model share its blind spots, so a reviewer from another provider would catch more of the writer's mistakes";
        match (self.why, self.shares_provider(config)) {
            (Why::Configured, false) => "The reviewer is set under [author] in your config, and uses another provider than the writer's.".to_owned(),
            (Why::Configured, true) => format!(
                "The reviewer is set under [author] in your config, and uses the writer's own provider. {shared}, if you have one."
            ),
            (Why::OtherProvider, _) => format!(
                "No reviewer is set under [author], so it's {}, another provider than the writer's, as it's installed and logged in.",
                provider_name(config, &self.model.provider)
            ),
            (Why::SameProvider, _) => {
                let others: Vec<String> = candidates(config)
                    .map(|(id, _)| provider_name(config, id))
                    .collect();
                let install = if others.is_empty() {
                    "set one under [author]".to_owned()
                } else {
                    format!("install and log in to {}", others.join(" or "))
                };
                format!(
                    "No reviewer is set under [author], and no other provider is installed and logged in, so it uses the writer's own. {shared}: {install} and it'll be used."
                )
            }
        }
    }
}

/// A model the author uses, as the app and `workshop doctor` name it, such as "opus with Claude
/// Code".
pub fn named(config: &Config, model: &AuthorModel) -> String {
    format!(
        "{} with {}",
        model.model,
        provider_name(config, &model.provider)
    )
}

fn provider_name(config: &Config, id: &str) -> String {
    config
        .providers
        .get(id)
        .map_or(id, |provider| provider.display_name(id))
        .to_owned()
}

/// The reviewers to try when none is set: those of [`OTHER_PROVIDERS`] that aren't the writer's
/// provider and are in the config.
fn candidates(config: &Config) -> impl Iterator<Item = (&'static str, &'static str)> + '_ {
    OTHER_PROVIDERS.iter().copied().filter(|(id, _)| {
        *id != config.author.writer.provider && config.providers.contains_key(*id)
    })
}

/// The reviewer for the config, given which providers are installed and logged in.
pub fn choose(config: &Config, ready: impl Fn(&str) -> bool) -> Reviewer {
    if let Some(model) = &config.author.reviewer {
        return Reviewer {
            model: model.clone(),
            why: Why::Configured,
        };
    }
    match candidates(config).find(|(id, _)| ready(id)) {
        Some((provider, model)) => Reviewer {
            model: AuthorModel {
                provider: provider.to_owned(),
                model: model.to_owned(),
            },
            why: Why::OtherProvider,
        },
        None => Reviewer {
            model: config.author.writer.clone(),
            why: Why::SameProvider,
        },
    }
}

/// The reviewer for the config, checking which providers are installed and logged in only if
/// none is set.
pub async fn chosen(config: &Config) -> Reviewer {
    let mut ready = Vec::new();
    if config.author.reviewer.is_none() {
        for (id, _) in candidates(config) {
            if is_ready(&config.providers[id]).await {
                ready.push(id);
            }
        }
    }
    choose(config, |id| ready.contains(&id))
}

/// Whether a provider's CLI is installed and, if it can say, logged in.
pub async fn is_ready(provider: &ProviderConfig) -> bool {
    let Some(program) = provider.command.first() else {
        return false;
    };
    if find_program(program).is_none() {
        return false;
    }
    match &provider.auth_check_command {
        Some(command) => matches!(crate::doctor::output(command).await, Some((true, _))),
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(author: &str) -> Config {
        Config::parse(&format!("[author]\n{author}")).unwrap()
    }

    #[test]
    fn prefers_another_provider_and_falls_back_to_the_writers() {
        let both = |_: &str| true;
        let none = |_: &str| false;
        // With Claude Code writing, Codex reviews if it's ready, and Claude Code if not.
        let claude = config("");
        let other = choose(&claude, both);
        assert_eq!(
            other,
            Reviewer {
                model: AuthorModel {
                    provider: "codex".into(),
                    model: "sol".into()
                },
                why: Why::OtherProvider
            }
        );
        assert!(!other.shares_provider(&claude));
        assert!(other.reason(&claude).contains("Codex, another provider"));
        let same = choose(&claude, none);
        assert_eq!(same.model, claude.author.writer);
        assert_eq!(same.why, Why::SameProvider);
        assert!(same.shares_provider(&claude));
        let reason = same.reason(&claude);
        assert!(reason.contains("share its blind spots"), "{reason}");
        assert!(reason.contains("install and log in to Codex"), "{reason}");
        // Only another provider's readiness counts.
        assert_eq!(choose(&claude, |id| id == "claude").why, Why::SameProvider);

        // With Codex writing, it's the other way round.
        let codex = config("writer = { provider = \"codex\", model = \"sol\" }");
        assert_eq!(choose(&codex, both).model.provider, "claude");
        assert_eq!(choose(&codex, both).model.model, "opus");
        assert_eq!(choose(&codex, none).model, codex.author.writer);
    }

    #[test]
    fn uses_the_reviewer_set_whatever_is_ready() {
        let set = config("reviewer = { provider = \"claude\", model = \"opus\" }");
        let chosen = choose(&set, |_| true);
        assert_eq!(chosen.why, Why::Configured);
        assert_eq!(chosen.model.provider, "claude");
        assert!(chosen.reason(&set).contains("writer's own provider"));
        let other = config("reviewer = { provider = \"codex\", model = \"sol\" }");
        assert!(
            choose(&other, |_| false)
                .reason(&other)
                .contains("another provider than the writer's")
        );
    }

    #[test]
    fn can_review_with_antigravity() {
        let set =
            config("reviewer = { provider = \"antigravity\", model = \"gemini-4-neon-high\" }");
        let chosen = choose(&set, |_| false);
        assert_eq!(chosen.why, Why::Configured);
        assert_eq!(
            named(&set, &chosen.model),
            "gemini-4-neon-high with Antigravity"
        );
        assert!(!chosen.shares_provider(&set));
    }

    #[test]
    fn says_to_set_a_reviewer_when_theres_no_other_provider_to_try() {
        let mut config = config("");
        config.providers.remove("codex");
        let chosen = choose(&config, |_| true);
        assert_eq!(chosen.why, Why::SameProvider);
        assert!(chosen.reason(&config).contains("set one under [author]"));
    }

    #[tokio::test]
    async fn checks_another_provider_is_installed_and_logged_in() {
        let logged_out = config("")
            .providers
            .remove("codex")
            .map(|mut codex| {
                codex.command = vec!["sh".into()];
                codex.auth_check_command = Some(vec!["sh".into(), "-c".into(), "exit 1".into()]);
                codex
            })
            .unwrap();
        assert!(!is_ready(&logged_out).await);
        let mut logged_in = logged_out.clone();
        logged_in.auth_check_command = Some(vec!["sh".into(), "-c".into(), "exit 0".into()]);
        assert!(is_ready(&logged_in).await);
        let mut missing = logged_in.clone();
        missing.command = vec!["no-such-model-cli".into()];
        assert!(!is_ready(&missing).await);
        let mut silent = logged_in.clone();
        silent.auth_check_command = None;
        assert!(is_ready(&silent).await);

        // Unset, another provider is used only once it's checked.
        let mut auto = config("");
        auto.providers.insert("codex".into(), logged_in);
        assert_eq!(chosen(&auto).await.why, Why::OtherProvider);
        auto.providers.insert("codex".into(), logged_out);
        assert_eq!(chosen(&auto).await.why, Why::SameProvider);

        // Set, nothing's checked.
        let mut set = config("reviewer = { provider = \"codex\", model = \"sol\" }");
        set.providers.insert("codex".into(), missing);
        assert_eq!(chosen(&set).await.why, Why::Configured);
    }
}
