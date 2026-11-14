//! Building a program from one file of source, once, and running it as often as it's needed.
//!
//! Each program is built in a directory named after what's in it, so the same source is only
//! built once, however many times it's checked against.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::Serialize;
use tokio_util::sync::CancellationToken;
use workshop_common::programs::{find_program, find_program_in};
use workshop_pack::Language;
use workshop_runner::Ending;

use crate::sandbox::Sandbox;

/// Where and how programs are built and run.
#[derive(Debug, Clone)]
pub struct Runtime {
    /// Where programs are written and built, a directory of Workshop's own.
    pub scratch: PathBuf,
    /// Environment variables for building and running, such as a toolchain's `PATH`.
    pub environment: Vec<(String, String)>,
    /// How long building may take.
    pub build_timeout: Duration,
    /// How long each run may take.
    pub run_timeout: Duration,
    /// What programs are built and run inside.
    pub sandbox: Sandbox,
}

/// The C++ compilers to look for, in order.
const CPP_COMPILERS: &[&str] = &["c++", "clang++", "g++"];

/// How a program is built: plainly, or with the checks a language can add for mistakes found
/// as it runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flavour {
    Plain,
    /// For C++, with the sanitizers, which stop it at the first sign of undefined behaviour,
    /// such as reading memory that's been freed. For Rust, as a debug build, which panics on an
    /// integer overflowing and checks `debug_assert!`. Python checks as it runs anyway.
    Checked,
}

/// A program that's been built, ready to run.
#[derive(Debug, Clone)]
pub struct Program {
    dir: PathBuf,
    command: Vec<String>,
}

/// What happened when a program ran.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Run {
    pub ending: Ending,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
}

impl Run {
    pub fn succeeded(&self) -> bool {
        self.ending == (Ending::Exited { code: Some(0) })
    }
}

/// What came of building a program.
#[derive(Debug, Clone)]
pub enum Built {
    Ready(Program),
    /// The compiler said why it couldn't build it.
    Failed {
        errors: String,
        ending: Ending,
    },
    /// What's needed to build or run it isn't installed, and what to install.
    Unavailable(String),
}

impl Runtime {
    /// Finds a program as building and running do: on the environment's `PATH`, if it sets one.
    pub fn find(&self, program: &str) -> Option<PathBuf> {
        match self.environment.iter().find(|(name, _)| name == "PATH") {
            Some((_, path)) => find_program_in(program, OsStr::new(path)),
            None => find_program(program),
        }
    }

    /// The command that builds a program in this language, to `{dir}/main`, without its source.
    fn compiler(
        &self,
        language: Language,
        flavour: Flavour,
    ) -> Result<Option<Vec<String>>, String> {
        let owned = |args: &[&str]| args.iter().map(|a| (*a).to_owned()).collect::<Vec<_>>();
        match language {
            Language::Python => {
                if self.find("python3").is_none() {
                    return Err("Python isn't installed: install python3".to_owned());
                }
                Ok(None)
            }
            Language::Rust => {
                if self.find("rustc").is_none() {
                    return Err(
                        "Rust isn't installed: install it from https://rustup.rs".to_owned()
                    );
                }
                let mut args = owned(&["rustc", "--edition", "2024"]);
                match flavour {
                    Flavour::Plain => args.push("-O".to_owned()),
                    Flavour::Checked => args.extend(owned(&[
                        "-C",
                        "debug-assertions=on",
                        "-C",
                        "overflow-checks=on",
                    ])),
                }
                args.extend(owned(&["--crate-name", "main", "-o", &binary()]));
                // rustc links with `cc`, which may need to be the compiler behind a shim.
                if let Some(cc) = self.find("cc") {
                    let linker = self.sandbox.program(&cc);
                    if linker != cc {
                        args.extend(["-C".to_owned(), format!("linker={}", linker.display())]);
                    }
                }
                Ok(Some(args))
            }
            Language::Cpp => {
                let Some(compiler) = CPP_COMPILERS.iter().find_map(|c| self.find(c)) else {
                    return Err(format!(
                        "no C++ compiler was found (looked for {}); install one, such as clang or GCC",
                        CPP_COMPILERS.join(", ")
                    ));
                };
                let compiler = self.sandbox.program(&compiler);
                let compiler = compiler.to_string_lossy();
                let mut args = owned(&[&compiler, "-std=c++17", "-o", &binary()]);
                match flavour {
                    Flavour::Plain => args.push("-O1".to_owned()),
                    Flavour::Checked => args.extend(owned(&[
                        "-O0",
                        "-g",
                        "-fno-omit-frame-pointer",
                        "-fsanitize=address,undefined",
                        "-fno-sanitize-recover=all",
                    ])),
                }
                Ok(Some(args))
            }
        }
    }

