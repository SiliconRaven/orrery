# 把插件嵌入星图（开发者教程）

从 Orrery `0.10.0-beta.4`（星图 `2.0.0`）起，星图不再只是一个只读窗口，而是一个**全屏工作界面**：内置的任务系统（`tasks`）、协调员（`coordinator`）、收藏（`bookmarks`）以及你自己的第三方插件，全部通过同一套**星图面板托盘（HUD Dock）+ 悬浮窗容器**嵌入星图，零特权、零硬编码。

本文用两个完整可运行的示例带你把任意插件嵌入星图，并自动适配暗月（Luna）、群星（Astra）、炽阳（Sol）三套主题。

---

## 1. 先选对接入方式

Orrery 有两种插件安全档位，对应两种星图嵌入方式：

| 维度 | 方式 A：受限插件 `positions: ["starmap"]`（推荐默认） | 方式 B：完全信任插件 `panel` 插槽 |
|---|---|---|
| **适合场景** | 95% 的第三方插件：计数器、看板、日志查看器、CI/部署状态、检索面板、图表工具 | 需要同页复用宿主组件、或需要全局范围（跨所有群）常驻面板的深度扩展 |
| **渲染载体** | 悬浮窗内嵌 `<iframe sandbox="allow-scripts">`（不透明源、严 CSP、无 Cookie / 存储访问） | 同页 DOM（挂在 `.smw-panel` 容器中），直接共享页面变量与 `panelCtx` |
| **主题适配** | 通过 `orrery.init` / `orrery.theme` 收到 14 个标准色值令牌 + `theme.starmap.theme` | 直接继承 `--starmap-*` 与重映射后的 `--bg` / `--surface` / `--accent` 变量，并可订阅 `panelCtx.onThemeChange` |
| **可见范围** | 按群授权（仅在用户授权了 `starmap` 的群里出现） | 可声明 `scope: 'cluster'`（当前群）或 `scope: 'global'`（宇宙 / 星系 / 群三层均可用） |
| **安全边界** | 走 `postMessage` ↔ Hub ↔ 插件进程；窗口头强制保留不可移除的「第三方插件」标识 | 与 Orrery 同页同权限，须用户在「设置 → 插件」显式确认信任；窗口头同样保留「第三方插件」标识 |
| **参考示例** | [`examples/hub-plugins/ui-demo/`](../examples/hub-plugins/ui-demo/) | [`examples/hub-plugins/trusted-demo/`](../examples/hub-plugins/trusted-demo/) |

> 如无必要，**优先选择方式 A（受限插件）**：代码更简单、页面隔离最严密，而且无需用户授予完全信任。

---

## 2. 方式 A：5 分钟把受限插件嵌入星图（推荐）

受限插件只需要 3 步就能出现在星图底部插件栏（Dock）的悬浮窗里。

### 第一步：在 `orrery-plugin.json` 里声明 `"starmap"`

在现有受限插件清单的 `permissions` 中包含 `"ui.show"`，并在 `ui.positions` 中加入 `"starmap"`：

```json
{
  "id": "ui-demo",
  "version": "1.0.0",
  "name": "界面示例",
  "description": "在群聊标题栏、任务工作台和星图悬浮窗里显示计数器。",
  "apiVersion": 1,
  "entry": "main.mjs",
  "permissions": ["ui.show"],
  "commands": [],
  "ui": {
    "positions": ["titlebar", "workbench", "starmap"],
    "panelHeight": 240
  }
}
```

### 第二步：在用户授权里勾选 `starmap`

用户必须在安装确认页，或在 `ORRERY_HOME/external-plugins.json` 中显式授予 `"starmap"` 位置与目标群 ID（**旧已安装插件不会自动获得星图授权**）：

```json
{
  "plugins": [{
    "manifest": "C:/plugins/ui-demo/orrery-plugin.json",
    "permissions": ["ui.show"],
    "ui": ["titlebar", "workbench", "starmap"],
    "clusterIds": ["<完整群-ID>"]
  }]
}
```

重启 Hub 后，在「设置 → 插件」卡片上可以看到「星图面板（在星图悬浮窗里显示）」已授予，并可通过「显示网页界面」总开关随时启停。

### 第三步：在 `ui/app.js` 响应 `orrery.init` 与 `orrery.theme`

星图悬浮窗复用与 `titlebar` / `workbench` 完全相同的 `postMessage` 协议：

