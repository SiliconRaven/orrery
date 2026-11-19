import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage, t } from '../shared/i18n/index.js';
const english = (await import(new URL('../shared/i18n/en-ui.js', import.meta.url).href)).default as Record<string, string>;
const { avatarEl, harnessSpecs, deliveryView, hiddenConfirmText, memberDetails, memberSummary, moveTargets, quotaLines, relativeTime, resetText, tokenText } =
  await import(new URL('../src/web/public/ui.js', import.meta.url).href);
const { CATEGORY_CHOICES, FIXED_SENDERS, searchQuery, senderChoices } = await import(new URL('../src/web/public/chat-search.js', import.meta.url).href);
const { conversationMatrix, STATUS_WORD } = await import(new URL('../src/web/public/conversation-matrix.js', import.meta.url).href);
const { pluginState, pluginWriteSubmission } = await import(new URL('../src/web/public/plugins.js', import.meta.url).href);
const { purgeConfirmed, purgeCounts, purgeOutcome, purgePhrase } = await import(new URL('../src/web/public/trash.js', import.meta.url).href);
const { stalledLines, stalledTaskText } = await import(new URL('../src/web/public/stalled.js', import.meta.url).href);

test('shared UI renders in English after loading modules and preserves user content', () => {
  setLanguage('en');
  try {
    assert.equal(memberSummary(3, 2, 1), '3 members · 2 online · 1 hidden');
    assert.deepEqual(harnessSpecs({ harness: 'codex', sessions: [], nativeCreate: true, create: true }), {
      error: 'Select the project directory for the new conversation',
    });
    assert.equal(deliveryView({ state: 'done', outcome: 'completed' }).label, 'Turn completed');
    assert.equal(STATUS_WORD.offline, 'Offline');
    assert.equal(FIXED_SENDERS[0].label, 'You');
    assert.equal(CATEGORY_CHOICES.find((choice: { value: string }) => choice.value === 'warning:problem').label, 'Warning · Problem');
    assert.equal(searchQuery({ q: 'x'.repeat(201) }).error, 'Keywords can contain at most 200 characters.');
    const member = { id: 'm', name: '中文名字', clusterId: 'c', harness: 'codex', workerSessionId: 'conversation-id', cwd: 'C:/中文/项目' };
    assert.equal(senderChoices([member], 'c')[0].label, member.name);
    const details = memberDetails(member, null, null);
    assert.equal(details.project.text, '项目');
    assert.equal(details.project.title, 'Project (working directory): C:/中文/项目');
    assert.equal(details.model.text, 'Model unknown');
    const groups = moveTargets(['未分组', '我的组'], '');
    assert.equal(groups[0].label, '未分组', 'a user-created name that matches a msgid stays raw');
    assert.equal(groups.at(-1).label, 'Ungrouped');
    const matrix = conversationMatrix({ members: [], clusters: [{ id: 'c', name: '我的群', createdAt: '2026-01-01' }], statusOf: () => 'idle' });
    assert.equal(matrix.columns[0].group, 'Ungrouped');
    assert.equal(matrix.columns[0].name, '我的群');
    assert.match(hiddenConfirmText(member, { executing: [], reviewing: [] }, true), /^Hide 中文名字?/);
    assert.equal(purgePhrase([{ name: '永久删除' }]), '永久删除');
    assert.equal(purgePhrase([{ name: 'a' }, { name: 'b' }]), 'Permanently delete 2 clusters');
    assert.equal(purgeConfirmed([{ name: 'a' }, { name: 'b' }], 'Permanently delete 2 clusters'), true);
    assert.equal(purgeCounts({ messageCount: 4, fileCount: 2 }), '4 messages · 2 uploaded files');
    assert.equal(purgeOutcome({ ok: false, status: 400, data: { error: '第三方原文' } }).text, 'Not deleted: 第三方原文');
    assert.equal(stalledTaskText({ title: '用户任务', status: 'working', number: 3 }), '#3 用户任务 (In progress)');
    const hidden = stalledLines({ kind: 'hidden_work', memberName: member.name, harness: member.harness });
    assert.ok(hidden[0].startsWith('中文名字 (codex) is hidden'));
    assert.equal(pluginState({ enabled: true, pendingEnabled: true }).text, 'Enabled');
    const write = pluginWriteSubmission({ permissions: ['messages.mention'], writeSettings: { mentionEnabled: false, perMinute: 1, perHour: 5 } },
      { mentionEnabled: true, perMinute: { value: '1', unlimited: false }, perHour: { value: '5', unlimited: false } });
    assert.match(write.confirm.message, /plugin mentions wake members/);
    assert.equal(relativeTime('2026-01-01T00:00:00Z', Date.parse('2026-01-01T00:02:00Z')), '2 min ago');
    assert.equal(resetText('2026-01-01T00:02:00Z', Date.parse('2026-01-01T00:00:00Z')), 'Resets in 2 min');
    assert.equal(quotaLines({ supported: true, snapshot: { windows: [{ label: '外部窗口', usedPercent: 10, resetsAt: '2026-01-01' }] } }, Date.parse('2026-01-02'))[0].note, 'Reset');
    assert.match(tokenText({ input: 1, cachedInput: 2, cacheWrite: 3, output: 4, reasoning: 0 }), /^Total 10: input 1/);
  } finally { setLanguage('zh'); }
  assert.equal(deliveryView({ state: 'done', outcome: 'completed' }).label, '轮次完成');
  assert.equal(CATEGORY_CHOICES.find((choice: { value: string }) => choice.value === 'warning:problem').label, '警告 · 问题');
});

test('English helper catalog retains named parameters and has no Chinese fallback text', () => {
  const parameters = (value: string) => [...value.matchAll(/{([A-Za-z_]\w*)}/g)].map((hit) => hit[1]).sort();
  for (const [msgid, translated] of Object.entries(english)) {
    assert.deepEqual(parameters(translated), parameters(msgid), msgid);
    assert.doesNotMatch(translated, /\p{Script=Han}/u, msgid);
  }
  setLanguage('en');
  try { assert.equal(t('开启后，插件点名可能唤醒成员并消耗模型用量。'), 'Enabling this lets plugin mentions wake members and consume model usage.'); }
  finally { setLanguage('zh'); }
});

test('a missing preset image falls back to initials and a custom supplied image keeps its URL', (context) => {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const make = (tagName: string) => ({
    tagName, attrs: {} as Record<string, string>, handlers: {} as Record<string, (event: any) => void>,
    children: [] as any[], className: '',
    setAttribute(name: string, value: string) { this.attrs[name] = value; },
    addEventListener(name: string, fn: (event: any) => void) { this.handlers[name] = fn; },
    append(...children: any[]) { this.children.push(...children); },
    replaceChildren(...children: any[]) { this.children = children; },
  });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: make } });
  context.after(() => { if (old) Object.defineProperty(globalThis, 'document', old); else Reflect.deleteProperty(globalThis, 'document'); });

  const member = { name: 'Aster', harness: 'codex', avatar: 'preset:claude' };
  const preset = avatarEl(member, 'xs', { named: true }) as ReturnType<typeof make>;
  const image = preset.children[0];
  assert.equal(image.attrs.src, '/avatars/claude.png');
  image.handlers.error({ target: { parentElement: preset } });
  assert.equal(preset.children[0], 'A');
  assert.equal(preset.attrs['aria-label'], member.name);
  const custom = 'data:image/png;base64,AAAA';
  const uploaded = avatarEl({ ...member, avatar: custom }) as ReturnType<typeof make>;
  assert.equal(uploaded.children[0].attrs.src, custom);
});
