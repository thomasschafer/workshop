//! Getting Workshop ready: what's installed and logged in, choosing a language, the Advent of
//! Code session, installing the language's programs, and the link for a phone.

use anyhow::{Context, Result};
use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};

use super::error::{ApiResult, bad_request};
use super::install::{AfterInstall, InstallStatus, install_with};
use super::state::Shared;
use crate::doctor;
use crate::models;
use crate::toolchain::Toolchain;

pub(super) async fn run_doctor(State(app): State<Shared>) -> ApiResult<Vec<doctor::Check>> {
    Ok(Json(
        doctor::run(&app.config, &app.paths, app.aoc.has_session()).await,
    ))
}

#[derive(Serialize)]
pub(super) struct SetupState {
    /// Where solutions are saved, as shown to the user.
    solutions_dir: String,
    /// Whether that's a git repo yet, which it becomes when a puzzle is first opened.
    solutions_repo_exists: bool,
    /// The config file, where the solutions directory can be changed.
    config_file: String,
    languages: Vec<LanguageOption>,
    language: String,
    has_aoc_session: bool,
    providers: Vec<ProviderStatus>,
    tailscale_installed: bool,
    /// Whether mise is installed, to install a language's programs with.
    mise_installed: bool,
    /// Why the solutions directory's mise config couldn't be read, if it couldn't.
    toolchain_problem: Option<String>,
    /// Installing the chosen language's programs with mise.
    toolchain_install: InstallStatus,
    /// The address to open on a phone, with the token, if Tailscale is serving Workshop.
    phone_url: Option<String>,
    /// `phone_url` as a QR code, in SVG.
    phone_qr_svg: Option<String>,
    port: u16,
}

#[derive(Serialize)]
struct LanguageOption {
    id: String,
    name: String,
    /// Programs it needs that aren't installed.
    missing: Vec<String>,
    /// The language server, if it isn't installed. Workshop works without it.
    missing_language_server: Option<String>,
    /// Whether setup can install its programs with mise.
    installable: bool,
}

#[derive(Serialize)]
struct ProviderStatus {
    id: String,
    name: String,
    installed: bool,
    /// Unknown if the provider has no way to check.
    logged_in: Option<bool>,
    install_hint: Option<String>,
}

pub(super) async fn setup_state(State(app): State<Shared>) -> ApiResult<SetupState> {
    let (toolchain, toolchain_problem) = match Toolchain::load(&app.config.solutions_dir).await {
        Ok(toolchain) => (toolchain, None),
        Err(err) => (Toolchain::default(), Some(format!("{err:#}"))),
    };
    let languages = app
        .config
        .languages
        .iter()
        .map(|(id, profile)| LanguageOption {
            id: id.clone(),
            name: profile.name.clone(),
            missing: profile
                .required_programs()
                .into_iter()
                .filter(|p| toolchain.find_program(p).is_none())
                .map(str::to_owned)
                .collect(),
            missing_language_server: profile
                .lsp
                .as_ref()
                .and_then(|c| c.first())
                .filter(|p| toolchain.find_program(p).is_none())
                .cloned(),
            installable: profile.toolchain.is_some(),
        })
        .collect();
    let providers =
        futures_util::future::join_all(models::options(&app.config).into_iter().map(|option| {
            let provider = &app.config.providers[&option.id];
            async move {
                let installed = option.unavailable.is_none();
                let logged_in = match (&provider.auth_check_command, installed) {
                    (Some(command), true) => doctor::output(command).await.map(|(ok, _)| ok),
                    _ => None,
                };
                ProviderStatus {
                    id: option.id,
                    name: option.name,
                    installed,
                    logged_in,
                    install_hint: provider.install_hint.clone(),
                }
            }
        }))
        .await;
    let port = app.config.server.bind.port();
    let phone_url = crate::tailscale::serving_url(port)
        .await
        .map(|base| format!("{base}/?token={}", app.token));
    let phone_qr_svg = phone_url.as_deref().map(qr_svg).transpose()?;
    Ok(Json(SetupState {
        solutions_dir: crate::paths::display_path(&app.config.solutions_dir),
        solutions_repo_exists: app.config.solutions_dir.join(".git").exists(),
        config_file: crate::paths::display_path(&app.paths.config_file()),
        languages,
        language: app.settings().language,
        has_aoc_session: app.aoc.has_session(),
        providers,
        tailscale_installed: crate::tailscale::program().is_some(),
        mise_installed: doctor::find_program("mise").is_some(),
        toolchain_problem,
        toolchain_install: app.toolchain_install.status(),
        phone_url,
        phone_qr_svg,
        port,
    }))
}

fn qr_svg(text: &str) -> Result<String> {
    let code = qrcode::QrCode::new(text.as_bytes()).context("making a QR code")?;
    Ok(code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(220, 220)
        .quiet_zone(true)
        .build())
}

#[derive(Deserialize)]
pub(super) struct LanguageBody {
    language: String,
}

/// Changes the language. The page reloads afterwards, as the editor and language server depend
/// on it.
pub(super) async fn set_language(
    State(app): State<Shared>,
    Json(body): Json<LanguageBody>,
) -> ApiResult<()> {
    app.update_settings(|s| s.language = body.language)
        .map_err(|e| bad_request(format!("{e:#}")))?;
    let warm = app.clone();
    tokio::spawn(async move { warm.warm_edit_model().await });
    Ok(Json(()))
}

#[derive(Deserialize)]
pub(super) struct SessionBody {
    session: String,
}

/// Checks a pasted Advent of Code session cookie, then saves it where only the user can read it.
pub(super) async fn set_aoc_session(
    State(app): State<Shared>,
    Json(body): Json<SessionBody>,
) -> ApiResult<()> {
    let session = body
        .session
        .trim()
        .trim_start_matches("session=")
        .to_owned();
    if session.is_empty() || session.contains(char::is_whitespace) {
        return Err(bad_request(
            "Paste just the cookie's value, a long string of letters and numbers.",
        ));
    }
    app.aoc.check_session(&session).await?;
    crate::paths::write_private(&app.paths.aoc_session_file(), session.as_bytes())?;
    app.aoc.set_session(session);
    Ok(Json(()))
}

/// Installs the chosen language's programs with mise, into the solutions directory.
pub(super) async fn install_toolchain(State(app): State<Shared>) -> ApiResult<SetupState> {
    if app.language().toolchain.is_none() {
        return Err(bad_request(format!(
            "Workshop doesn't know how to install {} with mise.",
            app.language().name
        )));
    }
    install_with(
        &app,
        |app| &app.toolchain_install,
        AfterInstall::RestartLanguageServers,
        |app, running| async move {
            let profile = app
                .language()
                .toolchain
                .clone()
                .context("the language has no toolchain")?;
            crate::toolchain::install(
                &profile,
                &app.config.solutions_dir,
                &running.cancel,
                &running.log,
            )
            .await
        },
    )
    .await?;
    tracing::info!("installed {} with mise", app.language().name);
    setup_state(State(app)).await
}

pub(super) async fn cancel_toolchain_install(State(app): State<Shared>) -> ApiResult<()> {
    app.toolchain_install.cancel();
    Ok(Json(()))
}
