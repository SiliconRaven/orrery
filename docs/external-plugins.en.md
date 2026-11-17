# External Plugin Protocol (Experimental API v1)

Language: [中文](external-plugins.md) | **English**

orrery (`v0.10.0-beta.1` Beta pre-release) supports third-party extensions as separate OS child processes communicating via line-delimited JSON-RPC 2.0 on `stdin`/`stdout`; external plugin interfaces are experimental Beta surfaces and may change.

> Acknowledges the MIT-licensed reference `deepseek-harness` `dsh-v0.2.1-rc.2` (Copyright (c) 2026 DeepSeek). Out-of-process execution isolates crashes under the same OS user account—**it is NOT an OS security sandbox**. Run trusted plugin code only.

## Manifest & Least-Privilege Scopes

Place an `orrery-plugin.json` manifest in your plugin directory, register it in `<ORRERY_HOME>/external-plugins.json`, and restart the Hub:

```json
{
  "plugins": [
    {
      "manifest": "C:/projects/my-plugin/orrery-plugin.json",
      "permissions": ["clusters.read", "messages.read", "messages.send", "messages.mention", "events.read"],
      "events": ["task.submitted", "task.approved"],
      "clusterIds": ["<readable-and-event-cluster-id>"],
      "writeClusterIds": ["<writable-cluster-id>"]
    }
  ]
}
```

- **Separate read & write allowlists**: `clusterIds` grants read and event-stream visibility only; posting requires both `messages.send` AND listing the cluster ID in `writeClusterIds` (max 16 plugins, 32 commands each, 100 cluster IDs, no wildcards; omitted = empty).
- **Mention / wake control (`messages.mention` + `mentionEnabled`)**: Without `messages.mention` granted and `mentionEnabled` enabled in settings, `@mentions` in plugin messages never wake members; when both are enabled (alongside optional per-minute/per-hour rate limits), plugins **can mention and wake cluster members**.
- **Entry & asset verification**: `entry` must resolve inside the plugin directory (`.js`/`.mjs`/`.cjs`); `icon` validates file type/magic/root (`<= 256 KiB` `.png`/`.webp`/`.ico`/`.svg`, rejecting symlinks/escapes).
- Examples: [Message Counter](../examples/hub-plugins/message-counter/README.en.md) and [Review Reminder](../examples/hub-plugins/review-reminder/README.en.md).

## Runtime Operations & Limits

1. **Invoke & stop**: Authenticated `POST /api/plugins/:id/invoke` and `POST /api/plugins/:id/stop` (`{}`).
2. **Filtered event stream (`events.read`)**: Subscribes to `message.created`, `task.submitted`, `task.approved`, `task.rejected`, `task.merged`, `member.status` with bounded queues and drop counters.
3. **Write settings**: `PATCH /api/plugins/:id/write-settings` / UI toggles `mentionEnabled` and rate caps.

- Plugin crashes or timeouts stay isolated from the Hub scheduler; manifest/permission edits require a Hub restart; external plugins cannot inject web UI slots or browser scripts.
