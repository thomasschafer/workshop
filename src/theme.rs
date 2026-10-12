//! Terminal colour themes, applied to Workshop's own colours. Themes come from Ghostty, which
//! ships hundreds, and from files in Workshop's themes directory, in Ghostty or base16 format.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::paths::Paths;

/// What to use for light or dark mode.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "name", rename_all = "snake_case")]
pub enum ThemeChoice {
    /// Workshop's own colours.
    #[default]
    Default,
    /// Whatever the user's Ghostty config uses.
    Ghostty,
    Named(String),
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ThemeSettings {
    pub light: ThemeChoice,
    pub dark: ThemeChoice,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rgb(u8, u8, u8);

impl Rgb {
    fn parse(text: &str) -> Option<Self> {
        let hex = text.trim().trim_matches('"').trim_start_matches('#');
        if hex.len() != 6 {
            return None;
        }
        let channel = |i: usize| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok();
        Some(Self(channel(0)?, channel(2)?, channel(4)?))
    }

    fn mix(self, other: Self, amount: f64) -> Self {
        let blend = |a: u8, b: u8| {
            let mixed = f64::from(a) + (f64::from(b) - f64::from(a)) * amount;
            mixed.round().clamp(0.0, 255.0) as u8
        };
        Self(
            blend(self.0, other.0),
            blend(self.1, other.1),
            blend(self.2, other.2),
        )
    }

    fn luminance(self) -> f64 {
        let linear = |c: u8| {
            let c = f64::from(c) / 255.0;
            if c <= 0.03928 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * linear(self.0) + 0.7152 * linear(self.1) + 0.0722 * linear(self.2)
    }

    fn contrast(self, other: Self) -> f64 {
        let (a, b) = (self.luminance(), other.luminance());
        (a.max(b) + 0.05) / (a.min(b) + 0.05)
    }

    fn css(self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.0, self.1, self.2)
    }
}

/// A terminal theme: background, foreground and the 16 ANSI colours.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalTheme {
    background: Rgb,
    foreground: Rgb,
    palette: [Option<Rgb>; 16],
    selection: Option<Rgb>,
}

impl TerminalTheme {
    /// Ghostty's format: `background = #1e1e2e` and `palette = 4=#89b4fa` lines.
    pub fn parse_ghostty(text: &str) -> Result<Self> {
        let mut background = None;
        let mut foreground = None;
        let mut selection = None;
        let mut palette = [None; 16];
        for line in text.lines() {
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            match key.trim() {
                "background" => background = Rgb::parse(value),
                "foreground" => foreground = Rgb::parse(value),
                "selection-background" => selection = Rgb::parse(value),
                "palette" => {
                    if let Some((index, colour)) = value.split_once('=')
                        && let Ok(index) = index.trim().parse::<usize>()
                        && index < 16
                    {
                        palette[index] = Rgb::parse(colour);
                    }
                }
                _ => {}
            }
        }
        Ok(Self {
            background: background.context("the theme has no background colour")?,
            foreground: foreground.context("the theme has no foreground colour")?,
            palette,
            selection,
        })
    }

    /// base16's format: `base00: "1e1e2e"` lines, mapped to terminal colours as base16's own
    /// shell themes do.
    pub fn parse_base16(text: &str) -> Result<Self> {
        let mut base = [None; 16];
        for line in text.lines() {
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            if let Some(index) = key.trim().strip_prefix("base0")
                && let Ok(index) = usize::from_str_radix(index, 16)
            {
                base[index] = Rgb::parse(value);
            }
        }
        let get = |i: usize| base[i].with_context(|| format!("the theme has no base0{i:X} colour"));
        let mut palette = [None; 16];
        for (slot, index) in [
            (0, 0x0),
            (1, 0x8),
            (2, 0xB),
            (3, 0xA),
            (4, 0xD),
            (5, 0xE),
            (6, 0xC),
            (7, 0x5),
        ] {
            palette[slot] = Some(get(index)?);
            palette[slot + 8] = Some(get(index)?);
        }
        Ok(Self {
            background: get(0x0)?,
            foreground: get(0x5)?,
            palette,
            selection: base[0x2],
        })
    }

    fn colour(&self, index: usize) -> Option<Rgb> {
        self.palette[index]
    }

