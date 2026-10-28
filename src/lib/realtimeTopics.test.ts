import { describe, it, expect } from 'vitest';
import { PRIVATE_CHANNEL_OPTIONS, dmTopic, userTopic } from './realtimeTopics';

const A = '0000000a-0000-0000-0000-00000000000a';
const B = '0000000b-0000-0000-0000-00000000000b';

describe('realtimeTopics', () => {
  it('userTopic is the lower-case user:<uuid> the database triggers publish to', () => {
    expect(userTopic(A)).toBe(`user:${A}`);
    expect(userTopic(A.toUpperCase())).toBe(`user:${A}`);
  });

  it('dmTopic is the same for both participants, ids sorted and lower-case', () => {
    expect(dmTopic(A, B)).toBe(`dm:${A}:${B}`);
    expect(dmTopic(B, A)).toBe(`dm:${A}:${B}`);
    expect(dmTopic(B.toUpperCase(), A)).toBe(`dm:${A}:${B}`);
  });

  it('the dm topic matches the exact shape the 0199 policy accepts', () => {
    const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    expect(dmTopic(B, A)).toMatch(new RegExp(`^dm:${uuid}:${uuid}$`));
  });

  it('channels are private and do not echo your own broadcasts', () => {
    expect(PRIVATE_CHANNEL_OPTIONS).toEqual({ config: { private: true, broadcast: { self: false } } });
  });
});
