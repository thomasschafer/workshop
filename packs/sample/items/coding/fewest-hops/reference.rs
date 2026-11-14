use std::collections::VecDeque;
use std::io::Read;

fn fewest_hops(n: usize, roads: &[(usize, usize)]) -> i64 {
    let mut neighbours = vec![Vec::new(); n + 1];
    for &(a, b) in roads {
        neighbours[a].push(b);
        neighbours[b].push(a);
    }
    let mut distance = vec![-1_i64; n + 1];
    distance[1] = 0;
    let mut queue = VecDeque::from([1]);
    while let Some(town) = queue.pop_front() {
        for &next in &neighbours[town] {
            if distance[next] == -1 {
                distance[next] = distance[town] + 1;
                queue.push_back(next);
            }
        }
    }
    distance[n]
}

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let data: Vec<usize> = input.split_whitespace().map(|x| x.parse().unwrap()).collect();
    let (n, m) = (data[0], data[1]);
    let roads: Vec<(usize, usize)> = (0..m).map(|i| (data[2 + 2 * i], data[3 + 2 * i])).collect();
    println!("{}", fewest_hops(n, &roads));
}
