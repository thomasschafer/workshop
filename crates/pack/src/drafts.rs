//! Drafts: questions added to a pack as they were found, such as from elsewhere, waiting to be
//! made into items with checks. Each is a Markdown file under `drafts/`, with TOML front matter
//! saying where it came from and the skills it's for, and the question as it was given.
//!
//! Drafts aren't items, so they're never practised; the author makes an item from one, with
//! its check, and removes the draft.

use serde::{Deserialize, Serialize};

use crate::item::Kind;
use crate::manifest::{Manifest, is_slug};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Draft {
    /// From its file's name.
    pub id: String,
    /// Where it is in the pack.
    pub path: String,
    /// Where it came from, in the learner's own words. Workshop doesn't interpret it.
    pub source: Option<String>,
    pub skills: Vec<String>,
    /// The kind of item it should become, if that's been said.
    pub kind: Option<Kind>,
    /// When it was added, as `YYYY-MM-DD`.
    pub added: Option<String>,
    /// The question, as it was given.
    pub text: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Front {
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    skills: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<Kind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    added: Option<String>,
}

impl Draft {
    pub fn parse(path: &str, id: &str, source: &str, manifest: &Manifest) -> Result<Self, String> {
        let (front, body) = crate::item::split_front_matter(source)?;
        let front: Front = toml::from_str(front).map_err(|err| err.to_string())?;
        if let Some(unknown) = front.skills.iter().find(|s| !manifest.has_skill(s)) {
            return Err(format!(
                "the skill {unknown:?} isn't in the pack's skills, in pack.toml"
            ));
        }
        let text = body.trim().to_owned();
        if text.is_empty() {
            return Err("the draft has no question in it".to_owned());
        }
        Ok(Self {
            id: id.to_owned(),
            path: path.to_owned(),
            source: front.source,
            skills: front.skills,
            kind: front.kind,
            added: front.added,
            text,
        })
    }

    /// The draft's file.
    pub fn to_file(&self) -> String {
        let front = Front {
            source: self.source.clone(),
            skills: self.skills.clone(),
            kind: self.kind,
            added: self.added.clone(),
        };
        let front = toml::to_string(&front).expect("a draft's front matter is plain TOML");
        format!("+++\n{front}+++\n{}\n", self.text.trim())
    }

    /// What it's called in lists: the start of its question.
    pub fn label(&self) -> String {
        let words: Vec<&str> = self.text.split_whitespace().take(9).collect();
        if words.len() <= 8 {
            words.join(" ")
        } else {
            format!("{}…", words[..8].join(" "))
        }
    }
}

/// An id for a new draft, from its question's first words, different from every id in `taken`.
pub fn new_id(text: &str, taken: &[&str]) -> String {
    let words: Vec<String> = text
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .take(6)
        .map(str::to_ascii_lowercase)
        .collect();
    let base = if words.is_empty() {
        "question".to_owned()
    } else {
        words.join("-")
    };
    debug_assert!(is_slug(&base));
    let mut id = base.clone();
    let mut n = 2;
    while taken.contains(&id.as_str()) {
        id = format!("{base}-{n}");
        n += 1;
    }
    id
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> Manifest {
        Manifest::parse("id = \"x\"\nname = \"X\"\n[[skills]]\nid = \"dice\"\nname = \"Dice\"\n")
            .unwrap()
    }

    #[test]
    fn writes_and_reads_drafts() {
        let draft = Draft {
            id: "two-dice".to_owned(),
            path: "drafts/two-dice.md".to_owned(),
            source: Some("A book on chance, chapter 2".to_owned()),
            skills: vec!["dice".to_owned()],
            kind: Some(Kind::Probability),
            added: Some("2026-11-14".to_owned()),
            text: "Two dice are rolled. What's the chance of a double?".to_owned(),
        };
        let file = draft.to_file();
        assert!(file.starts_with("+++\nsource = \"A book on chance, chapter 2\"\n"));
        assert_eq!(
            Draft::parse(&draft.path, &draft.id, &file, &manifest()).unwrap(),
            draft
        );
        let unknown = file.replace("\"dice\"", "\"cards\"");
        assert!(Draft::parse(&draft.path, &draft.id, &unknown, &manifest()).is_err());
        assert_eq!(draft.label(), "Two dice are rolled. What's the chance of…");
    }

    #[test]
    fn makes_ids_from_the_question() {
        assert_eq!(
            new_id("Two dice are rolled. What's the chance?", &[]),
            "two-dice-are-rolled-what-s"
        );
        assert_eq!(new_id("Why?", &["why"]), "why-2");
        assert_eq!(new_id("?!", &[]), "question");
    }
}
