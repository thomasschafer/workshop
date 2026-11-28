/** A piece of Markdown: prose, or a fenced code block, so a code block can be copied. */
export type MarkdownPart =
  | { kind: "text"; text: string }
  /** `markdown` is the whole block, fences and all, and `code` what's between its fences. */
  | { kind: "code"; markdown: string; code: string };

/** The opening of a fenced code block, as CommonMark has it: three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Splits Markdown into its fenced code blocks and the prose between them, in order. A block
 * left open runs to the end, as Markdown renders it.
 */
export function splitCodeBlocks(text: string): MarkdownPart[] {
  const parts: MarkdownPart[] = [];
  let prose: string[] = [];
  let block: { fence: string; lines: string[] } | null = null;
  const endProse = () => {
    const joined = prose.join("\n");
    if (joined.trim()) parts.push({ kind: "text", text: joined });
    prose = [];
  };
  const endBlock = (open: { fence: string; lines: string[] }, closing: string | null) => {
    const code = open.lines.slice(1).join("\n");
    const markdown = [...open.lines, ...(closing === null ? [] : [closing])].join("\n");
    parts.push({ kind: "code", markdown, code });
  };
  for (const line of text.split("\n")) {
    if (block) {
      const close = line.match(FENCE)?.[1];
      // A closing fence is the same character, at least as long, with nothing after it.
      if (
        close &&
        close[0] === block.fence[0] &&
        close.length >= block.fence.length &&
        line.trim() === close
      ) {
        endBlock(block, line);
        block = null;
      } else {
        block.lines.push(line);
      }
      continue;
    }
    const open = line.match(FENCE)?.[1];
    if (open) {
      endProse();
      block = { fence: open, lines: [line] };
    } else {
      prose.push(line);
    }
  }
  if (block) endBlock(block, null);
  endProse();
  return parts;
}
