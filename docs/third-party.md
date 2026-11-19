# 第三方素材与依赖说明

语言：**中文** | [English](third-party.en.md)

本仓库自身源码采用 **MIT License** 开源（英文法律原文保存在仓库根目录 `LICENSE` 文件中，不以中文译文替代法律效力）。仓库中的 MIT 授权仅覆盖 orrery 项目自身代码，**不自动对第三方依赖、外部工具或随仓分发的视觉素材进行重新许可**。

## 软件依赖与上游参考

- **运行与开发依赖**：根工程及桌面外壳子包引入的第三方依赖（例如 `@modelcontextprotocol/sdk`、`zod`、Electron、`koffi`、Knip 等）均继续沿用各自原有的开源或软件许可协议。
- **外部协议参考致谢**：[外部插件协议](external-plugins.md) 中的权限与进程隔离模型曾参考 MIT 许可的 `deepseek-harness`（`dsh-v0.2.1-rc.2`），其版权与许可说明按上游条款保留。

## 图标与视觉素材

1. **9 个第三方应用图标**：界面与成员列表中展示的 9 个第三方桌面/AI 应用图标仅用于直观识别用户接入的对应程序，其商标与图标权利仍归各自所属权方所有，不纳入项目 MIT 授权范围。
2. **项目图标**：单轨双星图标的原创 SVG 源文件保存在 `desktop/assets/orrery-icon.svg` 与 `orrery-mark.svg`，PNG 和 Windows ICO 均由这些源文件导出，随项目按 MIT 发布。仓库不内置角色插画。

归档安装使用 `tar 7.5.23`（BlueOak-1.0.0）和 `yauzl 3.4.0`（MIT），其软件包保留上游许可证原文。
