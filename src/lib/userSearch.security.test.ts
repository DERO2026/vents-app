import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis tests for search_users_for_request (0069_user_search.sql),
// the RPC behind the "Someone Else Pays" / Ticket Transfer user autocomplete
// (UserAutocomplete.tsx). public.users has no public read policy
// (select_own_user is own-row-only) -- this function is the one deliberate,
// narrow hole in that, so it needs to stay authenticated-only, rate-limited,
// self-excluding, and field-limited.

let m0069: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0069 = readFileSync(join(dir, '0069_user_search.sql'), 'utf8');
});

describe('search_users_for_request: authenticated-only, self-excluding, rate-limited, field-limited', () => {
  it('is never reachable by anon or PUBLIC', () => {
    expect(m0069).toMatch(/REVOKE ALL ON FUNCTION public\.search_users_for_request\(text\) FROM PUBLIC, anon;/);
    expect(m0069).toMatch(/GRANT EXECUTE ON FUNCTION public\.search_users_for_request\(text\) TO authenticated;/);
  });

  it('requires authentication', () => {
    expect(m0069).toMatch(/IF v_uid IS NULL THEN\s*\n\s*RAISE EXCEPTION 'Not authenticated';/);
  });

  it('excludes the caller from their own search results', () => {
    expect(m0069).toMatch(/AND u\.id <> v_uid/);
  });

  it('is rate-limited', () => {
    expect(m0069).toMatch(/PERFORM public\.check_rate_limit\('search_users:' \|\| v_uid::text, 30, 60\);/);
  });

  it('requires a minimum query length before searching, to blunt single-character enumeration', () => {
    expect(m0069).toMatch(/IF v_query IS NULL OR length\(v_query\) < 2 THEN\s*\n\s*RETURN;/);
  });

  it('returns only username/full_name/avatar_url -- never email, phone, or other account fields', () => {
    const returns = m0069.match(/RETURNS TABLE\(([^)]*)\)/)?.[1] ?? '';
    expect(returns).toMatch(/id uuid, username text, full_name text, avatar_url text/);
    const selectClause = m0069.match(/SELECT u\.id, u\.username, u\.full_name, u\.avatar_url/);
    expect(selectClause).not.toBeNull();
    expect(m0069).not.toMatch(/u\.email\s*,|u\.phone_number\s*,/);
  });

  it('excludes deleted users', () => {
    expect(m0069).toMatch(/u\.deleted_at IS NULL/);
  });

  it('excludes users without a username -- the only field the downstream resolution RPCs (create_pending_purchase/initiate_ticket_transfer) can match a selected suggestion against, alongside email which this function never exposes', () => {
    expect(m0069).toMatch(/AND u\.username IS NOT NULL/);
  });

  it('caps results', () => {
    expect(m0069).toMatch(/LIMIT 8;/);
  });
});

describe('UserAutocomplete: selecting a suggestion always produces a valid, matchable username identifier', () => {
  let autocompleteSrc: string;

  beforeAll(() => {
    autocompleteSrc = readFileSync(
      join(__dirname, '..', 'app', 'components', 'shared', 'UserAutocomplete.tsx'),
      'utf8'
    );
  });

  it('fills the identifier from username only -- never full_name, which the resolution RPCs cannot match', () => {
    expect(autocompleteSrc).toMatch(/const identifier = user\.username \|\| '';/);
    expect(autocompleteSrc).not.toMatch(/user\.username \|\| user\.fullName/);
  });

  it('still shows full_name in the suggestion row UI (display-only, not the fillable value)', () => {
    expect(autocompleteSrc).toMatch(/\{user\.fullName \|\| user\.username \|\| 'VENTS user'\}/);
  });
});
