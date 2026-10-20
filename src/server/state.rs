//! What every request shares: the config, the solutions, the model runners and what's under way.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::install::Installs;
use crate::aoc::AocClient;
use crate::config::Config;
use crate::edit;
use crate::language::LanguageProfile;
use crate::models::ModelSettings;
use crate::packages::Resolution;
use crate::paths::Paths;
use crate::provider::{CallSpec, ProviderRunner, Role};
use crate::settings::AppSettings;
use crate::solutions::Solutions;
use crate::workspace::Workspace;

pub struct App {
    pub(super) config: Config,
    pub(super) paths: Paths,
    pub(super) token: String,
    pub(super) workspace: Workspace,
    pub(super) aoc: AocClient,
    /// One per provider, each keeping its own process ready.
    pub(super) runners: BTreeMap<String, ProviderRunner>,
    settings: std::sync::RwLock<AppSettings>,
    pub(super) run_lock: Mutex<()>,
    /// Cancels the run in progress, if there is one.
    pub(super) current_run: std::sync::Mutex<Option<CancellationToken>>,
    /// Held while anything is being installed, as packages need the toolchain.
    pub(super) install_lock: Arc<Mutex<()>>,
    pub(super) packages_install: Installs,
    /// Installing the language's programs with mise.
    pub(super) toolchain_install: Installs,
    /// Downloading Whisper's model for dictation.
    pub(super) speech_install: Installs,
    pub(super) dictation: Arc<crate::whisper::Dictation>,
    /// Notifies devices that asked, as puzzles unlock.
    pub notifier: Arc<crate::notify::Notifier>,
    /// Whether a newer release is out.
    pub updates: Arc<crate::updates::Updates>,
    /// Packages already found for missing modules, by language and module.
    pub(super) resolutions: std::sync::Mutex<BTreeMap<(String, String), Resolution>>,
    pub(super) http: reqwest::Client,
    /// Changed to restart language servers, such as after installing packages.
    pub(super) lsp_restarts: tokio::sync::watch::Sender<u64>,
}

pub(super) type Shared = Arc<App>;

impl App {
    pub fn new(
        config: Config,
        paths: Paths,
        token: String,
        aoc_session: Option<String>,
    ) -> Result<Self> {
        let model_dir = paths.cache_dir.join("model-cwd");
        let runners = config
            .providers
            .iter()
            .map(|(id, provider)| {
                Ok((
                    id.clone(),
                    ProviderRunner::new(provider.clone(), model_dir.clone())?,
                ))
            })
            .collect::<Result<_>>()?;
        Ok(Self {
            workspace: Workspace::new(config.solutions_dir.clone(), paths.clone()),
            aoc: crate::solutions::aoc_client(&config, &paths, aoc_session)?,
            runners,
            settings: std::sync::RwLock::new(AppSettings::load(&config, &paths)),
            run_lock: Mutex::new(()),
            current_run: std::sync::Mutex::new(None),
            install_lock: Arc::new(Mutex::new(())),
            packages_install: Installs::default(),
            toolchain_install: Installs::default(),
            speech_install: Installs::default(),
            dictation: Arc::default(),
            notifier: Arc::new(crate::notify::Notifier::load(&paths)?),
            updates: Arc::new(crate::updates::Updates::load(
                &paths,
                config.server.check_for_updates,
            )),
            resolutions: std::sync::Mutex::new(BTreeMap::new()),
            http: reqwest::Client::builder()
                .user_agent(&config.aoc.user_agent)
                .timeout(Duration::from_secs(15))
                .build()?,
            lsp_restarts: tokio::sync::watch::Sender::new(0),
            config,
            paths,
            token,
        })
    }

    pub(super) fn settings(&self) -> AppSettings {
        self.settings
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub(super) fn model_settings(&self) -> ModelSettings {
        self.settings().models
    }

    /// The language chosen in the app, or the config's.
    pub(super) fn language(&self) -> &LanguageProfile {
        &self.config.languages[&self.settings().language]
    }

    /// Solutions in the chosen language: their toolchain, packages, environment and how to run
    /// them.
    pub(super) async fn solutions(&self) -> Result<Solutions<'_>> {
        Solutions::load(&self.config, &self.paths, self.settings().language).await
    }

    pub(super) fn update_settings(&self, change: impl FnOnce(&mut AppSettings)) -> Result<()> {
        let mut settings = self
            .settings
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut next = settings.clone();
        change(&mut next);
        next.validate(&self.config)?;
        next.save(&self.paths)?;
        *settings = next;
        Ok(())
    }

    /// The runner and call for the chosen edit model.
    pub(super) fn edit_target(&self) -> (&ProviderRunner, CallSpec) {
        let choice = self.model_settings().edit;
        let spec = self.config.providers[&choice.provider].spec(
            Role::Edit,
            &choice.model,
            edit::system_prompt(self.language()),
        );
        (&self.runners[&choice.provider], spec)
    }

    pub(super) async fn warm_edit_model(&self) {
        let (runner, spec) = self.edit_target();
        if let Err(err) = runner.warm(&spec).await {
            tracing::warn!("couldn't start the edit model: {err:#}");
        }
    }

    /// Gets ready for the first edit. The solutions repo isn't created until a puzzle is
    /// opened, so it isn't made somewhere the user hasn't seen yet.
    pub async fn warm_up(&self) {
        self.warm_edit_model().await;
    }
}

/// Locks a mutex that guards plain data, which stays usable even if a holder panicked.
pub(super) fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
