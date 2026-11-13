//! Notifications sent with Web Push to devices that asked for them, so a phone hears even when
//! Workshop isn't open on it.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use web_push_native::WebPushBuilder;
use web_push_native::jwt_simple::algorithms::{ECDSAP256PublicKeyLike, ES256KeyPair};
use workshop_common::files::write_private;

/// Who to contact about these notifications, which push services ask senders for.
const CONTACT: &str = "https://github.com/thomasschafer/workshop";

/// How long a push service should keep trying to deliver: what's sent is stale after a day.
const TIME_TO_LIVE: Duration = Duration::from_secs(24 * 60 * 60);

/// A device's subscription, as its browser gives it: where to send, and the keys to encrypt to.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Subscription {
    pub endpoint: String,
    pub keys: SubscriptionKeys,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SubscriptionKeys {
    pub p256dh: String,
    pub auth: String,
}

/// What a notification says, which the app's service worker shows.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Message {
    pub title: String,
    pub body: String,
    /// Opened when the notification is tapped.
    pub url: String,
}

/// How a push service answered.
#[derive(Debug, PartialEq, Eq)]
pub enum Delivery {
    Sent,
    /// The subscription has ended, such as when notifications were turned off in the browser,
    /// so it's forgotten.
    Gone,
}

/// Devices that asked for notifications, and the key that signs what's sent to them.
pub struct Notifier {
    key: ES256KeyPair,
    subscriptions: Mutex<Vec<Subscription>>,
    file: PathBuf,
    http: reqwest::Client,
}

impl Notifier {
    /// The notifier for this server, keeping its signing key and devices in `data_dir`, and
    /// making the key the first time.
    pub fn load(data_dir: &Path) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()?;
        let key_file = data_dir.join("push-key");
        let key = match std::fs::read(&key_file) {
            Ok(bytes) => ES256KeyPair::from_bytes(&bytes)
                .map_err(|e| anyhow::anyhow!("{e}"))
                .with_context(|| format!("reading {}", key_file.display()))?,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                let key = ES256KeyPair::generate();
                write_private(&key_file, &key.to_bytes())?;
                key
            }
            Err(err) => return Err(err).with_context(|| format!("reading {}", key_file.display())),
        };
        let file = data_dir.join("push-subscriptions.json");
        let subscriptions = match std::fs::read_to_string(&file) {
            Ok(json) => serde_json::from_str(&json)
                .with_context(|| format!("reading {}", file.display()))?,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(err) => return Err(err).with_context(|| format!("reading {}", file.display())),
        };
        Ok(Self {
            key,
            subscriptions: Mutex::new(subscriptions),
            file,
            http,
        })
    }

    /// The public half of the signing key, which a browser subscribes with, as base64url.
    pub fn public_key(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.key.public_key().public_key().to_bytes_uncompressed())
    }

    pub fn has_subscriptions(&self) -> bool {
        !lock(&self.subscriptions).is_empty()
    }

    pub fn is_subscribed(&self, endpoint: &str) -> bool {
        lock(&self.subscriptions)
            .iter()
            .any(|s| s.endpoint == endpoint)
    }

    pub fn subscribe(&self, subscription: Subscription) -> Result<()> {
        // Checked now, so a subscription that can't be sent to is refused rather than saved.
        builder(&subscription)?;
        let mut subscriptions = lock(&self.subscriptions);
        subscriptions.retain(|s| s.endpoint != subscription.endpoint);
        subscriptions.push(subscription);
        self.save(&subscriptions)
    }

    pub fn unsubscribe(&self, endpoint: &str) -> Result<()> {
        let mut subscriptions = lock(&self.subscriptions);
        subscriptions.retain(|s| s.endpoint != endpoint);
        self.save(&subscriptions)
    }

    fn save(&self, subscriptions: &[Subscription]) -> Result<()> {
        write_private(&self.file, &serde_json::to_vec_pretty(subscriptions)?)
    }

    /// Sends a message to one device.
    pub async fn send(&self, subscription: &Subscription, message: &Message) -> Result<Delivery> {
        let request = builder(subscription)?
            .with_valid_duration(TIME_TO_LIVE)
            .with_vapid(&self.key, CONTACT)
            .build(serde_json::to_vec(message)?)
            .map_err(|e| anyhow::anyhow!("{e}"))
            .context("encrypting the notification")?;
        let (parts, body) = request.into_parts();
        let mut sending = self.http.post(parts.uri.to_string()).body(body);
        for (name, value) in &parts.headers {
            sending = sending.header(name, value);
        }
        let response = sending
            .send()
            .await
            .context("couldn't reach the push service")?;
        match response.status().as_u16() {
            200..=299 => Ok(Delivery::Sent),
            404 | 410 => Ok(Delivery::Gone),
            status => bail!(
                "the push service refused the notification ({status}): {}",
                response.text().await.unwrap_or_default().trim()
            ),
        }
    }

    /// Sends a message to every subscribed device, forgetting those whose subscriptions ended.
    pub async fn send_to_all(&self, message: &Message) {
        let subscriptions = lock(&self.subscriptions).clone();
        for subscription in subscriptions {
            match self.send(&subscription, message).await {
                Ok(Delivery::Sent) => {}
                Ok(Delivery::Gone) => {
                    tracing::info!("forgetting a device whose notifications have ended");
                    if let Err(err) = self.unsubscribe(&subscription.endpoint) {
                        tracing::warn!("forgetting a device: {err:#}");
                    }
                }
                Err(err) => tracing::warn!("sending a notification: {err:#}"),
            }
        }
    }
}

