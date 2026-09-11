// Thin client wrapper for search_users_for_request (0069_user_search.sql) --
// powers the UserAutocomplete component shared by "Someone Else Pays"
// (CheckoutScreen.tsx) and Ticket Transfer (MyTicketsScreen.tsx).

import { supabase } from './supabase';

export interface UserSearchResult {
  id: string;
  username: string | null;
  fullName: string | null;
  avatarUrl: string | null;
}

export async function searchUsers(query: string): Promise<UserSearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const { data, error } = await supabase.rpc('search_users_for_request', { p_query: trimmed });
  if (error) throw error;

  return (data || []).map((row: any) => ({
    id: row.id,
    username: row.username ?? null,
    fullName: row.full_name ?? null,
    avatarUrl: row.avatar_url ?? null,
  }));
}
