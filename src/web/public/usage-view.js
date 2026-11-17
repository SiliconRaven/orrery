import { emptyState, fmtTime, fmtTokens, h } from './ui.js';

/** Cached member-page usage blocks; the page supplies data, elements and message navigation. */
export function createUsageRenderer({ element, nameOf, showMessage }) {
  /**
   * Redraws a usage block only when what it shows changed (a minute passing changes the countdown, so the minute is part
   * of it): a redraw between pointerdown and pointerup would swap the refresh button under the pointer.
   */
  const usageSigs = new Map();
  function draw(id, what, build, { perMinute = true, preserveOpen = false } = {}) {
    const sig = JSON.stringify([what, perMinute ? Math.floor(Date.now() / 60_000) : null]);
    if (usageSigs.get(id) === sig) return;
    usageSigs.set(id, sig);
    const open = preserveOpen && element(id).querySelector('details')?.open;
    const content = build();
    if (open && content.tagName === 'DETAILS') content.open = true;
    element(id).replaceChildren(content);
  }

  function renderTurns(member, { data: report, identity, error }) {
    const data = report?.memberId === member.id ? report : null;
    draw('member-turns', [member.id, identity, data, error], () => {
      if (!data) return h('p', { class: 'muted usage-note' }, error ? '轮次用量读取失败。' : '正在读取轮次用量…');
      const sourceName = (from) => from === 'system' ? '系统' : nameOf(from);
      const kindName = (kind) => ({ chat: '聊天', task_comment: '任务留言', system: '系统通知', handover: '交接包', handoff: '投递交接', resend: '重发', plugin: '插件消息' })[kind] ?? kind;
      const line = (label, part) => h('p', { class: 'usage-note' }, `${label}：${part.turns} 轮 · ${fmtTokens(part.tokens)} token`);
      const entries = data.expensive.map((turn) => h('li', {},
        h('div', {}, `${fmtTime(turn.at)} · ${fmtTokens(turn.tokens)} token`),
        turn.messages.length ? turn.messages.map((message) => h('button', { type: 'button', class: 'usage-message',
          onclick: () => showMessage(member.clusterId, message.messageId) },
        `${sourceName(message.from)} · ${kindName(message.kind)} · ${message.excerpt || '（无正文）'}`)) : h('span', { class: 'muted' }, '触发消息不可用')));
      return h('section', { class: 'usage', 'aria-label': '轮次用量' },
        h('div', { class: 'usage-head' }, '轮次用量'),
        h('p', { class: 'usage-note' }, `共 ${fmtTokens(data.tokens)} token · ${data.turns} 轮 · 平均每轮 ${fmtTokens(Math.round(data.average))}`),
        line('短回复轮（输出少于 3000）', data.short), line('工作轮', data.work),
        data.expensive.length ? [h('div', { class: 'usage-head' }, '最贵轮次'), h('ol', { class: 'usage-turns' }, entries)] : emptyState('暂无轮次记录', { compact: true }));
    }, { perMinute: false });
  }

  return { draw, renderTurns };
}
