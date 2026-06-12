import { createClient } from '@insforge/sdk';

const insforge = createClient({
  baseUrl: process.env.VITE_INSFORGE_URL,
  anonKey: process.env.VITE_INSFORGE_ANON_KEY
});

async function main() {
  console.log("URL:", process.env.VITE_INSFORGE_URL);
  console.log("Anon key present:", !!process.env.VITE_INSFORGE_ANON_KEY);
  
  const { data, error } = await insforge.database
    .from('users')
    .select('*')
    .limit(5);
    
  if (error) {
    console.error("Database query failed:", error);
  } else {
    console.log("Successfully fetched users:", data);
  }
}

main();
