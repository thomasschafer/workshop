//! Confining the programs built and run for coding and reading items, some of which a model
//! wrote: no network, writes only to a directory of the build's or run's own, and reads only of
//! the system, the toolchains and the program itself.
//!
//! On macOS that's Seatbelt, through `sandbox-exec`, and on Linux bubblewrap, if it's installed
//! and works. Elsewhere there's no sandbox, and callers decide whether to run programs without
//! one.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use workshop_common::programs::{find_program, find_program_in};

/// What programs are built and run inside.
#[derive(Debug, Clone)]
pub enum Sandbox {
    /// macOS's sandbox, through `sandbox-exec`.
    Seatbelt(Seatbelt),
    /// bubblewrap, on Linux.
    Bubblewrap(Bubblewrap),
    /// Nothing: programs run with all the user's access. Only ever chosen knowingly.
    Unconfined,
}

#[derive(Debug, Clone)]
pub struct Seatbelt {
    /// Directories hidden from programs, such as home directories and shared temporary ones.
    hidden: Vec<PathBuf>,
    /// The toolchains' directories inside `hidden`, which programs may still read.
    toolchains: Vec<PathBuf>,
    /// The SDK, for compilers that would otherwise ask `xcrun`, which doesn't work inside.
    sdk: Option<String>,
    /// The `xcrun` shims in `/usr/bin`, such as `c++`, with the compilers they start.
    shims: Vec<(PathBuf, PathBuf)>,
}

#[derive(Debug, Clone)]
pub struct Bubblewrap {
    bwrap: PathBuf,
    hidden: Vec<PathBuf>,
    toolchains: Vec<PathBuf>,
    /// Links directly in the hidden directories to places that aren't hidden, such as NixOS's
    /// `/run/current-system`, made again inside, as where they lead is visible anyway.
    links: Vec<(PathBuf, PathBuf)>,
}

/// A command ready to start, inside the sandbox if there is one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Confined {
    pub command: Vec<String>,
    pub environment: Vec<(String, String)>,
}

/// The compilers that `/usr/bin` has `xcrun` shims for on macOS.
const XCRUN_SHIMS: &[&str] = &["cc", "c++", "clang", "clang++", "gcc", "g++"];

/// The programs whose installations are read, for finding where they keep the rest of
/// themselves, such as Python's standard library.
const TOOLCHAIN_PROGRAMS: &[&str] = &["python3", "rustc", "cc", "c++", "clang++", "g++"];

/// Allows what building and running a program needs, and denies everything else, including
/// all network access, talking to other processes and services, and sending Apple events.
/// Reading any file's metadata is allowed, as tools look at the directories above theirs, so a
/// program can see which files exist, but not what's in the hidden ones.
const SEATBELT_PROFILE: &str = r#"(version 1)
(deny default)
(allow process-exec process-fork)
(allow signal (target same-sandbox))
(allow sysctl-read)
(allow file-read*)
"#;

impl Sandbox {
    /// The sandbox this machine offers, if any, for programs run with `environment`. Found once
    /// for each environment, as finding it starts a few programs.
    pub async fn detect(environment: &[(String, String)]) -> Option<Self> {
        type Found = Vec<(Vec<(String, String)>, Option<Sandbox>)>;
        static FOUND: tokio::sync::Mutex<Found> = tokio::sync::Mutex::const_new(Vec::new());
        let mut found = FOUND.lock().await;
        if let Some((_, sandbox)) = found.iter().find(|(e, _)| e == environment) {
            return sandbox.clone();
        }
        let sandbox = Self::find(environment).await;
        found.push((environment.to_vec(), sandbox.clone()));
        sandbox
    }

