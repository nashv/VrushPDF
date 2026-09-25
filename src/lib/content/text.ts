/**
 * Where each show-text operator actually draws.
 *
 * The tokenizer says what the operators are; this says where they put ink. A
 * click in the viewer can only be tied back to a run in the content stream if
 * every `Tj`/`TJ` has a position, so this is the bridge between the two.
 *
 * Runs are identified by **operator ordinal** rather than byte offset: ordinals
 * survive the stream being re-compressed on save, offsets do not.
 *
 * pdf-lib only, no `$lib` imports, so `verify-roundtrip` can exercise it in Node.
 */
import { latin1, type Token } from "./tokenizer";

/** `[a b c d e f]`, the usual PDF affine matrix. */
export type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m` then `n` — i.e. the matrix product m × n, PDF's row-vector convention. */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

export interface ShownText {
  /** Position among show operators on the page, counting from zero. */
  ordinal: number;
  /** Index of the operator token, for rewriting. */
  tokenIndex: number;
  /** Indices of the string tokens this operator shows. */
  stringTokens: number[];
  /** The shown bytes, as latin-1; decoding to Unicode needs the font. */
  text: string;
  /** Baseline origin in page space. */
  x: number;
  y: number;
  /** Font resource name, e.g. `/F1`, and the size in effect. */
  font: string;
  size: number;
}

interface State {
  ctm: Matrix;
  tm: Matrix;
  tlm: Matrix;
  font: string;
  size: number;
  leading: number;
  rise: number;
  hscale: number;
}

const fresh = (): State => ({
  ctm: [...IDENTITY] as Matrix,
  tm: [...IDENTITY] as Matrix,
  tlm: [...IDENTITY] as Matrix,
  font: "",
  size: 0,
  leading: 0,
  rise: 0,
  hscale: 1,
});

/**
 * Walk the tokens, tracking the state that affects where text lands, and
 * report every show operator.
 */
export function shownText(bytes: Uint8Array, tokens: Token[]): ShownText[] {
  const out: ShownText[] = [];
  const stack: State[] = [];
  let s = fresh();
  let ordinal = 0;

  /** Operands since the last operator, as token indices. */
  let operands: number[] = [];
  const num = (i: number) => Number(latin1(bytes, tokens[i].start, tokens[i].end));

  const place = (tokenIndex: number, stringTokens: number[]) => {
    // Text space -> page space. Only the translation is needed for the origin.
    const trm = multiply(
      [s.size * s.hscale, 0, 0, s.size, 0, s.rise],
      multiply(s.tm, s.ctm),
    );
    out.push({
      ordinal: ordinal++,
      tokenIndex,
      stringTokens,
      text: stringTokens
        .map((i) => decodeStringToken(bytes, tokens[i]))
        .join(""),
      x: trm[4],
      y: trm[5],
      font: s.font,
      size: s.size,
    });
  };

  const nextLine = (tx: number, ty: number) => {
    s.tlm = multiply([1, 0, 0, 1, tx, ty], s.tlm);
    s.tm = [...s.tlm] as Matrix;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "whitespace" || token.kind === "comment") continue;

    if (token.kind !== "operator") {
      operands.push(i);
      continue;
    }

    const args = operands;
    operands = [];
    const strings = args.filter(
      (a) => tokens[a].kind === "string" || tokens[a].kind === "hexstring",
    );

    switch (token.op) {
      case "q":
        stack.push({ ...s, ctm: [...s.ctm] as Matrix });
        break;
      case "Q": {
        const popped = stack.pop();
        if (popped) s = popped;
        break;
      }
      case "cm":
        if (args.length >= 6) {
          s.ctm = multiply(args.slice(-6).map(num) as Matrix, s.ctm);
        }
        break;
      case "BT":
        s.tm = [...IDENTITY] as Matrix;
        s.tlm = [...IDENTITY] as Matrix;
        break;
      case "Tf":
        if (args.length >= 2) {
          s.font = latin1(bytes, tokens[args[args.length - 2]].start, tokens[args[args.length - 2]].end);
          s.size = num(args[args.length - 1]);
        }
        break;
      case "Td":
        if (args.length >= 2) nextLine(num(args[args.length - 2]), num(args[args.length - 1]));
        break;
      case "TD":
        if (args.length >= 2) {
          s.leading = -num(args[args.length - 1]);
          nextLine(num(args[args.length - 2]), num(args[args.length - 1]));
        }
        break;
      case "Tm":
        if (args.length >= 6) {
          s.tlm = args.slice(-6).map(num) as Matrix;
          s.tm = [...s.tlm] as Matrix;
        }
        break;
      case "T*":
        nextLine(0, -s.leading);
        break;
      case "TL":
        if (args.length >= 1) s.leading = num(args[args.length - 1]);
        break;
      case "Ts":
        if (args.length >= 1) s.rise = num(args[args.length - 1]);
        break;
      case "Tz":
        if (args.length >= 1) s.hscale = num(args[args.length - 1]) / 100;
        break;
      case "Tj":
        place(i, strings);
        break;
      case "TJ":
        // The array mixes strings with kerning numbers; only the strings show.
        place(i, strings);
        break;
      case "'":
        nextLine(0, -s.leading);
        place(i, strings);
        break;
      case '"':
        nextLine(0, -s.leading);
        place(i, strings);
        break;
      default:
        break;
    }
  }

  return out;
}

/** Literal or hex string token to its bytes, as latin-1. */
function decodeStringToken(bytes: Uint8Array, token: Token): string {
  if (token.kind === "hexstring") {
    const hex = latin1(bytes, token.start + 1, token.end - 1).replace(/[^0-9a-fA-F]/g, "");
    let out = "";
    for (let i = 0; i + 1 < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    return out;
  }

  const raw = latin1(bytes, token.start + 1, token.end - 1);
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "\\") {
      out += raw[i];
      continue;
    }
    const next = raw[++i];
    const simple: Record<string, string> = {
      n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\",
    };
    if (next in simple) out += simple[next];
    else if (next >= "0" && next <= "7") {
      let oct = next;
      while (oct.length < 3 && raw[i + 1] >= "0" && raw[i + 1] <= "7") oct += raw[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else out += next ?? "";
  }
  return out;
}
