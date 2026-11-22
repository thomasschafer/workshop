//! Follow-up questions on cards. Having answered a card in their own words, typed or aloud, the
//! learner can go deeper: the tutor asks a follow-up question about what they said, such as why
//! it's so, what happens in an edge case, or what changes under a different condition, and once
//! they've answered it, another, up to the card's `follow_ups`. Then the grader marks the whole
//! exchange, for how deeply they understand the card as well as whether they're right, and that's
//! the card's attempt.
//!
//! Each answer and question is saved as it's given, so the learner can stop part-way and carry
//! on, on any device. The tutor sees the card's answer and explanation, which the learner hasn't
//! yet, so its questions go at what matters, without giving the answer away.

use std::time::Duration;

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use workshop_pack::{Content, FollowUps, Item};
use workshop_provider::{CallSpec, ProviderRunner};

/// How long the tutor may take to ask a question.
pub const TIMEOUT: Duration = Duration::from_secs(120);

/// The tutor's instructions for asking follow-up questions on cards, with a pack's tutor add-on
/// if it has one, as this is the tutor's counterpart for cards.
pub fn system_prompt(add_on: Option<&str>) -> String {
    crate::grader::with_add_on(include_str!("../prompts/follow-ups.md"), add_on)
}

/// Something the learner said: their answer to the card, or a reply to a question.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Said {
    pub text: String,
    /// Whether it was explained aloud, so it's what speech recognition heard, which is also
    /// marked for how clearly it was put.
    pub spoken: bool,
    /// When, in milliseconds since 1970.
    pub at: i64,
}

/// A follow-up question the tutor asked, and the learner's reply once they've given it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Question {
    pub text: String,
    pub asked_at: i64,
    #[serde(default)]
    pub reply: Option<Said>,
}

/// A card answered in the learner's own words, and followed up, saved as it goes, and kept with
/// its marks once it's marked.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Exchange {
    /// Made by the app as it starts, so starting it again, as after a lost reply, finds it, and
    /// each reply says which exchange it's for. It's also the id of the attempt it's marked as.
    pub id: String,
    /// The most questions the tutor asks, as the card said when the exchange started.
    pub limit: FollowUps,
    /// The learner's answer to the card itself.
    pub answer: Said,
    /// The tutor's questions so far, in the order they were asked.
    #[serde(default)]
    pub questions: Vec<Question>,
    /// How many attempts the card had when it started: one more, from answering it some other
    /// way, ends it, whatever the clocks of the devices say.
    pub attempts_before: u64,
    /// When it was started, and last changed, in milliseconds since 1970.
    pub started_at: i64,
    pub updated_at: i64,
    /// How the grader marked it, once it has. It's over then, and kept, so asking to mark it
    /// again, as after a lost reply, gives the same marks rather than a second attempt.
    #[serde(default)]
    pub marked: Option<crate::grader::Marked>,
}

/// What happens next in an exchange.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Next {
    /// The tutor asks its next question.
    Ask,
    /// The learner replies to the question waiting.
    Reply,
    /// Every question's been asked and answered, so it's ready to mark, or it's been marked.
    Mark,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ExchangeError {
    #[error("this card doesn't offer follow-up questions")]
    NotOffered,
    #[error("there's nothing in the answer")]
    Empty,
    #[error("there's a question waiting for your answer")]
    Waiting,
    #[error("there's no question waiting for an answer")]
    NotWaiting,
    #[error("the tutor has asked all {0} of its questions")]
    AllAsked(u8),
    #[error("the tutor hasn't asked question {0}")]
    NoSuchQuestion(usize),
    #[error("question {0} has been answered already, with something else")]
    Answered(usize),
    #[error("these follow-up questions have been marked already")]
    Marked,
}

impl Exchange {
    /// Starts an exchange with the learner's answer to the card, which had `attempts_before`
    /// attempts.
    pub fn new(
        id: &str,
        limit: FollowUps,
        attempts_before: u64,
        text: &str,
        spoken: bool,
        now: i64,
    ) -> Result<Self, ExchangeError> {
        if !limit.offered() {
            return Err(ExchangeError::NotOffered);
        }
        Ok(Self {
            id: id.to_owned(),
            limit,
            answer: said(text, spoken, now)?,
            questions: Vec::new(),
            attempts_before,
            started_at: now,
            updated_at: now,
            marked: None,
        })
    }

    /// Whether it's over without being marked, as the card it's on now has `attempts`, or is
    /// flagged as wrong, so it's left out of practice.
    pub fn superseded(&self, attempts: u64, flagged: bool) -> bool {
        self.marked.is_none() && (attempts > self.attempts_before || flagged)
    }

