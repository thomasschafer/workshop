//! What every request shares: the config, the solutions, the model runners and what's under way.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use workshop_provider::{CallSpec, ProviderRunner, Role};
use workshop_toolchain::packages::Resolution;

use super::install::Installs;
use crate::aoc::AocClient;
use crate::config::Config;
use crate::edit;
use crate::language::LanguageProfile;
use crate::models::ModelSettings;
use crate::paths::Paths;
use crate::settings::AppSettings;
use crate::solutions::Solutions;
use crate::workspace::Workspace;

/// The run in progress, if there is one, and its client-supplied ID for safe cancellation.
pub(super) struct ActiveRun {
    pub(super) id: Option<String>,
    pub(super) cancel: CancellationToken,
}

/// Status of a background Advent of Code prefetch for a year.
#[derive(Debug, Clone, Default)]
pub(super) struct YearCacheState {
    pub(super) caching: bool,
    pub(super) error: Option<String>,
}

pub struct App {
    pub(super) config: Config,
    pub(super) paths: Paths,
    /// Who may use the server.
    pub(super) gate: Arc<workshop_auth::Gate>,
    pub(super) workspace: Workspace,
    pub(super) aoc: AocClient,
    /// One per provider, each keeping its own process ready.
    pub(super) runners: BTreeMap<String, ProviderRunner>,
    settings: std::sync::RwLock<AppSettings>,
    pub(super) run_lock: Mutex<()>,
    /// Cancels the run in progress, if there is one.
    pub(super) current_run: std::sync::Mutex<Option<ActiveRun>>,
    /// Held while anything is being installed, as packages need the toolchain.
    pub(super) install_lock: Arc<Mutex<()>>,
    pub(super) packages_install: Installs,
    /// Installing the language's programs with mise.
    pub(super) toolchain_install: Installs,
    /// Installing each of the Coding track's languages' programs with mise.
    pub(super) coding_toolchain_installs: BTreeMap<workshop_pack::Language, Installs>,
    /// Downloading Whisper's model for dictation.
    pub(super) speech_install: Installs,
    pub(super) dictation: Arc<crate::whisper::Dictation>,
    /// Notifies devices that asked, as puzzles unlock.
    pub notifier: Arc<workshop_push::Notifier>,
    /// Whether a newer release is out.
    pub updates: Arc<crate::updates::Updates>,
    /// Packages already found for missing modules, by language and module.
    pub(super) resolutions: std::sync::Mutex<BTreeMap<(String, String), Resolution>>,
    pub(super) http: reqwest::Client,
    /// Changed to restart language servers, such as after installing packages.
    pub(super) lsp_restarts: tokio::sync::watch::Sender<u64>,
    /// Language servers whose editors have gone, kept for the next to take over.
    pub(super) lsp_servers: workshop_lsp::Servers,
    /// The short items from packs, and what's been done with them.
    pub(super) learning: crate::learning::Learning,
    /// Coding problems' sessions and drafts.
    pub(super) problems: crate::coding::Problems,
    /// Design prompts' sessions, worked through in stages.
    pub(super) design_sessions: workshop_sessions::Saved<workshop_sessions::design::Session>,
    /// Timed rounds under way, by item.
    pub(super) rounds: workshop_sessions::Saved<workshop_sessions::round::Round>,
    /// Fixes to cards the grader has proposed, waiting for approval.
    pub(super) card_fixes: crate::grader::Fixes,
    /// The author's queue, questions and last run.
    pub(super) author: crate::author::Desk,
    /// Whether the author is running from the app.
    pub(super) author_running: std::sync::atomic::AtomicBool,
    /// The author's reviewer as last chosen, and when, as choosing it can mean checking which
    /// providers are installed and logged in.
    pub(super) author_reviewer:
        tokio::sync::Mutex<Option<(std::time::Instant, crate::author::reviewer::Reviewer)>>,
    /// Each coding problem's brute force and inputs program, built, with the random cases made
    /// with them so far, by item and what's in them.
    pub(super) oracles: tokio::sync::Mutex<BTreeMap<String, Arc<workshop_coding::Oracle>>>,
    /// Held while the tutor poses a twist, so a review asked for twice gets only the one.
    pub(super) posing_twist: tokio::sync::Mutex<()>,
    /// Background prefetch jobs for saving a year's AoC puzzles offline.
    pub(super) year_cache: std::sync::Mutex<BTreeMap<u16, YearCacheState>>,
    /// Whether background pre-computation of coding oracle cases for offline bundles is running.
    pub(super) oracle_precompute_running: std::sync::atomic::AtomicBool,
}

