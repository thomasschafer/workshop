//! Turning notifications on and off for a device, and checking they arrive.

use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};

use super::error::{ApiResult, bad_request};
use super::state::Shared;

#[derive(Serialize)]
pub(super) struct NotificationsState {
    /// The key a browser subscribes with.
    public_key: String,
}

pub(super) async fn notifications(State(app): State<Shared>) -> ApiResult<NotificationsState> {
    Ok(Json(NotificationsState {
        public_key: app.notifier.public_key(),
    }))
}

#[derive(Deserialize)]
pub(super) struct EndpointBody {
    endpoint: String,
}

/// Whether a device's subscription is known, as a browser can keep one the server has forgotten.
pub(super) async fn notifications_subscribed(
    State(app): State<Shared>,
    Json(body): Json<EndpointBody>,
) -> ApiResult<bool> {
    Ok(Json(app.notifier.is_subscribed(&body.endpoint)))
}

pub(super) async fn subscribe_notifications(
    State(app): State<Shared>,
    Json(subscription): Json<crate::notify::Subscription>,
) -> ApiResult<()> {
    app.notifier
        .subscribe(subscription)
        .map_err(|e| bad_request(format!("{e:#}")))?;
    Ok(Json(()))
}

pub(super) async fn unsubscribe_notifications(
    State(app): State<Shared>,
    Json(body): Json<EndpointBody>,
) -> ApiResult<()> {
    app.notifier.unsubscribe(&body.endpoint)?;
    Ok(Json(()))
}

/// Sends a notification straight away, so a device can check they arrive.
pub(super) async fn test_notification(
    State(app): State<Shared>,
    Json(subscription): Json<crate::notify::Subscription>,
) -> ApiResult<()> {
    let message = crate::notify::Message {
        title: "Workshop".into(),
        body: "Notifications work: you'll hear when each puzzle unlocks.".into(),
        url: "/".into(),
    };
    match app.notifier.send(&subscription, &message).await? {
        crate::notify::Delivery::Sent => Ok(Json(())),
        crate::notify::Delivery::Gone => Err(bad_request(
            "The browser has ended this device's notifications. Turn them off and on again.",
        )),
    }
}
