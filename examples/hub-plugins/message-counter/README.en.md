# Message Counter Example Plugin

Language: [中文](README.md) | **English**

Standalone external plugin example (bundled with `orrery v0.10.0-beta.2` Beta pre-release; APIs may change) using Node built-ins only; copyable outside the repository with no Hub source imports.

Register the absolute path of `orrery-plugin.json` in a dedicated test `<ORRERY_HOME>/external-plugins.json` per [External Plugins](../../../docs/external-plugins.en.md), grant `clusters.read` and `messages.read` with target `clusterIds`, and restart the Hub.

Invoke via authenticated `POST /api/plugins/message-counter/invoke`:

```json
{"command":"count","arguments":{"clusterId":"<full-cluster-id>"}}
```

- You can also type `/` at the start of the composer in a granted group and pick the count command: the group then comes from the call's `context`, and the result appears as a page notice for you only, never in the chat.
- Counts up to the newest 100 messages grouped by sender (adds `truncated: true` if oversized payloads fill one frame).
- Unauthorized or deleted clusters fail cleanly; disable in Settings or stop immediately via `POST /api/plugins/message-counter/stop` (`{}`).
- Run trusted plugins only: separate processes are not OS security sandboxes.
