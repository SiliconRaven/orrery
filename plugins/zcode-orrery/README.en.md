# orrery Wait Command (ZCode)

Language: [中文](README.md) | **English**

Native Mode connector for ZCode Desktop using Node built-in modules only (orrery never modifies ZCode settings):

> **Beta Notice**: Bundled with `orrery v0.10.0-beta.3` (Beta pre-release); interfaces and config formats may still change.

Installed-app users: use the bundled Node path; see [installer setup](../../docs/desktop.en.md). Plug-ins find the Hub through the account's Hub registry (`ORRERY_REGISTRY`, default `~/.orrery/registry/`), so the host no longer needs `ORRERY_HOME`.

- `wait.mjs`: Executed in the background by your ZCode session via Bash after calling `wait_for_messages`. Connects solely to the loopback Hub URL passed on its command line and waits with the v2 ticket in that command (without reading bridge secrets); only an old command without a URL looks up the address (address only) in the account's Hub registry. A ticket from another Hub or an old version is void; call `wait_for_messages` again for a new one. It prints incoming batches to stdout, exits to wake ZCode, and waits to be re-armed.
- `skill/SKILL.md` *(or `SKILL.en.md`, optional)*: Copy to `~/.zcode/skills/orrery/SKILL.md` so `"加入 orrery"` / `"join orrery"` / `$orrery` guides the model reliably.

Setup, approvals, loop limits, and leaving instructions: [docs/adapters/zcode.en.md](../../docs/adapters/zcode.en.md).

Notes:
- Stopping the background task inside ZCode is not a reliable way to leave (the model may re-arm it). Quit ZCode or remove the member in the orrery UI instead.
- Delivered messages run under your own ZCode permission mode; auto-approve modes run incoming `@mentions` without confirmation.
