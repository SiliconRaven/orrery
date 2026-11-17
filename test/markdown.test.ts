// src/web/public/markdown.js, run in node. Message bodies are untrusted: besides the syntax, these pin down that only
// http(s) links exist, that nothing loads, and that odd input stays cheap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/main.ts';

const publicDir = join(REPO_ROOT, 'src', 'web', 'public');
// A browser module without types: a computed specifier keeps tsc from looking for declarations.
const { markdownBlocks } = await import(pathToFileURL(join(publicDir, 'markdown.js')).href);

/** The inline nodes of a body that is one paragraph. */
function inline(text: string) {
  const blocks = markdownBlocks(text);
  assert.equal(blocks.length, 1, `one block: ${JSON.stringify(blocks)}`);
  assert.equal(blocks[0].type, 'p');
  return blocks[0].inlines;
}
const para = (...inlines: unknown[]) => ({ type: 'p', inlines });
const strong = (...children: unknown[]) => ({ type: 'strong', children });
const em = (...children: unknown[]) => ({ type: 'em', children });
const del = (...children: unknown[]) => ({ type: 'del', children });
const link = (href: string, ...children: unknown[]) => ({ type: 'link', href, children });
const code = (text: string) => ({ type: 'code', text });

test('markdown: plain text stays one paragraph, single newlines and leading spaces included', () => {
  assert.deepEqual(markdownBlocks('第一行\n  第二行'), [para('第一行\n  第二行')]);
  assert.deepEqual(markdownBlocks('a\r\nb\rc'), [para('a\nb\nc')]);
  assert.deepEqual(markdownBlocks('段一\n\n\n段二'), [para('段一'), para('段二')]);
  assert.deepEqual(markdownBlocks(''), []);
  assert.deepEqual(markdownBlocks('   \n\n'), []);
  assert.deepEqual(inline('1.5 倍，-1 度，#标签，a|b，snake_case_name，_x_'), ['1.5 倍，-1 度，#标签，a|b，snake_case_name，_x_']);
});

test('markdown: headings are # to ###### with a space; setext is not a heading', () => {
  assert.deepEqual(markdownBlocks('# 一\n###### 六\n####### 七\n#无空格'), [
    { type: 'h', level: 1, inlines: ['一'] },
    { type: 'h', level: 6, inlines: ['六'] },
    para('####### 七\n#无空格'),
  ]);
  assert.deepEqual(markdownBlocks('## **粗**'), [{ type: 'h', level: 2, inlines: [strong('粗')] }]);
  assert.deepEqual(markdownBlocks('标题\n==='), [para('标题\n===')]);
  assert.deepEqual(markdownBlocks('标题\n---'), [para('标题'), { type: 'hr' }]);
});

test('markdown: fences keep their text raw, carry lang, and run to the end when unclosed', () => {
  assert.deepEqual(markdownBlocks('```js title\nconst a = `*b*`;\n\n<script>\n```\n后文'), [
    { type: 'code', lang: 'js', text: 'const a = `*b*`;\n\n<script>' },
    para('后文'),
  ]);
  assert.deepEqual(markdownBlocks('~~~\na\n```\n~~~'), [{ type: 'code', lang: '', text: 'a\n```' }]);
  assert.deepEqual(markdownBlocks('````\n```\nx\n```\n````'), [{ type: 'code', lang: '', text: '```\nx\n```' }]);
  assert.deepEqual(markdownBlocks('```py\n没有闭合\n# 也不是标题'), [{ type: 'code', lang: 'py', text: '没有闭合\n# 也不是标题' }]);
  assert.deepEqual(markdownBlocks('```x``` 行内'), [para(code('x'), ' 行内')]);
  assert.deepEqual(markdownBlocks('  ```\n    a\n  b\n  ```'), [{ type: 'code', lang: '', text: '  a\nb' }]);
});

test('markdown: rules, not lists', () => {
  for (const s of ['---', '***', '___', '- - -', '* * *', '-----']) assert.deepEqual(markdownBlocks(s), [{ type: 'hr' }], s);
  assert.deepEqual(markdownBlocks('--'), [para('--')]);
});

