use std::collections::HashMap;
use std::io::Read;

fn count_pairs(numbers: &[i64], target: i64) -> u64 {
    let mut seen: HashMap<i64, u64> = HashMap::new();
    let mut pairs = 0;
    for &number in numbers {
        pairs += seen.get(&(target - number)).copied().unwrap_or(0);
        *seen.entry(number).or_insert(0) += 1;
    }
    pairs
}

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let numbers: Vec<i64> = input.split_whitespace().map(|x| x.parse().unwrap()).collect();
    let (n, target) = (numbers[0] as usize, numbers[1]);
    println!("{}", count_pairs(&numbers[2..2 + n], target));
}
