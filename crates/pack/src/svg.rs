//! Checking SVG diagrams in lessons so they are safe to show inline and stay legible in light
//! and dark themes.

use std::collections::BTreeSet;

use roxmltree::{Document, Node};

const SVG_NS: &str = "http://www.w3.org/2000/svg";

/// Checks an SVG document for inline safety, the SVG namespace and a `viewBox`, returning any
/// warnings (such as fixed colours on text or strokes that may vanish in light or dark themes).
pub fn check(svg: &str) -> Result<Vec<String>, String> {
    // `Document::parse` uses `ParsingOptions::default()`, which refuses DTDs and entities.
    let doc = Document::parse(svg).map_err(|err| format!("SVG isn't valid XML: {err}"))?;
    let root = doc.root_element();
    if root.tag_name().name() != "svg" {
        return Err(format!(
            "SVG must have `<svg>` as its root element, not `<{}>`",
            root.tag_name().name()
        ));
    }
    if root.tag_name().namespace() != Some(SVG_NS) {
        return Err(match root.tag_name().namespace() {
            Some(ns) => {
                format!("SVG `<svg>` root element is in namespace {ns:?}; it must be in {SVG_NS:?}")
            }
            None => format!("SVG `<svg>` root element must declare `xmlns=\"{SVG_NS}\"`"),
        });
    }

    match root.attribute("viewBox") {
        Some(value) => validate_view_box(value)?,
        None => {
            let wrong_case = root
                .attributes()
                .any(|a| a.namespace().is_none() && a.name().eq_ignore_ascii_case("viewbox"));
            return Err(if wrong_case {
                "SVG must have a `viewBox` attribute (with a capital B)".to_owned()
            } else {
                "SVG must have a `viewBox` attribute".to_owned()
            });
        }
    }

    let mut stroke_colours: Vec<String> = Vec::new();
    let mut text_colours: Vec<String> = Vec::new();

    for node in doc.descendants().filter(Node::is_element) {
        let local = node.tag_name().name();
        if let Some(forbidden) = forbidden_element(local) {
            return Err(format!("SVG can't contain a `<{forbidden}>` element"));
        }
        if node.tag_name().namespace() != Some(SVG_NS) {
            return Err(match node.tag_name().namespace() {
                Some(ns) => format!(
                    "SVG element `<{local}>` is in namespace {ns:?}; only the SVG namespace ({SVG_NS}) is allowed"
                ),
                None => format!("SVG element `<{local}>` is outside the SVG namespace ({SVG_NS})"),
            });
        }

        for attr in node.attributes() {
            let name = attr.name();
            if name.len() >= 2 && name[..2].eq_ignore_ascii_case("on") {
                return Err(format!(
                    "SVG can't have an event handler attribute `{name}`"
                ));
            }
            if name.eq_ignore_ascii_case("href") {
                let trimmed = attr.value().trim();
                if !trimmed.starts_with('#') || trimmed.len() <= 1 {
                    return Err(format!(
                        "SVG `{name}` ({trimmed:?}) must be a local fragment starting with `#`"
                    ));
                }
            }
            if attr.namespace().is_none() {
                if name.eq_ignore_ascii_case("stroke") || name.eq_ignore_ascii_case("color") {
                    if let Some(fixed) = fixed_colour(attr.value()) {
                        push_unique(&mut stroke_colours, fixed);
                    }
                } else if name.eq_ignore_ascii_case("style") {
                    check_css_safety(attr.value())?;
                    for (prop, val) in css_declarations(attr.value()) {
                        if (prop.eq_ignore_ascii_case("stroke")
                            || prop.eq_ignore_ascii_case("color"))
                            && let Some(fixed) = fixed_colour(val)
                        {
                            push_unique(&mut stroke_colours, fixed);
                        }
                    }
                }
            }
        }

        if is_text_element(local)
            && let Some(fill) = inherited_fill(node)
            && let Some(fixed) = fixed_colour(&fill)
        {
            push_unique(&mut text_colours, fixed);
        }

        if local.eq_ignore_ascii_case("style") {
            let css: String = node
                .children()
                .filter(Node::is_text)
                .filter_map(|c| c.text())
                .collect();
            check_css_safety(&css)?;
            check_css(&css, &mut stroke_colours, &mut text_colours);
        }
    }

    Ok(colour_warnings(&stroke_colours, &text_colours))
}

