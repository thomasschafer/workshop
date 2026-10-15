/** The push-to-talk button's label, which the help refers to. */
export const TALK_LABEL = "Hold to talk";

/** Python, as the language most people can read; dictation works the same way in any language. */
const EXAMPLES: { say: string; result: string }[] = [
  { say: "def part one of data colon", result: "def part1(data):" },
  {
    say: "new line numbers equals data dot split lines",
    result: "    numbers = data.splitlines()",
  },
  { say: "wrap that in sorted", result: "    numbers = sorted(data.splitlines())" },
  {
    say: "new line return sum of int of n for n in numbers",
    result: "    return sum(int(n) for n in numbers)",
  },
  { say: "change sum to max", result: "    return max(int(n) for n in numbers)" },
];

export function Help() {
  return (
    <div class="help">
      <section>
        <h2>Editing by voice</h2>
        <p>
          Hold the "{TALK_LABEL}" button, say the code roughly as you'd type it, and let go. Edits
          happen at the cursor, so tap in the code first to put it where you want.
        </p>
        <p>For example, in Python, one after another:</p>
        <ol class="examples">
          {EXAMPLES.map((e) => (
            <li key={e.say}>
              <span class="say">"{e.say}"</span>
              <pre class="example-result">{e.result}</pre>
            </li>
          ))}
        </ol>
        <p class="muted">It works the same way in any language.</p>
        <p>
          Workshop only writes what you say. Ask it to write the solution for you and it will
          decline, and if it isn't sure what you meant it asks rather than guessing: tap Reply and
          hold the button to answer, or just hold it to start afresh.
        </p>
        <p>
          Each thing you say gets a card above the button, showing what was heard and then what
          changed. You don't have to wait: keep talking, and later edits queue up behind earlier
          ones. Tap Cancel on a card to drop it before it changes anything.
        </p>
        <p>
          On a computer, you can hold Ctrl instead of the button: on its own, rather than with
          another key as for a shortcut.
        </p>
        <p>
          The button turns green once it's listening; start speaking then. If what's heard often
          isn't what you said, try another way of hearing it in Settings, under Talking: Whisper on
          the server is the most accurate, and your keyboard's dictation works on any phone.
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
          <li>
            "install it", for a package an error says is missing, or "install package" and a name
          </li>
          <li>"start part two", which uncomments the line printing part 2's answer</li>
        </ul>
      </section>

      <section>
        <h2>Helpers and packages</h2>
        <p>
          Code you use in many puzzles, such as parsing numbers or grid neighbours, can go in your
          helpers module, in the <code>lib</code> folder of your solutions repo. It starts with a
          few, and every solution can import it. When an error says a module is missing, Workshop
          offers to install the package that provides it. Settings, under Packages, lists the
          packages you have.
        </p>
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
          part 2's on the second. Press ▶, then Run sample. When it matches, run on your real input,
          then submit the answer it gives. Some older puzzles have no usable example; then run on
          your real input straight away.
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
          a git repo on the server; commit and push from Settings, under Solutions repo, where
          Workshop can also do it after each star.
        </p>
      </section>

      <section>
        <h2>On your phone</h2>
        <p>
          Add Workshop to your home screen from the browser's menu ("Add to Home screen", or Share
          then "Add to Home Screen" on an iPhone), and it opens full screen like an app. An iPhone
          asks for the link once more there, as the app doesn't share Safari's login.
        </p>
        <p>
          In December, Workshop can tell you when each puzzle unlocks: turn it on in Settings,
          under Notifications, on each device you'd like to hear on.
        </p>
      </section>
    </div>
  );
}
