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
    <div style={{ background: '#090514', minHeight: '100vh', color: '#C4C9E0', fontFamily: 'Inter, sans-serif', padding: '40px 20px 80px', maxWidth: '680px', margin: '0 auto', lineHeight: 1.7 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '32px' }}>
        <a href="/" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ color: '#fff', fontWeight: 900, fontSize: '18px', fontFamily: 'Space Grotesk, sans-serif' }}>V</span>
          </div>
          <span style={{ color: '#F0F0FF', fontWeight: 800, fontSize: '20px', fontFamily: 'Space Grotesk, sans-serif' }}>Vents</span>
        </a>
      </div>

      <h1 style={{ color: '#F0F0FF', fontSize: '28px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', marginBottom: '6px' }}>Privacy Policy</h1>
      <p style={{ color: '#8B8FA8', fontSize: '13px', marginBottom: '32px' }}>Last updated: June 2026 · Effective: June 2026</p>

      <Section title="1. Who We Are">
        Vents App Ltd ("Vents", "we", "us") is a Nigerian company registered in Gwarimpa, Abuja, Nigeria. We operate the Vents event discovery and ticketing platform available at getvents.com and as a mobile application. This Privacy Policy explains how we collect, use, disclose, and protect your information when you use our platform. By using Vents you agree to this policy. If you do not agree, please do not use the Service.<br /><br />
        Contact: <a href="mailto:support@getvents.com" style={{ color: '#A78BFA' }}>support@getvents.com</a>
      </Section>

      <Section title="2. Information We Collect">
        <b style={{ color: '#F0F0FF' }}>Account information:</b> name, email address, username, phone number, date of birth, and profile photo.<br /><br />
        <b style={{ color: '#F0F0FF' }}>Profile information:</b> bio, location, and any other information you choose to add to your public profile.<br /><br />
        <b style={{ color: '#F0F0FF' }}>Payment information:</b> we do not store card details. All payments are processed securely by Paystack (paystack.com). We only store transaction references, amounts, and payment status.<br /><br />
        <b style={{ color: '#F0F0FF' }}>Device information:</b> device type, operating system, browser type, IP address, and app version.<br /><br />
        <b style={{ color: '#F0F0FF' }}>Usage data:</b> events you view, tickets you purchase, searches you perform, and features you use.<br /><br />
        <b style={{ color: '#F0F0FF' }}>Location data:</b> only when you explicitly grant permission, used to show you nearby events. We do not track your precise GPS location continuously.
      </Section>

      <Section title="3. How We Use Your Information">
        • To create and manage your account<br />
        • To process ticket purchases and send booking confirmations<br />
        • To send event reminders and notifications you have opted into<br />
        • To show you relevant events based on your location and interests<br />
        • To prevent fraud and ensure the security of our platform<br />
        • To respond to your support requests<br />
        • To improve our platform through anonymised analytics<br />
        • To comply with Nigerian law and regulations
      </Section>

      <Section title="4. Payment Data">
        All payment processing on Vents is handled by Paystack Technology Limited, a licensed payment processor regulated in Nigeria. When you make a purchase your payment details are transmitted directly to Paystack and are never stored on our servers. Paystack's privacy policy is available at <a href="https://paystack.com/privacy" target="_blank" rel="noopener noreferrer" style={{ color: '#A78BFA' }}>paystack.com/privacy</a>.<br /><br />
        Vents only receives confirmation of successful or failed transactions along with a transaction reference and amount. We never see or store your card number, CVV, or bank PIN.
      </Section>

      <Section title="5. Data Sharing">
        We do not sell your personal data. We share your information only with:<br /><br />
        • <b style={{ color: '#F0F0FF' }}>Paystack:</b> for secure payment processing<br />
        • <b style={{ color: '#F0F0FF' }}>Event organizers:</b> your name and contact details when you purchase a ticket to their event, so they can manage entry and communicate event updates<br />
        • <b style={{ color: '#F0F0FF' }}>Legal authorities:</b> when required by Nigerian law or a valid court order<br />
        • <b style={{ color: '#F0F0FF' }}>Service providers:</b> cloud hosting and analytics providers under strict data processing agreements who may not use your data for their own purposes
      </Section>

      <Section title="6. Vents Cents">
        Vents Cents are in-app loyalty points. They are <b style={{ color: '#F0F0FF' }}>not real money, not withdrawable, and not convertible to cash or any currency</b>. They may only be used for in-app discounts on ticket purchases and hold no monetary value outside the Vents platform.
      </Section>

      <Section title="7. Data Retention">
        We retain your account data for as long as your account is active. If you delete your account, your identifying personal data — name, email, phone number, profile photo, and bio — is anonymised immediately, and your login is deactivated at the same time. Ticket purchase records are retained in anonymised form for 7 years as required by Nigerian financial regulations, even after account deletion.
      </Section>

      <Section title="8. Your Rights">
        Under the Nigeria Data Protection Act (NDPA) 2023, you have the right to:<br /><br />
        • <b style={{ color: '#F0F0FF' }}>Access</b> a copy of your personal data<br />
        • <b style={{ color: '#F0F0FF' }}>Correct</b> inaccurate data<br />
        • <b style={{ color: '#F0F0FF' }}>Delete</b> your account, immediately anonymising your identifying personal data (see Section 7)<br />
        • <b style={{ color: '#F0F0FF' }}>Opt out</b> of marketing communications at any time<br />
        • <b style={{ color: '#F0F0FF' }}>Request a copy</b> of your data in a portable format<br />
        • <b style={{ color: '#F0F0FF' }}>Lodge a complaint</b> with the Nigeria Data Protection Commission (NDPC)<br /><br />
        To exercise any of these rights, email <a href="mailto:support@getvents.com" style={{ color: '#A78BFA' }}>support@getvents.com</a>. We will respond within 30 days.
      </Section>

      <Section title="9. Cookies and Tracking">
        We use essential cookies to keep you logged in and remember your preferences. We use analytics tools to understand how the app is used so we can improve it. You can disable non-essential cookies in your device or browser settings. Disabling essential cookies may prevent you from logging in.
      </Section>

      <Section title="10. Security">
        We use HTTPS/TLS for all data in transit. Passwords are never stored in plaintext. We conduct regular security reviews. Despite our best efforts no system is 100% secure; if you suspect unauthorized access to your account contact us immediately at <a href="mailto:support@getvents.com" style={{ color: '#A78BFA' }}>support@getvents.com</a>.
      </Section>

      <Section title="11. Children">
        Vents is not intended for users under 13 years of age. We do not knowingly collect personal data from anyone under 13. Users between 13 and 18 must have parental consent to use the Service. If you believe a child under 13 has created an account, contact us at <a href="mailto:support@getvents.com" style={{ color: '#A78BFA' }}>support@getvents.com</a> and we will delete the account.
      </Section>

      <Section title="12. Changes to This Policy">
        We will notify you of significant changes to this policy via email or in-app notification before the changes take effect. Continued use of Vents after changes are notified constitutes acceptance of the updated policy.
      </Section>

      <Section title="13. Contact Us">
        Vents App Ltd<br />
        Gwarimpa, Abuja, Nigeria<br />
        Email: <a href="mailto:support@getvents.com" style={{ color: '#A78BFA' }}>support@getvents.com</a><br />
        WhatsApp: <a href="https://wa.me/2349030737368" style={{ color: '#A78BFA' }}>+234 9030 737 368</a>
      </Section>

      <div style={{ marginTop: '40px', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '20px', display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
        <a href="/terms" style={{ color: '#A78BFA', fontSize: '13px', textDecoration: 'none' }}>Terms of Use</a>
        <a href="/refunds" style={{ color: '#A78BFA', fontSize: '13px', textDecoration: 'none' }}>Refund Policy</a>
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
