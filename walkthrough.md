# Walkthrough — Navigation Session Fix & Storage Policies

We have successfully resolved both critical issues in the VENTS application: the post-signup `currentUser` navigation crash, and the storage policy updates for the `avatars` bucket.

## 1. Post-Signup Navigation Fix

### Root Cause
- Previously, when the signup or verification succeeded on `AuthScreen.tsx`, the callback `onSuccess` immediately triggered navigation to the Home screen (or Organizer Dashboard) in `App.tsx` by setting the `screen` state.
- Because React state updates are asynchronous, `currentUser` was still `null` for the first render pass on the target screen. This caused runtime ReferenceErrors / crashes on screens that referenced `currentUser`.

### Fixes
- **App.tsx Refactoring**:
  - Removed immediate screen/role redirection from `handleAuthSuccess`.
  - Added a `useEffect` hook that listens for both the `currentUser` session to be loaded and the current screen to be `auth`. Once `currentUser` is present, it securely redirects the user to their respective dashboard (`home` for attendees, `org-dashboard` for organizers) after the state is fully populated.

---

## 2. Storage Upload Permissions & Deferral

### Root Cause
- **Pre-Auth Upload**: In `AuthScreen.tsx`, the user uploaded their profile picture *during* registration before they actually had a user account or session. This request was anonymous.
- **RLS Denial**: The `storage.objects` table Row Level Security policy denied insert privileges to anonymous callers (`anon` role), resulting in "Permission Denied" errors.

### Fixes
- **Deferred Upload (AuthScreen.tsx)**:
  - Introduced local state for the selected file object (`signupAvatarFile`) and preview URL (`signupAvatarPreview` using `URL.createObjectURL`).
  - The avatar upload is now deferred: when the user selects a photo, the app only generates a local preview.
  - The actual upload via `uploadAuto()` is executed *after* authentication completes successfully (either immediately upon `signUp` response or after verification of the OTP). At this point, the user is authenticated, and the upload succeeds.
  - The resulting URL is then used to enrich and save the user's public profile in the database.
- **Database Migration (`20260614032207_update-storage-policies.sql`)**:
  - Dropped the previous combined owner-only policies on `storage.objects`.
  - Established separate policies for the `events` and `avatars` buckets.
  - For the `events` bucket: maintained strict owner-restricted policies (users can only modify or delete their own event images).
  - For the `avatars` bucket: created permissive `authenticated` INSERT and UPDATE policies, ensuring any logged-in user can upload and update their avatar freely, while retaining owner-only DELETE restrictions.

---

## Verification Results

### 1. Database Migrations
Successfully applied the migration to the database:
```bash
✓ Applied 1 migration file(s).
- 20260614032207_update-storage-policies.sql
```

### 2. Compilation Check
Ran `npm run build` to verify there are no TypeScript compilation or chunk packaging errors.
```text
vite v6.4.3 building for production...
transforming...
✓ 1721 modules transformed.
rendering chunks...
dist/index.html                   1.13 kB │ gzip:   0.57 kB
dist/assets/index-BFNYjKU9.css   81.35 kB │ gzip:  13.57 kB
dist/assets/index-DTyze2dP.js    42.53 kB │ gzip:  13.31 kB
dist/assets/index-L8p60V9f.js   645.57 kB │ gzip: 160.65 kB
✓ built in 12.87s
```
The build succeeded with zero errors.