```js
function applyTheme(theme) {
  const root = document.documentElement;
  root.style.colorScheme = theme.scheme; // 星图内恒为 'dark'
  for (const [token, colour] of Object.entries(theme.colors ?? {})) {
    root.style.setProperty(`--${token}`, colour);
  }
  // 可选：读取当前星图主题 ID（'luna' | 'astra' | 'sol'）
  const starmapTheme = theme?.starmap?.theme;
  if (starmapTheme) root.dataset.starmapTheme = starmapTheme;
}

addEventListener('message', (event) => {
  if (event.source !== parent) return;
  const msg = event.data;
  if (msg?.type === 'orrery.init') {
    // msg.position === 'starmap'，msg.clusterId 为当前群 ID
    applyTheme(msg.theme);
    parent.postMessage({ type: 'orrery.request', id: 'init-1', data: { action: 'get' } }, '*');
  } else if (msg?.type === 'orrery.theme') {
    // 用户在星图里切换暗月 Luna / 群星 Astra / 炽阳 Sol 时实时推送
    applyTheme(msg.theme);
  } else if (msg?.type === 'orrery.push') {
    // 插件后端通过 host.ui.push 主动推来的实时数据
    renderCount(msg.data.count);
  }
});

parent.postMessage({ type: 'orrery.ready' }, '*');
```

你的 `ui/style.css` 只要继续使用标准 14 个 CSS 变量（`--bg`、`--surface`、`--surface-2`、`--line`、`--text`、`--muted`、`--accent`、`--accent-soft`、`--on-accent`、`--running`、`--done`、`--failed`、`--warn-bg`、`--warn-text`），打开星图并在三套主题间切换时就会自动换肤。

完整源码见 [`examples/hub-plugins/ui-demo/`](../examples/hub-plugins/ui-demo/)。

---

## 3. 方式 B：用完全信任 `panel` 插槽深度嵌入星图

如果你的插件属于完全信任插件（或官方插件），可以在网页入口 `web/index.js` 的 `register(host)` 返回值里新增 `panel`（单个描述符或非空描述符数组）：

```js
export function register({ api, ui, onDispose }) {
  const { h } = ui;
  // 按窗口容器维护独立实例状态：群级面板可以同时在多个群里各开一个悬浮窗
  const cleanups = new Map();
  const detach = (el) => {
    if (el) { cleanups.get(el)?.(); cleanups.delete(el); return; }
    for (const fn of cleanups.values()) fn();
    cleanups.clear();
  };

  return {
    panel: {
      id: 'notes',                      // 插件内唯一 ID（^[a-z][a-z0-9-]*$）
      title: () => '群便签',             // 纯文本或返回纯文本的函数（随语言切换更新）
      icon: 'file',                     // 必须是页面 sprite 中已有的 i-* 图标名
      scope: 'cluster',                 // 'cluster'（仅群内可用）或 'global'（全局可用）
      defaultSize: { w: 460, h: 400 },  // 可选默认宽高，宿主会夹逼在视口范围内
      badge: (clusterId) => null,       // 可选：返回短数字/文本作为 Dock 角标
      mount(el, panelCtx) {
        detach(el);
        let alive = true;
        const box = h('div', { style: 'padding: 12px;' }, '正在加载…');
        el.replaceChildren(box);

        // 随星图主题变化响应（可选；CSS 变量已自动重映射）
        const stopTheme = panelCtx.onThemeChange((theme) => {
          box.dataset.theme = theme.id; // 'luna' | 'astra' | 'sol'
        });

        // 订阅群 SSE 事件，关闭窗口时宿主也会自动退订
        const stopEvents = panelCtx.onEvent((ev) => {
          if (ev.clusterId === panelCtx.clusterId) { /* 刷新 */ }
        });

        panelCtx.api('GET', `/api/x/my-plugin/clusters/${encodeURIComponent(panelCtx.clusterId)}/notes`)
          .then((data) => {
            if (!alive) return;
            box.textContent = `共 ${data.notes.length} 条便签`;
          })
          .catch((err) => {
            if (alive) box.textContent = err.message;
          });

        const cleanup = () => {
          alive = false;
          stopTheme();
          stopEvents();
        };
        cleanups.set(el, cleanup);
        return () => detach(el);
      },
      unmount(el) {
        detach(el);
      },
    },
  };
}
```

### `panelCtx` 完整字段一览

