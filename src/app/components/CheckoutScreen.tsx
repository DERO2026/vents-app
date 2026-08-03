import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Lock, Tag, ChevronDown, AlertCircle, X, Users, CheckCircle2 } from 'lucide-react';
import { Event, TicketType, PurchasedTicket, TicketAttendee } from './types';
import { formatPrice } from './data';
import { openPaystackPopup } from '../../lib/paystack';
import { analytics } from '../../lib/analyticsEvents';
import { insforge } from '../../lib/insforge';
import { openExternalUrl } from '../../lib/externalLink';
import { haptics } from '../../lib/haptics';

interface CheckoutScreenProps {
  event: Event;
  ticketType: TicketType;
  quantity: number;
  currentUser: { id: string; email: string; full_name: string | null; username?: string } | null;
  onBack: () => void;
  onSuccess: (ticket: PurchasedTicket) => void;
}

const INPUT_STYLE: React.CSSProperties = {
  flex: 1,
  background: 'none',
  border: 'none',
  outline: 'none',
  color: '#FFFFFF',
  fontSize: '14px',
  fontFamily: 'Inter, sans-serif',
};

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

const COUNTRY_CODES = [
  { flag: '🇳🇬', code: '+234', name: 'Nigeria', format: '080 0000 0000' },
  { flag: '🇬🇧', code: '+44', name: 'UK', format: '07700 000000' },
  { flag: '🇺🇸', code: '+1', name: 'USA', format: '(000) 000-0000' },
  { flag: '🇨🇦', code: '+1', name: 'Canada', format: '(000) 000-0000' },
  { flag: '🇬🇭', code: '+233', name: 'Ghana', format: '024 000 0000' },
  { flag: '🇿🇦', code: '+27', name: 'South Africa', format: '071 000 0000' },
  { flag: '🇰🇪', code: '+254', name: 'Kenya', format: '0712 000000' },
  { flag: '🇫🇷', code: '+33', name: 'France', format: '06 00 00 00 00' },
  { flag: '🇩🇪', code: '+49', name: 'Germany', format: '0151 00000000' },
  { flag: '🇦🇺', code: '+61', name: 'Australia', format: '0412 000 000' },
  { flag: '🇨🇳', code: '+86', name: 'China', format: '138 0000 0000' },
  { flag: '🇮🇳', code: '+91', name: 'India', format: '98000 00000' },
  { flag: '🇦🇪', code: '+971', name: 'UAE', format: '050 000 0000' },
  { flag: '🇸🇳', code: '+221', name: 'Senegal', format: '77 000 00 00' },
  { flag: '🇪🇹', code: '+251', name: 'Ethiopia', format: '091 000 0000' },
];

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ width: '100%', minWidth: 0 }}>
      <p style={{ color: '#94A3B8', fontSize: '12px', marginBottom: '6px', fontWeight: 500, textTransform: 'uppercase' }}>{label}</p>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          background: '#090514',
          border: '1px solid rgba(255,255,255,0.05)',
          borderRadius: '16px',
          height: '52px',
          padding: '0 14px',
          width: '100%',
          boxSizing: 'border-box',
        }}
      >
        <span style={{ color: '#FFFFFF', fontSize: '14px' }}>{value}</span>
      </div>
    </div>
  );
}

function Field({
  label,
  placeholder,
  value,
  onChange,
  type = 'text',
  icon,
  error,
  onBlur,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  icon?: React.ReactNode;
  error?: string;
  onBlur?: () => void;
}) {
  return (
    <div style={{ width: '100%', minWidth: 0 }}>
      <p style={{ color: '#94A3B8', fontSize: '12px', marginBottom: '6px', fontWeight: 500, textTransform: 'uppercase' }}>{label}</p>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          background: '#090514',
          border: `1px solid ${error ? 'rgba(239,68,68,0.5)' : 'rgba(255,255,255,0.1)'}`,
          borderRadius: '16px',
          height: '52px',
          padding: '0 14px',
          gap: '10px',
          width: '100%',
          boxSizing: 'border-box',
        }}
      >
        {icon}
        <input
          type={type}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          style={{ ...INPUT_STYLE, minWidth: 0 }}
        />
      </div>
      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '4px' }}>
          <AlertCircle size={11} color="#EF4444" />
          <span style={{ color: '#EF4444', fontSize: '11px' }}>{error}</span>
        </div>
      )}
    </div>
  );
}

