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
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::language::Puzzle;
use crate::paths;
use crate::practice::Practice;

pub const BASE_URL: &str = "https://adventofcode.com";
const MIN_REQUEST_INTERVAL: Duration = Duration::from_secs(3);
const CALENDAR_TTL: Duration = Duration::from_secs(15 * 60);

/// Advent of Code needs the user to log in, for the first time or again: the app offers to.
#[derive(Debug)]
pub struct NeedsLogin(pub &'static str);

impl std::fmt::Display for NeedsLogin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for NeedsLogin {}

const SESSION_REJECTED: NeedsLogin = NeedsLogin(
    "Advent of Code didn't accept your session cookie; it may have expired. Log in again in setup, or see `workshop doctor`.",
);

/// Whether someone is waiting on a request, such as for a puzzle they've opened, or it's for
/// something shown alongside, such as the calendar's stars. Requests are spaced apart either way,
/// but one someone is waiting on goes first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Priority {
    Now,
    Background,
}

/// A request someone is waiting on, counted while it's queued or being made.
struct WaitingNow<'a>(&'a AocClient);

impl<'a> WaitingNow<'a> {
    fn new(client: &'a AocClient) -> Self {
        client
            .waiting_now
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Self(client)
    }
}

impl Drop for WaitingNow<'_> {
    fn drop(&mut self) {
        let before = self
            .0
            .waiting_now
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        if before == 1 {
            self.0.now_done.notify_waiters();
        }
    }
}

pub struct AocClient {
    http: reqwest::Client,
    /// Can be set while running, from the app's setup.
    session: std::sync::RwLock<Option<String>>,
    cache_dir: PathBuf,
    base_url: String,
    min_request_interval: Duration,
    last_request: Mutex<Option<Instant>>,
    /// How many requests someone is waiting on are queued, which background ones give way to.
    waiting_now: std::sync::atomic::AtomicUsize,
    /// Wakes background requests once no request someone is waiting on is queued.
    now_done: tokio::sync::Notify,
    /// Serves the practice puzzle, which never touches Advent of Code.
    practice: Option<Practice>,
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
    /// The same, part by part.
    #[serde(skip)]
    pub parts_text: Vec<String>,
    /// The answers the user has already had accepted, by part.
    pub answers: Vec<String>,
    /// Stars earned on this puzzle.
    pub stars: u8,
    /// On the last day of a year, part 2 isn't a puzzle: its star is awarded for having every
    /// other star.
    pub final_star: Option<FinalStar>,
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
#[serde(tag = "state", rename_all = "snake_case")]
pub enum FinalStar {
    /// Every other star is needed first.
    NeedsMoreStars { more: Option<u32> },
    /// The star can be claimed by submitting part 2.
    Claimable,
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

impl SubmitOutcome {
    /// Whether Advent of Code has the part solved, so the pages Workshop keeps are out of date:
    /// just now, or already, such as from another device.
    pub fn shows_progress(&self) -> bool {
        matches!(self, Self::Correct | Self::AlreadySolved { .. })
    }
}

impl AocClient {
    pub fn with_base_url(
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
            session: std::sync::RwLock::new(
                session
                    .map(|s| s.trim().to_owned())
                    .filter(|s| !s.is_empty()),
            ),
            cache_dir,
            min_request_interval: if base_url == BASE_URL {
                MIN_REQUEST_INTERVAL
            } else {
                // Only tests and demos use another address, and they don't need to be polite.
                Duration::ZERO
            },
            base_url,
            last_request: Mutex::new(None),
            waiting_now: std::sync::atomic::AtomicUsize::new(0),
            now_done: tokio::sync::Notify::new(),
            practice: None,
        })
    }

    pub fn with_practice(mut self, practice: Practice) -> Self {
        self.practice = Some(practice);
        self
    }

    /// Clears progress on the practice puzzle, for another go.
    pub fn reset_practice(&self) -> Result<()> {
        self.practice()?.reset()
    }