    /// Workshop's CSS variables in this theme's colours.
    pub fn css_variables(&self) -> BTreeMap<&'static str, String> {
        let (bg, fg) = (self.background, self.foreground);
        let accent = self.colour(4).unwrap_or(fg);
        let accent_fg = if accent.contrast(bg) >= accent.contrast(fg) {
            bg
        } else {
            fg
        };
        let muted = fg.mix(bg, 0.4);
        let colour = |index: usize, fallback: Rgb| self.colour(index).unwrap_or(fallback);
        BTreeMap::from([
            ("--bg", bg.css()),
            ("--surface", bg.mix(fg, 0.06).css()),
            ("--fg", fg.css()),
            ("--muted", muted.css()),
            ("--faint", fg.mix(bg, 0.7).css()),
            ("--border", bg.mix(fg, 0.15).css()),
            ("--accent", accent.css()),
            ("--accent-fg", accent_fg.css()),
            ("--active-line", bg.mix(fg, 0.04).css()),
            (
                "--selection",
                self.selection.unwrap_or_else(|| bg.mix(accent, 0.3)).css(),
            ),
            ("--changed", bg.mix(accent, 0.25).css()),
            ("--error", colour(1, fg).css()),
            ("--ok", colour(2, fg).css()),
            ("--warn", colour(3, fg).css()),
            ("--star", colour(11, colour(3, fg)).css()),
            ("--syntax-keyword", colour(5, fg).css()),
            ("--syntax-string", colour(2, fg).css()),
            ("--syntax-number", colour(3, fg).css()),
            ("--syntax-type", colour(6, fg).css()),
            ("--syntax-operator", muted.css()),
        ])
    }
}

/// Where themes are looked for, in order of precedence.
fn theme_dirs(paths: &Paths) -> Vec<PathBuf> {
    let mut dirs = vec![paths.config_dir.join("themes")];
    if let Some(config) = dirs::config_dir() {
        dirs.push(config.join("ghostty").join("themes"));
    }
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".config").join("ghostty").join("themes"));
    }
    dirs.push(PathBuf::from(
        "/Applications/Ghostty.app/Contents/Resources/ghostty/themes",
    ));
    dirs.push(PathBuf::from("/usr/share/ghostty/themes"));
    dirs.push(PathBuf::from("/usr/local/share/ghostty/themes"));
    dirs
}

/// Names of every theme found, sorted.
pub fn available(paths: &Paths) -> Vec<String> {
    let mut names: Vec<String> = theme_dirs(paths)
        .iter()
        .filter_map(|dir| std::fs::read_dir(dir).ok())
        .flatten()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_file())
        .filter_map(|entry| theme_name(&entry.path()))
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup();
    names
}

fn theme_name(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let name = name
        .strip_suffix(".yaml")
        .or_else(|| name.strip_suffix(".yml"))
        .unwrap_or(name);
    (!name.starts_with('.')).then(|| name.to_owned())
}

pub fn load(paths: &Paths, name: &str) -> Result<TerminalTheme> {
    if name.contains('/') || name.contains('\\') || name.starts_with('.') {
        bail!("{name:?} isn't a theme name");
    }
    for dir in theme_dirs(paths) {
        for file in [
            dir.join(name),
            dir.join(format!("{name}.yaml")),
            dir.join(format!("{name}.yml")),
        ] {
            let Ok(text) = std::fs::read_to_string(&file) else {
                continue;
            };
            let base16 = file.extension().is_some_and(|e| e == "yaml" || e == "yml");
            let theme = if base16 {
                TerminalTheme::parse_base16(&text)
            } else {
                TerminalTheme::parse_ghostty(&text)
            };
            return theme.with_context(|| format!("reading theme {}", file.display()));
        }
    }
    bail!("there's no theme called {name:?}")
}

/// The themes the user's Ghostty config uses for light and dark mode, if any.
pub fn ghostty_themes() -> Option<(String, String)> {
    let config = dirs::config_dir()
        .map(|d| d.join("ghostty").join("config"))
        .filter(|p| p.exists())
        .or_else(|| dirs::home_dir().map(|h| h.join(".config").join("ghostty").join("config")))?;
    parse_ghostty_theme_setting(&std::fs::read_to_string(config).ok()?)
}

/// Ghostty's `theme` setting is either one name, or `light:A,dark:B`.
fn parse_ghostty_theme_setting(config: &str) -> Option<(String, String)> {
    // A later setting overrides an earlier one.
    let value = config
        .lines()
        .rev()
        .filter_map(|l| l.split_once('='))
        .find(|(key, _)| key.trim() == "theme")
        .map(|(_, value)| value.trim().trim_matches('"').to_owned())?;
    if value.contains(':') {
        let mut light = None;
        let mut dark = None;
        for part in value.split(',') {
            match part.split_once(':') {
                Some(("light", name)) => light = Some(name.trim().to_owned()),
                Some(("dark", name)) => dark = Some(name.trim().to_owned()),
                _ => {}
            }
        }
        Some((light?, dark?))
    } else {
        Some((value.clone(), value))
    }
}

