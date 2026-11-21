//! Setup checks, shared by `workshop doctor` and the app.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;
use workshop_common::programs::find_program;
use workshop_pack::Language;
use workshop_toolchain::toolchain::{self, Toolchain};

use crate::config::Config;
use crate::paths::Paths;
use crate::solutions::Solutions;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Ok,
    /// Workshop works, but something is missing or degraded.
    Warn,
    Fail,
}

#[derive(Debug, Clone, Serialize)]
pub struct Check {
    pub name: String,
    pub status: Status,
    pub detail: String,
    pub fix: Option<String>,
}

impl Check {
    fn ok(name: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            status: Status::Ok,
            detail: detail.into(),
            fix: None,
        }
    }

    fn problem(
        status: Status,
        name: impl Into<String>,
        detail: impl Into<String>,
        fix: impl Into<String>,
    ) -> Self {
        Self {
            name: name.into(),
            status,
            detail: detail.into(),
            fix: Some(fix.into()),
        }
    }
}

pub async fn run(config: &Config, paths: &Paths, has_aoc_session: bool) -> Vec<Check> {
    let mut checks = Vec::new();
    checks.push(
        match crate::updates::Updates::load(paths, config.server.check_for_updates).available() {
            Some(update) => Check::problem(
                Status::Warn,
                "Version",
                format!(
                    "Workshop {} is running, and {} is out",
                    env!("CARGO_PKG_VERSION"),
                    update.version
                ),
                update.how,
            ),
            None => Check::ok("Version", format!("Workshop {}", env!("CARGO_PKG_VERSION"))),
        },
    );
    checks.push(Check::ok(
        "Config",
        format!(
            "Using {}",
            workshop_common::files::display_path(&paths.config_file())
        ),
    ));

    // The providers chosen in the app, which may differ from the config's defaults.
    let settings = crate::settings::AppSettings::load(config, paths);
    for id in &settings.models.providers(config) {
        checks.extend(check_provider(config, id).await);
    }

    checks.push(check_author_reviewer(config).await);

    let (toolchain, toolchain_check) = check_toolchain(&config.solutions_dir, "Toolchain").await;
    checks.extend(toolchain_check);
    let solutions = Solutions {
        config,
        paths,
        language_id: settings.language.clone(),
        toolchain,
    };
    let language = solutions.language();
    let install_hint = if language.toolchain.is_some() {
        " Setup in the app can install it for you with mise."
    } else {
        ""
    };
    for program in language.required_programs() {
        checks.push(check_program(
            &solutions.toolchain,
            format!("{} runner", language.name),
            program,
            Status::Fail,
            format!(
                "Install {} so that `{program}` is on your PATH, or change the commands in your language profile.{install_hint}",
                language.name
            ),
        ));
    }
    if let Some(lsp) = language.lsp.as_ref().and_then(|c| c.first()) {
        checks.push(check_language_server(
            &solutions.toolchain,
            "Language server".to_owned(),
            lsp,
            "",
        ));
    }
    checks.extend(check_coding_languages(config, paths).await);

    if let Some(packages) = solutions.packages() {
        checks.push(check_packages(&packages));
    }

    checks.push(check_speech(paths));

    checks.push(match find_program("git") {
        Some(_) => Check::ok("Git", "Found git"),
        None => Check::problem(
            Status::Fail,
            "Git",
            "`git` isn't on your PATH",
            "Install git.",
        ),
    });
    let solutions = workshop_common::files::display_path(&config.solutions_dir);
    checks.push(if config.solutions_dir.join(".git").exists() {
        Check::ok("Solutions repo", solutions)
    } else if config.solutions_dir.exists() && !config.solutions_dir.is_dir() {
        Check::problem(
            Status::Fail,
            "Solutions repo",
            format!("{solutions} isn't a folder"),
            "Set `dir` under [solutions] in your config to a folder for your solutions.",
        )
    } else {
        // Made when a puzzle is first opened, so nothing's wrong yet.
        Check::ok(
            "Solutions repo",
            format!("{solutions}, made when you open your first puzzle"),
        )
    });

    checks.push(if has_aoc_session {
        Check::ok("Advent of Code login", "Session cookie found")
    } else {
        Check::problem(
            Status::Fail,
            "Advent of Code login",
            "No session cookie, so puzzles and inputs can't be fetched",
            format!(
                "Log in at adventofcode.com, copy the `session` cookie from your browser's developer tools (Storage or Application, then Cookies), and save it to {} or set AOC_SESSION.",
                paths.aoc_session_file().display()
            ),
        )
    });
    checks.push(check_network(&config.aoc).await);
    checks.push(check_https(config).await);
    checks
}