    /// Builds a program from its source, or finds it built already.
    pub async fn build(
        &self,
        language: Language,
        source: &str,
        flavour: Flavour,
        cancel: &CancellationToken,
    ) -> Result<Built> {
        let compiler = match self.compiler(language, flavour) {
            Ok(compiler) => compiler,
            Err(missing) => return Ok(Built::Unavailable(missing)),
        };
        let file = format!("main.{}", language.extension());
        let key = fingerprint(&[language.id(), &format!("{compiler:?}"), source]);
        let dir = self.scratch.join(&key);
        let command = match language {
            Language::Python => vec!["python3".to_owned(), file.clone()],
            Language::Rust | Language::Cpp => {
                vec![dir.join(binary()).to_string_lossy().into_owned()]
            }
        };
        let built = Program {
            dir: dir.clone(),
            command,
        };
        // Written last, so its being there means the rest is.
        let done = dir.join("built");
        if done.is_file() {
            return Ok(Built::Ready(built));
        }
        // Built somewhere of its own, then moved into place, so two builds of the same source
        // at once can't trip over each other.
        let staging = self
            .scratch
            .join(format!("building-{key}-{}", std::process::id()))
            .join(unique());
        std::fs::create_dir_all(&staging)
            .with_context(|| format!("creating {}", staging.display()))?;
        std::fs::write(staging.join(&file), source)?;
        if let Some(mut args) = compiler {
            args.push(file.clone());
            let confined = self
                .sandbox
                .confine(&args, &[], &staging, &self.environment)
                .with_context(|| format!("sandboxing the build in {}", staging.display()))?;
            let output = workshop_runner::execute(
                &confined.command,
                &staging,
                &confined.environment,
                None,
                self.build_timeout,
                cancel,
            )
            .await?;
            if output.ending != (Ending::Exited { code: Some(0) }) {
                let _ = std::fs::remove_dir_all(&staging);
                let errors = format!("{}{}", output.stdout, output.stderr);
                return Ok(Built::Failed {
                    errors: shorten_paths(&errors, &staging),
                    ending: output.ending,
                });
            }
        }
        std::fs::write(staging.join("built"), "")?;
        if let Some(parent) = dir.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if std::fs::rename(&staging, &dir).is_err() && !done.is_file() {
            anyhow::bail!("couldn't put the built program in {}", dir.display());
        }
        let _ = std::fs::remove_dir_all(&staging);
        if let Some(parent) = staging.parent() {
            let _ = std::fs::remove_dir(parent);
        }
        Ok(Built::Ready(built))
    }

    /// Runs a built program on `input`, with `args` after its command.
    pub async fn run(
        &self,
        program: &Program,
        args: &[String],
        input: &str,
        cancel: &CancellationToken,
    ) -> Result<Run> {
        let started = Instant::now();
        let command: Vec<String> = program.command.iter().chain(args).cloned().collect();
        // Somewhere of its own to write, as the program's directory is shared by every run.
        let scratch =
            self.scratch
                .join("running")
                .join(format!("{}-{}", std::process::id(), unique()));
        std::fs::create_dir_all(&scratch)
            .with_context(|| format!("creating {}", scratch.display()))?;
        let output = async {
            let confined = self
                .sandbox
                .confine(&command, &[&program.dir], &scratch, &self.environment)
                .with_context(|| format!("sandboxing a run of {}", program.dir.display()))?;
            workshop_runner::execute(
                &confined.command,
                &program.dir,
                &confined.environment,
                Some(input),
                self.run_timeout,
                cancel,
            )
            .await
        }
        .await;
        let _ = std::fs::remove_dir_all(&scratch);
        let output = output?;
        Ok(Run {
            ending: output.ending,
            stdout: output.stdout,
            stderr: shorten_paths(&output.stderr, &program.dir),
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }
}

/// The file a compiled program is built to: `main`, or `main.exe` on Windows.
fn binary() -> String {
    format!("main{}", std::env::consts::EXE_SUFFIX)
}

/// Paths in the build directory, as compilers and tracebacks give them, without the directory,
/// which means nothing to the learner and takes much of a phone's width.
fn shorten_paths(text: &str, dir: &Path) -> String {
    // A program sees its directory with any links resolved, such as macOS's /private/var.
    let resolved = dir.canonicalize().ok();
    [resolved.as_deref(), Some(dir)]
        .into_iter()
        .flatten()
        .fold(text.to_owned(), |text, dir| {
            text.replace(
                &format!("{}{}", dir.display(), std::path::MAIN_SEPARATOR),
                "",
            )
        })
}

/// A name for what's in some pieces of text, the same every time, for the directory a program
/// is built in.
fn fingerprint(parts: &[&str]) -> String {
    // FNV-1a, whose value never changes between versions, with the parts kept apart.
    let hash = parts.iter().fold(0xcbf2_9ce4_8422_2325_u64, |hash, part| {
        part.bytes().chain([0xff]).fold(hash, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
        })
    });
    format!("{hash:016x}")
}

/// A name no other build in this process has.
fn unique() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    NEXT.fetch_add(1, Ordering::Relaxed).to_string()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn runtime(dir: &Path) -> Runtime {
        Runtime {
            scratch: dir.to_owned(),
            environment: Vec::new(),
            build_timeout: Duration::from_secs(60),
            run_timeout: Duration::from_secs(60),
            sandbox: Sandbox::Unconfined,
        }
    }