test('markdown: lists, with numbering, nesting and items of several blocks', () => {
  assert.deepEqual(markdownBlocks('- a\n- **b**'), [{ type: 'ul', items: [[para('a')], [para(strong('b'))]] }]);
  assert.deepEqual(markdownBlocks('3. a\n4) b'), [
    { type: 'ol', start: 3, items: [[para('a')]] },
    { type: 'ol', start: 4, items: [[para('b')]] },
  ]);
  assert.deepEqual(markdownBlocks('- a\n  - b\n    - c\n- d'), [{
    type: 'ul',
    items: [
      [para('a'), { type: 'ul', items: [[para('b'), { type: 'ul', items: [[para('c')]] }]] }],
      [para('d')],
    ],
  }]);
  assert.deepEqual(markdownBlocks('- a\n\n  第二段\n\n- b'), [{ type: 'ul', items: [[para('a'), para('第二段')], [para('b')]] }]);
  assert.deepEqual(markdownBlocks('- a\n\n后文'), [{ type: 'ul', items: [[para('a')]] }, para('后文')]);
  // A common way to write it: two spaces under an ordered item, less than the marker's width.
  assert.deepEqual(markdownBlocks('1. a\n  - b\n2. c'), [{
    type: 'ol', start: 1, items: [[para('a'), { type: 'ul', items: [[para('b')]] }], [para('c')]],
  }]);
  assert.deepEqual(markdownBlocks('- a\n\t- b'), [{ type: 'ul', items: [[para('a'), { type: 'ul', items: [[para('b')]] }]] }]);
  assert.deepEqual(markdownBlocks('- a\n* b'), [
    { type: 'ul', items: [[para('a')]] },
    { type: 'ul', items: [[para('b')]] },
  ]);
  assert.deepEqual(markdownBlocks('- [ ] 不做任务列表'), [{ type: 'ul', items: [[para('[ ] 不做任务列表')]] }]);
});

test('markdown: list items take lazy lines and fences', () => {
  assert.deepEqual(markdownBlocks('- 第一行\n懒续行\n- b'), [{ type: 'ul', items: [[para('第一行\n懒续行')], [para('b')]] }]);
  assert.deepEqual(markdownBlocks('1. 步骤\n   ```sh\n   npm test\n\n   # 注释\n   ```\n2. 下一步'), [{
    type: 'ol',
    start: 1,
    items: [[para('步骤'), { type: 'code', lang: 'sh', text: 'npm test\n\n# 注释' }], [para('下一步')]],
  }]);
  assert.deepEqual(markdownBlocks('- ```\n  x'), [{ type: 'ul', items: [[{ type: 'code', lang: '', text: 'x' }]] }]);
});

test('markdown: a paragraph is cut by blocks, but not by an ordered item that does not start at 1', () => {
  assert.deepEqual(markdownBlocks('文字\n- a'), [para('文字'), { type: 'ul', items: [[para('a')]] }]);
  assert.deepEqual(markdownBlocks('文字\n1. a'), [para('文字'), { type: 'ol', start: 1, items: [[para('a')]] }]);
  assert.deepEqual(markdownBlocks('今年是\n2026. 年'), [para('今年是\n2026. 年')]);
  assert.deepEqual(markdownBlocks('文字\n-\n更多'), [para('文字\n-\n更多')]);
  assert.deepEqual(markdownBlocks('文字\n# 题\n> 引'), [para('文字'), { type: 'h', level: 1, inlines: ['题'] }, { type: 'quote', blocks: [para('引')] }]);
});

test('markdown: quotes nest and hold other blocks', () => {
  assert.deepEqual(markdownBlocks('> a\n> b\n>\n> - c\n后文'), [
    { type: 'quote', blocks: [para('a\nb'), { type: 'ul', items: [[para('c')]] }] },
    para('后文'),
  ]);
  assert.deepEqual(markdownBlocks('>>深'), [{ type: 'quote', blocks: [{ type: 'quote', blocks: [para('深')] }] }]);
});

