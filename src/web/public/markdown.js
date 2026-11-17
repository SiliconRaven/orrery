// Markdown for chat messages: text in, a plain data structure out. No DOM and no HTML strings, so it runs in node and
// the page can only turn the result into text nodes and attributes. Message bodies come from agents and are untrusted.
//
// Blocks:  { type: 'p', inlines } | { type: 'h', level, inlines } | { type: 'code', lang, text } | { type: 'hr' }
//          { type: 'ul', items: Block[][] } | { type: 'ol', start, items } | { type: 'quote', blocks }
//          { type: 'table', align: ('left'|'center'|'right'|null)[], head: Inline[][], rows: Inline[][][] }
// Inlines: string | { type: 'code', text } | { type: 'strong'|'em'|'del', children } | { type: 'link', href, children }
//
// Deliberately absent: images (a URL in a message is never loaded), HTML, setext headings, indented code, task lists,
// footnotes, and _em_ (underscores are common in snake_case).
//
// Runtime stays linear in the text: every line and every inline token is visited a bounded number of times, and
// nesting is capped. Regexes here are anchored or simple scans; an unanchored `[ \t]+$` would be quadratic on long
// runs of spaces.

const MAX_TEXT = 100_000;
const MAX_BLOCK_DEPTH = 8;
const MAX_INLINE_DEPTH = 4;
const MAX_URL = 2048;

/** A block's inline text in one string, code as blanks: quotes can span emphasis and code, which split it into nodes. */
export const inlineText = (nodes) => nodes.map((n) => {
  if (typeof n === 'string') return n;
  return n.type === 'code' ? ' '.repeat(n.text.length) : inlineText(n.children);
}).join('');

/** The body as blocks. */
export function markdownBlocks(text) {
  // shortcut: a longer body is one paragraph of plain text, which also skips highlighting and links; parse it (maybe in chunks) if real messages get that long.
  if (text.length > MAX_TEXT) return [{ type: 'p', inlines: [text] }];
  return blocks(text.replace(/\r\n?/g, '\n').split('\n'), 0);
}

// ---- blocks ----

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])( +|\t|$)/;
const DELIMITER_CELL = /^:?-+:?$/;

const isBlank = (line) => line.trim() === '';

/** Columns of leading whitespace; a tab counts as 4. */
function indentOf(line) {
  let col = 0;
  for (const c of /^[ \t]*/.exec(line)[0]) col += c === '\t' ? 4 : 1;
  return col;
}

/** The line without up to `n` columns of leading whitespace. */
function dedent(line, n) {
  let col = 0;
  let i = 0;
  while (col < n && (line[i] === ' ' || line[i] === '\t')) col += line[i++] === '\t' ? 4 : 1;
  return line.slice(i);
}

/** A fence opening, or null. A backtick fence's info string has no backticks, so ```` ```x``` ```` stays inline code. */
function fenceOf(line) {
  const m = FENCE.exec(line);
  if (!m || (m[1][0] === '`' && m[2].includes('`'))) return null;
  return { marker: m[1], info: m[2], indent: indentOf(line) };
}

function isClosingFence(line, marker) {
  const t = line.trim();
  if (indentOf(line) > 3 || t.length < marker.length) return false;
  for (const c of t) if (c !== marker[0]) return false;
  return true;
}

function isHr(line) {
  if (indentOf(line) > 3) return false;
  const t = line.replace(/[ \t]/g, '');
  return /^(?:-{3,}|\*{3,}|_{3,})$/.test(t);
}

/** Table row → cell texts. `\|` is a literal pipe; the outer pipes are optional. */
function splitRow(line) {
  const s = line.trim();
  const cells = [];
  let cur = '';
  let open = true;   // false right after a `|` that may turn out to be the closing one
  for (let i = s[0] === '|' ? 1 : 0; i < s.length; i++) {
    open = true;
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; }
    else if (s[i] === '|') { cells.push(cur); cur = ''; open = false; }
    else cur += s[i];
  }
  if (open) cells.push(cur);
  return cells.map((c) => c.trim());
}

