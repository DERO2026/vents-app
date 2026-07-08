import { useState } from 'react';
import { ArrowLeft, Minus, Plus, CreditCard, Shield, ChevronDown } from 'lucide-react';
import { Event, TicketType, PurchasedTicket } from './types';
import { formatPrice } from './data';

interface TicketPurchaseProps {
  event: Event;
  initialTicket: TicketType;
  onBack: () => void;
  onPurchaseComplete: (ticket: PurchasedTicket) => void;
}

const PAYMENT_METHODS = [
  { id: 'card', label: 'Debit/Credit Card', icon: '💳' },
  { id: 'transfer', label: 'Bank Transfer', icon: '🏦' },
  { id: 'ussd', label: 'USSD', icon: '#️⃣' },
];

export function TicketPurchase({ event, initialTicket, onBack, onPurchaseComplete }: TicketPurchaseProps) {
  const [selectedTicket, setSelectedTicket] = useState<TicketType>(initialTicket);
  const [quantity, setQuantity] = useState(1);
  const [paymentMethod, setPaymentMethod] = useState('card');
  const [holderName, setHolderName] = useState('Adebayo Johnson');
  const [email, setEmail] = useState('adebayo@gmail.com');
  const [processing, setProcessing] = useState(false);
  const [showTicketPicker, setShowTicketPicker] = useState(false);

  const serviceFee = Math.round(selectedTicket.price * 0.05);
  const subtotal = selectedTicket.price * quantity;
  const total = subtotal + serviceFee;

  const handlePurchase = () => {
    setProcessing(true);
    setTimeout(() => {
      const purchased: PurchasedTicket = {
        event,
        ticketType: selectedTicket,
        quantity,
        ticketId: 'VNT-' + Math.random().toString(36).substring(2, 10).toUpperCase(),
        purchasedAt: new Date().toISOString(),
        totalAmount: total,
        holderName,
      };
      onPurchaseComplete(purchased);
    }, 1800);
  };

  return (
    <div className="flex flex-col h-full" style={{ background: '#020005' }}>
      {/* Header */}
      <div
        className="flex items-center gap-3 px-4 pb-4"
        style={{ paddingTop: 'calc(14px + env(safe-area-inset-top))', borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <button
          onClick={onBack}
          className="w-9 h-9 rounded-full flex items-center justify-center"
          style={{ background: '#131629' }}
        >
          <ArrowLeft size={18} color="#F0F0FF" />
        </button>
        <div>
          <h1 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 700 }}>Purchase Ticket</h1>
          <p style={{ color: '#8B8FA8', fontSize: '12px' }}>{event.title}</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-32" style={{ scrollbarWidth: 'none' }}>
        <div className="px-4 pt-4">
          {/* Event summary mini card */}
          <div
            className="flex gap-3 p-3 mb-5"
            style={{ background: '#131629', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.05)' }}
          >
            <img
              src={event.image}
              alt={event.title}
              className="object-cover flex-shrink-0"
              style={{ width: '60px', height: '60px', borderRadius: '10px' }}
            />
            <div>
              <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>{event.title}</p>
              <p style={{ color: '#8B8FA8', fontSize: '12px' }}>{event.date} · {event.time}</p>
              <p style={{ color: '#8B8FA8', fontSize: '12px' }}>{event.venue}</p>
            </div>
          </div>

          {/* Ticket Type */}
          <div className="mb-4">
            <label style={{ color: '#A8AEC8', fontSize: '12px', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
              Ticket Type
            </label>
            <div className="relative mt-2">
              <button
                onClick={() => setShowTicketPicker(!showTicketPicker)}
                className="w-full flex items-center justify-between p-4"
                style={{
                  background: '#131629',
                  borderRadius: '14px',
                  border: '1px solid rgba(255,255,255,0.08)',
                }}
              >
                <div>
                  <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 600 }}>{selectedTicket.name}</p>
                  <p style={{ color: '#8B8FA8', fontSize: '12px' }}>{selectedTicket.description}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span style={{ color: '#FFB830', fontSize: '15px', fontWeight: 700 }}>
                    {formatPrice(selectedTicket.price)}
                  </span>
                  <ChevronDown size={16} color="#8B8FA8" />
                </div>
              </button>

              {showTicketPicker && (
                <div
                  className="absolute top-full left-0 right-0 z-10 mt-1"
                  style={{
                    background: '#1A1D2E',
                    borderRadius: '14px',
                    border: '1px solid rgba(255,255,255,0.1)',
                    overflow: 'hidden',
                  }}
                >
                  {event.ticketTypes.map((ticket) => (
                    <button
                      key={ticket.id}
                      onClick={() => {
                        setSelectedTicket(ticket);
                        setShowTicketPicker(false);
                      }}
                      className="w-full flex items-center justify-between p-3 text-left"
                      style={{
                        borderBottom: '1px solid rgba(255,255,255,0.05)',
                        background: ticket.id === selectedTicket.id ? 'rgba(123,47,190,0.15)' : 'transparent',
                      }}
                    >
                      <div>
                        <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 500 }}>{ticket.name}</p>
                        <p style={{ color: '#8B8FA8', fontSize: '12px' }}>{ticket.description}</p>
                      </div>
                      <span style={{ color: '#FFB830', fontSize: '14px', fontWeight: 700 }}>
                        {formatPrice(ticket.price)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Quantity */}
          <div className="mb-5">
            <label style={{ color: '#A8AEC8', fontSize: '12px', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
              Quantity
            </label>
            <div
              className="flex items-center justify-between mt-2 p-4"
              style={{ background: '#131629', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.08)' }}
            >
              <button
                onClick={() => setQuantity(Math.max(1, quantity - 1))}
                className="w-9 h-9 rounded-full flex items-center justify-center"
                style={{ background: '#1E2540' }}
              >
                <Minus size={16} color="#F0F0FF" />
              </button>
              <div className="text-center">
                <span style={{ color: '#F0F0FF', fontSize: '24px', fontWeight: 700 }}>{quantity}</span>
                <p style={{ color: '#8B8FA8', fontSize: '11px' }}>ticket{quantity > 1 ? 's' : ''}</p>
              </div>
              <button
                onClick={() => setQuantity(Math.min(10, quantity + 1))}
                className="w-9 h-9 rounded-full flex items-center justify-center"
                style={{ background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)' }}
              >
                <Plus size={16} color="#fff" />
              </button>
            </div>
          </div>

          {/* Attendee Info */}
          <div className="mb-5">
            <label style={{ color: '#A8AEC8', fontSize: '12px', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
              Attendee Details
            </label>
            <div className="flex flex-col gap-2 mt-2">
              <div>
                <p style={{ color: '#8B8FA8', fontSize: '12px', marginBottom: '4px' }}>Full Name</p>
                <input
                  value={holderName}
                  onChange={(e) => setHolderName(e.target.value)}
                  placeholder="Enter your full name"
                  style={{
                    width: '100%',
                    background: '#131629',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '12px',
                    padding: '12px 14px',
                    color: '#F0F0FF',
                    fontSize: '14px',
                    outline: 'none',
                  }}
                />
              </div>
              <div>
                <p style={{ color: '#8B8FA8', fontSize: '12px', marginBottom: '4px' }}>Email Address</p>
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Enter your email"
                  type="email"
                  style={{
                    width: '100%',
                    background: '#131629',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '12px',
                    padding: '12px 14px',
                    color: '#F0F0FF',
                    fontSize: '14px',
                    outline: 'none',
                  }}
                />
              </div>
            </div>
          </div>

          {/* Payment Method */}
          <div className="mb-5">
            <label style={{ color: '#A8AEC8', fontSize: '12px', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
              Payment Method
            </label>
            <div className="flex flex-col gap-2 mt-2">
              {PAYMENT_METHODS.map((method) => {
                const isActive = paymentMethod === method.id;
                return (
                  <button
                    key={method.id}
                    onClick={() => setPaymentMethod(method.id)}
                    className="flex items-center gap-3 p-3"
                    style={{
                      background: isActive ? 'rgba(123,47,190,0.12)' : '#131629',
                      borderRadius: '12px',
                      border: isActive ? '1.5px solid #7B2FBE' : '1px solid rgba(255,255,255,0.06)',
                      transition: 'all 0.2s',
                    }}
                  >
                    <span style={{ fontSize: '20px' }}>{method.icon}</span>
                    <span style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 500 }}>{method.label}</span>
                    <div className="ml-auto">
                      <div
                        style={{
                          width: '18px',
                          height: '18px',
                          borderRadius: '50%',
                          border: isActive ? '5px solid #7B2FBE' : '2px solid #8B8FA8',
                          transition: 'all 0.2s',
                        }}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Order Summary */}
          <div
            className="p-4 mb-4"
            style={{ background: '#131629', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.05)' }}
          >
            <h3 style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700 }} className="mb-3">
              Order Summary
            </h3>
            <div className="flex flex-col gap-2">
              <div className="flex justify-between">
                <span style={{ color: '#8B8FA8', fontSize: '14px' }}>
                  {selectedTicket.name} × {quantity}
                </span>
                <span style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 500 }}>
                  {formatPrice(subtotal)}
                </span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: '#8B8FA8', fontSize: '14px' }}>Service fee</span>
                <span style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 500 }}>
                  {formatPrice(serviceFee)}
                </span>
              </div>
              <div
                className="flex justify-between pt-2 mt-1"
                style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}
              >
                <span style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700 }}>Total</span>
                <span style={{ color: '#FFB830', fontSize: '16px', fontWeight: 700 }}>
                  {formatPrice(total)}
                </span>
              </div>
            </div>
          </div>

          {/* Security note */}
          <div className="flex items-center gap-2 justify-center mb-2">
            <Shield size={12} color="#8B8FA8" />
            <span style={{ color: '#8B8FA8', fontSize: '12px' }}>Secured by Paystack · 256-bit SSL</span>
          </div>
        </div>
      </div>

      {/* Pay Button */}
      <div
        className="absolute bottom-0 left-0 right-0 px-4 pb-6 pt-3"
        style={{ background: 'linear-gradient(to top, #020005 70%, transparent)' }}
      >
        <button
          onClick={handlePurchase}
          disabled={processing}
          className="w-full flex items-center justify-center gap-2"
          style={{
            height: '54px',
            background: processing
              ? '#2A2D3E'
              : 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
            borderRadius: '16px',
            boxShadow: processing ? 'none' : '0 6px 24px rgba(123,47,190,0.45)',
            transition: 'all 0.3s',
          }}
        >
          {processing ? (
            <div className="flex items-center gap-2">
              <div
                className="w-5 h-5 rounded-full border-2 border-white/30 border-t-white animate-spin"
              />
              <span style={{ color: '#8B8FA8', fontSize: '16px', fontWeight: 600 }}>Processing...</span>
            </div>
          ) : (
            <>
              <CreditCard size={18} color="#fff" />
              <span style={{ color: '#fff', fontSize: '16px', fontWeight: 700 }}>
                Pay {formatPrice(total)}
              </span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
