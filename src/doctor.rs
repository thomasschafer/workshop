//! Setup checks, shared by `workshop doctor` and the app.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;

use crate::config::Config;
use crate::paths::Paths;

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
    checks.push(Check::ok(
        "Config",
        format!("Using {}", paths.config_file().display()),
    ));

    // The providers chosen in the app, which may differ from the config's defaults.
    let settings = crate::settings::AppSettings::load(config, paths);
    let mut provider_ids = vec![
        settings.models.edit.provider.clone(),
        settings.models.discuss_provider.clone(),
    ];
    provider_ids.dedup();
    for id in &provider_ids {
        checks.extend(check_provider(config, id).await);
    }

    let language = &config.languages[&settings.language];
    for program in language.required_programs() {
        checks.push(match find_program(program) {
            Some(path) => Check::ok(
                format!("{} runner", language.name),
                format!("Found {program} at {}", path.display()),
            ),
            None => Check::problem(
                Status::Fail,
                format!("{} runner", language.name),
                format!("`{program}` isn't on your PATH"),
                format!(
                    "Install {} so that `{program}` is on your PATH, or change the commands in your language profile.",
                    language.name
                ),
            ),
        });
    }
    if let Some(lsp) = language.lsp.as_ref().and_then(|c| c.first()) {
        checks.push(match find_program(lsp) {
            Some(path) => Check::ok(
                "Language server",
                format!("Found {lsp} at {}", path.display()),
            ),
            None => Check::problem(
                Status::Warn,
                "Language server",
                format!(
                    "`{lsp}` isn't on your PATH, so there will be no error underlines or types"
                ),
                format!("Optional: install `{lsp}` for inline errors and types."),
            ),
        });
    }

    if let Some(profile) = &language.packages {
        let packages = crate::packages::Packages {
            profile,
            language_name: &language.name,
            solutions_dir: &config.solutions_dir,
            dir: paths.packages_dir(&settings.language),
        };
        checks.push(check_packages(&packages));
    }

    checks.push(match find_program("git") {
        Some(_) => Check::ok("Git", "Found git"),
        None => Check::problem(
            Status::Fail,
            "Git",
            "`git` isn't on your PATH",
            "Install git.",
        ),
    });
    checks.push(if config.solutions_dir.join(".git").exists() {
        Check::ok(
            "Solutions repo",
            format!("{}", config.solutions_dir.display()),
        )
    } else {
        Check::problem(
            Status::Warn,
            "Solutions repo",
            format!("{} isn't a git repo yet", config.solutions_dir.display()),
            "Workshop will create it the first time you open a puzzle, or set `solutions.dir` in your config.",
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

fn check_packages(packages: &crate::packages::Packages) -> Check {
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
    if find_program("tailscale").is_none() {
        return Check::problem(Status::Warn, name, "Tailscale isn't installed", fix);
    }
    match crate::tailscale::serving_url(port).await {
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

pub fn find_program(program: &str) -> Option<PathBuf> {
    let candidate = PathBuf::from(program);
    if candidate.components().count() > 1 {
        return candidate.is_file().then_some(candidate);
    }
    let extensions: &[&str] = if cfg!(windows) {
        &["exe", "cmd", "bat"]
    } else {
        &[""]
    };
    std::env::split_paths(&std::env::var_os("PATH")?).find_map(|dir| {
        extensions.iter().find_map(|ext| {
            let path = if ext.is_empty() {
                dir.join(program)
            } else {
                dir.join(format!("{program}.{ext}"))
            };
            path.is_file().then_some(path)
        })
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_programs() {
        assert!(find_program("definitely-not-a-real-program-xyz").is_none());
        #[cfg(unix)]
        assert!(find_program("sh").is_some());
    }
}