/** The alignments of a delimiter row with `count` columns, or null if it is not one. */
function tableAlign(line, count) {
  if (line === undefined || !/^[ \t|:-]+$/.test(line) || !line.includes('-')) return null;
  const cells = splitRow(line);
  if (cells.length !== count || !cells.every((c) => DELIMITER_CELL.test(c))) return null;
  return cells.map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    return right ? 'right' : left ? 'left' : null;
  });
}

const startsTable = (lines, i) => lines[i].includes('|') && tableAlign(lines[i + 1], splitRow(lines[i]).length) !== null;

/** Whether the line can cut a paragraph short. As in CommonMark, a list only does when it has content and an ordered one starts at 1. */
function interrupts(lines, i) {
  const line = lines[i];
  if (fenceOf(line) || HEADING.test(line) || QUOTE.test(line) || isHr(line) || startsTable(lines, i)) return true;
  const item = itemOf(line);
  return item !== null && !isBlank(item.text) && (item.start === undefined || item.start === 1);
}

function blocks(lines, depth) {
  if (depth >= MAX_BLOCK_DEPTH) return [{ type: 'p', inlines: inlines(lines.join('\n')) }];
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }

    const fence = fenceOf(line);
    if (fence) {
      const body = [];
      for (i++; i < lines.length && !isClosingFence(lines[i], fence.marker); i++) body.push(dedent(lines[i], fence.indent));
      i++;
      out.push({ type: 'code', lang: fence.info.trim().split(/\s+/)[0], text: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ type: 'h', level: heading[1].length, inlines: inlines(heading[2].trim()) });
      i++;
      continue;
    }

    if (isHr(line)) {   // before lists: `- - -` and `* * *` are rules
      out.push({ type: 'hr' });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) inner.push(lines[i].replace(QUOTE, ''));
      out.push({ type: 'quote', blocks: blocks(inner, depth + 1) });
      continue;
    }

    if (ITEM.test(line)) {
      const list = parseList(lines, i, depth);
      out.push(list.block);
      i = list.next;
      continue;
    }

    if (startsTable(lines, i)) {
      const table = parseTable(lines, i);
      out.push(table.block);
      i = table.next;
      continue;
    }

    const para = [line];
    for (i++; i < lines.length && !isBlank(lines[i]) && !interrupts(lines, i); i++) para.push(lines[i]);
    out.push({ type: 'p', inlines: inlines(para.join('\n')) });
  }
  return out;
}

function parseTable(lines, start) {
  const header = splitRow(lines[start]);
  const align = tableAlign(lines[start + 1], header.length);
  const rows = [];
  let i = start + 2;
  for (; i < lines.length && !isBlank(lines[i]) && !interrupts(lines, i); i++) {
    const cells = splitRow(lines[i]).slice(0, header.length);
    while (cells.length < header.length) cells.push('');
    rows.push(cells.map(inlines));
  }
  return { block: { type: 'table', align, head: header.map(inlines), rows }, next: i };
}

/** A list item line: its column, the column its content starts at, its text, its number, and which list it belongs to. */
function itemOf(line) {
  const m = ITEM.exec(line);
  if (!m) return null;
  const [all, , marker, gap] = m;
  const indent = indentOf(line);
  const rest = line.slice(all.length);
  // Five or more spaces are content: only one of them belongs to the marker.
  const wide = gap.length > 4;
  const columns = wide || isBlank(rest) ? 1 : gap === '\t' ? 4 : gap.length;
  return {
    indent,
    offset: indent + marker.length + columns,
    text: wide ? line.slice(all.length - gap.length + 1) : rest,
    start: marker.length > 1 ? Number(marker.slice(0, -1)) : undefined,
    key: marker.at(-1),
  };
}

