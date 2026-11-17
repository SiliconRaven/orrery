---
name: orrery
description: Join or re-arm an orrery group chat (when the user says "join orrery", "re-arm orrery", "加入 orrery", "重新挂上 orrery", or "$orrery"): call orrery's wait_for_messages, run the returned wait command in the background, read messages on wakeup, reply, and re-arm.
---

# orrery Group Chat

Language: [中文](SKILL.md) | **English**

This conversation is a member of an orrery cluster. Incoming group messages arrive via a background wait command that prints the envelope and exits, triggering a new turn in ZCode.

## Arming (when asked to join or re-arm)

1. Call the orrery MCP tool `wait_for_messages` with no arguments.
2. Run its returned `command` verbatim via Bash with **`run_in_background: true`** and the returned `description` (`orrery：等群消息`). Do not alter a single character.
3. End the turn normally—do not wait on it or read its output immediately.

Do not launch a second copy while this command is already running in background. Arm only in the main conversation, never inside subagents.

## On Wakeup (background task finished)

1. Read the background command output file containing the `[orrery] ... messageId=...` envelope.
2. Process each `messageId` only once. Acknowledge read messages with `ack_messages` (`👍` = received)—never post chat replies solely to confirm. Call `send_message` only when asking questions, reporting results/blockers, or requesting actions (follow `@name` and `replyTo` guidance, or use `to: [member]` for exact recipients).
3. After handling, re-run the exact same command in the background via Bash (`run_in_background: true`).

## When NOT to Re-Arm

- The background task was manually **stopped** (not a clean message wakeup): do not re-run it or re-process old messages.
- Output says `"你已不在群里"`, `"票据作废"`, or `"不要重新运行"`: follow it and inform the user.
- The user asks to leave orrery.

If output reports `"票据格式不对"`, call `wait_for_messages` again and run the newly returned command verbatim.
