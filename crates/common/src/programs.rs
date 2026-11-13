//! Finding the programs Workshop runs.

use std::ffi::OsStr;
use std::path::PathBuf;

/// What separates the directories in a search path such as `PATH`.
pub const SEARCH_PATH_SEPARATOR: char = if cfg!(windows) { ';' } else { ':' };

/// Finds a program on Workshop's own `PATH`.
pub fn find_program(program: &str) -> Option<PathBuf> {
    find_program_in(program, &std::env::var_os("PATH")?)
}

/// Finds a program on the given search path, or at the path given.
pub fn find_program_in(program: &str, search_path: &OsStr) -> Option<PathBuf> {
    let candidate = PathBuf::from(program);
    if candidate.components().count() > 1 {
        return candidate.is_file().then_some(candidate);
    }
    let extensions: &[&str] = if cfg!(windows) {
        &["exe", "cmd", "bat"]
    } else {
        &[""]
    };
    std::env::split_paths(search_path).find_map(|dir| {
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
