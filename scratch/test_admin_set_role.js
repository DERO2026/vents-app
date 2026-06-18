import { createClient, createAdminClient } from '@insforge/sdk';
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

// Parse project.json for admin API key
const projectPath = path.resolve('.insforge/project.json');
const projectContent = JSON.parse(fs.readFileSync(projectPath, 'utf8'));

const insforge = createClient({
  baseUrl: env.VITE_INSFORGE_URL,
  anonKey: env.VITE_INSFORGE_ANON_KEY,
});

const admin = createAdminClient({
  baseUrl: env.VITE_INSFORGE_URL,
  apiKey: projectContent.api_key,
});

async function main() {
  const randomSuffix = Math.floor(Math.random() * 1000000);
  const email = `test-admin-${randomSuffix}@example.com`;
  const password = "password123";
  const name = `Test Admin ${randomSuffix}`;

  console.log("--- 1. Registering new user via Client SDK ---");
  const signupRes = await insforge.auth.signUp({
    email,
    password,
    name,
    redirectTo: "http://localhost:3000"
  });

  console.log("SignUp Response:", JSON.stringify(signupRes, null, 2));

  if (signupRes.error) {
    console.error("SignUp failed:", signupRes.error);
    return;
  }

  // Fetch user profile from public schema to get the id
  const { data: userProfile, error: profileErr } = await admin.database
    .from('users')
    .select('*')
    .eq('email', email)
    .maybeSingle();

  if (profileErr || !userProfile) {
    console.error("Failed to fetch user profile by email:", profileErr);
    return;
  }

  const userId = userProfile.id;
  console.log("SignUp succeeded. User ID:", userId);


  // Check initial public profile in DB
  const { data: initialProfile } = await admin.database
    .from('users')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  console.log("Initial profile in DB:", initialProfile);

  // Update role using Admin Client (bypassing RLS policies)
  console.log("Updating role to 'organizer' using Admin Client...");
  const { data: updatedProfile, error: updateError } = await admin.database
    .from('users')
    .update({ role: 'organizer', username: `testadmin${randomSuffix}` })
    .eq('id', userId)
    .select()
    .maybeSingle();

  if (updateError) {
    console.error("Admin role update failed:", updateError);
  } else {
    console.log("Admin role update succeeded:", updatedProfile);
  }
}

main().catch(console.error);
