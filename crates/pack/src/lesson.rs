//! Lessons: short pieces that teach a topic in a few minutes before its questions.
//!
//! A lesson starts with a brief summary (its prompt), optional unscored guesses to focus
//! attention, one to six short segments with optional diagrams and predict-then-reveal checks,
//! and an "explain why" prompt with a model explanation at the end.

use std::collections::BTreeSet;

use serde::Deserialize;

use crate::manifest::is_slug;

/// The fewest and most segments a lesson may have.
pub const SEGMENTS: std::ops::RangeInclusive<usize> = 1..=6;

/// The most guesses a lesson may ask before its first segment.
pub const MAX_GUESSES: usize = 3;

/// How many choices a guess or check may offer.
pub const CHOICES: std::ops::RangeInclusive<usize> = 2..=5;

/// A segment over this many words gets a warning from `workshop pack check`, as it's meant to
/// read comfortably on a phone.
pub const WARN_SEGMENT_WORDS: usize = 180;

/// A segment over this many words is refused by `workshop pack check`.
pub const MAX_SEGMENT_WORDS: usize = 300;

/// PNG files always start with this 8-byte signature.
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

/// A lesson item's parsed content.
#[derive(Debug, Clone, PartialEq)]
pub struct Lesson {
    /// The topic of one of its skills it teaches, if it says.
    pub topic: Option<TopicRef>,
    /// Ids of other lessons in the pack to do first.
    pub requires: Vec<String>,
    /// Where the lesson's facts come from, shown as further reading.
    pub sources: Vec<LessonSource>,
    /// Unscored questions asked before the first segment (0 to 3).
    pub guesses: Vec<Guess>,
    /// The teaching segments, in order (1 to 6).
    pub segments: Vec<Segment>,
    /// The question asked at the end, in the learner's own words (`## Explain`).
    pub explain: String,
    /// What a good explanation covers (`## Explain answer`).
    pub explain_answer: String,
}

/// A topic of a skill, as a lesson names it: `<skill id>/<topic id>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TopicRef {
    pub skill: String,
    pub topic: String,
}

impl TopicRef {
    /// Reads `<skill id>/<topic id>`, checking only its form, not that the topic exists.
    pub fn parse(text: &str) -> Result<Self, String> {
        let (skill, topic) = text
            .split_once('/')
            .filter(|(skill, topic)| !skill.is_empty() && is_slug(topic))
            .ok_or_else(|| {
                format!(
                    "topic {text:?} should be a skill's id and one of its topics' ids, joined by `/`, such as \"graphs/shortest-paths\""
                )
            })?;
        Ok(Self {
            skill: skill.to_owned(),
            topic: topic.to_owned(),
        })
    }
}

impl std::fmt::Display for TopicRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.skill, self.topic)
    }
}

/// A reference a lesson's facts come from, shown as further reading.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LessonSource {
    pub title: String,
    pub url: String,
}

/// An unscored question asked before the first segment, to focus attention on what follows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Guess {
    pub prompt: String,
    pub choices: Vec<String>,
    /// The right choice, counting from 0.
    pub answer: usize,
}

/// A predict-then-reveal check after a segment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Check {
    pub prompt: String,
    pub choices: Vec<String>,
    /// The right choice, counting from 0.
    pub answer: usize,
    pub explanation: String,
}

/// One segment of a lesson, shown a screen at a time on a phone.
#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub title: String,
    /// Markdown text, which may refer to files in [`Self::images`].
    pub body: String,
    /// An optional predict-then-reveal check for this segment.
    pub check: Option<Check>,
    /// Local images referenced in [`Self::body`], in order of appearance.
    pub images: Vec<LessonImage>,
}

/// An image referenced from a segment, kept with the lesson so an embedded pack works like one
/// on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LessonImage {
    /// Relative path inside the lesson's directory.
    pub file: String,
    pub alt: String,
    pub data: ImageData,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageData {
    Svg(String),
    Png(Vec<u8>),
}