pub(super) type Shared = Arc<App>;

/// What a browser fetches to install Workshop as an app, which may be before it has the token,
/// and which holds nothing private.
const PUBLIC_ASSETS: &[&str] = &[
    "/manifest.webmanifest",
    "/sw.js",
    "/icon-192.png",
    "/icon-512.png",
    "/icon-maskable-512.png",
    "/apple-touch-icon.png",
];

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
            coding_toolchain_installs: workshop_pack::Language::ALL
                .into_iter()
                .map(|language| (language, Installs::default()))
                .collect(),
            speech_install: Installs::default(),
            dictation: Arc::default(),
            notifier: Arc::new(workshop_push::Notifier::load(&paths.data_dir)?),
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
            lsp_servers: workshop_lsp::Servers::default(),
            learning: crate::learning::Learning::open(&config.learning, &paths.data_dir)?,
            problems: crate::coding::Problems::new(&paths.data_dir),
            design_sessions: workshop_sessions::Saved::new(
                paths.data_dir.join("design").join("sessions"),
            ),
            rounds: workshop_sessions::Saved::new(paths.data_dir.join("rounds")),
            card_fixes: crate::grader::Fixes::new(&paths.data_dir),
            author: crate::author::Desk::new(&paths.data_dir),
            author_running: std::sync::atomic::AtomicBool::new(false),
            author_reviewer: tokio::sync::Mutex::default(),
            oracles: tokio::sync::Mutex::default(),
            posing_twist: tokio::sync::Mutex::default(),
            year_cache: std::sync::Mutex::new(BTreeMap::new()),
            oracle_precompute_running: std::sync::atomic::AtomicBool::new(false),
            config,
            paths,
            gate: Arc::new(workshop_auth::Gate::new(token, PUBLIC_ASSETS)),
        })
    }

    /// The author's reviewer, chosen again once what was checked is a few minutes old.
    pub(super) async fn author_reviewer(&self) -> crate::author::reviewer::Reviewer {
        const FRESH_FOR: Duration = Duration::from_secs(5 * 60);
        let mut kept = self.author_reviewer.lock().await;
        if let Some((at, reviewer)) = kept.as_ref()
            && at.elapsed() < FRESH_FOR
        {
            return reviewer.clone();
        }
        let reviewer = crate::author::reviewer::chosen(&self.config).await;
        *kept = Some((std::time::Instant::now(), reviewer.clone()));
        reviewer
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

    /// The runner and call for the grader: its own model if one's chosen, in the app or the
    /// config, or else the discussion provider's first, with the pack's add-on to the grader's
    /// instructions.
    pub(super) fn grader_target(
        &self,
        add_on: Option<&str>,
    ) -> Result<(&ProviderRunner, CallSpec)> {
        let system = crate::grader::system_prompt(add_on);
        match self.model_settings().grader(&self.config) {
            Some(grader) => {
                let spec = self.config.providers[&grader.provider].spec(
                    Role::Discuss,
                    &grader.model,
                    system,
                );
                Ok((&self.runners[&grader.provider], spec))
            }
            None => self.coach_target(system),
        }
    }

    /// The runner and call for a coach that isn't talked to through the discussion screen, such
    /// as the grader or the examiner: the discussion provider's first model, with these
    /// instructions.
    pub(super) fn coach_target(&self, system: String) -> Result<(&ProviderRunner, CallSpec)> {
        let provider = self.model_settings().discuss_provider;
        let model = crate::models::discuss_models(&self.config, &provider)
            .into_iter()
            .next()
            .with_context(|| format!("{provider} has no discussion models to coach with"))?;
        let spec = self.config.providers[&provider].spec(Role::Discuss, &model, system);
        Ok((&self.runners[&provider], spec))
    }

    /// The runner and call for the tutor posing a twist on a problem: the discussion
    /// provider's first model, with the tutor's instructions and the pack's add-on to them.
    /// Fails if there's no model to pose one with.
    pub(super) fn twist_target(&self, add_on: Option<&str>) -> Result<(&ProviderRunner, CallSpec)> {
        self.coach_target(crate::discuss::tutor_system_prompt(add_on))
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