test('markdown: tables align, unescape \\| and fit every row to the header', () => {
  const body = '| 名 | 值 | 备注 |\n|:--|--:|:-:|\n| `a` | **1** | x\\|y |\n| 少一格 | 2 |\n| 1 | 2 | 3 | 多 |\n后面也算一行\n\n段落';
  assert.deepEqual(markdownBlocks(body), [{
    type: 'table',
    align: ['left', 'right', 'center'],
    head: [['名'], ['值'], ['备注']],
    rows: [
      [[code('a')], [strong('1')], ['x|y']],
      [['少一格'], ['2'], []],
      [['1'], ['2'], ['3']],
      [['后面也算一行'], [], []],
    ],
  }, para('段落')]);
  assert.deepEqual(markdownBlocks('a | b\n--- | ---\n1 | 2')[0].align, [null, null]);
  assert.equal(markdownBlocks('前文\n| a |\n|---|')[1].type, 'table', 'cuts a paragraph');
  assert.deepEqual(markdownBlocks('| a | b |\n|---|'), [para('| a | b |\n|---|')], 'the delimiter row has the header\'s width');
  assert.deepEqual(markdownBlocks('| a |\n| b |'), [para('| a |\n| b |')]);
});

test('markdown: inline code holds its text raw', () => {
  assert.deepEqual(inline('用 `**x**` 和 `` a`b `` 和 `<b>`'), ['用 ', code('**x**'), ' 和 ', code('a`b'), ' 和 ', code('<b>')]);
  assert.deepEqual(inline('`C:\\Users\\example\\*`'), [code('C:\\Users\\example\\*')]);
  assert.deepEqual(inline('没闭合 ` 的反引号 ``'), ['没闭合 ` 的反引号 ``']);
  assert.deepEqual(inline('**a `**` b**'), [strong('a ', code('**'), ' b')], 'code wins over emphasis');
});

test('markdown: emphasis fits Chinese: only whitespace next to the delimiter stops it', () => {
  assert.deepEqual(inline('**“引用”**后文'), [strong('“引用”'), '后文']);
  assert.deepEqual(inline('前文**（括号）**后文'), ['前文', strong('（括号）'), '后文']);
  assert.deepEqual(inline('这是*斜体*文字'), ['这是', em('斜体'), '文字']);
  assert.deepEqual(inline('~~删除~~了'), [del('删除'), '了']);
  assert.deepEqual(inline('**粗 *斜* 粗**'), [strong('粗 ', em('斜'), ' 粗')]);
  assert.deepEqual(inline('***都有***'), [strong(em('都有'))]);
  assert.deepEqual(inline('**跨\n两行**'), [strong('跨\n两行')]);
  for (const s of ['** 不粗**', '**不粗 **', 'x * 不斜*', '*不斜 *', '~~ 不删~~', '~~不删 ~~', '**没闭合', '单个~波浪~线', 'x **** y', '*****x*****']) {
    assert.deepEqual(inline(s), [s], s);
  }
});

test('markdown: a single * after a letter or digit is arithmetic, not emphasis', () => {
  for (const s of ['2*3*4', '2 * 3 * 4', 'a*b*c', '5*x', 'glob *.ts and * js']) assert.deepEqual(inline(s), [s], s);
  assert.deepEqual(inline('**a**b**c'), [strong('a'), 'b**c']);
});

test('markdown: pairs do not cross', () => {
  assert.deepEqual(inline('**a *b** c*'), [strong('a *b'), ' c*']);
});

test('markdown: backslash escapes only Markdown syntax, so Windows paths survive', () => {
  assert.deepEqual(inline('\\*不斜\\* \\# \\[x\\](y) \\`'), ['*不斜* # [x](y) `']);
  assert.deepEqual(inline('C:\\Users\\example\\Documents'), ['C:\\Users\\example\\Documents']);
  assert.deepEqual(inline('C:\\Users\\example\\.claude\\_tmp\\-x'), ['C:\\Users\\example\\.claude\\_tmp\\-x']);
  assert.deepEqual(inline('\\\\server\\share'), ['\\\\server\\share']);
  assert.deepEqual(inline('末尾\\'), ['末尾\\']);
  assert.deepEqual(inline('\\中文'), ['\\中文']);
});

