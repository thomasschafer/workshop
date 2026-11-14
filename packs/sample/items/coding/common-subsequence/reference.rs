use std::io::Read;

fn longest_common(first: &[u8], second: &[u8]) -> usize {
    let mut previous = vec![0; second.len() + 1];
    for &a in first {
        let mut current = vec![0; second.len() + 1];
        for (j, &b) in second.iter().enumerate() {
            current[j + 1] = if a == b {
                previous[j] + 1
            } else {
                previous[j + 1].max(current[j])
            };
        }
        previous = current;
    }
    previous[second.len()]
}

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let words: Vec<&str> = input.split_whitespace().collect();
    println!("{}", longest_common(words[0].as_bytes(), words[1].as_bytes()));
}
