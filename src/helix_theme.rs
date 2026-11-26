//! Reads Helix's configuration and TOML colour themes, resolving `inherits` chains and `[palette]`
//! lookups as `helix-view` does, and exports syntax highlight scopes (excluding `ui.*`) for the
//! frontend's tree-sitter highlighter.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use toml::Value;
use toml::map::Map;

/// Where syntax highlighting colours come from for light or dark mode.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "name", rename_all = "snake_case")]
pub enum SyntaxThemeChoice {
    /// Workshop's own syntax colours (or the active terminal theme's `--syntax-*` variables).
    #[default]
    Default,
    /// Whatever theme the user's Helix `config.toml` sets.
    Helix,
    /// A named Helix theme from Helix's theme directories.
    Named(String),
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SyntaxThemeSettings {
    pub light: SyntaxThemeChoice,
    pub dark: SyntaxThemeChoice,
}

/// Text modifiers supported by the frontend syntax highlighter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyntaxModifier {
    Bold,
    Italic,
    Underlined,
    CrossedOut,
    Dim,
}

/// Resolved foreground colour and text modifiers for a single Helix highlight scope.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyntaxScopeStyle {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fg: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modifiers: Vec<SyntaxModifier>,
}

/// Map from Helix highlight scope (e.g. `"keyword.control"`) to its resolved style.
pub type HelixSyntaxScopes = BTreeMap<String, SyntaxScopeStyle>;

/// Resolved Helix syntax themes for light and dark colour schemes.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedSyntaxThemes {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub light: Option<HelixSyntaxScopes>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dark: Option<HelixSyntaxScopes>,
}

/// What the settings UI needs to show Helix syntax theme choices and any load/parse problem.
#[derive(Debug, Clone, Default, Serialize)]
pub struct HelixThemesInfo {
    pub names: Vec<String>,
    /// Light and dark theme names configured in Helix's `config.toml`, if any.
    pub config: Option<(String, String)>,
    /// Why Helix's config or the active Helix theme couldn't be read or parsed, if anything failed.
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum HelixConfigTheme {
    Constant(String),
    Adaptive {
        light: String,
        dark: String,
        #[allow(dead_code)]
        fallback: Option<String>,
    },
}

#[derive(Debug, Deserialize)]
struct HelixConfig {
    theme: Option<HelixConfigTheme>,
}

/// Parses the `theme` setting from a Helix `config.toml`, returning `(light, dark)`.
pub fn parse_helix_config_themes(config_toml: &str) -> Result<Option<(String, String)>> {
    let parsed: HelixConfig = toml::from_str(config_toml).context("parsing Helix config.toml")?;
    Ok(parsed.theme.map(|theme| match theme {
        HelixConfigTheme::Constant(name) => (name.clone(), name),
        HelixConfigTheme::Adaptive { light, dark, .. } => (light, dark),
    }))
}

/// Candidate Helix configuration directories in priority order (matching Helix's XDG/platform layout).
fn helix_config_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut push_unique = |path: PathBuf| {
        if !dirs.contains(&path) {
            dirs.push(path);
        }
    };
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME")
        && !xdg.is_empty()
    {
        push_unique(PathBuf::from(xdg).join("helix"));
    }
    if let Some(home) = dirs::home_dir() {
        push_unique(home.join(".config").join("helix"));
    }
    if let Some(config) = dirs::config_dir() {
        push_unique(config.join("helix"));
    }
    dirs
}

/// Finds the `hx` binary on `PATH` and returns its canonicalized parent directory, if found.
fn hx_binary_dir() -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let exe_name = if cfg!(windows) { "hx.exe" } else { "hx" };
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(exe_name);
        if candidate.is_file() {
            let resolved = std::fs::canonicalize(&candidate).unwrap_or(candidate);
            if let Some(parent) = resolved.parent() {
                return Some(parent.to_path_buf());
            }
        }
    }
    None
}

fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/")
        && let Some(home) = dirs::home_dir()
    {
        return home.join(rest);
    }
    if path == "~"
        && let Some(home) = dirs::home_dir()
    {
        return home;
    }
    PathBuf::from(path)
}

/// Helix theme search directories (`.../themes`), ordered from highest to lowest priority,
/// following `helix-loader`'s `runtime_dirs()` plus the user config `themes/` directory.
pub fn theme_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut push_unique = |path: PathBuf| {
        if !dirs.contains(&path) {
            dirs.push(path);
        }
    };

    let config_dirs = helix_config_dirs();
    // 1. User config `themes/` directory (highest priority in Helix's `theme::Loader`).
    for dir in &config_dirs {
        push_unique(dir.join("themes"));
    }
    // 2. User config `runtime/themes`.
    for dir in &config_dirs {
        push_unique(dir.join("runtime").join("themes"));
    }
    // 3. `HELIX_RUNTIME/themes`.
    if let Ok(runtime) = std::env::var("HELIX_RUNTIME")
        && !runtime.is_empty()
    {
        push_unique(expand_tilde(&runtime).join("themes"));
    }
    // 4. `runtime/themes` next to the `hx` binary (plus common package-manager layouts).
    if let Some(bin_dir) = hx_binary_dir() {
        push_unique(bin_dir.join("runtime").join("themes"));
        if let Some(prefix) = bin_dir.parent() {
            push_unique(prefix.join("libexec").join("runtime").join("themes"));
            push_unique(
                prefix
                    .join("share")
                    .join("helix")
                    .join("runtime")
                    .join("themes"),
            );
        }
    }
    // 5. Standard system runtime locations.
    push_unique(PathBuf::from("/usr/local/share/helix/runtime/themes"));
    push_unique(PathBuf::from("/usr/share/helix/runtime/themes"));

    dirs
}

/// Reads the user's Helix `config.toml` and returns `(light, dark)` theme names, if configured.
pub fn configured_themes() -> Result<Option<(String, String)>> {
    for dir in helix_config_dirs() {
        let file = dir.join("config.toml");
        if file.is_file() {
            let text = std::fs::read_to_string(&file)
                .with_context(|| format!("reading {}", file.display()))?;
            return parse_helix_config_themes(&text)
                .with_context(|| format!("in {}", file.display()));
        }
    }
    Ok(None)
}

/// Names of every `.toml` Helix theme found in `dirs`, sorted and deduplicated.
pub fn available_in(dirs: &[PathBuf]) -> Vec<String> {
    let mut names: Vec<String> = dirs
        .iter()
        .filter_map(|dir| std::fs::read_dir(dir).ok())
        .flatten()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_file())
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension()?.to_str()? != "toml" {
                return None;
            }
            let stem = path.file_stem()?.to_str()?;
            (!stem.starts_with('.')).then(|| stem.to_owned())
        })
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup();
    names
}

/// Loads a named Helix theme from `dirs`, resolving `inherits` chains and `[palette]` entries.
pub fn load_in(dirs: &[PathBuf], name: &str) -> Result<HelixSyntaxScopes> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.starts_with('.') {
        bail!("{name:?} isn't a valid Helix theme name");
    }
    let mut visited = HashSet::new();
    let merged = load_merged_toml(dirs, name, &mut visited)?;
    extract_syntax_scopes(merged).with_context(|| format!("parsing Helix theme {name:?}"))
}

/// Resolves the active `SyntaxThemeSettings` into light and dark syntax scope maps.
pub fn resolve_settings(
    dirs: &[PathBuf],
    configured: Result<Option<(String, String)>>,
    settings: &SyntaxThemeSettings,
) -> Result<ResolvedSyntaxThemes> {
    let needs_config = matches!(settings.light, SyntaxThemeChoice::Helix)
        || matches!(settings.dark, SyntaxThemeChoice::Helix);
    let config_themes = if needs_config {
        configured?
    } else {
        configured.ok().flatten()
    };

    let resolve_one =
        |choice: &SyntaxThemeChoice, light: bool| -> Result<Option<HelixSyntaxScopes>> {
            let name = match choice {
                SyntaxThemeChoice::Default => return Ok(None),
                SyntaxThemeChoice::Helix => {
                    let (l, d) = config_themes
                        .as_ref()
                        .context("Helix's config.toml doesn't set a theme")?;
                    if light { l.as_str() } else { d.as_str() }
                }
                SyntaxThemeChoice::Named(name) => name.as_str(),
            };
            load_in(dirs, name).map(Some)
        };

    Ok(ResolvedSyntaxThemes {
        light: resolve_one(&settings.light, true)?,
        dark: resolve_one(&settings.dark, false)?,
    })
}

