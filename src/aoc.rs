//! Fetching puzzles and inputs from Advent of Code, and submitting answers.
//!
//! Everything fetched is cached outside the solutions repo, requests are spaced out, and every
//! request carries a User-Agent identifying this tool, per Advent of Code's guidance for
//! automated tools.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use anyhow::{Context, Result, bail};
use scraper::{ElementRef, Html, Node, Selector};
use serde::Serialize;
use tokio::sync::Mutex;

use crate::language::Puzzle;
use crate::paths;

const BASE_URL: &str = "https://adventofcode.com";
const MIN_REQUEST_INTERVAL: Duration = Duration::from_secs(3);
const CALENDAR_TTL: Duration = Duration::from_secs(15 * 60);

pub struct AocClient {
    http: reqwest::Client,
    session: Option<String>,
    cache_dir: PathBuf,
    base_url: String,
    last_request: Mutex<Option<Instant>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Part {
    One,
    Two,
}

impl Part {
    pub fn number(self) -> u8 {
        match self {
            Part::One => 1,
            Part::Two => 2,
        }
    }

    pub fn from_number(n: u8) -> Result<Self> {
        match n {
            1 => Ok(Part::One),
            2 => Ok(Part::Two),
            _ => bail!("part must be 1 or 2, got {n}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Problem {
    pub title: Option<String>,
    /// Sanitised HTML for each part that is currently visible. `<pre>` blocks carry a
    /// `data-block` index and inline `<code>` elements a `data-code` index, so the user can tap
    /// them to choose sample input and expected answers.
    pub parts_html: Vec<String>,
    /// Plain text of the visible parts, for the discussion model.
    pub text: String,
    /// The answers the user has already had accepted, by part.
    pub answers: Vec<String>,
    /// For each part, the last emphasised inline code that looks like an answer, which is
    /// usually the sample's answer.
    pub suggested_sample_answers: Vec<Option<String>>,
    /// For each part, the code block that is probably its sample input: the first one introduced
    /// as an example, or for part 1 the first block. Part 2 often reuses part 1's sample, in
    /// which case this is `None`.
    pub suggested_sample_blocks: Vec<Option<usize>>,
    pub blocks: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum SubmitOutcome {
    Correct,
    Incorrect {
        hint: Option<String>,
        message: String,
    },
    TooSoon {
        message: String,
    },
    AlreadySolved {
        message: String,
    },
    Unknown {
        message: String,
    },
}

impl AocClient {
    pub fn new(session: Option<String>, user_agent: &str, cache_dir: PathBuf) -> Result<Self> {
        Self::with_base_url(session, user_agent, cache_dir, BASE_URL.into())
    }

    fn with_base_url(
        session: Option<String>,
        user_agent: &str,
        cache_dir: PathBuf,
        base_url: String,
    ) -> Result<Self> {
        let http = reqwest::Client::builder()
            .user_agent(user_agent)
            .timeout(Duration::from_secs(30))
            .build()?;
        Ok(Self {
            http,
            session: session
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty()),
            cache_dir,
            base_url,
            last_request: Mutex::new(None),
        })
    }

    pub fn has_session(&self) -> bool {
        self.session.is_some()
    }

    fn day_dir(&self, puzzle: Puzzle) -> PathBuf {
        self.cache_dir
            .join(puzzle.year.to_string())
            .join(format!("{:02}", puzzle.day))
    }

    pub async fn problem(&self, puzzle: Puzzle, refresh: bool) -> Result<Problem> {
        let path = self.day_dir(puzzle).join("problem.html");
        let html = match read_cache(&path, refresh, None)? {
            Some(html) => html,
            None => {
                let url = format!("{}/{}/day/{}", self.base_url, puzzle.year, puzzle.day);
                let html = self.get(&url).await?;
                paths::write_atomic(&path, html.as_bytes())?;
                html
            }
        };
        parse_problem(&html)
    }

    /// The puzzle if it's already cached, without making any request.
    pub fn cached_problem(&self, puzzle: Puzzle) -> Result<Option<Problem>> {
        let path = self.day_dir(puzzle).join("problem.html");
        read_cache(&path, false, None)?
            .map(|html| parse_problem(&html))
            .transpose()
    }

    pub async fn input(&self, puzzle: Puzzle) -> Result<String> {
        let path = self.day_dir(puzzle).join("input.txt");
        if let Some(input) = read_cache(&path, false, None)? {
            return Ok(input);
        }
        let url = format!("{}/{}/day/{}/input", self.base_url, puzzle.year, puzzle.day);
        let input = self.get(&url).await?;
        paths::write_atomic(&path, input.as_bytes())?;
        Ok(input)
    }

    /// Stars per day, from the year's calendar page.
    pub async fn stars(&self, year: u16, refresh: bool) -> Result<BTreeMap<u8, u8>> {
        let path = self.cache_dir.join(year.to_string()).join("calendar.html");
        let html = match read_cache(&path, refresh, Some(CALENDAR_TTL))? {
            Some(html) => html,
            None => {
                let html = self.get(&format!("{}/{year}", self.base_url)).await?;
                paths::write_atomic(&path, html.as_bytes())?;
                html
            }
        };
        Ok(parse_calendar(&html))
    }

    pub async fn submit(&self, puzzle: Puzzle, part: Part, answer: &str) -> Result<SubmitOutcome> {
        let answer = answer.trim();
        if answer.is_empty() || answer.contains('\n') {
            bail!("the answer must be a single non-empty line");
        }
        let url = format!(
            "{}/{}/day/{}/answer",
            self.base_url, puzzle.year, puzzle.day
        );
        let session = self.require_session()?;
        let response = self
            .throttled(|| {
                self.http
                    .post(&url)
                    .header(reqwest::header::COOKIE, format!("session={session}"))
                    .form(&[
                        ("level", part.number().to_string()),
                        ("answer", answer.to_owned()),
                    ])
                    .send()
            })
            .await?;
        let status = response.status();
        let body = response.text().await?;
        if !status.is_success() {
            bail!("Advent of Code returned {status} when submitting");
        }
        let outcome = parse_submit_response(&body);
        if outcome == SubmitOutcome::Correct {
            // The problem page now shows the next part and the accepted answer.
            let _ = std::fs::remove_file(self.day_dir(puzzle).join("problem.html"));
            let _ = std::fs::remove_file(
                self.cache_dir
                    .join(puzzle.year.to_string())
                    .join("calendar.html"),
            );
        }
        Ok(outcome)
    }

    fn require_session(&self) -> Result<&str> {
        self.session.as_deref().context(
            "your Advent of Code session cookie isn't set; run `workshop doctor` for how to add it",
        )
    }

    async fn get(&self, url: &str) -> Result<String> {
        let session = self.require_session()?;
        let response = self
            .throttled(|| {
                self.http
                    .get(url)
                    .header(reqwest::header::COOKIE, format!("session={session}"))
                    .send()
            })
            .await
            .with_context(|| format!("fetching {url}"))?;
        let status = response.status();
        let body = response.text().await?;
        match status.as_u16() {
            200 => Ok(body),
            400 | 500 if body.contains("log in") => bail!(
                "Advent of Code didn't accept your session cookie; it may have expired. Run `workshop doctor` for how to update it."
            ),
            404 => bail!("Advent of Code has no page at {url}; is the puzzle unlocked yet?"),
            _ => bail!("Advent of Code returned {status} for {url}"),
        }
    }

    async fn throttled<F, Fut>(&self, request: F) -> Result<reqwest::Response>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = reqwest::Result<reqwest::Response>>,
    {
        let mut last = self.last_request.lock().await;
        if let Some(previous) = *last {
            let wait = MIN_REQUEST_INTERVAL.saturating_sub(previous.elapsed());
            tokio::time::sleep(wait).await;
        }
        let result = request().await;
        *last = Some(Instant::now());
        Ok(result?)
    }
}

pub fn read_session(paths: &paths::Paths) -> Result<Option<String>> {
    if let Ok(session) = std::env::var("AOC_SESSION")
        && !session.trim().is_empty()
    {
        return Ok(Some(session.trim().to_owned()));
    }
    let file = paths.aoc_session_file();
    match std::fs::read_to_string(&file) {
        Ok(session) => Ok(Some(session.trim().to_owned()).filter(|s| !s.is_empty())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err).with_context(|| format!("reading {}", file.display())),
    }
}

fn read_cache(path: &Path, refresh: bool, ttl: Option<Duration>) -> Result<Option<String>> {
    if refresh {
        return Ok(None);
    }
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err).with_context(|| format!("reading {}", path.display())),
    };
    if let Some(ttl) = ttl {
        let age = SystemTime::now()
            .duration_since(metadata.modified()?)
            .unwrap_or_default();
        if age > ttl {
            return Ok(None);
        }
    }
    Ok(Some(
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?,
    ))
}

fn selector(s: &str) -> Selector {
    Selector::parse(s).expect("hard-coded selectors are valid")
}

pub fn parse_problem(html: &str) -> Result<Problem> {
    let document = Html::parse_document(html);
    let articles: Vec<_> = document.select(&selector("article.day-desc")).collect();
    if articles.is_empty() {
        bail!("couldn't find the puzzle description on the Advent of Code page");
    }

    let mut sanitiser = Sanitiser::default();
    let mut parts_html = Vec::new();
    let mut text = String::new();
    let mut suggested_sample_answers = Vec::new();
    let mut suggested_sample_blocks = Vec::new();
    for (part, article) in articles.iter().enumerate() {
        let first_block = sanitiser.blocks.len();
        let mut html = String::new();
        sanitiser.children(*article, &mut html);
        parts_html.push(html);

        let pres: Vec<_> = article.select(&selector("pre")).collect();
        let example = pres.iter().position(|pre| introduced_as_example(*pre));
        suggested_sample_blocks.push(match example {
            Some(i) => Some(first_block + i),
            None if part == 0 && !pres.is_empty() => Some(first_block),
            None => None,
        });

        let emphasised_code = selector("code em, em code");
        suggested_sample_answers.push(
            article
                .select(&emphasised_code)
                .last()
                .map(|e| e.text().collect::<String>().trim().to_owned())
                .filter(|a| !a.is_empty() && !a.contains(char::is_whitespace)),
        );
        text.push_str(&article_text(*article));
        text.push_str("\n\n");
    }

    let title = document
        .select(&selector("article.day-desc h2"))
        .next()
        .map(|h| {
            h.text()
                .collect::<String>()
                .trim_matches(|c| c == '-' || c == ' ')
                .to_owned()
        });

    let answers = document
        .select(&selector("main > p"))
        .filter(|p| {
            p.text()
                .collect::<String>()
                .contains("Your puzzle answer was")
        })
        .filter_map(|p| p.select(&selector("code")).next())
        .map(|c| c.text().collect::<String>().trim().to_owned())
        .collect();

    Ok(Problem {
        title,
        parts_html,
        text: text.trim_end().to_owned(),
        answers,
        suggested_sample_answers,
        suggested_sample_blocks,
        blocks: sanitiser.blocks,
    })
}

/// Whether the paragraph before a code block ends "…example:", which is how puzzles usually
/// introduce their sample input, as opposed to illustrations of intermediate steps.
fn introduced_as_example(pre: ElementRef) -> bool {
    pre.prev_siblings()
        .find_map(ElementRef::wrap)
        .filter(|el| el.value().name() == "p")
        .is_some_and(|p| {
            p.text()
                .collect::<String>()
                .trim_end()
                .to_lowercase()
                .ends_with("example:")
        })
}

fn article_text(article: ElementRef) -> String {
    let mut out = String::new();
    for node in article.descendants() {
        if let Node::Text(text) = node.value() {
            out.push_str(text);
        } else if let Node::Element(el) = node.value()
            && matches!(el.name(), "p" | "pre" | "li" | "h2")
            && !out.ends_with('\n')
            && !out.is_empty()
        {
            out.push('\n');
        }
    }
    out
}

/// Rebuilds puzzle HTML from an allowlist, so nothing from the page can run script in the app.
#[derive(Default)]
struct Sanitiser {
    blocks: Vec<String>,
    inline_codes: usize,
    in_pre: bool,
}

impl Sanitiser {
    fn children(&mut self, element: ElementRef, out: &mut String) {
        for child in element.children() {
            match child.value() {
                Node::Text(text) => out.push_str(&escape(text)),
                Node::Element(_) => {
                    if let Some(child) = ElementRef::wrap(child) {
                        self.element(child, out);
                    }
                }
                _ => {}
            }
        }
    }

