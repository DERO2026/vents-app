import { createClient } from '@insforge/sdk';
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

async function checkSignupRole(role) {
  const suffix = Math.floor(Math.random() * 1000000);
  const email = `test-direct-${role}-${suffix}@example.com`;
  const password = "Password123!";
  const name = `Test Direct ${role} ${suffix}`;

  console.log(`[Signup] Registering ${email} with role: ${role}...`);
  
  let signupRes;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      signupRes = await insforge.auth.signUp({
        email,
        password,
        name: JSON.stringify({
          n: name,
          r: role
        }),
        redirectTo: "http://localhost:3000"
      });
      if (signupRes.error) {
        throw new Error(signupRes.error.message);
      }
      break;
    } catch (err) {
      if (attempt === 5) throw err;
      console.warn(`[Signup] SignUp failed (attempt ${attempt}/5): ${err.message}. Retrying in 3s...`);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }

  console.log(`[Signup] SignUp call completed. Waiting for trigger to populate public.users...`);
  
  // Wait 2 seconds
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Query database using SDK directly with retries
  let profile;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const { data, error } = await insforge.database
        .from('users')
        .select('id, email, full_name, role')
        .eq('email', email)
        .maybeSingle();
      
      if (error) throw error;
      profile = data;
      if (profile) break;
    } catch (err) {
      console.warn(`[DB Profile] Query failed (attempt ${attempt}/5): ${err.message}.`);
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  console.log(`[DB Profile] Stored record:`, profile);

  if (!profile) {
    throw new Error(`Profile not found in database for ${email}`);
  }

  if (profile.role !== role) {
    throw new Error(`CRITICAL: Role mismatch! Expected '${role}', got '${profile.role}'`);
  }

  console.log(`✅ Stored correctly: '${role}' immediately after signup!\n`);
}

async function run() {
  try {
    await checkSignupRole('attendee');
    await checkSignupRole('organizer');
    console.log("=== ALL DIRECT ROLE TESTS PASSED SUCCESSFULLY! ===");
    process.exit(0);
  } catch (err) {
    console.error("❌ TEST FAILED:", err.message);
    process.exit(1);
  }
}

run();
