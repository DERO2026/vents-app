-- Financial-hardening: all 6 Storage buckets currently have
-- file_size_limit = null, meaning Supabase enforces no server-side cap at
-- all on object size -- only each client-side check (which a caller
-- bypassing the app's JS and talking to Storage directly simply skips).
-- This sets each bucket's limit to its largest legitimate client-side
-- check plus a small safety margin, without reducing any legitimate
-- upload. It does not touch bucket names, paths, public/private status,
-- allowed_mime_types, or any RLS policy.
--
-- avatars (client check: 8MB, MAX_AVATAR_BYTES in SettingsScreen/AuthScreen)
-- direct_messages (client check: 15MB, ConversationScreen.tsx)
-- events (client check: 15MB, CreateEventScreen.tsx via mediaPipeline)
-- service-providers (client check: 15MB, ServiceProviderSetupScreen.tsx)
-- highlights (no legitimate caller found; same general margin for consistency)
-- verification-docs (client check: 10MB, MAX_FILE_BYTES in both verification screens)
update storage.buckets set file_size_limit = 20971520 where id = 'avatars';
update storage.buckets set file_size_limit = 20971520 where id = 'direct_messages';
update storage.buckets set file_size_limit = 20971520 where id = 'events';
update storage.buckets set file_size_limit = 20971520 where id = 'service-providers';
update storage.buckets set file_size_limit = 20971520 where id = 'highlights';
update storage.buckets set file_size_limit = 15728640 where id = 'verification-docs';