    async fn find(environment: &[(String, String)]) -> Option<Self> {
        if cfg!(target_os = "macos") {
            let sandbox_exec = Path::new("/usr/bin/sandbox-exec");
            if !sandbox_exec.is_file() {
                return None;
            }
            let hidden = existing(
                [
                    "/Users",
                    "/Volumes",
                    "/private/tmp",
                    "/private/var/tmp",
                    "/private/var/folders",
                ]
                .into_iter()
                .map(PathBuf::from)
                .chain(dirs::home_dir()),
            );
            let mut shims = Vec::new();
            for name in XCRUN_SHIMS {
                let shim = Path::new("/usr/bin").join(name);
                if shim.is_file()
                    && let Some(found) = xcrun(&["--find", name]).await
                {
                    shims.push((shim, PathBuf::from(found)));
                }
            }
            let seatbelt = Seatbelt {
                toolchains: toolchains(environment, &hidden),
                hidden,
                sdk: xcrun(&["--show-sdk-path"]).await,
                shims,
            };
            // Checked once, so a sandbox that doesn't start fails here rather than in every
            // build.
            let probe = Self::Seatbelt(seatbelt.clone());
            works(&probe).await.then_some(probe)
        } else if cfg!(target_os = "linux") {
            let bwrap = find_program("bwrap")?;
            let home = dirs::home_dir();
            let hidden = existing(
                // `/run` has local services' sockets, which are reachable without a network.
                [
                    "/home", "/root", "/tmp", "/var/tmp", "/run", "/media", "/mnt",
                ]
                .into_iter()
                .map(PathBuf::from)
                .chain(home),
            );
            let probe = Self::Bubblewrap(Bubblewrap {
                bwrap,
                toolchains: toolchains(environment, &hidden),
                links: links_out(&hidden),
                hidden,
            });
            works(&probe).await.then_some(probe)
        } else {
            None
        }
    }

    /// Whether programs run inside a sandbox at all.
    pub fn confines(&self) -> bool {
        !matches!(self, Self::Unconfined)
    }

    /// The program to start for `found`: the compiler itself rather than macOS's `xcrun` shim
    /// for it, which can't find the compiler from inside the sandbox.
    pub fn program(&self, found: &Path) -> PathBuf {
        match self {
            Self::Seatbelt(seatbelt) => seatbelt
                .shims
                .iter()
                .find(|(shim, _)| shim == found)
                .map_or_else(|| found.to_owned(), |(_, compiler)| compiler.clone()),
            Self::Bubblewrap(_) | Self::Unconfined => found.to_owned(),
        }
    }

    /// `command`, run with `environment`, made to run in the sandbox, able to read `reads` and
    /// to read and write `writes`, which is also its temporary directory.
    pub fn confine(
        &self,
        command: &[String],
        reads: &[&Path],
        writes: &Path,
        environment: &[(String, String)],
    ) -> std::io::Result<Confined> {
        let writes = writes.canonicalize()?;
        let reads = reads
            .iter()
            .map(|path| path.canonicalize())
            .collect::<std::io::Result<Vec<_>>>()?;
        let mut environment = environment.to_vec();
        let command = match self {
            Self::Unconfined => command.to_vec(),
            Self::Seatbelt(seatbelt) => {
                set(&mut environment, "TMPDIR", display(&writes));
                if let Some(sdk) = &seatbelt.sdk
                    && !environment.iter().any(|(name, _)| name == "SDKROOT")
                {
                    environment.push(("SDKROOT".to_owned(), sdk.clone()));
                }
                seatbelt.command(command, &reads, &writes)
            }
            Self::Bubblewrap(bubblewrap) => {
                set(&mut environment, "TMPDIR", display(&writes));
                bubblewrap.command(command, &reads, &writes)
            }
        };
        Ok(Confined {
            command,
            environment,
        })
    }
}

impl Seatbelt {
    fn command(&self, command: &[String], reads: &[PathBuf], writes: &Path) -> Vec<String> {
        let mut profile = SEATBELT_PROFILE.to_owned();
        let mut args = vec!["/usr/bin/sandbox-exec".to_owned()];
        // Paths are given as parameters, so they never need quoting in the profile.
        let mut param = |profile: &mut String, rule: &str, name: String, path: &Path| {
            profile.push_str(&format!("({rule} (subpath (param \"{name}\")))\n"));
            args.extend(["-D".to_owned(), format!("{name}={}", display(path))]);
        };
        for (i, path) in self.hidden.iter().enumerate() {
            param(&mut profile, "deny file-read*", format!("HIDDEN{i}"), path);
        }
        // After the denials, which these override.
        profile.push_str("(allow file-read-metadata)\n");
        for (i, path) in self.toolchains.iter().chain(reads).enumerate() {
            param(&mut profile, "allow file-read*", format!("READ{i}"), path);
        }
        param(&mut profile, "allow file-read*", "WRITE".to_owned(), writes);
        param(
            &mut profile,
            "allow file-write*",
            "WRITE".to_owned(),
            writes,
        );
        profile.push_str("(allow file-write-data (literal \"/dev/null\"))\n");
        args.extend(["-p".to_owned(), profile]);
        args.extend(command.iter().cloned());
        args
    }
}