    pub fn next(&self) -> Next {
        if self.marked.is_some() {
            return Next::Mark;
        }
        match self.questions.last() {
            Some(question) if question.reply.is_none() => Next::Reply,
            _ if self.questions.len() < usize::from(self.limit.get()) => Next::Ask,
            _ => Next::Mark,
        }
    }

    /// Adds the tutor's next question.
    pub fn asked(&mut self, question: &str, now: i64) -> Result<(), ExchangeError> {
        if self.marked.is_some() {
            return Err(ExchangeError::Marked);
        }
        match self.next() {
            Next::Ask => {}
            Next::Reply => return Err(ExchangeError::Waiting),
            Next::Mark => return Err(ExchangeError::AllAsked(self.limit.get())),
        }
        let text = question.trim();
        if text.is_empty() {
            return Err(ExchangeError::Empty);
        }
        self.questions.push(Question {
            text: text.to_owned(),
            asked_at: now,
            reply: None,
        });
        self.updated_at = now;
        Ok(())
    }

    /// Adds the learner's reply to a question, counting from 0, which must be the one waiting.
    /// The same reply sent again, as after a lost reply, changes nothing, and says so by
    /// returning false; a different one to a question already answered is refused.
    pub fn replied(
        &mut self,
        question: usize,
        text: &str,
        spoken: bool,
        now: i64,
    ) -> Result<bool, ExchangeError> {
        if self.marked.is_some() {
            return Err(ExchangeError::Marked);
        }
        let reply = said(text, spoken, now)?;
        let last = self.questions.len().checked_sub(1);
        let asked = self
            .questions
            .get_mut(question)
            .ok_or(ExchangeError::NoSuchQuestion(question + 1))?;
        match &asked.reply {
            Some(given) if given.text == reply.text && given.spoken == reply.spoken => Ok(false),
            Some(_) => Err(ExchangeError::Answered(question + 1)),
            None if Some(question) == last => {
                asked.reply = Some(reply);
                self.updated_at = now;
                Ok(true)
            }
            None => Err(ExchangeError::NotWaiting),
        }
    }

    /// Keeps the grader's marks, which end it.
    pub fn mark(&mut self, marked: crate::grader::Marked) -> Result<(), ExchangeError> {
        if self.marked.is_some() {
            return Err(ExchangeError::Marked);
        }
        self.marked = Some(marked);
        Ok(())
    }

    /// Whether any of it was explained aloud, so it's marked for clarity too.
    pub fn spoken(&self) -> bool {
        self.answer.spoken
            || self
                .questions
                .iter()
                .any(|q| q.reply.as_ref().is_some_and(|reply| reply.spoken))
    }

    /// The exchange as the tutor and the grader read it, one line for each thing said, with the
    /// tutor's lines as `tutor`'s. What was explained aloud says so, and a question left
    /// unanswered, as when the learner had it marked early, says that.
    pub fn transcript(&self, tutor: &str) -> String {
        let learner = |said: &Said| {
            let who = if said.spoken {
                "Learner (aloud)"
            } else {
                "Learner"
            };
            format!("{who}: {}\n", one_line(&said.text))
        };
        let mut out = learner(&self.answer);
        for question in &self.questions {
            out.push_str(&format!("{tutor}: {}\n", one_line(&question.text)));
            match &question.reply {
                Some(reply) => out.push_str(&learner(reply)),
                None => out.push_str("Learner: (Not answered.)\n"),
            }
        }
        out.trim_end().to_owned()
    }
}

fn said(text: &str, spoken: bool, now: i64) -> Result<Said, ExchangeError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(ExchangeError::Empty);
    }
    Ok(Said {
        text: text.to_owned(),
        spoken,
        at: now,
    })
}

/// Lines run together, so each thing said is one line of a transcript.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// How the grader's transcript names the tutor.
pub const TUTOR: &str = "Tutor";

