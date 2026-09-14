import { useEffect, useState } from 'react';
import { ArrowLeft, Wallet, Plus, ArrowDownLeft, ArrowUpRight, RotateCcw, Loader, ChevronRight, Ticket, Sparkles, CreditCard } from 'lucide-react';
import { fetchMyWalletBalanceKobo, fetchMyWalletTransactions, depositToWallet, findTicketIdForPaymentRef, UserWalletTransaction } from '../../lib/userWallet';
import { classifyWalletTransaction } from '../../lib/walletTransactionClassifier';
import { haptics } from '../../lib/haptics';

// Customer-facing VENTS Wallet -- deliberately separate from WalletScreen.tsx
// (organizer/provider EARNINGS, withdrawable) and from VENTS Cents
// (non-cash points, spendable only on app features). This is a deposit-
// funded, spendable, NEVER-withdrawable NGN balance -- no Withdraw button
// exists here, and none should ever be added; see 0065_user_wallets.sql's
// own header comment on why that's a structural property of the backend,
// not just a UI omission.
//
// This pass builds the foundation + deposit flow only -- wallet balance is
// not yet spendable at ticket/service checkout (that's a separate,
// deliberately later pass once this foundation is independently verified).

interface UserWalletScreenProps {
  currentUser: { id: string; email?: string } | null;
  onBack: () => void;
  // Both optional and degrade to simply not showing a deep-link button --
  // this screen never fabricates a destination it can't actually resolve.
  // Implemented in App.tsx using the SAME existing navigation this app
  // already uses for ticket/booking notifications (myTicketsFocusTicket +
  // 'my-tickets', 'service-bookings') -- no new destination screens.
  onViewTicket?: (ticketId: string) => void;
  onViewServiceBookings?: () => void;
}

const DEPOSIT_PRESETS_NAIRA = [1000, 2000, 5000, 10000];

function fmtNaira(kobo: number) {
  return '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-NG', { dateStyle: 'medium' }) +
    ' · ' + new Date(iso).toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' });
}

const TX_ICON: Record<UserWalletTransaction['type'], { Icon: typeof ArrowDownLeft; color: string }> = {
  deposit: { Icon: ArrowDownLeft, color: '#10B981' },
  spend: { Icon: ArrowUpRight, color: '#F59E0B' },
  refund: { Icon: RotateCcw, color: '#A855F7' },
};

// Reference/ticket ids are shown truncated -- enough to match against a
// support ticket or a receipt screenshot without printing the full opaque
// id, which is never itself sensitive but has no reason to be shown in full.
function maskRef(ref: string): string {
  if (ref.length <= 14) return ref;
  return `${ref.slice(0, 8)}…${ref.slice(-6)}`;
}

function DetailRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '11px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
      <span style={{ color: '#8B8FA8', fontSize: '12.5px', flexShrink: 0 }}>{label}</span>
      <span style={{ color: valueColor || '#F0F0FA', fontSize: '13px', fontWeight: 600, textAlign: 'right', wordBreak: 'break-word' }}>{value}</span>
    </div>
  );
}

