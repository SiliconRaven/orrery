# 完全信任示例：群便签

语言：**中文** | [English](README.en.md)

完全信任插件的最小例子（随 `orrery v0.10.0-beta.2` Beta 测试版提供，接口仍可能变化）。它和 orrery 本身权限相同，在 Hub 进程里运行，规则见[第三方插件「完全信任的插件」](../../../docs/external-plugins.md#完全信任的插件)。整个目录可以复制到仓库外，不导入 orrery 源码、不需要 npm 依赖，不调用模型或网络。

它有：

- 自己的图标 `icon.svg`（写在清单的 `icon` 里，确认前也显示在卡片上）；
- 自己的数据表 `x_trusted_demo_notes`（迁移第 1 步，名字带 `x_trusted_demo_` 前缀）；
- 输入框旁的“便签”按钮（网页模块 `web/index.js`，`composer` 插槽）：查看、添加本群便签；快捷键 Alt+Shift+N，插件被卸下时用 `host.onDispose` 移除自己的按键监听；
- 自己的接口：`GET /api/x/trusted-demo/clusters/<群 ID>/notes` 读本群便签，`POST` 同一地址、正文 `{"body":"…"}` 添加一条。和别的 `/api/*` 一样要登录：在打开过协作页的同一个浏览器里可以直接打开这个地址，程序调用带 `Authorization: Bearer <API 令牌>`；
- 群员工具 `trusted_demo_note`：群员留一条便签；
- 钩子 `clusterPurging`：永久删除群聊时删掉这个群的便签。

网页模块只用 `register(host)` 拿到的东西（`host.ui`、`api`、`onDispose`），不按相对路径导入页面文件。表名、路由、动作和工具名都从清单的 `id` 算出（`-` 换成 `_`），复制一份并改掉 `id` 就是另一个能同时运行的插件。

## 安装

1. 在自己选择的 `ORRERY_HOME` 下的 `external-plugins.json` 里登记 `orrery-plugin.json` 的绝对路径，并写明完全信任：

   ```json
   { "plugins": [{ "manifest": "<绝对路径>/trusted-demo/orrery-plugin.json", "trust": "full" }] }
   ```

2. 重启 Hub，打开设置的“插件”，在“完全信任示例：群便签”卡片上点“确认信任…”，看清对话框里的说明和入口文件路径后确认。
3. 再重启 Hub，刷新页面。之后卡片显示“已启用”，输入框旁出现“便签”按钮，支持插件工具的群员能看到 `trusted_demo_note`。

撤销信任、关掉启用开关都在重启 Hub 后生效。重启后已经打开的页面立刻去掉“便签”按钮、不再调用它，并提示“刷新页面后彻底生效”；页面不会自己刷新。如果撤销时便签对话框还开着，里面输入的文字会转进页面自己的只读提示，可以复制；关闭提示或刷新前请先复制需要的内容。

卸载后数据表留在数据库里。要清掉，先停 Hub，再用 sqlite 工具执行 `DROP TABLE x_trusted_demo_notes;` 和 `DELETE FROM plugin_migrations WHERE plugin_id = 'trusted-demo';`。

只安装你信任作者的完全信任插件：它能读写 Hub 数据库里的全部数据。