/// The tutor's prompt for its next question.
pub fn ask_prompt(item: &Item, exchange: &Exchange) -> Result<String> {
    let Content::Card {
        answer,
        explanation,
        ..
    } = &item.content
    else {
        bail!(
            "only a card's answer is followed up, not {}'s",
            item.label()
        );
    };
    if exchange.next() != Next::Ask {
        bail!("the tutor has no question to ask now");
    }
    let mut out = format!(
        "<question>\n{}\n</question>\n\n<answer>\n{}\n</answer>\n\n",
        item.prompt.trim(),
        answer.trim()
    );
    if let Some(explanation) = explanation {
        out.push_str(&format!(
            "<explanation>\n{}\n</explanation>\n\n",
            explanation.trim()
        ));
    }
    out.push_str("The answer and explanation are the card's, for you only: the learner hasn't seen them.\n\n");
    out.push_str(&format!(
        "<conversation>\n{}\n</conversation>\n\n",
        exchange.transcript("You")
    ));
    let number = exchange.questions.len() + 1;
    let limit = exchange.limit.get();
    out.push_str(&format!(
        "Ask follow-up question {number} of {limit}: one short question that probes what they said last."
    ));
    if usize::from(limit) == number {
        out.push_str(" It's the last, so ask about what matters most that they haven't shown yet.");
    }
    out.push_str(" Reply with the question alone.");
    Ok(out)
}

/// Reads the tutor's question, checking it has one.
pub fn parse_question(reply: &str) -> Result<String> {
    let text = one_line(reply);
    let text = text.trim_matches('"').trim();
    if text.is_empty() {
        bail!("the tutor's question was empty");
    }
    Ok(text.to_owned())
}

/// Has the tutor ask its next follow-up question.
pub async fn ask(
    runner: &ProviderRunner,
    spec: &CallSpec,
    item: &Item,
    exchange: &Exchange,
) -> Result<String> {
    let prompt = ask_prompt(item, exchange)?;
    let reply = runner.call_aside(spec, &prompt, TIMEOUT).await?;
    parse_question(&reply.text)
}

#[cfg(test)]
mod tests {
    use workshop_pack::Pack;

    use super::*;

    fn two() -> FollowUps {
        FollowUps::new(2).unwrap()
    }

    fn start(text: &str) -> Exchange {
        Exchange::new("first", two(), 3, text, false, 1).unwrap()
    }

    fn marks(score: f64) -> crate::grader::Marked {
        crate::grader::Marked {
            score,
            points: Vec::new(),
            findings: Vec::new(),
            feedback: String::new(),
            clarity: None,
            questioning: None,
        }
    }

    #[test]
    fn takes_turns_until_every_question_is_answered() {
        let none = FollowUps::new(0).unwrap();
        assert_eq!(
            Exchange::new("x", none, 0, "O(log n)", false, 1),
            Err(ExchangeError::NotOffered)
        );
        assert_eq!(
            Exchange::new("x", two(), 0, "  ", false, 1),
            Err(ExchangeError::Empty)
        );
        let mut exchange = start(" O(log n) ");
        assert_eq!(
            (exchange.id.as_str(), exchange.answer.text.as_str()),
            ("first", "O(log n)")
        );
        assert_eq!(exchange.next(), Next::Ask);
        // The learner can't reply before there's a question.
        assert_eq!(
            exchange.replied(0, "Because", false, 2),
            Err(ExchangeError::NoSuchQuestion(1))
        );
        exchange.asked("Why log n?", 2).unwrap();
        assert_eq!(exchange.next(), Next::Reply);
        // Nor the tutor ask again before it's answered.
        assert_eq!(exchange.asked("And?", 3), Err(ExchangeError::Waiting));
        assert_eq!(exchange.replied(0, " ", true, 3), Err(ExchangeError::Empty));
        assert_eq!(exchange.replied(0, "It's one path", true, 3), Ok(true));
        exchange.asked("And the smallest?", 4).unwrap();
        assert_eq!(exchange.replied(1, "At the root", false, 5), Ok(true));
        assert_eq!(exchange.next(), Next::Mark);
        assert_eq!(exchange.asked("More?", 6), Err(ExchangeError::AllAsked(2)));
        assert_eq!((exchange.started_at, exchange.updated_at), (1, 5));
        assert!(exchange.spoken());

        // What failed changed nothing, so it saves as it was.
        let saved = serde_json::to_string(&exchange).unwrap();
        let read: Exchange = serde_json::from_str(&saved).unwrap();
        assert_eq!(read, exchange);
        assert_eq!(read.questions.len(), 2);
    }

