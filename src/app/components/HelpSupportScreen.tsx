import React, { useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronUp, Mail, MessageCircle, Phone } from 'lucide-react';

interface HelpSupportScreenProps {
  onBack: () => void;
}

const FAQS = [
  {
    q: 'How do I buy a ticket?',
    a: 'Tap any event, choose your ticket type, select quantity, then tap "Buy Ticket." You can pay by card, bank transfer, or USSD. Your ticket appears in My Tickets immediately after payment.',
  },
  {
    q: 'How do I get my ticket QR code?',
    a: 'Go to Profile → My Tickets and tap the event. Your QR code is on that screen. Screenshot it or keep the app open — organisers will scan it at the gate.',
  },
  {
    q: "I paid but my ticket isn't showing.",
    a: "Pull down to refresh on the My Tickets screen. If it still doesn't appear after 5 minutes, email support@getvents.com with your payment reference and we'll sort it out.",
  },
  {
    q: 'How do I create an event as an organiser?',
    a: 'Tap Profile → Switch to Organiser Mode. First time requires choosing the Organiser option. After that, you get an Organiser Dashboard with a Create Event button.',
  },
  {
    q: 'What payment methods are accepted?',
    a: 'Debit/credit cards (Visa, Mastercard, Verve), bank transfer, and USSD. All payments go through Paystack — we never store your card details.',
  },
  {
    q: 'Can I get a refund?',
    a: 'Refunds are handled by the event organiser, not Vents. Contact the organiser directly via the event page. If an event is cancelled by the organiser, contact support@getvents.com.',
  },
  {
    q: 'How do I report a problem with an event or user?',
    a: 'Tap the three-dot menu (⋯) on any event or user profile and select "Report." Choose a reason and submit — our team reviews every report. For urgent issues, email support@getvents.com or WhatsApp +234 9030737368.',
  },
  {
    q: 'What are Vents Cents?',
    a: 'Vents Cents (VC) are in-app loyalty points — not money. You cannot withdraw, convert, or transfer them to cash or any external account.\n\nHow to EARN VC:\n• 300 VC when a friend you refer signs up (they get 150 VC too)\n• 100 VC for completing your profile\n• 50 VC per ticket you purchase\n\nHow to SPEND VC:\n• Enter monthly prize draws (prizes vary each month)\n• Unlock exclusive badges and profile features\n• Boost event visibility (organizers)\n\nVC expires 12 months after they are earned. They hold no cash value and cannot be used to pay for tickets.',
  },
  {
    q: 'How do organisers withdraw their earnings?',
    a: 'Go to your Organiser Dashboard → Wallet → Withdraw. Enter your bank details and the amount. Withdrawals are processed within 1–3 business days. Minimum withdrawal is ₦1,000.',
  },
  {
    q: 'How do I delete my account?',
    a: "Go to Profile → Settings → scroll to the bottom → tap \"Delete Account.\" You'll be asked to confirm. Your data is anonymised immediately and you cannot reverse this. If you have trouble, email support@getvents.com.",
  },
];

export function HelpSupportScreen({ onBack }: HelpSupportScreenProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <div style={{
      background: '#020005',
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflowY: 'auto',
      scrollbarWidth: 'none',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '12px',
        padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        flexShrink: 0,
      }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center' }}>
          <ArrowLeft size={24} color="#A78BFA" />
        </button>
        <h1 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 700, margin: 0 }}>Help & Support</h1>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 16px', paddingBottom: 'calc(20px + env(safe-area-inset-bottom))', scrollbarWidth: 'none' }}>
        {/* Contact strip */}
        <div style={{
          background: 'rgba(168,85,247,0.08)',
          border: '1px solid rgba(168,85,247,0.2)',
          borderRadius: '14px',
          padding: '14px 16px',
          marginBottom: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}>
          <p style={{ color: '#C4C9E0', fontSize: '13px', margin: 0, lineHeight: 1.5 }}>
            Can't find what you need? Reach us directly:
          </p>
          <a
            href="mailto:support@getvents.com"
            style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#A78BFA', fontSize: '14px', fontWeight: 600, textDecoration: 'none' }}
          >
            <Mail size={16} color="#A78BFA" />
            support@getvents.com
          </a>
          <a
            href="https://wa.me/2349030737368"
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#22C55E', fontSize: '14px', fontWeight: 600, textDecoration: 'none' }}
          >
            <Phone size={16} color="#22C55E" />
            WhatsApp: +234 9030737368
          </a>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#8B8FA8', fontSize: '12px' }}>
            <MessageCircle size={14} color="#8B8FA8" />
            We aim to respond within 24 hours
          </div>
        </div>

        {/* FAQs */}
        <h2 style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700, marginBottom: '12px', letterSpacing: '0.04em' }}>
          FREQUENTLY ASKED QUESTIONS
        </h2>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {FAQS.map((faq, i) => (
            <div
              key={i}
              style={{
                background: '#090514',
                border: `1px solid ${openIndex === i ? 'rgba(168,85,247,0.3)' : 'rgba(255,255,255,0.05)'}`,
                borderRadius: '12px',
                overflow: 'hidden',
                transition: 'border-color 0.2s',
              }}
            >
              <button
                onClick={() => setOpenIndex(openIndex === i ? null : i)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '14px 16px',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                  gap: '12px',
                }}
              >
                <span style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 500, flex: 1, lineHeight: 1.4 }}>{faq.q}</span>
                {openIndex === i
                  ? <ChevronUp size={16} color="#A78BFA" />
                  : <ChevronDown size={16} color="#8B8FA8" />}
              </button>
              {openIndex === i && (
                <div style={{ padding: '0 16px 14px', color: '#C4C9E0', fontSize: '13px', lineHeight: 1.65 }}>
                  {faq.a}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
