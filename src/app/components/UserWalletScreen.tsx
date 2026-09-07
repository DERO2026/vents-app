import { useEffect, useState } from 'react';
import { ArrowLeft, Wallet, Plus, ArrowDownLeft, ArrowUpRight, RotateCcw, Loader } from 'lucide-react';
import { fetchMyWalletBalanceKobo, fetchMyWalletTransactions, depositToWallet, UserWalletTransaction } from '../../lib/userWallet';
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

export function UserWalletScreen({ currentUser, onBack }: UserWalletScreenProps) {
  const [balanceKobo, setBalanceKobo] = useState<number | null>(null);
  const [transactions, setTransactions] = useState<UserWalletTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showDeposit, setShowDeposit] = useState(false);
  const [depositAmount, setDepositAmount] = useState('');
  const [depositing, setDepositing] = useState(false);
  const [depositError, setDepositError] = useState('');

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
                <div
                  key={tx.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '12px', padding: '13px 14px',
                    background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '16px',
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
                </div>
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
    </div>
  );
}