test('markdown: links are http(s) with the URL normalized', () => {
  assert.deepEqual(inline('[文档](https://example.com/a?b=1#c)'), [link('https://example.com/a?b=1#c', '文档')]);
  assert.deepEqual(inline('[大写](HTTP://EXAMPLE.com)'), [link('http://example.com/', '大写')]);
  assert.deepEqual(inline('[**粗** `码`](http://a.example/)'), [link('http://a.example/', strong('粗'), ' ', code('码'))]);
  assert.deepEqual(inline('[维基](https://a.example/F_(b))后'), [link('https://a.example/F_(b)', '维基'), '后']);
  assert.deepEqual(inline('**[粗链接](http://a.example/)**'), [strong(link('http://a.example/', '粗链接'))]);
  assert.deepEqual(inline('[](http://a.example/)'), [link('http://a.example/', 'http://a.example/')]);
  assert.deepEqual(inline('[外 [内](http://a.example/)]'), ['[外 ', link('http://a.example/', '内'), ']']);
  assert.deepEqual(inline('[https://a.example/](https://b.example/)'), [link('https://b.example/', 'https://a.example/')], 'no link in a link');
});

test('markdown: any other link target stays as its source text', () => {
  for (const s of [
    '[x](javascript:alert(1))', '[x](JaVaScRiPt:alert(1))', '[x](data:text/html,<script>alert(1)</script>)',
    '[x](file:///C:/secret)', '[x](/api/shutdown)', '[x](../a)', '[x](#top)', '[x](mailto:a@b.example)', '[x](vbscript:x)',
    '[x](//evil.example/)', '[**粗**](javascript:x)',
  ]) assert.deepEqual(inline(s), [s], s);
  assert.deepEqual(inline('[x](http://a b)'), ['[x](', link('http://a/', 'http://a'), ' b)']);
  assert.deepEqual(inline('[x] (http://a.example/)'), ['[x] (', link('http://a.example/', 'http://a.example/'), ')']);
  assert.deepEqual(inline('[没闭合](http://a.example/'), ['[没闭合](', link('http://a.example/', 'http://a.example/')]);
});

test('markdown: images are never images', () => {
  assert.deepEqual(inline('![图](https://evil.example/x.png)'), [link('https://evil.example/x.png', '图')]);
  assert.deepEqual(inline('![](https://evil.example/x.png)'), [link('https://evil.example/x.png', 'https://evil.example/x.png')]);
  assert.deepEqual(inline('![图](data:image/png;base64,AAAA)'), ['![图](data:image/png;base64,AAAA)']);
  assert.deepEqual(inline('惊叹! [图]'), ['惊叹! [图]']);
  // Whatever the input, no node type could make the page load something.
  const types = new Set<string>();
  const walk = (n: any) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') {
      if (n.type) types.add(n.type);
      Object.values(n).forEach(walk);
    }
  };
  walk(markdownBlocks('# ![a](http://x.example/a.png)\n- ![b](http://x.example/b.png)\n> ![c](http://x.example/c.png)\n\n| ![d](http://x.example/d.png) |\n|---|\n'));
  assert.deepEqual([...types].filter((t) => !['h', 'ul', 'quote', 'table', 'p', 'link'].includes(t)), []);
});

test('markdown: bare http(s) URLs link, without the sentence around them', () => {
  assert.deepEqual(inline('见 https://a.example/x，然后'), ['见 ', link('https://a.example/x', 'https://a.example/x'), '，然后']);
  assert.deepEqual(inline('访问https://a.example/x然后'), ['访问', link('https://a.example/x', 'https://a.example/x'), '然后']);
  assert.deepEqual(inline('See http://a.example/x.'), ['See ', link('http://a.example/x', 'http://a.example/x'), '.']);
  assert.deepEqual(inline('(http://a.example/x), ok?'), ['(', link('http://a.example/x', 'http://a.example/x'), '), ok?']);
  assert.deepEqual(inline('http://a.example/F_(b)'), [link('http://a.example/F_(b)', 'http://a.example/F_(b)')]);
  assert.deepEqual(inline('**http://a.example/**'), [strong(link('http://a.example/', 'http://a.example/'))]);
  assert.deepEqual(inline('~~http://a.example/~~'), [del(link('http://a.example/', 'http://a.example/'))]);
  assert.deepEqual(inline('`http://a.example/`'), [code('http://a.example/')]);
  for (const s of ['xhttp://a.example/', 'ftp://a.example/', 'javascript:alert(1)', 'http://', 'https:// 空']) assert.deepEqual(inline(s), [s], s);
});

