//! The editor's connection to the language server, and the file URIs it knows files by.

use axum::extract::{State, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use super::state::Shared;

pub(super) async fn lsp(State(app): State<Shared>, upgrade: WebSocketUpgrade) -> Response {
    let Some(command) = app.language().lsp.clone() else {
        return (StatusCode::NOT_FOUND, "No language server is configured").into_response();
    };
    upgrade.on_upgrade(move |socket| async move {
        // Without them, a new user's language server complains there's no project.
        let project = async {
            app.workspace.ensure_repo().await?;
            app.workspace.ensure_project(app.language())
        };
        if let Err(err) = project.await {
            tracing::warn!("language server: {err:#}");
        }
        let environment = match app.solutions().await.and_then(|s| s.environment()) {
            Ok(environment) => environment,
            Err(err) => {
                tracing::warn!("language server: {err:#}");
                Vec::new()
            }
        };
        let restart = app.lsp_restarts.subscribe();
        if let Err(err) = crate::lsp::relay(
            socket,
            &command,
            &app.config.solutions_dir,
            &environment,
            restart,
        )
        .await
        {
            tracing::warn!("language server: {err:#}");
        }
    })
}

pub(super) fn file_uri(path: &std::path::Path) -> String {
    let path = path.to_string_lossy().replace('\\', "/");
    let encoded: Vec<String> = path
        .split('/')
        .map(|segment| urlencoding::encode(segment).into_owned())
        .collect();
    let joined = encoded.join("/");
    if joined.starts_with('/') {
        format!("file://{joined}")
    } else {
        format!("file:///{joined}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn makes_file_uris() {
        assert_eq!(
            file_uri(std::path::Path::new("/a b/Main.hs")),
            "file:///a%20b/Main.hs"
        );
    }
}