/// Resolves the user's Helix syntax theme settings using the system's Helix config and theme dirs.
pub fn resolve(settings: &SyntaxThemeSettings) -> Result<ResolvedSyntaxThemes> {
    resolve_settings(&theme_dirs(), configured_themes(), settings)
}

/// Gathers available Helix themes, Helix's configured themes, and any error to surface in Settings.
pub fn info(settings: &SyntaxThemeSettings) -> HelixThemesInfo {
    let dirs = theme_dirs();
    let names = available_in(&dirs);
    let config_result = configured_themes();
    let (config, config_error) = match &config_result {
        Ok(pair) => (pair.clone(), None),
        Err(err) => (None, Some(format!("{err:#}"))),
    };
    let active_error = resolve_settings(&dirs, config_result, settings)
        .err()
        .map(|err| format!("{err:#}"));
    HelixThemesInfo {
        names,
        config,
        error: active_error.or(config_error),
    }
}

fn load_merged_toml(dirs: &[PathBuf], name: &str, visited: &mut HashSet<PathBuf>) -> Result<Value> {
    let path = match find_theme_path(dirs, name, visited) {
        Ok(path) => path,
        Err(err) => {
            if let Some(builtin) = builtin_default_theme(name) {
                return Ok(builtin);
            }
            return Err(err);
        }
    };

    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("reading Helix theme {}", path.display()))?;
    let theme_toml: Value =
        toml::from_str(&text).with_context(|| format!("parsing Helix theme {}", path.display()))?;

    let merged = if let Some(parent_val) = theme_toml.get("inherits") {
        let parent_name = parent_val
            .as_str()
            .ok_or_else(|| anyhow!("expected 'inherits' to be a string in {}", path.display()))?;
        let parent_toml = load_merged_toml(dirs, parent_name, visited)?;
        merge_themes(parent_toml, theme_toml)
    } else {
        theme_toml
    };

    Ok(merged)
}

fn find_theme_path(
    dirs: &[PathBuf],
    name: &str,
    visited: &mut HashSet<PathBuf>,
) -> Result<PathBuf> {
    let filename = format!("{name}.toml");
    let mut cycle_found = false;
    for dir in dirs {
        let path = dir.join(&filename);
        if !path.is_file() {
            continue;
        }
        if visited.contains(&path) {
            cycle_found = true;
            continue;
        }
        visited.insert(path.clone());
        return Ok(path);
    }
    if cycle_found {
        bail!("cycle found while resolving Helix theme inheritance for {name:?}");
    }
    bail!("Helix theme {name:?} wasn't found in Helix's theme directories");
}

/// Merges `child` onto `parent` matching `helix-view`'s `Loader::merge_themes`:
/// `[palette]` tables merge at depth 2 while top-level style entries merge at depth 1 (so a child's
/// style table replaces the parent's style for that scope rather than partially merging fields).
fn merge_themes(parent: Value, child: Value) -> Value {
    let palette_values = match (parent.get("palette"), child.get("palette")) {
        (Some(p), Some(c)) => merge_toml_values(p.clone(), c.clone(), 2),
        (Some(p), None) => p.clone(),
        (None, Some(c)) => c.clone(),
        (None, None) => Value::Table(Map::new()),
    };
    let mut palette_wrapper = Map::new();
    palette_wrapper.insert("palette".to_owned(), palette_values);

    let merged = merge_toml_values(parent, child, 1);
    merge_toml_values(merged, Value::Table(palette_wrapper), 1)
}

