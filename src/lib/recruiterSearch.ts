// Representative "Find" tab search.
//
// Primary path: search_recruiter_invite_targets (migration 0204), which
// matches partial usernames/names and returns only invitable users
// (organizers and approved service providers) with their eligibility.
//
// 0204 is not applied to production yet. Until it is, PostgREST answers
// PGRST202 ("function not found") and this falls back to the existing
// search_users_for_request (0069): prefix-only matching over all users,
// with eligibility resolved per user on selection, as before.
//
// Errors are never swallowed: callers get a typed SearchError so the
// screen can say "too many searches" or "disabled in Preview" instead
// of showing an empty "No matches found".

import { supabase } from './supabase';
import { searchUsers, type UserSearchResult } from './userSearch';

export interface RecruiterSearchResult extends UserSearchResult {
  // null = unknown (fallback path): resolve with get_recruiter_invite_target.
  isOrganizer: boolean | null;
  providerId: string | null;
}

export type SearchErrorKind = 'rate_limited' | 'preview' | 'not_representative' | 'network' | 'unknown';

export class SearchError extends Error {
  kind: SearchErrorKind;
  constructor(kind: SearchErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = 'SearchError';
  }
}

export const MIN_QUERY_LENGTH = 2;

/** Strip whitespace and a leading '@' (how usernames are shown in the app). */
export function normalizeQuery(raw: string): string {
  return raw.trim().replace(/^@+/, '').trim();
}

function isMissingFunction(err: any): boolean {
  return err?.code === 'PGRST202' || /could not find the function/i.test(String(err?.message ?? ''));
}

export function classifySearchError(err: any): SearchError {
  const code = String(err?.code ?? '');
  const message = String(err?.message ?? '');
  if (code === 'PREVIEW_READ_ONLY') {
    return new SearchError('preview', 'Search is disabled in this Preview build because it shares production data. It works in the production app.');
  }
  if (code === 'P0429' || /rate_limited/i.test(message)) {
    return new SearchError('rate_limited', 'Too many searches in the last minute. Wait a moment, then try again.');
  }
  if (/only active representatives/i.test(message)) {
    return new SearchError('not_representative', 'Only active representatives can search for partners.');
  }
  if (/failed to fetch|network|load failed|timeout/i.test(message)) {
    return new SearchError('network', 'Could not reach VENTS. Check your connection and try again.');
  }
  return new SearchError('unknown', 'Search failed. Please try again.');
}

export async function searchRecruiterTargets(rawQuery: string): Promise<RecruiterSearchResult[]> {
  const query = normalizeQuery(rawQuery);
  if (query.length < MIN_QUERY_LENGTH) return [];

  let data: any;
  let error: any;
  try {
    ({ data, error } = await supabase.rpc('search_recruiter_invite_targets' as any, { p_query: query }));
  } catch (thrown) {
    throw classifySearchError(thrown);
  }

  if (error && isMissingFunction(error)) {
    try {
      const rows = await searchUsers(query);
      return rows.map((r) => ({ ...r, isOrganizer: null, providerId: null }));
    } catch (fallbackErr) {
      throw classifySearchError(fallbackErr);
    }
  }
  if (error) throw classifySearchError(error);

  return (Array.isArray(data) ? data : []).map((row: any) => ({
    id: row.id,
    username: row.username ?? null,
    fullName: row.full_name ?? null,
    avatarUrl: row.avatar_url ?? null,
    isOrganizer: row.target_is_organizer === true,
    providerId: row.target_provider_id ?? null,
  }));
}
