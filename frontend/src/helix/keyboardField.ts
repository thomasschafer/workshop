// Takes key presses from a phone's on-screen keyboard. Such a keyboard edits a text field rather
// than pressing keys: it keeps its own idea of the field's text, composing words, correcting them
// and deleting relative to where it thinks the caret is. Helix's normal mode takes keys without
// changing the text, so a keyboard typing into the code itself soon has the wrong idea of it, and
// sends edits for text that isn't there. Instead, the keyboard types into a hidden field of its
// own, which this reads as keys and empties again after every edit, so what the keyboard thinks
// the field holds is always right.

import { graphemes } from "./text";

/** What the field holds between edits: one character, so Backspace has something to delete. */
export const SENTINEL = "​";

export interface KeyboardSink {
  /** A key that isn't a character, in Helix's notation, such as `backspace` or `ret`. */
  key(name: "backspace" | "del" | "ret" | "A-backspace" | "A-del" | "C-u" | "C-k"): void;
  /** Characters typed, each a key. */
  text(text: string): void;
  /** Text pasted or dropped. */
  paste(text: string): void;
}

/**
 * Turns what a keyboard does to the field into keys for `sink`. Edits it lets Helix take are
 * stopped, so the field doesn't change. Others, such as a word being composed, change the field,
 * and each change is compared with what the field held before it: what's gone was backspaced,
 * and what's new was typed. So a word being composed sends each letter as it's added, and a
 * correction of it backspaces the difference and types the rest.
 */
export class KeyboardField {
  readonly el: HTMLTextAreaElement;
  /** What the field holds that's already been sent as keys. */
  private known = SENTINEL;
  private composing = false;
  /** Counts compositions, so emptying the field after one doesn't cut into the next. */
  private compositions = 0;

  constructor(private readonly sink: KeyboardSink) {
    const el = document.createElement("textarea");
    el.className = "cm-helix-keyboard";
    el.setAttribute("aria-label", "Keys for the code");
    // As little help from the keyboard as it allows: no capitals, corrections or suggestions.
    el.setAttribute("autocapitalize", "off");
    el.setAttribute("autocorrect", "off");
    el.setAttribute("autocomplete", "off");
    el.setAttribute("spellcheck", "false");
    el.setAttribute("enterkeyhint", "enter");
    el.inputMode = "none";
    el.value = SENTINEL;
    el.addEventListener("beforeinput", this.onBeforeInput);
    el.addEventListener("input", this.onInput);
    el.addEventListener("compositionstart", this.onCompositionStart);
    el.addEventListener("compositionend", this.onCompositionEnd);
    el.addEventListener("paste", this.onPaste);
    el.addEventListener("focus", () => {
      if (!this.composing) this.reset();
    });
    this.el = el;
  }

  /** Whether an on-screen keyboard shows while the field has the focus. */
  setKeyboard(enabled: boolean): void {
    this.el.inputMode = enabled ? "text" : "none";
  }

  focus(): void {
    this.el.focus({ preventScroll: true });
  }

  get focused(): boolean {
    return document.activeElement === this.el;
  }

  /** Empties the field to its sentinel, with the caret after it. */
  private reset(): void {
    if (this.el.value !== SENTINEL) this.el.value = SENTINEL;
    this.known = SENTINEL;
    this.el.setSelectionRange(SENTINEL.length, SENTINEL.length);
  }

  private readonly onBeforeInput = (event: InputEvent): void => {
    // Composing is read from what it changes, as it can't be stopped.
    if (event.isComposing || this.composing || !event.cancelable) return;
    event.preventDefault();
    this.handleInput(event.inputType, event.data, event.dataTransfer);
  };

  /** Sends what an edit stands for. */
  private handleInput(type: string, data: string | null, transfer: DataTransfer | null): void {
    switch (type) {
      case "insertText":
      case "insertReplacementText":
        if (data) this.sink.text(data);
        return;
      case "insertParagraph":
      case "insertLineBreak":
        this.sink.key("ret");
        return;
      case "deleteContentBackward":
        this.sink.key("backspace");
        return;
      case "deleteContentForward":
        this.sink.key("del");
        return;
      case "deleteWordBackward":
        this.sink.key("A-backspace");
        return;
      case "deleteWordForward":
        this.sink.key("A-del");
        return;
      case "deleteSoftLineBackward":
      case "deleteHardLineBackward":
        this.sink.key("C-u");
        return;
      case "deleteSoftLineForward":
      case "deleteHardLineForward":
        this.sink.key("C-k");
        return;
      default:
        if (type.startsWith("insertFrom")) {
          const text = transfer?.getData("text/plain") ?? data;
          if (text) this.sink.paste(text);
        }
      // Anything else, such as formatting or the field's own undo, means nothing for code.
    }
  }

  /** Sends how the field differs from what it held: backspaces for what's gone, then typing. */
  private catchUp(): void {
    const value = this.el.value;
    const known = this.known;
    let common = 0;
    while (common < known.length && common < value.length && known[common] === value[common]) {
      common++;
    }
    for (const _ of graphemes(known.slice(common))) this.sink.key("backspace");
    const added = value.slice(common).replaceAll(SENTINEL, "");
    if (added) this.sink.text(added);
    this.known = value;
  }

  private readonly onInput = (): void => {
    this.catchUp();
    if (!this.composing) this.reset();
  };

  private readonly onCompositionStart = (): void => {
    this.compositions++;
    this.composing = true;
  };

  private readonly onCompositionEnd = (): void => {
    this.composing = false;
    this.catchUp();
    // Once the browser has finished with the composition, which can still change the field, or
    // the keyboard would compose on from what's in it.
    const composition = this.compositions;
    setTimeout(() => {
      if (this.compositions !== composition || this.composing) return;
      this.catchUp();
      this.reset();
    }, 0);
  };

  private readonly onPaste = (event: ClipboardEvent): void => {
    const text = event.clipboardData?.getData("text/plain");
    event.preventDefault();
    if (text) this.sink.paste(text);
  };
}
