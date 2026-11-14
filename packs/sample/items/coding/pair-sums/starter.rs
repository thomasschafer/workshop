use std::collections::HashMap;
use std::io::Read;

fn count_pairs(numbers: &[i64], target: i64) -> u64 {
    todo!("your code here")
}

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let numbers: Vec<i64> = input.split_whitespace().map(|x| x.parse().unwrap()).collect();
    let (n, target) = (numbers[0] as usize, numbers[1]);
    println!("{}", count_pairs(&numbers[2..2 + n], target));
}
