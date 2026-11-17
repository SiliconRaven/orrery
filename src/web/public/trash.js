// The recycle bin dialog (docs/architecture.md「回收站与永久删除」): restore a cluster, or tick several and delete them for
// good after typing a confirmation. The pure helpers at the top run in node (test/trash-ui.test.ts).
import { emptyState, h } from './ui.js';

/** What the user types to confirm: the cluster's name for one, `永久删除 N 个群` for several. */
export function purgePhrase(clusters) {
  return clusters.length === 1 ? clusters[0].name : `永久删除 ${clusters.length} 个群`;
}

/** The confirm button is enabled only when the text is exactly the phrase. */
export const purgeConfirmed = (clusters, text) => clusters.length > 0 && text === purgePhrase(clusters);

/** "12 条消息 · 3 个上传文件" for a recycle-bin row (counts from GET /api/clusters?deleted=true). */
export const purgeCounts = (c) => `${c.messageCount ?? 0} 条消息 · ${c.fileCount ?? 0} 个上传文件`;

/**
 * One result line after a purge attempt: `answer` is { ok: true, data } (the 200 body) or { ok: false, status, data }
 * (the error body, with the Hub's refusal code). `tone`: 'done', 'partial' (deleted, some files left) or 'refused'.
 */
export function purgeOutcome(answer) {
  if (answer.ok) {
    const left = answer.data.filesFailed?.length ?? 0;
    return left ? { tone: 'partial', text: `已永久删除，但有 ${left} 个上传文件没能从磁盘删掉（文件夹异常或被占用）` } : { tone: 'done', text: '已永久删除' };
  }
  const { code, member, error } = answer.data ?? {};
  if (code === 'RUNNING') return { tone: 'refused', text: `没有删除：成员 ${member ?? ''} 还有执行没结束，等它结束后再试` };
  if (code === 'NOT_IN_TRASH') return { tone: 'refused', text: '没有删除：它已被恢复，不在回收站里' };
  if (code === 'NOT_FOUND') return { tone: 'refused', text: '没有删除：它已经不存在（可能已被删除）' };
  if (code === 'NAME_MISMATCH') return { tone: 'refused', text: '没有删除：群名已变，和确认时不一致' };
  if (code === 'TRASH_CHANGED') return { tone: 'refused', text: '没有删除：群聊曾被恢复并再次移入回收站，请重新确认' };
  if (code === 'ADDING_MEMBERS') return { tone: 'refused', text: '没有删除：群聊还有添加成员的操作，请等它结束后再试' };
  if (!answer.status || answer.status >= 500) return { tone: 'partial', text: `删除结果未确认：${error || `HTTP ${answer.status ?? '?'}`}` };
  return { tone: 'refused', text: `没有删除：${error || `HTTP ${answer.status ?? '?'}`}` };
}

/**
 * The confirmation for `clusters`: resolves true only when the user typed the phrase and pressed the button; Esc and
 * 取消 resolve false. Focus starts in the input and goes back to where it was.
 */
function confirmPurge(clusters) {
  return new Promise((resolve) => {
    const trigger = document.activeElement;
    const phrase = purgePhrase(clusters);
    const single = clusters.length === 1;
    const ok = h('button', { type: 'submit', value: 'confirm', class: 'primary danger', disabled: true }, '永久删除');
    const input = h('input', { id: 'purge-confirm-input', type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'purge-what purge-kept' });
    input.addEventListener('input', () => { ok.disabled = !purgeConfirmed(clusters, input.value); });
    const dialog = h('dialog', { class: 'ask purge-confirm', role: 'alertdialog', 'aria-labelledby': 'purge-title', 'aria-describedby': 'purge-undo' },
      h('form', { method: 'dialog' },
        h('h2', { id: 'purge-title' }, single ? `永久删除群聊“${clusters[0].name}”？` : `永久删除这 ${clusters.length} 个群聊？`),
        h('ul', { class: 'purge-list' }, clusters.map((c) => h('li', {}, h('strong', {}, c.name), h('span', { class: 'muted' }, purgeCounts(c))))),
        h('p', { id: 'purge-undo', class: 'purge-warning' }, '这一步不能撤销，删除后无法恢复。'),
        h('p', { id: 'purge-what', class: 'ask-message' }, '会删除：群里的全部消息、任务、投递记录、上传的文件，以及成员在群里的记录（已读、收藏、用量等）。'),
        h('p', { id: 'purge-kept', class: 'ask-message muted' }, '不会动：各应用里的对话本身、工作文件夹、之前做的备份。'),
        h('label', { for: 'purge-confirm-input', class: 'purge-type' },
          h('span', {}, '请输入 ', h('strong', { class: 'purge-phrase' }, phrase), ' 确认'), input),
        h('div', { class: 'row end' }, h('button', { type: 'button', onclick: () => dialog.close('cancel') }, '取消'), ok)));
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (trigger?.isConnected) trigger.focus();
      resolve(dialog.returnValue === 'confirm' && purgeConfirmed(clusters, input.value));
    });
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
  });
}

