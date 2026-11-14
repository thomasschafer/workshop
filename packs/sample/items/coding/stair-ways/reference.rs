use std::collections::HashSet;
use std::io::Read;

const MOD: u64 = 1_000_000_007;

fn count_ways(n: usize, broken: &HashSet<usize>) -> u64 {
    let mut ways = vec![0_u64; n + 1];
    ways[0] = 1;
    for step in 1..=n {
        if !broken.contains(&step) {
            ways[step] = (step.saturating_sub(3)..step).map(|below| ways[below]).sum::<u64>() % MOD;
        }
    }
    ways[n]
}

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let data: Vec<usize> = input.split_whitespace().map(|x| x.parse().unwrap()).collect();
    let (n, k) = (data[0], data[1]);
    let broken: HashSet<usize> = data[2..2 + k].iter().copied().collect();
    println!("{}", count_ways(n, &broken));
}