/// A link from a short item to the lesson (and optionally segment) that teaches it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LessonRef {
    pub id: String,
    /// The segment that covers the item, counting from 0, if specified.
    pub segment: Option<usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LessonFields {
    topic: Option<String>,
    #[serde(default)]
    requires: Vec<String>,
    #[serde(default)]
    sources: Vec<RawSource>,
    #[serde(default)]
    guesses: Vec<RawGuess>,
    #[serde(default)]
    checks: Vec<RawCheck>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSource {
    title: String,
    url: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawGuess {
    prompt: String,
    choices: Vec<String>,
    answer: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawCheck {
    segment: usize,
    prompt: String,
    choices: Vec<String>,
    answer: usize,
    explanation: String,
}

impl Lesson {
    pub(crate) fn new(
        fields: LessonFields,
        prompt: &str,
        sections: Vec<(String, String)>,
        read_bytes: &dyn Fn(&str) -> Result<Vec<u8>, String>,
    ) -> Result<Self, String> {
        let topic = fields.topic.as_deref().map(TopicRef::parse).transpose()?;

        // Validate `requires`.
        let mut seen_requires = BTreeSet::new();
        for req in &fields.requires {
            if !is_slug(req) {
                return Err(format!(
                    "requires {req:?} should be lowercase letters and digits, in words joined by hyphens"
                ));
            }
            if !seen_requires.insert(req.as_str()) {
                return Err(format!("requires lists {req:?} twice"));
            }
        }

        // Validate `[[sources]]`.
        if fields.sources.is_empty() {
            return Err("a lesson needs at least one `[[sources]]` entry".to_owned());
        }
        let mut sources = Vec::with_capacity(fields.sources.len());
        for (i, source) in fields.sources.into_iter().enumerate() {
            let n = i + 1;
            let title = source.title.trim().to_owned();
            if title.is_empty() {
                return Err(format!("source {n}'s title is empty"));
            }
            let url = source.url.trim().to_owned();
            if !is_http_url(&url) {
                return Err(format!(
                    "source {n}'s url {url:?} should be an http or https URL"
                ));
            }
            sources.push(LessonSource { title, url });
        }

        // Validate `[[guesses]]`.
        if fields.guesses.len() > MAX_GUESSES {
            return Err(format!(
                "a lesson can have at most {MAX_GUESSES} guesses, and this one has {}",
                fields.guesses.len()
            ));
        }
        let mut guesses = Vec::with_capacity(fields.guesses.len());
        for (i, guess) in fields.guesses.into_iter().enumerate() {
            let n = i + 1;
            let label = format!("guess {n}");
            let (prompt, choices, answer) =
                validate_question(&label, guess.prompt, guess.choices, guess.answer)?;
            guesses.push(Guess {
                prompt,
                choices,
                answer,
            });
        }

        // Split sections into segments, `## Explain` and `## Explain answer`.
        let mut raw_segments: Vec<(String, String)> = Vec::new();
        let mut explain: Option<String> = None;
        let mut explain_answer: Option<String> = None;
        for (heading, text) in sections {
            match heading.as_str() {
                "Explain" => explain = Some(text),
                "Explain answer" => explain_answer = Some(text),
                _ => raw_segments.push((heading, text)),
            }
        }
        let explain = explain
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "a lesson needs a `## Explain` section".to_owned())?;
        let explain_answer = explain_answer
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "a lesson needs a `## Explain answer` section".to_owned())?;

        if raw_segments.is_empty() {
            return Err(
                "a lesson needs at least one segment (a `## ` section besides `## Explain` and `## Explain answer`)"
                    .to_owned(),
            );
        }
        if raw_segments.len() > *SEGMENTS.end() {
            return Err(format!(
                "a lesson can have at most {} segments, and this one has {}",
                SEGMENTS.end(),
                raw_segments.len()
            ));
        }

        // Images belong in segments only, so no unchecked image slips into prompt or explain.
        for (where_in, text) in [
            ("the prompt", prompt),
            ("`## Explain`", explain.as_str()),
            ("`## Explain answer`", explain_answer.as_str()),
        ] {
            if !markdown_images(text).is_empty() {
                return Err(format!("images belong in segments, not in {where_in}"));
            }
        }

        let mut segments = Vec::with_capacity(raw_segments.len());
        for (i, (title, body)) in raw_segments.into_iter().enumerate() {
            if body.is_empty() {
                return Err(format!("segment {} ({title:?}) is empty", i + 1));
            }
            let images = load_segment_images(&body, read_bytes)
                .map_err(|err| format!("in segment {} ({title:?}): {err}", i + 1))?;
            segments.push(Segment {
                title,
                body,
                check: None,
                images,
            });
        }

        // Attach `[[checks]]` to their segments.
        let segment_count = segments.len();
        for check in fields.checks {
            if !(1..=segment_count).contains(&check.segment) {
                return Err(if segment_count == 1 {
                    format!(
                        "a check's segment counts from 1, and this lesson has only 1 segment, not {}",
                        check.segment
                    )
                } else {
                    format!(
                        "a check's segment counts from 1, so from 1 to {segment_count}, not {}",
                        check.segment
                    )
                });
            }
            let index = check.segment - 1;
            if segments[index].check.is_some() {
                return Err(format!(
                    "segment {} has more than one check; each segment can have at most one",
                    check.segment
                ));
            }
            let label = format!("the check for segment {}", check.segment);
            let (prompt, choices, answer) =
                validate_question(&label, check.prompt, check.choices, check.answer)?;
            let explanation = check.explanation.trim().to_owned();
            if explanation.is_empty() {
                return Err(format!("{label} has an empty explanation"));
            }
            segments[index].check = Some(Check {
                prompt,
                choices,
                answer,
                explanation,
            });
        }

        Ok(Self {
            topic,
            requires: fields.requires,
            sources,
            guesses,
            segments,
            explain,
            explain_answer,
        })
    }

    /// Runs the lesson's own checks: segment word counts (warn > 180, refuse > 300) and SVG
    /// theme warnings. Returns `(errors, warnings)`.
    pub fn check_self(&self) -> (Vec<String>, Vec<String>) {
        let mut errors = Vec::new();
        let mut warnings = Vec::new();
        let mut warned_svgs = BTreeSet::new();
        for (i, segment) in self.segments.iter().enumerate() {
            let n = i + 1;
            let words = word_count(&segment.body);
            if words > MAX_SEGMENT_WORDS {
                errors.push(format!(
                    "segment {n} ({:?}) has {words} words, over the limit of {MAX_SEGMENT_WORDS}; split it into shorter segments for a phone",
                    segment.title
                ));
            } else if words > WARN_SEGMENT_WORDS {
                warnings.push(format!(
                    "segment {n} ({:?}) has {words} words; aim for {WARN_SEGMENT_WORDS} or fewer so it reads well on a phone",
                    segment.title
                ));
            }
            for image in &segment.images {
                if let ImageData::Svg(svg) = &image.data
                    && warned_svgs.insert(image.file.as_str())
                    && let Ok(svg_warnings) = crate::svg::check(svg)
                {
                    for warning in svg_warnings {
                        warnings.push(format!("{}: {warning}", image.file));
                    }
                }
            }
        }
        (errors, warnings)
    }

    /// Summary of what the lesson contains, for `workshop pack check`.
    pub fn summary(&self) -> String {
        let segments = plural(self.segments.len(), "segment", "segments");
        let checks = self.segments.iter().filter(|s| s.check.is_some()).count();
        let mut parts = vec![segments];
        if !self.guesses.is_empty() {
            parts.push(plural(self.guesses.len(), "guess", "guesses"));
        }
        if checks > 0 {
            parts.push(plural(checks, "check", "checks"));
        }
        parts.join(", ")
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn validate_question(
    label: &str,
    prompt: String,
    choices: Vec<String>,
    answer: usize,
) -> Result<(String, Vec<String>, usize), String> {
    let prompt = prompt.trim().to_owned();
    if prompt.is_empty() {
        return Err(format!("{label}'s prompt is empty"));
    }
    if !CHOICES.contains(&choices.len()) {
        return Err(format!(
            "{label} should have between {} and {} choices, not {}",
            CHOICES.start(),
            CHOICES.end(),
            choices.len()
        ));
    }
    let mut cleaned = Vec::with_capacity(choices.len());
    for choice in choices {
        let text = choice.trim().to_owned();
        if text.is_empty() {
            return Err(format!("{label} has an empty choice"));
        }
        cleaned.push(text);
    }
    if !(1..=cleaned.len()).contains(&answer) {
        return Err(format!(
            "{label}'s answer is the right choice, counting from 1, so from 1 to {}, not {answer}",
            cleaned.len()
        ));
    }
    Ok((prompt, cleaned, answer - 1))
}

fn is_http_url(url: &str) -> bool {
    let Some(rest) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
    else {
        return false;
    };
    if url.chars().any(char::is_whitespace) {
        return false;
    }
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    !host.is_empty()
}

fn load_segment_images(
    body: &str,
    read_bytes: &dyn Fn(&str) -> Result<Vec<u8>, String>,
) -> Result<Vec<LessonImage>, String> {
    let mut images = Vec::new();
    for (alt, raw_target) in markdown_images(body) {
        let target = raw_target.trim();
        if target.is_empty() {
            return Err("an image has no file path".to_owned());
        }
        let alt = alt.trim().to_owned();
        if alt.is_empty() {
            return Err(format!(
                "the image {target:?} needs alt text, inside `![...]`"
            ));
        }
        if target.contains("://") || target.starts_with("data:") {
            return Err(format!(
                "the image {target:?} must be a file in the lesson's directory, not a URL"
            ));
        }
        if target.starts_with('/')
            || target.contains('\\')
            || target
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(format!(
                "the image {target:?} should be a relative path inside the lesson's directory, without `..` or a leading `/`"
            ));
        }
        let ext = target.rsplit_once('.').map(|(_, ext)| ext);
        let data = match ext {
            Some("svg") => {
                let bytes = read_bytes(target)?;
                let text = String::from_utf8(bytes)
                    .map_err(|_| format!("the image {target:?} isn't UTF-8"))?;
                crate::svg::check(&text).map_err(|err| format!("in {target:?}: {err}"))?;
                ImageData::Svg(text)
            }
            Some("png") => {
                let bytes = read_bytes(target)?;
                if !bytes.starts_with(PNG_SIGNATURE) {
                    return Err(format!("the image {target:?} isn't a valid PNG file"));
                }
                ImageData::Png(bytes)
            }
            _ => {
                return Err(format!(
                    "the image {target:?} should be an .svg or .png file"
                ));
            }
        };
        images.push(LessonImage {
            file: target.to_owned(),
            alt,
            data,
        });
    }
    Ok(images)
}

/// Finds Markdown images `![alt](target)` outside fenced code blocks and inline code spans.
fn markdown_images(text: &str) -> Vec<(String, String)> {
    let mut found = Vec::new();
    let mut in_fence: Option<char> = None;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if let Some(ch) = in_fence {
            if (ch == '`' && trimmed.starts_with("```"))
                || (ch == '~' && trimmed.starts_with("~~~"))
            {
                in_fence = None;
            }
            continue;
        }
        if trimmed.starts_with("```") {
            in_fence = Some('`');
            continue;
        }
        if trimmed.starts_with("~~~") {
            in_fence = Some('~');
            continue;
        }
        extract_line_images(line, &mut found);
    }
    found
}

fn extract_line_images(line: &str, found: &mut Vec<(String, String)>) {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        // Skip inline code spans (matching run of N backticks).
        if bytes[i] == b'`' {
            let start = i;
            while i < bytes.len() && bytes[i] == b'`' {
                i += 1;
            }
            let ticks = i - start;
            if let Some(close) = find_closing_ticks(line, i, ticks) {
                i = close + ticks;
            }
            continue;
        }
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            i += 2;
            continue;
        }
        if bytes[i] == b'!'
            && i + 1 < bytes.len()
            && bytes[i + 1] == b'['
            && let Some((alt, target, next)) = parse_image_at(line, i)
        {
            found.push((alt, target));
            i = next;
            continue;
        }
        i += 1;
    }
}

