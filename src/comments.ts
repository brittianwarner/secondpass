/**
 * Comment detection for the scan stage.
 *
 * Half the scan stage's false positives came from one source: a matcher
 * firing on vulnerable-looking code quoted inside a comment. The warning
 * comment above a hardened call site is, by construction, written in the
 * exact vocabulary the matcher hunts for:
 *
 *   // Never do: db.query("SELECT * FROM t WHERE id = " + id)
 *   const row = await db.query(SAFE_SQL, [id]);
 *
 * That's not a vulnerability, it's a colleague being helpful. Measured on
 * a 96-case labeled corpus, comment contamination accounted for 9 of 18
 * false positives — every affected family at once.
 *
 * WHY A LEXER AND NOT A REGEX: `content.replace(/\/\/.*$/gm, "")` is the
 * obvious approach and it is wrong. It eats the tail of every line holding
 * a `//` inside a string — `"https://example.com"`, an S3 URL, a regex
 * literal — and blanking real code causes FALSE NEGATIVES, which this
 * stage can never recover. So we track string, template, and regex-literal
 * state properly.
 *
 * CONSERVATIVE BY CONSTRUCTION: every ambiguous case resolves to "not a
 * comment". A missed comment costs one false positive that adjudication
 * then filters — cheap, and visible. A comment claimed over live code
 * silently deletes a real finding — expensive, and invisible forever. The
 * asymmetry is the whole design.
 */

/** A half-open `[start, end)` span of source text, in character offsets. */
export interface CommentRange {
  start: number;
  end: number;
}

/**
 * The non-code regions of a source file.
 *
 * `strings` covers quoted and template-literal TEXT only — a template's
 * `${...}` interpolations are live code and are deliberately excluded, so
 * `` `user=${req.query.id}` `` reports the `user=` text as string while
 * leaving `req.query.id` matchable.
 */
export interface LiteralRanges {
  comments: CommentRange[];
  strings: CommentRange[];
}

/**
 * Characters after which a `/` begins a REGEX LITERAL rather than a
 * division. After a value — an identifier, a digit, `)`, `]` — a slash
 * divides. Everywhere else it opens a pattern.
 *
 * Deliberately incomplete: anything not listed falls through to "treat as
 * an ordinary character", which is the safe direction.
 */
const REGEX_MAY_FOLLOW = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", "\n",
]);

/** `return /re/`, `typeof /re/` — keyword positions where a slash is a pattern. */
const REGEX_MAY_FOLLOW_KEYWORD = /\b(?:return|typeof|instanceof|in|of|case|do|else|yield|await|delete|void|throw|new)$/;

/**
 * Locate every comment in a JS/TS source, skipping over string literals,
 * template literals (including `${...}` interpolations, which contain real
 * code and can hold real comments), and regex literals.
 *
 * Returns ranges sorted by `start` and non-overlapping.
 */
export function findCommentRanges(source: string): CommentRange[] {
  return findLiteralRanges(source).comments;
}

/**
 * Locate every comment AND every string-literal text span in one pass.
 *
 * Same conservative contract as {@link findCommentRanges}: anything the
 * lexer cannot confidently classify stays code, because misreading code
 * as a literal silently deletes findings.
 */
