//! The chosen language's packages: the manifest, installing what it lists, and finding the
//! package for a missing module.

use anyhow::{Context, Result};
use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};

use super::error::{ApiError, ApiResult, bad_request};
use super::install::{AfterInstall, InstallStatus, install_with};
use super::state::{App, Shared, lock};
use crate::packages::{Change, Packages, PackagesState, Resolution};

#[derive(Serialize)]
pub(super) struct PackagesResponse {
    /// None when the language has no packages beyond its standard library.
    state: Option<PackagesState>,
    #[serde(flatten)]
    install: InstallStatus,
}

async fn packages_response(app: &App) -> Result<PackagesResponse> {
    Ok(PackagesResponse {
        state: app
            .solutions()
            .await?
            .packages()
            .map(|p| p.state())
            .transpose()?,
        install: app.packages_install.status(),
    })
}

async fn require_packages(app: &App) -> Result<Packages<'_>, ApiError> {
    app.solutions().await?.packages().ok_or_else(|| {
        bad_request(format!(
            "{} has no packages to install.",
            app.language().name
        ))
    })
}

pub(super) async fn get_packages(State(app): State<Shared>) -> ApiResult<PackagesResponse> {
    Ok(Json(packages_response(&app).await?))
}

#[derive(Deserialize)]
pub(super) struct ManifestBody {
    text: String,
}

pub(super) async fn save_packages(
    State(app): State<Shared>,
    Json(body): Json<ManifestBody>,
) -> ApiResult<PackagesResponse> {
    require_packages(&app)
        .await?
        .save_manifest(&body.text)
        .map_err(|e| bad_request(format!("{e:#}")))?;
    Ok(Json(packages_response(&app).await?))
}

#[derive(Deserialize)]
pub(super) struct PackageBody {
    package: String,
}

pub(super) async fn add_package(
    State(app): State<Shared>,
    Json(body): Json<PackageBody>,
) -> ApiResult<PackagesResponse> {
    change_packages(app, Some(Change::Add(body.package))).await
}

pub(super) async fn remove_package(
    State(app): State<Shared>,
    Json(body): Json<PackageBody>,
) -> ApiResult<PackagesResponse> {
    change_packages(app, Some(Change::Remove(body.package))).await
}

pub(super) async fn cancel_install(State(app): State<Shared>) -> ApiResult<()> {
    app.packages_install.cancel();
    Ok(Json(()))
}

#[derive(Deserialize)]
pub(super) struct ResolveBody {
    module: String,
}

/// Finds the package for a missing module, looking it up online if the language says how.
pub(super) async fn resolve_package(
    State(app): State<Shared>,
    Json(body): Json<ResolveBody>,
) -> ApiResult<Resolution> {
    let key = (app.settings().language, body.module.clone());
    if let Some(found) = lock(&app.resolutions).get(&key) {
        return Ok(Json(found.clone()));
    }
    let resolution = require_packages(&app)
        .await?
        .resolve(&body.module, &app.http)
        .await?;
    lock(&app.resolutions).insert(key, resolution.clone());
    Ok(Json(resolution))
}

/// Installs the manifest's packages.
pub(super) async fn install_packages(State(app): State<Shared>) -> ApiResult<PackagesResponse> {
    change_packages(app, None).await
}

/// Adds or removes a package, if asked to, then installs what's listed.
async fn change_packages(app: Shared, change: Option<Change>) -> ApiResult<PackagesResponse> {
    if let Some(change) = &change {
        require_packages(&app)
            .await?
            .check(change)
            .map_err(|e| bad_request(format!("{e:#}")))?;
    } else {
        require_packages(&app).await?;
    }
    let installed: Vec<String> = install_with(
        &app,
        |app| &app.packages_install,
        AfterInstall::RestartLanguageServers,
        |app, running| async move {
            let packages = app
                .solutions()
                .await?
                .packages()
                .context("the language has no packages")?;
            packages
                .apply(change.as_ref(), &running.cancel, &running.log)
                .await
        },
    )
    .await?;
    tracing::info!("installed packages: {}", installed.join(" "));
    Ok(Json(packages_response(&app).await?))
}
