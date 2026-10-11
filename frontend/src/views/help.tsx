export function Help() {
  return (
    <div class="help">
      <section>
        <h2>Editing by voice</h2>
        <p>
          Hold the big button, say the code roughly as you'd type it, and let go. Edits happen at
          the cursor, so tap in the code first to put it where you want.
        </p>
        <ul>
          <li>"function solve from string to int"</li>
          <li>"solve equals lines", then "before that map read dot"</li>
          <li>"wrap that in parens", "delete that"</li>
          <li>"on line six change int to integer"</li>
        </ul>
        <p>
          Workshop only writes what you say. Ask it to write the solution for you and it will
          decline, and if it isn't sure what you meant it asks rather than guessing. The last thing
          you said and what changed are shown above the button.
        </p>
      </section>

      <section>
        <h2>Instant commands</h2>
        <p>These work straight away, without the model:</p>
        <ul>
          <li>"undo", "redo"</li>
          <li>"run the sample", "run the real input", "submit"</li>
          <li>"go to line 12", "next error", "previous error"</li>
          <li>"show the problem", "show code", "show notes"</li>
          <li>"snippet" and a snippet's name</li>
        </ul>
      </section>

      <section>
        <h2>Samples</h2>
        <p>
          Before you submit, Workshop checks your code against the puzzle's example. In the puzzle,
          the code it will use as each part's sample input and the expected answer are outlined in
          blue. It guesses them for you; to change them, tap any code in the puzzle, or use Edit at
          the top of the Problem tab to type your own.
        </p>
      </section>

      <section>
        <h2>Running and submitting</h2>
        <p>
          Your program reads the input on stdin and prints part 1's answer on the first line and
          part 2's on the second. Press ▶ to run on the sample. When it matches, run on your real
          input, then submit the answer it gives. Some older puzzles have no usable example; then
          run on your real input straight away.
        </p>
      </section>

      <section>
        <h2>Discuss and notes</h2>
        <p>
          Discuss is for when you're stuck: it can see the puzzle and your code, won't change
          anything, and won't give the answer away unless you ask. Notes is for rough thoughts;
          holding the button there adds what you say.
        </p>
      </section>

      <section>
        <h2>Saving</h2>
        <p>
          Everything saves as you go, so you can put your phone down at any point. Solutions live in
          a git repo on your computer; commit and push from Settings.
        </p>
      </section>
    </div>
  );
}
