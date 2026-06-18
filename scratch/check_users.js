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

async function checkUsers() {
  const { data: users, error } = await insforge.database
    .from('users')
    .select('email, role, full_name, username');
  
  if (error) {
    console.error('Fetch users failed:', error);
    process.exit(1);
  }

  console.log('--- USERS IN DATABASE ---');
  console.table(users);
}

checkUsers().catch(console.error);