    fn element(&mut self, element: ElementRef, out: &mut String) {
        let name = element.value().name();
        match name {
            "pre" => {
                let index = self.blocks.len();
                self.blocks.push(element.text().collect());
                out.push_str(&format!("<pre data-block=\"{index}\">"));
                self.in_pre = true;
                self.children(element, out);
                self.in_pre = false;
                out.push_str("</pre>");
            }
            "code" if !self.in_pre => {
                let index = self.inline_codes;
                self.inline_codes += 1;
                out.push_str(&format!("<code data-code=\"{index}\">"));
                self.children(element, out);
                out.push_str("</code>");
            }
            "a" => {
                let href = element
                    .value()
                    .attr("href")
                    .filter(|h| {
                        h.starts_with("http://") || h.starts_with("https://") || h.starts_with('/')
                    })
                    .map(|h| {
                        if h.starts_with('/') {
                            format!("{BASE_URL}{h}")
                        } else {
                            h.to_owned()
                        }
                    });
                match href {
                    Some(href) => out.push_str(&format!(
                        "<a href=\"{}\" target=\"_blank\" rel=\"noreferrer\">",
                        escape(&href)
                    )),
                    None => out.push_str("<a>"),
                }
                self.children(element, out);
                out.push_str("</a>");
            }
            "span" => {
                match element.value().attr("title") {
                    Some(title) => out.push_str(&format!("<span title=\"{}\">", escape(title))),
                    None => out.push_str("<span>"),
                }
                self.children(element, out);
                out.push_str("</span>");
            }
            "p" | "em" | "code" | "ul" | "ol" | "li" | "h2" | "strong" | "b" | "i" | "s"
            | "sup" | "sub" | "blockquote" => {
                out.push_str(&format!("<{name}>"));
                self.children(element, out);
                out.push_str(&format!("</{name}>"));
            }
            "br" => out.push_str("<br>"),
            // Unknown elements keep their text but lose their markup.
            _ => self.children(element, out),
        }
    }
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

pub fn parse_calendar(html: &str) -> BTreeMap<u8, u8> {
    let document = Html::parse_document(html);
    let label = regex::Regex::new(r"(?i)^Day (\d+)(?:, (one|two) stars?)?").expect("valid regex");
    let mut stars = BTreeMap::new();
    for link in document.select(&selector("a[aria-label]")) {
        let Some(aria) = link.value().attr("aria-label") else {
            continue;
        };
        let Some(captures) = label.captures(aria) else {
            continue;
        };
        let Ok(day) = captures[1].parse::<u8>() else {
            continue;
        };
        let count = match captures.get(2).map(|m| m.as_str().to_lowercase()) {
            Some(n) if n == "two" => 2,
            Some(n) if n == "one" => 1,
            _ => 0,
        };
        stars.insert(day, count);
    }
    stars
}

pub fn parse_submit_response(html: &str) -> SubmitOutcome {
    let document = Html::parse_document(html);
    let message = document
        .select(&selector("main article"))
        .next()
        .map(|a| a.text().collect::<String>())
        .unwrap_or_else(|| document.root_element().text().collect())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if message.contains("That's the right answer") {
        SubmitOutcome::Correct
    } else if message.contains("not the right answer") {
        let hint = if message.contains("too high") {
            Some("too high".to_owned())
        } else if message.contains("too low") {
            Some("too low".to_owned())
        } else {
            None
        };
        SubmitOutcome::Incorrect { hint, message }
    } else if message.contains("answer too recently") {
        SubmitOutcome::TooSoon { message }
    } else if message.contains("right level") || message.contains("already complete") {
        SubmitOutcome::AlreadySolved { message }
    } else {
        SubmitOutcome::Unknown { message }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // An invented puzzle in the shape of an Advent of Code page. Real puzzle text must never be
    // used in tests.
    const PART_ONE_PAGE: &str = r#"<html><body><main>
<article class="day-desc"><h2>--- Day 4: Counting Pebbles ---</h2>
<p>The elves have <em>pebbles</em>. <span title="secret">Count</span> them.</p>
<p>For example:</p>
<pre><code>3 1
4 1
</code></pre>
<p>Here the total is <code><em>9</em></code>. <a href="/2017/day/3">Yesterday</a> was easier.</p>
<script>alert(1)</script>
<p onclick="evil()">What is the <code>sum</code>?</p>
</article>
<p>To begin, <a href="4/input" target="_blank">get your puzzle input</a>.</p>
</main></body></html>"#;

    const PART_TWO_PAGE: &str = r#"<html><body><main>
<article class="day-desc"><h2>--- Day 4: Counting Pebbles ---</h2><p>Part one.</p><pre><code>1</code></pre><p>Total <code><em>1</em></code>.</p></article>
<p>Your puzzle answer was <code>1234</code>.</p>
<article class="day-desc"><h2 id="part2">--- Part Two ---</h2><p>Now multiply.</p><pre><code>2 2</code></pre><p>Product <code><em>4</em></code>.</p></article>
</main></body></html>"#;

    #[test]
    fn parses_part_one() {
        let problem = parse_problem(PART_ONE_PAGE).unwrap();
        assert_eq!(problem.title.as_deref(), Some("Day 4: Counting Pebbles"));
        assert_eq!(problem.parts_html.len(), 1);
        assert_eq!(problem.blocks, vec!["3 1\n4 1\n"]);
        assert_eq!(problem.suggested_sample_answers, vec![Some("9".to_owned())]);
        assert_eq!(problem.suggested_sample_blocks, vec![Some(0)]);
        assert!(problem.answers.is_empty());
        assert!(problem.text.contains("For example:"));
    }

    #[test]
    fn sanitises_html() {
        let html = &parse_problem(PART_ONE_PAGE).unwrap().parts_html[0];
        assert!(!html.contains("script"));
        assert!(!html.contains("onclick"));
        assert!(html.contains("<pre data-block=\"0\"><code>3 1"));
        assert!(html.contains("<code data-code=\"0\"><em>9</em></code>"));
        assert!(html.contains("href=\"https://adventofcode.com/2017/day/3\""));
        assert!(html.contains("<span title=\"secret\">"));
        assert!(
            html.contains("alert(1)"),
            "unknown elements keep their text, escaped"
        );
    }

    #[test]
    fn parses_part_two_and_answers() {
        let problem = parse_problem(PART_TWO_PAGE).unwrap();
        assert_eq!(problem.parts_html.len(), 2);
        assert_eq!(problem.answers, vec!["1234"]);
        assert_eq!(problem.blocks, vec!["1", "2 2"]);
        // Part 2 doesn't introduce its own example, so it reuses part 1's.
        assert_eq!(problem.suggested_sample_blocks, vec![Some(0), None]);
        assert_eq!(
            problem.suggested_sample_answers,
            vec![Some("1".to_owned()), Some("4".to_owned())]
        );
    }

    #[test]
    fn suggests_blocks_introduced_as_examples() {
        let page = r#"<html><body><main>
<article class="day-desc"><h2>--- Day 9: Invented ---</h2>
<p>A single piece looks like this:</p><pre><code>+</code></pre>
<p>Here is a bigger example:</p><pre><code>+-+
| |
+-+</code></pre>
<p>After one step:</p><pre><code>+-+</code></pre>
<p>The answer is <code><em>4</em></code>.</p></article>
<p>Your puzzle answer was <code>17</code>.</p>
<article class="day-desc"><h2>--- Part Two ---</h2>
<p>Again considering the example above, it starts like this:</p><pre><code>+</code></pre>
<p>Now the answer is <code><em>8</em></code>, or <code><em>2 * n</em></code> in general.</p></article>
<article class="day-desc"><h2>--- Part Three ---</h2>
<p>For example:</p><pre><code>new</code></pre>
<p>The answer is <code><em>1</em></code>.</p></article>
</main></body></html>"#;
        let problem = parse_problem(page).unwrap();
        // Part 1's example is the second block, not the illustration before it. Part 2 has no
        // example of its own, so it reuses part 1's. The third article has its own.
        assert_eq!(
            problem.suggested_sample_blocks,
            vec![Some(1), None, Some(4)]
        );
        // "2 * n" isn't an answer.
        assert_eq!(
            problem.suggested_sample_answers,
            vec![Some("4".to_owned()), None, Some("1".to_owned())]
        );
    }

    #[test]
    fn rejects_pages_without_a_puzzle() {
        assert!(parse_problem("<html><body>Please log in</body></html>").is_err());
    }

    #[test]
    fn parses_calendar_stars() {
        let html = r#"<main><pre class="calendar">
<a aria-label="Day 1, two stars" href="/2017/day/1" class="calendar-day1 calendar-verycomplete">x</a>
<a aria-label="Day 2, one star" href="/2017/day/2" class="calendar-day2 calendar-complete">x</a>
<a aria-label="Day 3" href="/2017/day/3" class="calendar-day3">x</a>
</pre></main>"#;
        let stars = parse_calendar(html);
        assert_eq!(stars, BTreeMap::from([(1, 2), (2, 1), (3, 0)]));
    }

    #[test]
    fn parses_submit_responses() {
        let wrap = |s: &str| {
            format!("<html><body><main><article><p>{s}</p></article></main></body></html>")
        };
        assert_eq!(
            parse_submit_response(&wrap(
                "That's the right answer! You are one gold star closer."
            )),
            SubmitOutcome::Correct
        );
        assert!(matches!(
            parse_submit_response(&wrap("That's not the right answer; your answer is too high.")),
            SubmitOutcome::Incorrect { hint: Some(h), .. } if h == "too high"
        ));
        assert!(matches!(
            parse_submit_response(&wrap(
                "You gave an answer too recently; you have 30s left to wait."
            )),
            SubmitOutcome::TooSoon { .. }
        ));
        assert!(matches!(
            parse_submit_response(&wrap(
                "You don't seem to be solving the right level. Did you already complete it?"
            )),
            SubmitOutcome::AlreadySolved { .. }
        ));
        assert!(matches!(
            parse_submit_response(&wrap("Something new")),
            SubmitOutcome::Unknown { .. }
        ));
    }

    #[tokio::test]
    async fn serves_from_cache_without_network() {
        let dir = tempfile::tempdir().unwrap();
        let client = AocClient::with_base_url(
            Some("cookie".into()),
            "test",
            dir.path().to_owned(),
            // Unroutable, so any request would fail the test.
            "http://127.0.0.1:9".into(),
        )
        .unwrap();
        let puzzle = Puzzle::new(2017, 4).unwrap();
        let day_dir = client.day_dir(puzzle);
        std::fs::create_dir_all(&day_dir).unwrap();
        std::fs::write(day_dir.join("problem.html"), PART_ONE_PAGE).unwrap();
        std::fs::write(day_dir.join("input.txt"), "1 2\n").unwrap();
        assert_eq!(
            client
                .problem(puzzle, false)
                .await
                .unwrap()
                .parts_html
                .len(),
            1
        );
        assert_eq!(client.input(puzzle).await.unwrap(), "1 2\n");
        assert!(client.problem(puzzle, true).await.is_err());
    }

    #[tokio::test]
    async fn requires_session() {
        let dir = tempfile::tempdir().unwrap();
        let client = AocClient::with_base_url(
            None,
            "test",
            dir.path().to_owned(),
            "http://127.0.0.1:9".into(),
        )
        .unwrap();
        let err = client
            .input(Puzzle::new(2017, 4).unwrap())
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("session cookie"), "{err}");
    }
}