/// Which model reviews the author's items, and why. A reviewer from the writer's own provider
/// works, so another provider, such as Codex alongside Claude Code, is only a suggestion.
async fn check_author_reviewer(config: &Config) -> Check {
    use crate::author::reviewer::{self, Why};
    let reviewer = reviewer::chosen(config).await;
    let name = "Author's reviewer";
    let detail = reviewer::named(config, &reviewer.model);
    let reason = reviewer.reason(config);
    // One chosen by itself is already known to be ready; one set in the config isn't.
    let provider = &config.providers[&reviewer.model.provider];
    if reviewer.why == Why::Configured && !reviewer::is_ready(provider).await {
        let program = &provider.command[0];
        let install = provider
            .install_hint
            .clone()
            .unwrap_or_else(|| format!("Install `{program}` and log in."));
        return Check::problem(
            Status::Fail,
            name,
            format!("{detail}, set under [author], isn't installed or logged in"),
            format!("{install} Or choose another reviewer under [author]."),
        );
    }
    if reviewer.shares_provider(config) {
        Check::problem(
            Status::Warn,
            name,
            format!("{detail}, the writer's own provider"),
            format!("Optional: {reason}"),
        )
    } else {
        Check::ok(name, format!("{detail}. {reason}"))
    }
}

/// Whisper on the server, which hears dictation more accurately than phones. Optional.
fn check_speech(paths: &Paths) -> Check {
    use crate::whisper::{DICTATION_MODEL, INSTALL_HINT, Whisper};
    let name = "Speech";
    match Whisper::find(&paths.cache_dir) {
        Some(whisper) if whisper.dictation_model().is_some() => Check::ok(
            name,
            format!("Whisper is ready, with its {DICTATION_MODEL} model"),
        ),
        Some(_) => Check::problem(
            Status::Warn,
            name,
            format!("Whisper is installed, but its {DICTATION_MODEL} model isn't downloaded"),
            "Optional: download it in the app, in Settings under Talking, for more accurate dictation.",
        ),
        None => Check::problem(
            Status::Warn,
            name,
            "Whisper isn't installed, so dictation uses the phone's own speech recognition",
            format!("Optional, for more accurate dictation: {INSTALL_HINT}"),
        ),
    }
}

/// Whether `toolchain` has `program`, which building or running needs, as `name`, with how to
/// install it if it doesn't, and how bad that is.
fn check_program(
    toolchain: &Toolchain,
    name: String,
    program: &str,
    missing: Status,
    fix: String,
) -> Check {
    match toolchain.find_program(program) {
        Some(path) => Check::ok(name, format!("Found {program} at {}", path.display())),
        None => Check::problem(
            missing,
            name,
            format!("`{program}` isn't on your PATH"),
            fix,
        ),
    }
}

/// Whether `toolchain` has the language server `lsp`, which is optional, with `install_hint`
/// added to how to install it.
fn check_language_server(
    toolchain: &Toolchain,
    name: String,
    lsp: &str,
    install_hint: &str,
) -> Check {
    match toolchain.find_program(lsp) {
        Some(path) => Check::ok(name, format!("Found {lsp} at {}", path.display())),
        None => Check::problem(
            Status::Warn,
            name,
            format!("`{lsp}` isn't on your PATH, so there will be no error underlines or types"),
            format!("Optional: install `{lsp}` for inline errors and types.{install_hint}"),
        ),
    }
}

/// The programs and language servers of the languages the Coding track has code written in,
/// which come from each language's own directory, as the solutions' come from theirs. Only a
/// warning when missing, as the rest of Workshop works without them.
async fn check_coding_languages(config: &Config, paths: &Paths) -> Vec<Check> {
    let mut checks = Vec::new();
    for language in Language::ALL.into_iter().filter(|l| l.is_writable()) {
        let Some(profile) = config.languages.get(language.id()) else {
            continue;
        };
        let name = format!("Coding track: {}", profile.name);
        let dir = crate::coding::language_dir(&paths.data_dir, language);
        let (toolchain, toolchain_check) =
            check_toolchain(&dir, &format!("{name} toolchain")).await;
        checks.extend(toolchain_check);
        let install_hint = if profile.toolchain.is_some() {
            " The app offers to install it for you with mise, with a problem open in the language."
        } else {
            ""
        };
        let program = workshop_coding::needs(language);
        checks.push(check_program(
            &toolchain,
            name.clone(),
            program,
            Status::Warn,
            format!(
                "Install {} so that `{program}` is on your PATH, to solve problems in it.{install_hint}",
                profile.name
            ),
        ));
        if let Some(lsp) = profile.lsp.as_ref().and_then(|c| c.first()) {
            checks.push(check_language_server(
                &toolchain,
                format!("{name} language server"),
                lsp,
                install_hint,
            ));
        }
    }
    checks
}

