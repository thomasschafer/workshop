use std::collections::VecDeque;
use std::io::Read;

fn count_islands(grid: &[&[u8]]) -> usize {
    todo!("your code here")
}

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let words: Vec<&str> = input.split_whitespace().collect();
    let rows: usize = words[0].parse().unwrap();
    let grid: Vec<&[u8]> = words[2..2 + rows].iter().map(|row| row.as_bytes()).collect();
    println!("{}", count_islands(&grid));
}
