use std::collections::VecDeque;
use std::io::Read;

fn count_islands(grid: &[&[u8]]) -> usize {
    let (rows, cols) = (grid.len(), grid[0].len());
    let mut seen = vec![vec![false; cols]; rows];
    let mut islands = 0;
    for r in 0..rows {
        for c in 0..cols {
            if grid[r][c] != b'#' || seen[r][c] {
                continue;
            }
            islands += 1;
            seen[r][c] = true;
            let mut queue = VecDeque::from([(r, c)]);
            while let Some((y, x)) = queue.pop_front() {
                let around = [
                    (y.wrapping_sub(1), x),
                    (y + 1, x),
                    (y, x.wrapping_sub(1)),
                    (y, x + 1),
                ];
                for (ny, nx) in around {
                    if ny < rows && nx < cols && grid[ny][nx] == b'#' && !seen[ny][nx] {
                        seen[ny][nx] = true;
                        queue.push_back((ny, nx));
                    }
                }
            }
        }
    }
    islands
}

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let words: Vec<&str> = input.split_whitespace().collect();
    let rows: usize = words[0].parse().unwrap();
    let grid: Vec<&[u8]> = words[2..2 + rows].iter().map(|row| row.as_bytes()).collect();
    println!("{}", count_islands(&grid));
}