/// The environment from the mise config in `dir`, if it has one, and how that went, as `name`.
async fn check_toolchain(dir: &Path, name: &str) -> (Toolchain, Option<Check>) {
    let Some(file) = toolchain::mise_config(dir) else {
        return (Toolchain::default(), None);
    };
    if find_program("mise").is_none() {
        return (
            Toolchain::default(),
            Some(Check::problem(
                Status::Warn,
                name,
                format!(
                    "{} lists programs to install with mise, but mise isn't installed, so they're looked for on your PATH instead",
                    file.display()
                ),
                toolchain::MISE_INSTALL_HINT,
            )),
        );
    }
    match Toolchain::load(dir).await {
        Ok(toolchain) => (
            toolchain,
            Some(Check::ok(
                name,
                format!("Programs from {}, via mise", file.display()),
            )),
        ),
        Err(err) => (
            Toolchain::default(),
            Some(Check::problem(
                Status::Fail,
                name,
                format!("{err:#}"),
                format!("Run `mise trust` and `mise install` in {}.", dir.display()),
            )),
        ),
    }
}

fn check_packages(packages: &workshop_toolchain::packages::Packages) -> Check {
    let state = match packages.state() {
        Ok(state) => state,
        Err(err) => {
            return Check::problem(
                Status::Fail,
                "Packages",
                format!("{err:#}"),
                "Check the file can be read.",
            );
        }
    };
    let fix = "Install them in Settings, under Packages.";
    if let Some(problem) = &state.problem {
        return Check::problem(
            Status::Fail,
            "Packages",
            format!("{} has a problem: {problem}", state.manifest),
            format!("Fix {} in Settings, under Packages.", state.manifest),
        );
    }
    if !state.packages.is_empty() && !state.missing_programs.is_empty() {
        return Check::problem(
            Status::Fail,
            "Packages",
            format!(
                "Installing packages needs {}, which isn't on your PATH",
                state.missing_programs.join(" and ")
            ),
            "Install it, then install the packages in Settings, under Packages.",
        );
    }
    match (&state.packages, &state.installed) {
        (listed, _) if listed.is_empty() => Check::ok("Packages", "None listed"),
        (listed, Some(installed)) if listed == installed => Check::ok(
            "Packages",
            format!("{} installed, from {}", listed.join(", "), state.manifest),
        ),
        (_, Some(_)) => Check::problem(
            Status::Warn,
            "Packages",
            format!(
                "{} changed since the packages were installed",
                state.manifest
            ),
            fix,
        ),
        (listed, None) => Check::problem(
            Status::Warn,
            "Packages",
            format!("Not installed yet: {}", listed.join(", ")),
            fix,
        ),
    }
}

async fn check_provider(config: &Config, id: &str) -> Vec<Check> {
    let provider = &config.providers[id];
    let install_hint = provider
        .install_hint
        .clone()
        .unwrap_or_else(|| format!("Install the CLI used by the `{id}` provider."));
    let name = format!("Model CLI ({id})");
    if provider.check_platform(id, cfg!(windows)).is_err() {
        return vec![Check::problem(
            Status::Fail,
            name,
            format!("{} doesn't work on Windows yet", provider.display_name(id)),
            "Choose another provider in Settings, under Models.",
        )];
    }
    let program = &provider.command[0];
    if find_program(program).is_none() {
        let alternatives: Vec<&str> = config
            .providers
            .iter()
            .filter(|(other, p)| *other != id && find_program(&p.command[0]).is_some())
            .map(|(other, _)| other.as_str())
            .collect();
        let fix = match alternatives.first() {
            Some(other) => format!(
                "{install_hint} Or use `{other}`, which is installed: set `provider = \"{other}\"` under [models.edit] and [models.discuss] in your config."
            ),
            None => install_hint,
        };
        return vec![Check::problem(
            Status::Fail,
            name,
            format!("`{program}` isn't on your PATH"),
            fix,
        )];
    }
    let mut checks = Vec::new();
    match &provider.version_command {
        Some(command) => match output(command).await {
            Some((true, out)) => {
                checks.push(Check::ok(&name, out.lines().next().unwrap_or("").trim()))
            }
            _ => checks.push(Check::problem(
                Status::Fail,
                &name,
                format!("`{}` failed", command.join(" ")),
                install_hint,
            )),
        },
        None => checks.push(Check::ok(&name, format!("Found {program}"))),
    }
    if let Some(command) = &provider.auth_check_command {
        checks.push(match output(command).await {
            Some((true, _)) => Check::ok(format!("Model login ({id})"), "Logged in"),
            _ => Check::problem(
                Status::Fail,
                format!("Model login ({id})"),
                "Not logged in",
                format!("Run `{program}` in a terminal and log in."),
            ),
        });
    }
    checks
}

