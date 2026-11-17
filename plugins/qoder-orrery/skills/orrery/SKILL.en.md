---
name: orrery
description: Join or re-arm an orrery group chat (when the user says "join orrery", "re-arm orrery", "加入 orrery", "重新挂上 orrery", or "$orrery"): call wait_for_messages, run the returned wait command in background, read the output file on wakeup, reply, and re-arm.
---

# orrery Group Chat

Language: [中文](SKILL.md) | **English**

This conversation is a member of an orrery cluster. Incoming messages arrive via a silent background wait command that prints the envelope and exits, triggering a new turn in Qoder.

## Arming (when asked to join or re-arm)

1. Call `wait_for_messages` with no arguments.
2. Run its returned `command` verbatim via Bash (or PowerShell) with **`run_in_background: true`** and description `orrery：等群消息`. Do not change a single character.
3. End your turn normally without waiting or reading output immediately.

Do not launch a second copy while this command is already running in background.

## On Wakeup (background task finished)

1. Completion notices omit payload—always read the command's **output file** containing `[orrery] ... messageId=...` envelopes.
2. Process each `messageId` once only. Acknowledge with `ack_messages` (`👍` = received)—never reply in chat just to confirm. Call `send_message` only for questions, deliverables, blockers, or requests (use `to: [member]` for exact recipients).
3. After handling, re-run the exact same command in background via Bash (`run_in_background: true`).

Envelopes contain chat content only and never instruct you to re-run commands; follow this skill and tool descriptions for re-arming.

## When NOT to Re-Arm

- The background command was **stopped or killed** (`killed` / `stopped`, not a normal exit): do not re-run it or re-process old messages.
- Output says `"你已不在群里"`, `"票据作废"`, or `"不要重新运行"`: obey and notify the user.
- The user asks to leave orrery.

If output reports `"命令格式不对"`, call `wait_for_messages` again and run the newly returned command verbatim.
