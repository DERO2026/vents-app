import { createClient, createAdminClient } from '@insforge/sdk';
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

function verifyUserInDb(email) {
  console.log(`[DB] Confirming email for ${email}...`);
  const cmd = `npx @insforge/cli db query "UPDATE auth.users SET email_verified = true WHERE email = '${email}';" --json`;
  const result = execSync(cmd, { encoding: 'utf8' });
  console.log(`[DB] Confirm result:`, result.trim());
}

async function testAttendee() {
  const suffix = Math.floor(Math.random() * 1000000);
  const email = `test-att-${suffix}@example.com`;
  const password = "Password123!";
  const name = `Test Attendee ${suffix}`;
  const username = `testatt${suffix}`;
  const phone = `+234803${String(suffix).padStart(6, '0')}`;
  const state = "Lagos";
  const role = "attendee";

  console.log(`\n=== Testing Attendee Sign Up: ${email} ===`);
  
  // SignUp
  const signupRes = await insforge.auth.signUp({
    email,
    password,
    name,
    redirectTo: "http://localhost:3000"
  });

  if (signupRes.error) {
    throw new Error(`Signup failed: ${signupRes.error.message}`);
  }

  console.log("Signup call succeeded.");

  // Confirm email in DB
  verifyUserInDb(email);

  // Sign In
  console.log("Signing in with password...");
  const signinRes = await insforge.auth.signInWithPassword({
    email,
    password
  });

  if (signinRes.error) {
    throw new Error(`SignIn failed: ${signinRes.error.message}`);
  }

  const userId = signinRes.data.user.id;
  console.log("Logged in user ID:", userId);

  // Authenticate client (handled automatically by signInWithPassword)

  // Check database users profile
  let { data: profile } = await insforge.database
    .from('users')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  console.log("Initial database profile:", profile);

  // Update profile role to 'attendee' (simulating AuthScreen success flow)
  console.log("Updating role to attendee...");
  const { data: updated, error: updateError } = await insforge.database
    .from('users')
    .update({ role, username, phone_number: phone, state })
    .eq('id', userId)
    .select()
    .maybeSingle();

  if (updateError) {
    throw new Error(`Failed to update profile: ${updateError.message}`);
  }

  console.log("Updated database profile:", updated);

  if (updated.role !== 'attendee') {
    throw new Error(`Expected role 'attendee', got: ${updated.role}`);
  }

  console.log("✅ Attendee signup & login role verification success!");
  return { email, password, userId };
}

async function testOrganizer() {
  const suffix = Math.floor(Math.random() * 1000000);
  const email = `test-org-${suffix}@example.com`;
  const password = "Password123!";
  const name = `Test Organizer ${suffix}`;
  const username = `testorg${suffix}`;
  const phone = `+234803${String(suffix).padStart(6, '0')}`;
  const state = "Lagos";
  const role = "organizer";

  console.log(`\n=== Testing Organizer Sign Up: ${email} ===`);
  
  // SignUp
  const signupRes = await insforge.auth.signUp({
    email,
    password,
    name,
    redirectTo: "http://localhost:3000"
  });

  if (signupRes.error) {
    throw new Error(`Signup failed: ${signupRes.error.message}`);
  }

  console.log("Signup call succeeded.");

  // Confirm email in DB
  verifyUserInDb(email);

  // Sign In
  console.log("Signing in with password...");
  const signinRes = await insforge.auth.signInWithPassword({
    email,
    password
  });

  if (signinRes.error) {
    throw new Error(`SignIn failed: ${signinRes.error.message}`);
  }

  const userId = signinRes.data.user.id;
  console.log("Logged in user ID:", userId);

  // Authenticate client (handled automatically by signInWithPassword)

  // Check database users profile
  let { data: profile } = await insforge.database
    .from('users')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  console.log("Initial database profile:", profile);

  // Update profile role to 'organizer' (simulating AuthScreen success flow)
  console.log("Updating role to organizer...");
  const { data: updated, error: updateError } = await insforge.database
    .from('users')
    .update({ role, username, phone_number: phone, state })
    .eq('id', userId)
    .select()
    .maybeSingle();

  if (updateError) {
    throw new Error(`Failed to update profile: ${updateError.message}`);
  }

  console.log("Updated database profile:", updated);

  if (updated.role !== 'organizer') {
    throw new Error(`Expected role 'organizer', got: ${updated.role}`);
  }

  console.log("✅ Organizer signup & login role verification success!");
  return { email, password, userId };
}

async function run() {
  try {
    const attendee = await testAttendee();
    const organizer = await testOrganizer();
    
    console.log("\n=== ALL TESTS PASSED SUCCESSFULLY! ===");
    process.exit(0);
  } catch (err) {
    console.error("\n❌ TEST FAILED:", err);
    process.exit(1);
  }
}

run();
