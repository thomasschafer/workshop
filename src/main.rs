mod aoc;
mod commands;
mod config;
mod discuss;
mod doctor;
mod edit;
mod eval;
mod language;
mod lsp;
mod manifest;
mod models;
mod notify;
mod packages;
mod paths;
mod practice;
mod process;
mod provider;
mod runner;
mod samples;
mod server;
mod settings;
mod solutions;
mod tailscale;
mod template;
mod theme;
mod toolchain;
mod updates;
mod whisper;
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
    /// Run the edit model against example utterances, to check changes to the edit prompt or
    /// dictation hints. Each case is a real model call.
    Eval {
        /// An eval file, or a directory of them.
        #[arg(default_value = "evals")]
        cases: std::path::PathBuf,
        /// Only run cases whose name contains this.
        #[arg(long)]
        filter: Option<String>,
        /// The model to check, as `provider:model` (such as `codex:luna`), instead of the one
        /// chosen in the app.
        #[arg(long)]
        model: Option<String>,
    },
    /// Run a solution as the app does: on your input, or with `--sample` on the sample chosen in
    /// the app, with the same programs, packages and helpers.
    Run {
        /// The year, or `practice` for the practice puzzle.
        year: String,
        /// The day; not needed for the practice puzzle.
        day: Option<u8>,
        /// Run on the sample chosen in the app, and check its expected answers.
        #[arg(long)]
        sample: bool,
        /// Which part's sample to use: part 2 uses part 1's if it has none of its own.
        #[arg(long, default_value_t = 1)]
        part: u8,
    },
    /// Print commands that set the environment solutions run with, such as where packages are
    /// installed and any programs from mise, so a terminal or editor matches the app:
    /// `eval "$(workshop env)"`.
    Env {
        #[arg(long, value_enum, default_value = "posix")]
        shell: commands::Shell,
    },
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
        Command::Eval {
            cases,
            filter,
            model,
        } => {
            let model = model
                .map(|m| {
                    let (provider, model) = m
                        .split_once(':')
                        .context("give the model as `provider:model`, such as `codex:luna`")?;
                    anyhow::Ok(models::ModelChoice {
                        provider: provider.to_owned(),
                        model: model.to_owned(),
                    })
                })
                .transpose()?;
            if !eval::run(&config, &paths, &cases, filter.as_deref(), model).await? {
                std::process::exit(1);
            }
            Ok(())
        }
        Command::Run {
            year,
            day,
            sample,
            part,
        } => {
            let puzzle = commands::parse_puzzle(&year, day)?;
            let part = aoc::Part::from_number(part)?;
            if !commands::run(&config, &paths, aoc_session, puzzle, sample, part).await? {
                std::process::exit(1);
            }
            Ok(())
        }
        Command::Env { shell } => {
            print!("{}", commands::env(&config, &paths, shell).await?);
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
    let listener = match tokio::net::TcpListener::bind(bind).await {
        Ok(listener) => listener,
        Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
            let next = std::net::SocketAddr::new(bind.ip(), bind.port().wrapping_add(1));
            anyhow::bail!(
                "port {port} is already in use, perhaps by Workshop running elsewhere. Stop that, \
                 or use another port: `workshop serve --bind {next}`, or set `bind` under \
                 [server] in your config.",
                port = bind.port()
            );
        }
        Err(err) => return Err(err).with_context(|| format!("listening on {bind}")),
    };
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
    let notifier = app.notifier.clone();
    tokio::spawn(async move { notifier.run().await });
    let updates = app.updates.clone();
    tokio::spawn(async move { updates.run().await });
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
