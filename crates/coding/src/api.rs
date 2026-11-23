//! Running solutions in API mode: Workshop's driver imports the learner's module, makes the
//! calls a case gives, and prints what each returns (see `workshop_pack::api`).

use anyhow::Result;
use workshop_pack::{Api, Language};

/// The driver, which reads the calls on stdin and prints their results.
const DRIVER: &str = include_str!("driver.py");

/// The file the module being called is written to, beside the driver, which imports it.
pub const MODULE: &str = "solution.py";

/// The driver for an item's API, in `language`.
pub fn driver(api: &Api, language: Language) -> Result<String> {
    if !workshop_pack::api::LANGUAGES.contains(&language) {
        anyhow::bail!(
            "API mode is for Python only, and this solution is in {}",
            language.name()
        );
    }
    let setting = "CLASS = None\n";
    // A class is a Python identifier, as the pack checks, so it can go in a string as it is.
    let class = match &api.class {
        Some(class) => format!("CLASS = \"{class}\"\n"),
        None => setting.to_owned(),
    };
    anyhow::ensure!(
        DRIVER.matches(setting).count() == 1,
        "the driver sets CLASS once"
    );
    Ok(DRIVER.replacen(setting, &class, 1))
}
