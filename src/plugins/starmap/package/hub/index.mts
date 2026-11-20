// The star map's Hub side (docs/starmap.md「2. Hub 接口」): one read-only route for a member's bound native conversation.
// This file is the official package's entry (docs/official-plugin-updates.md「制品合同」) and the built-in copy's source:
// it imports nothing, and gets everything it uses from `host` and the route context the Hub provides.

/** What this entry uses of the Hub (host API 1): the active-member lookup and the paged transcript read. */
interface StarmapHub {
  store: { getMember(memberId: string): { clusterId: string } | null | undefined };
  memberTranscript(memberId: string, request: { cursor?: string; direction?: 'before' | 'after'; limit?: number }): Promise<unknown>;
}

const transcriptParams = new Set(['cursor', 'direction', 'limit']);

export default function createPlugin(host: { transcriptMaxItems: number }) {
  return {
    name: '星图',
    description: '在星图中按需查看成员当前绑定的原生对话。',
    details: '启用后，可在星图中读取成员已绑定的原生对话正文。正文按页读取，不写入 Hub 数据。',
    routes: [{
      method: 'GET',
      pattern: /^\/api\/clusters\/([^/]+)\/members\/([^/]+)\/transcript$/,
      noStore: true as const,
      handle: ({ hub, params: [clusterId, memberId], url }: { hub: StarmapHub; params: string[]; url: URL }) => {
        // getMember excludes removed memberships and clusters in the recycle bin.
        if (hub.store.getMember(memberId)?.clusterId !== clusterId) {
          throw new Error('unknown member in cluster');
        }
        const query = url.searchParams;
        if ([...query.keys()].some((key) => !transcriptParams.has(key) || query.getAll(key).length !== 1)) {
          throw new Error('invalid transcript query parameters');
        }
        const cursor = query.get('cursor') ?? undefined;
        const direction = (query.get('direction') ?? undefined) as 'before' | 'after' | undefined;
        const rawLimit = query.get('limit');
        if (cursor === '' || (direction !== undefined && !['before', 'after'].includes(direction))) {
          throw new Error('invalid transcript query parameters');
        }
        let limit: number | undefined;
        if (rawLimit !== null) {
          limit = Number(rawLimit);
          if (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > host.transcriptMaxItems) {
            throw new Error('invalid transcript query parameters');
          }
        }
        return hub.memberTranscript(memberId, { cursor, direction, limit });
      },
    }],
  };
}