fn builder(subscription: &Subscription) -> Result<WebPushBuilder> {
    let json = serde_json::to_string(subscription)?;
    serde_json::from_str(&json).context("the subscription's endpoint or keys aren't valid")
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_its_key_and_devices() {
        let dir = tempfile::tempdir().unwrap();
        let notifier = Notifier::load(dir.path()).unwrap();
        let key = notifier.public_key();
        // An uncompressed P-256 point: 65 bytes.
        assert_eq!(URL_SAFE_NO_PAD.decode(&key).unwrap().len(), 65);
        let subscription = device("https://push.example/1").0;
        notifier.subscribe(subscription.clone()).unwrap();
        notifier.subscribe(subscription.clone()).unwrap();
        assert!(
            notifier
                .subscribe(Subscription {
                    endpoint: "not a url".into(),
                    ..subscription.clone()
                })
                .is_err()
        );

        let again = Notifier::load(dir.path()).unwrap();
        assert_eq!(again.public_key(), key);
        assert!(again.is_subscribed("https://push.example/1"));
        assert_eq!(lock(&again.subscriptions).len(), 1);
        again.unsubscribe("https://push.example/1").unwrap();
        assert!(!again.is_subscribed("https://push.example/1"));
    }

    /// A device's subscription, with the secret it decrypts with.
    fn device(endpoint: &str) -> (Subscription, web_push_native::p256::SecretKey, [u8; 16]) {
        use web_push_native::p256::elliptic_curve::sec1::ToEncodedPoint;
        // Almost every 32 random bytes make a key; the rare few that don't are drawn again.
        let secret = std::iter::repeat_with(rand::random::<[u8; 32]>)
            .find_map(|bytes| web_push_native::p256::SecretKey::from_slice(&bytes).ok())
            .unwrap();
        let auth: [u8; 16] = rand::random();
        let subscription = Subscription {
            endpoint: endpoint.to_owned(),
            keys: SubscriptionKeys {
                p256dh: URL_SAFE_NO_PAD
                    .encode(secret.public_key().to_encoded_point(false).as_bytes()),
                auth: URL_SAFE_NO_PAD.encode(auth),
            },
        };
        (subscription, secret, auth)
    }

    #[tokio::test]
    async fn sends_what_only_the_device_can_read() {
        // A push service of its own, which keeps what it's sent.
        let received =
            std::sync::Arc::new(Mutex::new(Vec::<(axum::http::HeaderMap, Vec<u8>)>::new()));
        let keep = received.clone();
        let service = axum::Router::new().route(
            "/push/{id}",
            axum::routing::post(
                move |axum::extract::Path(id): axum::extract::Path<String>,
                      headers: axum::http::HeaderMap,
                      body: axum::body::Bytes| {
                    let keep = keep.clone();
                    async move {
                        lock(&keep).push((headers, body.to_vec()));
                        if id == "gone" {
                            axum::http::StatusCode::GONE
                        } else {
                            axum::http::StatusCode::CREATED
                        }
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, service).await });

        let dir = tempfile::tempdir().unwrap();
        let notifier = Notifier::load(dir.path()).unwrap();
        let (phone, secret, auth) = device(&format!("http://{address}/push/phone"));
        let (gone, _, _) = device(&format!("http://{address}/push/gone"));
        notifier.subscribe(phone.clone()).unwrap();
        notifier.subscribe(gone.clone()).unwrap();

        let message = Message {
            title: "Day 4 is out".into(),
            body: "Advent of Code 2026, day 4, has unlocked.".into(),
            url: "/?open=2026-4".into(),
        };
        assert_eq!(
            notifier.send(&phone, &message).await.unwrap(),
            Delivery::Sent
        );
        let (headers, body) = lock(&received).pop().unwrap();
        assert_eq!(headers["content-encoding"], "aes128gcm");
        assert!(
            headers["authorization"]
                .to_str()
                .unwrap()
                .starts_with("vapid t=")
        );
        let auth = web_push_native::Auth::clone_from_slice(&auth);
        let plain = web_push_native::decrypt(body, &secret, &auth).unwrap();
        let sent: serde_json::Value = serde_json::from_slice(&plain).unwrap();
        assert_eq!(sent["title"], "Day 4 is out");
        assert_eq!(sent["url"], "/?open=2026-4");

        // A device whose subscription has ended is forgotten; the other is kept.
        notifier.send_to_all(&message).await;
        assert!(notifier.is_subscribed(&phone.endpoint));
        assert!(!notifier.is_subscribed(&gone.endpoint));
    }
}
