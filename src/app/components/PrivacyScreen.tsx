import { useEffect } from 'react';

export function PrivacyScreen() {
  useEffect(() => {
    const els = [document.documentElement, document.body, document.getElementById('root')].filter(Boolean) as HTMLElement[];
    const prev = els.map(el => ({ overflow: el.style.overflow, position: el.style.position, inset: el.style.inset, height: el.style.height }));
    els.forEach(el => { el.style.overflow = 'auto'; el.style.position = 'static'; el.style.inset = ''; el.style.height = 'auto'; });
    return () => {
      els.forEach((el, i) => { el.style.overflow = prev[i].overflow; el.style.position = prev[i].position; el.style.inset = prev[i].inset; el.style.height = prev[i].height; });
    };
  }, []);
  return (
    <div style={{ background: '#07080F', minHeight: '100vh', color: '#C4C9E0', fontFamily: 'Inter, sans-serif', padding: '40px 20px 80px', maxWidth: '680px', margin: '0 auto', lineHeight: 1.7 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '32px' }}>
        <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ color: '#fff', fontWeight: 900, fontSize: '18px', fontFamily: 'Space Grotesk, sans-serif' }}>V</span>
        </div>
        <span style={{ color: '#F0F0FF', fontWeight: 800, fontSize: '20px', fontFamily: 'Space Grotesk, sans-serif' }}>Vents</span>
      </div>

      <h1 style={{ color: '#F0F0FF', fontSize: '28px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', marginBottom: '6px' }}>Privacy Policy</h1>
      <p style={{ color: '#8B8FA8', fontSize: '13px', marginBottom: '32px' }}>Last updated: 19 June 2026 · Effective: 19 June 2026</p>

      <Section title="1. Introduction">
        Vents Ltd ("Vents", "we", "us") operates the Vents mobile application and website (the "Service"). This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our Service. By using Vents, you agree to this policy. If you do not agree, please do not use the Service.
      </Section>

      <Section title="2. Information We Collect">
        <b style={{ color: '#F0F0FF' }}>Account data:</b> name, email address, phone number, username, state of residence, profile photo, bio, and role (attendee or organizer).<br /><br />
        <b style={{ color: '#F0F0FF' }}>Event data:</b> events you create, attend, save, or share; ticket purchases and check-in status.<br /><br />
        <b style={{ color: '#F0F0FF' }}>Payment data:</b> Paystack handles all card processing. We store only your transaction reference, amount, status, and a masked card summary. We never store raw card numbers.<br /><br />
        <b style={{ color: '#F0F0FF' }}>Usage data:</b> pages viewed, features used, search queries, device type, operating system, IP address, and app version.<br /><br />
        <b style={{ color: '#F0F0FF' }}>Location data:</b> approximate city/state (used to show nearby events). We do not track your precise GPS location continuously.
      </Section>

      <Section title="3. How We Use Your Information">
        • Provide, personalise, and improve the Service<br />
        • Process ticket purchases and send receipts<br />
        • Send you event reminders and notifications (you may opt out)<br />
        • Detect and prevent fraud, spam, and abuse<br />
        • Comply with legal obligations<br />
        • Aggregate anonymised analytics to understand usage trends
      </Section>

      <Section title="4. Sharing Your Information">
        We do not sell your personal data. We share information only:<br /><br />
        • With <b style={{ color: '#F0F0FF' }}>event organisers</b> who need your name and contact details to manage the event you purchased tickets for<br />
        • With <b style={{ color: '#F0F0FF' }}>service providers</b> (Paystack for payments, cloud hosting, analytics) under strict data-processing agreements<br />
        • When required by <b style={{ color: '#F0F0FF' }}>Nigerian law</b> or a valid court order<br />
        • In the event of a <b style={{ color: '#F0F0FF' }}>merger or acquisition</b>, with notice to users
      </Section>

      <Section title="5. Vents Cents">
        Vents Cents are in-app reward points. They are <b style={{ color: '#F0F0FF' }}>not real money, not withdrawable, and not convertible to cash</b>. They may be used for in-app discounts only. They hold no monetary value outside the Vents platform.
      </Section>

      <Section title="6. Data Retention">
        We retain your personal data for <b style={{ color: '#F0F0FF' }}>7 years</b> from the date of your last transaction to comply with Nigerian financial regulations, or until you delete your account. Financial records (transactions, ticket purchases) are retained for the full 7-year period even after account deletion, in anonymised form.
      </Section>

      <Section title="7. Account Deletion">
        You may delete your account at any time via Settings → Delete Account. Upon deletion:<br /><br />
        • Your name, email, phone, photo, and bio are permanently removed<br />
        • Your email address is blocked to prevent re-signup under the same address<br />
        • Anonymised financial records are retained for 7 years as required by law<br />
        • Content you created (events, reviews) may remain but will be attributed to "Deleted User"
      </Section>

      <Section title="8. Your Rights">
        Under the Nigeria Data Protection Act (NDPA) 2023, you have the right to:<br /><br />
        • Access a copy of your personal data<br />
        • Correct inaccurate data<br />
        • Request deletion (subject to retention obligations)<br />
        • Withdraw consent where processing is consent-based<br />
        • Lodge a complaint with the Nigeria Data Protection Commission (NDPC)<br /><br />
        To exercise these rights, email <a href="mailto:ventsappltd@gmail.com" style={{ color: '#A78BFA' }}>ventsappltd@gmail.com</a>.
      </Section>

      <Section title="9. Security">
        We use HTTPS/TLS for all data in transit. Passwords are never stored in plaintext. Session tokens are stored in HTTP-only cookies, not localStorage. We conduct regular security reviews.
      </Section>

      <Section title="10. Children">
        Vents is not intended for children under 13. We do not knowingly collect personal data from anyone under 13. If you believe a child under 13 has created an account, contact us at <a href="mailto:ventsappltd@gmail.com" style={{ color: '#A78BFA' }}>ventsappltd@gmail.com</a> and we will delete the account.
      </Section>

      <Section title="11. Governing Law">
        This policy is governed by the laws of the Federal Republic of Nigeria. Disputes shall be subject to the exclusive jurisdiction of Nigerian courts.
      </Section>

      <Section title="12. Contact Us">
        Vents Ltd<br />
        Email: <a href="mailto:ventsappltd@gmail.com" style={{ color: '#A78BFA' }}>ventsappltd@gmail.com</a><br />
        WhatsApp: <a href="https://wa.me/2349030737368" style={{ color: '#A78BFA' }}>+234 9030 737 368</a>
      </Section>

      <div style={{ marginTop: '40px', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '20px', display: 'flex', gap: '16px' }}>
        <a href="/terms" style={{ color: '#A78BFA', fontSize: '13px', textDecoration: 'none' }}>Terms of Use</a>
        <a href="/" style={{ color: '#8B8FA8', fontSize: '13px', textDecoration: 'none' }}>← Back to Vents</a>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '28px' }}>
      <h2 style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 700, marginBottom: '10px', fontFamily: 'Space Grotesk, sans-serif' }}>{title}</h2>
      <p style={{ margin: 0, fontSize: '14px' }}>{children}</p>
    </div>
  );
}
