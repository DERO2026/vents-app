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

async function verifyEmailInDb(email) {
  console.log(`[Test] Verifying email for ${email} directly in database...`);
  const cmd = `npx @insforge/cli db query "UPDATE auth.users SET email_verified = true WHERE email = '${email}';" --json`;
  execSync(cmd, { encoding: 'utf8' });
  console.log(`[Test] Email verification query executed successfully.`);
}

async function run() {
  const suffix = Math.floor(Math.random() * 1000000);
  const email = `test-new-org-${suffix}@example.com`;
  const password = "Password123!";
  const name = `Test New Org Name ${suffix}`;
  const selectedRole = "organizer";

  console.log("=== STEP 1: Calling insforge.auth.signUp with plain name (NO JSON serialization) ===");
  const signupRes = await insforge.auth.signUp({
    email,
    password,
    name: name,
    redirectTo: "http://localhost:3000"
  });

  if (signupRes.error) {
    throw new Error(`Signup failed: ${signupRes.error.message}`);
  }
  console.log("SignUp Response:", JSON.stringify(signupRes, null, 2));

  // Query database using CLI to get the user ID
  const idQueryCmd = `npx @insforge/cli db query "SELECT id FROM auth.users WHERE email = '${email}'" --json`;
  const idQueryResult = JSON.parse(execSync(idQueryCmd, { encoding: 'utf8' }));
  if (!idQueryResult.rows || idQueryResult.rows.length === 0) {
    throw new Error("User was not created in auth.users");
  }
  const userId = idQueryResult.rows[0].id;
  console.log(`SignUp succeeded. User ID from DB: ${userId}`);

  // Poll database to make sure the trigger finished inserting the user record into public.users with default role 'user'
  console.log("Waiting for trigger to insert user into public.users with default role...");
  let initialProfile = null;
  for (let i = 0; i < 10; i++) {
    const { data } = await insforge.database
      .from('users')
      .select('role')
      .eq('id', userId)
      .maybeSingle();
    if (data) {
      initialProfile = data;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log("Initial role in public.users immediately after trigger:", initialProfile?.role);

  console.log("=== STEP 2: Simulating email verification ===");
  await verifyEmailInDb(email);

  console.log("=== STEP 3: Signing in to authenticate the client session ===");
  const signinRes = await insforge.auth.signInWithPassword({
    email,
    password
  });
  if (signinRes.error) {
    throw new Error(`Sign in failed: ${signinRes.error.message}`);
  }
  console.log("Sign in succeeded. Client session is now authenticated.");

  console.log(`=== STEP 4: Performing direct database update: role = '${selectedRole}' ===`);
  const { error: updateError } = await insforge.database
    .from('users')
    .update({ role: selectedRole })
    .eq('id', userId);

  if (updateError) {
    throw new Error(`Direct database update failed: ${updateError.message}`);
  }
  console.log("Direct database update executed successfully.");

  console.log("=== STEP 5: Querying public.users again to verify ===");
  const { data: verifiedProfile, error: verifyError } = await insforge.database
    .from('users')
    .select('role')
    .eq('id', userId)
    .maybeSingle();

  if (verifyError) {
    throw new Error(`Query verification failed: ${verifyError.message}`);
  }
  if (!verifiedProfile) {
    throw new Error("Verification failed: User profile not found in public.users.");
  }

  console.log("Database value returned after verification:", JSON.stringify(verifiedProfile));

  if (verifiedProfile.role !== selectedRole) {
    throw new Error(`CRITICAL: Verification failed! Expected '${selectedRole}', got '${verifiedProfile.role}'`);
  }
  console.log("✅ ROLE VERIFICATION MATCHES EXPECTED selectedRole!");
}

run().catch(err => {
  console.error("❌ TEST RUN FAILED:", err);
  process.exit(1);
});
