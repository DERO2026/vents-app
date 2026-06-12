import { createClient } from '@insforge/sdk';

const insforge = createClient({
  baseUrl: process.env.VITE_INSFORGE_URL,
  anonKey: process.env.VITE_INSFORGE_ANON_KEY
});

async function main() {
  const email = `test-user-${Date.now()}@example.com`;
  const password = "password123";
  const username = `testuser_${Date.now()}`;
  const phone = "1234567890";
  const name = "Test User";

  console.log("--- 1. Testing signUp ---");
  try {
    const signupRes = await insforge.auth.signUp({
      email,
      password,
      name,
      redirectTo: "http://localhost:3001"
    });
    console.log("SignUp Response:", JSON.stringify(signupRes, null, 2));

    if (signupRes.error) {
      console.error("SignUp failed:", signupRes.error);
      return;
    }

    if (signupRes.data?.requireEmailVerification) {
      console.log("Verification is required (Expected: true based on metadata).");
      
      // Let's check if we can query the users table for the user before verification
      // Wait, is the public user record already created?
      console.log("Checking if public user profile exists...");
      const { data: userProfile, error: profileErr } = await insforge.database
        .from('users')
        .select('*')
        .eq('email', email)
        .maybeSingle();
        
      console.log("Public profile before verification:", userProfile, "Error:", profileErr);
    } else {
      console.log("No verification needed. Session user:", signupRes.data?.user);
    }

  } catch (err) {
    console.error("SignUp caught exception:", err);
  }
}

main();
