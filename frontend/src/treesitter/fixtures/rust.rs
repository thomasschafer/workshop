// Representative Rust module for syntax highlighting parity with Helix.
// TODO(alice): cover common Rust constructs and injections (#42)
// FIXME: check https://example.com/docs and @bob mentions

use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub enum Colour {
    Red,
    Green,
    Blue,
}

pub trait Describable {
    fn describe(&self) -> &'static str;
}

impl Describable for Colour {
    fn describe(&self) -> &'static str {
        match self {
            Colour::Red => "red",
            Colour::Green => "green",
            Colour::Blue => "blue",
        }
    }
}

#[derive(Debug, Copy, Clone)]
pub struct Point<'a, T> {
    pub label: &'a str,
    pub x: T,
    pub y: T,
}

pub fn evaluate(values: &[i32], factor: i32) -> Result<i32, String> {
    let mut total = 0_i32;
    for (idx, &v) in values.iter().enumerate() {
        if v < 0 {
            return Err(format!("negative value {v} at index {idx:02}"));
        }
        let step = |n: i32| n * factor + 1;
        total += if v % 2 == 0 { step(v) } else { v };
    }
    Ok(total)
}

pub fn demo() {
    let _re = Regex::new(r"^([a-z_]+)=(\d+)$");
    let mut counts: HashMap<&str, usize> = HashMap::new();
    counts.insert("alpha", 1);
    let pt = Point { label: "origin", x: 0.0_f64, y: -0.0 };
    let val = evaluate(&[1, 2, 3], 2).unwrap_or(0);
    println!("pt={pt:?} colour={} val={val:#06x} escaped={{}}", Colour::Red.describe());
}