/// The stylesheet overriding Workshop's colours, or none for its defaults.
pub fn stylesheet(paths: &Paths, settings: &ThemeSettings) -> Result<Option<String>> {
    let ghostty = ghostty_themes();
    let resolve = |choice: &ThemeChoice, light: bool| -> Result<Option<TerminalTheme>> {
        let name = match choice {
            ThemeChoice::Default => return Ok(None),
            ThemeChoice::Ghostty => {
                let (l, d) = ghostty
                    .clone()
                    .context("Ghostty's config doesn't set a theme")?;
                if light { l } else { d }
            }
            ThemeChoice::Named(name) => name.clone(),
        };
        load(paths, &name).map(Some)
    };
    let mut css = String::new();
    for (choice, light) in [(&settings.light, true), (&settings.dark, false)] {
        if let Some(theme) = resolve(choice, light)? {
            let scheme = if light { "light" } else { "dark" };
            let variables: String = theme
                .css_variables()
                .iter()
                .map(|(name, value)| format!("{name}:{value};"))
                .collect();
            css.push_str(&format!(
                "@media (prefers-color-scheme: {scheme}) {{ :root {{ {variables} }} }}\n"
            ));
        }
    }
    Ok((!css.is_empty()).then_some(css))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Invented colours, in each format.
    const GHOSTTY: &str = "palette = 1=#cc3333\npalette = 2=#33cc33\npalette = 3=#cccc33\npalette = 4=#3366ff\npalette = 5=#cc33cc\npalette = 6=#33cccc\nbackground = #101010\nforeground = #f0f0f0\nselection-background = #404040\n";
    const BASE16: &str = "scheme: \"Invented\"\nbase00: \"101010\"\nbase01: \"202020\"\nbase02: \"303030\"\nbase03: \"404040\"\nbase04: \"505050\"\nbase05: \"f0f0f0\"\nbase06: \"f8f8f8\"\nbase07: \"ffffff\"\nbase08: \"cc3333\"\nbase09: \"cc7733\"\nbase0A: \"cccc33\"\nbase0B: \"33cc33\"\nbase0C: \"33cccc\"\nbase0D: \"3366ff\"\nbase0E: \"cc33cc\"\nbase0F: \"993333\"\n";

    #[test]
    fn maps_ghostty_themes_to_workshop_colours() {
        let vars = TerminalTheme::parse_ghostty(GHOSTTY)
            .unwrap()
            .css_variables();
        assert_eq!(vars["--bg"], "#101010");
        assert_eq!(vars["--fg"], "#f0f0f0");
        assert_eq!(vars["--accent"], "#3366ff");
        assert_eq!(vars["--error"], "#cc3333");
        assert_eq!(vars["--selection"], "#404040");
        // Light text reads better on this blue than the dark background does.
        assert_eq!(vars["--accent-fg"], "#f0f0f0");
    }

    #[test]
    fn reads_base16_themes_the_same_way() {
        let ghostty = TerminalTheme::parse_ghostty(GHOSTTY)
            .unwrap()
            .css_variables();
        let base16 = TerminalTheme::parse_base16(BASE16).unwrap().css_variables();
        for key in [
            "--bg",
            "--fg",
            "--accent",
            "--error",
            "--ok",
            "--syntax-keyword",
        ] {
            assert_eq!(ghostty[key], base16[key], "{key}");
        }
    }

    #[test]
    fn rejects_incomplete_themes() {
        assert!(TerminalTheme::parse_ghostty("palette = 1=#cc3333").is_err());
        assert!(TerminalTheme::parse_base16("base00: \"101010\"").is_err());
    }

    #[test]
    fn reads_ghostty_theme_settings() {
        assert_eq!(
            parse_ghostty_theme_setting("font-size = 14\ntheme = Catppuccin Macchiato\n"),
            Some(("Catppuccin Macchiato".into(), "Catppuccin Macchiato".into()))
        );
        assert_eq!(
            parse_ghostty_theme_setting("theme = light:Day,dark:Night"),
            Some(("Day".into(), "Night".into()))
        );
        assert_eq!(parse_ghostty_theme_setting("font-size = 14"), None);
    }

    #[test]
    fn loads_themes_from_the_themes_directory() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::under(dir.path());
        std::fs::create_dir_all(paths.config_dir.join("themes")).unwrap();
        std::fs::write(paths.config_dir.join("themes").join("Invented"), GHOSTTY).unwrap();
        std::fs::write(paths.config_dir.join("themes").join("Base.yaml"), BASE16).unwrap();
        let names = available(&paths);
        assert!(names.contains(&"Invented".to_owned()) && names.contains(&"Base".to_owned()));
        assert!(load(&paths, "Base").is_ok());
        assert!(load(&paths, "../escape").is_err());

        let settings = ThemeSettings {
            light: ThemeChoice::Default,
            dark: ThemeChoice::Named("Invented".into()),
        };
        let css = stylesheet(&paths, &settings).unwrap().unwrap();
        assert!(css.starts_with("@media (prefers-color-scheme: dark)"));
        assert!(css.contains("--bg:#101010;"));
        assert!(
            stylesheet(&paths, &ThemeSettings::default())
                .unwrap()
                .is_none()
        );
    }
}
