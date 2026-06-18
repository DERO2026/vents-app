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
  const email = `test-json-${randomSuffix}@example.com`;
  const password = "password123";
  const name = `Test JSON ${randomSuffix}`;
  const role = "organizer";

  console.log("--- Testing signUp with JSON-serialized name ---");
  const signupRes = await insforge.auth.signUp({
    email,
    password,
    name: JSON.stringify({
      n: name,
      r: role
    }),
    redirectTo: "http://localhost:3000"
  });

  console.log("SignUp response:", JSON.stringify(signupRes, null, 2));

  if (signupRes.error) {
    console.error("SignUp failed:", signupRes.error);
    return;
  }

  // Wait 1.5 seconds and query public.users
  await new Promise(r => setTimeout(r, 1500));
  
  const { execSync } = await import('child_process');
  const cmd = `npx @insforge/cli db query "SELECT * FROM public.users WHERE email = '${email}';" --json`;
  const result = execSync(cmd, { encoding: 'utf8' });
  console.log("Database result in public.users:");
  console.log(result);
}

main().catch(console.error);
