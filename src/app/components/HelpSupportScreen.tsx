import React, { useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronUp, Mail, MessageCircle } from 'lucide-react';

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
    q: 'I paid but my ticket isn\'t showing.',
    a: 'Pull down to refresh on the My Tickets screen. If it still doesn\'t appear after 5 minutes, email ventsappltd@gmail.com with your payment reference and we\'ll sort it out.',
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
    a: 'Refunds are handled by the event organiser, not Vents. Contact the organiser directly via the event page. If an event is cancelled by the organiser, contact ventsappltd@gmail.com.',
  },
  {
    q: 'How do I report a problem with an event or user?',
    a: 'Email ventsappltd@gmail.com with the event name or user\'s username and a description. We review all reports and act on policy violations.',
  },
  {
    q: 'What are Vents Cents?',
    a: 'Vents Cents are in-app points earned by inviting friends. They can be used for discounts on future tickets. They are not withdrawable and have no cash value.',
  },
  {
    q: 'How do I delete my account?',
    a: 'Email ventsappltd@gmail.com from your registered email address and request account deletion. Under Nigeria\'s Data Protection Act you have the right to this, and we\'ll action it within a reasonable period.',
  },
];

export function HelpSupportScreen({ onBack }: HelpSupportScreenProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <div style={{
      background: '#060A12',
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
            href="mailto:ventsappltd@gmail.com"
            style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#A78BFA', fontSize: '14px', fontWeight: 600, textDecoration: 'none' }}
          >
            <Mail size={16} color="#A78BFA" />
            ventsappltd@gmail.com
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
                background: '#0D1220',
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