/// Elements refused in any namespace: scripts, embedded HTML, links and SMIL animation.
fn forbidden_element(local: &str) -> Option<&'static str> {
    match local.to_ascii_lowercase().as_str() {
        "script" => Some("script"),
        "foreignobject" => Some("foreignObject"),
        "a" => Some("a"),
        "animate" => Some("animate"),
        "set" => Some("set"),
        "animatemotion" => Some("animateMotion"),
        "animatetransform" => Some("animateTransform"),
        _ => None,
    }
}

fn is_text_element(local: &str) -> bool {
    local.eq_ignore_ascii_case("text")
        || local.eq_ignore_ascii_case("tspan")
        || local.eq_ignore_ascii_case("textpath")
}

/// The `fill` applying to `node` from itself or its nearest ancestor with an explicit `fill`
/// attribute or inline `style="fill: ..."`.
fn inherited_fill(node: Node<'_, '_>) -> Option<String> {
    for ancestor in node.ancestors().filter(Node::is_element) {
        let mut attr_fill = None;
        let mut style_fill = None;
        for attr in ancestor.attributes() {
            if attr.namespace().is_some() {
                continue;
            }
            if attr.name().eq_ignore_ascii_case("fill") {
                attr_fill = Some(attr.value().to_owned());
            } else if attr.name().eq_ignore_ascii_case("style") {
                for (prop, val) in css_declarations(attr.value()) {
                    if prop.eq_ignore_ascii_case("fill") {
                        style_fill = Some(val.to_owned());
                    }
                }
            }
        }
        if let Some(fill) = style_fill.or(attr_fill) {
            return Some(fill);
        }
    }
    None
}

fn validate_view_box(value: &str) -> Result<(), String> {
    let numbers: Result<Vec<f64>, _> = value
        .split(|c: char| c.is_ascii_whitespace() || c == ',')
        .filter(|part| !part.is_empty())
        .map(str::parse::<f64>)
        .collect();
    let Ok(nums) = numbers else {
        return Err(format!(
            "SVG `viewBox` ({value:?}) should be four numbers: min-x, min-y, width and height"
        ));
    };
    if nums.len() != 4 || !nums.iter().all(|n| n.is_finite()) {
        return Err(format!(
            "SVG `viewBox` ({value:?}) should be four numbers: min-x, min-y, width and height"
        ));
    }
    if nums[2] <= 0.0 || nums[3] <= 0.0 {
        return Err(format!(
            "SVG `viewBox` ({value:?}) should have width and height above 0"
        ));
    }
    Ok(())
}

/// Returns the fixed colour string if `value` is a fixed colour rather than `currentColor` or a
/// theme-safe keyword.
fn fixed_colour(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let trimmed = trimmed
        .strip_suffix("!important")
        .map_or(trimmed, str::trim);
    let lower = trimmed.to_ascii_lowercase();
    if lower.is_empty()
        || matches!(
            lower.as_str(),
            "none"
                | "transparent"
                | "currentcolor"
                | "inherit"
                | "initial"
                | "unset"
                | "context-fill"
                | "context-stroke"
        )
        || lower.starts_with("var(")
        || lower.starts_with("url(#")
    {
        return None;
    }
    Some(trimmed.to_owned())
}

fn css_declarations(style: &str) -> impl Iterator<Item = (&str, &str)> {
    style.split(';').filter_map(|decl| {
        let (prop, val) = decl.split_once(':')?;
        Some((prop.trim(), val.trim()))
    })
}

/// Refuses `@import` and any `url(...)` that isn't a local fragment `url(#...)` in CSS from
/// `<style>` elements or `style` attributes.
fn check_css_safety(css: &str) -> Result<(), String> {
    let clean = unescape_css(&strip_css_comments(css));
    let lower = clean.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if lower[i..].starts_with("@import") {
            let after = bytes.get(i + 7).copied();
            if after.is_none_or(|b| !b.is_ascii_alphanumeric() && b != b'-' && b != b'_') {
                return Err("SVG CSS can't use `@import`".to_owned());
            }
        }
        if lower[i..].starts_with("url(") {
            let prev = i.checked_sub(1).map(|p| bytes[p]);
            if prev.is_none_or(|b| !b.is_ascii_alphanumeric() && b != b'-' && b != b'_') {
                let start = i + 4;
                let Some(rel_end) = clean[start..].find(')') else {
                    return Err("SVG CSS has an unclosed `url(...)`".to_owned());
                };
                let raw = clean[start..start + rel_end].trim();
                let target = raw
                    .strip_prefix('"')
                    .and_then(|s| s.strip_suffix('"'))
                    .or_else(|| raw.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
                    .unwrap_or(raw)
                    .trim();
                if !target.starts_with('#') || target.len() <= 1 {
                    return Err(format!(
                        "SVG CSS `url({raw})` must be a local fragment starting with `#`"
                    ));
                }
                i = start + rel_end + 1;
                continue;
            }
        }
        let ch = lower[i..].chars().next().expect("within bounds");
        i += ch.len_utf8();
    }
    Ok(())
}