所有方法均受窗口生命周期守卫；窗口关闭、离开星图或插件撤销信任后自动失效并中止未完成的 `GET`/`HEAD` 请求：

| 字段 | 说明 |
|---|---|
| `clusterId` | 当前群 ID（`scope: 'global'` 时为 `null`） |
| `api(method, path, body?)` | 走页面令牌与错误处理；窗口关闭时自动中止在途读请求 |
| `onEvent(fn)` | 订阅页面 SSE 事件流，返回取消函数（窗口关闭自动退订） |
| `theme` | `{ id: 'luna' \| 'astra' \| 'sol', scheme: 'dark', tokens: Record<string, string> }` |
| `onThemeChange(fn)` | 星图切换主题时回调新主题对象，返回取消函数 |
| `setTitle(text)` / `setSubtitle(text)` | 以纯文本更新当前悬浮窗标题或副标题 |
| `close()` | 关闭当前悬浮窗 |
| `openCluster(clusterId)` | 星图镜头飞往指定群并选中它 |
| `openMember(clusterId, memberId)` | 在星图中打开指定群员的对话窗 |

### 可用图标名（`icon` 白名单）

`panel.icon` 与 `view.icon` 只接受页面内置 sprite 的图标名（禁止传 HTML/SVG 字符串），常用图标包括：`tasks`、`users`、`star`、`file`、`folder`、`search`、`chats`、`comment`、`layers`、`chip`、`clock`、`orbit`、`alert`、`gear`、`trash`、`help`。

### CSS 主题变量

`.smw-panel` 容器会自动把核心界面变量重映射到当前星图主题（`--bg`、`--surface`、`--surface-2`、`--line`、`--text`、`--muted`、`--accent`、`--accent-soft`、`--on-accent`），同时也可以直接读取星图专用变量：

- 表面与玻璃：`--starmap-bg`、`--starmap-surface`、`--starmap-surface-2`、`--starmap-glass`、`--starmap-blur`
- 边框与圆角：`--starmap-edge`、`--starmap-edge-strong`、`--starmap-radius`、`--starmap-radius-sm`
- 文字与强调：`--starmap-ink`、`--starmap-muted`、`--starmap-accent`、`--starmap-accent-hi`、`--starmap-accent-soft`、`--starmap-on-accent`、`--starmap-ether`

完整源码见 [`examples/hub-plugins/trusted-demo/`](../examples/hub-plugins/trusted-demo/)。

---

## 4. 安全约束与排障检查表

1. **受限插件不出现在星图 Dock？**
   - 检查 `orrery-plugin.json` 的 `permissions` 包含 `"ui.show"` 且 `ui.positions` 包含 `"starmap"`；
   - 检查用户授权（`external-plugins.json` 或安装向导）的 `ui` 数组里也明确包含 `"starmap"`，且 `clusterIds` 包含当前群 ID；
   - 检查设置页插件卡片上的「显示网页界面」开关是否打开、插件进程状态是否为 `ready`；
   - 注意：只有飞进某个群（恒星系统层）后，群范围的受限插件才会出现在底部 Dock。
2. **受限插件面板里一片空白或提示超时？**
   - 确认插件目录存在 `ui/index.html` 且所有静态资源都在 `ui/` 内（受严 CSP 限制，禁止加载外链脚本或图片）；
   - 确认脚本加载完成后向 `parent` 发送了 `{ type: 'orrery.ready' }`；
   - 浏览器开发者工具里查看 Console 是否有 CSP 报错。
3. **完全信任插件 `panel` 没注册上？**
   - 宿主在加载阶段会严格校验 `panel` 描述符形状：任意未知字段、非法 `id`、重复 `id`、不在白名单内的 `icon`、非法 `scope`、返回 Promise 都会导致整套插槽被拒绝并在控制台打印原因；
   - `mount` 中请使用 `host.ui.h()` 创建 DOM，切勿把不可信内容塞进 `innerHTML`；
   - 所有全局监听器、定时器必须在 `unmount()` 与 `host.onDispose()` 中清理；宿主会给面板容器自动打 `data-plugin-slot="<id>"`，用户未提交的输入受草稿保护并在插件卸下时自动保留。
4. **私聊隔离提醒**：受限插件无法读取用户在星图成员窗中发送的 1 对 1 私聊（`private: true`），也收不到私聊关联的事件与投递通知；相关规则见 [external-plugins.md](external-plugins.md) 与 [security.md](security.md)。
