# Follow-ups

Language: [中文](backlog.md) | **English**

- Plugin installs: explain replacement of the same ID and dependency downloads in the preview, improve retry messages, and provide installable public GitHub/npm examples.
- Storage and errors: clean old plugin versions and interrupted staging folders; improve Windows reserved-name, file-limit, and filesystem error messages. Sources currently accept any user-supplied HTTPS URL.
- Desktop language: existing status reasons can keep the previous language until the panel is reopened.
- Plugin install sources: plain HTTPS URLs and GitHub archive or release URLs have TLS only and no integrity check; npm dependencies are not listed before confirmation.
- Interface language: plugin-related pages (Skills & MCP, plugin configuration, plugin pages, plugin commands and parts of the plugin cards) still show Chinese in English mode.
- Reading native conversations: a Codex first `session_meta` line over 64 KiB makes the read return `unsupported`; several thinking blocks without id or index in one Claude answer are merged into one.