async fn check_network(aoc: &crate::config::AocConfig) -> Check {
    let client = reqwest::Client::builder()
        .user_agent(&aoc.user_agent)
        .timeout(Duration::from_secs(10))
        .build();
    let reachable = match client {
        Ok(client) => client.head(&aoc.base_url).send().await.is_ok(),
        Err(_) => false,
    };
    if reachable {
        Check::ok("Network", "adventofcode.com is reachable")
    } else {
        Check::problem(
            Status::Fail,
            "Network",
            "Couldn't reach adventofcode.com",
            "Check your internet connection. Cached puzzles still work offline.",
        )
    }
}

async fn check_https(config: &Config) -> Check {
    let port = config.server.bind.port();
    let name = "Phone access";
    let fix = "Browsers only allow the microphone over HTTPS. If you use Tailscale, start Workshop with `workshop serve --tailscale` and open the link it prints on your phone.";
    if workshop_tailscale::program().is_none() {
        return Check::problem(Status::Warn, name, "Tailscale isn't installed", fix);
    }
    match workshop_tailscale::serving_url(port).await {
        Some(url) => Check::ok(name, format!("Served at {url}")),
        None => Check::problem(
            Status::Warn,
            name,
            "Tailscale isn't serving Workshop over HTTPS",
            fix,
        ),
    }
}

pub async fn output(command: &[String]) -> Option<(bool, String)> {
    let (program, args) = command.split_first()?;
    let output = tokio::time::timeout(
        Duration::from_secs(15),
        Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    Some((
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
    ))
}

pub fn print(checks: &[Check]) {
    for check in checks {
        let mark = match check.status {
            Status::Ok => "✓",
            Status::Warn => "!",
            Status::Fail => "✗",
        };
        println!("{mark} {}: {}", check.name, check.detail);
        if let Some(fix) = &check.fix {
            println!("    {fix}");
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// Config with Claude Code standing in, logged in, and Codex, logged in or not, so no model
    /// CLI is run.
    fn config(author: &str, codex_logged_in: bool) -> Config {
        let stand_in = |name: &str, exit: u8| {
            format!(
                "name = \"{name}\"\ncommand = [\"sh\"]\ninput = \"stdin\"\noutput = \"text\"\nauth_check_command = [\"sh\", \"-c\", \"exit {exit}\"]\n"
            )
        };
        let codex = stand_in("Codex", if codex_logged_in { 0 } else { 1 });
        let claude = stand_in("Claude Code", 0);
        Config::parse(&format!(
            "[author]\n{author}\n[providers.codex]\n{codex}[providers.claude]\n{claude}"
        ))
        .unwrap()
    }

    #[tokio::test]
    async fn reports_another_provider_for_the_reviewer_as_optional() {
        let other = check_author_reviewer(&config("", true)).await;
        assert_eq!(other.status, Status::Ok);
        assert!(
            other.detail.starts_with("sol with Codex. "),
            "{}",
            other.detail
        );

        // Without Codex, the writer's own provider reviews, and Codex is only suggested.
        let same = check_author_reviewer(&config("", false)).await;
        assert_eq!(same.status, Status::Warn);
        assert_eq!(
            same.detail,
            "opus with Claude Code, the writer's own provider"
        );
        let fix = same.fix.unwrap();
        assert!(fix.starts_with("Optional: "), "{fix}");
        assert!(fix.contains("install and log in to Codex"), "{fix}");

        // Set under [author], it's used whatever's installed.
        let set = check_author_reviewer(&config(
            "reviewer = { provider = \"claude\", model = \"opus\" }",
            true,
        ))
        .await;
        assert_eq!(set.status, Status::Warn);
        assert!(set.fix.unwrap().contains("set under [author]"));
    }

    #[tokio::test]
    async fn fails_when_the_reviewer_set_isnt_installed_or_logged_in() {
        let set = "reviewer = { provider = \"codex\", model = \"sol\" }";
        let ready = check_author_reviewer(&config(set, true)).await;
        assert_eq!(ready.status, Status::Ok);
        let logged_out = check_author_reviewer(&config(set, false)).await;
        assert_eq!(logged_out.status, Status::Fail);
        assert_eq!(
            logged_out.detail,
            "sol with Codex, set under [author], isn't installed or logged in"
        );
        assert!(
            logged_out
                .fix
                .unwrap()
                .ends_with("Or choose another reviewer under [author]."),
        );
    }
}
