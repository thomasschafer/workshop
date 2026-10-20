//! How a request that fails is reported to the app.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

// Errors are shown to the user, so they carry the full context chain.
pub(super) struct ApiError(pub(super) StatusCode, pub(super) serde_json::Value);

impl From<anyhow::Error> for ApiError {
    fn from(err: anyhow::Error) -> Self {
        tracing::warn!("{err:#}");
        // So the app can offer to log in, rather than only saying so.
        if let Some(login) = err
            .chain()
            .find_map(|e| e.downcast_ref::<crate::aoc::NeedsLogin>())
        {
            return Self(
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "error": login.to_string(), "action": "login" }),
            );
        }
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            serde_json::json!({ "error": format!("{err:#}") }),
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(self.1)).into_response()
    }
}

pub(super) type ApiResult<T> = Result<Json<T>, ApiError>;

/// A request that can't be carried out as asked, with a reason to show the user.
pub(super) fn bad_request(message: impl Into<String>) -> ApiError {
    ApiError(
        StatusCode::BAD_REQUEST,
        serde_json::json!({ "error": message.into() }),
    )
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::{StatusCode, header};

    use crate::server::testing::{send, test_app};

    #[tokio::test]
    async fn offers_to_log_in_when_advent_of_code_needs_it() {
        let (_dir, router) = test_app().await;
        let request = Request::get("/api/puzzles/2017/4/input")
            .header(header::COOKIE, "workshop_token=secret")
            .body(Body::empty())
            .unwrap();
        let response = send(&router, request).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["action"], "login");
    }
}
