import { useState } from 'react';
import { haptics } from '../../lib/haptics';

interface Section { title: string; items: { q: string; a: string }[] }

const SECTIONS: Section[] = [
  {
    title: 'Tickets & Purchases',
    items: [
      { q: 'How do I buy a ticket?', a: 'Tap any event on the home screen, choose your ticket type and quantity, then tap "Buy Ticket." You can pay by debit/credit card, bank transfer, or USSD via Paystack. Your ticket appears in Profile → My Tickets immediately after payment is confirmed.' },
      { q: 'How do I access my QR code?', a: 'Go to Profile → My Tickets and tap the event. Your QR code is displayed on the ticket screen. Screenshot it or keep the app open — organizers will scan it at the gate using the Vents check-in scanner.' },
      { q: 'I paid but my ticket is not showing.', a: 'Pull down to refresh on the My Tickets screen. If it still does not appear after 5 minutes, email support@getvents.com with your Paystack payment reference and we will resolve it within 1 business day.' },
      { q: 'Can I get a refund?', a: 'Refund policies are set by individual event organizers and must be stated on the event listing. If an event is cancelled by the organizer, contact support@getvents.com and we will facilitate a refund through Paystack (typically 5–10 business days). Vents platform fees are non-refundable.' },
      { q: 'Can I transfer my ticket to someone else?', a: 'Ticket transfers are not currently supported in-app. Contact the event organizer directly — some organizers accommodate name changes at their discretion.' },
    ],
  },
  {
    title: 'Payments',
    items: [
      { q: 'What payment methods are accepted?', a: 'Debit/credit cards (Visa, Mastercard, Verve), bank transfer, and USSD. All payments are processed by Paystack — we never store your card details.' },
      { q: 'Is my payment secure?', a: 'Yes. All card processing is handled by Paystack, a PCI-DSS compliant payment provider. Vents never sees or stores raw card numbers. All data is encrypted in transit using HTTPS/TLS.' },
      { q: 'What are Vents Cents?', a: 'Vents Cents are in-app reward points earned by referring friends. They can be used for discounts on future ticket purchases. They are not withdrawable, not transferable between accounts, and have no cash value outside the Vents platform.' },
      { q: 'How do I earn Vents Cents?', a: 'Go to Profile → Referrals and send invite links to friends. When a friend signs up using your link and purchases a ticket, you earn Vents Cents. There is a 14-day pending period before earnings are activated.' },
    ],
  },
  {
    title: 'For Organizers',
    items: [
      { q: 'How do I create an event?', a: 'Go to Profile and switch to Organizer mode. You will see an Organizer Dashboard with a Create Event button. Fill in all event details, upload a flyer, set your ticket types and prices, then publish.' },
      { q: 'How do I receive payment from ticket sales?', a: 'Ticket revenue is paid out to your Paystack account. Ensure your Paystack merchant account is set up and linked. Payouts follow Paystack\'s schedule. Vents deducts a platform fee per transaction.' },
      { q: 'How do I check in attendees at the gate?', a: 'Use the Vents Check-in Scanner (available in your Organizer Dashboard). Scan the attendee\'s QR code from their Vents app. The scanner marks the ticket as checked in and shows attendee details.' },
      { q: 'Can I set a capacity limit for my event?', a: 'Yes. When creating an event, set the "Ticket Goal" field. Ticket sales will stop automatically when the limit is reached. You can increase the limit later from Manage Events.' },
      { q: 'How do I apply for organizer verification?', a: 'Verified organizers receive a blue checkmark on their profile. To apply, email support@getvents.com with your full name, the name of your events business, and a link to your social media presence. We review applications within 5 business days.' },
    ],
  },
  {
    title: 'Account & Safety',
    items: [
      { q: 'How do I report an event or user?', a: 'Tap the three-dot menu or flag icon on any event or user profile and select Report. Choose a reason and submit. All reports are reviewed by our moderation team within 48 hours.' },
      { q: 'How do I delete my account?', a: 'Go to Profile → Settings → scroll to the bottom → tap "Delete Account." You will be asked to confirm. Your personal data is anonymised immediately. This action cannot be reversed. Email support@getvents.com if you have trouble.' },
      { q: 'I forgot my password. How do I reset it?', a: 'On the login screen, tap "Forgot password?" and enter your email. You will receive a reset link. If you signed up with a phone number, contact support@getvents.com for assistance.' },
      { q: 'How do I report a bug or technical issue?', a: 'Email support@getvents.com with a description of the issue, your device model, and any screenshots. You can also reach us on WhatsApp at +234 9030 737 368.' },
    ],
  },
];

function AccordionItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
      <button
        onClick={() => { haptics.light(); setOpen(o => !o); }}
        style={{ width: '100%', background: 'none', border: 'none', padding: '16px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', cursor: 'pointer', textAlign: 'left' }}
      >
        <span style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600, lineHeight: 1.4, flex: 1 }}>{q}</span>
        <span style={{ color: '#8B8FA8', fontSize: '18px', flexShrink: 0, marginTop: '-2px' }}>{open ? '−' : '+'}</span>
      </button>
      {open && (
        <p style={{ color: '#C4C9E0', fontSize: '14px', lineHeight: 1.65, margin: '0 0 16px', paddingRight: '24px' }}>{a}</p>
      )}
    </div>
  );
}

export function HelpPage() {
  return (
    <div style={{ background: '#090514', minHeight: '100dvh', color: '#C4C9E0', fontFamily: 'Inter, sans-serif', padding: '40px 20px 80px', maxWidth: '680px', margin: '0 auto', lineHeight: 1.7 }}>
      {/* Logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '32px' }}>
        <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ color: '#fff', fontWeight: 900, fontSize: '18px', fontFamily: 'Space Grotesk, sans-serif' }}>V</span>
        </div>
        <span style={{ color: '#F0F0FF', fontWeight: 800, fontSize: '20px', fontFamily: 'Space Grotesk, sans-serif' }}>Vents</span>
      </div>

      <h1 style={{ color: '#F0F0FF', fontSize: '28px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', marginBottom: '6px' }}>Help Center</h1>
      <p style={{ color: '#8B8FA8', fontSize: '14px', marginBottom: '40px' }}>Answers to the most common questions about Vents.</p>

      {SECTIONS.map(section => (
        <div key={section.title} style={{ marginBottom: '36px' }}>
          <h2 style={{ color: '#A78BFA', fontSize: '13px', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: '8px', fontFamily: 'Space Grotesk, sans-serif' }}>{section.title}</h2>
          <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '16px', padding: '0 16px' }}>
            {section.items.map(item => <AccordionItem key={item.q} q={item.q} a={item.a} />)}
          </div>
        </div>
      ))}

      <div style={{ background: 'rgba(167,139,250,0.07)', border: '1px solid rgba(167,139,250,0.2)', borderRadius: '16px', padding: '24px' }}>
        <h3 style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 700, fontFamily: 'Space Grotesk, sans-serif', margin: '0 0 8px' }}>Still need help?</h3>
        <p style={{ color: '#8B8FA8', fontSize: '14px', margin: '0 0 16px' }}>Our support team is available Monday–Friday, 9am–6pm WAT.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <a href="mailto:support@getvents.com" style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#A78BFA', textDecoration: 'none', fontSize: '14px', fontWeight: 600 }}>
            ✉ support@getvents.com
          </a>
          <a href="https://wa.me/2349030737368" style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#A78BFA', textDecoration: 'none', fontSize: '14px', fontWeight: 600 }}>
            💬 WhatsApp: +234 9030 737 368
          </a>
        </div>
      </div>

      <div style={{ marginTop: '40px', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '20px', display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
        <a href="/privacy" style={{ color: '#A78BFA', fontSize: '13px', textDecoration: 'none' }}>Privacy Policy</a>
        <a href="/terms" style={{ color: '#A78BFA', fontSize: '13px', textDecoration: 'none' }}>Terms of Use</a>
        <a href="/" style={{ color: '#8B8FA8', fontSize: '13px', textDecoration: 'none' }}>← Back to Vents</a>
      </div>
    </div>
  );
}
