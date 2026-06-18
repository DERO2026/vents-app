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
  const email = `test-update-${randomSuffix}@example.com`;
  const password = "password123";
  const name = `Test Update ${randomSuffix}`;
  const role = "organizer";

  console.log("--- 1. SignUp with autoConfirm: true ---");
  const signupRes = await insforge.auth.signUp({
    email,
    password,
    name,
    autoConfirm: true,
    redirectTo: "http://localhost:3000"
  });

  console.log("SignUp Response:", JSON.stringify(signupRes, null, 2));

  if (signupRes.error) {
    console.error("SignUp failed:", signupRes.error);
    return;
  }

  const userId = signupRes.data?.user?.id;
  if (!userId) {
    console.error("No userId returned in signup data.");
    return;
  }

  console.log("SignUp succeeded. User ID:", userId);

  // Authenticate the client with the returned token
  insforge.auth.setAccessToken(signupRes.data.accessToken);

  // Check the initial public profile
  let { data: profile } = await insforge.database
    .from('users')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  console.log("Initial profile in DB:", profile);

  // Try updating the role
  console.log(`Updating role to '${role}'...`);
  const { data: updated, error: updateError } = await insforge.database
    .from('users')
    .update({ role })
    .eq('id', userId)
    .select()
    .maybeSingle();

  if (updateError) {
    console.error("Role update failed:", updateError);
  } else {
    console.log("Role update succeeded. Updated profile:", updated);
  }
}

main().catch(console.error);
