//! Making a mental maths question from its template: drawing the params for a seed, and
//! working out the answer.

use serde::Serialize;

use crate::item::{MentalMaths, Param, placeholders};
use crate::number;
use crate::script::{Scripts, Value};

/// How many draws to try for params that meet the template's `require` before giving up.
const MAX_DRAWS: u32 = 1_000;

/// One question made from a template.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Instance {
    /// What it was made from: the same seed always makes the same question.
    pub seed: u64,
    pub prompt: String,
    pub answer: f64,
    /// How to work it out, with this question's numbers.
    pub method: Option<String>,
}

/// A template ready to make questions, with its expressions compiled once.
pub struct Generator<'a> {
    template: &'a MentalMaths,
    prompt: &'a str,
    scripts: Scripts,
    derived: Vec<(String, rhai::AST)>,
    answer: rhai::AST,
    require: Option<rhai::AST>,
}

impl<'a> Generator<'a> {
    pub fn new(template: &'a MentalMaths, prompt: &'a str) -> Result<Self, String> {
        let scripts = Scripts::new(0);
        let derived = template
            .derived
            .iter()
            .map(|(name, expr)| {
                scripts
                    .compile_expression(expr)
                    .map(|ast| (name.clone(), ast))
                    .map_err(|err| format!("in the derived value {name}: {err}"))
            })
            .collect::<Result<_, _>>()?;
        let answer = scripts
            .compile_expression(&template.answer)
            .map_err(|err| format!("in the answer: {err}"))?;
        let require = template
            .require
            .as_deref()
            .map(|expr| scripts.compile_expression(expr))
            .transpose()
            .map_err(|err| format!("in require: {err}"))?;
        Ok(Self {
            template,
            prompt,
            scripts,
            derived,
            answer,
            require,
        })
    }

    pub fn instance(&self, seed: u64) -> Result<Instance, String> {
        self.scripts.reseed(seed);
        for _ in 0..MAX_DRAWS {
            let mut values: Vec<(String, Value)> = self
                .template
                .params
                .iter()
                .map(|(name, param)| {
                    let mut rng = self.scripts.rng();
                    let value = match param {
                        Param::Range { min, max } => rng.int_between(*min, *max),
                        Param::Choices { choices } => {
                            choices[rng.int_between(0, choices.len() as i64 - 1) as usize]
                        }
                    };
                    (name.clone(), Value::Int(value))
                })
                .collect();
            if let Some(require) = &self.require {
                match self.scripts.run(require, &values)? {
                    Value::Bool(true) => {}
                    Value::Bool(false) => continue,
                    other => return Err(format!("require gave {other:?}, not true or false")),
                }
            }
            let params = values.clone();
            for (name, ast) in &self.derived {
                let value = self
                    .scripts
                    .run(ast, &params)
                    .map_err(|err| format!("in the derived value {name}: {err}"))?;
                if let Value::Bool(_) = value {
                    return Err(format!("the derived value {name} should be a number"));
                }
                values.push((name.clone(), value));
            }
            let answer = match self
                .scripts
                .run(&self.answer, &values)
                .map_err(|err| format!("in the answer: {err}"))?
            {
                Value::Bool(_) => return Err("the answer should be a number".to_owned()),
                value => value.as_f64(),
            };
            values.push(("answer".to_owned(), Value::Float(answer)));
            return Ok(Instance {
                seed,
                prompt: fill(self.prompt, &values),
                answer,
                method: self.template.method.as_deref().map(|m| fill(m, &values)),
            });
        }
        Err(format!(
            "no params met `require` in {MAX_DRAWS} draws, so it may never be met"
        ))
    }
}

/// Puts the values into a text's `{name}` placeholders.
fn fill(text: &str, values: &[(String, Value)]) -> String {
    let mut filled = text.to_owned();
    for name in placeholders(text) {
        let (_, value) = values
            .iter()
            .find(|(n, _)| *n == name)
            .expect("placeholders are checked when the item is read");
        filled = filled.replace(&format!("{{{name}}}"), &number::display(value.as_f64()));
    }
    filled
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::number::Tolerance;

    fn template(require: Option<&str>) -> MentalMaths {
        MentalMaths {
            params: BTreeMap::from([
                ("a".to_owned(), Param::Range { min: 2, max: 9 }),
                (
                    "b".to_owned(),
                    Param::Choices {
                        choices: vec![10, 20],
                    },
                ),
            ]),
            derived: BTreeMap::from([("product".to_owned(), "a * b".to_owned())]),
            answer: "product / a".to_owned(),
            require: require.map(str::to_owned),
            tolerance: Tolerance::EXACT,
            method: Some("{product} ÷ {a} = {answer}".to_owned()),
        }
    }

    #[test]
    fn makes_the_same_question_from_the_same_seed() {
        let template = template(None);
        let generator = Generator::new(&template, "What's {product} ÷ {a}?").unwrap();
        let first = generator.instance(3).unwrap();
        assert_eq!(generator.instance(3).unwrap(), first);
        assert!(first.answer == 10.0 || first.answer == 20.0);
        let a = first
            .prompt
            .split(" ÷ ")
            .nth(1)
            .unwrap()
            .trim_end_matches('?');
        let product = first
            .prompt
            .trim_start_matches("What's ")
            .split(' ')
            .next()
            .unwrap();
        assert_eq!(
            product.parse::<f64>().unwrap() / a.parse::<f64>().unwrap(),
            first.answer
        );
        assert_eq!(
            first.method.unwrap(),
            format!("{product} ÷ {a} = {}", number::display(first.answer))
        );
        let prompts: std::collections::BTreeSet<String> = (0..50)
            .map(|seed| generator.instance(seed).unwrap().prompt)
            .collect();
        assert!(prompts.len() > 5);
    }

    #[test]
    fn draws_until_the_params_meet_require() {
        let template = template(Some("a == 7"));
        let generator = Generator::new(&template, "{a}").unwrap();
        for seed in 0..20 {
            assert_eq!(generator.instance(seed).unwrap().prompt, "7");
        }
        let impossible = self::template(Some("a > 100"));
        let generator = Generator::new(&impossible, "{a}").unwrap();
        assert!(
            generator
                .instance(0)
                .unwrap_err()
                .contains("may never be met")
        );
    }
}