/// Matches `helix_loader::merge_toml_values`.
fn merge_toml_values(left: Value, right: Value, merge_depth: usize) -> Value {
    match (left, right) {
        (Value::Table(mut left_map), Value::Table(right_map)) if merge_depth > 0 => {
            for (key, rval) in right_map {
                let merged = match left_map.remove(&key) {
                    Some(lval) => merge_toml_values(lval, rval, merge_depth - 1),
                    None => rval,
                };
                left_map.insert(key, merged);
            }
            Value::Table(left_map)
        }
        (_, right) => right,
    }
}

/// Minimal fallback when a user selects or inherits Helix's built-in `"default"` or
/// `"base16_default"` themes, which Helix compiles into its binary rather than shipping as files.
fn builtin_default_theme(name: &str) -> Option<Value> {
    let src = match name {
        "default" => {
            r##"
attribute = "#dbbfef"
keyword = "#eccdba"
"keyword.directive" = "#dbbfef"
namespace = "#dbbfef"
punctuation = "#a4a0e8"
operator = "#dbbfef"
special = "#efba5d"
"variable.other.member" = "#ffffff"
variable = "#a4a0e8"
"variable.parameter" = "#a4a0e8"
"variable.builtin" = "#9ff28f"
type = "#ffffff"
constructor = "#dbbfef"
function = "#ffffff"
"function.macro" = "#dbbfef"
tag = "#eccdba"
comment = "#697c81"
constant = "#ffffff"
string = "#cccccc"
"constant.numeric" = "#e8dca0"
"constant.character.escape" = "#efba5d"
label = "#efba5d"
"markup.heading" = "#dbbfef"
"markup.bold" = { modifiers = ["bold"] }
"markup.italic" = { modifiers = ["italic"] }
"markup.strikethrough" = { modifiers = ["crossed_out"] }
"markup.link.url" = { fg = "#cccccc", modifiers = ["underlined"] }
"markup.link.text" = "#eccdba"
"markup.raw" = "#eccdba"
warning = "#ffcd1c"
error = "#f47868"
info = "#6f44f0"
hint = "#cccccc"
"##
        }
        "base16_default" => {
            r##"
attribute = "yellow"
keyword = "magenta"
namespace = "blue"
punctuation = "white"
operator = "white"
special = "cyan"
variable = "red"
"variable.builtin" = "yellow"
type = "yellow"
constructor = "blue"
function = "blue"
tag = "red"
comment = "light-gray"
constant = "yellow"
string = "green"
"constant.numeric" = "yellow"
label = "magenta"
warning = "yellow"
error = "red"
info = "blue"
hint = "cyan"
"##
        }
        _ => return None,
    };
    Some(toml::from_str(src).expect("built-in Helix fallback theme is valid TOML"))
}

fn extract_syntax_scopes(value: Value) -> Result<HelixSyntaxScopes> {
    let mut table = match value {
        Value::Table(table) => table,
        other => bail!("expected theme TOML to be a table, found {other}"),
    };
    table.remove("inherits");
    table.remove("rainbow");

    let palette = match table.remove("palette") {
        Some(value) => Palette::from_toml(value)?,
        None => Palette::default(),
    };

    let mut scopes = HelixSyntaxScopes::new();
    for (name, style_val) in table {
        if name == "ui" || name.starts_with("ui.") {
            continue;
        }
        let style = palette
            .parse_style(&style_val)
            .with_context(|| format!("scope {name:?}"))?;
        scopes.insert(name, style);
    }
    Ok(scopes)
}

#[derive(Debug, Clone)]
enum ResolvedColor {
    /// Inherit the editor's default foreground colour (`"default"` in Helix).
    Reset,
    Hex(String),
}

struct Palette {
    colors: HashMap<String, ResolvedColor>,
}