impl Bubblewrap {
    fn command(&self, command: &[String], reads: &[PathBuf], writes: &Path) -> Vec<String> {
        let mut args = vec![display(&self.bwrap)];
        let mut push = |parts: &[&str]| args.extend(parts.iter().map(|p| (*p).to_owned()));
        // A new namespace of every kind, so no network, and nothing outside to signal or talk
        // to, with the whole system read-only, then the hidden directories replaced with empty
        // ones, and only then what may be read and written mounted over them.
        push(&["--unshare-all", "--die-with-parent", "--ro-bind", "/", "/"]);
        push(&["--dev", "/dev", "--proc", "/proc"]);
        for path in &self.hidden {
            push(&["--tmpfs", &display(path)]);
        }
        for (target, link) in &self.links {
            push(&["--symlink", &display(target), &display(link)]);
        }
        for path in self.toolchains.iter().chain(reads) {
            push(&["--ro-bind", &display(path), &display(path)]);
        }
        push(&["--bind", &display(writes), &display(writes), "--"]);
        args.extend(command.iter().cloned());
        args
    }
}

/// The directories toolchains keep themselves in, inside the `hidden` ones: those that their
/// managers, such as rustup and mise, use, the directories on the `PATH`, and the
/// installations of the programs building and running use.
fn toolchains(environment: &[(String, String)], hidden: &[PathBuf]) -> Vec<PathBuf> {
    let var = |name: &str| {
        environment
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, value)| value.into())
            .or_else(|| std::env::var_os(name))
    };
    let home = dirs::home_dir();
    let in_home = |path: &str| home.as_ref().map(|home| home.join(path));
    let or_home = |name: &str, default: &str| var(name).map(PathBuf::from).or(in_home(default));
    let mut candidates: Vec<PathBuf> = [
        or_home("RUSTUP_HOME", ".rustup"),
        // Only its programs: the rest of Cargo's directory has the user's credentials.
        or_home("CARGO_HOME", ".cargo").map(|cargo| cargo.join("bin")),
        or_home("MISE_DATA_DIR", ".local/share/mise"),
        or_home("MISE_CONFIG_DIR", ".config/mise"),
        in_home(".nix-profile"),
    ]
    .into_iter()
    .flatten()
    .collect();
    let path = var("PATH");
    let search = path.as_deref();
    candidates.extend(search.into_iter().flat_map(std::env::split_paths));
    for program in TOOLCHAIN_PROGRAMS {
        let found = match search {
            Some(path) => find_program_in(program, path),
            None => find_program(program),
        };
        let Some(real) = found.and_then(|found| found.canonicalize().ok()) else {
            continue;
        };
        // An installation's prefix, such as `python3.13` for `python3.13/bin/python3`.
        let dir = real.parent();
        let prefix = match dir {
            Some(dir) if dir.file_name() == Some(OsStr::new("bin")) => dir.parent(),
            _ => dir,
        };
        candidates.extend(prefix.map(Path::to_owned));
    }
    let mut toolchains = Vec::new();
    for candidate in candidates {
        let Ok(real) = candidate.canonicalize() else {
            continue;
        };
        // Never a whole hidden directory, a home directory or one directly in it, such as
        // ~/.local, which would let programs read much more than any toolchain.
        let too_wide = hidden.iter().any(|hidden| {
            hidden.starts_with(&real) || real.parent().is_some_and(|parent| parent == hidden)
        }) || home.as_ref().is_some_and(|home| {
            let home = home.canonicalize().unwrap_or_else(|_| home.clone());
            home.starts_with(&real) || real.parent() == Some(home.as_path())
        });
        let explicit = real.ends_with(".rustup") || real.ends_with(".cargo/bin");
        if (too_wide && !explicit) || !hidden.iter().any(|hidden| real.starts_with(hidden)) {
            continue;
        }
        if !toolchains.contains(&real) {
            toolchains.push(real);
        }
    }
    toolchains
}

