import { language, t } from './i18n.js';
import { emptyState, fmtTime, fmtTokens, h } from './ui.js';

/** Cached member-page usage blocks; the page supplies data, elements and message navigation. */
export function createUsageRenderer({ element, nameOf, showMessage }) {
  /**
   * Redraws a usage block only when what it shows changed (a minute passing changes the countdown, so the minute is part
   * of it): a redraw between pointerdown and pointerup would swap the refresh button under the pointer.
   */
  const usageSigs = new Map();
  function draw(id, what, build, { perMinute = true, preserveOpen = false } = {}) {
    const sig = JSON.stringify([language(), what, perMinute ? Math.floor(Date.now() / 60_000) : null]);   // a language switch redraws it
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
      if (!data) return h('p', { class: 'muted usage-note' }, error ? t("轮次用量读取失败。") : t("正在读取轮次用量…"));
      const sourceName = (from) => from === 'system' ? t("系统") : nameOf(from);
      const kindName = (kind) => ({ chat: t("聊天"), task_comment: t("任务留言"), system: t("系统通知"), handover: t("交接包"), handoff: t("投递交接"), resend: t("重发"), plugin: t("插件消息") })[kind] ?? kind;
      const line = (label, part) => h('p', { class: 'usage-note' }, t("{label}：{turns} 轮 · {tokens} token", { label: label, turns: part.turns, tokens: fmtTokens(part.tokens) }));
      const entries = data.expensive.map((turn) => h('li', {},
        h('div', {}, `${fmtTime(turn.at)} · ${fmtTokens(turn.tokens)} token`),
        turn.messages.length ? turn.messages.map((message) => h('button', { type: 'button', class: 'usage-message',
          onclick: () => showMessage(member.clusterId, message.messageId) },
        `${sourceName(message.from)} · ${kindName(message.kind)} · ${message.excerpt || t("（无正文）")}`)) : h('span', { class: 'muted' }, t("触发消息不可用"))));
      return h('section', { class: 'usage', 'aria-label': t("轮次用量") },
        h('div', { class: 'usage-head' }, t("轮次用量")),
        h('p', { class: 'usage-note' }, t("共 {tokens} token · {turns} 轮 · 平均每轮 {average}", { tokens: fmtTokens(data.tokens), turns: data.turns, average: fmtTokens(Math.round(data.average)) })),
        line(t("短回复轮（输出少于 3000）"), data.short), line(t("工作轮"), data.work),
        data.expensive.length ? [h('div', { class: 'usage-head' }, t("最贵轮次")), h('ol', { class: 'usage-turns' }, entries)] : emptyState(t("暂无轮次记录"), { compact: true }));
    }, { perMinute: false });
  }

  return { draw, renderTurns };
}
