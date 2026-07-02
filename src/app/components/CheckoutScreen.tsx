import { useState, useEffect } from 'react';
import { ArrowLeft, CreditCard, Building2, Smartphone, Lock, Tag, ChevronDown, AlertCircle, X, Eye, EyeOff, CheckCircle, Search } from 'lucide-react';
import { Event, TicketType, PurchasedTicket } from './types';
import { formatPrice } from './data';
import { openPaystackPopup } from '../../lib/paystack';

interface CheckoutScreenProps {
  event: Event;
  ticketType: TicketType;
  quantity: number;
  currentUser: { id: string; email: string; full_name: string | null; username?: string } | null;
  onBack: () => void;
  onSuccess: (ticket: PurchasedTicket) => void;
}

type PayMethod = 'card' | 'bank' | 'ussd';
type BankStep = 'details' | 'login' | 'confirm';

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

// Our fixed receiving account — always Zenith Bank
const OUR_ACCOUNT = { bank: 'Zenith Bank', account: '1014567890', name: 'VENTS PAYMENTS LTD' };

// Customer's sending banks — where THEY pay FROM
const CUSTOMER_BANKS = [
  // Commercial banks
  { name: 'Access Bank', abbr: 'ACCESS', color: '#F47920', ussd: '*901#', category: 'Commercial' },
  { name: 'Zenith Bank', abbr: 'ZENITH', color: '#D40021', ussd: '*966#', category: 'Commercial' },
  { name: 'GTBank', abbr: 'GTB', color: '#E8A000', ussd: '*737#', category: 'Commercial' },
  { name: 'First Bank of Nigeria', abbr: 'FIRSTBANK', color: '#009A44', ussd: '*894#', category: 'Commercial' },
  { name: 'UBA', abbr: 'UBA', color: '#BC1E24', ussd: '*919#', category: 'Commercial' },
  { name: 'Fidelity Bank', abbr: 'FIDELITY', color: '#006600', ussd: '*770#', category: 'Commercial' },
  { name: 'FCMB', abbr: 'FCMB', color: '#002060', ussd: '*329#', category: 'Commercial' },
  { name: 'Sterling Bank', abbr: 'STERLING', color: '#0F5FB5', ussd: '*822#', category: 'Commercial' },
  { name: 'Polaris Bank', abbr: 'POLARIS', color: '#0B4C8C', ussd: '*833#', category: 'Commercial' },
  { name: 'Wema Bank', abbr: 'WEMA', color: '#7B2183', ussd: '*945#', category: 'Commercial' },
  { name: 'Keystone Bank', abbr: 'KEYSTONE', color: '#C8111A', ussd: '*7111#', category: 'Commercial' },
  { name: 'Union Bank', abbr: 'UNION', color: '#004B87', ussd: '*826#', category: 'Commercial' },
  { name: 'Ecobank Nigeria', abbr: 'ECO', color: '#003399', ussd: '*326#', category: 'Commercial' },
  { name: 'Stanbic IBTC Bank', abbr: 'STANBIC', color: '#009A44', ussd: '*909#', category: 'Commercial' },
  { name: 'Heritage Bank', abbr: 'HERITAGE', color: '#FF6600', ussd: '*745#', category: 'Commercial' },
  { name: 'Citibank Nigeria', abbr: 'CITI', color: '#056DAE', ussd: 'App only', category: 'Commercial' },
  // Microfinance & Digital banks
  { name: 'Kuda Bank', abbr: 'KUDA', color: '#40196D', ussd: 'App only', category: 'Digital' },
  { name: 'OPay', abbr: 'OPAY', color: '#1A7A40', ussd: '*955#', category: 'Digital' },
  { name: 'PalmPay', abbr: 'PALM', color: '#07C160', ussd: 'App only', category: 'Digital' },
  { name: 'Moniepoint MFB', abbr: 'MONIE', color: '#0052CC', ussd: '*5573#', category: 'Digital' },
  { name: 'Carbon (Paylater)', abbr: 'CARBON', color: '#1A1A1A', ussd: 'App only', category: 'Digital' },
  { name: 'FairMoney MFB', abbr: 'FAIR', color: '#FF6600', ussd: 'App only', category: 'Digital' },
  { name: 'VFD MFB', abbr: 'VFD', color: '#003580', ussd: '*5037#', category: 'Digital' },
  { name: 'Rubies MFB', abbr: 'RUBIES', color: '#C8111A', ussd: '*7797#', category: 'Digital' },
  { name: 'Sparkle MFB', abbr: 'SPARKLE', color: '#6C5CE7', ussd: 'App only', category: 'Digital' },
  { name: 'Eyowo', abbr: 'EYOWO', color: '#FF3B30', ussd: '*4255#', category: 'Digital' },
];

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
  const [selectedCountry, setSelectedCountry] = useState(COUNTRY_CODES[0]);
  const [showCountryPicker, setShowCountryPicker] = useState(false);
  const [showBankPicker, setShowBankPicker] = useState(false);
  const [selectedCustomerBank, setSelectedCustomerBank] = useState(CUSTOMER_BANKS[0]);
  const [bankStep, setBankStep] = useState<BankStep>('details');
  const [bankUsername, setBankUsername] = useState('');
  const [bankPassword, setBankPassword] = useState('');
  const [showBankPassword, setShowBankPassword] = useState(false);
  const [bankLoginLoading, setBankLoginLoading] = useState(false);
  const [bankSearchQuery, setBankSearchQuery] = useState('');
  const [payMethod, setPayMethod] = useState<PayMethod>('card');
  const [cardNum, setCardNum] = useState('');
  const [cardExpiry, setCardExpiry] = useState('');
  const [cardCvv, setCardCvv] = useState('');
  const [promoCode, setPromoCode] = useState('');
  const [promoApplied, setPromoApplied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saveCard, setSaveCard] = useState(false);
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  const subtotal = ticketType.price * quantity;
  const serviceFee = Math.round(subtotal * 0.05);
  const discount = promoApplied ? Math.round(subtotal * 0.1) : 0;
  const total = Math.max(0, subtotal + serviceFee - discount);

  const emailError = emailTouched && email.length > 0 && !isValidEmail(email)
    ? 'Enter a valid email (e.g. name@gmail.com)'
    : undefined;

  const formatCardNum = (v: string) => v.replace(/\D/g, '').replace(/(.{4})/g, '$1 ').trim().slice(0, 19);
  const formatExpiry = (v: string) => v.replace(/\D/g, '').replace(/^(\d{2})(\d)/, '$1/$2').slice(0, 5);

  const payMethods: { id: PayMethod; label: string; icon: React.ElementType; desc: string }[] = [
    { id: 'card', label: 'Debit/Credit Card', icon: CreditCard, desc: 'Visa, Mastercard, Verve' },
    { id: 'bank', label: 'Bank Transfer', icon: Building2, desc: 'Nigerian banks & MFBs' },
    { id: 'ussd', label: 'USSD', icon: Smartphone, desc: 'Dial from any phone' },
  ];

  const handleFreeTicket = () => {
    const ticket: PurchasedTicket = {
      event,
      ticketType,
      quantity,
      ticketId: `VNT-FREE-${Date.now().toString(36).toUpperCase()}`,
      purchasedAt: new Date().toISOString(),
      totalAmount: 0,
      holderName: name.trim() || 'Guest',
    };
    onSuccess(ticket);
  };

  const handlePay = () => {
    setPayError(null);

    const payerEmail = currentUser?.email || email.trim();
    if (!payerEmail || !isValidEmail(payerEmail)) {
      setPayError('A valid email address is required to pay.');
      return;
    }

    if (!event?.id) {
      setPayError('Event not found. Please go back and try again.');
      return;
    }

    // Free tickets bypass Paystack
    if (total === 0) {
      handleFreeTicket();
      return;
    }

    const amountKobo = Math.round(total * 100);
    if (amountKobo <= 0 || isNaN(amountKobo)) {
      setPayError('Invalid payment amount. Please go back and try again.');
      return;
    }

    const PaystackPop = (window as any).PaystackPop;
    if (!PaystackPop) {
      setPayError('Payment system not loaded. Please refresh the page and try again.');
      return;
    }

    const reference = `VENTS_${Date.now()}_${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

    const publicKey = import.meta.env.VITE_PAYSTACK_PUBLIC_KEY;
    console.log('[PAYSTACK REQUEST DEBUG]', JSON.stringify({ key: publicKey?.substring(0, 15), email: payerEmail, amount: amountKobo, currency: 'NGN', ref: reference }));

    try {
      const handler = PaystackPop.setup({
        key: publicKey,
        email: payerEmail,
        amount: amountKobo,
        currency: 'NGN',
        ref: reference,
        label: currentUser?.full_name || currentUser?.username || name.trim() || '',
        channels: saveCard ? ['card'] : ['card', 'bank_transfer', 'ussd', 'mobile_money', 'bank'],
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
          setPaymentLoading(true);
          const ticket: PurchasedTicket = {
            event,
            ticketType,
            quantity,
            ticketId: response.reference,
            purchasedAt: new Date().toISOString(),
            totalAmount: total,
            holderName: name.trim() || currentUser?.full_name || 'Guest',
          };
          onSuccess(ticket);
          setPaymentLoading(false);
        },
        onClose: () => {
          setPaymentLoading(false);
        },
      });

      handler.openIframe();
    } catch (err: any) {
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
            background: '#131629',
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
            <Field label="Full Name" placeholder="Your full name" value={name} onChange={setName} />
            <Field
              label="Email Address"
              placeholder="name@gmail.com"
              value={email}
              onChange={setEmail}
              type="email"
              error={emailError}
              onBlur={() => setEmailTouched(true)}
            />

            {/* Phone with country code */}
            <div>
              <p style={{ color: '#94A3B8', fontSize: '12px', marginBottom: '6px', fontWeight: 500, textTransform: 'uppercase' }}>Phone Number</p>
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
                    border: '1px solid rgba(255,255,255,0.1)',
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
                    style={INPUT_STYLE}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Payment method */}
        <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '16px', marginBottom: '16px' }}>
          <p style={{ color: '#FFFFFF', fontSize: '15px', fontWeight: 700, marginBottom: '12px' }}>Payment Method</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px' }}>
            {payMethods.map((pm) => {
              const Icon = pm.icon;
              const isActive = payMethod === pm.id;
              return (
                <button
                  key={pm.id}
                  onClick={() => setPayMethod(pm.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    background: isActive ? 'rgba(123,47,190,0.1)' : '#090514',
                    border: isActive ? '1px solid #7B2FBE' : '1px solid rgba(255,255,255,0.07)',
                    borderRadius: '12px',
                    padding: '12px',
                    cursor: 'pointer',
                    textAlign: 'left',
                    width: '100%',
                  }}
                >
                  <div style={{ width: '38px', height: '38px', borderRadius: '10px', background: isActive ? 'rgba(124,58,237,0.2)' : 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <Icon size={18} color={isActive ? '#A78BFA' : '#8B8FA8'} />
                  </div>
                  <div>
                    <p style={{ color: '#FFFFFF', fontSize: '13px', fontWeight: 600 }}>{pm.label}</p>
                    <p style={{ color: '#8B8FA8', fontSize: '11px' }}>{pm.desc}</p>
                  </div>
                  <div style={{ marginLeft: 'auto', width: '18px', height: '18px', borderRadius: '50%', border: isActive ? 'none' : '2px solid rgba(255,255,255,0.2)', background: isActive ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)' : 'transparent' }} />
                </button>
              );
            })}
          </div>

          {/* Card details */}
          {payMethod === 'card' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <Field
                label="Card Number"
                placeholder="0000 0000 0000 0000"
                value={cardNum}
                onChange={(v) => setCardNum(formatCardNum(v))}
                icon={<CreditCard size={16} color="#8B8FA8" />}
              />
              <div style={{ display: 'flex', gap: '10px', minWidth: 0 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Field label="Expiry" placeholder="MM/YY" value={cardExpiry} onChange={(v) => setCardExpiry(formatExpiry(v))} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Field label="CVV" placeholder="•••" value={cardCvv} onChange={setCardCvv} type="password" />
                </div>
              </div>
            </div>
          )}

          {/* Bank transfer */}
          {payMethod === 'bank' && bankStep === 'details' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {/* Our fixed receiving account */}
              <div style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: '12px', padding: '12px' }}>
                <p style={{ color: '#10B981', fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em', marginBottom: '8px' }}>TRANSFER TO THIS ACCOUNT</p>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                  <span style={{ color: '#8B8FA8', fontSize: '12px' }}>Bank</span>
                  <span style={{ color: '#F0F0FF', fontSize: '12px', fontWeight: 700 }}>{OUR_ACCOUNT.bank}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                  <span style={{ color: '#8B8FA8', fontSize: '12px' }}>Account No.</span>
                  <span style={{ color: '#FFB830', fontSize: '13px', fontWeight: 800, fontFamily: 'monospace', letterSpacing: '0.05em' }}>{OUR_ACCOUNT.account}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                  <span style={{ color: '#8B8FA8', fontSize: '12px' }}>Account Name</span>
                  <span style={{ color: '#F0F0FF', fontSize: '12px', fontWeight: 600 }}>{OUR_ACCOUNT.name}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#8B8FA8', fontSize: '12px' }}>Amount</span>
                  <span style={{ color: '#10B981', fontSize: '14px', fontWeight: 800 }}>{formatPrice(total)}</span>
                </div>
              </div>

              {/* Their bank selector */}
              <p style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 600, marginTop: '4px' }}>SELECT YOUR BANK TO PAY WITH</p>
              <button
                onClick={() => setShowBankPicker(true)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%',
                  background: '#0D0F1E', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px',
                  padding: '12px 14px', cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: selectedCustomerBank.color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span style={{ color: '#fff', fontSize: '9px', fontWeight: 800 }}>{selectedCustomerBank.abbr}</span>
                  </div>
                  <div style={{ textAlign: 'left' }}>
                    <p style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 600 }}>{selectedCustomerBank.name}</p>
                    <p style={{ color: '#8B8FA8', fontSize: '11px' }}>{selectedCustomerBank.category} · USSD: {selectedCustomerBank.ussd}</p>
                  </div>
                </div>
                <ChevronDown size={16} color="#8B8FA8" />
              </button>
              <button
                onClick={() => setBankStep('login')}
                style={{
                  width: '100%', background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
                  border: 'none', borderRadius: '12px', padding: '14px',
                  color: '#fff', fontSize: '14px', fontWeight: 700, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                }}
              >
                <Building2 size={16} color="#fff" />
                Log in to {selectedCustomerBank.name}
              </button>
            </div>
          )}

          {/* Bank login screen */}
          {payMethod === 'bank' && bankStep === 'login' && (
            <div style={{ background: '#0A0C18', border: `1px solid ${selectedCustomerBank.color}40`, borderRadius: '16px', overflow: 'hidden' }}>
              {/* Bank header */}
              <div style={{ background: selectedCustomerBank.color, padding: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                <button onClick={() => setBankStep('details')} style={{ background: 'rgba(0,0,0,0.2)', border: 'none', borderRadius: '50%', width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                  <ArrowLeft size={14} color="#fff" />
                </button>
                <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ color: '#fff', fontSize: '10px', fontWeight: 800 }}>{selectedCustomerBank.abbr}</span>
                </div>
                <div>
                  <p style={{ color: '#fff', fontSize: '14px', fontWeight: 700 }}>{selectedCustomerBank.name}</p>
                  <p style={{ color: 'rgba(255,255,255,0.75)', fontSize: '11px' }}>Internet Banking — Secure Login</p>
                </div>
              </div>
              <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <p style={{ color: '#8B8FA8', fontSize: '12px', textAlign: 'center' }}>
                  Sign in to authorize a transfer of{' '}
                  <span style={{ color: '#FFB830', fontWeight: 700 }}>{formatPrice(total)}</span>
                </p>
                <div>
                  <p style={{ color: '#8B8FA8', fontSize: '11px', marginBottom: '5px', fontWeight: 500 }}>Username / Customer ID</p>
                  <div style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', padding: '11px 13px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input placeholder="Enter username" value={bankUsername} onChange={(e) => setBankUsername(e.target.value)} style={{ ...INPUT_STYLE }} />
                  </div>
                </div>
                <div>
                  <p style={{ color: '#8B8FA8', fontSize: '11px', marginBottom: '5px', fontWeight: 500 }}>Password</p>
                  <div style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', padding: '11px 13px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input placeholder="Enter password" type={showBankPassword ? 'text' : 'password'} value={bankPassword} onChange={(e) => setBankPassword(e.target.value)} style={{ ...INPUT_STYLE }} />
                    <button onClick={() => setShowBankPassword(!showBankPassword)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                      {showBankPassword ? <EyeOff size={15} color="#8B8FA8" /> : <Eye size={15} color="#8B8FA8" />}
                    </button>
                  </div>
                </div>
                <button
                  onClick={() => {
                    if (!bankUsername || !bankPassword) return;
                    setBankLoginLoading(true);
                    setTimeout(() => { setBankLoginLoading(false); setBankStep('confirm'); }, 1500);
                  }}
                  disabled={bankLoginLoading || !bankUsername || !bankPassword}
                  style={{
                    width: '100%', background: bankUsername && bankPassword ? selectedCustomerBank.color : 'rgba(255,255,255,0.08)',
                    border: 'none', borderRadius: '10px', padding: '13px',
                    color: '#fff', fontSize: '14px', fontWeight: 700, cursor: bankUsername && bankPassword ? 'pointer' : 'not-allowed',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                    opacity: bankUsername && bankPassword ? 1 : 0.5,
                  }}
                >
                  {bankLoginLoading ? (
                    <div style={{ width: '16px', height: '16px', borderRadius: '50%', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', animation: 'spin 0.7s linear infinite' }} />
                  ) : 'Sign In'}
                </button>
                <p style={{ color: '#5A5A7A', fontSize: '10px', textAlign: 'center' }}>
                  🔒 Your login is secured and never stored by VENTS
                </p>
              </div>
            </div>
          )}

          {/* Transfer confirmation */}
          {payMethod === 'bank' && bankStep === 'confirm' && (
            <div style={{ background: '#0A0C18', border: `1px solid ${selectedCustomerBank.color}40`, borderRadius: '16px', overflow: 'hidden' }}>
              <div style={{ background: selectedCustomerBank.color, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <CheckCircle size={16} color="#fff" />
                <p style={{ color: '#fff', fontSize: '13px', fontWeight: 700 }}>Logged in · {selectedCustomerBank.name}</p>
              </div>
              <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700, marginBottom: '4px' }}>Confirm Transfer</p>
                {[
                  { label: 'From', value: `${selectedCustomerBank.name} (your account)` },
                  { label: 'To', value: `${OUR_ACCOUNT.bank} — ${OUR_ACCOUNT.account}` },
                  { label: 'Beneficiary', value: OUR_ACCOUNT.name },
                  { label: 'Amount', value: formatPrice(total), highlight: true },
                  { label: 'Narration', value: 'VENTS ticket payment' },
                ].map(({ label, value, highlight }) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '6px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <span style={{ color: '#8B8FA8', fontSize: '12px' }}>{label}</span>
                    <span style={{ color: highlight ? '#FFB830' : '#F0F0FF', fontSize: '12px', fontWeight: highlight ? 800 : 600, textAlign: 'right', maxWidth: '60%' }}>{value}</span>
                  </div>
                ))}
                <p style={{ color: '#5A5A7A', fontSize: '10px', marginTop: '4px' }}>
                  By confirming, you authorize this debit from your {selectedCustomerBank.name} account.
                </p>
              </div>
            </div>
          )}

          {/* USSD */}
          {payMethod === 'ussd' && (
            <div style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: '12px', padding: '12px' }}>
              <p style={{ color: '#3B82F6', fontSize: '13px', fontWeight: 600, marginBottom: '6px' }}>USSD Codes</p>
              {[
                { bank: 'Zenith Bank', code: `*966*${total}#` },
                { bank: 'GTBank', code: `*737*58*${total}#` },
                { bank: 'Access Bank', code: `*901*58*${total}#` },
                { bank: 'First Bank', code: `*894*${total}#` },
                { bank: 'UBA', code: `*919*58*${total}#` },
              ].map(({ bank, code }) => (
                <div key={bank} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span style={{ color: '#C4C9E0', fontSize: '12px' }}>{bank}:</span>
                  <span style={{ color: '#F0F0FF', fontSize: '12px', fontWeight: 700, fontFamily: 'monospace' }}>Dial {code}</span>
                </div>
              ))}
              <p style={{ color: '#8B8FA8', fontSize: '11px', marginTop: '6px' }}>Ticket sent to email after payment confirmation.</p>
            </div>
          )}
        </div>

        {/* Promo code */}
        <div style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '14px', marginBottom: '16px', display: 'flex', gap: '10px', alignItems: 'center' }}>
          <Tag size={16} color="#8B8FA8" />
          <input placeholder="Promo code" value={promoCode} onChange={(e) => setPromoCode(e.target.value)} style={{ ...INPUT_STYLE, flex: 1 }} />
          <button
            onClick={() => promoCode && setPromoApplied(true)}
            style={{
              background: promoApplied ? 'rgba(16,185,129,0.15)' : 'rgba(124,58,237,0.15)',
              border: 'none',
              borderRadius: '8px',
              padding: '7px 14px',
              color: promoApplied ? '#10B981' : '#A78BFA',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {promoApplied ? '✓ Applied' : 'Apply'}
          </button>
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
                <span style={{ color: '#10B981', fontSize: '14px' }}>Promo (10% off)</span>
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

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', marginTop: '14px' }}>
          <Lock size={12} color="#8B8FA8" />
          <span style={{ color: '#8B8FA8', fontSize: '11px' }}>Secured by 256-bit SSL encryption</span>
        </div>
      </div>

      {/* Pay CTA */}
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(6,10,18,0.95)', backdropFilter: 'blur(20px)', borderTop: '1px solid rgba(255,255,255,0.08)', padding: '14px 16px 28px' }}>

        {/* Payment method badges */}
        {total > 0 && (
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap' }}>
            <span style={{ color: '#555C7A', fontSize: '11px' }}>Pay with:</span>
            {['Visa', 'Mastercard', 'Verve', 'Bank Transfer', 'USSD'].map((method) => (
              <span key={method} style={{
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '6px',
                padding: '3px 8px',
                fontSize: '10px',
                color: '#aaa',
                fontWeight: 600,
              }}>{method}</span>
            ))}
          </div>
        )}

        {/* Save card checkbox */}
        {total > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
            <input
              type="checkbox"
              id="saveCard"
              checked={saveCard}
              onChange={(e) => setSaveCard(e.target.checked)}
              style={{ accentColor: '#7B2FF7', width: '16px', height: '16px', cursor: 'pointer' }}
            />
            <label htmlFor="saveCard" style={{ color: '#888', fontSize: '13px', cursor: 'pointer' }}>
              Save card for faster future payments
            </label>
          </div>
        )}

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
          <span onClick={() => window.open('https://getvents.com/refunds', '_blank')} style={{ color: '#C084FC', cursor: 'pointer' }}>Refund Policy</span>
          {' '}and{' '}
          <span onClick={() => window.open('https://getvents.com/terms', '_blank')} style={{ color: '#C084FC', cursor: 'pointer' }}>Terms of Service</span>
        </p>
      </div>

      {/* Country picker modal */}
      {showCountryPicker && (
        <div onClick={() => setShowCountryPicker(false)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', background: '#131629', borderRadius: '24px 24px 0 0', maxHeight: '70%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
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

      {/* Bank picker modal */}
      {showBankPicker && (
        <div onClick={() => setShowBankPicker(false)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', background: '#0F1120', borderRadius: '24px 24px 0 0', maxHeight: '82%', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '20px 20px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
              <div>
                <p style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 700 }}>Your Bank</p>
                <p style={{ color: '#8B8FA8', fontSize: '12px' }}>Select the bank you'll pay FROM</p>
              </div>
              <button onClick={() => setShowBankPicker(false)} style={{ background: 'rgba(255,255,255,0.06)', border: 'none', borderRadius: '50%', width: '32px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                <X size={16} color="#C4C9E0" />
              </button>
            </div>
            {/* Search */}
            <div style={{ padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: '#131629', borderRadius: '10px', padding: '9px 12px' }}>
                <Search size={14} color="#8B8FA8" />
                <input
                  placeholder="Search banks..."
                  value={bankSearchQuery}
                  onChange={(e) => setBankSearchQuery(e.target.value)}
                  style={{ ...INPUT_STYLE, fontSize: '13px' }}
                />
              </div>
            </div>
            <div style={{ overflowY: 'auto', padding: '8px 0 32px', flex: 1 }}>
              {(['Commercial', 'Digital'] as const).map((cat) => {
                const banks = CUSTOMER_BANKS.filter((b) => b.category === cat && b.name.toLowerCase().includes(bankSearchQuery.toLowerCase()));
                if (banks.length === 0) return null;
                return (
                  <div key={cat}>
                    <p style={{ color: '#5A5A7A', fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', padding: '10px 20px 4px' }}>
                      {cat === 'Commercial' ? 'COMMERCIAL BANKS' : 'DIGITAL & MICROFINANCE BANKS'}
                    </p>
                    {banks.map((bank) => {
                      const isSelected = selectedCustomerBank.name === bank.name;
                      return (
                        <button
                          key={bank.name}
                          onClick={() => { setSelectedCustomerBank(bank); setShowBankPicker(false); setBankStep('details'); }}
                          style={{ display: 'flex', alignItems: 'center', gap: '12px', width: '100%', padding: '12px 20px', background: isSelected ? 'rgba(255,255,255,0.04)' : 'transparent', border: 'none', cursor: 'pointer' }}
                        >
                          <div style={{ width: '38px', height: '38px', borderRadius: '10px', background: bank.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            <span style={{ color: '#fff', fontSize: '8px', fontWeight: 900 }}>{bank.abbr}</span>
                          </div>
                          <div style={{ flex: 1, textAlign: 'left' }}>
                            <p style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 600 }}>{bank.name}</p>
                            <p style={{ color: '#8B8FA8', fontSize: '11px' }}>USSD: {bank.ussd}</p>
                          </div>
                          {isSelected && <CheckCircle size={18} color="#10B981" />}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
