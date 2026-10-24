//! Reaching Workshop from a phone over Tailscale, which also provides the HTTPS that browsers
//! require for microphone access.
//!
//! Other apps on the machine may be served too, each on its own HTTPS port, so Workshop never
//! changes a port that's already in use: it reuses the address Tailscale already serves it at,
//! or else adds one on a free port.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use tokio::process::Command;

/// The tailscale CLI: on the PATH, or inside the macOS app, which doesn't put it there.
pub fn program() -> Option<PathBuf> {
    crate::doctor::find_program("tailscale").or_else(|| {
        let app = PathBuf::from("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
        (cfg!(target_os = "macos") && app.is_file()).then_some(app)
    })
}

/// The HTTPS port `tailscale serve` uses unless told otherwise, which gives the bare address.
const DEFAULT_HTTPS_PORT: u16 = 443;

/// The first port suggested when the one Workshop wanted is taken.
const FIRST_SUGGESTED_PORT: u16 = 8443;

/// Which HTTPS port on the tailnet to serve Workshop on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HttpsPort {
    /// Wherever Tailscale already serves Workshop, or else 443 if nothing uses it.
    Default,
    /// This port, which must either already serve Workshop or be unused.
    Given(u16),
}

/// Serves the local port over HTTPS on the tailnet, returning the base URL. Reuses the address
/// Tailscale already serves it at, and fails rather than replace another app's.
pub async fn serve(port: u16, https_port: HttpsPort) -> Result<String> {
    let Some(tailscale) = program() else {
        bail!("`--tailscale` needs Tailscale, which isn't installed");
    };
    let served = read_served()
        .await
        .map_err(|err| err.context(not_running()))?;
    let https_port = match plan(&served, port, https_port)? {
        Plan::Reuse(url) => {
            println!("Tailscale already serves Workshop at {url}");
            return Ok(url);
        }
        Plan::Add(https_port) => https_port,
    };
    let target = local_target(port);
    let https = format!("--https={https_port}");
    println!("Setting up `tailscale serve` on HTTPS port {https_port}…");
    // Tailscale's output is shown rather than captured, because it can ask the user to do
    // something first, such as enabling Serve for their tailnet, and waits until they have.
    let status = Command::new(&tailscale)
        .args(["serve", "--bg", &https, &target])
        .stdin(Stdio::null())
        .status()
        .await
        .context("running tailscale")?;
    if !status.success() {
        bail!("`tailscale serve` failed ({status}). {}", not_running());
    }
    read_served()
        .await?
        .url_on(port, https_port)
        .with_context(|| {
            format!(
                "`tailscale serve` succeeded, but Tailscale doesn't list Workshop on HTTPS port {https_port}"
            )
        })
}

/// The HTTPS address Tailscale is already serving `port` at, without changing anything.
pub async fn serving_url(port: u16) -> Option<String> {
    program()?;
    let served = tokio::time::timeout(Duration::from_secs(10), read_served())
        .await
        .ok()?
        .ok()?;
    served.url(port)
}

fn not_running() -> &'static str {
    if cfg!(target_os = "linux") {
        "Is Tailscale running and logged in? On Linux, it also needs permission first: run `sudo tailscale set --operator=$USER`, then start Workshop again."
    } else {
        "Is Tailscale running and logged in?"
    }
}

