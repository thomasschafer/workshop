mod aoc;
mod config;
mod discuss;
mod doctor;
mod edit;
mod language;
mod lsp;
mod paths;
mod provider;
mod runner;
mod server;
mod tailscale;
mod template;
mod workspace;

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

use crate::config::Config;
use crate::paths::Paths;

/// Solve Advent of Code puzzles by voice, from your phone.
#[derive(Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Start the server (the default).
    Serve {
        /// Address to listen on, overriding the config file.
        #[arg(long)]
        bind: Option<SocketAddr>,
        /// Make Workshop reachable from your other devices with `tailscale serve`, which also
        /// provides the HTTPS that phones need for the microphone.
        #[arg(long)]
        tailscale: bool,
    },
    /// Check that everything Workshop needs is installed and set up.
    Doctor,
    /// Print the link, including the access token, for opening Workshop.
    Token {
        /// Set up `tailscale serve` and print the link and QR code for your phone.
        #[arg(long)]
        tailscale: bool,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let paths = Paths::from_env()?;
    init_logging(&paths)?;
    let config = Config::load_or_init(&paths)?;
    let aoc_session = aoc::read_session(&paths)?;

    match cli.command.unwrap_or(Command::Serve {
        bind: None,
        tailscale: false,
    }) {
        Command::Serve { bind, tailscale } => {
            serve(config, paths, aoc_session, bind, tailscale).await
        }
        Command::Doctor => {
            let checks = doctor::run(&config, &paths, aoc_session.is_some()).await;
            doctor::print(&checks);
            if checks.iter().any(|c| c.status == doctor::Status::Fail) {
                std::process::exit(1);
            }
            Ok(())
        }
        Command::Token { tailscale } => {
            let token = server::load_or_create_token(&paths)?;
            if tailscale {
                print_phone_link(config.server.bind, &token).await
            } else {
                println!("{}", open_url(config.server.bind, &token));
                Ok(())
            }
        }
    }
}

/// The log file is started afresh once it grows past this.
const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;

fn init_logging(paths: &Paths) -> Result<()> {
    use tracing_subscriber::prelude::*;

    let path = paths.log_file();
    std::fs::create_dir_all(&paths.data_dir)
        .with_context(|| format!("creating {}", paths.data_dir.display()))?;
    let too_big = std::fs::metadata(&path).is_ok_and(|m| m.len() > MAX_LOG_BYTES);
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(!too_big)
        .write(true)
        .truncate(too_big)
        .open(&path)
        .with_context(|| format!("opening {}", path.display()))?;
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "workshop=info".into());
    tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer())
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(std::sync::Mutex::new(file)),
        )
        .init();
    Ok(())
}

fn qr_code(text: &str) -> Result<String> {
    let code = qrcode::QrCode::new(text.as_bytes()).context("making a QR code")?;
    Ok(code
        .render::<qrcode::render::unicode::Dense1x2>()
        .dark_color(qrcode::render::unicode::Dense1x2::Light)
        .light_color(qrcode::render::unicode::Dense1x2::Dark)
        .build())
}

fn open_url(bind: SocketAddr, token: &str) -> String {
    format!("http://{bind}/?token={token}")
}

async fn serve(
    mut config: Config,
    paths: Paths,
    aoc_session: Option<String>,
    bind: Option<SocketAddr>,
    use_tailscale: bool,
) -> Result<()> {
    if let Some(bind) = bind {
        config.server.bind = bind;
    }
    let bind = config.server.bind;
    if !bind.ip().is_loopback() {
        tracing::warn!(
            "listening on {bind}, which is reachable from other machines. Anyone with the token can run code on this machine."
        );
    }
    let token = server::load_or_create_token(&paths)?;
    let app = Arc::new(server::App::new(config, paths, token.clone(), aoc_session)?);
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .with_context(|| format!("listening on {bind}"))?;
    println!(
        "Workshop is running. On this computer, open {}",
        open_url(bind, &token)
    );
    if use_tailscale {
        print_phone_link(bind, &token).await?;
    } else {
        println!(
            "To use it from your phone, run `workshop serve --tailscale`, or see the README for other options."
        );
    }
    let warm = app.clone();
    tokio::spawn(async move { warm.warm_up().await });
    // Stop straight away rather than waiting for connections to close: the editor's language
    // server websocket stays open indefinitely. Returning drops every task, which stops the
    // language servers and model CLIs they started.
    tokio::select! {
        result = axum::serve(listener, server::router(app)) => result?,
        () = shutdown_signal() => {}
    }
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = terminate.recv() => {}
                }
            }
            Err(err) => {
                tracing::warn!("can't listen for SIGTERM: {err}");
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

async fn print_phone_link(bind: SocketAddr, token: &str) -> Result<()> {
    if !(bind.ip().is_loopback() || bind.ip().is_unspecified()) {
        anyhow::bail!("`--tailscale` forwards to 127.0.0.1, so Workshop must listen there");
    }
    let base = tailscale::serve(bind.port()).await?;
    let url = format!("{base}/?token={token}");
    println!(
        "\nOn your phone, open {url}\nor scan:\n\n{}",
        qr_code(&url)?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_qr_codes() {
        let code = qr_code("https://laptop.tail1234.ts.net/?token=abc").unwrap();
        assert!(code.lines().count() > 10);
    }
}
