//! Reaching Workshop from a phone over Tailscale, which also provides the HTTPS that browsers
//! require for microphone access.

use std::process::Stdio;

use anyhow::{Context, Result, bail};
use tokio::process::Command;

/// Serves the local port over HTTPS on the tailnet, returning the base URL.
pub async fn serve(port: u16) -> Result<String> {
    if crate::doctor::find_program("tailscale").is_none() {
        bail!("`--tailscale` needs the tailscale CLI, which isn't on your PATH");
    }
    let target = format!("http://127.0.0.1:{port}");
    println!("Setting up `tailscale serve`…");
    // Tailscale's output is shown rather than captured, because it can ask the user to do
    // something first, such as enabling Serve for their tailnet, and waits until they have.
    let status = Command::new("tailscale")
        .args(["serve", "--bg", &target])
        .stdin(Stdio::null())
        .status()
        .await
        .context("running tailscale")?;
    if !status.success() {
        bail!("`tailscale serve` failed ({status}); is Tailscale running and logged in?");
    }
    let status = run(&["status", "--json"]).await?;
    let name = dns_name(&status)?;
    Ok(format!("https://{name}"))
}

async fn run(args: &[&str]) -> Result<String> {
    let output = Command::new("tailscale")
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

fn dns_name(status_json: &str) -> Result<String> {
    let status: serde_json::Value =
        serde_json::from_str(status_json).context("tailscale status isn't valid JSON")?;
    let name = status
        .pointer("/Self/DNSName")
        .and_then(|n| n.as_str())
        .map(|n| n.trim_end_matches('.'))
        .filter(|n| !n.is_empty())
        .context("tailscale didn't report this machine's name; is it logged in?")?;
    Ok(name.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_dns_name() {
        let json = r#"{"Self":{"DNSName":"laptop.tail1234.ts.net."}}"#;
        assert_eq!(dns_name(json).unwrap(), "laptop.tail1234.ts.net");
        assert!(dns_name(r#"{"Self":{"DNSName":""}}"#).is_err());
        assert!(dns_name("{}").is_err());
    }
}
