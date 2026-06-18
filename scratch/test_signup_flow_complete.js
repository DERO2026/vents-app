import { createClient } from '@insforge/sdk';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Parse .env.local
const envPath = path.resolve('.env.local');
const envContent = fs.readFileSync(envPath, 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
  if (match) {
    const key = match[1];
    let value = match[2] || '';
    if (value.length > 0 && value.startsWith('"') && value.endsWith('"')) {
      value = value.substring(1, value.length - 1);
    }
    env[key] = value;
  }
});

const insforge = createClient({
  baseUrl: env.VITE_INSFORGE_URL,
  anonKey: env.VITE_INSFORGE_ANON_KEY,
});

async function verifyUserInDb(email) {
  console.log(`[DB] Confirming email for ${email}...`);
  const cmd = `npx @insforge/cli db query "UPDATE auth.users SET email_verified = true WHERE email = '${email}';" --json`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      execSync(cmd, { encoding: 'utf8' });
      console.log(`[DB] Confirm email succeeded.`);
      return;
    } catch (err) {
      if (attempt === 5) throw err;
      console.warn(`[DB] Confirm email failed (attempt ${attempt}/5). Retrying in 2s...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

async function testFlow(role) {
  const suffix = Math.floor(Math.random() * 1000000);
  const email = `test-${role}-${suffix}@example.com`;
  const password = "Password123!";
  const name = `Test Name ${suffix}`;
  const username = `test${role}${suffix}`;
  const phone = `+234803${String(suffix).padStart(6, '0')}`;
  const state = "Lagos";

  console.log(`\n=== Testing Flow for Role: ${role} ===`);
  
  // 1. SignUp with JSON-serialized name containing the role
  const signupRes = await insforge.auth.signUp({
    email,
    password,
    name: JSON.stringify({
      n: name,
      r: role
    }),
    redirectTo: "http://localhost:3000"
  });

  if (signupRes.error) {
    throw new Error(`Signup failed: ${signupRes.error.message}`);
  }
  console.log("Signup call succeeded.");

  // Wait 1.5 seconds for the DB trigger to finish creating user
  await new Promise(resolve => setTimeout(resolve, 1500));

  // Query database using SDK directly (with public anon key)
  const { data: initialProfile, error: queryErr } = await insforge.database
    .from('users')
    .select('role, full_name')
    .eq('email', email)
    .maybeSingle();

  if (queryErr) {
    throw new Error(`Failed to query initial profile: ${queryErr.message}`);
  }

  console.log("Initial database profile immediately after signup:", initialProfile);

  if (!initialProfile) {
    throw new Error(`CRITICAL: Profile not created in public.users for email ${email}`);
  }

  if (initialProfile.role !== role) {
    throw new Error(`CRITICAL: Expected role '${role}' to be stored immediately after signup, but got '${initialProfile.role}'`);
  }
  console.log(`✅ Stored role correctly as '${role}' immediately after signup!`);

  // 2. Confirm email in DB (simulating OTP verification)
  await verifyUserInDb(email);

  // 3. Sign In (authenticates user)
  console.log("Signing in...");
  const signinRes = await insforge.auth.signInWithPassword({
    email,
    password
  });

  if (signinRes.error) {
    throw new Error(`SignIn failed: ${signinRes.error.message}`);
  }
  const userId = signinRes.data.user.id;

  // 4. Update the remaining profile fields (simulating fetchProfileAndSucceed)
  console.log("Updating username, phone and state...");
  const { data: updated, error: updateError } = await insforge.database
    .from('users')
    .update({ username, phone_number: phone, state })
    .eq('id', userId)
    .select()
    .maybeSingle();

  if (updateError) {
    throw new Error(`Failed to update profile fields: ${updateError.message}`);
  }
  console.log("Updated database profile:", updated);

  if (updated.role !== role) {
    throw new Error(`CRITICAL: Login or update overwrote role! Expected '${role}', got '${updated.role}'`);
  }
  console.log(`✅ Verification success for role: ${role}`);
}

async function run() {
  try {
    await testFlow('attendee');
    await testFlow('organizer');
    console.log("\n=== ALL FLOW TESTS PASSED! ===");
    process.exit(0);
  } catch (err) {
    console.error("\n❌ TEST FAILED:", err);
    process.exit(1);
  }
}

run();
