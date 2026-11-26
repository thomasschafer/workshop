mod aoc;
mod author;
mod calendar;
mod code_review;
mod coding;
mod commands;
mod config;
mod design;
mod discuss;
mod doctor;
mod edit;
mod eval;
mod examiner;
mod follow_ups;
mod goals;
mod grader;
mod helix_theme;
mod language;
mod learning;
mod mistakes;
mod models;
mod notify;
mod on_device;
mod pack_files;
mod packs;
mod paths;
mod practice;
mod rounds;
mod runner;
mod samples;
mod server;
mod settings;
mod solutions;
mod theme;
mod tracks;
mod twist;
mod updates;
mod whisper;
mod workspace;

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

use crate::config::Config;
use crate::paths::Paths;

/// A learning and coding platform built for your phone, with Advent of Code built in.
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
        #[command(flatten)]
        tailscale: TailscaleArgs,
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
    /// Work with packs of things to learn.
    Pack {
        #[command(subcommand)]
        command: PackCommand,
    },
    /// Write new items for your pack, for the skills you're weakest in and the mistakes you make
    /// most: one model writes them, another reviews each blind, and every item must pass its
    /// check. What both agree on is added to the pack and committed, never pushed; the rest wait
    /// for your approval in the app. Schedule it yourself, such as with cron, if you'd like it
    /// to run regularly.
    Author {
        /// The pack to write for, by its id, if you have more than one.
        #[arg(long)]
        pack: Option<String>,
    },
    /// Print the link, including the access token, for opening Workshop.
    Token {
        #[command(flatten)]
        tailscale: TailscaleArgs,
    },
}

#[derive(Subcommand)]
enum PackCommand {
    /// Read every item in a pack and run its check, such as a probability item's simulation,
    /// listing anything wrong.
    Check {
        /// The pack's directory. By default, the packs in your config, or the sample pack.
        dir: Option<std::path::PathBuf>,
    },
    /// Add a question to a pack as a draft, such as one found elsewhere, for the author to make
    /// into an item with a check. Commits it if the pack is a git repo.
    Import {
        /// A file holding the question, as text or Markdown. Without one, it's read from stdin.
        file: Option<std::path::PathBuf>,
        /// Where it came from, in your own words.
        #[arg(long)]
        source: Option<String>,
        /// The skills it's for, from the pack's pack.toml, separated by commas.
        #[arg(long, value_delimiter = ',', required = true)]
        skills: Vec<String>,
        /// The kind of item it should become, such as `card`, `probability` or `coding`.
        #[arg(long, value_parser = parse_kind)]
        kind: Option<workshop_pack::Kind>,
        /// The pack to add it to, by its id, if you have more than one.
        #[arg(long)]
        pack: Option<String>,
    },
}

fn parse_kind(text: &str) -> Result<workshop_pack::Kind, String> {
    serde_json::from_value(serde_json::Value::String(text.to_owned()))
        .map_err(|_| format!("{text:?} isn't a kind of item; see docs/packs.md"))
}

#[derive(clap::Args, Default)]
struct TailscaleArgs {
    /// Make Workshop reachable from your other devices with `tailscale serve`, which also
    /// provides the HTTPS that phones need for the microphone, and print a link and QR code for
    /// your phone. Reuses the address Tailscale already serves Workshop at, and never replaces
    /// another app's.
    #[arg(long)]
    tailscale: bool,
    /// The HTTPS port to serve on over Tailscale, such as when another app uses 443. By default,
    /// the port Tailscale already serves Workshop on, or else 443.
    #[arg(long, requires = "tailscale", value_parser = clap::value_parser!(u16).range(1..))]
    https_port: Option<u16>,
}