    async fn built(runtime: &Runtime, language: Language, source: &str) -> Built {
        runtime
            .build(language, source, Flavour::Plain, &CancellationToken::new())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn builds_once_and_runs_many_times() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = runtime(dir.path());
        let source = "use std::io::Read;\nfn main() {\n    let mut s = String::new();\n    std::io::stdin().read_to_string(&mut s).unwrap();\n    let args: Vec<String> = std::env::args().skip(1).collect();\n    println!(\"{} {}\", s.trim(), args.join(\",\"));\n}\n";
        let Built::Ready(program) = built(&runtime, Language::Rust, source).await else {
            panic!("didn't build");
        };
        let cancel = CancellationToken::new();
        let run = runtime
            .run(
                &program,
                &["a".to_owned(), "b".to_owned()],
                "hello\n",
                &cancel,
            )
            .await
            .unwrap();
        assert!(run.succeeded(), "{run:?}");
        assert_eq!(run.stdout, "hello a,b\n");
        // The second build finds the first.
        let entries = std::fs::read_dir(dir.path()).unwrap().count();
        assert!(matches!(
            built(&runtime, Language::Rust, source).await,
            Built::Ready(_)
        ));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), entries);
    }

    #[tokio::test]
    async fn says_why_a_program_wont_build() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = runtime(dir.path());
        let Built::Failed { errors, .. } = built(&runtime, Language::Rust, "fn main() { x }").await
        else {
            panic!("built a broken program");
        };
        assert!(errors.contains("main.rs"), "{errors}");
        assert!(
            !errors.contains(&dir.path().display().to_string()),
            "{errors}"
        );
    }

    #[tokio::test]
    async fn runs_python_and_reports_crashes() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = runtime(dir.path());
        let Built::Ready(program) = built(
            &runtime,
            Language::Python,
            "import sys\nprint(1 // int(sys.stdin.read()))\n",
        )
        .await
        else {
            panic!("python isn't available");
        };
        let cancel = CancellationToken::new();
        let fine = runtime.run(&program, &[], "1", &cancel).await.unwrap();
        assert_eq!(fine.stdout, "1\n");
        let crashed = runtime.run(&program, &[], "0", &cancel).await.unwrap();
        assert!(!crashed.succeeded());
        assert!(
            crashed.stderr.contains("ZeroDivisionError"),
            "{}",
            crashed.stderr
        );
        assert!(crashed.stderr.contains("main.py"), "{}", crashed.stderr);
    }

    #[tokio::test]
    async fn says_what_to_install_when_a_compiler_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let mut runtime = runtime(dir.path());
        runtime.environment = vec![("PATH".to_owned(), dir.path().display().to_string())];
        let Built::Unavailable(why) = built(&runtime, Language::Cpp, "int main() {}").await else {
            panic!("found a compiler where there's none");
        };
        assert!(why.contains("no C++ compiler"), "{why}");
        assert!(matches!(
            built(&runtime, Language::Python, "").await,
            Built::Unavailable(_)
        ));
    }

    #[test]
    fn fingerprints_keep_parts_apart() {
        assert_ne!(fingerprint(&["ab", "c"]), fingerprint(&["a", "bc"]));
        assert_eq!(fingerprint(&["a"]), fingerprint(&["a"]));
    }
}
