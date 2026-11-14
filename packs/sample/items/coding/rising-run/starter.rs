use std::io::Read;

fn longest_rise(readings: &[i64]) -> usize {
    todo!("your code here")
}

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let numbers: Vec<i64> = input.split_whitespace().map(|x| x.parse().unwrap()).collect();
    let n = numbers[0] as usize;
    println!("{}", longest_rise(&numbers[1..1 + n]));
}