/** The list starting at lines[start]. Item content is dedented and parsed on its own, which is what nests. */
function parseList(lines, start, depth) {
  const first = itemOf(lines[start]);
  const items = [];
  let i = start;
  for (;;) {
    const item = itemOf(lines[i]);
    const content = [item.text];
    for (i++; i < lines.length; i++) {
      const line = lines[i];
      if (isBlank(line)) {
        let next = i + 1;
        while (next < lines.length && isBlank(lines[next])) next++;
        if (next === lines.length || indentOf(lines[next]) < item.offset) break;
        for (; i < next - 1; i++) content.push('');
        content.push('');
      } else if (indentOf(line) >= item.offset) content.push(dedent(line, item.offset));
      else if (ITEM.test(line)) {
        if (indentOf(line) < item.indent + 2) break;
        content.push(dedent(line, item.offset));   // nested, indented less than the marker's width (`1. a` then `  - b`)
      } else if (interrupts(lines, i)) break;
      else content.push(line);                     // lazy continuation
    }
    items.push(blocks(content, depth + 1));

    let next = i;
    while (next < lines.length && isBlank(lines[next])) next++;
    if (next === lines.length || itemOf(lines[next])?.key !== first.key || isHr(lines[next])) break;
    i = next;
  }
  const block = first.start === undefined ? { type: 'ul', items } : { type: 'ol', start: Number(first.start), items };
  return { block, next: i };
}

// ---- inlines: one pass into flat tokens (`[…](…)` resolved on the way), then emphasis pairs are matched with stacks ----

// Only what means something in a chat message: `\.`, `\_`, `\-` and `\\` are everyday Windows paths, not escapes.
const ESCAPABLE = /^[*`~[\]#>|]$/;
const ALNUM = /^[A-Za-z0-9]$/;
const isSpace = (c) => c === undefined || /\s/.test(c);
const EMPHASIS = { '*': 'em', '**': 'strong', '~~': 'del' };

function inlines(text) {
  return tree(tokenize(text), 0);
}

/** Backtick runs by length, each with a cursor: scanning only moves forward, so finding a closer never rescans. */
function backtickRuns(text) {
  const runs = new Map();
  for (const m of text.matchAll(/`+/g)) {
    const len = m[0].length;
    if (!runs.has(len)) runs.set(len, { at: [], next: 0 });
    runs.get(len).at.push(m.index);
  }
  return (len, from) => {
    const run = runs.get(len);
    while (run.next < run.at.length && run.at[run.next] < from) run.next++;
    return run.at[run.next] ?? -1;
  };
}

/** CommonMark's one trim: `` `a` `` shows `a`, while a span of only spaces stays as it is. */
function codeText(s) {
  return s.length > 1 && s[0] === ' ' && s.at(-1) === ' ' && s.trim() !== '' ? s.slice(1, -1) : s;
}

/**
 * Tokens for a `*` or `~` run. Rules made for Chinese text rather than CommonMark's flanking: an opener is not followed
 * by whitespace, a closer does not follow it, and a single `*` does not open right after a letter or digit (`2*3*4`).
 * Runs that mean nothing (`****`, `~`) are text.
 */
function delimiters(run, prev, next) {
  if (run[0] === '~' ? run.length !== 2 : run.length > 3) return [run];
  const open = !isSpace(next);
  const close = !isSpace(prev);
  const token = (delim) => ({ delim, open: open && (delim !== '*' || !ALNUM.test(prev ?? '')), close });
  if (run.length < 3) return [token(run)];
  return open ? [token('**'), token('*')] : [token('*'), token('**')];
}

/** The normalized URL if `raw` is an absolute http(s) URL, else null. Nothing else ever becomes a link. */
function httpUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** `(url)` at `start`, inner parens balanced: { url, end } with `end` just past the `)`, or null. */
function destination(text, start) {
  let depth = 0;
  const stop = Math.min(text.length, start + MAX_URL);
  for (let i = start; i < stop; i++) {
    const c = text[i];
    if (c <= ' ') return null;
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return { url: text.slice(start + 1, i), end: i + 1 };
  }
  return null;
}

/** How much of a bare URL is the URL: sentence punctuation is not, and a `)` is only if it closes a `(` inside. */
function urlLength(raw) {
  let extra = raw.split(')').length - raw.split('(').length;
  let end = raw.length;
  while (end > 0) {
    const c = raw[end - 1];
    if (c === ')' && extra > 0) extra--;
    else if (!".,;:!?'~_".includes(c)) break;
    end--;
  }
  return end;
}