impl Default for Palette {
    fn default() -> Self {
        let mut colors = HashMap::new();
        colors.insert("default".into(), ResolvedColor::Reset);
        for (name, hex) in [
            ("black", "#000000"),
            ("red", "#cd3131"),
            ("green", "#0dbc79"),
            ("yellow", "#e5e510"),
            ("blue", "#2472c8"),
            ("magenta", "#bc3fbc"),
            ("cyan", "#11a8cd"),
            ("gray", "#e5e5e5"),
            ("light-red", "#f14c4c"),
            ("light-green", "#23d18b"),
            ("light-yellow", "#f5f543"),
            ("light-blue", "#3b8eea"),
            ("light-magenta", "#d670d6"),
            ("light-cyan", "#29b8db"),
            ("light-gray", "#666666"),
            ("white", "#ffffff"),
        ] {
            colors.insert(name.into(), ResolvedColor::Hex(hex.into()));
        }
        Self { colors }
    }
}

impl Palette {
    fn from_toml(value: Value) -> Result<Self> {
        let Value::Table(entries) = value else {
            bail!("expected [palette] to be a table");
        };
        let mut palette = Self::default();
        for (name, val) in entries {
            let s = val
                .as_str()
                .ok_or_else(|| anyhow!("palette entry {name:?} must be a string"))?;
            let color = parse_raw_color(s)
                .with_context(|| format!("invalid colour {s:?} for palette entry {name:?}"))?;
            palette.colors.insert(name, color);
        }
        Ok(palette)
    }

    fn resolve_color(&self, value: &Value) -> Result<ResolvedColor> {
        let s = value
            .as_str()
            .ok_or_else(|| anyhow!("expected colour string, found {value}"))?;
        if let Some(color) = self.colors.get(s) {
            return Ok(color.clone());
        }
        parse_raw_color(s)
    }

    fn parse_style(&self, value: &Value) -> Result<SyntaxScopeStyle> {
        let mut style = SyntaxScopeStyle::default();
        match value {
            Value::String(_) => {
                if let ResolvedColor::Hex(hex) = self.resolve_color(value)? {
                    style.fg = Some(hex);
                }
            }
            Value::Table(entries) => {
                for (key, val) in entries {
                    match key.as_str() {
                        "fg" => match self.resolve_color(val)? {
                            ResolvedColor::Hex(hex) => style.fg = Some(hex),
                            ResolvedColor::Reset => style.fg = None,
                        },
                        // Background and underline colour are validated for syntax correctness,
                        // though Workshop only applies foreground colour and text modifiers.
                        "bg" => {
                            let _ = self.resolve_color(val)?;
                        }
                        "underline" => {
                            let ul = val
                                .as_table()
                                .ok_or_else(|| anyhow!("'underline' must be a table"))?;
                            for (ukey, uval) in ul {
                                match ukey.as_str() {
                                    "color" => {
                                        let _ = self.resolve_color(uval)?;
                                    }
                                    "style" => {
                                        let s = uval.as_str().ok_or_else(|| {
                                            anyhow!("invalid underline style: {uval}")
                                        })?;
                                        match s {
                                            "line" | "curl" | "dashed" | "dotted"
                                            | "double_line" => {
                                                push_unique_modifier(
                                                    &mut style.modifiers,
                                                    SyntaxModifier::Underlined,
                                                );
                                            }
                                            "reset" => {}
                                            _ => bail!("invalid underline style: {s:?}"),
                                        }
                                    }
                                    other => bail!("invalid underline attribute: {other:?}"),
                                }
                            }
                        }
                        "modifiers" => {
                            let list = val
                                .as_array()
                                .ok_or_else(|| anyhow!("'modifiers' must be an array"))?;
                            for item in list {
                                let name = item
                                    .as_str()
                                    .ok_or_else(|| anyhow!("invalid modifier: {item}"))?;
                                match name {
                                    "bold" => push_unique_modifier(
                                        &mut style.modifiers,
                                        SyntaxModifier::Bold,
                                    ),
                                    "italic" => push_unique_modifier(
                                        &mut style.modifiers,
                                        SyntaxModifier::Italic,
                                    ),
                                    "underlined" => push_unique_modifier(
                                        &mut style.modifiers,
                                        SyntaxModifier::Underlined,
                                    ),
                                    "crossed_out" => push_unique_modifier(
                                        &mut style.modifiers,
                                        SyntaxModifier::CrossedOut,
                                    ),
                                    "dim" => push_unique_modifier(
                                        &mut style.modifiers,
                                        SyntaxModifier::Dim,
                                    ),
                                    // Valid Helix terminal modifiers that don't apply to CSS.
                                    "slow_blink" | "rapid_blink" | "reversed" | "hidden" => {}
                                    other => bail!("invalid modifier: {other:?}"),
                                }
                            }
                        }
                        other => bail!("invalid style attribute: {other:?}"),
                    }
                }
            }
            other => bail!("expected colour string or style table, found {other}"),
        }
        Ok(style)
    }
}