/**
 * Opens the recycle bin. `api(method, path, body)` throws on a non-2xx answer with `status` and `data` (the error body)
 * on the error; `restored()` runs after a restore. Purges run one by one; one refusal does not stop the others.
 */
export function openTrash({ api, restored, noticeDialog, closed }) {
  const list = h('div', { class: 'trash-list' }, '正在加载…');
  const results = h('div', { class: 'trash-results', role: 'status', 'aria-live': 'polite' });
  const purgeButton = h('button', { type: 'button', class: 'danger', disabled: true }, '永久删除所选');
  const box = h('dialog', { class: 'trash-dialog', 'aria-labelledby': 'trash-title' }, h('div', { class: 'workbench-form' }, h('h2', { id: 'trash-title' }, '回收站'),
    h('p', { class: 'muted' }, '恢复群聊不会重发旧投递，也不会更改原生对话。勾选后可以永久删除，永久删除不能撤销。'), results, list,
    h('div', { class: 'row end' }, purgeButton, h('button', { type: 'button', onclick: () => box.close() }, '关闭'))));
  box.addEventListener('close', () => { box.remove(); closed?.(); });
  document.body.append(box); box.showModal();
  let clusters = [];
  let busy = false;
  let loading = 0;
  const removed = new Set();
  const ticked = new Set();
  const selected = () => clusters.filter((c) => ticked.has(c.id));
  const update = () => { purgeButton.disabled = busy || ticked.size === 0; };
  const draw = () => {
    list.replaceChildren(...(clusters.length ? clusters.map((cluster) => {
      const checkbox = h('input', { type: 'checkbox', id: `trash-${cluster.id}`, checked: ticked.has(cluster.id) });
      checkbox.addEventListener('change', () => { if (checkbox.checked) ticked.add(cluster.id); else ticked.delete(cluster.id); update(); });
      return h('div', { class: 'workbench-setting-row trash-row' },
        h('label', { class: 'trash-pick', for: `trash-${cluster.id}` }, checkbox,
          h('span', { class: 'trash-name' }, cluster.name), h('span', { class: 'muted trash-counts' }, purgeCounts(cluster))),
        h('button', { type: 'button', class: 'small', 'aria-label': `恢复 ${cluster.name}`, onclick: async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          try { await api('POST', `/api/clusters/${encodeURIComponent(cluster.id)}/restore`, {}); ticked.delete(cluster.id); await restored(); await load(); }
          catch (e) { await noticeDialog(e.message, '恢复失败'); button.disabled = false; }
        } }, '恢复'));
    }) : [emptyState('回收站为空。')]));
    update();
  };
  const load = async () => {
    const request = ++loading;
    try {
      const rows = await api('GET', '/api/clusters?deleted=true');
      if (!box.open || request !== loading) return;
      clusters = rows.filter((c) => !removed.has(c.id));
      for (const id of ticked) if (!clusters.some((c) => c.id === id)) ticked.delete(id);
      draw();
    } catch (e) {
      if (box.open && request === loading) list.textContent = `加载失败：${e.message}`;
    }
  };
  purgeButton.addEventListener('click', async () => {
    const chosen = selected();
    if (busy || !chosen.length) return;
    busy = true;
    update();
    try {
      if (!(await confirmPurge(chosen))) return;
      const lines = [];
      const show = (note) => results.replaceChildren(h('h3', {}, '永久删除结果'), h('ul', {}, lines), ...(note ? [h('p', { class: 'muted' }, note)] : []));
      for (const [i, cluster] of chosen.entries()) {
        show(`正在删除 ${i + 1}/${chosen.length}…`);
        let answer;
        try {
          const data = await api('POST', `/api/clusters/${encodeURIComponent(cluster.id)}/purge`, { name: cluster.name, trashVersion: cluster.trashVersion });
          answer = { ok: true, data };
        } catch (e) { answer = { ok: false, status: e.status, data: e.data ?? { error: e.message } }; }
        const outcome = purgeOutcome(answer);
        if (answer.ok) ticked.delete(cluster.id);
        lines.push(h('li', { class: `purge-${outcome.tone}` }, h('strong', {}, cluster.name), '：', outcome.text));
      }
      show('');
      await load();
    } finally {
      busy = false;
      update();
    }
  });
  load();
  return (id) => {
    if (!box.open) return;
    removed.add(id);
    if (!clusters.some((c) => c.id === id)) return;
    clusters = clusters.filter((c) => c.id !== id);
    ticked.delete(id);
    draw();
  };
}