export function CheckoutScreen({ event, ticketType, quantity, currentUser, onBack, onSuccess }: CheckoutScreenProps) {
  const [name, setName] = useState(currentUser?.full_name || '');
  const [email, setEmail] = useState(currentUser?.email || '');
  const [emailTouched, setEmailTouched] = useState(false);
  const [phone, setPhone] = useState('');
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [selectedCountry, setSelectedCountry] = useState(COUNTRY_CODES[0]);
  const [showCountryPicker, setShowCountryPicker] = useState(false);
  const [promoCode, setPromoCode] = useState('');
  const [promoApplied, setPromoApplied] = useState(false);
  const [promoDiscountPct, setPromoDiscountPct] = useState(0);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [promoChecking, setPromoChecking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [paymentLoading, setPaymentLoading] = useState(false);
  // Synchronous single-flight guard: refs update immediately (unlike state,
  // which batches), so this closes the window between a fast double-tap and
  // React re-rendering the disabled button. paymentLoading state still
  // drives the visual disabled state; this ref is the actual re-entrancy lock.
  const payingRef = useRef(false);
  const [payError, setPayError] = useState<string | null>(null);

  // Group purchases (quantity > 1) need one distinct name+email per ticket
  // -- each row gets its own QR code, and the door scanner needs to know
  // whose ticket it's scanning. Attendee 1 is always the purchaser (the
  // existing name/email fields above); this holds attendees 2..quantity.
  const [additionalAttendees, setAdditionalAttendees] = useState<TicketAttendee[]>(
    () => Array.from({ length: Math.max(0, quantity - 1) }, () => ({ name: '', email: '', phone: '' }))
  );
  const [attendeesTouched, setAttendeesTouched] = useState(false);

  const updateAttendee = (index: number, field: keyof TicketAttendee, value: string) => {
    setAdditionalAttendees((prev) => prev.map((a, i) => (i === index ? { ...a, [field]: value } : a)));
  };

  const subtotal = ticketType.price * quantity;
  const serviceFee = Math.round(subtotal * 0.05);
  const discount = promoApplied ? Math.round(subtotal * (promoDiscountPct / 100)) : 0;
  const total = Math.max(0, subtotal + serviceFee - discount);

  const emailError = emailTouched && email.length > 0 && !isValidEmail(email)
    ? 'Enter a valid email (e.g. name@gmail.com)'
    : undefined;

  // A phone number is required so organizers can actually reach the buyer
  // about their booking — previously only validated (and required) for
  // *additional* attendees on a group purchase, leaving the far more common
  // single-ticket purchase with no phone requirement at all.
  const phoneDigits = phone.replace(/\D/g, '');
  const phoneError = phoneTouched && phoneDigits.length < 7
    ? 'Enter a valid phone number'
    : undefined;

  const additionalAttendeesValid = additionalAttendees.every(
    (a) => a.name.trim().length > 0 && isValidEmail(a.email) && (a.phone ?? '').replace(/\D/g, '').length >= 7
  );

  // A code the user typed but never successfully applied (or applied, then
  // edited) must block checkout rather than silently getting ignored — that
  // would look like the discount applied when it didn't.
  const promoPending = promoCode.trim().length > 0 && !promoApplied;

  const buildAttendees = (purchaserName: string, purchaserEmail: string): TicketAttendee[] => [
    { name: purchaserName, email: purchaserEmail, phone: phoneDigits ? `${selectedCountry.code}${phoneDigits}` : undefined },
    ...additionalAttendees.map((a) => ({ name: a.name.trim(), email: a.email.trim(), phone: (a.phone ?? '').trim() || undefined })),
  ];

  const handleApplyPromo = async () => {
    const code = promoCode.trim();
    if (!code) return;
    setPromoChecking(true);
    setPromoError(null);
    try {
      const { data, error } = await insforge.database.rpc('validate_promo_code' as any, { p_code: code });
      if (error) throw error;
      const result = data as any;
      if (result?.valid) {
        setPromoApplied(true);
        setPromoDiscountPct(Number(result.discount_percentage) || 0);
        setPromoError(null);
      } else {
        setPromoApplied(false);
        setPromoDiscountPct(0);
        setPromoError(result?.reason || 'Invalid promo code.');
      }
    } catch (err: any) {
      setPromoApplied(false);
      setPromoDiscountPct(0);
      setPromoError('Could not verify promo code. Please try again.');
    } finally {
      setPromoChecking(false);
    }
  };

  const handleFreeTicket = () => {
    const purchaserName = name.trim() || 'Guest';
    const purchaserEmail = currentUser?.email || email.trim();
    const ticket: PurchasedTicket = {
      event,
      ticketType,
      quantity,
      ticketId: `VNT-FREE-${Date.now().toString(36).toUpperCase()}`,
      purchasedAt: new Date().toISOString(),
      totalAmount: 0,
      holderName: purchaserName,
      holderEmail: purchaserEmail,
      attendees: buildAttendees(purchaserName, purchaserEmail),
      promoCode: promoApplied ? promoCode.trim() : undefined,
    };
    // Completion is tracked once, downstream, when purchase_ticket succeeds
    // (App.handleTicketPurchase → analytics.ticketPurchased). Here we only
    // record the intent so the funnel has a start → complete pair.
    analytics.checkoutStarted({ eventId: event?.id, ticketType: ticketType?.name, quantity, amount: 0, free: true });
    onSuccess(ticket);
  };

  const handlePay = async () => {
    // Single-flight guard: a fast double-tap (or click-flood on a laggy
    // connection) used to be able to invoke this twice before the Paystack
    // iframe finished opening, spawning two concurrent payment handlers with
    // distinct references. This must be checked before anything else runs.
    if (payingRef.current) return;

    haptics.medium();
    setPayError(null);
    setAttendeesTouched(true);
    setPhoneTouched(true);
    analytics.checkoutStarted({ eventId: event?.id, ticketType: ticketType?.name, quantity, amount: total, free: false });

    const payerEmail = currentUser?.email || email.trim();
    if (!payerEmail || !isValidEmail(payerEmail)) {
      setPayError('A valid email address is required to pay.');
      return;
    }

    if (phoneDigits.length < 7) {
      setPayError('A valid phone number is required so the organizer can reach you about your booking.');
      return;
    }

    if (promoPending) {
      setPayError('Apply your promo code or clear it before continuing.');
      return;
    }

    if (!event?.id) {
      setPayError('Event not found. Please go back and try again.');
      return;
    }

    if (!additionalAttendeesValid) {
      setPayError(`Enter full name, email and phone number for all ${quantity} attendees.`);
      return;
    }

    // Free tickets bypass Paystack — still needs the same single-flight lock
    // as the paid path (handleFreeTicket calls onSuccess synchronously and
    // this screen navigates away, so there's no matching unlock needed).
    if (total === 0) {
      payingRef.current = true;
      setPaymentLoading(true);
      handleFreeTicket();
      return;
    }

    const PaystackPop = (window as any).PaystackPop;
    if (!PaystackPop) {
      setPayError('Payment system not loaded. Please refresh the page and try again.');
      return;
    }

    const purchaserName = name.trim() || currentUser?.full_name || 'Guest';
    const attendees = buildAttendees(purchaserName, payerEmail);

    payingRef.current = true;
    setPaymentLoading(true);

    // Persist the purchase intent (event, ticket type, attendees, promo, and
    // the exact amount to charge) server-side BEFORE ever opening Paystack —
    // this is what lets the webhook finalize the purchase later even if this
    // client never survives to see the callback. The server also computes
    // the amount now (not the client), and returns the SAME reference on an
    // immediate retry of an identical purchase instead of minting a new one,
    // so a user who thinks their payment failed and taps Pay again can't be
    // charged twice for the same intent.
    let reference: string;
    let amountKobo: number;
    try {
      const { data, error } = await insforge.database.rpc('create_pending_purchase', {
        p_event_id: event.id,
        p_ticket_type: ticketType.name,
        p_attendees: attendees,
        p_promo_code: promoApplied ? promoCode.trim() : null,
      });
      if (error) throw error;
      reference = (data as any)?.payment_ref;
      amountKobo = Number((data as any)?.amount_kobo);
      if (!reference || !amountKobo || amountKobo <= 0) throw new Error('Could not prepare this purchase.');
    } catch (err: any) {
      payingRef.current = false;
      setPaymentLoading(false);
      setPayError(err?.message || 'Could not start checkout. Please try again.');
      return;
    }

    const rawPublicKey = import.meta.env.VITE_PAYSTACK_PUBLIC_KEY || '';
    const publicKey = rawPublicKey.replace(new RegExp('^\\uFEFF'), '').trim();

    try {
      const handler = PaystackPop.setup({
        key: publicKey,
        email: payerEmail,
        amount: amountKobo,
        currency: 'NGN',
        ref: reference,
        label: currentUser?.full_name || currentUser?.username || name.trim() || '',
        channels: ['card', 'bank_transfer', 'ussd', 'mobile_money', 'bank'],
        metadata: {
          event_id: event.id,
          event_title: event.title,
          ticket_type: ticketType.name,
          user_id: currentUser?.id || '',
          quantity,
          custom_fields: [
            { display_name: 'Event', variable_name: 'event_title', value: event.title },
            { display_name: 'Tickets', variable_name: 'ticket_quantity', value: String(quantity) },
          ],
        },
        callback: (response: { reference: string }) => {
          const ticket: PurchasedTicket = {
            event,
            ticketType,
            quantity,
            ticketId: response.reference,
            purchasedAt: new Date().toISOString(),
            totalAmount: total,
            holderName: purchaserName,
            holderEmail: payerEmail,
            attendees,
            promoCode: promoApplied ? promoCode.trim() : undefined,
          };
          // Purchase completion tracked downstream (App.handleTicketPurchase).
          // Deliberately leave payingRef/paymentLoading locked — this screen
          // is about to be navigated away from on success, not reused.
          onSuccess(ticket);
        },
        onClose: () => {
          payingRef.current = false;
          setPaymentLoading(false);
        },
      });

      handler.openIframe();
    } catch (err: any) {
      payingRef.current = false;
      setPaymentLoading(false);
      setPayError('Payment failed to start: ' + (err?.message || 'Please try again.'));
    }
  };

  return (
    <div
      style={{
        background: '#020005',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        scrollbarWidth: 'none',
      }}
    >
      <style>{`input::placeholder { color: #8B8FA8; } @keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px' }}>
        <button
          onClick={onBack}
          style={{
            background: '#090514',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '50%',
            width: '36px',
            height: '36px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <ArrowLeft size={16} color="#C4C9E0" />
        </button>
        <h1 style={{ color: '#FFFFFF', fontSize: '18px', fontWeight: 700 }}>Checkout</h1>
      </div>

      <div style={{ flex: 1, padding: '4px 16px 140px' }}>
        {/* Order mini summary */}
        <div
          style={{
            background: '#090514',
            border: '1px solid rgba(255,255,255,0.05)',
            borderRadius: '24px',
            padding: '14px',
            marginBottom: '20px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
          }}
        >
          <img src={event.image} alt="" style={{ width: '56px', height: '56px', borderRadius: '10px', objectFit: 'cover', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ color: '#FFFFFF', fontSize: '16px', fontWeight: 700 }}>{event.title}</p>
            <p style={{ color: '#8B8FA8', fontSize: '12px' }}>{ticketType.name} × {quantity}</p>
          </div>
          <p style={{ color: '#FFFFFF', fontSize: '16px', fontWeight: 600 }}>{formatPrice(subtotal)}</p>
        </div>

        {/* Attendee info */}
        <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '16px', marginBottom: '16px' }}>
          <p style={{ color: '#FFFFFF', fontSize: '15px', fontWeight: 700, marginBottom: '14px' }}>Attendee Details</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {currentUser?.full_name ? (
              <ReadOnlyField label="Full Name" value={currentUser.full_name} />
            ) : (
              <Field label="Full Name" placeholder="Your full name" value={name} onChange={setName} />
            )}
            {currentUser?.email ? (
              <ReadOnlyField label="Email Address" value={currentUser.email} />
            ) : (
            <Field
              label="Email Address"
              placeholder="name@gmail.com"
              value={email}
              onChange={setEmail}
              type="email"
              error={emailError}
              onBlur={() => setEmailTouched(true)}
            />
            )}

            {/* Phone with country code */}
            <div>
              <p style={{ color: '#94A3B8', fontSize: '12px', marginBottom: '6px', fontWeight: 500, textTransform: 'uppercase' }}>Phone Number *</p>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => setShowCountryPicker(true)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    background: '#090514',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '16px',
                    height: '52px',
                    padding: '0 10px',
                    cursor: 'pointer',
                    flexShrink: 0,
                    boxSizing: 'border-box',
                  }}
                >
                  <span style={{ fontSize: '16px' }}>{selectedCountry.flag}</span>
                  <span style={{ color: '#FFFFFF', fontSize: '13px', fontWeight: 500 }}>{selectedCountry.code}</span>
                  <ChevronDown size={12} color="#8B8FA8" />
                </button>
                <div
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    background: '#090514',
                    border: `1px solid ${phoneError ? 'rgba(239,68,68,0.5)' : 'rgba(255,255,255,0.1)'}`,
                    borderRadius: '16px',
                    height: '52px',
                    padding: '0 14px',
                    boxSizing: 'border-box',
                  }}
                >
                  <input
                    type="tel"
                    placeholder={selectedCountry.format}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    onBlur={() => setPhoneTouched(true)}
                    style={INPUT_STYLE}
                  />
                </div>
              </div>
              {phoneError && (
                <p style={{ color: '#EF4444', fontSize: '12px', marginTop: '6px' }}>{phoneError}</p>
              )}
            </div>
          </div>
        </div>

        {/* Additional attendees — one card per extra ticket in the group.
            Attendee 1 is the purchaser above; each of these gets its own
            distinct QR code, so the door scanner can check each person in
            individually with the right name. */}
        {quantity > 1 && (
          <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '16px', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
              <Users size={16} color="#A78BFA" />
              <p style={{ color: '#FFFFFF', fontSize: '15px', fontWeight: 700 }}>
                Attendee Details ({quantity} tickets)
              </p>
            </div>
            <p style={{ color: '#8B8FA8', fontSize: '12px', marginBottom: '16px', lineHeight: 1.5 }}>
              You're buying {quantity} tickets. Each ticket needs its own name and email so everyone gets a valid entry pass.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {additionalAttendees.map((attendee, i) => {
                const attendeeNumber = i + 2;
                const nameMissing = attendeesTouched && attendee.name.trim().length === 0;
                const attendeeEmailError = attendeesTouched && attendee.email.length > 0 && !isValidEmail(attendee.email)
                  ? 'Enter a valid email'
                  : attendeesTouched && attendee.email.length === 0
                  ? 'Email is required'
                  : undefined;
                return (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '10px', paddingTop: i === 0 ? 0 : '14px', borderTop: i === 0 ? 'none' : '1px dashed rgba(255,255,255,0.08)' }}>
                    <p style={{ color: '#A78BFA', fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      Attendee {attendeeNumber} Details
                    </p>
                    <Field
                      label="Full Name"
                      placeholder={`Attendee ${attendeeNumber} full name`}
                      value={attendee.name}
                      onChange={(v) => updateAttendee(i, 'name', v)}
                      error={nameMissing ? 'Name is required' : undefined}
                    />
                    <Field
                      label="Email Address"
                      placeholder="name@gmail.com"
                      value={attendee.email}
                      onChange={(v) => updateAttendee(i, 'email', v)}
                      type="email"
                      error={attendeeEmailError}
                    />
                    <Field
                      label="Phone Number"
                      placeholder="080 0000 0000"
                      value={attendee.phone ?? ''}
                      onChange={(v) => updateAttendee(i, 'phone', v)}
                      type="tel"
                      error={attendeesTouched && (attendee.phone ?? '').replace(/\D/g, '').length < 7 ? 'Valid phone required' : undefined}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Promo code */}
        <div style={{ marginBottom: '16px' }}>
          <div style={{ background: '#090514', border: `1px solid ${promoError ? 'rgba(239,68,68,0.4)' : 'rgba(255,255,255,0.06)'}`, borderRadius: '16px', padding: '14px', display: 'flex', gap: '10px', alignItems: 'center' }}>
            {promoApplied ? <CheckCircle2 size={16} color="#10B981" /> : <Tag size={16} color="#8B8FA8" />}
            <input
              placeholder="Promo code"
              value={promoCode}
              onChange={(e) => {
                setPromoCode(e.target.value);
                if (promoApplied) setPromoApplied(false);
                setPromoDiscountPct(0);
                setPromoError(null);
              }}
              style={{ ...INPUT_STYLE, flex: 1 }}
            />
            <button
              onClick={handleApplyPromo}
              disabled={!promoCode.trim() || promoChecking}
              style={{
                background: promoApplied ? 'rgba(16,185,129,0.15)' : 'rgba(124,58,237,0.15)',
                border: 'none',
                borderRadius: '8px',
                padding: '7px 14px',
                color: promoApplied ? '#10B981' : '#A78BFA',
                fontSize: '12px',
                fontWeight: 600,
                cursor: (!promoCode.trim() || promoChecking) ? 'not-allowed' : 'pointer',
                opacity: (!promoCode.trim() || promoChecking) ? 0.6 : 1,
              }}
            >
              {promoChecking ? 'Checking…' : promoApplied ? `✓ ${promoDiscountPct}% off` : 'Apply'}
            </button>
          </div>
          {promoError && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '6px', paddingLeft: '2px' }}>
              <AlertCircle size={11} color="#EF4444" />
              <span style={{ color: '#EF4444', fontSize: '11px' }}>{promoError}</span>
            </div>
          )}
        </div>

        {/* Order breakdown */}
        <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '14px' }}>
          <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 600, letterSpacing: '0.06em', marginBottom: '10px' }}>ORDER BREAKDOWN</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#94A3B8', fontSize: '14px' }}>{ticketType.name} × {quantity}</span>
              <span style={{ color: '#94A3B8', fontSize: '14px' }}>{formatPrice(subtotal)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#94A3B8', fontSize: '14px' }}>Service fee (5%)</span>
              <span style={{ color: '#94A3B8', fontSize: '14px' }}>{formatPrice(serviceFee)}</span>
            </div>
            {promoApplied && (
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#10B981', fontSize: '14px' }}>Promo ({promoDiscountPct}% off)</span>
                <span style={{ color: '#10B981', fontSize: '14px', fontWeight: 600 }}>-{formatPrice(discount)}</span>
              </div>
            )}
            <div style={{ height: '1px', background: 'rgba(255,255,255,0.1)', margin: '4px 0' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#FFFFFF', fontSize: '18px', fontWeight: 700 }}>Total</span>
              <span style={{ color: '#FFFFFF', fontSize: '18px', fontWeight: 700 }}>{formatPrice(total)}</span>
            </div>
          </div>
        </div>

        <p style={{ color: '#8B8FA8', fontSize: '11px', textAlign: 'center', marginTop: '10px' }}>
          Paystack processing fees may apply and will be shown before you complete payment.
        </p>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', marginTop: '14px' }}>
          <Lock size={12} color="#8B8FA8" />
          <span style={{ color: '#8B8FA8', fontSize: '11px' }}>Secured by 256-bit SSL encryption</span>
        </div>
      </div>

      {/* Pay CTA */}
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(6,10,18,0.95)', backdropFilter: 'blur(20px)', borderTop: '1px solid rgba(255,255,255,0.08)', padding: '14px 16px 28px' }}>

        {payError && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '10px', padding: '10px 12px' }}>
            <AlertCircle size={14} color="#EF4444" />
            <span style={{ color: '#EF4444', fontSize: '13px' }}>{payError}</span>
          </div>
        )}

        <button
          onClick={handlePay}
          disabled={paymentLoading}
          style={{
            width: '100%',
            height: '52px',
            background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
            border: 'none',
            borderRadius: '100px',
            padding: '0 24px',
            color: '#fff',
            fontSize: '16px',
            fontWeight: 700,
            fontFamily: 'Space Grotesk, sans-serif',
            cursor: paymentLoading ? 'not-allowed' : 'pointer',
            opacity: paymentLoading ? 0.6 : 1,
            boxShadow: '0 8px 24px rgba(123,47,190,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
          }}
        >
          {paymentLoading ? (
            <>
              <div style={{ width: '16px', height: '16px', borderRadius: '50%', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', animation: 'spin 0.7s linear infinite' }} />
              Processing...
            </>
          ) : (
            <>
              <Lock size={16} color="#fff" />
              {total === 0 ? 'Get Free Ticket' : `Pay ${formatPrice(total)}`}
            </>
          )}
        </button>
        <p style={{ fontSize: '11px', color: '#94A3B8', textAlign: 'center', marginTop: '8px', marginBottom: '0' }}>
          By purchasing you agree to our{' '}
          <span onClick={() => openExternalUrl('https://getvents.com/refunds')} style={{ color: '#C084FC', cursor: 'pointer' }}>Refund Policy</span>
          {' '}and{' '}
          <span onClick={() => openExternalUrl('https://getvents.com/terms')} style={{ color: '#C084FC', cursor: 'pointer' }}>Terms of Service</span>
        </p>
      </div>

      {/* Country picker modal */}
      {showCountryPicker && (
        <div onClick={() => setShowCountryPicker(false)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', background: '#090514', borderRadius: '24px 24px 0 0', maxHeight: '70%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '20px 20px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
              <p style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 700 }}>Select Country</p>
              <button onClick={() => setShowCountryPicker(false)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
                <X size={20} color="#8B8FA8" />
              </button>
            </div>
            <div style={{ overflowY: 'auto', padding: '8px 0 28px' }}>
              {COUNTRY_CODES.map((c) => (
                <button
                  key={`${c.code}-${c.name}`}
                  onClick={() => { setSelectedCountry(c); setShowCountryPicker(false); }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    width: '100%',
                    padding: '14px 20px',
                    background: selectedCountry.name === c.name ? 'rgba(124,58,237,0.1)' : 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ fontSize: '22px' }}>{c.flag}</span>
                  <div style={{ flex: 1, textAlign: 'left' }}>
                    <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 500 }}>{c.name}</p>
                    <p style={{ color: '#8B8FA8', fontSize: '12px' }}>Format: {c.format}</p>
                  </div>
                  <span style={{ color: '#A78BFA', fontSize: '14px', fontWeight: 600 }}>{c.code}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