function tokenize(text) {
  const tokens = [];
  const brackets = [];   // unclosed `[`: { index: in tokens, start: in text }
  const nextRun = text.includes('`') ? backtickRuns(text) : null;
  const special = /\\|`+|\*+|~+|!?\[|\]|https?:\/\//gi;
  const bareUrl = /https?:\/\/[A-Za-z0-9\-._~:/?#@!$&'()+,;=%]+/iy;
  let pos = 0;
  for (let m = special.exec(text); m; m = special.exec(text)) {
    const at = m.index;
    const s = m[0];
    let end = at + s.length;
    if (at > pos) tokens.push(text.slice(pos, at));

    if (s === '\\') {
      if (ESCAPABLE.test(text[end] ?? '')) tokens.push(text[end++]);
      else tokens.push(s);
    } else if (s[0] === '`') {
      const close = nextRun(s.length, end);
      if (close < 0) tokens.push(s);
      else {
        tokens.push({ code: codeText(text.slice(end, close)) });
        end = close + s.length;
      }
    } else if (s[0] === '*' || s[0] === '~') {
      tokens.push(...delimiters(s, text[at - 1], text[end]));
    } else if (s.endsWith('[')) {
      brackets.push({ index: tokens.length, start: at });
      tokens.push(s);
    } else if (s === ']') {
      const open = brackets.pop();
      const dest = open && text[end] === '(' ? destination(text, end) : null;
      if (!dest) tokens.push(s);
      else {
        const raw = text.slice(open.start, dest.end);
        const href = httpUrl(dest.url);
        const label = tokens.splice(open.index).slice(1).map((t) => (t.auto ? t.raw : t));   // an <a> cannot hold an <a>
        // An image is a link here too: `![alt](url)` loads nothing. A scheme we refuse leaves the source text as it was.
        tokens.push(href ? { link: href, raw, tokens: label.length ? label : [href] } : raw);
        end = dest.end;
        if (href) brackets.length = 0;   // links do not nest, so an earlier `[` is plain text
      }
    } else {
      bareUrl.lastIndex = at;
      const raw = bareUrl.exec(text)?.[0] ?? s;
      const url = raw.slice(0, urlLength(raw));
      const href = ALNUM.test(text[at - 1] ?? '') ? null : httpUrl(url);
      if (href) tokens.push({ link: href, raw: url, auto: true, tokens: [url] });
      else tokens.push(url);
      end = at + url.length;
    }
    pos = special.lastIndex = end;
  }
  if (pos < text.length) tokens.push(text.slice(pos));
  return tokens;
}

/** Pairs up delimiters: on each match, `mate` holds the other token's index. Each token is pushed and popped at most once. */
function matchDelimiters(tokens) {
  const open = { '*': [], '**': [], '~~': [] };
  tokens.forEach((t, i) => {
    if (!t.delim) return;
    const stack = open[t.delim];
    if (t.close && stack.length) {
      const o = stack.pop();
      for (const s of Object.values(open)) while (s.at(-1) > o) s.pop();   // pairs do not cross
      tokens[o].mate = i;
      t.mate = o;
    } else if (t.open) stack.push(i);
  });
}

/** Tokens → inline nodes. Anything nested deeper than MAX_INLINE_DEPTH stays as its source text. */
function tree(tokens, depth) {
  matchDelimiters(tokens);
  const out = [];
  const path = [out];   // child lists of the nodes now open, innermost last
  const add = (node) => {
    const list = path.at(-1);
    if (typeof node === 'string' && typeof list.at(-1) === 'string') list[list.length - 1] += node;
    else list.push(node);
  };
  tokens.forEach((t, i) => {
    const level = depth + path.length - 1;
    const tooDeep = level >= MAX_INLINE_DEPTH;
    if (typeof t === 'string') add(t);
    else if (t.code !== undefined) add({ type: 'code', text: t.code });
    else if (t.link) add(tooDeep ? t.raw : { type: 'link', href: t.link, children: tree(t.tokens, level + 1) });
    else if (t.mate > i && !tooDeep) {
      const node = { type: EMPHASIS[t.delim], children: [] };
      add(node);
      path.push(node.children);
      t.live = true;
    } else if (t.mate < i && tokens[t.mate].live) path.pop();
    else add(t.delim);
  });
  return out;
}