    fn practice(&self) -> Result<&Practice> {
        self.practice
            .as_ref()
            .context("the practice puzzle isn't available here")
    }

    pub fn has_session(&self) -> bool {
        self.session().is_some()
    }

    fn session(&self) -> Option<String> {
        self.session
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub fn set_session(&self, session: String) {
        *self
            .session
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(session);
    }

    /// Checks that a session cookie logs in, by fetching a page that shows whether it does.
    pub async fn check_session(&self, session: &str) -> Result<()> {
        let url = format!("{}/2015", self.base_url);
        let response = self
            .throttled(Priority::Now, || {
                self.http
                    .get(&url)
                    .header(reqwest::header::COOKIE, format!("session={session}"))
                    .send()
            })
            .await
            .context("couldn't reach Advent of Code to check the cookie")?;
        // Advent of Code answers a malformed cookie with an error status rather than a page.
        let logged_in =
            response.status().is_success() && response.text().await?.contains("[Log Out]");
        if !logged_in {
            bail!(
                "Advent of Code didn't accept that cookie. Check you copied the whole value of the `session` cookie while logged in."
            );
        }
        Ok(())
    }

    /// Where the example found for a part is kept, next to the puzzle it came from.
    pub fn sample_path(&self, puzzle: Puzzle, part: Part) -> PathBuf {
        self.day_dir(puzzle)
            .join(format!("sample-{}.json", part.number()))
    }

    fn day_dir(&self, puzzle: Puzzle) -> PathBuf {
        self.cache_dir
            .join(puzzle.year.to_string())
            .join(format!("{:02}", puzzle.day))
    }

    pub async fn problem(&self, puzzle: Puzzle, refresh: bool) -> Result<Problem> {
        if puzzle.is_practice() {
            return parse_problem(&self.practice()?.page()?);
        }
        let path = self.day_dir(puzzle).join("problem.html");
        let html = match read_cache(&path, refresh, None)? {
            Some(html) => html,
            None => {
                let url = format!("{}/{}/day/{}", self.base_url, puzzle.year, puzzle.day);
                let html = self.get(&url, Priority::Now).await?;
                paths::write_atomic(&path, html.as_bytes())?;
                html
            }
        };
        parse_problem(&html)
    }

    /// The puzzle if it's already cached, without making any request.
    pub fn cached_problem(&self, puzzle: Puzzle) -> Result<Option<Problem>> {
        if puzzle.is_practice() {
            return parse_problem(&self.practice()?.page()?).map(Some);
        }
        let path = self.day_dir(puzzle).join("problem.html");
        read_cache(&path, false, None)?
            .map(|html| parse_problem(&html))
            .transpose()
    }

    pub async fn input(&self, puzzle: Puzzle) -> Result<String> {
        if puzzle.is_practice() {
            return Ok(crate::practice::INPUT.clone());
        }
        let path = self.day_dir(puzzle).join("input.txt");
        if let Some(input) = read_cache(&path, false, None)? {
            return Ok(input);
        }
        let url = format!("{}/{}/day/{}/input", self.base_url, puzzle.year, puzzle.day);
        let input = self.get(&url, Priority::Now).await?;
        paths::write_atomic(&path, input.as_bytes())?;
        Ok(input)
    }

    /// Stars per day, from the year's calendar page.
    pub async fn stars(&self, year: u16, refresh: bool) -> Result<BTreeMap<u8, u8>> {
        let path = self.cache_dir.join(year.to_string()).join("calendar.html");
        let html = match read_cache(&path, refresh, Some(CALENDAR_TTL))? {
            Some(html) => html,
            None => {
                let html = self
                    .get(&format!("{}/{year}", self.base_url), Priority::Background)
                    .await?;
                paths::write_atomic(&path, html.as_bytes())?;
                html
            }
        };
        Ok(parse_calendar(&html))
    }

    /// Your time to each star, by day, from your personal stats: how long after the puzzle
    /// unlocked, as Advent of Code shows it, such as `01:05:02` or `>24h`.
    pub async fn times(&self, year: u16, refresh: bool) -> Result<BTreeMap<u8, StarTimes>> {
        let path = self.cache_dir.join(year.to_string()).join("times.html");
        let html = match read_cache(&path, refresh, Some(CALENDAR_TTL))? {
            Some(html) => html,
            None => {
                let html = self
                    .get(
                        &format!("{}/{year}/leaderboard/self", self.base_url),
                        Priority::Background,
                    )
                    .await?;
                paths::write_atomic(&path, html.as_bytes())?;
                html
            }
        };
        Ok(parse_times(&html))
    }

    /// A private leaderboard, fetched at most once every 15 minutes.
    pub async fn leaderboard(
        &self,
        year: u16,
        id: &LeaderboardId,
    ) -> Result<Vec<LeaderboardMember>> {
        let path = self
            .cache_dir
            .join(year.to_string())
            .join(format!("leaderboard-{}.json", id.0));
        let json = match read_cache(&path, false, Some(LEADERBOARD_TTL))? {
            Some(json) => json,
            None => {
                let json = self
                    .get(
                        &format!(
                            "{}/{year}/leaderboard/private/view/{}.json",
                            self.base_url, id.0
                        ),
                        Priority::Background,
                    )
                    .await?;
                paths::write_atomic(&path, json.as_bytes())?;
                json
            }
        };
        parse_leaderboard(&json)
    }

    pub async fn submit(&self, puzzle: Puzzle, part: Part, answer: &str) -> Result<SubmitOutcome> {
        let answer = answer.trim();
        if answer.is_empty() || answer.contains('\n') {
            bail!("the answer must be a single non-empty line");
        }
        if puzzle.is_practice() {
            return self.practice()?.submit(part, answer);
        }
        let url = format!(
            "{}/{}/day/{}/answer",
            self.base_url, puzzle.year, puzzle.day
        );
        let session = self.require_session()?;
        let response = self
            .throttled(Priority::Now, || {
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
        if !status.is_success() && body.contains("log in") {
            return Err(SESSION_REJECTED.into());
        }
        if !status.is_success() {
            bail!("Advent of Code returned {status} when submitting");
        }
        let outcome = parse_submit_response(&body);
        if outcome.shows_progress() {
            // The problem page now shows the next part and the accepted answer.
            let _ = std::fs::remove_file(self.day_dir(puzzle).join("problem.html"));
            // Both now show the new star.
            for page in ["calendar.html", "times.html"] {
                let _ =
                    std::fs::remove_file(self.cache_dir.join(puzzle.year.to_string()).join(page));
            }
        }
        Ok(outcome)
    }

    fn require_session(&self) -> Result<String> {
        self.session().ok_or_else(|| {
            NeedsLogin("Workshop isn't logged in to Advent of Code yet. Add your session cookie in setup, or see `workshop doctor`.").into()
        })
    }

    async fn get(&self, url: &str, priority: Priority) -> Result<String> {
        let session = self.require_session()?;
        let response = match self
            .throttled(priority, || {
                self.http
                    .get(url)
                    .header(reqwest::header::COOKIE, format!("session={session}"))
                    .send()
            })
            .await
        {
            Ok(response) => response,
            Err(err) => {
                tracing::warn!("fetching {url}: {err:#}");
                bail!("couldn't reach Advent of Code; check your internet connection");
            }
        };
        let status = response.status();
        let body = response.text().await?;
        match status.as_u16() {
            200 => Ok(body),
            400 | 500 if body.contains("log in") => Err(SESSION_REJECTED.into()),
            404 => bail!("Advent of Code has no page at {url}; is the puzzle unlocked yet?"),
            _ => bail!("Advent of Code returned {status} for {url}"),
        }
    }

    async fn throttled<F, Fut>(&self, priority: Priority, request: F) -> Result<reqwest::Response>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = reqwest::Result<reqwest::Response>>,
    {
        use std::sync::atomic::Ordering;
        // Counted until it's made, or abandoned, such as when the app stops waiting for it.
        let _waiting = (priority == Priority::Now).then(|| WaitingNow::new(self));
        let result = loop {
            let mut last = self.last_request.lock().await;
            if let Some(previous) = *last {
                let wait = self.min_request_interval.saturating_sub(previous.elapsed());
                tokio::time::sleep(wait).await;
            }
            if priority == Priority::Background && self.waiting_now.load(Ordering::SeqCst) > 0 {
                drop(last);
                self.until_nothing_waiting_now().await;
                continue;
            }
            let result = request().await;
            *last = Some(Instant::now());
            break result;
        };
        Ok(result?)
    }

    async fn until_nothing_waiting_now(&self) {
        loop {
            // Made before checking, so a notification in between isn't missed.
            let done = self.now_done.notified();
            if self.waiting_now.load(std::sync::atomic::Ordering::SeqCst) == 0 {
                return;
            }
            done.await;
        }
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
    let mut parts_text = Vec::new();
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
        let part_text = article_text(*article);
        text.push_str(&part_text);
        text.push_str("\n\n");
        parts_text.push(part_text);
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
        .collect::<Vec<_>>();

    let success: String = document
        .select(&selector("p.day-success"))
        .flat_map(|p| p.text())
        .collect();
    let stars = if success.contains("Both parts") {
        2
    } else if success.contains("first half") {
        1
    } else {
        u8::try_from(answers.len().min(2)).expect("at most 2")
    };

    let main_text = document
        .select(&selector("main"))
        .next()
        .map(|m| m.text().collect::<String>())
        .unwrap_or_default();
    let final_star = if document
        .select(&selector("main form input[type=hidden][name=answer]"))
        .next()
        .is_some()
        && stars < 2
    {
        Some(FinalStar::Claimable)
    } else if main_text.contains("enough stars") {
        let more = regex::Regex::new(r"You need (\d+) more")
            .expect("valid regex")
            .captures(&main_text)
            .and_then(|c| c[1].parse().ok());
        Some(FinalStar::NeedsMoreStars { more })
    } else {
        None
    };

    Ok(Problem {
        title,
        parts_html,
        text: text.trim_end().to_owned(),
        parts_text,
        answers,
        stars,
        final_star,
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
            && matches!(el.name(), "p" | "pre" | "li" | "h2" | "br")
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

/// A private leaderboard's ID: the number at the end of its address on Advent of Code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct LeaderboardId(String);

impl TryFrom<String> for LeaderboardId {
    type Error = anyhow::Error;

    fn try_from(id: String) -> Result<Self> {
        let id = id.trim().to_owned();
        if id.is_empty() || id.len() > 12 || !id.chars().all(|c| c.is_ascii_digit()) {
            bail!("a leaderboard's ID is the number at the end of its address, such as 123456");
        }
        Ok(Self(id))
    }
}

impl From<LeaderboardId> for String {
    fn from(id: LeaderboardId) -> Self {
        id.0
    }
}

/// How often a private leaderboard may be fetched: Advent of Code asks for no more than once
/// every 15 minutes.
const LEADERBOARD_TTL: Duration = Duration::from_secs(15 * 60);

/// One member of a private leaderboard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LeaderboardMember {
    pub name: String,
    pub score: u64,
    pub stars: u64,
}

/// A private leaderboard's members, best first.
pub fn parse_leaderboard(json: &str) -> Result<Vec<LeaderboardMember>> {
    #[derive(Deserialize)]
    struct Board {
        members: BTreeMap<String, Member>,
    }
    #[derive(Deserialize)]
    struct Member {
        id: u64,
        name: Option<String>,
        local_score: u64,
        stars: u64,
    }
    let board: Board = serde_json::from_str(json).context("reading the leaderboard")?;
    let mut members: Vec<LeaderboardMember> = board
        .members
        .into_values()
        .map(|m| LeaderboardMember {
            name: m
                .name
                .unwrap_or_else(|| format!("Anonymous user #{}", m.id)),
            score: m.local_score,
            stars: m.stars,
        })
        .collect();
    members.sort_by(|a, b| b.score.cmp(&a.score).then(b.stars.cmp(&a.stars)));
    Ok(members)
}

/// The time to each part's star, if it's been earned.
pub type StarTimes = [Option<String>; 2];

/// Times from the personal stats page. Its table lists a day, then for each part a time, which
/// before 2025 is followed by a rank and score, and `-` for a star not yet earned.
pub fn parse_times(html: &str) -> BTreeMap<u8, StarTimes> {
    let document = Html::parse_document(html);
    let text: String = document
        .select(&selector("main"))
        .next()
        .map(|main| main.text().collect())
        .unwrap_or_default();
    let is_time = |token: &&str| token.contains(':') || token.starts_with('>') || *token == "-";
    let mut times = BTreeMap::new();
    for line in text.lines() {
        let mut tokens = line.split_whitespace();
        let Some(day) = tokens.next().and_then(|t| t.parse::<u8>().ok()) else {
            continue;
        };
        let mut parts = tokens
            .filter(is_time)
            .map(|t| (t != "-").then(|| t.to_owned()));
        let (Some(first), second) = (parts.next(), parts.next()) else {
            continue;
        };
        times.insert(day, [first, second.flatten()]);
    }
    times
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
    // Links back to the site, such as "[Return to Day 1]", which mean nothing in Workshop.
    let message = regex::Regex::new(r"\s*\[[^\]]*\]")
        .expect("valid regex")
        .replace_all(&message, "")
        .trim()
        .to_owned();
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

    #[test]
    fn reads_private_leaderboards() {
        // Invented members, as Advent of Code's leaderboard JSON lists them.
        let json = r#"{"event":"2025","owner_id":1,"members":{
            "1":{"id":1,"name":"Ada","local_score":40,"stars":6,"completion_day_level":{}},
            "2":{"id":2,"name":null,"local_score":52,"stars":7,"completion_day_level":{}}}}"#;
        let members = parse_leaderboard(json).unwrap();
        assert_eq!(members[0].name, "Anonymous user #2");
        assert_eq!(
            members[1],
            LeaderboardMember {
                name: "Ada".into(),
                score: 40,
                stars: 6
            }
        );
    }

    #[test]
    fn takes_only_numbers_as_leaderboard_ids() {
        assert!(LeaderboardId::try_from(" 123456 ".to_owned()).is_ok());
        for bad in ["", "abc", "12/../3", "1234567890123"] {
            assert!(LeaderboardId::try_from(bad.to_owned()).is_err(), "{bad}");
        }
    }

    #[test]
    fn reads_personal_times_in_both_layouts() {
        // Invented times, laid out as Advent of Code lays out personal stats.
        let before_2025 = "<main><pre>      --------Part 1---------   --------Part 2--------
Day       Time    Rank  Score       Time   Rank  Score
  2   00:31:10    4321      0          -      -      -
  1       >24h  102464      0   00:10:00   9000      0
</pre></main>";
        let times = parse_times(before_2025);
        assert_eq!(
            times[&1],
            [Some(">24h".to_owned()), Some("00:10:00".to_owned())]
        );
        assert_eq!(times[&2], [Some("00:31:10".to_owned()), None]);
        let from_2025 = "<main><pre>Day   -Part 1-   -Part 2-
 12       >24h          -
  3   00:59:46   01:19:33
</pre></main>";
        let times = parse_times(from_2025);
        assert_eq!(times[&12], [Some(">24h".to_owned()), None]);
        assert_eq!(
            times[&3],
            [Some("00:59:46".to_owned()), Some("01:19:33".to_owned())]
        );
        assert_eq!(times.len(), 2);
    }

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

    // The last day of a year, in the shapes the page takes as the user progresses.
    fn final_day(after_part_one: &str) -> String {
        format!(
            r#"<html><body><main>
<article class="day-desc"><h2>--- Day 25: Invented Ending ---</h2><p>Count it.</p></article>
<p>Your puzzle answer was <code>42</code>.</p><p class="day-success">The first half of this puzzle is complete! It provides one gold star: *</p>
<article class="day-desc"><h2 id="part2">--- Part Two ---</h2><p>The rest needs every star.</p></article>
{after_part_one}
</main></body></html>"#
        )
    }

    #[test]
    fn final_day_needing_more_stars() {
        let problem = parse_problem(&final_day(
            "<p>You don't have enough stars to finish, though. You need 2 more.</p>",
        ))
        .unwrap();
        assert_eq!(problem.stars, 1);
        assert_eq!(
            problem.final_star,
            Some(FinalStar::NeedsMoreStars { more: Some(2) })
        );
    }

    #[test]
    fn final_day_ready_to_claim() {
        let problem = parse_problem(&final_day(
            r#"<form method="post" action="25/answer"><input type="hidden" name="level" value="2"/><input type="hidden" name="answer" value="0"/><p>You can <input type="submit" value="[Finish]"/>.</p></form>"#,
        ))
        .unwrap();
        assert_eq!(problem.final_star, Some(FinalStar::Claimable));
    }

    #[test]
    fn final_day_complete() {
        let page = final_day("")
            .replace("The first half of this puzzle is complete! It provides one gold star: *", "")
            .replace(
                "</main>",
                r#"<form method="post" action="25/answer"><input type="hidden" name="level" value="2"/><input type="hidden" name="answer" value="0"/></form><p class="day-success">Both parts of this puzzle are complete! They provide two gold stars: **</p></main>"#,
            );
        let problem = parse_problem(&page).unwrap();
        assert_eq!(problem.stars, 2);
        assert_eq!(problem.answers.len(), 1);
        assert_eq!(problem.final_star, None);
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
        assert_eq!(
            parse_submit_response(&wrap(
                "You don't seem to be solving the right level. Did you already complete it? <a href=\"/2021/day/1\">[Return to Day 1]</a>"
            )),
            SubmitOutcome::AlreadySolved {
                message:
                    "You don't seem to be solving the right level. Did you already complete it?"
                        .into()
            }
        );
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

    /// A stand-in for Advent of Code that treats only the cookie "good" as logged in.
    async fn fake_aoc() -> String {
        use axum::http::{HeaderMap, StatusCode};
        let app = axum::Router::new().route(
            "/2015",
            axum::routing::get(|headers: HeaderMap| async move {
                let cookie = headers
                    .get("cookie")
                    .and_then(|c| c.to_str().ok())
                    .unwrap_or_default();
                match cookie {
                    "session=good" => (StatusCode::OK, "<a href=\"/auth/logout\">[Log Out]</a>"),
                    "session=expired" => (StatusCode::OK, "<a href=\"/auth/login\">[Log In]</a>"),
                    _ => (StatusCode::INTERNAL_SERVER_ERROR, "error"),
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn checks_session_cookies() {
        let dir = tempfile::tempdir().unwrap();
        let client =
            AocClient::with_base_url(None, "test", dir.path().to_owned(), fake_aoc().await)
                .unwrap();
        client.check_session("good").await.unwrap();
        for bad in ["expired", "malformed"] {
            let err = client.check_session(bad).await.unwrap_err().to_string();
            assert!(err.contains("didn't accept that cookie"), "{bad}: {err}");
        }
        assert!(!client.has_session());
        client.set_session("good".into());
        assert!(client.has_session());
    }

    #[test]
    fn keeps_line_breaks_in_the_text() {
        // Invented, with an example written across two lines.
        let html = r#"<main><article class="day-desc"><h2>--- Day 3: Paths ---</h2>
<p>For example, <code>R2,U1<br>L4,D2</code> gives <code><em>7</em></code>.</p></article></main>"#;
        let problem = parse_problem(html).unwrap();
        assert!(
            problem.parts_text[0].contains("R2,U1\nL4,D2 gives 7."),
            "{:?}",
            problem.parts_text
        );
    }

    #[tokio::test]
    async fn fetches_what_someone_is_waiting_for_first() {
        let order = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen = order.clone();
        let app = axum::Router::new().fallback(move |uri: axum::http::Uri| {
            let seen = seen.clone();
            async move {
                seen.lock().unwrap().push(uri.path().to_owned());
                "<html><body><main></main></body></html>"
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let dir = tempfile::tempdir().unwrap();
        let mut client = AocClient::with_base_url(
            Some("good".into()),
            "test",
            dir.path().to_owned(),
            format!("http://{address}"),
        )
        .unwrap();
        // Long enough that the input is asked for well before the times' turn comes, however
        // slowly the test runs.
        client.min_request_interval = Duration::from_secs(1);
        let puzzle = Puzzle::new(2017, 4).unwrap();

        // As if a request was made just now, so the next waits its turn.
        *client.last_request.lock().await = Some(Instant::now());
        // The times are queued first, but someone is waiting on the input.
        let times = client.times(2017, false);
        let input = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            client.input(puzzle).await
        };
        let (times, input) = tokio::join!(times, input);
        times.unwrap();
        input.unwrap();
        assert_eq!(
            *order.lock().unwrap(),
            ["/2017/day/4/input", "/2017/leaderboard/self"]
        );
    }

    #[tokio::test]
    async fn background_requests_carry_on_when_one_waited_on_is_abandoned() {
        let dir = tempfile::tempdir().unwrap();
        let mut client =
            AocClient::with_base_url(None, "test", dir.path().to_owned(), fake_aoc().await)
                .unwrap();
        client.min_request_interval = Duration::from_millis(200);
        client.check_session("good").await.unwrap();
        // Given up on while it waits its turn.
        let abandoned =
            tokio::time::timeout(Duration::from_millis(20), client.check_session("good")).await;
        assert!(abandoned.is_err());
        assert_eq!(
            client.waiting_now.load(std::sync::atomic::Ordering::SeqCst),
            0
        );
    }

    #[tokio::test]
    async fn forgets_pages_that_are_out_of_date_once_a_part_is_solved_elsewhere() {
        let app = axum::Router::new().route(
            "/2017/day/4/answer",
            axum::routing::post(|| async {
                "<main><article><p>You don't seem to be solving the right level. Did you already complete it? <a href=\"/2017/day/4\">[Return to Day 4]</a></p></article></main>"
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let dir = tempfile::tempdir().unwrap();
        let client = AocClient::with_base_url(
            Some("good".into()),
            "test",
            dir.path().to_owned(),
            format!("http://{address}"),
        )
        .unwrap();
        let puzzle = Puzzle::new(2017, 4).unwrap();
        let pages = [
            client.day_dir(puzzle).join("problem.html"),
            dir.path().join("2017").join("calendar.html"),
            dir.path().join("2017").join("times.html"),
        ];
        for page in &pages {
            std::fs::create_dir_all(page.parent().unwrap()).unwrap();
            std::fs::write(page, "old").unwrap();
        }
        let outcome = client.submit(puzzle, Part::One, "12").await.unwrap();
        assert!(matches!(outcome, SubmitOutcome::AlreadySolved { .. }));
        for page in &pages {
            assert!(!page.exists(), "{}", page.display());
        }
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