    #[test]
    fn files_each_reply_under_the_question_it_names() {
        let mut exchange = start("O(log n)");
        exchange.asked("Why?", 2).unwrap();
        exchange.replied(0, "One path", false, 3).unwrap();
        exchange.asked("And the smallest?", 4).unwrap();
        // The first reply sent again, as after its reply was lost, is taken as already given,
        // never as the answer to the question asked since.
        assert_eq!(exchange.replied(0, " One path ", false, 5), Ok(false));
        assert!(exchange.questions[1].reply.is_none());
        assert_eq!(exchange.updated_at, 4);
        // Something else for a question already answered is refused.
        assert_eq!(
            exchange.replied(0, "Two paths", false, 5),
            Err(ExchangeError::Answered(1))
        );
        assert_eq!(
            exchange.replied(0, "One path", true, 5),
            Err(ExchangeError::Answered(1))
        );
        // As is a reply to a question not asked yet.
        assert_eq!(
            exchange.replied(2, "Later", false, 5),
            Err(ExchangeError::NoSuchQuestion(3))
        );
        assert_eq!(exchange.replied(1, "At the root", false, 6), Ok(true));
    }

    #[test]
    fn is_over_once_marked_or_once_the_card_is_answered_another_way() {
        let mut exchange = start("O(log n)");
        // The card had three attempts as it started; a fourth, such as the learner's own
        // rating, or it being flagged as wrong, ends it.
        assert!(!exchange.superseded(3, false));
        assert!(exchange.superseded(4, false));
        assert!(exchange.superseded(3, true));
        exchange.asked("Why?", 2).unwrap();
        exchange.mark(marks(0.5)).unwrap();
        assert_eq!(exchange.mark(marks(0.9)), Err(ExchangeError::Marked));
        // Marked, it has nothing more to ask.
        assert_eq!(exchange.next(), Next::Mark);
        assert_eq!(exchange.marked.as_ref().unwrap().score, 0.5);
        // Its own attempt doesn't end it; it's kept, with its marks.
        assert!(!exchange.superseded(4, false));
        assert_eq!(exchange.asked("More?", 3), Err(ExchangeError::Marked));
        assert_eq!(
            exchange.replied(0, "x", false, 3),
            Err(ExchangeError::Marked)
        );
    }

    #[test]
    fn writes_out_the_exchange_saying_what_was_aloud_and_unanswered() {
        let mut exchange = start("It's\nO(log n)");
        assert!(!exchange.spoken());
        exchange.asked("Why?", 2).unwrap();
        exchange.replied(0, "one path down", true, 3).unwrap();
        exchange.asked("When isn't it?", 4).unwrap();
        assert_eq!(
            exchange.transcript(TUTOR),
            "Learner: It's O(log n)\nTutor: Why?\nLearner (aloud): one path down\nTutor: When isn't it?\nLearner: (Not answered.)"
        );
    }

    #[test]
    fn asks_the_tutor_to_probe_what_was_said_without_giving_it_away() {
        let pack = Pack::sample();
        let card = pack.item("binary-heap-costs").unwrap();
        let mut exchange = start("Log n to add");
        let prompt = ask_prompt(card, &exchange).unwrap();
        assert!(prompt.starts_with("<question>\nIn a binary heap of n items"));
        assert!(prompt.contains("<answer>\nAdding and removing take O(log n)"));
        assert!(prompt.contains("<explanation>\nThe smallest is always at the root."));
        assert!(prompt.contains("the learner hasn't seen them"));
        assert!(prompt.contains("<conversation>\nLearner: Log n to add\n</conversation>"));
        assert!(prompt.contains("Ask follow-up question 1 of 2:"));
        assert!(!prompt.contains("It's the last"));
        assert!(prompt.ends_with("Reply with the question alone."));

        exchange.asked("Why log n?", 2).unwrap();
        // Waiting for the learner, there's nothing to ask.
        assert!(ask_prompt(card, &exchange).is_err());
        exchange.replied(0, "The height", true, 3).unwrap();
        let last = ask_prompt(card, &exchange).unwrap();
        assert!(last.contains(
            "<conversation>\nLearner: Log n to add\nYou: Why log n?\nLearner (aloud): The height\n</conversation>"
        ));
        assert!(last.contains("Ask follow-up question 2 of 2:"));
        assert!(last.contains("It's the last"));
        // Only a card is followed up.
        assert!(ask_prompt(pack.item("islands").unwrap(), &exchange).is_err());

        let system = system_prompt(Some("Ask about costs."));
        assert!(system.starts_with("You are a tutor"));
        assert!(system.ends_with("The pack adds:\n\nAsk about costs."));
        assert!(!system_prompt(Some("  ")).contains("The pack adds"));
    }

    #[test]
    fn reads_the_tutors_question() {
        assert_eq!(
            parse_question(" \"Why is it\nlog n?\" \n").unwrap(),
            "Why is it log n?"
        );
        assert!(parse_question(" \n").is_err());
        assert!(parse_question("\"\"").is_err());
    }
}
