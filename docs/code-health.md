# 代码健康检查

语言：**中文** | [English](code-health.en.md)

Knip 6.45.1 是只在开发时使用的静态检查工具，报告没有被入口引用的文件、依赖、导出和类型；它不会执行被检查的程序。版本固定在根 package.json 和 package-lock.json，不增加 Hub 的运行时依赖。

## 运行

需要项目要求的 Node 24。首次运行先安装根依赖。桌面版是独立包：静态检查也需要它的依赖元数据，可以跳过安装脚本，避免为了扫描下载或启动 Electron。

```powershell
npm ci
npm ci --prefix desktop --ignore-scripts
npm run check:health
npm run check:exports
```

check:health 检查未引用文件、依赖和循环，循环按 error 处理，可作为门槛。check:exports 单独报告未使用的导出和类型；有候选时退出码为 1，需要人工核对，不作为代码健康 CI 的门禁。两者使用同一配置。可用 `npm run check:exports -- --reporter json` 获取结构化报告。扫描不会启动桌面、Hub、原生应用或真实模型；配置中列出的真机检查也只会被解析。

独立的 `.github/workflows/code-health.yml` 在推送 main、PR 和手动触发时安装根依赖与桌面依赖元数据，运行 `check:health` 和协作基准；本地运行也需要上面两步安装。

## 入口和配置

Knip 自动读取 package.json 的 main / exports / scripts 和 CI 命令；这些不重复登记。其余动态入口和扫描范围统一维护在 knip.json 的 workspaces 中，根包使用 `"."`，桌面包和 DeepSeek 插件保留自己的依赖边界。

- 根 Node 入口：Hub、启动器、备份、Claude 桥，以及 package.json / CI 使用的开发脚本。
- 网页：index.html 加载 app.js 和经典脚本 theme.js，app 的静态导入继续跟踪。书签、协调员、星图和任务的官方网页模块由插件插槽动态加载，各自在 Knip 中登记为入口。
- 原生插件：会被外部 harness 复制或执行的 MCP、hook、sidecar、后台等待脚本；Antigravity 的 hook-dump 是文档公开的诊断入口。Cursor 的 lib/hub.mjs 等内部模块仍由实际导入跟踪。
- DeepSeek 插件：lib/index.js 是 package.json 的 main / exports，导出由外部 Cordis 使用，不能按仓库内没有调用就删除。
- 示例：两个 hub-plugins 的 main.mjs 由各自清单指定，由 Hub 另起进程执行。
- 测试：scripts/test.mjs 实际运行的 test/*.test.ts 是非生产入口；helpers 和其余测试支持文件通过导入跟踪。用路径启动的模拟 CLI 和用清单加载的插件 fixture（例如 config-demo）逐个登记。
- 桌面：main / shortcut、三份 preload 和三个 HTML 直接加载的 UI 模块；四个独立 Electron 检查，以及测试通过字符串路径运行的 win32-host / temp-reaper。其他桌面模块继续按实际导入跟踪。

入口末尾的 `!` 表示生产入口，不带该标记的测试和开发命令不会在 `--production` 模式中作为入口。生产模式只是辅助观察测试专用导出，不替代默认的全仓报告。

只对操作系统提供的 tasklist、netstat、Windows 权限测试使用的 icacls.exe 和测试在可用时调用的 mkfifo 设置 ignoreBinaries。node_modules 和 .tmp 等产物沿用现有 .gitignore；临时 JSON 报告也应放在 .tmp。

## 如何处理候选

报告是人工核对的入口，不是自动删除清单。先查调用者、动态导入、生成的命令、外部安装方式和测试，再决定处理方式。

- 导出只在同一文件中使用时，通常可以去掉 export，而不是删除实现；仍需确认它不属于外部插件接口。
- 现有部分测试用 VM 读取源码片段或通过变量路径加载模块，静态图不能完整识别这些消费者。特别是工作台、图布局和原生适配器的测试接口，应回查对应测试，不为压低数字而把整份源文件登记为入口。
- 未安装独立桌面依赖时，electron 命令可能被误报为未列出的二进制。先按上面的命令安装桌面依赖元数据，不通过 ignore 掩盖。
- 每次新增 HTML 脚本、外部插件执行入口或字符串路径启动程序时，同步修改入口配置。新增真实导入不需要重复登记被导入的文件。

不在本检查中运行自动修复或自动删除，也不为本工具增加第二套扫描器。