/// The directories among `paths` that exist, with any links resolved, as the sandboxes match
/// paths once they're resolved.
fn existing(paths: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = Vec::new();
    for path in paths {
        if let Ok(real) = path.canonicalize()
            && real.is_dir()
            && !found.contains(&real)
        {
            found.push(real);
        }
    }
    found
}

/// The links directly in `hidden` directories that lead somewhere not hidden.
fn links_out(hidden: &[PathBuf]) -> Vec<(PathBuf, PathBuf)> {
    let mut links = Vec::new();
    for dir in hidden {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let link = entry.path();
            let (Ok(target), Ok(real)) = (std::fs::read_link(&link), link.canonicalize()) else {
                continue;
            };
            if !hidden.iter().any(|hidden| real.starts_with(hidden)) {
                links.push((target, link));
            }
        }
    }
    links
}

/// What `xcrun` says, if it's there and succeeds.
async fn xcrun(args: &[&str]) -> Option<String> {
    let output = workshop_common::process::command("/usr/bin/xcrun")
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;
    let found = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    (output.status.success() && !found.is_empty()).then_some(found)
}

/// Whether a trivial program runs in the sandbox.
async fn works(sandbox: &Sandbox) -> bool {
    let Ok(dir) = tempfile::tempdir() else {
        return false;
    };
    let Ok(confined) = sandbox.confine(&["true".to_owned()], &[], dir.path(), &[]) else {
        return false;
    };
    let Some((program, args)) = confined.command.split_first() else {
        return false;
    };
    workshop_common::process::command(program)
        .args(args)
        .envs(confined.environment)
        .current_dir(dir.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .is_ok_and(|status| status.success())
}

fn set(environment: &mut Vec<(String, String)>, name: &str, value: String) {
    environment.retain(|(n, _)| n != name);
    environment.push((name.to_owned(), value));
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|p| (*p).to_owned()).collect()
    }

    #[test]
    fn bubblewrap_mounts_what_may_be_read_over_what_is_hidden() {
        let bubblewrap = Bubblewrap {
            bwrap: PathBuf::from("/usr/bin/bwrap"),
            hidden: vec![PathBuf::from("/home/me"), PathBuf::from("/tmp")],
            toolchains: vec![PathBuf::from("/home/me/.rustup")],
            links: vec![(
                PathBuf::from("/nix/store/abc-system"),
                PathBuf::from("/run/current-system"),
            )],
        };
        let command = bubblewrap.command(
            &strings(&["./main", "x"]),
            &[PathBuf::from("/home/me/build/abc")],
            Path::new("/home/me/build/run-1"),
        );
        assert_eq!(
            command,
            strings(&[
                "/usr/bin/bwrap",
                "--unshare-all",
                "--die-with-parent",
                "--ro-bind",
                "/",
                "/",
                "--dev",
                "/dev",
                "--proc",
                "/proc",
                "--tmpfs",
                "/home/me",
                "--tmpfs",
                "/tmp",
                "--symlink",
                "/nix/store/abc-system",
                "/run/current-system",
                "--ro-bind",
                "/home/me/.rustup",
                "/home/me/.rustup",
                "--ro-bind",
                "/home/me/build/abc",
                "/home/me/build/abc",
                "--bind",
                "/home/me/build/run-1",
                "/home/me/build/run-1",
                "--",
                "./main",
                "x",
            ])
        );
    }

    #[test]
    fn seatbelt_allows_reads_after_hiding_and_writes_only_to_one_directory() {
        let seatbelt = Seatbelt {
            hidden: vec![PathBuf::from("/Users")],
            toolchains: vec![PathBuf::from("/Users/me/.rustup")],
            sdk: None,
            shims: Vec::new(),
        };
        let command = seatbelt.command(
            &strings(&["python3", "main.py"]),
            &[PathBuf::from("/Users/me/build/abc")],
            Path::new("/Users/me/build/run \"1\""),
        );
        let profile_at = command.iter().position(|a| a == "-p").unwrap() + 1;
        let profile = &command[profile_at];
        let rules: Vec<&str> = profile.lines().collect();
        let at = |rule: &str| rules.iter().position(|r| *r == rule).unwrap();
        assert!(at("(deny default)") < at("(allow file-read*)"));
        assert!(
            at("(deny file-read* (subpath (param \"HIDDEN0\")))")
                < at("(allow file-read* (subpath (param \"READ0\")))")
        );
        assert_eq!(profile.matches("allow file-write*").count(), 1, "{profile}");
        assert!(!profile.contains("network"), "{profile}");
        assert!(!profile.contains("mach"), "{profile}");
        // Paths with quotes in them stay out of the profile.
        assert!(!profile.contains("run"), "{profile}");
        assert!(command.contains(&"WRITE=/Users/me/build/run \"1\"".to_owned()));
        assert!(command.contains(&"READ1=/Users/me/build/abc".to_owned()));
        assert_eq!(command[profile_at + 1..], strings(&["python3", "main.py"]));
    }

    #[test]
    fn toolchains_never_include_a_whole_home_directory() {
        let home = dirs::home_dir().unwrap().canonicalize().unwrap();
        let hidden = vec![home.clone()];
        let environment = vec![(
            "PATH".to_owned(),
            std::env::join_paths([home.clone(), home.join(".local")])
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        )];
        let found = toolchains(&environment, &hidden);
        for dir in &found {
            assert_ne!(dir, &home);
            if dir.parent() == Some(home.as_path()) {
                assert!(dir.ends_with(".rustup"), "{found:?}");
            }
        }
    }
}