export function UserWalletScreen({ currentUser, onBack, onViewTicket, onViewServiceBookings }: UserWalletScreenProps) {
  const [balanceKobo, setBalanceKobo] = useState<number | null>(null);
  const [transactions, setTransactions] = useState<UserWalletTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showDeposit, setShowDeposit] = useState(false);
  const [depositAmount, setDepositAmount] = useState('');
  const [depositing, setDepositing] = useState(false);
  const [depositError, setDepositError] = useState('');
  const [selectedTx, setSelectedTx] = useState<UserWalletTransaction | null>(null);
  const [resolvingTicket, setResolvingTicket] = useState(false);
  const [resolveTicketError, setResolveTicketError] = useState('');

  const load = async () => {
    setError('');
    try {
      const [balance, txs] = await Promise.all([
        fetchMyWalletBalanceKobo(),
        fetchMyWalletTransactions(),
      ]);
      setBalanceKobo(balance);
      setTransactions(txs);
    } catch (e: any) {
      setError(e?.message || 'Failed to load your wallet.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openDeposit = () => {
    haptics.light();
    setDepositAmount('');
    setDepositError('');
    setShowDeposit(true);
  };

  const handleDeposit = async () => {
    const naira = Number(depositAmount);
    if (!naira || naira < 500) { setDepositError('Enter at least ₦500.'); return; }
    if (depositing) return;
    setDepositing(true);
    setDepositError('');
    try {
      const result = await depositToWallet(currentUser?.email || '', Math.round(naira * 100));
      if (result.status === 'success') {
        haptics.success();
        setShowDeposit(false);
        await load();
      } else if (result.error !== 'cancelled') {
        haptics.error();
        setDepositError(result.error || 'Deposit could not be completed.');
      }
    } catch (e: any) {
      haptics.error();
      setDepositError(e?.message || 'Deposit could not be started.');
    } finally {
      setDepositing(false);
    }
  };

  return (
    <div
      style={{
        background: 'radial-gradient(ellipse 520px 320px at 50% -8%, rgba(123,47,190,0.10) 0%, rgba(5,2,10,1) 40%, #050208 100%)',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'Inter, sans-serif',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(20px + env(safe-area-inset-top)) 16px 18px' }}>
        <button
          onClick={onBack}
          aria-label="Back"
          style={{
            background: 'rgba(255,255,255,0.04)', backdropFilter: 'blur(20px) saturate(180%)', WebkitBackdropFilter: 'blur(20px) saturate(180%)',
            border: '1px solid rgba(255,255,255,0.07)', borderRadius: '50%', width: '34px', height: '34px',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0,
          }}
        >
          <ArrowLeft size={15} color="#C4C9E0" />
        </button>
        <h1 style={{ color: '#F5F5FA', fontSize: '17px', fontWeight: 700, fontFamily: 'Space Grotesk, sans-serif', margin: 0 }}>
          VENTS Wallet
        </h1>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 16px 24px' }}>
        {/* Balance card */}
        <div
          style={{
            background: 'linear-gradient(135deg, rgba(123,47,190,0.22), rgba(79,70,229,0.16))',
            backdropFilter: 'blur(20px) saturate(180%)', WebkitBackdropFilter: 'blur(20px) saturate(180%)',
            border: '1px solid rgba(168,85,247,0.22)', borderRadius: '22px', padding: '22px', marginBottom: '20px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
            <div style={{ width: '30px', height: '30px', borderRadius: '50%', background: 'rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Wallet size={15} color="#D8B4FE" />
            </div>
            <span style={{ color: '#C4B5FD', fontSize: '12px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
              Spendable Balance
            </span>
          </div>
          <p style={{ color: '#fff', fontSize: '34px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', margin: '0 0 4px' }}>
            {loading ? '—' : fmtNaira(balanceKobo || 0)}
          </p>
          <p style={{ color: '#9A9DB5', fontSize: '12px', margin: '0 0 18px' }}>
            For tickets &amp; Services · not withdrawable
          </p>
          <button
            onClick={openDeposit}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
              background: 'linear-gradient(135deg,#7C3AED,#A855F7)', border: 'none', borderRadius: '14px',
              padding: '13px', color: '#fff', fontSize: '14px', fontWeight: 700, cursor: 'pointer',
            }}
          >
            <Plus size={16} /> Deposit Funds
          </button>
        </div>

        {error && (
          <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '12px', padding: '12px 14px', marginBottom: '16px', color: '#F87171', fontSize: '13px' }}>
            {error}
          </div>
        )}

        {/* History */}
        <p style={{ color: '#9CA0BC', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', margin: '0 0 10px' }}>
          TRANSACTION HISTORY
        </p>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0', color: '#6B7089' }}>
            <Loader size={18} className="animate-spin" />
          </div>
        ) : transactions.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', padding: '48px 16px' }}>
            <div style={{ width: '56px', height: '56px', borderRadius: '50%', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Wallet size={22} color="#4A4E63" strokeWidth={1.5} />
            </div>
            <p style={{ color: '#8B8FA8', fontSize: '13px', margin: 0, textAlign: 'center' }}>
              No wallet activity yet. Deposit funds to get started.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {transactions.map((tx) => {
              const { Icon, color } = TX_ICON[tx.type];
              const sign = tx.type === 'spend' ? '-' : '+';
              return (
                <button
                  key={tx.id}
                  onClick={() => { haptics.light(); setResolveTicketError(''); setSelectedTx(tx); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '12px', padding: '13px 14px', width: '100%',
                    background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '16px',
                    cursor: 'pointer', textAlign: 'left', font: 'inherit',
                  }}
                >
                  <div style={{ width: '34px', height: '34px', borderRadius: '50%', background: `${color}18`, border: `1px solid ${color}30`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <Icon size={15} color={color} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ color: '#F0F0FA', fontSize: '13.5px', fontWeight: 600, margin: '0 0 2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {tx.description || (tx.type === 'deposit' ? 'Wallet top-up' : tx.type === 'spend' ? 'Purchase' : 'Refund')}
                    </p>
                    <p style={{ color: '#5C6079', fontSize: '11px', margin: 0 }}>{fmtDate(tx.createdAt)}</p>
                  </div>
                  <span style={{ color, fontSize: '14px', fontWeight: 700, flexShrink: 0 }}>
                    {sign}{fmtNaira(tx.amountKobo)}
                  </span>
                  <ChevronRight size={15} color="#4A4E63" style={{ flexShrink: 0 }} />
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Deposit sheet */}
      {showDeposit && (
        <div
          onClick={() => !depositing && setShowDeposit(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'flex-end', zIndex: 300 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%', background: '#0A0612', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '22px 22px 0 0', padding: '22px 20px calc(22px + env(safe-area-inset-bottom))',
            }}
          >
            <h2 style={{ color: '#F0F0FF', fontSize: '17px', fontWeight: 700, fontFamily: 'Space Grotesk, sans-serif', margin: '0 0 16px' }}>
              Deposit to Wallet
            </h2>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' }}>
              {DEPOSIT_PRESETS_NAIRA.map((n) => (
                <button
                  key={n}
                  onClick={() => setDepositAmount(String(n))}
                  style={{
                    padding: '9px 14px', borderRadius: '10px', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
                    background: depositAmount === String(n) ? 'rgba(168,85,247,0.18)' : 'rgba(255,255,255,0.05)',
                    border: depositAmount === String(n) ? '1px solid rgba(168,85,247,0.4)' : '1px solid rgba(255,255,255,0.08)',
                    color: depositAmount === String(n) ? '#C4B5FD' : '#C4C9E0',
                  }}
                >
                  ₦{n.toLocaleString()}
                </button>
              ))}
            </div>
            <input
              type="number"
              inputMode="numeric"
              placeholder="Enter amount (₦)"
              value={depositAmount}
              onChange={(e) => setDepositAmount(e.target.value)}
              style={{
                width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '12px', padding: '13px 14px', color: '#fff', fontSize: '15px', outline: 'none', marginBottom: '10px',
              }}
            />
            {depositError && (
              <p style={{ color: '#F87171', fontSize: '12.5px', margin: '0 0 12px' }}>{depositError}</p>
            )}
            <button
              onClick={handleDeposit}
              disabled={depositing}
              style={{
                width: '100%', background: 'linear-gradient(135deg,#7C3AED,#A855F7)', border: 'none', borderRadius: '14px',
                padding: '14px', color: '#fff', fontSize: '15px', fontWeight: 700,
                cursor: depositing ? 'not-allowed' : 'pointer', opacity: depositing ? 0.6 : 1,
              }}
            >
              {depositing ? 'Processing…' : 'Continue to Payment'}
            </button>
          </div>
        </div>
      )}

      {selectedTx && (
        <TransactionReceipt
          tx={selectedTx}
          onClose={() => setSelectedTx(null)}
          resolvingTicket={resolvingTicket}
          resolveTicketError={resolveTicketError}
          onViewTicket={onViewTicket ? async () => {
            const kind = classifyWalletTransaction(selectedTx);
            setResolveTicketError('');
            setResolvingTicket(true);
            try {
              // Ticket refund: reference_id IS the ticket id already, no
              // lookup needed. Ticket purchase: reference_id is the
              // payment_ref, which can cover several ticket rows (a group
              // purchase) -- resolve the representative one, scoped by RLS
              // to this user's own tickets, same as the rest of this file.
              // Either way the id resolved here can only ever be this
              // caller's own ticket: it's read from a user_wallet_
              // transactions row already scoped to auth.uid() (get_my_
              // wallet_transactions), so the payment_ref/ticket id itself
              // was never attacker-suppliable to begin with -- select_
              // tickets' RLS (owner or event organizer only) is a correct
              // second layer, not the only thing preventing exposure here.
              const ticketId = kind === 'ticket_refund'
                ? selectedTx.referenceId
                : selectedTx.referenceId ? await findTicketIdForPaymentRef(selectedTx.referenceId) : null;
              if (ticketId) {
                setSelectedTx(null);
                onViewTicket(ticketId);
              } else {
                setResolveTicketError('Could not find this ticket. It may have been removed.');
              }
            } catch (e: any) {
              setResolveTicketError(e?.message || 'Could not open this ticket. Please try again.');
            } finally {
              setResolvingTicket(false);
            }
          } : undefined}
          onViewServiceBookings={onViewServiceBookings ? () => { setSelectedTx(null); onViewServiceBookings(); } : undefined}
        />
      )}
    </div>
  );
}

// Full-screen receipt, deliberately matching the existing organizer-
// earnings Transaction Details pattern (WalletScreen.tsx): a receipt
// header card (icon, amount, status pill, date) over a detail-rows card,
// with a masking disclaimer footer -- same visual language, not a new one
// invented for this screen. Every value shown comes directly from the
// authoritative transaction row (amount_kobo, description, reference_id,
// metadata, created_at) or a live-resolved deep-link id -- nothing here is
// computed or guessed client-side.
function TransactionReceipt({
  tx,
  onClose,
  onViewTicket,
  onViewServiceBookings,
  resolvingTicket,
  resolveTicketError,
}: {
  tx: UserWalletTransaction;
  onClose: () => void;
  onViewTicket?: () => void;
  onViewServiceBookings?: () => void;
  resolvingTicket: boolean;
  resolveTicketError?: string;
}) {
  const kind = classifyWalletTransaction(tx);
  const isMoneyIn = tx.type !== 'spend';
  const meta = tx.metadata || {};

  let icon = <Wallet size={22} color={isMoneyIn ? '#10B981' : '#F59E0B'} />;
  let title = 'Wallet Transaction';
  let statusLabel = 'Completed';
  const rows: Array<{ label: string; value: string; valueColor?: string }> = [];

  if (kind === 'deposit') {
    icon = <ArrowDownLeft size={22} color="#10B981" />;
    title = 'Wallet Deposit';
    rows.push({ label: 'Amount deposited', value: fmtNaira(tx.amountKobo) });
    rows.push({ label: 'Payment method', value: 'Paystack' });
    if (typeof meta.paystack_reference === 'string') {
      rows.push({ label: 'Reference', value: maskRef(meta.paystack_reference) });
    }
    rows.push({ label: 'Status', value: 'Confirmed', valueColor: '#10B981' });
  } else if (kind === 'ticket_purchase' || kind === 'service_purchase') {
    icon = kind === 'ticket_purchase' ? <Ticket size={22} color="#F59E0B" /> : <Sparkles size={22} color="#F59E0B" />;
    title = kind === 'ticket_purchase' ? 'Ticket Purchase' : 'Service Booking';
    statusLabel = 'Paid';
    rows.push({ label: 'Description', value: tx.description || (kind === 'ticket_purchase' ? 'Ticket purchase' : 'Service booking') });
    rows.push({ label: 'Total paid', value: fmtNaira(tx.amountKobo), valueColor: '#F59E0B' });
    rows.push({ label: 'Payment method', value: 'VENTS Wallet' });
    if (tx.referenceId) rows.push({ label: 'Reference', value: maskRef(tx.referenceId) });
    rows.push({ label: 'Status', value: 'Paid', valueColor: '#10B981' });
  } else if (kind === 'ticket_refund') {
    icon = <RotateCcw size={22} color="#A855F7" />;
    title = 'Ticket Refund';
    rows.push({ label: 'Amount refunded', value: fmtNaira(tx.amountKobo), valueColor: '#10B981' });
    if (tx.description) rows.push({ label: 'Details', value: tx.description });
    const feeAbsorbed = Number(meta.platform_fee_absorbed_kobo);
    if (Number.isFinite(feeAbsorbed) && feeAbsorbed > 0) {
      rows.push({ label: 'VENTS fee (included in your refund)', value: fmtNaira(feeAbsorbed) });
    }
    rows.push({ label: 'Refunded to', value: 'VENTS Wallet' });
    rows.push({ label: 'Status', value: 'Refunded', valueColor: '#A855F7' });
  } else {
    // Genuinely unclassified -- shown honestly with only the raw
    // authoritative fields, never guessed into one of the categories above.
    title = tx.type === 'spend' ? 'Wallet Purchase' : tx.type === 'refund' ? 'Wallet Refund' : 'Wallet Transaction';
    rows.push({ label: 'Amount', value: fmtNaira(tx.amountKobo) });
    rows.push({ label: 'Description', value: tx.description || '—' });
    if (tx.referenceId) rows.push({ label: 'Reference', value: maskRef(tx.referenceId) });
  }
  rows.push({ label: 'Date & time', value: fmtDate(tx.createdAt) });

  const showViewTicket = (kind === 'ticket_purchase' || kind === 'ticket_refund') && !!onViewTicket;
  const showViewBookings = kind === 'service_purchase' && !!onViewServiceBookings;

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#020005', zIndex: 9200, display: 'flex', flexDirection: 'column', color: '#F0F0FF' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '16px 20px', paddingTop: 'calc(16px + env(safe-area-inset-top))', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <button onClick={onClose} style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={16} color="#C4C9E0" />
        </button>
        <span style={{ fontSize: '18px', fontWeight: 700 }}>Transaction Details</span>
      </div>

      <div className="no-scrollbar" style={{ flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: '20px' }}>
        <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '20px', padding: '28px 24px', marginBottom: '20px', textAlign: 'center' }}>
          <div style={{ width: '48px', height: '48px', borderRadius: '14px', background: isMoneyIn ? 'rgba(16,185,129,0.12)' : 'rgba(245,158,11,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
            {icon}
          </div>
          <p style={{ margin: '0 0 6px', fontSize: '13px', color: '#8B8FA8' }}>{title}</p>
          <p style={{ margin: '0 0 10px', fontSize: '30px', fontWeight: 800, color: isMoneyIn ? '#10B981' : '#F59E0B', wordBreak: 'break-all' }}>
            {isMoneyIn ? '+' : '-'}{fmtNaira(tx.amountKobo)}
          </p>
          <span style={{ display: 'inline-block', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', padding: '4px 12px', borderRadius: '100px', color: '#C4C9E0', background: 'rgba(255,255,255,0.06)' }}>
            {statusLabel}
          </span>
          <p style={{ margin: '10px 0 0', fontSize: '12px', color: '#8B8FA8' }}>{fmtDate(tx.createdAt)}</p>
        </div>

        <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '20px', padding: '4px 20px', marginBottom: showViewTicket || showViewBookings ? '16px' : 0 }}>
          {rows.map((r, i) => (
            <DetailRow key={i} label={r.label} value={r.value} valueColor={r.valueColor} />
          ))}
        </div>

        {showViewTicket && (
          <>
            <button
              onClick={onViewTicket}
              disabled={resolvingTicket}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                background: 'linear-gradient(135deg,#7C3AED,#A855F7)', border: 'none', borderRadius: '14px',
                padding: '13px', color: '#fff', fontSize: '14px', fontWeight: 700,
                cursor: resolvingTicket ? 'not-allowed' : 'pointer', opacity: resolvingTicket ? 0.7 : 1,
              }}
            >
              <Ticket size={16} /> {resolvingTicket ? 'Opening…' : 'View Ticket'}
            </button>
            {resolveTicketError && (
              <p style={{ color: '#F87171', fontSize: '12px', margin: '10px 0 0', textAlign: 'center' }}>{resolveTicketError}</p>
            )}
          </>
        )}
        {showViewBookings && (
          <button
            onClick={onViewServiceBookings}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
              background: 'linear-gradient(135deg,#7C3AED,#A855F7)', border: 'none', borderRadius: '14px',
              padding: '13px', color: '#fff', fontSize: '14px', fontWeight: 700, cursor: 'pointer',
            }}
          >
            <CreditCard size={16} /> View My Bookings
          </button>
        )}

        <p style={{ margin: '16px 0 0', fontSize: '11px', color: '#5C6080', textAlign: 'center', lineHeight: 1.6 }}>
          Card numbers, bank credentials, and other sensitive payment details are never shown here.
        </p>
      </div>
    </div>
  );
}
