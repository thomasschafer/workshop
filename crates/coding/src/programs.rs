//! Building a program from one file of source, once, and running it as often as it's needed.
//!
//! Each program is built in a directory named after what's in it, so the same source is only
//! built once, however many times it's checked against.

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tokio::sync::OnceCell;
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
    /// Environment variables for building and running in each language, such as its
    /// toolchain's `PATH`. A language with none is built and run with Workshop's own.
    pub environments: BTreeMap<Language, Vec<(String, String)>>,
    /// How long building may take.
    pub build_timeout: Duration,
    /// How long each run may take.
    pub run_timeout: Duration,
    /// What programs are built and run inside.
    pub sandbox: Sandbox,
    /// The interpreters and compilers found for building and running, each the first time
    /// it's needed.
    pub tools: Tools,
}

/// The interpreter or compiler that building or running in a language starts, and the
/// directories the sandbox must let it read beyond those it always allows.
#[derive(Debug, Clone)]
struct Tool {
    program: String,
    reads: Vec<PathBuf>,
}

/// Each language's [`Tool`], once it's been found, which may take starting it.
#[derive(Debug, Clone, Default)]
pub struct Tools(Arc<[OnceCell<Tool>; Language::ALL.len()]>);

impl Tools {
    fn of(&self, language: Language) -> &OnceCell<Tool> {
        let index = Language::ALL
            .iter()
            .position(|l| *l == language)
            .expect("every language is in ALL");
        &self.0[index]
    }
}

/// The C++ compilers to look for, in order.
const CPP_COMPILERS: &[&str] = &["c++", "clang++", "g++"];

/// The program building and running in `language` needs: its interpreter or compiler, or for
/// C++, the first of the compilers looked for.
pub fn needs(language: Language) -> &'static str {
    match language {
        Language::Python => "python3",
        Language::Rust => "rustc",
        Language::Cpp => CPP_COMPILERS[0],
        Language::Haskell => "ghc",
    }
}

/// The packages Haskell programs can use: those that come with GHC, so an item builds wherever
/// GHC is installed, whatever else is.
pub const HASKELL_PACKAGES: &[&str] = &[
    "base",
    "containers",
    "array",
    "mtl",
    "transformers",
    "stm",
    "text",
    "bytestring",
    "deepseq",
    "parsec",
];

/// The flags that keep GHC to `HASKELL_PACKAGES`, for building and for the language server:
/// packages the user installed for themselves, in their own package database or a package
/// environment, aren't seen.
pub fn ghc_package_flags() -> Vec<String> {
    let mut flags = vec![
        "-no-user-package-db".to_owned(),
        "-hide-all-packages".to_owned(),
    ];
    for package in HASKELL_PACKAGES {
        flags.extend(["-package".to_owned(), (*package).to_owned()]);
    }
    flags
}

/// The most memory a Haskell program may use. Beyond it, the program stops, saying the heap is
/// exhausted, rather than taking all the machine has until its time is up.
const HASKELL_HEAP: &str = "1g";

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
    language: Language,
    dir: PathBuf,
    command: Vec<String>,
    /// What else running it reads, such as its interpreter's installation.
    reads: Vec<PathBuf>,
}

/// What happened when a program ran.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Run {
    pub ending: Ending,
    pub stdout: String,
    pub stderr: String,
    /// The size output is cut off at, if it printed more than that, in bytes. What it printed
    /// then can't be compared with anything.
    pub cut_off: Option<usize>,
    pub duration_ms: u64,
}

impl Run {
    pub fn succeeded(&self) -> bool {
        self.ending == (Ending::Exited { code: Some(0) })
    }