fn push_unique_modifier(list: &mut Vec<SyntaxModifier>, modifier: SyntaxModifier) {
    if !list.contains(&modifier) {
        list.push(modifier);
    }
}

fn parse_raw_color(s: &str) -> Result<ResolvedColor> {
    if let Some(hex) = s.strip_prefix('#') {
        return parse_hex_color(hex).map(ResolvedColor::Hex);
    }
    if let Ok(index) = s.parse::<u8>() {
        return Ok(ResolvedColor::Hex(ansi256_to_hex(index)));
    }
    bail!("unrecognised colour {s:?}")
}

fn parse_hex_color(hex: &str) -> Result<String> {
    match hex.len() {
        6 => {
            let r = u8::from_str_radix(&hex[0..2], 16)?;
            let g = u8::from_str_radix(&hex[2..4], 16)?;
            let b = u8::from_str_radix(&hex[4..6], 16)?;
            Ok(format!("#{r:02x}{g:02x}{b:02x}"))
        }
        3 => {
            let nibble = |i: usize| -> Result<u8> {
                let v = u8::from_str_radix(&hex[i..i + 1], 16)?;
                Ok(v * 17)
            };
            let (r, g, b) = (nibble(0)?, nibble(1)?, nibble(2)?);
            Ok(format!("#{r:02x}{g:02x}{b:02x}"))
        }
        _ => bail!("invalid hex colour #{hex}"),
    }
}

