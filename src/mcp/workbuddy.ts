// Native WorkBuddy (docs/adapters/workbuddy.md). Its stdio MCP bridge (plugins/workbuddy-orrery/bridge.mjs) takes the id
// from CODEBUDDY_SESSION_ID or else its WorkBuddy.exe parent's --session-id, and sends it as x-orrery-session with the Hub
// secret. That stops a model from naming another conversation in tool arguments, not an agent that can read local files
// (it can read the secret: docs/security.md). Nothing here reads identity from _meta. The tickets, wait connections and
// wait command are the shared background-wait route (./wait-core.ts) with WorkBuddy's settings.
import type { Hub } from '../core/hub.ts';
import { WORKBUDDY_WAIT } from '../core/types.ts';
import * as core from './wait-core.ts';

export const WORKBUDDY = WORKBUDDY_WAIT.harness;

export const ticketFor = (secret: string, sessionId: string): string => core.ticketFor(WORKBUDDY_WAIT, secret, sessionId);

export const ticketSession = (secret: string, ticket: unknown): string | null => core.ticketSession(WORKBUDDY_WAIT, secret, ticket);

export const waitCommand = (ticket: string, hubUrl: string, script?: string): string => core.waitCommand(WORKBUDDY_WAIT, ticket, hubUrl, script);

/** The wait registry of this Hub for WorkBuddy, made on first use. */
export const waitsOf = (hub: Hub, secret: string): core.WaitRegistry => core.waitsOf(WORKBUDDY_WAIT, hub, secret);