/// Programs that try to get out, built and run in the real sandbox with the real toolchains.
#[cfg(all(test, unix))]
mod confinement {
    use std::io::Read;
    use std::net::TcpListener;
    use std::time::Duration;

    use tokio_util::sync::CancellationToken;
    use workshop_pack::Language;

    use super::*;
    use crate::programs::{Built, Flavour, Runtime};

    /// A runtime with this machine's sandbox, or `None` where there isn't one. macOS always has
    /// one.
    async fn runtime(scratch: &Path) -> Option<Runtime> {
        let sandbox = Sandbox::detect(&[]).await;
        if cfg!(target_os = "macos") {
            assert!(sandbox.is_some(), "macOS always has sandbox-exec");
        }
        Some(Runtime {
            scratch: scratch.to_owned(),
            environment: Vec::new(),
            build_timeout: Duration::from_secs(120),
            run_timeout: Duration::from_secs(30),
            sandbox: sandbox?,
        })
    }

    /// Somewhere outside the build directory, with a file in it that programs mustn't read,
    /// and a port that they mustn't reach.
    struct Outside {
        dir: tempfile::TempDir,
        listener: TcpListener,
    }

    impl Outside {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            std::fs::write(dir.path().join("secret"), "the secret").unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            Self { dir, listener }
        }

        fn path(&self, name: &str) -> String {
            self.dir.path().join(name).display().to_string()
        }

        fn port(&self) -> u16 {
            self.listener.local_addr().unwrap().port()
        }

