import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for 0195_direct_messages_storage_private_access.sql.
//
// This suite is static: it reads the literal migration SQL and asserts on
// its text, following the same convention as
// directMessagesGrantHardening.security.test.ts (0194) /
// platformFeeAllocation.security.test.ts. It does NOT execute SQL against
// a live database.
//
// Covers three access scenarios at the policy-text level:
//   (a) authorized access  -- the EXISTS clause matches a direct_messages
//       row where the requester is sender_id OR recipient_id, OR the
//       requester is the object's own owner_id (pre-row upload window).
//   (b) unauthorized authenticated access -- a different authenticated
//       user matches neither the owner_id branch nor the EXISTS branch
//       (no row names them as sender/recipient of that object), so the
//       USING clause evaluates false and the row is excluded.
//   (c) unauthenticated access -- the policy is `TO authenticated` only
//       (no `public`/`anon` role), so an anon-role or unauthenticated
//       request to storage.objects never matches this policy's role list
//       at all, independent of its USING clause.

let migration: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  migration = readFileSync(
    join(dir, '0195_direct_messages_storage_private_access.sql'),
    'utf8'
  );
});

describe('0195_direct_messages_storage_private_access.sql', () => {
  it('makes the direct_messages bucket private', () => {
    expect(migration).toMatch(
      /UPDATE\s+storage\.buckets\s+SET\s+public\s*=\s*false\s+WHERE\s+id\s*=\s*'direct_messages'\s*;/i
    );
  });

  it('drops and recreates storage_objects_dm_select scoped to authenticated only (c: unauthenticated access)', () => {
    expect(migration).toMatch(/DROP\s+POLICY\s+IF\s+EXISTS\s+storage_objects_dm_select\s+ON\s+storage\.objects\s*;/i);
    const createMatch = migration.match(
      /CREATE\s+POLICY\s+storage_objects_dm_select\s+ON\s+storage\.objects\s+FOR\s+SELECT\s+TO\s+(\w+)/i
    );
    expect(createMatch).not.toBeNull();
    expect(createMatch![1].toLowerCase()).toBe('authenticated');
    // Must not also grant to public/anon -- that would reopen the exact
    // gap this migration exists to close.
    expect(migration).not.toMatch(/CREATE\s+POLICY\s+storage_objects_dm_select[\s\S]*?TO\s+public/i);
    expect(migration).not.toMatch(/CREATE\s+POLICY\s+storage_objects_dm_select[\s\S]*?TO\s+anon/i);
  });

  it('no longer allows an unqualified bucket_id-only read (the original unrestricted-SELECT gap)', () => {
    // The old policy body was exactly `USING (bucket_id = 'direct_messages')`
    // with nothing else. Assert the new policy's USING clause is NOT that
    // bare condition -- it must have further restrictions.
    const policyBlock = migration.match(/CREATE\s+POLICY\s+storage_objects_dm_select[\s\S]*?;/i)?.[0] || '';
    expect(policyBlock).not.toMatch(/USING\s*\(\s*bucket_id\s*=\s*'direct_messages'\s*\)\s*;/i);
  });

  it('authorizes read when the requester is sender_id or recipient_id of a matching direct_messages row (a: authorized access)', () => {
    const policyBlock = migration.match(/CREATE\s+POLICY\s+storage_objects_dm_select[\s\S]*?;/i)?.[0] || '';
    expect(policyBlock).toMatch(/EXISTS\s*\(/i);
    expect(policyBlock).toMatch(/FROM\s+public\.direct_messages\s+dm/i);
    expect(policyBlock).toMatch(/dm\.sender_id\s*=\s*\(SELECT\s+auth\.uid\(\)\)/i);
    expect(policyBlock).toMatch(/dm\.recipient_id\s*=\s*\(SELECT\s+auth\.uid\(\)\)/i);
  });

  it('also authorizes the object owner directly, covering the pre-message-row upload window (a: authorized access)', () => {
    const policyBlock = migration.match(/CREATE\s+POLICY\s+storage_objects_dm_select[\s\S]*?;/i)?.[0] || '';
    expect(policyBlock).toMatch(/owner_id\s*=\s*\(SELECT\s+auth\.uid\(\)\)::text/i);
  });

  it('joins on the object name as a suffix of the stored image_url, not an unrestricted bucket match (b: unauthorized authenticated access is excluded by default)', () => {
    const policyBlock = migration.match(/CREATE\s+POLICY\s+storage_objects_dm_select[\s\S]*?;/i)?.[0] || '';
    expect(policyBlock).toMatch(/dm\.image_url\s+LIKE\s+'%\/'\s*\|\|\s*storage\.objects\.name/i);
  });

  it('does not touch direct_messages RLS or any other bucket/policy', () => {
    // Only the executable statements matter here -- comment prose is
    // allowed to reference these names for context (it does, extensively,
    // above). Strip SQL line comments before asserting.
    const executable = migration.replace(/^--.*$/gm, '');
    expect(executable).not.toMatch(/CREATE\s+POLICY\s+dm_select/i);
    expect(executable).not.toMatch(/CREATE\s+POLICY\s+dm_update/i);
    expect(executable).not.toMatch(/CREATE\s+POLICY\s+dm_delete/i);
    expect(executable).not.toMatch(/storage_objects_dm_insert/i);
    expect(executable).not.toMatch(/storage_objects_dm_update/i);
    expect(executable).not.toMatch(/storage_objects_dm_delete/i);
    expect(executable).not.toMatch(/'avatars'|'events'|'highlights'|'service-providers'|'verification-docs'/i);
  });

  it('does not touch send_direct_message or any messaging/payment business logic', () => {
    const executable = migration.replace(/^--.*$/gm, '');
    expect(executable).not.toMatch(/send_direct_message|commission|payout|platform_fee_kobo|recruiter_partnerships/i);
  });
});

// Regression tests for the client-side object-key extraction used by
// ConversationScreen.tsx to request a signed URL for a stored image_url,
// now that the bucket is private and getPublicUrl() no longer serves a
// fetchable URL.
describe('ConversationScreen.tsx: DM image key extraction and signed-URL usage', () => {
  let conversationScreenSrc: string;

  beforeAll(() => {
    conversationScreenSrc = readFileSync(
      join(__dirname, '..', 'app', 'components', 'ConversationScreen.tsx'),
      'utf8'
    );
  });

  it('extracts the object key as everything after the last "/" in the stored URL', () => {
    // Avoid re-implementing the function by import (it's not exported);
    // assert the exact slice logic is present instead, matching the
    // stored URL shape confirmed live:
    // https://<project>.supabase.co/storage/v1/object/public/direct_messages/<key>
    expect(conversationScreenSrc).toMatch(
      /function getDmImageKey\(storedUrl: string\): string \{\s*return storedUrl\.slice\(storedUrl\.lastIndexOf\('\/'\) \+ 1\);\s*\}/
    );
    const getDmImageKey = (storedUrl: string): string => storedUrl.slice(storedUrl.lastIndexOf('/') + 1);
    expect(getDmImageKey(
      'https://slrtjxtzhowhwhebjprv.supabase.co/storage/v1/object/public/direct_messages/dm-1791644280052-6c8c8b91-c79f-4041-8202-1fb5b8d0fa69.jpg'
    )).toBe('dm-1791644280052-6c8c8b91-c79f-4041-8202-1fb5b8d0fa69.jpg');
  });

  it('calls createSignedUrl (not getPublicUrl) when resolving an existing message image for display', () => {
    expect(conversationScreenSrc).toMatch(/createSignedUrl\(key, DM_IMAGE_SIGNED_URL_TTL_SECONDS\)/);
  });

  it('renders the message image from signedImageUrls, never directly from m.image_url', () => {
    expect(conversationScreenSrc).toMatch(/signedImageUrls\[m\.id\]/);
    // The <img> tag in the message-bubble renderer must not use m.image_url as its src.
    expect(conversationScreenSrc).not.toMatch(/<img\s+src=\{m\.image_url\}/);
  });

  it('the lightbox never receives the raw stored image_url, only a resolved signed URL', () => {
    expect(conversationScreenSrc).not.toMatch(/setLightboxUrl\(m\.image_url!?\)/);
  });

  it('still stores the getPublicUrl()-shaped string as image_url when sending (unchanged persisted format, no data migration)', () => {
    expect(conversationScreenSrc).toMatch(/getPublicUrl\(key\)/);
    expect(conversationScreenSrc).toMatch(/p_image_url:\s*url/);
  });
});