fn find_closing_ticks(line: &str, from: usize, ticks: usize) -> Option<usize> {
    let bytes = line.as_bytes();
    let mut i = from;
    while i < bytes.len() {
        if bytes[i] == b'`' {
            let start = i;
            while i < bytes.len() && bytes[i] == b'`' {
                i += 1;
            }
            if i - start == ticks {
                return Some(start);
            }
        } else {
            i += 1;
        }
    }
    None
}

fn parse_image_at(line: &str, start: usize) -> Option<(String, String, usize)> {
    let bytes = line.as_bytes();
    let mut i = start + 2; // past "!["
    let mut alt = String::new();
    let mut closed_bracket = false;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            alt.push(bytes[i + 1] as char);
            i += 2;
            continue;
        }
        if bytes[i] == b']' {
            closed_bracket = true;
            i += 1;
            break;
        }
        let ch = line[i..].chars().next()?;
        alt.push(ch);
        i += ch.len_utf8();
    }
    if !closed_bracket || i >= bytes.len() || bytes[i] != b'(' {
        return None;
    }
    i += 1; // past '('
    let target_start = i;
    while i < bytes.len() && bytes[i] != b')' {
        i += 1;
    }
    if i >= bytes.len() {
        return None;
    }
    let target = line[target_start..i].to_owned();
    Some((alt, target, i + 1))
}