    /// Whether it ran to the end without an error, and everything it printed was kept.
    pub fn printed_in_full(&self) -> bool {
        self.succeeded() && self.cut_off.is_none()
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
    /// The environment variables for building and running in `language`.
    pub fn environment(&self, language: Language) -> &[(String, String)] {
        self.environments.get(&language).map_or(&[], Vec::as_slice)
    }

    /// Finds a program as building and running in `language` do: on its environment's `PATH`,
    /// if it sets one.
    pub fn find(&self, language: Language, program: &str) -> Option<PathBuf> {
        match self
            .environment(language)
            .iter()
            .find(|(name, _)| name == "PATH")
        {
            Some((_, path)) => find_program_in(program, OsStr::new(path)),
            None => find_program(program),
        }
    }

    /// The interpreter or compiler to start for building or running in `language`, which is
    /// at `found` on its `PATH`.
    ///
    /// Inside a sandbox, Python is asked which interpreter it is, as is Rust's compiler if it
    /// may be a version manager's shim (see [`Sandbox::may_be_shim`]), and that's what's
    /// started instead. Python always is, as macOS's own `python3` is a shim too, and the
    /// interpreter Python names runs as it is, whether it's a virtual environment's or a
    /// wrapper's. They're asked outside the sandbox, as only there can a shim read the files it
    /// decides by, and in the directory programs are built and run in, so a shim decides as it
    /// would for them. Nothing a pack's programs write can be there, as each writes only to a
    /// directory of its own inside it.
    async fn tool(
        &self,
        language: Language,
        found: &Path,
        cancel: &CancellationToken,
    ) -> Result<Tool> {
        self.tools
            .of(language)
            .get_or_try_init(|| self.ask_tool(language, found, cancel))
            .await
            .cloned()
    }

    async fn ask_tool(
        &self,
        language: Language,
        found: &Path,
        cancel: &CancellationToken,
    ) -> Result<Tool> {
        let as_found = Tool {
            program: needs(language).to_owned(),
            reads: Vec::new(),
        };
        if !self.sandbox.confines() {
            return Ok(as_found);
        }
        let (question, answer): (&[&str], fn(&str) -> PathBuf) = match language {
            Language::Python => (
                &["-I", "-c", "import sys; print(sys.executable)"],
                |executable| PathBuf::from(executable),
            ),
            Language::Rust if self.sandbox.may_be_shim(found) => {
                (&["--print", "sysroot"], |sysroot| {
                    Path::new(sysroot)
                        .join("bin")
                        .join(format!("rustc{}", std::env::consts::EXE_SUFFIX))
                })
            }
            Language::Rust | Language::Cpp | Language::Haskell => return Ok(as_found),
        };
        std::fs::create_dir_all(&self.scratch)
            .with_context(|| format!("creating {}", self.scratch.display()))?;
        let mut command = vec![found.to_string_lossy().into_owned()];
        command.extend(question.iter().map(|part| (*part).to_owned()));
        let output = workshop_runner::execute(
            &command,
            &self.scratch,
            self.environment(language),
            None,
            self.build_timeout,
            cancel,
        )
        .await?;
        let said = output.stdout.trim();
        if output.ending != (Ending::Exited { code: Some(0) }) || said.is_empty() {
            anyhow::bail!(
                "couldn't find out which program {} starts: `{}` in {} printed nothing it could use:\n{}",
                found.display(),
                command.join(" "),
                self.scratch.display(),
                output.stderr.trim_end()
            );
        }
        let program = answer(said);
        if !program.is_file() {
            anyhow::bail!(
                "{} says it starts {}, which isn't there",
                found.display(),
                program.display()
            );
        }
        Ok(Tool {
            reads: self.sandbox.installation(&program),
            program: program.to_string_lossy().into_owned(),
        })
    }

    /// The command that builds a program in this language, to `{dir}/main`, without its source,
    /// and the interpreter or compiler it starts; or what to install for it.
    async fn compiler(
        &self,
        language: Language,
        flavour: Flavour,
        cancel: &CancellationToken,
    ) -> Result<Result<(Option<Vec<String>>, Tool), String>> {
        let owned = |args: &[&str]| args.iter().map(|a| (*a).to_owned()).collect::<Vec<_>>();
        Ok(match language {
            Language::Python => {
                let Some(found) = self.find(language, needs(language)) else {
                    return Ok(Err("Python isn't installed: install python3".to_owned()));
                };
                Ok((None, self.tool(language, &found, cancel).await?))
            }
            Language::Rust => {
                let Some(found) = self.find(language, needs(language)) else {
                    return Ok(Err(
                        "Rust isn't installed: install it from https://rustup.rs".to_owned(),
                    ));
                };
                let tool = self.tool(language, &found, cancel).await?;
                let mut args = vec![tool.program.clone()];
                args.extend(owned(&["--edition", "2024"]));
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
                if let Some(cc) = self.find(language, "cc") {
                    let linker = self.sandbox.program(&cc);
                    if linker != cc {
                        args.extend(["-C".to_owned(), format!("linker={}", linker.display())]);
                    }
                }
                Ok((Some(args), tool))
            }
            Language::Cpp => {
                let Some(compiler) = CPP_COMPILERS.iter().find_map(|c| self.find(language, c))
                else {
                    return Ok(Err(format!(
                        "no C++ compiler was found (looked for {}); install one, such as clang or GCC",
                        CPP_COMPILERS.join(", ")
                    )));
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
                let tool = Tool {
                    program: args[0].clone(),
                    reads: Vec::new(),
                };
                Ok((Some(args), tool))
            }
            Language::Haskell => {
                let Some(found) = self.find(language, needs(language)) else {
                    return Ok(Err("GHC isn't installed: install ghc, such as with GHCup from https://www.haskell.org/ghcup/".to_owned()));
                };
                let tool = self.tool(language, &found, cancel).await?;
                // Built in a directory of the build's own, which is moved into place with the
                // program once it's built.
                let mut args = vec![tool.program.clone()];
                args.extend(owned(&["-O1", "-v0", "-outputdir", "build"]));
                args.extend(ghc_package_flags());
                args.extend([
                    format!("-with-rtsopts=-M{HASKELL_HEAP}"),
                    "-o".to_owned(),
                    binary(),
                ]);
                Ok((Some(args), tool))
            }
        })
    }

    /// The environment variables for building in `language`: its toolchain's, and for Haskell,
    /// `GHC_ENVIRONMENT=-`, so GHC reads no package environment file, such as one in the user's
    /// own `~/.ghc`, and builds the same way everywhere.
    fn build_environment(&self, language: Language) -> Vec<(String, String)> {
        let mut environment = self.environment(language).to_vec();
        if language == Language::Haskell {
            environment.retain(|(name, _)| name != "GHC_ENVIRONMENT");
            environment.push(("GHC_ENVIRONMENT".to_owned(), "-".to_owned()));
        }
        environment
    }

    /// Builds a program from its source, or finds it built already.
    pub async fn build(
        &self,
        language: Language,
        source: &str,
        flavour: Flavour,
        cancel: &CancellationToken,
    ) -> Result<Built> {
        let (compiler, tool) = match self.compiler(language, flavour, cancel).await? {
            Ok(compiler) => compiler,
            Err(missing) => return Ok(Built::Unavailable(missing)),
        };
        let file = format!("main.{}", language.extension());
        let key = fingerprint(&[language.id(), &format!("{compiler:?}"), source]);
        let dir = self.scratch.join(&key);
        let (command, reads) = match language {
            Language::Python => (vec![tool.program.clone(), file.clone()], tool.reads.clone()),
            Language::Rust | Language::Cpp | Language::Haskell => (
                vec![dir.join(binary()).to_string_lossy().into_owned()],
                Vec::new(),
            ),
        };
        let built = Program {
            language,
            dir: dir.clone(),
            command,
            reads,
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
            let reads: Vec<&Path> = tool.reads.iter().map(PathBuf::as_path).collect();
            let confined = self
                .sandbox
                .confine(&args, &reads, &staging, &self.build_environment(language))
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
            let reads: Vec<&Path> = std::iter::once(program.dir.as_path())
                .chain(program.reads.iter().map(PathBuf::as_path))
                .collect();
            let confined = self
                .sandbox
                .confine(
                    &command,
                    &reads,
                    &scratch,
                    self.environment(program.language),
                )
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
            cut_off: output
                .stdout_cut_off
                .then_some(workshop_runner::MAX_OUTPUT_BYTES),
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
            environments: BTreeMap::new(),
            build_timeout: Duration::from_secs(60),
            run_timeout: Duration::from_secs(60),
            sandbox: Sandbox::Unconfined,
            tools: Default::default(),
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
        let path = vec![("PATH".to_owned(), dir.path().display().to_string())];
        runtime.environments = Language::ALL
            .into_iter()
            .map(|language| (language, path.clone()))
            .collect();
        let Built::Unavailable(why) = built(&runtime, Language::Cpp, "int main() {}").await else {
            panic!("found a compiler where there's none");
        };
        assert!(why.contains("no C++ compiler"), "{why}");
        let Built::Unavailable(why) = built(&runtime, Language::Haskell, "main = pure ()").await
        else {
            panic!("found GHC where there's none");
        };
        assert!(why.contains("GHC isn't installed"), "{why}");
        assert!(matches!(
            built(&runtime, Language::Python, "").await,
            Built::Unavailable(_)
        ));
    }

    /// A package environment, such as one in the user's own `~/.ghc`, would change which
    /// packages there are, so builds never read one.
    #[tokio::test]
    async fn haskell_builds_read_no_package_environment() {
        let dir = tempfile::tempdir().unwrap();
        let mut runtime = runtime(dir.path());
        if runtime.find(Language::Haskell, "ghc").is_none() {
            return;
        }
        let environment = dir.path().join("environment");
        std::fs::write(&environment, "not a package environment\n").unwrap();
        runtime.environments.insert(
            Language::Haskell,
            vec![(
                "GHC_ENVIRONMENT".to_owned(),
                environment.display().to_string(),
            )],
        );
        let source = "import qualified Data.Map as M\n\nmain :: IO ()\nmain = print (M.size (M.fromList [(1 :: Int, 'a')]))\n";
        let Built::Ready(program) = built(&runtime, Language::Haskell, source).await else {
            panic!("didn't build");
        };
        let run = runtime
            .run(&program, &[], "", &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(run.stdout, "1\n");
        // Only the packages that come with GHC.
        let Built::Failed { errors, .. } = built(
            &runtime,
            Language::Haskell,
            "import GHC.Driver.Session ()\n\nmain :: IO ()\nmain = pure ()\n",
        )
        .await
        else {
            panic!("built with GHC's own library");
        };
        assert!(errors.contains("GHC.Driver.Session"), "{errors}");
    }

    #[test]
    fn fingerprints_keep_parts_apart() {
        assert_ne!(fingerprint(&["ab", "c"]), fingerprint(&["a", "bc"]));
        assert_eq!(fingerprint(&["a"]), fingerprint(&["a"]));
    }
}