/// Decodes CSS backslash escapes (`\HHHHHH` or `\c`) so escaped `@import` or `url(...)` can't
/// slip past safety checks.
fn unescape_css(css: &str) -> String {
    if !css.contains('\\') {
        return css.to_owned();
    }
    let mut out = String::with_capacity(css.len());
    let mut chars = css.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        let mut hex = String::new();
        while hex.len() < 6 && chars.peek().is_some_and(char::is_ascii_hexdigit) {
            hex.push(chars.next().expect("peeked"));
        }
        if !hex.is_empty() {
            if chars.peek().is_some_and(|c| c.is_ascii_whitespace()) {
                chars.next();
            }
            if let Ok(code) = u32::from_str_radix(&hex, 16)
                && let Some(decoded) = char::from_u32(code)
            {
                out.push(decoded);
            }
        } else if let Some(escaped) = chars.next() {
            out.push(escaped);
        }
    }
    out
}

fn check_css(css: &str, stroke_colours: &mut Vec<String>, text_colours: &mut Vec<String>) {
    let clean = strip_css_comments(css);
    let mut rest = clean.as_str();
    while let Some(open) = rest.find('{') {
        let selector = rest[..open].trim().to_ascii_lowercase();
        let after = &rest[open + 1..];
        let Some(close) = after.find('}') else {
            break;
        };
        let body = &after[..close];
        rest = &after[close + 1..];
        let targets_text = selector
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_' && c != '*')
            .any(|token| matches!(token, "text" | "tspan" | "textpath" | "svg" | "*"));
        for (prop, val) in css_declarations(body) {
            if prop.eq_ignore_ascii_case("stroke") || prop.eq_ignore_ascii_case("color") {
                if let Some(fixed) = fixed_colour(val) {
                    push_unique(stroke_colours, fixed);
                }
            } else if prop.eq_ignore_ascii_case("fill")
                && targets_text
                && let Some(fixed) = fixed_colour(val)
            {
                push_unique(text_colours, fixed);
            }
        }
    }
}

