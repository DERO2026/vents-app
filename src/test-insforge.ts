const INSFORGE_URL = (import.meta as any).env.VITE_INSFORGE_URL;
const INSFORGE_KEY = (import.meta as any).env.VITE_INSFORGE_ANON_KEY;

export async function createTestEvent() {
  console.log("Test event clicled");

  const res = await fetch(`${INSFORGE_URL}/rest/v1/events`, {
    method: "POST",
    headers: {
      apikey: INSFORGE_KEY,
      Authorization: `Bearer ${INSFORGE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      title: "First VENTS Event",
      description: "Testing event creation",
      location: "Lagos",
      date: "2026-06-10",
      organizer_id: "test-user",
    }),
  });

  return res.json();
}