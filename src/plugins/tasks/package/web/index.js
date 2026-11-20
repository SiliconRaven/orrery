// Tasks' Star Map panels: mounted through the generic `panel` slot with zero special-casing in Star Map.
import { emptyState } from '/plugin-host/v1.js';
import { t, useWords } from './words.js';

export function register(host = {}) {
  useWords(host?.i18n ?? null);
  const clusterHandles = new Map();
  const allHandles = new Map();

  function detach(map, el) {
    if (el) {
      const handle = map.get(el);
      map.delete(el);
      handle?.unmount();
      return;
    }
    for (const handle of map.values()) handle?.unmount();
    map.clear();
  }

  return {
    panel: [
      {
        id: 'tasks',
        title: () => t('任务'),
        icon: 'tasks',
        scope: 'cluster',
        defaultSize: { w: 820, h: 560 },
        badge: (clusterId) => {
          const count = host.workbench?.stalledCount?.(clusterId) ?? 0;
          return count > 0 ? String(count) : null;
        },
        mount(el, ctx) {
          detach(clusterHandles, el);
          if (!ctx.clusterId || !host.workbench?.mountEmbedded) {
            el.replaceChildren(emptyState(t('请先进入一个群聊再打开任务面板。'), { compact: true }));
            return () => {};
          }
          const handle = host.workbench.mountEmbedded(el, {
            clusterId: ctx.clusterId,
            tab: 'tasks',
            onClose: ctx.close,
            onOpenMember: ctx.openMember,
            onOpenCluster: ctx.openCluster,
          });
          clusterHandles.set(el, handle);
          return () => detach(clusterHandles, el);
        },
        unmount(el) {
          detach(clusterHandles, el);
        },
      },
      {
        id: 'all-tasks',
        title: () => t('全部任务'),
        icon: 'tasks',
        scope: 'global',
        defaultSize: { w: 820, h: 560 },
        badge: () => {
          const count = host.workbench?.stalledCount?.(null) ?? 0;
          return count > 0 ? String(count) : null;
        },
        mount(el, ctx) {
          detach(allHandles, el);
          if (!host.workbench?.mountEmbedded) return () => {};
          const handle = host.workbench.mountEmbedded(el, {
            overview: true,
            onClose: ctx.close,
            onOpenMember: ctx.openMember,
            onOpenCluster: ctx.openCluster,
          });
          allHandles.set(el, handle);
          return () => detach(allHandles, el);
        },
        unmount(el) {
          detach(allHandles, el);
        },
      },
    ],
  };
}