test('markdown: HTML is text', () => {
  for (const s of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<a href="javascript:x">y</a>', '&lt;b&gt;', '<!-- c -->']) {
    assert.deepEqual(inline(s), [s], s);
  }
  assert.deepEqual(markdownBlocks('```html\n<script>alert(1)</script>\n```')[0].text, '<script>alert(1)</script>');
});

test('markdown: nesting is capped, the rest stays text', () => {
  const quotes = (n: number) => markdownBlocks(`${'>'.repeat(n)} x`);
  const depthOf = (bs: any[]): number => (bs[0].type === 'quote' ? 1 + depthOf(bs[0].blocks) : 0);
  assert.equal(depthOf(quotes(8)), 8);
  assert.equal(depthOf(quotes(50)), 8);
  let b = quotes(9);
  for (let i = 0; i < 8; i++) b = b[0].blocks;
  assert.deepEqual(b, [para('> x')]);

  const lists = (n: number) => markdownBlocks(Array.from({ length: n }, (_, i) => `${'  '.repeat(i)}- x`).join('\n'));
  const listDepth = (bs: any[]): number => {
    const inner = bs.find((x) => x.type === 'ul');
    return inner ? 1 + listDepth(inner.items[0]) : 0;
  };
  assert.equal(listDepth(lists(8)), 8);
  assert.equal(listDepth(lists(30)), 8);

  // Four levels nest; the fifth keeps its delimiters.
  assert.deepEqual(inline('*a **b ~~c *d **e** d* c~~ b** a*'), [
    em('a ', strong('b ', del('c ', em('d **e** d'), ' c'), ' b'), ' a'),
  ]);
  assert.deepEqual(inline('*a **b ~~c *[d](http://x.example/)* c~~ b** a*'), [
    em('a ', strong('b ', del('c ', em('[d](http://x.example/)'), ' c'), ' b'), ' a'),
  ]);
});

test('markdown: a body over the size limit is one plain paragraph, parsed no further', () => {
  const big = `# 不是标题\n${'x'.repeat(100_000)}`;
  assert.deepEqual(markdownBlocks(big), [para(big)]);
  assert.equal(markdownBlocks(`# 是标题\n${'x'.repeat(99_000)}`)[0].type, 'h');
});

/** Inputs of length `n` (at most) that would be slow for a careless parser. */
function pathological(n: number): Record<string, string> {
  const fit = (unit: string) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  return {
    stars: fit('*'),
    'open stars': fit('*a '),
    'spaced stars': fit('* '),
    'star pairs': fit('**a'),
    'alternating delimiters': fit('*a **b ~~c '),
    brackets: fit('['),
    'close brackets': fit(']'),
    'bracket pairs': fit('[]'),
    'open links': fit('[a]('),
    'unclosed destinations': fit('[a](x'),
    'parens with no end': `[a](${fit('(')}`.slice(0, n),
    'refused links': fit('[a](j:b)'),
    backticks: fit('`'),
    'one backtick each': fit('` '),
    'runs of every length': Array.from({ length: 440 }, (_, i) => '`'.repeat(i + 1)).join(' ').slice(0, n),
    quotes: fit('>'),
    'quote lines': fit('> > > > > > > > > > x\n'),
    dashes: fit('- '),
    'list lines': fit('- a\n'),
    'blank lines in a list': fit('- a\n\n\n\n\n\n\n'),
    backslashes: fit('\\'),
    'escaped stars': fit('\\*'),
    spaces: `# ${' '.repeat(n - 3)}x`,
    hashes: `# a${'#'.repeat(n - 4)}b`,
    'spaced dashes': `-${' -'.repeat((n >> 1) - 2)} x`,
    'pipe lines': fit('| a | b |\n'),
    'delimiter lines': fit('|-|\n'),
    fences: fit('```\n'),
    'unclosed fences': fit('~~~x\n'),
    urls: fit('http://a.example/ '),
    'url ending in parens': `http://a.example/${fit(')')}`.slice(0, n),
    'url ending in dots': `http://a.example/${fit('.')}`.slice(0, n),
    'urls glued together': fit('http://'),
    newlines: fit('\n'),
  };
}

