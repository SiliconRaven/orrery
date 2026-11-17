# Optional Unread Hint Hook for Native Sessions

Language: [中文](unread-hook.md) | **English**

`plugins/unread-hint/hook.mjs` injects a single unread-count line between local tool or model steps. **orrery never installs, enables, or edits host configs**: users merge the snippet below manually into their own configs (`node` must be on the host's PATH; JSON Windows paths accept `/` or `\\`).

- **Positional harness argument**: Pass the harness as the **first positional argument** (**`--harness` is NOT supported**): `node "<orrery-dir>/plugins/unread-hint/hook.mjs" claude` (`claude`, `codex`, `antigravity`, or `zcode`).
- **Changed counts, 4 buckets**: Calls `POST /bridge/unread-hint` with `x-orrery-bridge` and emits a count line only when **unread items remain and their breakdown has changed since the last hint** across four buckets (`mention`, `user`, `broadcast`, `task_notice` with annotations), containing zero bodies, senders, or secrets. If the Hub is unreachable, times out (500ms), or has no hint to report, it stays silent (Antigravity outputs `{}`).
- **Scope**: Claude and Codex skip non-null `agent_id` inputs (`agent_type` alone does not skip); ZCode reads `session_id` only. Automated tests cover output formats and skip conditions. Host identity fields vary by version; leave the hook disabled if the correct session identity is unavailable.

## Claude Code

Merge into `.claude/settings.local.json` inside target projects:

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "*", "hooks": [
        { "type": "command", "command": "node \"<orrery-dir>/plugins/unread-hint/hook.mjs\" claude", "timeout": 5 }
      ] }
    ]
  }
}
```

Emits `{ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: hint } }`. Configure it in the project settings actually loaded by the host.

## Codex

Enable only after verifying your Codex build populates `agent_id` on subagent `PostToolUse` inputs; merge into a trusted `.codex/hooks.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "*", "hooks": [
        { "type": "command", "command": "node \"<orrery-dir>/plugins/unread-hint/hook.mjs\" codex", "timeout": 5 }
      ] }
    ]
  }
}
```

## Antigravity

Add an entry in `~/.gemini/config/hooks.json` under **`PreInvocation`** (NOT `PostToolUse`; no `sidecars/orrery/unread-hook.mjs` file exists):

```json
{
  "orrery-unread": {
    "PreInvocation": [
      { "type": "command", "command": "node \"<orrery-dir>/plugins/unread-hint/hook.mjs\" antigravity", "timeout": 5 }
    ]
  }
}
```

`PreInvocation` runs before model turns and emits `{ injectSteps: [{ ephemeralMessage: hint }] }` (`{}` otherwise). Session identity comes from the host hook input.

## ZCode

Merge into ZCode `hooks.events.PostToolUse` using separate positional `args: [".../hook.mjs", "zcode"]` (never set `async: true`):

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "PostToolUse": [
        { "matcher": ".*", "hooks": [
          { "type": "process", "command": "node", "args": ["<orrery-dir>/plugins/unread-hint/hook.mjs", "zcode"], "timeoutMs": 5000 }
        ] }
      ]
    }
  }
}
```

Reads `session_id` and returns `{ additionalContext: hint }`; session identity comes from the host hook input.

## Kimi Code and DeepSeek Harness

- **Kimi Code**: Unsupported in default mode (host tool hooks do not inject extra context).
- **DeepSeek Harness**: Handled natively inside [dsh-orrery](../../plugins/dsh-orrery/README.en.md) via `tools/post-execute` instead of this script (subagent isolation still awaits live confirmation).
