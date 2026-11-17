# Review Reminder Example Plugin

Language: [中文](README.md) | **English**

Standalone external plugin example (bundled with `orrery v0.10.0-beta.1` Beta pre-release; APIs may change) using Node built-ins only. Subscribes to `task.submitted`, waits 5 minutes, and posts one reminder attributed as `"插件 review-reminder"` (without `messages.mention`, so no member is woken) if no `task.approved`, `task.rejected`, or `task.merged` arrives. Resubmitting resets the timer; self-review completions do not trigger reminders.

## Running in a Dedicated Test Environment

1. Run the automated plugin test:
   ```powershell
   node --test --test-name-pattern 'standalone review reminder' test/external-plugins.test.ts
   ```
2. Or launch a separate mock Hub (never use port `4317` or default `~/.orrery`):
   ```powershell
   $demo = Join-Path $env:TEMP ('orrery-review-reminder-' + [guid]::NewGuid())
   $env:ORRERY_HOME = Join-Path $demo 'home'
   $env:ORRERY_DB = Join-Path $demo 'orrery.db'
   $env:ORRERY_PORT = '14917'
   $env:ORRERY_MOCK = '1'
   npm run open
   ```
   Create a `mock` cluster (grab its ID from `#c=...` or `GET /api/clusters`), copy this folder outside the repo (optionally shortening `REMINDER_DELAY_MS` in `main.mjs`), write `$demo\home\external-plugins.json`, and restart the temp Hub:

   ```json
   {
     "plugins": [{
       "manifest": "C:/projects/review-reminder/orrery-plugin.json",
       "permissions": ["events.read", "messages.send"],
       "events": ["task.submitted", "task.approved", "task.rejected", "task.merged"],
       "clusterIds": ["<full-cluster-id>"],
       "writeClusterIds": ["<full-cluster-id>"]
     }]
   }
   ```

   Reminders only post to clusters listed in **both** `clusterIds` (event read) and `writeClusterIds` (message write). Stop immediately via authenticated `POST /api/plugins/review-reminder/stop` (`{}`).

## Behavior Limits

- Does not replay submissions prior to startup; clears active timers if an event-loss notice arrives; task cancellation/reopen events are unsubscribed so pre-existing timers may still fire.
- Process separation isolates faults, not OS privileges; run trusted plugins only. See [External Plugins](../../../docs/external-plugins.en.md).