        /// Checks nothing got out.
        fn untouched(&self) {
            let names: Vec<_> = std::fs::read_dir(self.dir.path())
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect();
            assert_eq!(names, ["secret"], "a program wrote outside its directory");
            match self.listener.accept() {
                Ok((mut stream, _)) => {
                    let mut sent = String::new();
                    let _ = stream.read_to_string(&mut sent);
                    panic!("a program connected to the network, sending {sent:?}");
                }
                Err(err) => assert_eq!(err.kind(), std::io::ErrorKind::WouldBlock),
            }
        }
    }

    async fn build_and_run(runtime: &Runtime, language: Language, source: &str) -> String {
        let cancel = CancellationToken::new();
        let built = runtime
            .build(language, source, Flavour::Plain, &cancel)
            .await
            .unwrap();
        let program = match built {
            Built::Ready(program) => program,
            Built::Failed { errors, .. } => panic!("didn't build:\n{errors}"),
            Built::Unavailable(why) => panic!("can't build here: {why}"),
        };
        let run = runtime.run(&program, &[], "", &cancel).await.unwrap();
        assert!(run.succeeded(), "{run:?}");
        run.stdout
    }

    #[tokio::test]
    async fn python_can_only_write_to_its_own_directory_and_cant_connect() {
        let scratch = tempfile::tempdir().unwrap();
        let Some(runtime) = runtime(scratch.path()).await else {
            return;
        };
        let outside = Outside::new();
        let source = format!(
            r#"import os, socket, tempfile
def attempt(name, action):
    try:
        action()
        print(name, "allowed")
    except Exception:
        print(name, "refused")
attempt("write", lambda: open({escaped:?}, "w").write("out"))
attempt("read", lambda: open({secret:?}).read())
attempt("connect", lambda: socket.create_connection(("127.0.0.1", {port}), timeout=5).sendall(b"out"))
attempt("resolve", lambda: socket.getaddrinfo("example.com", 80))
attempt("temporary", lambda: tempfile.TemporaryFile().write(b"fine"))
"#,
            escaped = outside.path("escaped"),
            secret = outside.path("secret"),
            port = outside.port(),
        );
        let printed = build_and_run(&runtime, Language::Python, &source).await;
        assert_eq!(
            printed,
            "write refused\nread refused\nconnect refused\nresolve refused\ntemporary allowed\n"
        );
        outside.untouched();
    }

    #[tokio::test]
    async fn rust_can_only_write_to_its_own_directory_and_cant_connect() {
        let scratch = tempfile::tempdir().unwrap();
        let Some(runtime) = runtime(scratch.path()).await else {
            return;
        };
        let outside = Outside::new();
        let source = format!(
            r#"use std::io::Write;
fn main() {{
    let write = std::fs::write({escaped:?}, "out").is_ok();
    let read = std::fs::read_to_string({secret:?}).is_ok();
    let connect = std::net::TcpStream::connect(("127.0.0.1", {port}))
        .and_then(|mut s| s.write_all(b"out"))
        .is_ok();
    println!("{{write}} {{read}} {{connect}}");
}}
"#,
            escaped = outside.path("escaped"),
            secret = outside.path("secret"),
            port = outside.port(),
        );
        let printed = build_and_run(&runtime, Language::Rust, &source).await;
        assert_eq!(printed, "false false false\n");
        outside.untouched();
    }

    #[tokio::test]
    async fn builds_cant_read_outside_either() {
        let scratch = tempfile::tempdir().unwrap();
        let Some(runtime) = runtime(scratch.path()).await else {
            return;
        };
        let outside = Outside::new();
        let source = format!(
            "fn main() {{ print!(\"{{}}\", include_str!({:?})); }}\n",
            outside.path("secret")
        );
        let built = runtime
            .build(
                Language::Rust,
                &source,
                Flavour::Plain,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        let Built::Failed { errors, .. } = built else {
            panic!("read a file outside while building: {built:?}");
        };
        assert!(errors.contains("secret"), "{errors}");
        outside.untouched();
    }

    #[tokio::test]
    async fn cpp_can_only_write_to_its_own_directory_and_cant_connect() {
        let scratch = tempfile::tempdir().unwrap();
        let Some(runtime) = runtime(scratch.path()).await else {
            return;
        };
        if ["c++", "clang++", "g++"]
            .iter()
            .all(|c| runtime.find(c).is_none())
        {
            return;
        }
        let outside = Outside::new();
        let source = format!(
            r#"#include <arpa/inet.h>
#include <cstdio>
#include <fstream>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
int main() {{
    std::ofstream out({escaped:?});
    out << "out";
    out.flush();
    std::ifstream in({secret:?});
    std::string secret;
    in >> secret;
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in address{{}};
    address.sin_family = AF_INET;
    address.sin_port = htons({port});
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    bool connected = fd >= 0 && connect(fd, (sockaddr*)&address, sizeof address) == 0;
    std::printf("%d %d %d\n", (bool)out, !secret.empty(), connected);
}}
"#,
            escaped = outside.path("escaped"),
            secret = outside.path("secret"),
            port = outside.port(),
        );
        let printed = build_and_run(&runtime, Language::Cpp, &source).await;
        assert_eq!(printed, "0 0 0\n");
        outside.untouched();
    }
}
