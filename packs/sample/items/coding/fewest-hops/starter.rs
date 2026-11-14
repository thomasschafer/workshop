use std::collections::VecDeque;
use std::io::Read;

fn fewest_hops(n: usize, roads: &[(usize, usize)]) -> i64 {
    todo!("your code here")
}

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let data: Vec<usize> = input.split_whitespace().map(|x| x.parse().unwrap()).collect();
    let (n, m) = (data[0], data[1]);
    let roads: Vec<(usize, usize)> = (0..m).map(|i| (data[2 + 2 * i], data[3 + 2 * i])).collect();
    println!("{}", fewest_hops(n, &roads));
}
