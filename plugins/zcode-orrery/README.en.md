# orrery Wait Command (ZCode)

Language: [中文](README.md) | **English**

Native Mode connector for ZCode Desktop using Node built-in modules only (orrery never modifies ZCode settings):

> **Beta Notice**: Bundled with `orrery v0.10.0-beta.2` (Beta pre-release); interfaces and config formats may still change.

Installed-app users: use the bundled Node path and set `ORRERY_HOME` for the host plugin. See [installer setup](../../docs/desktop.en.md).

- `wait.mjs`: Executed in the background by your ZCode session via Bash after calling `wait_for_messages`. Connects solely to the loopback Hub URL passed on its command line (without reading bridge secrets), prints incoming batches to stdout, exits to wake ZCode, and waits to be re-armed.
- `skill/SKILL.md` *(or `SKILL.en.md`, optional)*: Copy to `~/.zcode/skills/orrery/SKILL.md` so `"加入 orrery"` / `"join orrery"` / `$orrery` guides the model reliably.

Setup, approvals, loop limits, and leaving instructions: [docs/adapters/zcode.en.md](../../docs/adapters/zcode.en.md).

Notes:
- Stopping the background task inside ZCode is not a reliable way to leave (the model may re-arm it). Quit ZCode or remove the member in the orrery UI instead.
- Delivered messages run under your own ZCode permission mode; auto-approve modes run incoming `@mentions` without confirmation.