impl TailscaleArgs {
    /// The HTTPS port to serve on with `tailscale serve`, if at all.
    fn https_port(&self) -> Option<workshop_tailscale::HttpsPort> {
        self.tailscale.then(|| {
            self.https_port.map_or(
                workshop_tailscale::HttpsPort::Default,
                workshop_tailscale::HttpsPort::Given,
            )
        })
    }
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
        tailscale: TailscaleArgs::default(),
    }) {
        Command::Serve { bind, tailscale } => {
            serve(config, paths, aoc_session, bind, tailscale.https_port()).await
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
        Command::Pack {
            command: PackCommand::Check { dir },
        } => {
            let runtime = coding::runtime(&config, &paths).await?;
            if !packs::check(dir.as_deref(), &config.learning, runtime).await? {
                std::process::exit(1);
            }
            Ok(())
        }
        Command::Pack {
            command:
                PackCommand::Import {
                    file,
                    source,
                    skills,
                    kind,
                    pack,
                },
        } => {
            let text = match file {
                Some(file) => std::fs::read_to_string(&file)
                    .with_context(|| format!("reading {}", file.display()))?,
                None => std::io::read_to_string(std::io::stdin()).context("reading stdin")?,
            };
            let dir = pack_files::chosen_pack_dir(&config.learning, pack.as_deref())?;
            let today = pack_files::date(learning::now_ms().div_euclid(86_400_000));
            let imported = pack_files::import(
                &dir,
                pack_files::Import {
                    text,
                    source,
                    skills,
                    kind,
                },
                &today,
            )
            .await?;
            println!(
                "Added {} as a draft{}.",
                dir.join(&imported.draft.path).display(),
                imported
                    .commit
                    .map_or_else(String::new, |c| format!(", in commit {c}"))
            );
            Ok(())
        }
        Command::Author { pack } => {
            let learning = learning::Learning::open(&config.learning, &paths.data_dir)?;
            let desk = author::Desk::new(&paths.data_dir);
            let notifier = Arc::new(workshop_push::Notifier::load(&paths.data_dir)?);
            println!("The author is writing; this can take a while.");
            let last =
                author::run(&config, &paths, &learning, &desk, notifier, pack.as_deref()).await?;
            print!("{}", author::summary(&last));
            if last.error.is_some() {
                std::process::exit(1);
            }
            Ok(())
        }
        Command::Token { tailscale } => {
            let token = workshop_auth::load_or_create_token(&paths.token_file())?;
            if let Some(https_port) = tailscale.https_port() {
                let base = serve_on_tailscale(config.server.bind, https_port).await?;
                print_phone_link(&base, &token)
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
    // The HTTPS port to serve on with `tailscale serve`, if at all.
    tailscale_https_port: Option<workshop_tailscale::HttpsPort>,
) -> Result<()> {
    if let Some(bind) = bind {
        config.server.bind = bind;
    }
    let bind = config.server.bind;
    let stay_awake = config.server.keep_awake;
    if !bind.ip().is_loopback() {
        tracing::warn!(
            "listening on {bind}, which is reachable from other machines. Anyone with the token can run code on this machine."
        );
    }
    let token = workshop_auth::load_or_create_token(&paths.token_file())?;
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
    let phone_base = match tailscale_https_port {
        Some(https_port) => Some(serve_on_tailscale(bind, https_port).await?),
        // `tailscale serve --bg` outlives Workshop, so once it's been set up, it's still served.
        None => workshop_tailscale::serving_url(bind.port()).await,
    };
    // Held until Workshop stops, which stops `caffeinate` with it.
    let _awake = match &phone_base {
        Some(base) => {
            print_phone_link(base, &token)?;
            stay_awake.then(keep_awake).flatten()
        }
        None => {
            println!(
                "To use it from your phone, run `workshop serve --tailscale` once, or put it behind another HTTPS proxy, which browsers need for the microphone."
            );
            None
        }
    };
    let warm = app.clone();
    tokio::spawn(async move { warm.warm_up().await });
    let notifier = app.notifier.clone();
    tokio::spawn(async move { crate::notify::notify_unlocks(&notifier).await });
    let updates = app.updates.clone();
    tokio::spawn(async move { updates.run().await });
    let author = app.clone();
    tokio::spawn(async move { server::run_author_on_schedule(author).await });
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

/// Serves Workshop over HTTPS on the tailnet, returning its base URL there.
async fn serve_on_tailscale(
    bind: SocketAddr,
    https_port: workshop_tailscale::HttpsPort,
) -> Result<String> {
    if !(bind.ip().is_loopback() || bind.ip().is_unspecified()) {
        anyhow::bail!("`--tailscale` forwards to 127.0.0.1, so Workshop must listen there");
    }
    workshop_tailscale::serve(bind.port(), https_port).await
}

fn print_phone_link(base: &str, token: &str) -> Result<()> {
    let url = format!("{base}/?token={token}");
    println!(
        "\nOn your phone, open {url}\nor scan:\n\n{}",
        qr_code(&url)?
    );
    Ok(())
}

/// Keeps the machine from sleeping while Workshop runs, where `caffeinate` can, so it can still
/// be reached from a phone. `caffeinate -w` also stops by itself if Workshop exits without
/// dropping the child.
fn keep_awake() -> Option<tokio::process::Child> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let pid = std::process::id().to_string();
    match tokio::process::Command::new("caffeinate")
        .args(["-i", "-w", &pid])
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => {
            println!(
                "Keeping this Mac awake while Workshop runs; set `keep_awake = false` under [server] to stop this."
            );
            Some(child)
        }
        Err(err) => {
            tracing::warn!("couldn't keep this Mac awake with caffeinate: {err}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tailscale_args() {
        use workshop_tailscale::HttpsPort;

        let https_port = |args: &[&str]| {
            let tailscale = match Cli::try_parse_from(args).unwrap().command {
                Some(Command::Serve { tailscale, .. } | Command::Token { tailscale }) => tailscale,
                _ => panic!("{args:?} isn't serve or token"),
            };
            tailscale.https_port()
        };
        for command in ["serve", "token"] {
            assert_eq!(https_port(&["workshop", command]), None);
            assert_eq!(
                https_port(&["workshop", command, "--tailscale"]),
                Some(HttpsPort::Default)
            );
            assert_eq!(
                https_port(&["workshop", command, "--tailscale", "--https-port", "8444"]),
                Some(HttpsPort::Given(8444))
            );
            assert!(Cli::try_parse_from(["workshop", command, "--https-port", "8444"]).is_err());
            assert!(
                Cli::try_parse_from(["workshop", command, "--tailscale", "--https-port", "0"])
                    .is_err()
            );
        }
    }

    #[test]
    fn parses_importing_a_question() {
        let parsed = Cli::try_parse_from([
            "workshop",
            "pack",
            "import",
            "q.md",
            "--skills",
            "a.b,c",
            "--kind",
            "probability",
            "--source",
            "A book",
        ])
        .unwrap();
        let Some(Command::Pack {
            command: PackCommand::Import { skills, kind, .. },
        }) = parsed.command
        else {
            panic!("not an import");
        };
        assert_eq!(skills, ["a.b", "c"]);
        assert_eq!(kind, Some(workshop_pack::Kind::Probability));
        assert!(Cli::try_parse_from(["workshop", "pack", "import", "--kind", "card"]).is_err());
        assert!(
            Cli::try_parse_from([
                "workshop", "pack", "import", "--skills", "a", "--kind", "poem"
            ])
            .is_err()
        );
    }

    #[test]
    fn renders_qr_codes() {
        let code = qr_code("https://laptop.tail1234.ts.net/?token=abc").unwrap();
        assert!(code.lines().count() > 10);
    }
}