fn strip_css_comments(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(start) = rest.find("/*") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find("*/") {
            Some(end) => rest = &after[end + 2..],
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

fn push_unique(list: &mut Vec<String>, item: String) {
    if !list
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(&item))
    {
        list.push(item);
    }
}

fn colour_warnings(stroke_colours: &[String], text_colours: &[String]) -> Vec<String> {
    if stroke_colours.is_empty() && text_colours.is_empty() {
        return Vec::new();
    }
    let mut all = BTreeSet::new();
    let mut listed = Vec::new();
    for colour in stroke_colours.iter().chain(text_colours) {
        if all.insert(colour.to_ascii_lowercase()) {
            listed.push(format!("{colour:?}"));
        }
    }
    let what = match (text_colours.is_empty(), stroke_colours.is_empty()) {
        (false, false) => "text and strokes",
        (false, true) => "text",
        (true, false) => "strokes",
        (true, true) => unreachable!(),
    };
    let colours = listed.join(", ");
    vec![format!(
        "uses a fixed colour ({colours}) for {what}; use currentColor so it stays visible in light and dark themes"
    )]
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 320 120" fill="none" stroke="currentColor">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M 0 1 L 8 5 L 0 9 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect x="10" y="10" width="80" height="40" stroke="currentColor" fill="currentColor" fill-opacity="0.1"/>
  <line x1="90" y1="30" x2="150" y2="30" marker-end="url(#arrow)"/>
  <use href="#arrow"/>
  <use xlink:href="#arrow"/>
  <text x="50" y="35" fill="currentColor" stroke="none">Node</text>
</svg>"##;

    #[test]
    fn accepts_safe_theme_aware_svgs() {
        assert_eq!(check(GOOD), Ok(Vec::new()));
        let with_prolog =
            format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!-- diagram -->\n{GOOD}");
        assert_eq!(check(&with_prolog), Ok(Vec::new()));
        // A non-standard prefix bound to xlink with a local fragment is allowed.
        let prefixed = r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/1999/xlink" viewBox="0 0 100 50"><defs><g id="a"/></defs><use x:href="#a"/></svg>"##;
        assert_eq!(check(prefixed), Ok(Vec::new()));
        // A tinted shape fill that isn't text or stroke doesn't warn.
        let tinted = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50" fill="#e0e7ff" stroke="currentColor"/><text x="10" y="25" fill="currentColor">Hi</text></svg>"##;
        assert_eq!(check(tinted), Ok(Vec::new()));
        // Local fragment `url(#...)` in CSS (both `<style>` and `style="..."`) is allowed.
        let css_fragment = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><defs><linearGradient id="g"/></defs><style>rect { fill: url(#g); }</style><rect style="fill: url('#g')" width="10" height="10"/></svg>"##;
        assert_eq!(check(css_fragment), Ok(Vec::new()));
    }

    #[test]
    fn refuses_unsafe_svgs_namespaces_dtds_and_missing_view_box() {
        let ns = r#"xmlns="http://www.w3.org/2000/svg""#;
        let bad: &[(&str, &str)] = &[
            (
                &format!(r#"<svg {ns} viewBox="0 0 10 10"><script>alert(1)</script></svg>"#),
                "<script>",
            ),
            (
                &format!(r#"<svg {ns} viewBox="0 0 10 10"><SCRIPT>alert(1)</SCRIPT></svg>"#),
                "<script>",
            ),
            (
                r#"<svg:svg xmlns:svg="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><svg:script>alert(1)</svg:script></svg:svg>"#,
                "<script>",
            ),
            (
                &format!(
                    r#"<svg {ns} viewBox="0 0 10 10"><foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"/></foreignObject></svg>"#
                ),
                "<foreignObject>",
            ),
            (
                &format!(r#"<svg {ns} viewBox="0 0 10 10"><FOREIGNOBJECT/></svg>"#),
                "<foreignObject>",
            ),
            (
                &format!(r##"<svg {ns} viewBox="0 0 10 10"><a href="#x"><rect/></a></svg>"##),
                "<a>",
            ),
            (
                &format!(
                    r##"<svg {ns} viewBox="0 0 10 10"><use href="#x"><animate attributeName="href" to="javascript:alert(1)"/></use></svg>"##
                ),
                "<animate>",
            ),
            (
                &format!(
                    r#"<svg {ns} viewBox="0 0 10 10"><rect><set attributeName="x" to="5"/></rect></svg>"#
                ),
                "<set>",
            ),
            (
                &format!(
                    r#"<svg {ns} viewBox="0 0 10 10"><rect><animateMotion path="M0,0 L10,10"/></rect></svg>"#
                ),
                "<animateMotion>",
            ),
            (
                &format!(
                    r#"<svg {ns} viewBox="0 0 10 10"><rect><animateTransform type="rotate"/></rect></svg>"#
                ),
                "<animateTransform>",
            ),
            (
                &format!(r#"<svg {ns} viewBox="0 0 10 10" onload="alert(1)"/>"#),
                "event handler",
            ),
            (
                &format!(r#"<svg {ns} viewBox="0 0 10 10"><rect onclick="x()"/></svg>"#),
                "event handler",
            ),
            (
                &format!(r#"<svg {ns} viewBox="0 0 10 10"><rect ONMOUSEOVER="x()"/></svg>"#),
                "event handler",
            ),
            (
                &format!(
                    r#"<svg {ns} viewBox="0 0 10 10"><use href="https://example.com"/></svg>"#
                ),
                "local fragment",
            ),
            (
                &format!(
                    r#"<svg {ns} xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><image xlink:href="https://example.com/a.png"/></svg>"#
                ),
                "local fragment",
            ),
            (
                &format!(
                    r#"<svg {ns} xmlns:foo="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><use foo:href="https://example.com"/></svg>"#
                ),
                "local fragment",
            ),
            (
                &format!(
                    r#"<svg {ns} viewBox="0 0 10 10"><use href="&#106;avascript:alert(1)"/></svg>"#
                ),
                "local fragment",
            ),
            (
                &format!(r##"<svg {ns} viewBox="0 0 10 10"><use href="#"/></svg>"##),
                "local fragment",
            ),
            (
                &format!(
                    r#"<svg {ns} viewBox="0 0 10 10"><style>@import url("https://example.com/a.css");</style></svg>"#
                ),
                "@import",
            ),
            (
                &format!(
                    r#"<svg {ns} viewBox="0 0 10 10"><style>@\69mport "https://example.com/a.css";</style></svg>"#
                ),
                "@import",
            ),
            (
                &format!(
                    r#"<svg {ns} viewBox="0 0 10 10"><style>rect {{ fill: url(https://example.com/a.png); }}</style></svg>"#
                ),
                "local fragment",
            ),
            (
                &format!(
                    r#"<svg {ns} viewBox="0 0 10 10"><rect style="background-image: URL('https://example.com/x.png')"/></svg>"#
                ),
                "local fragment",
            ),
            (
                &format!(
                    r#"<svg {ns} viewBox="0 0 10 10"><rect style="fill: \75rl(https://example.com/x.svg#a)"/></svg>"#
                ),
                "local fragment",
            ),
            (
                &format!(
                    r#"<svg {ns} viewBox="0 0 10 10"><rect style="@import 'https://example.com/a.css'"/></svg>"#
                ),
                "@import",
            ),
            (
                &format!(
                    r#"<svg {ns} xmlns:xhtml="http://www.w3.org/1999/xhtml" viewBox="0 0 10 10"><xhtml:div/></svg>"#
                ),
                "only the SVG namespace",
            ),
            (
                r#"<svg viewBox="0 0 10 10"><rect/></svg>"#,
                "xmlns=\"http://www.w3.org/2000/svg\"",
            ),
            (
                &format!(r#"<svg {ns} width="100" height="50"><rect/></svg>"#),
                "viewBox",
            ),
            (
                &format!(r#"<svg {ns} viewbox="0 0 100 50"><rect/></svg>"#),
                "capital B",
            ),
            (
                &format!(r#"<svg {ns} viewBox="0 0 0 50"><rect/></svg>"#),
                "width and height above 0",
            ),
            (
                &format!(
                    r#"<!DOCTYPE svg [ <!ENTITY x "hi"> ]><svg {ns} viewBox="0 0 10 10"><text>&x;</text></svg>"#
                ),
                "DTD",
            ),
            (
                r#"<div xmlns="http://www.w3.org/1999/xhtml">not an svg</div>"#,
                "root element",
            ),
        ];
        for (doc, expected) in bad {
            let err = check(doc).unwrap_err();
            assert!(err.contains(expected), "{doc}: {err}");
        }
    }

    #[test]
    fn warns_about_fixed_colours_on_text_and_strokes() {
        let ns = r#"xmlns="http://www.w3.org/2000/svg""#;
        let stroke = check(&format!(
            r##"<svg {ns} viewBox="0 0 100 50"><line x1="0" y1="0" x2="50" y2="50" stroke="#000"/></svg>"##
        ))
        .unwrap();
        assert_eq!(stroke.len(), 1);
        assert!(
            stroke[0].contains("\"#000\"") && stroke[0].contains("strokes"),
            "{stroke:?}"
        );

        let text = check(&format!(
            r#"<svg {ns} viewBox="0 0 100 50"><text x="5" y="20" fill="black">Hi</text></svg>"#
        ))
        .unwrap();
        assert_eq!(text.len(), 1);
        assert!(
            text[0].contains("\"black\"") && text[0].contains("text"),
            "{text:?}"
        );

        let inherited = check(&format!(
            r##"<svg {ns} viewBox="0 0 100 50"><g fill="#222"><text x="5" y="20">Hi</text></g></svg>"##
        ))
        .unwrap();
        assert_eq!(inherited.len(), 1);
        assert!(
            inherited[0].contains("\"#222\"") && inherited[0].contains("text"),
            "{inherited:?}"
        );

        let overridden = check(&format!(
            r##"<svg {ns} viewBox="0 0 100 50"><g fill="#222"><text x="5" y="20" fill="currentColor">Hi</text></g></svg>"##
        ))
        .unwrap();
        assert!(overridden.is_empty(), "{overridden:?}");

        let inline_style = check(&format!(
            r##"<svg {ns} viewBox="0 0 100 50"><line style="stroke: #444"/><text style="fill: #555">Hi</text></svg>"##
        ))
        .unwrap();
        assert_eq!(inline_style.len(), 1);
        assert!(
            inline_style[0].contains("\"#444\"")
                && inline_style[0].contains("\"#555\"")
                && inline_style[0].contains("text and strokes"),
            "{inline_style:?}"
        );

        let styled = check(&format!(
            r##"<svg {ns} viewBox="0 0 100 50"><style><![CDATA[line {{ stroke: #333; }} text {{ fill: #111; }}]]></style><line/></svg>"##
        ))
        .unwrap();
        assert_eq!(styled.len(), 1);
        assert!(styled[0].contains("text and strokes"), "{styled:?}");
    }
}
