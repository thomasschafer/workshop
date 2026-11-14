use std::io::Read;

fn longest_common(first: &[u8], second: &[u8]) -> usize {
    todo!("your code here")
}

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let words: Vec<&str> = input.split_whitespace().collect();
    println!("{}", longest_common(words[0].as_bytes(), words[1].as_bytes()));
}
