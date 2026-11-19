# 模型调用外未读提示钩子（可选）

语言：**中文** | [English](unread-hook.en.md)

仓库提供了独立的轻量脚本 `plugins/unread-hint/hook.mjs`，用于在支持的原生应用中在工具或调用间隙插入一行未读计数提示。**orrery 不安装、不启用或不修改任何宿主配置**：请由用户自行把对应配置片段合并到已有文件中（注意 Node 24 须位于对应应用的 PATH 上；JSON 中的 Windows 路径可用正斜杠 `/` 或双反斜杠 `\\`）。

- **位置参数传 harness 名**：脚本通过**第一个位置参数**区分应用，**不支持 `--harness` 标志**，例如 `node "<orrery目录>/plugins/unread-hint/hook.mjs" claude`（可选值为 `claude`、`codex`、`antigravity`、`zcode`）。
- **找 Hub 与签名**：脚本经同目录的 `hub-discovery.mjs` 读账户的 Hub 登记处（`ORRERY_REGISTRY`），连活动 Hub 或 `ORRERY_HUB` 钉住的那个，请求用 `x-orrery-sig` 签名，不读 `hub.json`、不发密钥原文（见[接入件：找 Hub、签名、报错](../native-mode.md#接入件找-hub签名报错)）。宿主配置按路径引用脚本，更新 orrery 即随之更新。
- **计数变化时提示，4 桶统计**：脚本请求 `POST /bridge/unread-hint`，仅当仍有未读且分项计数相对上次提示有变化时才输出精简计数行（含 4 类：`mention` 点名你、`user` 用户未 `@` 发言、`broadcast` 广播、`task_notice` 任务通知，附标注状态），不包含正文、发送者或密钥；Hub 未起、找不到、拒收、超时（500 毫秒）或无需提示时静默忽略（Antigravity 返回 `{}`）。
- **作用范围**：Claude 与 Codex 输入含非 null `agent_id` 时跳过（只有 `agent_type` 不跳过）；ZCode 只读取 `session_id`。自动化测试覆盖格式与跳过条件，宿主提供的身份字段取决于实际版本；无法取得正确会话身份时保持钩子关闭。

## Claude Code

在需要开启的项目中，由用户合并至 `.claude/settings.local.json`：

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "*", "hooks": [
        { "type": "command", "command": "node \"<orrery目录>/plugins/unread-hint/hook.mjs\" claude", "timeout": 5 }
      ] }
    ]
  }
}
```

输出格式为 `{ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: hint } }`。请配置到宿主实际读取的项目设置中。

## Codex

确认目标版本会在子代理的 `PostToolUse` 输入可靠携带 `agent_id` 后，可按需合并至受信任的项目 `.codex/hooks.json`（确认前不建议启用）：

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "*", "hooks": [
        { "type": "command", "command": "node \"<orrery目录>/plugins/unread-hint/hook.mjs\" codex", "timeout": 5 }
      ] }
    ]
  }
}
```

## Antigravity

在 `~/.gemini/config/hooks.json` 中新增独立条目使用 **`PreInvocation`**（非 `PostToolUse`，也**没有**额外的 `sidecars/orrery/unread-hook.mjs` 文件）：

```json
{
  "orrery-unread": {
    "PreInvocation": [
      { "type": "command", "command": "node \"<orrery目录>/plugins/unread-hint/hook.mjs\" antigravity", "timeout": 5 }
    ]
  }
}
```

`PreInvocation` 在下一次模型调用前运行，通过 `{ injectSteps: [{ ephemeralMessage: hint }] }` 插入临时提示（无新未读时输出 `{}`）；会话身份取自宿主 hook 输入。

## ZCode

在 ZCode 配置中合并 `PostToolUse`（`process` 方式将路径与位置参数 `"zcode"` 分开传，切勿设为 `async: true`）：

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "PostToolUse": [
        { "matcher": ".*", "hooks": [
          { "type": "process", "command": "node", "args": ["<orrery目录>/plugins/unread-hint/hook.mjs", "zcode"], "timeoutMs": 5000 }
        ] }
      ]
    }
  }
}
```

该钩子从输入读取 `session_id` 并返回 `{ additionalContext: hint }`；会话身份取自宿主 hook 输入。

## Kimi Code 与 DeepSeek Harness

- **Kimi Code**：原生默认版暂不支持（工具后钩子不向模型上下文注入附加文本）。
- **DeepSeek Harness**：不使用本脚本，已由 [dsh-orrery 插件](../../plugins/dsh-orrery/README.md) 通过 `tools/post-execute` 原生接入（其子代理身份仍待真机单独确认）。
