// An invented puzzle for the README's demo and screenshots. Never put a real puzzle or input here.

export const YEAR = 2025;
export const DAY = 9;

export const PUZZLE = `<html><body><main>
<article class="day-desc"><h2>--- Day ${DAY}: Lantern Rows ---</h2>
<p>Each line lists the lanterns on one row of the market stalls. Which row has the most?</p>
<p>For example:</p>
<pre><code>3 4
10
1 2 3
</code></pre>
<p>The rows have 7, 10 and 6 lanterns, so the answer is <code><em>10</em></code>.</p>
</article>
</main></body></html>`;

export const INPUT = "5 8 13\n21 1\n2 2 2 2\n40\n9 9 9\n";

/** Stars on the year's calendar, up to the puzzle's day. */
export const STARS = { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 7: 1, 8: 2, 9: 0 } as const;