fn local_target(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Whether a proxy target from Tailscale's config is Workshop's local port.
fn proxies_to(proxy: &str, port: u16) -> bool {
    let address = proxy.strip_prefix("http://").unwrap_or(proxy);
    let address = address.trim_end_matches('/');
    address.rsplit_once(':').is_some_and(|(host, proxied)| {
        matches!(host, "127.0.0.1" | "localhost") && proxied.parse() == Ok(port)
    })
}

fn site_url(host: &str, https_port: u16) -> String {
    if https_port == DEFAULT_HTTPS_PORT {
        format!("https://{host}")
    } else {
        format!("https://{host}:{https_port}")
    }
}

/// What `tailscale serve` serves on this machine's tailnet address.
#[derive(Debug, Default)]
struct Served {
    /// Every port in use, including for raw TCP forwarding.
    ports: BTreeSet<u16>,
    sites: Vec<Site>,
}

/// An HTTPS address on the tailnet.
#[derive(Debug)]
struct Site {
    host: String,
    https_port: u16,
    /// What the root of the address proxies to, if it proxies at all.
    root_proxy: Option<String>,
}

impl Served {
    fn workshop_sites(&self, port: u16) -> impl Iterator<Item = &Site> {
        self.sites.iter().filter(move |site| {
            site.root_proxy
                .as_deref()
                .is_some_and(|proxy| proxies_to(proxy, port))
        })
    }

    /// Workshop's address, at the lowest HTTPS port it's served on.
    fn url(&self, port: u16) -> Option<String> {
        self.workshop_sites(port)
            .min_by_key(|site| site.https_port)
            .map(|site| site_url(&site.host, site.https_port))
    }

    fn url_on(&self, port: u16, https_port: u16) -> Option<String> {
        self.workshop_sites(port)
            .find(|site| site.https_port == https_port)
            .map(|site| site_url(&site.host, site.https_port))
    }

    /// What's on `port`, for saying why Workshop won't use it.
    fn describe(&self, port: u16) -> String {
        let proxies: Vec<&str> = self
            .sites
            .iter()
            .filter(|site| site.https_port == port)
            .filter_map(|site| site.root_proxy.as_deref())
            .collect();
        if proxies.is_empty() {
            "something else".to_owned()
        } else {
            proxies.join(" and ")
        }
    }

    fn free_port(&self) -> u16 {
        (FIRST_SUGGESTED_PORT..=u16::MAX)
            .find(|port| !self.ports.contains(port))
            .expect("Tailscale can't be using every port")
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Plan {
    /// Tailscale already serves Workshop at this URL.
    Reuse(String),
    /// Serve Workshop on this HTTPS port, which nothing uses.
    Add(u16),
}

fn plan(served: &Served, port: u16, https_port: HttpsPort) -> Result<Plan> {
    let wanted = match https_port {
        HttpsPort::Default => {
            if let Some(url) = served.url(port) {
                return Ok(Plan::Reuse(url));
            }
            DEFAULT_HTTPS_PORT
        }
        HttpsPort::Given(https_port) => {
            if let Some(url) = served.url_on(port, https_port) {
                return Ok(Plan::Reuse(url));
            }
            https_port
        }
    };
    if served.ports.contains(&wanted) {
        bail!(
            "Tailscale already uses port {wanted} for {what}, so Workshop won't replace it. Serve Workshop on a free port instead, such as with `--https-port {free}`.",
            what = served.describe(wanted),
            free = served.free_port(),
        );
    }
    Ok(Plan::Add(wanted))
}

async fn read_served() -> Result<Served> {
    parse_served(&run(&["serve", "status", "--json"]).await?)
}

/// The parts of Tailscale's serve config (`ipn.ServeConfig`) that say which ports are in use.
#[derive(Debug, Deserialize)]
struct ServeConfig {
    /// Each port in use, by number.
    #[serde(rename = "TCP")]
    tcp: Option<BTreeMap<String, serde_json::Value>>,
    /// Each HTTPS address, as `host:port`.
    #[serde(rename = "Web")]
    web: Option<BTreeMap<String, WebConfig>>,
    /// What `tailscale serve` commands running in the foreground serve, by session.
    #[serde(rename = "Foreground")]
    foreground: Option<BTreeMap<String, ServeConfig>>,
}

#[derive(Debug, Deserialize)]
struct WebConfig {
    /// What each path serves.
    #[serde(rename = "Handlers")]
    handlers: Option<BTreeMap<String, Handler>>,
}

#[derive(Debug, Deserialize)]
struct Handler {
    #[serde(rename = "Proxy")]
    proxy: Option<String>,
}

/// Reads `tailscale serve status --json`, which prints nothing or `{}` when nothing is served.
fn parse_served(json: &str) -> Result<Served> {
    let mut served = Served::default();
    if json.trim().is_empty() {
        return Ok(served);
    }
    let config: ServeConfig =
        serde_json::from_str(json).context("`tailscale serve status --json` isn't valid JSON")?;
    add_config(&mut served, config)?;
    Ok(served)
}

fn add_config(served: &mut Served, config: ServeConfig) -> Result<()> {
    for port in config.tcp.unwrap_or_default().into_keys() {
        let port = port
            .parse()
            .with_context(|| format!("Tailscale's serve config has a port '{port}'"))?;
        served.ports.insert(port);
    }
    for (address, web) in config.web.unwrap_or_default() {
        let (host, https_port) = address
            .rsplit_once(':')
            .and_then(|(host, port)| Some((host, port.parse().ok()?)))
            .with_context(|| format!("Tailscale's serve config has an address '{address}'"))?;
        served.ports.insert(https_port);
        let root_proxy = web
            .handlers
            .unwrap_or_default()
            .remove("/")
            .and_then(|handler| handler.proxy);
        served.sites.push(Site {
            host: host.to_owned(),
            https_port,
            root_proxy,
        });
    }
    for foreground in config.foreground.unwrap_or_default().into_values() {
        add_config(served, foreground)?;
    }
    Ok(())
}

async fn run(args: &[&str]) -> Result<String> {
    let output = Command::new(program().context("Tailscale isn't installed")?)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .await
        .context("running tailscale")?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if !output.status.success() {
        bail!(
            "`tailscale {}` failed: {}{}",
            args.join(" "),
            stdout.trim(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = "laptop.tail1234.ts.net";

    /// A serve config like Tailscale's, serving each `(https_port, local_port)` at the root.
    fn config(sites: &[(u16, u16)]) -> String {
        let tcp: serde_json::Map<String, serde_json::Value> = sites
            .iter()
            .map(|(https, _)| (https.to_string(), serde_json::json!({"HTTPS": true})))
            .collect();
        let web: serde_json::Map<String, serde_json::Value> = sites
            .iter()
            .map(|(https, local)| {
                (
                    format!("{HOST}:{https}"),
                    serde_json::json!({"Handlers": {"/": {"Proxy": local_target(*local)}}}),
                )
            })
            .collect();
        serde_json::json!({"TCP": tcp, "Web": web}).to_string()
    }

    fn served(sites: &[(u16, u16)]) -> Served {
        parse_served(&config(sites)).unwrap()
    }

    #[test]
    fn reads_an_empty_config() {
        for json in ["", "\n", "{}", r#"{"TCP":null,"Web":null}"#] {
            let served = parse_served(json).unwrap();
            assert!(
                served.ports.is_empty() && served.sites.is_empty(),
                "{json:?}"
            );
        }
    }

    #[test]
    fn reads_the_ports_and_sites_in_use() {
        let json = format!(
            r#"{{
                "TCP": {{"443": {{"HTTPS": true}}, "5432": {{"TCPForward": "127.0.0.1:5432"}}, "8443": {{"HTTPS": true}}}},
                "Web": {{
                    "{HOST}:443": {{"Handlers": {{"/": {{"Proxy": "http://127.0.0.1:8080"}}}}}},
                    "{HOST}:8443": {{"Handlers": {{"/docs": {{"Path": "/srv/docs"}}}}}}
                }},
                "AllowFunnel": {{"{HOST}:443": true}}
            }}"#
        );
        let served = parse_served(&json).unwrap();
        assert_eq!(served.ports, BTreeSet::from([443, 5432, 8443]));
        assert_eq!(served.url(8080), Some(format!("https://{HOST}")));
        assert_eq!(served.describe(443), "http://127.0.0.1:8080");
        assert_eq!(served.describe(8443), "something else");
    }

    #[test]
    fn reads_foreground_sessions() {
        let json = format!(
            r#"{{"Foreground": {{"abc123": {{
                "TCP": {{"8443": {{"HTTPS": true}}}},
                "Web": {{"{HOST}:8443": {{"Handlers": {{"/": {{"Proxy": "http://127.0.0.1:7878"}}}}}}}}
            }}}}}}"#
        );
        let served = parse_served(&json).unwrap();
        assert_eq!(served.ports, BTreeSet::from([8443]));
        assert_eq!(served.url(7878), Some(format!("https://{HOST}:8443")));
    }

    #[test]
    fn rejects_configs_it_cant_read() {
        assert!(parse_served("No serve config").is_err());
        assert!(parse_served(r#"{"TCP": {"https": {}}}"#).is_err());
        assert!(parse_served(r#"{"Web": {"laptop": {}}}"#).is_err());
        assert!(parse_served(r#"{"Web": {"laptop:99999": {}}}"#).is_err());
    }

    #[test]
    fn finds_workshop_among_other_apps() {
        let served = served(&[(443, 8080), (8443, 8787), (7879, 7879), (8444, 7878)]);
        assert_eq!(served.url(7878), Some(format!("https://{HOST}:8444")));
        assert_eq!(served.url(7879), Some(format!("https://{HOST}:7879")));
        assert_eq!(served.url(8080), Some(format!("https://{HOST}")));
        assert_eq!(served.url(787), None);
        assert_eq!(served.url(9999), None);
    }

    #[test]
    fn prefers_the_lowest_port_when_served_twice() {
        let served = served(&[(8444, 7878), (443, 7878)]);
        assert_eq!(served.url(7878), Some(format!("https://{HOST}")));
        assert_eq!(
            served.url_on(7878, 8444),
            Some(format!("https://{HOST}:8444"))
        );
        assert_eq!(served.url_on(7878, 8445), None);
    }

    #[test]
    fn recognises_workshops_port_however_its_written() {
        assert!(proxies_to("http://127.0.0.1:7878", 7878));
        assert!(proxies_to("http://127.0.0.1:7878/", 7878));
        assert!(proxies_to("http://localhost:7878", 7878));
        assert!(proxies_to("127.0.0.1:7878", 7878));
        assert!(!proxies_to("http://127.0.0.1:78780", 7878));
        assert!(!proxies_to("http://127.0.0.1:787", 7878));
        assert!(!proxies_to("http://192.168.1.2:7878", 7878));
        assert!(!proxies_to("https+insecure://127.0.0.1:7878", 7878));
        assert!(!proxies_to("http://127.0.0.1", 7878));
    }

    #[test]
    fn reuses_wherever_workshop_is_already_served() {
        let served = served(&[(443, 8080), (8444, 7878)]);
        assert_eq!(
            plan(&served, 7878, HttpsPort::Default).unwrap(),
            Plan::Reuse(format!("https://{HOST}:8444"))
        );
        assert_eq!(
            plan(&served, 7878, HttpsPort::Given(8444)).unwrap(),
            Plan::Reuse(format!("https://{HOST}:8444"))
        );
    }

    #[test]
    fn adds_workshop_on_a_free_port() {
        assert_eq!(
            plan(&Served::default(), 7878, HttpsPort::Default).unwrap(),
            Plan::Add(443)
        );
        let served = served(&[(443, 8080), (8444, 7878)]);
        assert_eq!(
            plan(&served, 7878, HttpsPort::Given(8445)).unwrap(),
            Plan::Add(8445)
        );
        assert_eq!(
            plan(&served, 7879, HttpsPort::Given(7879)).unwrap(),
            Plan::Add(7879)
        );
    }

    #[test]
    fn never_replaces_another_apps_port() {
        let served = served(&[(443, 8080), (8443, 8787), (8444, 7878)]);
        let err = plan(&served, 7879, HttpsPort::Default)
            .unwrap_err()
            .to_string();
        assert!(err.contains("port 443 for http://127.0.0.1:8080"), "{err}");
        assert!(err.contains("`--https-port 8445`"), "{err}");
        let err = plan(&served, 7878, HttpsPort::Given(8443))
            .unwrap_err()
            .to_string();
        assert!(err.contains("port 8443 for http://127.0.0.1:8787"), "{err}");

        let tcp_only = parse_served(r#"{"TCP": {"443": {"TCPForward": "127.0.0.1:22"}}}"#).unwrap();
        let err = plan(&tcp_only, 7878, HttpsPort::Default)
            .unwrap_err()
            .to_string();
        assert!(err.contains("port 443 for something else"), "{err}");
    }

    #[test]
    fn builds_site_urls() {
        assert_eq!(site_url(HOST, 443), format!("https://{HOST}"));
        assert_eq!(site_url(HOST, 7879), format!("https://{HOST}:7879"));
    }
}
