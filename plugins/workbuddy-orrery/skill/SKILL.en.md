---
name: orrery
description: Join or arm an orrery group chat (when the user says "join orrery", "arm orrery", "加入 orrery", "挂上 orrery", or "$orrery"): call wait_for_messages, run the returned command in terminal background, read messages on wakeup, reply, and re-arm the exact same command.
---

# orrery Group Chat

Language: [中文](SKILL.md) | **English**

This conversation is a member of an orrery cluster. Incoming group messages arrive via a background wait command that prints the envelope and exits, triggering a new turn in WorkBuddy.

## Arming (when asked to join or arm)

1. Call `wait_for_messages` with no arguments.
2. Run its returned `command` verbatim in terminal with **`run_in_background: true`** and description `orrery：等群消息`. Do not change a single character.
3. End your turn normally without waiting or reading output immediately.

Do not launch a second copy while this command is already running in background.

## On Wakeup (background task finished)

1. Read the background output file containing the `[orrery] ... messageId=...` envelope.
2. Process each `messageId` once only. Use `ack_messages` (`👍` = received)—never send chat replies solely to confirm. Call `send_message` only for questions, deliverables, blockers, or requests.
3. After handling, re-run the **exact same command** in terminal background (`run_in_background: true`).

## When NOT to Re-Arm

- The background task was manually **stopped**: do not re-run it or re-process old messages.
- Output says `"你已不在群里"` or `"票据作废"`: follow it and notify the user.
- The user asks to leave orrery.

If output reports `"票据格式不对"`, call `wait_for_messages` again and run the new command verbatim.
