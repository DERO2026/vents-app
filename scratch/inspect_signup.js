import { createClient } from '@insforge/sdk';

const insforge = createClient({
  baseUrl: "https://8git8iib.us-east.insforge.app",
  anonKey: "dummy"
});

console.log("signUp type:", typeof insforge.auth.signUp);
console.log("signUp signature keys (if inspectable):", Object.keys(insforge.auth.signUp));
