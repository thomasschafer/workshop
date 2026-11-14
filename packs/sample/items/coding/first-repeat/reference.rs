use std::collections::HashSet;
use std::io::Read;

fn first_repeat<'a>(words: &[&'a str]) -> &'a str {
    let mut seen = HashSet::new();
    for &word in words {
        if !seen.insert(word) {
            return word;
        }
    }
    "none"
}

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let words: Vec<&str> = input.split_whitespace().collect();
    println!("{}", first_repeat(&words));
}
