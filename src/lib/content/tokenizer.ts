/**
 * A lexer for PDF content streams.
 *
 * Page text lives in the content stream, not in `/Annots`, so editing it means
 * reading and rewriting operators directly — pdf-lib has no API for this and
 * pdf.js gives positions but no byte offsets.
 *
 * Every token records the span it came from, and the spans are required to tile
 * the input exactly: no gaps, no overlaps. That invariant is the safety net for
 * everything built on top, because a lexer that quietly mis-segments a stream
 * corrupts documents rather than failing.
 *
 * pdf-lib only, no `$lib` imports, so `verify-roundtrip` can exercise it under
 * plain Node.
 */

export type TokenKind =
  | "whitespace"
  | "comment"
  | "number"
  | "name"
  | "string"
  | "hexstring"
  | "array-open"
  | "array-close"
  | "dict-open"
  | "dict-close"
  | "operator"
  /** `BI … ID <raw bytes> EI`, kept whole: the payload is not PDF syntax. */
  | "inline-image";

export interface Token {
  kind: TokenKind;
  /** Byte offsets into the source, end exclusive. */
  start: number;
  end: number;
  /** Operator keyword, for `kind === "operator"`. */
  op?: string;
}

const SPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

const isSpace = (b: number) => SPACE.has(b);
const isDelim = (b: number) => DELIM.has(b);
const isRegular = (b: number) => !isSpace(b) && !isDelim(b);

/** Split a content stream into tokens whose spans tile the input exactly. */
export function tokenize(bytes: Uint8Array): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < bytes.length) {
    const start = i;
    const b = bytes[i];

    if (isSpace(b)) {
      while (i < bytes.length && isSpace(bytes[i])) i++;
      tokens.push({ kind: "whitespace", start, end: i });
      continue;
    }

    if (b === 0x25) {
      // % comment, to end of line.
      while (i < bytes.length && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
      tokens.push({ kind: "comment", start, end: i });
      continue;
    }

    if (b === 0x28) {
      i = skipLiteralString(bytes, i);
      tokens.push({ kind: "string", start, end: i });
      continue;
    }

    if (b === 0x3c) {
      if (bytes[i + 1] === 0x3c) {
        i += 2;
        tokens.push({ kind: "dict-open", start, end: i });
      } else {
        i++;
        while (i < bytes.length && bytes[i] !== 0x3e) i++;
        if (i < bytes.length) i++; // closing >
        tokens.push({ kind: "hexstring", start, end: i });
      }
      continue;
    }

    if (b === 0x3e && bytes[i + 1] === 0x3e) {
      i += 2;
      tokens.push({ kind: "dict-close", start, end: i });
      continue;
    }

    if (b === 0x5b) {
      tokens.push({ kind: "array-open", start, end: ++i });
      continue;
    }

    if (b === 0x5d) {
      tokens.push({ kind: "array-close", start, end: ++i });
      continue;
    }

    if (b === 0x2f) {
      i++;
      while (i < bytes.length && isRegular(bytes[i])) i++;
      tokens.push({ kind: "name", start, end: i });
      continue;
    }

    // A bare `>` or `)` is malformed; consume one byte so the spans still tile
    // and the caller can round-trip a broken stream untouched.
    if (isDelim(b)) {
      tokens.push({ kind: "operator", start, end: ++i, op: String.fromCharCode(b) });
      continue;
    }

    // Number or keyword.
    while (i < bytes.length && isRegular(bytes[i])) i++;
    const text = latin1(bytes, start, i);

    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) {
      tokens.push({ kind: "number", start, end: i });
      continue;
    }

    if (text === "BI") {
      const end = skipInlineImage(bytes, i);
      tokens.push({ kind: "inline-image", start, end });
      i = end;
      continue;
    }

    tokens.push({ kind: "operator", start, end: i, op: text });
  }

  return tokens;
}

/** `(…)` with balanced inner parens and backslash escapes. */
function skipLiteralString(bytes: Uint8Array, from: number): number {
  let i = from + 1;
  let depth = 1;
  while (i < bytes.length && depth > 0) {
    const b = bytes[i];
    if (b === 0x5c) {
      i += 2; // escape consumes the next byte whatever it is
      continue;
    }
    if (b === 0x28) depth++;
    else if (b === 0x29) depth--;
    i++;
  }
  return i;
}

/**
 * `BI <dict> ID <raw bytes> EI`.
 *
 * The payload is arbitrary binary, so the end is found by looking for `EI`
 * delimited by whitespace on the left and whitespace/EOF on the right — the
 * conventional heuristic, since the length is not always declared.
 */
function skipInlineImage(bytes: Uint8Array, from: number): number {
  let i = from;

  // Find the ID that opens the binary payload.
  while (i < bytes.length - 1) {
    if (bytes[i] === 0x49 && bytes[i + 1] === 0x44 && (i === 0 || !isRegular(bytes[i - 1]))) {
      i += 2;
      break;
    }
    i++;
  }
  if (i < bytes.length && isSpace(bytes[i])) i++; // single space after ID

  while (i < bytes.length - 1) {
    if (
      bytes[i] === 0x45 &&
      bytes[i + 1] === 0x49 &&
      (i === 0 || isSpace(bytes[i - 1])) &&
      (i + 2 >= bytes.length || !isRegular(bytes[i + 2]))
    ) {
      return i + 2;
    }
    i++;
  }
  return bytes.length;
}

export function latin1(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/**
 * Do the spans tile `bytes` exactly?
 *
 * Used by the tests as the tokenizer's correctness proof, and cheap enough to
 * call before any rewrite as a guard.
 */
export function tilesExactly(bytes: Uint8Array, tokens: Token[]): boolean {
  let at = 0;
  for (const token of tokens) {
    if (token.start !== at || token.end < token.start) return false;
    at = token.end;
  }
  return at === bytes.length;
}

/** Re-serialise, optionally dropping tokens by index. */
export function serialize(bytes: Uint8Array, tokens: Token[], drop?: Set<number>): Uint8Array {
  const keep = tokens.filter((_, index) => !drop?.has(index));
  const size = keep.reduce((sum, t) => sum + (t.end - t.start), 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const token of keep) {
    out.set(bytes.subarray(token.start, token.end), at);
    at += token.end - token.start;
  }
  return out;
}
