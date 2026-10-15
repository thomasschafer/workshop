//! Notifications when puzzles unlock, sent to devices that asked for them with Web Push, so a
//! phone hears even when Workshop isn't open on it. Off unless a device turns them on.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use web_push_native::WebPushBuilder;
use web_push_native::jwt_simple::algorithms::{ECDSAP256PublicKeyLike, ES256KeyPair};

use crate::paths::{self, Paths};

/// Who to contact about these notifications, which push services ask senders for.
const CONTACT: &str = "https://github.com/thomasschafer/workshop";

/// How long a push service should keep trying to deliver: a puzzle's news is stale after a day.
const TIME_TO_LIVE: Duration = Duration::from_secs(24 * 60 * 60);

/// When a puzzle unlocks, in seconds since 1970: midnight US Eastern, which in December is
/// always 05:00 UTC.
pub fn unlock_time(year: u16, day: u8) -> u64 {
    let days = days_from_civil(i64::from(year), 12, i64::from(day));
    u64::try_from(days * 86_400 + 5 * 3600).expect("puzzles unlock after 1970")
}

/// Advent of Code has 12 days from 2025 onwards, and 25 before that.
pub fn days_in(year: u16) -> u8 {
    if year >= 2025 { 12 } else { 25 }
}

/// The next puzzle to unlock after `now`, during or ahead of this year's event.
pub fn next_unlock(now: u64) -> Option<(u16, u8, u64)> {
    let year = year_of(now);
    (1..=days_in(year))
        .map(|day| (year, day, unlock_time(year, day)))
        .find(|(_, _, at)| *at > now)
}

/// The calendar year a time falls in, in UTC.
fn year_of(seconds: u64) -> u16 {
    let days = i64::try_from(seconds / 86_400).expect("a time within range");
    // Days from 1970 to the start of each year, until the year that contains `days`.
    let mut year = 1970;
    while days_from_civil(year + 1, 1, 1) <= days {
        year += 1;
    }
    u16::try_from(year).expect("a year within range")
}

/// Days from 1970-01-01 to a date, by Howard Hinnant's algorithm for the proleptic Gregorian
/// calendar.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

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

impl Message {
    pub fn unlocked(year: u16, day: u8) -> Self {
        Self {
            title: format!("Day {day} is out"),
            body: format!("Advent of Code {year}, day {day}, has unlocked."),
            url: format!("/?open={year}-{day}"),
        }
    }
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
    /// The notifier for this server, making its signing key the first time.
    pub fn load(paths: &Paths) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()?;
        let key_file = paths.data_dir.join("push-key");
        let key = match std::fs::read(&key_file) {
            Ok(bytes) => ES256KeyPair::from_bytes(&bytes)
                .map_err(|e| anyhow::anyhow!("{e}"))
                .with_context(|| format!("reading {}", key_file.display()))?,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                let key = ES256KeyPair::generate();
                paths::write_private(&key_file, &key.to_bytes())?;
                key
            }
            Err(err) => return Err(err).with_context(|| format!("reading {}", key_file.display())),
        };
        let file = paths.data_dir.join("push-subscriptions.json");
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
        paths::write_private(&self.file, &serde_json::to_vec_pretty(subscriptions)?)
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

    /// Notifies subscribed devices as each puzzle unlocks, for as long as the server runs.
    pub async fn run(&self) {
        loop {
            let now = now_secs();
            let Some((year, day, at)) = next_unlock(now) else {
                // Until the next year's event, checking now and then.
                tokio::time::sleep(Duration::from_secs(24 * 60 * 60)).await;
                continue;
            };
            // In shorter steps, so a clock that changes or a computer that sleeps doesn't delay
            // a notification by much.
            let wait = at.saturating_sub(now).min(15 * 60);
            if wait > 0 {
                tokio::time::sleep(Duration::from_secs(wait)).await;
                continue;
            }
            if !lock(&self.subscriptions).is_empty() {
                tracing::info!("notifying devices that day {day} has unlocked");
                self.send_to_all(&Message::unlocked(year, day)).await;
            }
            // Past this unlock, so the next pass finds the following one.
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
}

fn builder(subscription: &Subscription) -> Result<WebPushBuilder> {
    let json = serde_json::to_string(subscription)?;
    serde_json::from_str(&json).context("the subscription's endpoint or keys aren't valid")
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Seconds since 1970 for a UTC time, for readable tests.
    fn at(year: i64, month: i64, day: i64, hour: u64) -> u64 {
        u64::try_from(days_from_civil(year, month, day) * 86_400).unwrap() + hour * 3600
    }

    #[test]
    fn counts_days_from_1970() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
        assert_eq!(days_from_civil(2026, 12, 1), 20_788);
        assert_eq!(year_of(at(2026, 12, 31, 23)), 2026);
        assert_eq!(year_of(at(2027, 1, 1, 0)), 2027);
    }

    #[test]
    fn unlocks_at_midnight_us_eastern() {
        // 2026-12-01T05:00:00Z.
        assert_eq!(unlock_time(2026, 1), 1_796_101_200);
        assert_eq!(
            next_unlock(at(2026, 12, 3, 22)),
            Some((2026, 4, unlock_time(2026, 4)))
        );
        assert_eq!(
            next_unlock(at(2026, 11, 2, 0)),
            Some((2026, 1, unlock_time(2026, 1)))
        );
        // After the last of the year's twelve days, nothing until next year.
        assert_eq!(next_unlock(at(2026, 12, 12, 6)), None);
        assert_eq!(
            next_unlock(at(2024, 12, 24, 6)).map(|(_, d, _)| d),
            Some(25)
        );
    }

    #[test]
    fn keeps_its_key_and_devices() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::under(dir.path());
        std::fs::create_dir_all(&paths.data_dir).unwrap();
        let notifier = Notifier::load(&paths).unwrap();
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

        let again = Notifier::load(&paths).unwrap();
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
        let paths = Paths::under(dir.path());
        std::fs::create_dir_all(&paths.data_dir).unwrap();
        let notifier = Notifier::load(&paths).unwrap();
        let (phone, secret, auth) = device(&format!("http://{address}/push/phone"));
        let (gone, _, _) = device(&format!("http://{address}/push/gone"));
        notifier.subscribe(phone.clone()).unwrap();
        notifier.subscribe(gone.clone()).unwrap();

        let message = Message::unlocked(2026, 4);
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
