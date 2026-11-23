//! Hosting optional on-device runtime bundles and managing their server-side downloads.
//!
//! Bundles live under `$WORKSHOP_CACHE/on-device/<id>@<version>/` and are served from
//! `/on-device/<id>@<version>/<file>` (never embedded in the binary and outside `/assets/`).

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderValue, Request, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use tower_http::services::ServeFile;

use super::error::{ApiResult, not_found};
use super::install::{AfterInstall, InstallStatus, install_with};
use super::state::{App, Shared};
use crate::on_device;

#[derive(Serialize)]
pub(super) struct BundleFileInfo {
    name: &'static str,
    path: String,
    size: u64,
    sha256: &'static str,
    content_type: &'static str,
}

#[derive(Serialize)]
pub(super) struct BundleStatus {
    id: &'static str,
    version: &'static str,
    key: String,
    language: &'static str,
    engine: &'static str,
    description: &'static str,
    packages: &'static [String],
    ghc_libdir: &'static str,
    ghc_lib_search_dir: &'static str,
    main_so_path: &'static str,
    total_bytes: u64,
    installed_on_server: bool,
    files: Vec<BundleFileInfo>,
}

#[derive(Serialize)]
pub(super) struct OnDeviceBundlesState {
    bundles: Vec<BundleStatus>,
    download: InstallStatus,
}

pub(super) fn bundles_state(app: &App) -> OnDeviceBundlesState {
    let base = app.paths.on_device_dir();
    let bundles = on_device::catalog()
        .iter()
        .map(|spec| {
            let key = spec.key();
            let files = spec
                .files
                .iter()
                .map(|file| BundleFileInfo {
                    name: &file.name,
                    path: format!("/on-device/{key}/{}", file.name),
                    size: file.size,
                    sha256: &file.sha256,
                    content_type: &file.content_type,
                })
                .collect();
            BundleStatus {
                id: &spec.id,
                version: &spec.version,
                key,
                language: &spec.language,
                engine: &spec.engine,
                description: &spec.description,
                packages: &spec.packages,
                ghc_libdir: &spec.ghc_libdir,
                ghc_lib_search_dir: &spec.ghc_lib_search_dir,
                main_so_path: &spec.main_so_path,
                total_bytes: spec.total_bytes(),
                installed_on_server: on_device::is_installed(&base, spec),
                files,
            }
        })
        .collect();
    OnDeviceBundlesState {
        bundles,
        download: app.on_device_install.status(),
    }
}

pub(super) async fn get_bundles(State(app): State<Shared>) -> ApiResult<OnDeviceBundlesState> {
    Ok(Json(bundles_state(&app)))
}

pub(super) async fn download_bundle(
    State(app): State<Shared>,
    Path(id): Path<String>,
) -> ApiResult<OnDeviceBundlesState> {
    let spec = on_device::find_by_id(&id)
        .ok_or_else(|| not_found(format!("Unknown on-device bundle: {id}")))?;
    install_with(
        &app,
        |app| &app.on_device_install,
        AfterInstall::Nothing,
        move |app, running| async move {
            let base = app.paths.on_device_dir();
            on_device::download_bundle(&base, spec, &running.cancel, &running.log).await
        },
    )
    .await?;
    Ok(Json(bundles_state(&app)))
}

pub(super) async fn cancel_download(State(app): State<Shared>) -> ApiResult<OnDeviceBundlesState> {
    app.on_device_install.cancel();
    Ok(Json(bundles_state(&app)))
}

pub(super) async fn delete_bundle(
    State(app): State<Shared>,
    Path(id): Path<String>,
) -> ApiResult<OnDeviceBundlesState> {
    let spec = on_device::find_by_id(&id)
        .ok_or_else(|| not_found(format!("Unknown on-device bundle: {id}")))?;
    on_device::remove_bundle(&app.paths.on_device_dir(), spec)?;
    Ok(Json(bundles_state(&app)))
}

/// Serves a pinned file from `/on-device/<id>@<version>/<file>` straight from the server's cache.
pub(super) async fn serve_file(
    State(app): State<Shared>,
    Path((bundle_key, file_name)): Path<(String, String)>,
    request: Request<axum::body::Body>,
) -> Response {
    let Some(spec) = on_device::find_by_key(&bundle_key) else {
        return (StatusCode::NOT_FOUND, "Unknown on-device bundle.").into_response();
    };
    let Some(file) = spec.file(&file_name) else {
        return (StatusCode::NOT_FOUND, "Unknown file in on-device bundle.").into_response();
    };
    let path = on_device::file_path(&app.paths.on_device_dir(), spec, file);
    if !path.is_file() {
        return (
            StatusCode::NOT_FOUND,
            "This on-device bundle hasn't been downloaded to the server yet.",
        )
            .into_response();
    }
    let mut response = match ServeFile::new(&path).try_call(request).await {
        Ok(res) => res,
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to read on-device bundle file: {err}"),
            )
                .into_response();
        }
    };
    if response.status().is_success() {
        let headers = response.headers_mut();
        if let Ok(ct) = HeaderValue::from_str(&file.content_type) {
            headers.insert(header::CONTENT_TYPE, ct);
        }
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
        if let Ok(sha) = HeaderValue::from_str(&file.sha256) {
            headers.insert("x-workshop-sha256", sha);
        }
    }
    response.into_response()
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::{StatusCode, header};

    use crate::on_device;
    use crate::server::testing::{send, test_app};

    #[tokio::test]
    async fn lists_bundles_and_serves_pinned_files_from_cache() {
        let (dir, router) = test_app().await;
        let spec = on_device::find_by_id("haskell-ghc-wasm").unwrap();

        let list = send(
            &router,
            Request::get("/api/on-device/bundles")
                .header(header::COOKIE, "workshop_token=secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(list.status(), StatusCode::OK);
        let body = axum::body::to_bytes(list.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["bundles"][0]["id"], "haskell-ghc-wasm");
        assert_eq!(json["bundles"][0]["installed_on_server"], false);

        // Serving an uninstalled bundle returns 404 (not index.html fallback).
        let url = format!("/on-device/{}/bsdtar.wasm", spec.key());
        let missing = send(
            &router,
            Request::get(&url)
                .header(header::COOKIE, "workshop_token=secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);

        // Place a file in the server's cache directory and verify streaming + headers.
        let bdir = dir.path().join("cache").join("on-device").join(spec.key());
        std::fs::create_dir_all(&bdir).unwrap();
        std::fs::write(bdir.join("bsdtar.wasm"), b"fake-wasm").unwrap();

        let served = send(
            &router,
            Request::get(&url)
                .header(header::COOKIE, "workshop_token=secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(served.status(), StatusCode::OK);
        assert_eq!(
            served.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/wasm"
        );
        assert_eq!(
            served.headers().get("x-workshop-sha256").unwrap(),
            spec.file("bsdtar.wasm").unwrap().sha256.as_str()
        );
        let bytes = axum::body::to_bytes(served.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&bytes[..], b"fake-wasm");

        // Unknown file names are rejected with 404.
        let unknown = send(
            &router,
            Request::get(format!("/on-device/{}/other.wasm", spec.key()))
                .header(header::COOKIE, "workshop_token=secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(unknown.status(), StatusCode::NOT_FOUND);

        // DELETE removes the cached bundle directory.
        let deleted = send(
            &router,
            Request::delete("/api/on-device/bundles/haskell-ghc-wasm")
                .header(header::COOKIE, "workshop_token=secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(deleted.status(), StatusCode::OK);
        assert!(!bdir.exists());
    }
}
