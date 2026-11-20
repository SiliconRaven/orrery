import { TRANSCRIPT_MAX_ITEMS } from '../../core/native-transcript.ts';
import type { OfficialPlugin } from '../../core/plugin.ts';

const transcriptParams = new Set(['cursor', 'direction', 'limit']);

export const starmap: OfficialPlugin = {
  id: 'starmap',
  version: '0.10.0-beta.2',
  name: '星图',
  description: '在星图中按需查看成员当前绑定的原生对话。',
  details: '启用后，可在星图中读取成员已绑定的原生对话正文。正文按页读取，不写入 Hub 数据。',
  defaultEnabled: false,
  icon: 'starmap.svg',
  webModule: 'starmap',
  routes: [{
    method: 'GET',
    pattern: /^\/api\/clusters\/([^/]+)\/members\/([^/]+)\/transcript$/,
    noStore: true,
    handle: ({ hub, params: [clusterId, memberId], url }) => {
      // getMember excludes removed memberships and clusters in the recycle bin.
      if (hub.store.getMember(memberId)?.clusterId !== clusterId) {
        throw new Error('unknown member in cluster');
      }
      const query = url.searchParams;
      if ([...query.keys()].some((key) => !transcriptParams.has(key) || query.getAll(key).length !== 1)) {
        throw new Error('invalid transcript query parameters');
      }
      const cursor = query.get('cursor') ?? undefined;
      const direction = query.get('direction') ?? undefined;
      const rawLimit = query.get('limit');
      if (cursor === '' || (direction !== undefined && direction !== 'before' && direction !== 'after')) {
        throw new Error('invalid transcript query parameters');
      }
      let limit: number | undefined;
      if (rawLimit !== null) {
        limit = Number(rawLimit);
        if (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > TRANSCRIPT_MAX_ITEMS) {
          throw new Error('invalid transcript query parameters');
        }
      }
      return hub.memberTranscript(memberId, { cursor, direction, limit });
    },
  }],
};
