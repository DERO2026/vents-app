import { useState, useEffect } from 'react';
import { ArrowLeft, Wallet as WalletIcon, Plus, ArrowDownCircle, ArrowUpCircle, RefreshCw, ChevronRight } from 'lucide-react';
import { supabase, getAuthToken } from '../../lib/supabase';
import { apiUrl } from '../../lib/apiBase';
import { openPaystackPopup } from '../../lib/paystack';
import { Sentry } from '../../lib/sentry';
import { validateWalletDepositAmountKobo, isWalletCredit, walletTxnLabel } from '../../lib/walletMath';
import { ventsColors } from '../../lib/ventsDesignTokens';

interface CustomerWalletScreenProps {
  currentUser: { id: string; email: string; full_name: string | null; role: string } | null;
  onBack: () => void;
  onOpenEarnings?: () => void;
  showEarningsTab?: boolean;
}

interface WalletTxn {
  id: string;
  type: 'deposit' | 'spend' | string;
  amount_kobo: number;
  description: string | null;
  reference_id: string | null;
  metadata: Record<string, any> | null;
  created_at: string;
}

function fmt(kobo: number) {
  return '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const DEPOSIT_PRESETS_NAIRA = [1000, 2500, 5000, 10000, 25000];

function txnLabel(t: WalletTxn): string {
  return walletTxnLabel(t.type, t.description);
}

export function CustomerWalletScreen({ currentUser, onBack, onOpenEarnings, showEarningsTab }: CustomerWalletScreenProps) {
  const [balanceKobo, setBalanceKobo] = useState<number | null>(null);
  const [txns, setTxns] = useState<WalletTxn[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState<'wallet' | 'earnings'>('wallet');

  const [showDeposit, setShowDeposit] = useState(false);
  const [depositAmount, setDepositAmount] = useState('');
  const [depositing, setDepositing] = useState(false);
  const [depositError, setDepositError] = useState('');
  const [selectedTxn, setSelectedTxn] = useState<WalletTxn | null>(null);

  const load = async () => {
    if (!currentUser?.id) return;
    setLoading(true);
    setLoadError('');
    try {
      const [wRes, tRes] = await Promise.all([
        supabase.rpc('get_my_wallet'),
        supabase.rpc('get_my_wallet_transactions', { p_limit: 50, p_offset: 0 }),
      ]);
      if (wRes.error) throw wRes.error;
      if (tRes.error) throw tRes.error;
      const row = Array.isArray(wRes.data) ? wRes.data[0] : wRes.data;
      setBalanceKobo(typeof row?.balance_kobo === 'number' ? row.balance_kobo : 0);
      setTxns((tRes.data as WalletTxn[]) || []);
    } catch (e) {
      console.error('Customer wallet load error:', e);
      Sentry.captureException(e);
      setLoadError('Failed to load wallet data. Pull to retry.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [currentUser?.id]);

  const openDeposit = () => {
    setDepositError('');
    setDepositAmount('');
    setShowDeposit(true);
  };

  const handleDeposit = async () => {
    const naira = Number(depositAmount);
    const amountKobo = Math.round(naira * 100);
    const validationError = validateWalletDepositAmountKobo(amountKobo);
    if (validationError) {
      setDepositError(validationError);
      return;
    }
    setDepositError('');
    setDepositing(true);
    try {
      // Server-authoritative: initiate_wallet_deposit re-validates min/max
      // and rate-limits, and mints the reference the popup and later
      // verification are both keyed on -- the client only ever supplies the
      // requested amount here, never the amount that ends up credited.
      const { data, error } = await supabase.rpc('initiate_wallet_deposit', { p_amount_kobo: amountKobo });
      if (error) throw error;
      const reference: string = (data as any)?.reference;
      const confirmedAmountKobo: number = (data as any)?.amountKobo;
      if (!reference) throw new Error('Could not start this deposit.');

      openPaystackPopup({
        email: currentUser?.email || '',
        amountKobo: confirmedAmountKobo,
        ref: reference,
        label: currentUser?.full_name || 'VENTS Wallet Top-up',
        metadata: { purpose: 'wallet_deposit', user_id: currentUser?.id || '' },
        onSuccess: async () => {
          // Never trust this callback as proof of payment -- it's only a
          // signal to go verify. The actual amount credited comes from
          // Paystack's own server-side transaction record, checked by
          // api/webhook/paystack.ts?action=verify-deposit, which then calls
          // confirm_wallet_deposit (project_admin-only; not directly callable
          // by this client) with that verified amount.
          try {
            const token = await getAuthToken();
            const res = await fetch(apiUrl('/api/webhook/paystack?action=verify-deposit'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ reference }),
            });
            const json = await res.json().catch(() => null);
            if (!res.ok || json?.status !== 'success') {
              setDepositError(
                json?.status === 'abandoned'
                  ? 'Payment was not completed. If you were charged, contact support with your reference.'
                  : json?.status === 'failed'
                  ? 'Payment failed. You have not been charged.'
                  : (json?.error || 'Could not verify this deposit. If you were charged, contact support with your reference.')
              );
              setDepositing(false);
              return;
            }
            setShowDeposit(false);
            setDepositing(false);
            await load();
          } catch (e: any) {
            Sentry.captureException(e);
            setDepositError('Could not verify this deposit. If you were charged, contact support with your reference.');
            setDepositing(false);
          }
        },
        onClose: () => setDepositing(false),
        onError: (message) => { setDepositError(message); setDepositing(false); },
      });
    } catch (e: any) {
      setDepositError(e?.message || 'Could not start this deposit. Please try again.');
      setDepositing(false);
    }
  };

  return (
    <div style={{ background: ventsColors.bg, height: '100%', display: 'flex', flexDirection: 'column', color: ventsColors.ink1, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '16px 20px', paddingTop: 'calc(16px + env(safe-area-inset-top))' }}>
        <button onClick={onBack} style={{ background: ventsColors.surface, border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={18} color={ventsColors.ink1} />
        </button>
        <span style={{ fontSize: '18px', fontWeight: 800 }}>VENTS Wallet</span>
      </div>

      {showEarningsTab && (
        <div style={{ display: 'flex', gap: '8px', padding: '0 20px 12px' }}>
          <button
            onClick={() => setTab('wallet')}
            style={{
              flex: 1, padding: '10px', borderRadius: '100px', fontWeight: 700, fontSize: '13px', cursor: 'pointer',
              border: tab === 'wallet' ? '1px solid rgba(168,85,247,0.5)' : '1px solid rgba(255,255,255,0.08)',
              background: tab === 'wallet' ? 'rgba(168,85,247,0.15)' : ventsColors.surface,
              color: tab === 'wallet' ? ventsColors.accentSoft : ventsColors.ink2,
            }}
          >
            Wallet Balance
          </button>
          <button
            onClick={() => { setTab('earnings'); onOpenEarnings?.(); }}
            style={{
              flex: 1, padding: '10px', borderRadius: '100px', fontWeight: 700, fontSize: '13px', cursor: 'pointer',
              border: '1px solid rgba(255,255,255,0.08)', background: ventsColors.surface, color: ventsColors.ink2,
            }}
          >
            Earnings
          </button>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 24px' }}>
        <div
          style={{
            background: 'linear-gradient(135deg, #2D0B4E, #0F0620)',
            border: '1px solid rgba(168,85,247,0.35)',
            boxShadow: '0 0 40px rgba(124,58,237,0.25)',
            borderRadius: '22px',
            padding: '28px 24px',
            marginBottom: '20px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
            <WalletIcon size={16} color={ventsColors.accentSoft} />
            <span style={{ color: ventsColors.accentSoft, fontSize: '13px', fontWeight: 700, letterSpacing: '0.02em' }}>WALLET BALANCE</span>
          </div>
          <div style={{ fontSize: '34px', fontWeight: 800, color: ventsColors.white, marginBottom: '4px' }}>
            {loading ? '···' : fmt(balanceKobo || 0)}
          </div>
          <div style={{ fontSize: '12px', color: 'rgba(240,240,255,0.55)', marginBottom: '20px' }}>
            Spendable on VENTS tickets &amp; services. Deposits are not withdrawable.
          </div>
          <button
            onClick={openDeposit}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
              width: '100%', padding: '14px', borderRadius: '14px', border: 'none', cursor: 'pointer',
              background: 'linear-gradient(135deg,#7C3AED,#A855F7)', color: ventsColors.white, fontWeight: 700, fontSize: '15px',
            }}
          >
            <Plus size={18} /> Deposit Funds
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
          <span style={{ fontSize: '14px', fontWeight: 700, color: ventsColors.ink1 }}>Transaction History</span>
          <button onClick={load} style={{ background: 'none', border: 'none', cursor: 'pointer', color: ventsColors.ink2 }}>
            <RefreshCw size={15} />
          </button>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: ventsColors.ink3 }}>Loading…</div>
        ) : loadError ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', padding: '32px 0', color: ventsColors.error, fontSize: '13px', textAlign: 'center' }}>
            <span>{loadError}</span>
            <button
              onClick={load}
              style={{ background: ventsColors.surface, border: '1px solid rgba(255,255,255,0.1)', borderRadius: '100px', padding: '8px 18px', color: ventsColors.ink1, fontWeight: 700, fontSize: '12px', cursor: 'pointer' }}
            >
              Retry
            </button>
          </div>
        ) : txns.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: ventsColors.ink3, fontSize: '13px' }}>
            No wallet activity yet. Your deposits and purchases will show up here.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {txns.map((t) => {
              const isCredit = isWalletCredit(t.type);
              return (
                <button
                  key={t.id}
                  onClick={() => setSelectedTxn(t)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%',
                    background: ventsColors.surface, border: '1px solid rgba(255,255,255,0.06)', borderRadius: '14px',
                    padding: '14px', cursor: 'pointer', textAlign: 'left',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                    {isCredit
                      ? <ArrowDownCircle size={20} color={ventsColors.success} />
                      : <ArrowUpCircle size={20} color={ventsColors.error} />}
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '13px', fontWeight: 700, color: ventsColors.ink1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {txnLabel(t)}
                      </div>
                      <div style={{ fontSize: '11px', color: ventsColors.ink3 }}>
                        {new Date(t.created_at).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                    <span style={{ fontSize: '14px', fontWeight: 800, color: isCredit ? ventsColors.success : ventsColors.error }}>
                      {isCredit ? '+' : '-'}{fmt(t.amount_kobo)}
                    </span>
                    <ChevronRight size={14} color={ventsColors.ink3} />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {showDeposit && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 9500 }} onClick={() => !depositing && setShowDeposit(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: ventsColors.surface, borderRadius: '20px 20px 0 0', padding: '24px', width: '100%', maxWidth: '390px', paddingBottom: 'calc(24px + env(safe-area-inset-bottom))' }}>
            <div style={{ fontSize: '16px', fontWeight: 800, marginBottom: '16px' }}>Deposit to VENTS Wallet</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
              {DEPOSIT_PRESETS_NAIRA.map((n) => (
                <button
                  key={n}
                  onClick={() => setDepositAmount(String(n))}
                  style={{
                    padding: '8px 14px', borderRadius: '100px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                    border: depositAmount === String(n) ? '1px solid rgba(168,85,247,0.6)' : '1px solid rgba(255,255,255,0.08)',
                    background: depositAmount === String(n) ? 'rgba(168,85,247,0.15)' : 'transparent',
                    color: depositAmount === String(n) ? ventsColors.accentSoft : ventsColors.ink2,
                  }}
                >
                  ₦{n.toLocaleString('en-NG')}
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
                width: '100%', padding: '14px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)',
                background: ventsColors.bg, color: ventsColors.ink1, fontSize: '15px', marginBottom: '12px', boxSizing: 'border-box',
              }}
            />
            {depositError && <div style={{ color: ventsColors.error, fontSize: '12px', marginBottom: '12px' }}>{depositError}</div>}
            <button
              onClick={handleDeposit}
              disabled={depositing}
              style={{
                width: '100%', padding: '14px', borderRadius: '12px', border: 'none', cursor: depositing ? 'not-allowed' : 'pointer',
                background: 'linear-gradient(135deg,#7C3AED,#A855F7)', color: ventsColors.white, fontWeight: 700, opacity: depositing ? 0.6 : 1,
              }}
            >
              {depositing ? 'Processing…' : 'Continue to Paystack'}
            </button>
          </div>
        </div>
      )}

      {selectedTxn && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 9500 }} onClick={() => setSelectedTxn(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: ventsColors.surface, borderRadius: '20px 20px 0 0', padding: '24px', width: '100%', maxWidth: '390px', paddingBottom: 'calc(24px + env(safe-area-inset-bottom))' }}>
            <div style={{ fontSize: '16px', fontWeight: 800, marginBottom: '16px' }}>Transaction Details</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13px' }}>
              <Row label="Type" value={txnLabel(selectedTxn)} />
              <Row label="Amount" value={(isWalletCredit(selectedTxn.type) ? '+' : '-') + fmt(selectedTxn.amount_kobo)} />
              <Row label="Date" value={new Date(selectedTxn.created_at).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })} />
              {selectedTxn.reference_id && <Row label="Reference" value={maskReference(selectedTxn.reference_id)} />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '8px' }}>
      <span style={{ color: ventsColors.ink3 }}>{label}</span>
      <span style={{ color: ventsColors.ink1, fontWeight: 600, maxWidth: '60%', textAlign: 'right', wordBreak: 'break-all' }}>{value}</span>
    </div>
  );
}

// References can be Paystack payment refs -- shown truncated rather than in
// full to avoid surfacing more of a payment identifier than a user needs to
// read at a glance.
function maskReference(ref: string): string {
  if (ref.length <= 14) return ref;
  return `${ref.slice(0, 8)}…${ref.slice(-6)}`;
}
