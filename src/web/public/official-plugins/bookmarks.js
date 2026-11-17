// Bookmarks owns the chat affordance and collection tab; the host supplies shared workbench controls.
import { emptyState, h, icon, noticeDialog } from '../ui.js';
import { formDialog } from '../workbench-form.js';

/** A message can belong to several task bins; only unlinked messages belong to Other. */
export function collectionBins(items) {
  const bins = new Map();
  for (const item of items) for (const id of item.taskIds?.length ? item.taskIds : ['']) {
    if (!bins.has(id)) bins.set(id, []);
    bins.get(id).push(item);
  }
  return bins;
}

export function register({ api, nameOf, command }) {
  function bookmark(clusterId, message) {
    const previous = (message.bookmarks ?? []).find((item) => item.memberId === 'user');
    const labels = h('input', { value: (previous?.labels ?? []).join(', '), placeholder: '可选，用逗号分隔' });
    formDialog(previous ? '编辑我的收藏' : '收藏消息', [h('label', {}, '收藏标签', labels)], () => command({
      action: 'bookmark.set', messageId: message.id,
      labels: [...new Set(labels.value.split(/[,，]/).map((item) => item.trim()).filter(Boolean))],
    }, clusterId));
  }

  function message(msg, state) {
    const bookmarks = msg.bookmarks ?? [];
    const mine = bookmarks.some((item) => item.memberId === 'user');
    return h('details', { class: 'message-stars', open: state?.open }, h('summary', { 'aria-label': `收藏 ${bookmarks.length}` }, icon('star', 'ico-sm'), String(bookmarks.length)),
      bookmarks.length ? bookmarks.map((item) => h('p', {}, `${nameOf(item.memberId)} · ${new Date(item.createdAt).toLocaleString('zh-CN')}${item.labels?.length ? ` · ${item.labels.join('、')}` : ''}`))
        : emptyState('暂无收藏', { compact: true }),
      h('div', { class: 'workbench-actions' }, h('button', { type: 'button', class: 'small', 'data-star-action': 'edit',
        onclick: () => bookmark(msg.clusterId, msg) }, mine ? '编辑我的收藏' : '收藏'),
      mine ? h('button', { type: 'button', class: 'small', 'data-star-action': 'remove', onclick: async () => {
        try { await command({ action: 'bookmark.remove', messageId: msg.id }, msg.clusterId); } catch (e) { await noticeDialog(e.message, '取消收藏失败'); }
      } }, '取消我的收藏') : null));
  }

  function workbench({ getClusterId, getHistoryMembers, taskOptionsPager, itemCard, render, beginCollectionRequest, setError, taskTag }) {
    let collection = null;
    let filters = {};

    async function loadCollections(append = false) {
      const cid = getClusterId();
      const current = beginCollectionRequest();
      const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
      if (append && collection?.nextCursor) query.set('cursor', collection.nextCursor);
      try {
        const data = await api('GET', `/api/clusters/${encodeURIComponent(cid)}/collections?${query}`);
        if (cid !== getClusterId() || !current()) return;
        collection = append && collection ? { ...data, items: [...collection.items, ...data.items] } : data;
        setError(null);
      } catch (e) { if (cid === getClusterId() && current()) setError(e.message); }
      render();
    }

    function collectionFilters() {
      const history = getHistoryMembers(getClusterId());
      const memberOption = (item) => h('option', { value: item.id }, `${item.name}${item.removedAt ? '（已移出）' : ''}`);
      const member = h('select', {}, h('option', { value: '' }, '全部收藏者'), h('option', { value: 'user' }, '你'),
        history.map(memberOption));
      const task = h('select', {}, h('option', { value: '' }, '全部任务'));
      if (filters.taskId) task.append(h('option', { value: filters.taskId }, `未加载：${filters.taskId}`));
      const taskPager = taskOptionsPager(getClusterId(), task);
      const sender = h('select', {}, h('option', { value: '' }, '全部发送者'), h('option', { value: 'user' }, '你'), h('option', { value: 'system' }, 'Orrery 系统'),
        history.map(memberOption));
      const q = h('input', { value: filters.q ?? '' });
      const label = h('input', { value: filters.label ?? '' });
      const since = h('input', { value: filters.since ?? '', placeholder: 'ISO 时间，可留空' });
      const until = h('input', { value: filters.until ?? '', placeholder: 'ISO 时间，可留空' });
      member.value = filters.memberId ?? ''; task.value = filters.taskId ?? ''; sender.value = filters.sender ?? '';
      const modal = formDialog('筛选收藏', [h('label', {}, '收藏者', member), h('label', {}, '任务', task), taskPager.more, taskPager.error, h('label', {}, '发送者', sender),
        h('label', {}, '关键词', q), h('label', {}, '收藏标签', label), h('label', {}, '从时间', since), h('label', {}, '到时间', until)], () => {
        filters = { memberId: member.value, taskId: task.value, sender: sender.value, q: q.value.trim(), label: label.value.trim(),
          since: since.value.trim(), until: until.value.trim() };
        return loadCollections();
      });
      taskPager.start(modal);
    }

    function renderTab() {
      const bins = collectionBins(collection?.items ?? []);
      return h('div', {}, h('div', { class: 'workbench-bar' }, h('span', { class: 'muted' }, `已加载 ${collection?.items.length ?? 0} 条收藏消息`),
        h('button', { type: 'button', class: 'small', onclick: collectionFilters }, '筛选与检索')),
      bins.size ? [...bins].map(([id, items]) => h('section', { class: 'workbench-bin' },
        h('h3', {}, id ? taskTag(id) : h('span', { class: 'wb-author' }, '其他'), h('span', { class: 'workbench-meta' }, `${items.length} 条`)), items.map(itemCard)))
        : collection ? emptyState('没有符合条件的收藏。') : h('p', { class: 'muted' }, '正在加载收藏…'),
      collection?.nextCursor ? h('button', { type: 'button', class: 'small', onclick: () => loadCollections(true) }, '加载更多收藏') : null);
    }

    return {
      id: 'bookmarks', label: '成员收藏', render: renderTab, load: loadCollections,
      reset() { collection = null; filters = {}; },
      itemRow: (item, memberChip) => h('div', { class: 'wb-row' }, h('span', { class: 'wb-row-key' }, '收藏'),
        item.bookmarks?.length ? item.bookmarks.flatMap((bookmark) => [
          bookmark.memberId === 'user' ? h('span', { class: 'wb-author' }, '你') : memberChip(bookmark.memberId),
          ...(bookmark.labels ?? []).map((label) => h('span', { class: 'wb-label' }, label)),
        ]) : h('span', { class: 'muted' }, '无')),
    };
  }

  return {
    message: {
      render: message,
      key: (msg) => msg.bookmarks ?? [],
      update: (msg, data) => { msg.bookmarks = data.bookmarks ?? []; },
      capture(article) {
        const stars = article.querySelector('.message-stars');
        const focused = document.activeElement;
        return { open: stars?.open, summary: focused === stars?.querySelector('summary'),
          action: stars?.contains(focused) ? focused.closest('[data-star-action]')?.dataset.starAction : null };
      },
      restore(article, state) {
        if (!state?.action && !state?.summary) return;
        const control = state.action ? article.querySelector(`[data-star-action="${state.action}"]`) : null;
        (control ?? article.querySelector('.message-stars summary'))?.focus({ preventScroll: true });
      },
    },
    workbench,
  };
}