/// Counts words in a segment's Markdown text, excluding fence lines and `![alt](file)` image
/// references so helpful alt text doesn't count against the word limit.
pub fn word_count(text: &str) -> usize {
    let mut total = 0;
    let mut in_fence: Option<char> = None;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if let Some(ch) = in_fence {
            if (ch == '`' && trimmed.starts_with("```"))
                || (ch == '~' && trimmed.starts_with("~~~"))
            {
                in_fence = None;
                continue;
            }
            total += count_words_in(line);
            continue;
        }
        if trimmed.starts_with("```") {
            in_fence = Some('`');
            continue;
        }
        if trimmed.starts_with("~~~") {
            in_fence = Some('~');
            continue;
        }
        let without_images = strip_line_images(line);
        total += count_words_in(&without_images);
    }
    total
}

fn strip_line_images(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'`' {
            let start = i;
            while i < bytes.len() && bytes[i] == b'`' {
                i += 1;
            }
            let ticks = i - start;
            if let Some(close) = find_closing_ticks(line, i, ticks) {
                out.push_str(&line[start..close + ticks]);
                i = close + ticks;
            } else {
                out.push_str(&line[start..i]);
            }
            continue;
        }
        if bytes[i] == b'!'
            && i + 1 < bytes.len()
            && bytes[i + 1] == b'['
            && let Some((_, _, next)) = parse_image_at(line, i)
        {
            out.push(' ');
            i = next;
            continue;
        }
        let ch = line[i..].chars().next().expect("valid utf-8 boundary");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn count_words_in(text: &str) -> usize {
    text.split_whitespace()
        .filter(|word| word.chars().any(char::is_alphanumeric))
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_markdown_images_outside_code() {
        let text = "Before\n\n![A diagram](grow.svg)\n\n`![not an image](x.svg)`\n\n```md\n![also not](y.png)\n```\n\n![](empty.svg) and ![two](sub/pic.png)";
        assert_eq!(
            markdown_images(text),
            vec![
                ("A diagram".to_owned(), "grow.svg".to_owned()),
                (String::new(), "empty.svg".to_owned()),
                ("two".to_owned(), "sub/pic.png".to_owned()),
            ]
        );
    }

    #[test]
    fn counts_segment_words_excluding_images_and_punctuation_bullets() {
        let text = "One two three.\n\n- Four five\n- Six — seven\n\n![Ten words of descriptive alt text that should not count](diagram.svg)\n";
        assert_eq!(word_count(text), 7);
    }

    #[test]
    fn validates_http_urls() {
        assert!(is_http_url("https://example.com/path"));
        assert!(is_http_url("http://example.com"));
        assert!(!is_http_url("ftp://example.com"));
        assert!(!is_http_url("https://"));
        assert!(!is_http_url("https://example.com/with space"));
        assert!(!is_http_url("example.com"));
    }
}
