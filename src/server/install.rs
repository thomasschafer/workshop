//! Installs that run in the background, one at a time, such as of packages, a language's programs
//! or Whisper's model.

use std::sync::Arc;

use anyhow::{Context, Result};
use axum::http::StatusCode;
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use super::error::ApiError;
use super::state::{App, Shared, lock};
use crate::packages::InstallLog;

pub(super) struct RunningInstall {
    pub(super) cancel: CancellationToken,
    pub(super) log: InstallLog,
}

#[derive(Clone, Serialize)]
pub(super) struct LastInstall {
    succeeded: bool,
    log: Vec<String>,
}

/// One kind of install, such as of packages, run one at a time in the background.
#[derive(Default)]
pub(super) struct Installs {
    /// The install under way, to follow or cancel.
    running: std::sync::Mutex<Option<Arc<RunningInstall>>>,
    /// How the last install ended, and its output.
    last: std::sync::Mutex<Option<LastInstall>>,
}

#[derive(Serialize)]
pub(super) struct InstallStatus {
    installing: bool,
    /// The installer's latest line of output, while installing.
    progress: Option<String>,
    last_install: Option<LastInstall>,
}

impl Installs {
    pub(super) fn status(&self) -> InstallStatus {
        let running = lock(&self.running).clone();
        InstallStatus {
            installing: running.is_some(),
            progress: running.and_then(|r| r.log.last()),
            last_install: lock(&self.last).clone(),
        }
    }

    pub(super) fn cancel(&self) {
        if let Some(running) = lock(&self.running).as_ref() {
            running.cancel.cancel();
        }
    }
}

/// What to restart once an install succeeds.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum AfterInstall {
    /// Language servers, so they see what was installed.
    RestartLanguageServers,
    Nothing,
}

/// Runs an install in its own task, so it finishes even if the phone disconnects while waiting.
pub(super) async fn install_with<T, Job, Fut>(
    app: &Shared,
    installs: fn(&App) -> &Installs,
    after: AfterInstall,
    job: Job,
) -> Result<T, ApiError>
where
    Job: FnOnce(Shared, Arc<RunningInstall>) -> Fut,
    Fut: std::future::Future<Output = Result<T>> + Send + 'static,
    T: Send + 'static,
{
    let Ok(guard) = app.install_lock.clone().try_lock_owned() else {
        return Err(ApiError(
            StatusCode::CONFLICT,
            serde_json::json!({ "error": "Something is already being installed." }),
        ));
    };
    let running = Arc::new(RunningInstall {
        cancel: CancellationToken::new(),
        log: InstallLog::default(),
    });
    *lock(&installs(app).running) = Some(running.clone());
    let installing = job(app.clone(), running.clone());
    let app = app.clone();
    let task = tokio::spawn(async move {
        let _guard = guard;
        let result = installing.await;
        // The error itself already quotes the end of the output.
        if let Err(err) = &result {
            running
                .log
                .push(err.to_string().lines().next().unwrap_or_default());
        }
        let installs = installs(&app);
        *lock(&installs.last) = Some(LastInstall {
            succeeded: result.is_ok(),
            log: running.log.lines(),
        });
        *lock(&installs.running) = None;
        if result.is_ok() && after == AfterInstall::RestartLanguageServers {
            app.lsp_restarts.send_modify(|n| *n += 1);
        }
        result
    });
    Ok(task.await.context("the install stopped unexpectedly")??)
}
