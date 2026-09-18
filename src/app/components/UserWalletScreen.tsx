import { useEffect, useState } from 'react';
import { ventsColors } from '../../lib/ventsDesignTokens';
import { ArrowLeft, Wallet, Plus, ArrowDownLeft, ArrowUpRight, RotateCcw, Loader, ChevronRight, Ticket, Sparkles, CreditCard, CheckCircle2 } from 'lucide-react';
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
  deposit: { Icon: ArrowDownLeft, color: ventsColors.success },
  spend: { Icon: ArrowUpRight, color: ventsColors.pending },
  refund: { Icon: RotateCcw, color: ventsColors.accent },
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
      <span style={{ color: ventsColors.ink2, fontSize: '12.5px', flexShrink: 0 }}>{label}</span>
      <span style={{ color: valueColor || ventsColors.ink1, fontSize: '13px', fontWeight: 600, textAlign: 'right', wordBreak: 'break-word' }}>{value}</span>
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
  // Handoff F2 (DepositScreen): a successful deposit used to just close the
  // sheet and silently refresh the list -- no confirmation at all. Real
  // data only: amountKobo/reference come from the actual deposit result,
  // newBalanceKobo from the balance re-fetched right after.
  const [depositSuccess, setDepositSuccess] = useState<{ amountKobo: number; reference: string; newBalanceKobo: number } | null>(null);
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
        const freshBalance = await fetchMyWalletBalanceKobo().catch(() => balanceKobo || 0);
        await load();
        setDepositSuccess({ amountKobo: result.amountKobo || Math.round(naira * 100), reference: result.reference || '', newBalanceKobo: freshBalance });
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

  // F2 handoff: dedicated full-screen Deposit view, replacing the old
  // bottom-sheet modal. Same real state/handlers as before (depositAmount,
  // handleDeposit, DEPOSIT_PRESETS_NAIRA) -- only the layout changed.
  if (showDeposit) {
    const amountKobo = Math.round((Number(depositAmount) || 0) * 100);
    return (
      <div style={{ background: '#08050f', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', position: 'relative', fontFamily: 'Manrope, sans-serif' }}>
        <div style={{ position: 'absolute', top: '-140px', left: '50%', transform: 'translateX(-50%)', width: '520px', height: '420px', background: 'radial-gradient(ellipse at center, rgba(168,85,247,0.32), transparent 65%)', filter: 'blur(10px)', pointerEvents: 'none' }} />

        <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 'calc(16px + env(safe-area-inset-top)) 20px 0' }}>
          <button
            onClick={() => !depositing && setShowDeposit(false)}
            style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          >
            <ArrowLeft size={16} color="#f6f4f9" />
          </button>
          <div style={{ fontSize: '16px', fontWeight: 800, color: '#f6f4f9' }}>Deposit to Wallet</div>
          <div style={{ width: '36px', height: '36px' }} />
        </div>

        <div style={{ position: 'relative', flex: 1, overflowY: 'auto', padding: '0 0 24px' }}>
          <div style={{ margin: '18px 20px 0', textAlign: 'center', fontSize: '12px', letterSpacing: '1.5px', color: '#9a93a8', fontWeight: 700 }}>
            CURRENT BALANCE {loading ? '—' : fmtNaira(balanceKobo || 0)}
          </div>

          <div style={{ margin: '20px 20px 0', textAlign: 'center' }}>
            <div style={{ fontSize: '13px', color: '#9a93a8', marginBottom: '6px' }}>Enter amount</div>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: '6px' }}>
              <span style={{ fontSize: '28px', fontWeight: 700, color: '#c3bdd1' }}>₦</span>
              <style>{`.vents-deposit-amount-input::-webkit-outer-spin-button,.vents-deposit-amount-input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;} .vents-deposit-amount-input{-moz-appearance:textfield;}`}</style>
              <input
                className="vents-deposit-amount-input"
                type="number"
                inputMode="numeric"
                autoFocus
                placeholder="0"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                style={{
                  width: '180px', background: 'transparent', border: 'none', outline: 'none',
                  fontSize: '48px', fontWeight: 900, color: '#f6f4f9', textAlign: 'center',
                  fontFamily: 'Manrope, sans-serif',
                }}
              />
            </div>
          </div>

          <div style={{ display: 'flex', gap: '10px', margin: '20px 20px 0' }}>
            {DEPOSIT_PRESETS_NAIRA.map((n) => {
              const active = depositAmount === String(n);
              return (
                <button
                  key={n}
                  onClick={() => setDepositAmount(String(n))}
                  style={{
                    flex: 1, textAlign: 'center', padding: '10px 0', borderRadius: '12px', cursor: 'pointer',
                    background: active ? 'rgba(168,85,247,0.28)' : 'rgba(255,255,255,0.06)',
                    border: active ? '1px solid rgba(168,85,247,0.5)' : '1px solid rgba(255,255,255,0.1)',
                    fontSize: '13px', fontWeight: 700, color: active ? '#fff' : '#f6f4f9',
                  }}
                >
                  ₦{n.toLocaleString()}
                </button>
              );
            })}
          </div>

          <div style={{ margin: '26px 20px 0', fontSize: '12px', letterSpacing: '1.5px', color: '#9a93a8', fontWeight: 700 }}>PAYMENT METHOD</div>
          <div style={{ margin: '12px 20px 0' }}>
            {/* Only one real deposit path exists (Paystack's own popup,
                where the user picks card/bank/USSD themselves) -- there is
                no saved card on file and no real "pay with Vents Cents"
                deposit option, so this shows that one real method honestly
                instead of fabricating a selectable multi-method list. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '14px', borderRadius: '14px', background: 'rgba(168,85,247,0.14)', border: '1px solid rgba(168,85,247,0.4)' }}>
              <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <CreditCard size={16} color="#f6f4f9" />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '13.5px', fontWeight: 700, color: '#f6f4f9' }}>Card, Bank Transfer or USSD</div>
                <div style={{ fontSize: '11.5px', color: '#9a93a8', marginTop: '2px' }}>Choose your method in the next step — powered by Paystack</div>
              </div>
              <div style={{ width: '20px', height: '20px', borderRadius: '50%', border: '2px solid #a855f7', background: '#a855f7' }} />
            </div>
          </div>

          <div style={{ margin: '22px 20px 0', padding: '14px', borderRadius: '14px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', justifyContent: 'space-between', fontSize: '12.5px', color: '#9a93a8' }}>
            <span>Processing fee</span><span style={{ color: '#f6f4f9', fontWeight: 600 }}>₦0</span>
          </div>

          {depositError && (
            <p style={{ color: ventsColors.error, fontSize: '12.5px', margin: '16px 20px 0', textAlign: 'center' }}>{depositError}</p>
          )}

          <div style={{ margin: '24px 20px 0' }}>
            <button
              onClick={handleDeposit}
              disabled={depositing || amountKobo < 50000}
              style={{
                width: '100%', textAlign: 'center', padding: '16px 0', borderRadius: '14px',
                background: 'linear-gradient(135deg,#a855f7,#7c3aed)', border: 'none',
                fontWeight: 700, fontSize: '15px', color: '#fff',
                boxShadow: '0 8px 26px rgba(168,85,247,0.35)',
                cursor: depositing ? 'not-allowed' : 'pointer', opacity: depositing ? 0.6 : 1,
              }}
            >
              {depositing ? 'Processing…' : `Deposit ${depositAmount ? fmtNaira(amountKobo) : ''}`}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (depositSuccess) {
    return (
      <div style={{ background: '#08070C', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'Manrope, sans-serif' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'calc(20px + env(safe-area-inset-top)) 16px 0' }}>
          <button onClick={() => setDepositSuccess(null)} style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: '50%', width: '42px', height: '42px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <ArrowLeft size={18} color="#fff" />
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', padding: '36px 20px 0' }}>
          <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: 'rgba(52,211,153,0.14)', border: '1px solid rgba(52,211,153,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <CheckCircle2 size={30} color={ventsColors.success} />
          </div>
          <span style={{ fontSize: '38px', fontWeight: 800, letterSpacing: '-0.035em', fontVariantNumeric: 'tabular-nums lining-nums', color: '#fff', lineHeight: 1 }}>
            +{fmtNaira(depositSuccess.amountKobo)}
          </span>
          <span style={{ fontSize: '15px', fontWeight: 600, color: 'rgba(237,234,245,0.66)' }}>Deposit successful</span>
        </div>
        <div style={{ margin: '32px 20px 0', borderRadius: '22px', background: '#121019', border: '1px solid rgba(255,255,255,0.09)', padding: '4px 20px' }}>
          <div style={{ padding: '16px 0', display: 'flex', justifyContent: 'space-between', gap: '16px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
            <span style={{ fontSize: '14px', color: 'rgba(237,234,245,0.66)' }}>Status</span>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', fontWeight: 700, letterSpacing: '0.12em', padding: '5px 9px', borderRadius: '7px', background: 'rgba(52,211,153,0.16)', color: '#6EE7B7' }}>COMPLETED</span>
          </div>
          <div style={{ padding: '16px 0', display: 'flex', justifyContent: 'space-between', gap: '16px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
            <span style={{ fontSize: '14px', color: 'rgba(237,234,245,0.66)' }}>Method</span>
            <span style={{ fontSize: '15px', fontWeight: 700, color: '#EDEAF5' }}>Paystack</span>
          </div>
          <div style={{ padding: '16px 0', display: 'flex', justifyContent: 'space-between', gap: '16px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
            <span style={{ fontSize: '14px', color: 'rgba(237,234,245,0.66)' }}>Date</span>
            <span style={{ fontSize: '15px', fontWeight: 700, color: '#EDEAF5' }}>{new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</span>
          </div>
          {depositSuccess.reference && (
            <div style={{ padding: '16px 0', display: 'flex', justifyContent: 'space-between', gap: '16px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
              <span style={{ fontSize: '14px', color: 'rgba(237,234,245,0.66)' }}>Reference</span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '13px', color: '#EDEAF5', wordBreak: 'break-all', textAlign: 'right' }}>{depositSuccess.reference}</span>
            </div>
          )}
          <div style={{ padding: '16px 0', display: 'flex', justifyContent: 'space-between', gap: '16px' }}>
            <span style={{ fontSize: '14px', color: 'rgba(237,234,245,0.66)' }}>New balance</span>
            <span style={{ fontSize: '16px', fontWeight: 800, fontVariantNumeric: 'tabular-nums lining-nums', color: '#fff' }}>{fmtNaira(depositSuccess.newBalanceKobo)}</span>
          </div>
        </div>
        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: '10px', padding: '0 20px calc(24px + env(safe-area-inset-bottom))' }}>
          <button onClick={() => setDepositSuccess(null)} style={{ height: '56px', borderRadius: '16px', background: '#8E5CF7', border: 'none', color: '#fff', fontSize: '17px', fontWeight: 700, cursor: 'pointer', boxShadow: '0 14px 40px -14px rgba(142,92,247,1)' }}>
            Back to Wallet
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        background: 'radial-gradient(ellipse 520px 320px at 50% -8%, rgba(123,47,190,0.10) 0%, rgba(5,2,10,1) 40%, #050208 100%)',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'Manrope, sans-serif',
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
          <ArrowLeft size={15} color={ventsColors.ink2} />
        </button>
        <h1 style={{ color: ventsColors.ink1, fontSize: '17px', fontWeight: 700, fontFamily: 'Manrope, sans-serif', margin: 0 }}>
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
              <Wallet size={15} color={ventsColors.accentSoft} />
            </div>
            <span style={{ color: ventsColors.accentSoft, fontSize: '12px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
              Spendable Balance
            </span>
          </div>
          <p style={{ color: '#fff', fontSize: '34px', fontWeight: 800, fontFamily: 'Manrope, sans-serif', letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums lining-nums', margin: '0 0 4px' }}>
            {loading ? '—' : fmtNaira(balanceKobo || 0)}
          </p>
          <p style={{ color: ventsColors.ink2, fontSize: '12px', margin: '0 0 18px' }}>
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
          <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '12px', padding: '12px 14px', marginBottom: '16px', color: ventsColors.error, fontSize: '13px' }}>
            {error}
          </div>
        )}

        {/* History */}
        <p style={{ color: ventsColors.ink3, fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', margin: '0 0 10px' }}>
          TRANSACTION HISTORY
        </p>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0', color: ventsColors.ink3 }}>
            <Loader size={18} className="animate-spin" />
          </div>
        ) : transactions.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', padding: '48px 16px' }}>
            <div style={{ width: '56px', height: '56px', borderRadius: '50%', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Wallet size={22} color={ventsColors.ink3} strokeWidth={1.5} />
            </div>
            <p style={{ color: ventsColors.ink2, fontSize: '13px', margin: 0, textAlign: 'center' }}>
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
                    <p style={{ color: ventsColors.ink1, fontSize: '13.5px', fontWeight: 600, margin: '0 0 2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {tx.description || (tx.type === 'deposit' ? 'Wallet top-up' : tx.type === 'spend' ? 'Purchase' : 'Refund')}
                    </p>
                    <p style={{ color: ventsColors.ink3, fontSize: '11px', margin: 0 }}>{fmtDate(tx.createdAt)}</p>
                  </div>
                  <span style={{ color, fontSize: '14px', fontWeight: 700, fontVariantNumeric: 'tabular-nums lining-nums', flexShrink: 0 }}>
                    {sign}{fmtNaira(tx.amountKobo)}
                  </span>
                  <ChevronRight size={15} color={ventsColors.ink3} style={{ flexShrink: 0 }} />
                </button>
              );
            })}
          </div>
        )}
      </div>

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

  let icon = <Wallet size={22} color={isMoneyIn ? ventsColors.success : ventsColors.pending} />;
  let title = 'Wallet Transaction';
  let statusLabel = 'Completed';
  const rows: Array<{ label: string; value: string; valueColor?: string }> = [];

  if (kind === 'deposit') {
    icon = <ArrowDownLeft size={22} color={ventsColors.success} />;
    title = 'Wallet Deposit';
    rows.push({ label: 'Amount deposited', value: fmtNaira(tx.amountKobo) });
    rows.push({ label: 'Payment method', value: 'Paystack' });
    if (typeof meta.paystack_reference === 'string') {
      rows.push({ label: 'Reference', value: maskRef(meta.paystack_reference) });
    }
    rows.push({ label: 'Status', value: 'Confirmed', valueColor: ventsColors.success });
  } else if (kind === 'ticket_purchase' || kind === 'service_purchase') {
    icon = kind === 'ticket_purchase' ? <Ticket size={22} color={ventsColors.pending} /> : <Sparkles size={22} color={ventsColors.pending} />;
    title = kind === 'ticket_purchase' ? 'Ticket Purchase' : 'Service Booking';
    statusLabel = 'Paid';
    rows.push({ label: 'Description', value: tx.description || (kind === 'ticket_purchase' ? 'Ticket purchase' : 'Service booking') });
    rows.push({ label: 'Total paid', value: fmtNaira(tx.amountKobo), valueColor: ventsColors.pending });
    rows.push({ label: 'Payment method', value: 'VENTS Wallet' });
    if (tx.referenceId) rows.push({ label: 'Reference', value: maskRef(tx.referenceId) });
    rows.push({ label: 'Status', value: 'Paid', valueColor: ventsColors.success });
  } else if (kind === 'ticket_refund') {
    icon = <RotateCcw size={22} color={ventsColors.accent} />;
    title = 'Ticket Refund';
    rows.push({ label: 'Amount refunded', value: fmtNaira(tx.amountKobo), valueColor: ventsColors.success });
    if (tx.description) rows.push({ label: 'Details', value: tx.description });
    const feeAbsorbed = Number(meta.platform_fee_absorbed_kobo);
    if (Number.isFinite(feeAbsorbed) && feeAbsorbed > 0) {
      rows.push({ label: 'VENTS fee (included in your refund)', value: fmtNaira(feeAbsorbed) });
    }
    rows.push({ label: 'Refunded to', value: 'VENTS Wallet' });
    rows.push({ label: 'Status', value: 'Refunded', valueColor: ventsColors.accent });
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
    <div style={{ position: 'fixed', inset: 0, background: ventsColors.bg, zIndex: 9200, display: 'flex', flexDirection: 'column', color: ventsColors.ink1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '16px 20px', paddingTop: 'calc(16px + env(safe-area-inset-top))', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <button onClick={onClose} style={{ background: ventsColors.surface, border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={16} color={ventsColors.ink2} />
        </button>
        <span style={{ fontSize: '18px', fontWeight: 700 }}>Transaction Details</span>
      </div>

      <div className="no-scrollbar" style={{ flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: '20px' }}>
        <div style={{ background: ventsColors.surface, border: '1px solid rgba(255,255,255,0.08)', borderRadius: '20px', padding: '28px 24px', marginBottom: '20px', textAlign: 'center' }}>
          <div style={{ width: '48px', height: '48px', borderRadius: '14px', background: isMoneyIn ? 'rgba(16,185,129,0.12)' : 'rgba(245,158,11,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
            {icon}
          </div>
          <p style={{ margin: '0 0 6px', fontSize: '13px', color: ventsColors.ink2 }}>{title}</p>
          <p style={{ margin: '0 0 10px', fontSize: '30px', fontWeight: 800, color: isMoneyIn ? ventsColors.success : ventsColors.pending, wordBreak: 'break-all' }}>
            {isMoneyIn ? '+' : '-'}{fmtNaira(tx.amountKobo)}
          </p>
          <span style={{ display: 'inline-block', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', padding: '4px 12px', borderRadius: '100px', color: ventsColors.ink2, background: 'rgba(255,255,255,0.06)' }}>
            {statusLabel}
          </span>
          <p style={{ margin: '10px 0 0', fontSize: '12px', color: ventsColors.ink2 }}>{fmtDate(tx.createdAt)}</p>
        </div>

        <div style={{ background: ventsColors.surface, border: '1px solid rgba(255,255,255,0.08)', borderRadius: '20px', padding: '4px 20px', marginBottom: showViewTicket || showViewBookings ? '16px' : 0 }}>
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
              <p style={{ color: ventsColors.error, fontSize: '12px', margin: '10px 0 0', textAlign: 'center' }}>{resolveTicketError}</p>
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

        <p style={{ margin: '16px 0 0', fontSize: '11px', color: ventsColors.ink3, textAlign: 'center', lineHeight: 1.6 }}>
          Card numbers, bank credentials, and other sensitive payment details are never shown here.
        </p>
      </div>
    </div>
  );
}
