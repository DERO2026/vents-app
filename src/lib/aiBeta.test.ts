import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCallProjectAdminRpc } = vi.hoisted(() => ({ mockCallProjectAdminRpc: vi.fn() }));
vi.mock('../../api/_lib/projectAdminDb', () => ({ callProjectAdminRpc: mockCallProjectAdminRpc }));

import { isAiBetaUser } from '../../api/_lib/aiBeta';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isAiBetaUser', () => {
  it('calls is_ai_beta_user with exactly the userId, nothing else', async () => {
    mockCallProjectAdminRpc.mockResolvedValueOnce(true);
    const result = await isAiBetaUser('user-123');
    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('is_ai_beta_user', ['user-123']);
    expect(result).toBe(true);
  });

  it('returns false for any non-true RPC result (false, null, undefined) -- never treats ambiguity as approval', async () => {
    mockCallProjectAdminRpc.mockResolvedValueOnce(false);
    expect(await isAiBetaUser('user-123')).toBe(false);
    mockCallProjectAdminRpc.mockResolvedValueOnce(null);
    expect(await isAiBetaUser('user-123')).toBe(false);
    mockCallProjectAdminRpc.mockResolvedValueOnce(undefined);
    expect(await isAiBetaUser('user-123')).toBe(false);
  });

  it('fails CLOSED (not approved) on any error reaching or parsing the check', async () => {
    mockCallProjectAdminRpc.mockRejectedValueOnce(new Error('ECONNRESET'));
    expect(await isAiBetaUser('user-123')).toBe(false);
  });
});