fn ansi256_to_hex(index: u8) -> String {
    const ANSI16: [&str; 16] = [
        "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
        "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
    ];
    if index < 16 {
        return ANSI16[usize::from(index)].to_owned();
    }
    if index < 232 {
        let c = index - 16;
        let to_byte = |v: u8| if v == 0 { 0 } else { 55 + 40 * v };
        let r = to_byte(c / 36);
        let g = to_byte((c / 6) % 6);
        let b = to_byte(c % 6);
        return format!("#{r:02x}{g:02x}{b:02x}");
    }
    let gray = 8 + 10 * (index - 232);
    format!("#{gray:02x}{gray:02x}{gray:02x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_constant_and_adaptive_helix_config_themes() {
        assert_eq!(
            parse_helix_config_themes(r#"theme = "catppuccin_mocha""#).unwrap(),
            Some(("catppuccin_mocha".into(), "catppuccin_mocha".into()))
        );
        assert_eq!(
            parse_helix_config_themes(
                r#"theme = { light = "solarized_light", dark = "solarized_dark" }"#
            )
            .unwrap(),
            Some(("solarized_light".into(), "solarized_dark".into()))
        );
        assert_eq!(
            parse_helix_config_themes("line-number = \"relative\"").unwrap(),
            None
        );
        assert!(parse_helix_config_themes("theme = [invalid").is_err());
    }

    #[test]
    fn resolves_inherits_palette_modifiers_and_drops_ui_scopes() {
        let dir = tempfile::tempdir().unwrap();
        let runtime_themes = dir.path().join("runtime_themes");
        let user_themes = dir.path().join("user_themes");
        std::fs::create_dir_all(&runtime_themes).unwrap();
        std::fs::create_dir_all(&user_themes).unwrap();

        std::fs::write(
            runtime_themes.join("base.toml"),
            r##"
keyword = { fg = "purple", modifiers = ["bold"] }
comment = { fg = "muted", modifiers = ["italic"] }
string = "green"
"ui.background" = { bg = "#111111" }
"ui.text" = "#eeeeee"

[palette]
purple = "#aa66ff"
muted = "#777"
green = "#33aa55"
"##,
        )
        .unwrap();

        // Child overrides palette entry `purple` and replaces `string`, while inheriting `comment`.
        std::fs::write(
            user_themes.join("custom.toml"),
            r##"
inherits = "base"
string = { fg = "teal", modifiers = ["underlined", "dim"] }
"keyword.control" = { fg = "purple", modifiers = ["crossed_out"] }
"ui.linenr" = "#444444"

[palette]
purple = "#cc88ff"
teal = "#2299aa"
"##,
        )
        .unwrap();

        let dirs = vec![user_themes, runtime_themes];
        let scopes = load_in(&dirs, "custom").unwrap();

        assert!(!scopes.contains_key("ui.background"));
        assert!(!scopes.contains_key("ui.text"));
        assert!(!scopes.contains_key("ui.linenr"));

        // `keyword` came from parent, resolved against the merged palette where child overrode `purple`.
        assert_eq!(
            scopes["keyword"],
            SyntaxScopeStyle {
                fg: Some("#cc88ff".into()),
                modifiers: vec![SyntaxModifier::Bold],
            }
        );
        // 3-digit hex `#777` expands to `#777777`.
        assert_eq!(
            scopes["comment"],
            SyntaxScopeStyle {
                fg: Some("#777777".into()),
                modifiers: vec![SyntaxModifier::Italic],
            }
        );
        assert_eq!(
            scopes["string"],
            SyntaxScopeStyle {
                fg: Some("#2299aa".into()),
                modifiers: vec![SyntaxModifier::Underlined, SyntaxModifier::Dim],
            }
        );
        assert_eq!(
            scopes["keyword.control"],
            SyntaxScopeStyle {
                fg: Some("#cc88ff".into()),
                modifiers: vec![SyntaxModifier::CrossedOut],
            }
        );
    }

    #[test]
    fn allows_user_theme_inheriting_same_name_from_lower_priority_dir_and_rejects_cycles() {
        let dir = tempfile::tempdir().unwrap();
        let high = dir.path().join("high");
        let low = dir.path().join("low");
        std::fs::create_dir_all(&high).unwrap();
        std::fs::create_dir_all(&low).unwrap();

        std::fs::write(low.join("ocean.toml"), r##"keyword = "#112233""##).unwrap();
        std::fs::write(
            high.join("ocean.toml"),
            r##"
inherits = "ocean"
comment = "#445566"
"##,
        )
        .unwrap();

        let dirs = vec![high.clone(), low];
        let scopes = load_in(&dirs, "ocean").unwrap();
        assert_eq!(scopes["keyword"].fg.as_deref(), Some("#112233"));
        assert_eq!(scopes["comment"].fg.as_deref(), Some("#445566"));

        // Self-cycle in only one directory fails loudly.
        std::fs::write(high.join("loop.toml"), r##"inherits = "loop""##).unwrap();
        let err = load_in(&dirs, "loop").unwrap_err();
        assert!(format!("{err:#}").contains("cycle"), "{err:#}");
    }

    #[test]
    fn reports_missing_and_invalid_themes_loudly() {
        let dir = tempfile::tempdir().unwrap();
        let dirs = vec![dir.path().to_path_buf()];

        let missing = load_in(&dirs, "does_not_exist").unwrap_err();
        assert!(
            format!("{missing:#}").contains("wasn't found"),
            "{missing:#}"
        );

        std::fs::write(dir.path().join("bad.toml"), r#"keyword = "not_in_palette""#).unwrap();
        assert!(load_in(&dirs, "bad").is_err());

        // Traversal names are rejected.
        assert!(load_in(&dirs, "../secret").is_err());
    }
}
