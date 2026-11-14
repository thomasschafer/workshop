use std::collections::HashSet;
use std::io::Read;

const MOD: u64 = 1_000_000_007;

fn count_ways(n: usize, broken: &HashSet<usize>) -> u64 {
    todo!("your code here")
}

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let data: Vec<usize> = input.split_whitespace().map(|x| x.parse().unwrap()).collect();
    let (n, k) = (data[0], data[1]);
    let broken: HashSet<usize> = data[2..2 + k].iter().copied().collect();
    println!("{}", count_ways(n, &broken));
}
