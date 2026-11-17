// The first line of everything delivered into a harness that shows a delivery as the user's own message (Kimi Code,
// Cursor): it tells the user and the model where the text came from. Cursor's adds the batch's hand-over id
// (docs/adapters/cursor.md, "送达确认").

/** `[orrery · 来自 A、B]`, or `[orrery · 来自 A · #1a2b3c4d]` with a hand-over id; `[orrery]` without senders. */
export function marker(from: string[] | undefined, handout?: string): string {
  const parts = ['orrery', ...(from?.length ? [`来自 ${from.join('、')}`] : []), ...(handout ? [`#${handout}`] : [])];
  return `[${parts.join(' · ')}]`;
}
