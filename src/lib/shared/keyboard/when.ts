/**
 * The `when` clause of a keybinding: a boolean expression over context keys.
 *
 * Hand-written rather than a dependency or `new Function`, for two reasons that
 * are both hard requirements here. A rule is user data, so evaluating it as
 * JavaScript would make the settings blob an execution channel, and that blob
 * arrives from a remote boite over a socket. And an unknown key has to read as
 * `false` rather than throw, which is the opposite of what a reference to an
 * undeclared identifier does.
 */

export type WhenNode =
  | { t: "lit"; v: boolean }
  | { t: "key"; name: string }
  | { t: "not"; e: WhenNode }
  | { t: "and"; l: WhenNode; r: WhenNode }
  | { t: "or"; l: WhenNode; r: WhenNode };

export type KeyContext = Record<string, boolean>;

type Token =
  | { t: "and" }
  | { t: "or" }
  | { t: "not" }
  | { t: "(" }
  | { t: ")" }
  | { t: "id"; name: string };

const ID_START = /[A-Za-z_]/;
const ID_REST = /[A-Za-z0-9_.]/;

function tokenize(src: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
    } else if (c === "&" && src[i + 1] === "&") {
      out.push({ t: "and" });
      i += 2;
    } else if (c === "|" && src[i + 1] === "|") {
      out.push({ t: "or" });
      i += 2;
    } else if (c === "!") {
      out.push({ t: "not" });
      i += 1;
    } else if (c === "(") {
      out.push({ t: "(" });
      i += 1;
    } else if (c === ")") {
      out.push({ t: ")" });
      i += 1;
    } else if (ID_START.test(c)) {
      let j = i + 1;
      while (j < src.length && ID_REST.test(src[j])) j += 1;
      out.push({ t: "id", name: src.slice(i, j) });
      i = j;
    } else {
      return null;
    }
  }
  return out;
}

/**
 * Parse a `when` clause. Returns `null` on a syntax error rather than throwing:
 * one malformed rule in the user's set must not take the whole keyboard down,
 * and the settings editor renders the null as "this rule never matches".
 *
 * An empty clause is `true` — a rule with no condition is live everywhere.
 */
export function parseWhen(src: string | undefined | null): WhenNode | null {
  if (src === undefined || src === null || src.trim() === "") {
    return { t: "lit", v: true };
  }
  const tokens = tokenize(src);
  if (!tokens) return null;

  let at = 0;
  const peek = () => tokens[at];

  function parseOr(): WhenNode | null {
    let left = parseAnd();
    if (!left) return null;
    while (peek()?.t === "or") {
      at += 1;
      const right = parseAnd();
      if (!right) return null;
      left = { t: "or", l: left, r: right };
    }
    return left;
  }

  function parseAnd(): WhenNode | null {
    let left = parseUnary();
    if (!left) return null;
    while (peek()?.t === "and") {
      at += 1;
      const right = parseUnary();
      if (!right) return null;
      left = { t: "and", l: left, r: right };
    }
    return left;
  }

  function parseUnary(): WhenNode | null {
    if (peek()?.t === "not") {
      at += 1;
      const inner = parseUnary();
      return inner ? { t: "not", e: inner } : null;
    }
    return parsePrimary();
  }

  function parsePrimary(): WhenNode | null {
    const tok = peek();
    if (!tok) return null;
    if (tok.t === "(") {
      at += 1;
      const inner = parseOr();
      if (!inner) return null;
      if (peek()?.t !== ")") return null;
      at += 1;
      return inner;
    }
    if (tok.t === "id") {
      at += 1;
      if (tok.name === "true") return { t: "lit", v: true };
      if (tok.name === "false") return { t: "lit", v: false };
      return { t: "key", name: tok.name };
    }
    return null;
  }

  const node = parseOr();
  if (!node || at !== tokens.length) return null;
  return node;
}

export function evaluateWhen(node: WhenNode, ctx: KeyContext): boolean {
  switch (node.t) {
    case "lit":
      return node.v;
    case "key":
      return ctx[node.name] === true;
    case "not":
      return !evaluateWhen(node.e, ctx);
    case "and":
      return evaluateWhen(node.l, ctx) && evaluateWhen(node.r, ctx);
    case "or":
      return evaluateWhen(node.l, ctx) || evaluateWhen(node.r, ctx);
  }
}

/**
 * A clause turned into a predicate, once. The dispatcher runs on every
 * keystroke including the ones the terminal is about to receive, so nothing
 * here may happen per event.
 *
 * A clause that does not parse compiles to a predicate that is never true. The
 * alternative — treating it as `true` — would give a typo a shortcut that fires
 * everywhere, which is the more expensive way to be wrong.
 */
export function compileWhen(src: string | undefined | null): {
  ok: boolean;
  test: (ctx: KeyContext) => boolean;
} {
  const node = parseWhen(src);
  if (!node) return { ok: false, test: () => false };
  return { ok: true, test: (ctx) => evaluateWhen(node, ctx) };
}

export function whenKeys(node: WhenNode, into = new Set<string>()): Set<string> {
  switch (node.t) {
    case "key":
      into.add(node.name);
      break;
    case "not":
      whenKeys(node.e, into);
      break;
    case "and":
    case "or":
      whenKeys(node.l, into);
      whenKeys(node.r, into);
      break;
    case "lit":
      break;
  }
  return into;
}

// Above this many distinct keys the truth table below stops being cheap. Two
// clauses that wide are assumed to overlap, which only ever over-reports a
// conflict in the settings editor.
const OVERLAP_KEY_CEILING = 14;

/**
 * Whether two clauses can be true at the same time — the question the conflict
 * list is actually asking, since two rules on one key only fight where their
 * conditions meet.
 *
 * Exact for boolean expressions: every key either appears in one of the two
 * clauses or is irrelevant to both, so walking the truth table over the union
 * decides it.
 */
export function whenOverlaps(a: string | undefined, b: string | undefined): boolean {
  const na = parseWhen(a);
  const nb = parseWhen(b);
  if (!na || !nb) return false;
  const keys = [...whenKeys(na, whenKeys(nb))];
  if (keys.length > OVERLAP_KEY_CEILING) return true;
  const total = 1 << keys.length;
  for (let mask = 0; mask < total; mask += 1) {
    const ctx: KeyContext = {};
    for (let k = 0; k < keys.length; k += 1) ctx[keys[k]] = (mask & (1 << k)) !== 0;
    if (evaluateWhen(na, ctx) && evaluateWhen(nb, ctx)) return true;
  }
  return false;
}