export function findLiteralRanges(source: string): LiteralRanges {
  const ranges: CommentRange[] = [];
  const strings: CommentRange[] = [];
  const n = source.length;

  // Depth of `${...}` interpolation. Non-empty means a `` ` `` we hit
  // closes an interpolation's template rather than opening a new one.
  const templateBraceDepth: number[] = [];

  // The last non-whitespace character of actual code, used only to decide
  // whether a `/` opens a regex literal. Comments do not update it — a
  // comment must not change how the code after it parses.
  let lastSignificant = "\n";
  // Rolling tail of recent identifier characters, for the keyword test.
  let identTail = "";

  let i = 0;
  while (i < n) {
    const c = source[i]!;

    // --- string literal -------------------------------------------------
    if (c === '"' || c === "'") {
      const from = i;
      i = skipQuoted(source, i, c);
      // Interior only — the delimiters stay "code" so a matcher anchored
      // on the quote itself still works.
      if (i - from > 2) strings.push({ start: from + 1, end: i - 1 });
      lastSignificant = c;
      identTail = "";
      continue;
    }

    // --- template literal -----------------------------------------------
    if (c === "`") {
      i += 1;
      let textFrom = i;
      let closed = false;
      while (i < n) {
        const t = source[i]!;
        if (t === "\\") {
          i += 2;
          continue;
        }
        if (t === "`") {
          if (i > textFrom) strings.push({ start: textFrom, end: i });
          i += 1;
          closed = true;
          break;
        }
        if (t === "$" && source[i + 1] === "{") {
          if (i > textFrom) strings.push({ start: textFrom, end: i });
          // Enter interpolation: hand control back to the main loop so
          // comments and nested templates inside `${...}` are seen.
          templateBraceDepth.push(0);
          i += 2;
          break;
        }
        i += 1;
      }
      if (closed || i >= n) {
        lastSignificant = "`";
        identTail = "";
      }
      continue;
    }

    // --- inside an interpolation: track braces to find its end ----------
    if (templateBraceDepth.length > 0) {
      if (c === "{") {
        templateBraceDepth[templateBraceDepth.length - 1]! += 1;
      } else if (c === "}") {
        const depth = templateBraceDepth[templateBraceDepth.length - 1]!;
        if (depth === 0) {
          // Closing `}` of `${...}` — resume the enclosing template body.
          templateBraceDepth.pop();
          i = resumeTemplateBody(source, i + 1, templateBraceDepth, strings);
          lastSignificant = "`";
          identTail = "";
          continue;
        }
        templateBraceDepth[templateBraceDepth.length - 1] = depth - 1;
      }
    }

    // --- line comment ----------------------------------------------------
    if (c === "/" && source[i + 1] === "/") {
      const start = i;
      while (i < n && source[i] !== "\n") i += 1;
      ranges.push({ start, end: i });
      continue;
    }

    // --- block comment ---------------------------------------------------
    if (c === "/" && source[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i = Math.min(i + 2, n);
      ranges.push({ start, end: i });
      continue;
    }

    // --- regex literal ----------------------------------------------------
    // Checked AFTER `//` and `/*` on purpose: an empty regex `//` is not
    // legal JS, so a doubled slash is always a comment.
    if (c === "/" && regexMayStartHere(lastSignificant, identTail)) {
      const after = skipRegexLiteral(source, i);
      if (after > i) {
        i = after;
        lastSignificant = "/";
        identTail = "";
        continue;
      }
      // Unterminated — fall through and treat as an ordinary character
      // rather than swallowing the rest of the file.
    }

    if (!isWhitespace(c)) {
      lastSignificant = c;
      identTail = /[A-Za-z0-9_$]/.test(c) ? (identTail + c).slice(-12) : "";
    }
    i += 1;
  }

  strings.sort((a, b) => a.start - b.start);
  return { comments: ranges, strings };
}

/**
 * True when `offset` falls inside a comment.
 *
 * `ranges` must be sorted by `start` (as {@link findCommentRanges} returns
 * them); the lookup is a binary search, so this stays cheap when called
 * once per regex match on a large file.
 */
export function isInsideComment(ranges: readonly CommentRange[], offset: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = ranges[mid]!;
    if (offset < range.start) hi = mid - 1;
    else if (offset >= range.end) lo = mid + 1;
    else return true;
  }
  return false;
}

function isWhitespace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
}

function regexMayStartHere(lastSignificant: string, identTail: string): boolean {
  if (REGEX_MAY_FOLLOW.has(lastSignificant)) return true;
  return identTail.length > 0 && REGEX_MAY_FOLLOW_KEYWORD.test(identTail);
}

/** Advance past a `'...'` / `"..."` literal. Stops at an unescaped newline. */
function skipQuoted(source: string, start: number, quote: string): number {
  let i = start + 1;
  const n = source.length;
  while (i < n) {
    const c = source[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    // An unterminated literal is a syntax error upstream; bail at the line
    // end so one stray quote can't reinterpret the rest of the file.
    if (c === "\n") return i;
    i += 1;
  }
  return n;
}

/**
 * Advance past a `/.../flags` literal, honoring escapes and character
 * classes (a `/` inside `[...]` does not close the pattern).
 *
 * Returns `start` unchanged if the literal never terminates on this line,
 * which the caller reads as "not actually a regex".
 */
function skipRegexLiteral(source: string, start: number): number {
  let i = start + 1;
  const n = source.length;
  let inClass = false;
  while (i < n) {
    const c = source[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "\n") return start;
    if (inClass) {
      if (c === "]") inClass = false;
    } else if (c === "[") {
      inClass = true;
    } else if (c === "/") {
      i += 1;
      while (i < n && /[a-z]/i.test(source[i]!)) i += 1;
      return i;
    }
    i += 1;
  }
  return start;
}

/**
 * After an interpolation's closing `}`, scan the template body again until
 * the closing backtick or the next `${`.
 */
function resumeTemplateBody(
  source: string,
  start: number,
  templateBraceDepth: number[],
  strings: CommentRange[],
): number {
  let i = start;
  const n = source.length;
  while (i < n) {
    const c = source[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") {
      if (i > start) strings.push({ start, end: i });
      return i + 1;
    }
    if (c === "$" && source[i + 1] === "{") {
      if (i > start) strings.push({ start, end: i });
      templateBraceDepth.push(0);
      return i + 2;
    }
    i += 1;
  }
  if (n > start) strings.push({ start, end: n });
  return n;
}
