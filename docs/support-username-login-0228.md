# Username login after migration 0228: release and support notes

**Decision D7 (owner-approved 2026-11-26):** the old username lookup is revoked immediately through 0228. Older installed iOS and Android versions may lose username login and may need email login or an app update.

## What changes

| Where | Username login | Email login |
|---|---|---|
| Website (getvents.com), once #125 is deployed | Works, unchanged for users | Works |
| App builds that include #125 (the next release) | Works | Works |
| **Installed app builds from before #125** (1.3.0 and earlier), once 0228 is applied | **Stops working.** The app shows "We couldn't verify your login right now. Please check your connection and try again." | **Works** |

Nothing else changes: passwords, accounts, tickets, wallets and sign-up are unaffected.

## Why

The old lookup returned **any** user's email address to **anyone** who knew their public username, which exposed the email of every account (finding H2). The replacement returns the email only when the password is also correct. Old app builds still call the old lookup and get that message: they show the same text for any lookup failure, so a clearer message isn't possible for them.

## Rollout order (from the repair tracker)

1. Apply 0227: adds the new lookup, safe for every build.
2. Merge #125: the website switches to the new lookup.
3. **Immediately apply 0228**: the old lookup is closed. From this point old app builds lose username login.
4. Ship the next app release (it includes #125) and post the support notes below.

Optional: once the next release is live in both stores, raise the minimum supported app version, so old builds are asked to update instead of showing the login error.

## Release-note line (app stores and website)

> Security update: we've made signing in more private. If you use an older version of the VENTS app and can't sign in with your username, sign in with your email address instead, or update the app.

## Support macro

> **Can't sign in with my username / "We couldn't verify your login right now"**
>
> Thanks for reaching out. We recently strengthened how VENTS protects account details, and older versions of the app can no longer sign in with a username. Your account and tickets are safe. To get back in:
> 1. Sign in with the **email address** on your account and your usual password, **or**
> 2. Update VENTS from the App Store / Google Play, then sign in as normal.
>
> If you don't remember which email you used, reply with your username and we'll help you after verifying the account. We'll never ask for your password.

**Notes for support staff:**
- **Never** tell someone the email address on an account based only on a username. That is exactly the exposure 0228 closes. Verify the person first, through the existing account-recovery process.
- "Forgot password" on any build still works by email.
- If someone on the **latest** app or the website reports this error, it isn't this change. Escalate it as a possible outage, since username login should work there.

## How to tell if this is the cause

- The person is on an app version older than the release that includes #125.
- Email login works for them.
- The error appeared after the date 0228 was applied (record that date here: **not yet applied**).