// This guards growth, not speed. Each input is parsed once at length n and K times at length n/K, the same amount
// of text: a linear parser costs about the same for both (up to about 2x here), a quadratic one K times more for the
// one long text. Cost is this thread's CPU time, not the clock: on a busy machine a parse also waits for time slices,
// and the one long parse waited disproportionately, so clock-time comparisons failed on their own, even best of 12.
// CPU time is counted in clock ticks (about 16 ms on Windows), so runs alternate until both sides have used
// ENOUGH_MS, or MAX_RUNS for a cheap input, whose small total is then compared with FLOOR_MS instead. The absolute
// limit is loose on purpose: it only catches a regression of an order of magnitude at every length.
test('markdown: pathological input stays cheap', () => {
  const n = 100_000;
  const K = 16;
  const GROWTH = 4;         // allowed cpu(1 × n) / cpu(K × n/K): about 1 when linear, K when quadratic
  const ENOUGH_MS = 100;    // CPU time of the long text to collect before comparing
  const MIN_RUNS = 2;
  const MAX_RUNS = 12;      // an input this cheap gets no more runs
  const FLOOR_MS = ENOUGH_MS;   // a cpu(K × n/K) below this is a few ticks, mostly error: compare with this instead
  const LIMIT_MS = 1_000;   // CPU time for one parse of n characters
  const big = pathological(n);
  const small = pathological(n / K);
  const cpuMs = () => {
    const { user, system } = process.threadCpuUsage();
    return (user + system) / 1000;
  };
  const cost = (text: string, times: number) => {
    const start = cpuMs();
    for (let i = 0; i < times; i++) markdownBlocks(text);
    return cpuMs() - start;
  };
  for (const [name, text] of Object.entries(big)) {
    assert.ok(text.length <= n && small[name].length <= n / K, name);
    let ofSmall = 0;
    let ofBig = 0;
    let runs = 0;
    markdownBlocks(small[name]);   // warm-up, not counted: compiling the code this input takes
    while (runs < MIN_RUNS || (runs < MAX_RUNS && Math.min(ofSmall, ofBig) < ENOUGH_MS)) {
      ofSmall += cost(small[name], K);
      ofBig += cost(text, 1);
      runs++;
    }
    const report = `${name}, ${runs} runs: ${ofSmall.toFixed(0)} ms CPU for ${K} × ${n / K} characters, ${ofBig.toFixed(0)} ms for 1 × ${n}`;    assert.ok(ofBig < GROWTH * Math.max(ofSmall, FLOOR_MS), `grows faster than linear: ${report}`);
    assert.ok(ofBig / runs < LIMIT_MS, report);
  }
});

test('markdown: the module has no DOM and no way to make HTML, and the renderer never parses a string as HTML', () => {
  const md = readFileSync(join(publicDir, 'markdown.js'), 'utf8');
  assert.doesNotMatch(md, /\bdocument\.|\bwindow\.|^\s*import\b|\bfetch\(|innerHTML|outerHTML|insertAdjacentHTML/m, 'pure: no DOM, no imports, no network');
  const app = readFileSync(join(publicDir, 'app.js'), 'utf8');
  assert.doesNotMatch(app, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment|srcdoc/);
  const start = app.indexOf('function mdBlocks');
  const render = app.slice(start, app.indexOf('function bodyNodes'));
  assert.ok(start > 0 && render.length > 0, 'found the renderer');
  assert.doesNotMatch(render, /'img'|'iframe'|'video'|'audio'|'source'|src:/, 'nothing in a message loads a URL');
  assert.match(render, /rel: 'noopener noreferrer'/);
  // Text in code stays raw: it goes straight to a text node, not through the highlighting.
  assert.match(render, /h\('code', \{\}, n\.text\)/);
  assert.match(render, /h\('pre', \{\}, h\('code', \{\}, b\.text\)\)/);
});
