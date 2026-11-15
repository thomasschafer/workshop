//! The editor's connection to the language server, and the file URIs it knows files by.

use axum::Json;
use axum::extract::{State, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use super::error::ApiResult;
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
        let help = install_help(app.language(), "Setup", "");
        let relayed = app.lsp_servers.relay(
            socket,
            &command,
            &app.config.solutions_dir,
            &environment,
            &help,
            restart,
        );
        if let Err(err) = relayed.await {
            tracing::warn!("language server: {err:#}");
        }
    })
}

/// How to install a language server that isn't there, for the editor to show when it can't start:
/// with mise, by `who`, along with the rest of the language's programs `for_what`, if Workshop
/// knows how.
pub(super) fn install_help(
    profile: &crate::language::LanguageProfile,
    who: &str,
    for_what: &str,
) -> String {
    match &profile.toolchain {
        Some(_) => format!(
            "{who} can install it with mise, with the rest of {}'s programs{for_what}. Then try again.",
            profile.name
        ),
        None => "Install it on the computer Workshop runs on, then try again.".to_owned(),
    }
}

/// Restarts every language server, such as one that's stopped answering: each editor connected to
/// one reconnects to a fresh server, and those kept for an editor to come back to are stopped.
pub(super) async fn restart(State(app): State<Shared>) -> ApiResult<()> {
    app.lsp_restarts.send_modify(|n| *n += 1);
    Ok(Json(()))
}

pub(crate) fn file_uri(path: &std::path::Path) -> String {
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

    #[tokio::test]
    async fn restarting_tells_the_language_servers_to_restart() {
        use axum::body::Body;
        use axum::extract::Request;
        use axum::http::header;

        use crate::server::router;
        use crate::server::testing::{send, test_state_in};

        let dir = tempfile::tempdir().unwrap();
        let app = test_state_in(dir.path(), "");
        let restarts = app.lsp_restarts.subscribe();
        let router = router(app);
        let request = Request::builder()
            .method("POST")
            .uri("/api/lsp/restart")
            .header(header::COOKIE, "workshop_token=secret")
            .body(Body::empty())
            .unwrap();
        let response = send(&router, request).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(restarts.has_changed().unwrap());
    }

    #[test]
    fn makes_file_uris() {
        assert_eq!(
            file_uri(std::path::Path::new("/a b/Main.hs")),
            "file:///a%20b/Main.hs"
        );
    }
}
