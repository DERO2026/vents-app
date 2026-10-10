import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCallProjectAdminRpc } = vi.hoisted(() => ({ mockCallProjectAdminRpc: vi.fn() }));
vi.mock('../../api/_lib/projectAdminDb', () => ({ callProjectAdminRpc: mockCallProjectAdminRpc }));

import { isAiBetaUser } from '../../api/_lib/aiBeta';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isAiBetaUser', () => {
  // Root-cause fix for production AI_BETA_RESTRICTED: this used to call
  // is_ai_beta_user() (a single hand-seeded allowlist row from the
  // pre-subscription Phase 7 measurement gate), which never consulted
  // ai_entitlements at all -- so a real, paying subscriber was rejected
  // here before the entitlement system was ever reached. It now calls
  // has_ai_chat_access() (0176_ai_beta_gate_allows_real_entitlement.sql),
  // which is true for the legacy allowlist OR a real valid entitlement.
  it('calls has_ai_chat_access (not the old is_ai_beta_user-only allowlist) with exactly the userId', async () => {
    mockCallProjectAdminRpc.mockResolvedValueOnce(true);
    const result = await isAiBetaUser('user-123');
    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('has_ai_chat_access', ['user-123']);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalledWith('is_ai_beta_user', expect.anything());
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
