import React from 'react';
import { ArrowLeft } from 'lucide-react';

interface PrivacyPolicyScreenProps {
  onBack: () => void;
}

const PRIVACY_POLICY_TEXT = `PRIVACY POLICY — VENTS

This policy explains what information Vents collects, how it's used, and your rights over it.

Information we collect: your name, email, and phone number when you create an account; your location, only if you allow it, so we can show events near you; event details you create, attend, or save. Payment is handled directly by our payment partner, Paystack — we never see or store your full card number.

How we use it: to run your account; to show you relevant nearby events; to process ticket payments through Paystack; to contact you about your tickets or account; to investigate reports of abuse or policy violations.

Who we share it with: Paystack, to process payments. Nobody else, unless required by law.

Your rights: you can ask what information we hold about you, ask us to correct it, or ask us to delete your account and data, by contacting ventsappltd@gmail.com. Nigeria's Data Protection Act gives you the right to all of this.

Data retention: kept while your account is active, deleted within a reasonable period of closing it, except where legally required to keep transaction records longer.

Security: we use encrypted connections and restrict who can access user data internally. No system is fully unhackable, and we'll tell you directly if a breach affects your information.

Children: Vents is not intended for anyone under 18.

Changes: this policy may be updated as the app changes, with notice for anything significant.

Contact: ventsappltd@gmail.com`;

export function PrivacyPolicyScreen({ onBack }: PrivacyPolicyScreenProps) {
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
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
        <button
          onClick={onBack}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            padding: 0,
          }}
        >
          <ArrowLeft size={24} color="#A78BFA" />
        </button>
        <h1 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 700, margin: 0, flex: 1 }}>
          Privacy Policy
        </h1>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 16px', paddingBottom: `calc(20px + env(safe-area-inset-bottom))` }}>
        <div style={{ whiteSpace: 'pre-wrap', color: '#C4C9E0', fontSize: '13px', lineHeight: 1.7, fontFamily: 'Inter, sans-serif', maxWidth: '100%' }}>
          {PRIVACY_POLICY_TEXT}
        </div>

        <p style={{ color: '#8B8FA8', fontSize: '11px', marginTop: '32px', textAlign: 'center', paddingBottom: '12px' }}>
          Last updated: June 2026
        </p>
      </div>
    </div>
  );
}
