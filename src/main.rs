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
    },
    /// Check that everything Workshop needs is installed and set up.
    Doctor,
    /// Print the link, including the access token, for opening Workshop.
    Token,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "workshop=info".into()),
        )
        .init();

    let cli = Cli::parse();
    let paths = Paths::from_env()?;
    let config = Config::load_or_init(&paths)?;
    let aoc_session = aoc::read_session(&paths)?;

    match cli.command.unwrap_or(Command::Serve { bind: None }) {
        Command::Serve { bind } => serve(config, paths, aoc_session, bind).await,
        Command::Doctor => {
            let checks = doctor::run(&config, &paths, aoc_session.is_some()).await;
            doctor::print(&checks);
            if checks.iter().any(|c| c.status == doctor::Status::Fail) {
                std::process::exit(1);
            }
            Ok(())
        }
        Command::Token => {
            let token = server::load_or_create_token(&paths)?;
            println!("{}", open_url(config.server.bind, &token));
            Ok(())
        }
    }
}

fn open_url(bind: SocketAddr, token: &str) -> String {
    format!("http://{bind}/?token={token}")
}

async fn serve(
    mut config: Config,
    paths: Paths,
    aoc_session: Option<String>,
    bind: Option<SocketAddr>,
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
    println!("Workshop is running. Open {}", open_url(bind, &token));
    println!(
        "From your phone over Tailscale: run `tailscale serve --bg {}` and open the https address it prints, adding ?token={token}",
        bind.port()
    );
    let warm = app.clone();
    tokio::spawn(async move { warm.warm_up().await });
    axum::serve(listener, server::router(app))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
