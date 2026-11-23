//! Coding and reading items' programs: building and running them with Workshop's runner, in
//! Python, Rust and C++, so a learner's solution can be run on examples and graded when it's
//! submitted, and a pack's own solutions and code checked by `workshop pack check`.

pub mod api;
pub mod check;
pub mod grade;
pub mod programs;
pub mod sandbox;

pub use check::{Checker, Unconfined};
pub use grade::{CaseRef, CaseResult, Graded, Oracle, OracleCase, grade, run_examples};
pub use programs::{Built, Flavour, Program, Run, Runtime, needs};
pub use sandbox::Sandbox;
