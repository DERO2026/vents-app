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

async function main() {
  const randomSuffix = Math.floor(Math.random() * 1000000);
  const email = `test-verify-${randomSuffix}@example.com`;
  const password = "password123";
  const name = `Test Verify ${randomSuffix}`;
  const role = "organizer";
  const username = `testverify${randomSuffix}`;
  const phone = `+234803${String(randomSuffix).padStart(6, '0')}`;
  const state = "Lagos";

  console.log("--- 1. Testing signUp with profile options ---");
  const signupRes = await insforge.auth.signUp({
    email,
    password,
    profile: {
      name,
      role,
      username,
      phone_number: phone,
      state
    },
    redirectTo: "http://localhost:3000"
  });
  console.log("SignUp Response:", JSON.stringify(signupRes, null, 2));

  if (signupRes.error) {
    console.error("SignUp failed:", signupRes.error);
    return;
  }

  // Let's check public.users
  console.log("Checking public user profile...");
  const { data: userProfile, error: profileErr } = await insforge.database
    .from('users')
    .select('*')
    .eq('email', email)
    .maybeSingle();
    
  console.log("Public profile in database:", userProfile);
  if (profileErr) {
    console.error("Profile query error:", profileErr);
  }
}

main().catch(console.error);
