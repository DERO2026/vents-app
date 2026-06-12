import { createClient } from '@insforge/sdk';

const insforge = createClient({
  baseUrl: process.env.VITE_INSFORGE_URL,
  anonKey: process.env.VITE_INSFORGE_ANON_KEY
});

async function main() {
  const email = `test-login-${Date.now()}@example.com`;
  const password = "password123";

  console.log("--- 1. Registering with autoConfirm: true ---");
  const signupRes = await insforge.auth.signUp({
    email,
    password,
    name: "Login Test User",
    autoConfirm: true
  });
  console.log("SignUp Response:", JSON.stringify(signupRes, null, 2));

  if (signupRes.error) {
    console.error("SignUp failed:", signupRes.error);
    return;
  }

  console.log("--- 2. Attempting signInWithPassword ---");
  const signinRes = await insforge.auth.signInWithPassword({
    email,
    password
  });
  console.log("SignIn Response:", JSON.stringify(signinRes, null, 2));

  if (signinRes.error) {
    console.error("SignIn failed:", signinRes.error);
    return;
  }

  console.log("--- 3. Testing getCurrentUser after SignIn ---");
  const userRes = await insforge.auth.getCurrentUser();
  console.log("getCurrentUser Response:", JSON.stringify(userRes, null, 2));
}

main();
