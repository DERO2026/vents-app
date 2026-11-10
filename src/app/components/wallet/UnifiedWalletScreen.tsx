// The one VENTS Wallet screen, with two real tabs in the same screen:
//
//   Wallet Balance -- the spendable VENTS Wallet (user_wallets, 0065): money
//     for tickets and services, deposits, transfers to and from friends
//     (0215), refunds. Never withdrawable.
//   Earnings -- withdrawable income (organizer_wallets): earnings, pending
//     settlement, withdrawals with the PIN, bank accounts (WalletScreen,
//     embedded unchanged).
//
// The balances are separate systems and are never added together or moved
// between each other here. VENTS Cents are shown on their own card: points,
// not naira.
//
// Both tabs stay mounted, so switching never reloads or resets either side
// and each keeps its own scroll position.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Plus, Send, QrCode, ArrowDownLeft, ArrowUpRight, RefreshCw, ChevronRight, Coins, Info } from 'lucide-react';
import { supabase, getAuthToken } from '../../../lib/supabase';
import { apiUrl } from '../../../lib/apiBase';
import { openPaystackPopup } from '../../../lib/paystack';
import { Sentry } from '../../../lib/sentry';
import { validateWalletDepositAmountKobo, walletTxnLabel, walletTxnDirection } from '../../../lib/walletMath';
import { friendlyOperationalError } from '../../../lib/operationalStatus';
import { ventsColors } from '../../../lib/ventsDesignTokens';
import { getVcBalance } from '../../../lib/vcBalanceCache';
import { fetchTransferStatus, fetchTransferReceipt, formatNaira, PAY_TO_STORAGE_KEY, type TransferStatus, type TransferReceipt } from '../../../lib/walletTransfers';
import { WalletScreen } from '../WalletScreen';
import { SendMoneySheet } from './SendMoneySheet';
import { ReceiveMoneySheet } from './ReceiveMoneySheet';
import { Sheet, PrimaryButton, DetailRow, Notice, inputStyle, walletCard } from './walletUi';

export type WalletTab = 'balance' | 'earnings';

export interface UnifiedWalletUser {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  username?: string | null;
  isOrganizer?: boolean;
  is_service_provider?: boolean;
}

interface WalletTxn {
  id: string;
  type: string;
  amount_kobo: number;
  description: string | null;
  reference_id: string | null;
  metadata: Record<string, any> | null;
  created_at: string;
}

const PAGE = 50;
const DEPOSIT_PRESETS_NAIRA = [1000, 2500, 5000, 10000, 25000];
type Filter = 'all' | 'in' | 'out' | 'transfers';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'in', label: 'Money in' }, { key: 'out', label: 'Money out' }, { key: 'transfers', label: 'Transfers' },
];

const when = (t: string) => new Date(t).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' });

/** What kind of movement a ledger row is, in plain words. */
export function walletTxnKindLabel(t: Pick<WalletTxn, 'type' | 'reference_id'>): string {
  switch (t.type) {
    case 'deposit': return 'Deposit';
    case 'transfer_in': return 'Money received';
    case 'transfer_out': return 'Money sent';
    case 'refund': return 'Refund';
    case 'vc_conversion': return 'VENTS Cents converted';
    case 'spend': return (t.reference_id || '').startsWith('BKG-') ? 'Service booking' : (t.reference_id || '').startsWith('VNT-') ? 'Ticket purchase' : 'Purchase';
    default: return 'Wallet adjustment';
  }
}

export function UnifiedWalletScreen({ currentUser, onBack, initialTab = 'balance', onOpenVentsCents }: {
  currentUser: UnifiedWalletUser | null;
  onBack: () => void;
  initialTab?: WalletTab;
  onOpenVentsCents?: () => void;
}) {
  const [tab, setTab] = useState<WalletTab>(initialTab);
  const balanceTabRef = useRef<HTMLButtonElement>(null);
  const earningsTabRef = useRef<HTMLButtonElement>(null);

  const [balanceKobo, setBalanceKobo] = useState<number | null>(null);
  const [txns, setTxns] = useState<WalletTxn[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [transferStatus, setTransferStatus] = useState<TransferStatus | null>(null);
  const [vc, setVc] = useState<number | null>(null);

  const [showDeposit, setShowDeposit] = useState(false);
  const [depositAmount, setDepositAmount] = useState('');
  const [depositing, setDepositing] = useState(false);
  const [depositError, setDepositError] = useState('');
  const [showSend, setShowSend] = useState(false);
  const [sendTo, setSendTo] = useState<string | null>(null);
  const [showReceive, setShowReceive] = useState(false);
  const [selected, setSelected] = useState<WalletTxn | null>(null);
  const [receipt, setReceipt] = useState<TransferReceipt | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const loadStatus = useCallback(() => {
    fetchTransferStatus().then(setTransferStatus, () => setTransferStatus(null));
  }, []);

  const load = useCallback(async () => {
    if (!currentUser?.id) return;
    setLoading(true); setLoadError('');
    try {
      const [wRes, tRes] = await Promise.all([
        supabase.rpc('get_my_wallet'),
        supabase.rpc('get_my_wallet_transactions', { p_limit: PAGE, p_offset: 0 }),
      ]);
      if (wRes.error) throw wRes.error;
      if (tRes.error) throw tRes.error;
      const row = Array.isArray(wRes.data) ? wRes.data[0] : wRes.data;
      setBalanceKobo(Number(row?.balance_kobo ?? 0));
      const list = (tRes.data as WalletTxn[]) || [];
      setTxns(list); setHasMore(list.length === PAGE);
    } catch (e) {
      Sentry.captureException(e);
      setLoadError('Could not load your wallet. Check your connection and try again.');
    } finally { setLoading(false); }
    loadStatus();
  }, [currentUser?.id, loadStatus]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!currentUser?.id) return;
    getVcBalance(currentUser.id).then((r) => setVc(r ? r.spendable : null), () => setVc(null));
  }, [currentUser?.id]);
  // A ?pay=<username> link (someone's Receive QR) opens Send Money to them once.
  useEffect(() => {
    let to: string | null = null;
    try { to = sessionStorage.getItem(PAY_TO_STORAGE_KEY); sessionStorage.removeItem(PAY_TO_STORAGE_KEY); } catch { /* storage unavailable */ }
    if (to) { setTab('balance'); setSendTo(to); }
  }, []);
  useEffect(() => {
    if (sendTo && transferStatus?.enabled) setShowSend(true);
  }, [sendTo, transferStatus?.enabled]);

  const loadMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const { data, error } = await supabase.rpc('get_my_wallet_transactions', { p_limit: PAGE, p_offset: txns.length });
      if (error) throw error;
      const page = (data as WalletTxn[]) || [];
      setTxns((cur) => { const seen = new Set(cur.map((t) => t.id)); return [...cur, ...page.filter((t) => !seen.has(t.id))]; });
      setHasMore(page.length === PAGE);
    } catch (e) { Sentry.captureException(e); setFlash('Could not load more transactions.'); }
    finally { setLoadingMore(false); }
  };

  const openTxn = (t: WalletTxn) => {
    setSelected(t); setReceipt(null);
    if ((t.type === 'transfer_in' || t.type === 'transfer_out') && t.reference_id) {
      fetchTransferReceipt(t.reference_id).then(setReceipt, () => setReceipt(null));
    }
  };

  const handleDeposit = async () => {
    const amountKobo = Math.round(Number(depositAmount) * 100);
    const validationError = validateWalletDepositAmountKobo(amountKobo);
    if (validationError) { setDepositError(validationError); return; }
    setDepositError(''); setDepositing(true);
    try {
      // Server-authoritative: initiate_wallet_deposit re-validates and mints the reference.
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
          // Never proof of payment: the server verifies with Paystack and credits the verified amount.
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
                json?.status === 'abandoned' ? 'Payment was not completed. If you were charged, contact support with your reference.'
                  : json?.status === 'failed' ? 'Payment failed. You have not been charged.'
                  : (json?.error || 'Could not verify this deposit. If you were charged, contact support with your reference.'));
              setDepositing(false);
              return;
            }
            setShowDeposit(false); setDepositing(false);
            setFlash('Deposit received.');
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
      setDepositError(friendlyOperationalError(e?.message) || e?.message || 'Could not start this deposit. Please try again.');
      setDepositing(false);
    }
  };

  const transfersOn = !!transferStatus?.enabled;
  const visible = txns.filter((t) => {
    const d = walletTxnDirection(t.type);
    if (filter === 'in') return d === 'in';
    if (filter === 'out') return d === 'out';
    if (filter === 'transfers') return t.type === 'transfer_in' || t.type === 'transfer_out';
    return true;
  });

  const onTabKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next: WalletTab = tab === 'balance' ? 'earnings' : 'balance';
    setTab(next);
    (next === 'balance' ? balanceTabRef : earningsTabRef).current?.focus();
  };

  const tabButton = (key: WalletTab, label: string, ref: React.RefObject<HTMLButtonElement>) => {
    const active = tab === key;
    return (
      <button ref={ref} type="button" role="tab" id={`wallet-tab-${key}`} aria-selected={active} aria-controls={`wallet-panel-${key}`}
        tabIndex={active ? 0 : -1} data-testid={`wallet-tab-${key}`} onClick={() => setTab(key)} onKeyDown={onTabKey}
        style={{ flex: 1, minHeight: 44, borderRadius: 12, border: 'none', cursor: 'pointer', fontWeight: 800, fontSize: 14,
          background: active ? 'linear-gradient(135deg, #8E5CF7 0%, #7B2FBE 100%)' : 'transparent',
          color: active ? ventsColors.white : ventsColors.ink2, boxShadow: active ? '0 4px 18px rgba(142,92,247,0.35)' : 'none' }}>
        {label}
      </button>
    );
  };

  return (
    <div data-testid="unified-wallet" style={{ background: ventsColors.bg, height: '100%', display: 'flex', flexDirection: 'column', color: ventsColors.ink1, overflow: 'hidden' }}>
      {/* Header and tabs stay put while each panel scrolls on its own. */}
      <div style={{ flexShrink: 0, padding: '12px 16px 10px', paddingTop: 'calc(12px + env(safe-area-inset-top))', background: ventsColors.bg, borderBottom: `1px solid ${ventsColors.divider}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <button type="button" onClick={onBack} aria-label="Back"
            style={{ width: 44, height: 44, borderRadius: '50%', background: ventsColors.surface, border: `1px solid ${ventsColors.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
            <ArrowLeft size={18} color={ventsColors.ink1} />
          </button>
          <h1 style={{ margin: 0, fontSize: 19, fontWeight: 800 }}>Wallet</h1>
        </div>
        <div role="tablist" aria-label="Wallet" style={{ display: 'flex', gap: 6, padding: 4, borderRadius: 16, background: ventsColors.surface, border: `1px solid ${ventsColors.border}` }}>
          {tabButton('balance', 'Wallet Balance', balanceTabRef)}
          {tabButton('earnings', 'Earnings', earningsTabRef)}
        </div>
      </div>

      {/* ── Wallet Balance ── */}
      <div role="tabpanel" id="wallet-panel-balance" aria-labelledby="wallet-tab-balance" hidden={tab !== 'balance'} data-testid="wallet-panel-balance"
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', padding: '16px 16px calc(32px + env(safe-area-inset-bottom))', display: tab === 'balance' ? 'block' : 'none' }}>
        <div style={{ maxWidth: 640, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <section aria-label="Wallet balance" data-testid="wallet-balance-card"
            style={{ borderRadius: 22, padding: '22px 18px 18px', background: 'radial-gradient(120% 140% at 0% 0%, rgba(142,92,247,0.45) 0%, rgba(123,47,190,0.18) 45%, #120D1E 100%)',
              border: '1px solid rgba(183,155,255,0.35)', boxShadow: '0 0 48px rgba(124,58,237,0.28)' }}>
            <p style={{ margin: 0, fontSize: 11, fontWeight: 800, letterSpacing: '0.16em', color: ventsColors.accentSoft }}>WALLET BALANCE</p>
            <p data-testid="wallet-balance-amount" style={{ margin: '6px 0 4px', fontSize: 'clamp(28px, 9vw, 38px)', fontWeight: 800, color: ventsColors.white, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>
              {loading && balanceKobo === null ? '···' : formatNaira(balanceKobo || 0)}
            </p>
            <p style={{ margin: 0, fontSize: 13, color: 'rgba(240,240,255,0.75)', lineHeight: 1.45 }}>
              Money you can spend on VENTS tickets and services{transfersOn ? ' or send to friends' : ''}. It can't be withdrawn to a bank.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: transfersOn ? 'repeat(3, minmax(0, 1fr))' : '1fr', gap: 8, marginTop: 16 }}>
              <ActionTile testId="wallet-deposit" icon={<Plus size={18} />} label="Deposit" onClick={() => { setDepositError(''); setDepositAmount(''); setShowDeposit(true); }} />
              {transfersOn && <ActionTile testId="wallet-send" icon={<Send size={18} />} label="Send" onClick={() => { setSendTo(null); setShowSend(true); }} />}
              {transfersOn && <ActionTile testId="wallet-receive" icon={<QrCode size={18} />} label="Receive" onClick={() => setShowReceive(true)} />}
            </div>
          </section>

          {flash && <Notice tone="ok" testId="wallet-flash">{flash}</Notice>}

          <section aria-label="VENTS Cents" data-testid="wallet-vc-card" style={{ ...walletCard, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <Coins size={20} color="#FFD700" style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <p style={{ margin: 0, fontSize: 13, fontWeight: 800 }}>
                VENTS Cents{vc !== null ? <span style={{ color: '#FFD700' }}> · {vc.toLocaleString('en-NG')} VC</span> : null}
              </p>
              <p style={{ margin: '4px 0 0', fontSize: 12, color: ventsColors.ink2, lineHeight: 1.45 }}>
                Reward points, not naira, and not part of your Wallet Balance. Use them toward eligible tickets; at Gold tier you can convert them into Wallet Balance. VENTS Cents can't be withdrawn or sent.
              </p>
              {onOpenVentsCents && (
                <button type="button" data-testid="wallet-vc-open" onClick={onOpenVentsCents}
                  style={{ minHeight: 44, padding: 0, marginTop: 2, background: 'none', border: 'none', color: ventsColors.accentSoft, fontWeight: 700, fontSize: 12.5, cursor: 'pointer' }}>
                  How VENTS Cents work →
                </button>
              )}
            </div>
          </section>

          <section aria-label="Transaction history">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '4px 0 8px' }}>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>Transaction history</h2>
              <button type="button" onClick={() => void load()} aria-label="Refresh" data-testid="wallet-refresh"
                style={{ minWidth: 44, minHeight: 44, background: 'none', border: 'none', color: ventsColors.ink2, cursor: 'pointer' }}>
                <RefreshCw size={16} />
              </button>
            </div>
            <div role="group" aria-label="Filter" style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 4, marginBottom: 8 }}>
              {FILTERS.filter((f) => f.key !== 'transfers' || transfersOn || txns.some((t) => t.type.startsWith('transfer_'))).map((f) => (
                <button key={f.key} type="button" data-testid={`wallet-filter-${f.key}`} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}
                  style={{ flexShrink: 0, minHeight: 36, padding: '0 14px', borderRadius: 999, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
                    border: filter === f.key ? '1px solid rgba(183,155,255,0.6)' : `1px solid ${ventsColors.border}`,
                    background: filter === f.key ? 'rgba(142,92,247,0.18)' : 'transparent', color: filter === f.key ? ventsColors.accentSoft : ventsColors.ink2 }}>
                  {f.label}
                </button>
              ))}
            </div>
            {loading && txns.length === 0 ? (
              <p style={{ textAlign: 'center', padding: '28px 0', color: ventsColors.ink3, fontSize: 13 }}>Loading…</p>
            ) : loadError ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <Notice tone="error" testId="wallet-load-error">{loadError}</Notice>
                <PrimaryButton tone="ghost" onClick={() => void load()}>Try again</PrimaryButton>
              </div>
            ) : visible.length === 0 ? (
              <p data-testid="wallet-empty" style={{ textAlign: 'center', padding: '28px 8px', color: ventsColors.ink3, fontSize: 13, lineHeight: 1.5 }}>
                {txns.length === 0 ? 'No wallet activity yet. Deposits, purchases, refunds and transfers will show up here.' : 'Nothing matches this filter.'}
              </p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {visible.map((t) => <TxnRow key={t.id} t={t} onOpen={() => openTxn(t)} />)}
              </ul>
            )}
            {hasMore && !loadError && (
              <div style={{ marginTop: 10 }}>
                <PrimaryButton tone="ghost" testId="wallet-load-more" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : 'Load older transactions'}</PrimaryButton>
              </div>
            )}
          </section>
        </div>
      </div>

      {/* ── Earnings ── */}
      <div role="tabpanel" id="wallet-panel-earnings" aria-labelledby="wallet-tab-earnings" hidden={tab !== 'earnings'} data-testid="wallet-panel-earnings"
        style={{ flex: 1, minHeight: 0, display: tab === 'earnings' ? 'flex' : 'none', flexDirection: 'column' }}>
        <div style={{ flexShrink: 0, padding: '12px 16px 0' }}>
          <div data-testid="earnings-explainer" style={{ ...walletCard, display: 'flex', gap: 10, maxWidth: 640, margin: '0 auto', padding: 12 }}>
            <Info size={16} color={ventsColors.accentSoft} style={{ flexShrink: 0, marginTop: 2 }} />
            <p style={{ margin: 0, fontSize: 12, color: ventsColors.ink2, lineHeight: 1.45 }}>
              Earnings are what you make on VENTS: ticket sales, services and rewards. They become withdrawable to your bank after settlement
              (48 hours after the event ends or the booking is completed) and need your PIN. Earnings are separate from your Wallet Balance and can't be spent or sent.
            </p>
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <WalletScreen currentUser={currentUser} onBack={onBack} embedded />
        </div>
      </div>

      {showDeposit && (
        <Sheet title="Deposit to VENTS Wallet" onClose={() => setShowDeposit(false)} testId="deposit-sheet" busy={depositing}>
          <p style={{ margin: '0 0 12px', fontSize: 12.5, color: ventsColors.ink2, lineHeight: 1.45 }}>Paid by card or bank through Paystack. Deposits are spendable on VENTS and can't be withdrawn.</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            {DEPOSIT_PRESETS_NAIRA.map((n) => (
              <button key={n} type="button" onClick={() => setDepositAmount(String(n))}
                style={{ minHeight: 40, padding: '0 14px', borderRadius: 999, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
                  border: depositAmount === String(n) ? '1px solid rgba(183,155,255,0.6)' : `1px solid ${ventsColors.border}`,
                  background: depositAmount === String(n) ? 'rgba(142,92,247,0.18)' : 'transparent', color: depositAmount === String(n) ? ventsColors.accentSoft : ventsColors.ink2 }}>
                ₦{n.toLocaleString('en-NG')}
              </button>
            ))}
          </div>
          <input data-testid="deposit-amount" type="number" inputMode="numeric" placeholder="Enter amount (₦)" value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} style={inputStyle} />
          {depositError && <div style={{ marginTop: 10 }}><Notice tone="error">{depositError}</Notice></div>}
          <div style={{ marginTop: 14 }}><PrimaryButton testId="deposit-continue" disabled={depositing} onClick={handleDeposit}>{depositing ? 'Processing…' : 'Continue to Paystack'}</PrimaryButton></div>
        </Sheet>
      )}

      {showSend && transferStatus && (
        <SendMoneySheet balanceKobo={balanceKobo || 0} status={transferStatus} initialUsername={sendTo}
          onClose={() => { setShowSend(false); setSendTo(null); }}
          onSent={(r) => { if (r.balanceKobo !== undefined) setBalanceKobo(r.balanceKobo); void load(); }}
          onStatusChanged={loadStatus} />
      )}
      {showReceive && (
        <ReceiveMoneySheet username={transferStatus?.username ?? currentUser?.username ?? null} displayName={currentUser?.full_name ?? null} onClose={() => setShowReceive(false)} />
      )}

      {selected && (
        <Sheet title="Transaction details" onClose={() => setSelected(null)} testId="wallet-receipt">
          <ReceiptBody t={selected} receipt={receipt} />
        </Sheet>
      )}
    </div>
  );
}

function ActionTile({ icon, label, onClick, testId }: { icon: React.ReactNode; label: string; onClick: () => void; testId: string }) {
  return (
    <button type="button" data-testid={testId} onClick={onClick}
      style={{ minHeight: 64, borderRadius: 16, border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(8,7,12,0.45)', color: ventsColors.white,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, fontWeight: 800, fontSize: 13, cursor: 'pointer', minWidth: 0 }}>
      {icon}{label}
    </button>
  );
}

function TxnRow({ t, onOpen }: { t: WalletTxn; onOpen: () => void }) {
  const dir = walletTxnDirection(t.type);
  const color = dir === 'in' ? ventsColors.success : dir === 'out' ? ventsColors.ink1 : ventsColors.ink2;
  const counterparty = t.metadata?.counterparty_username ? `@${t.metadata.counterparty_username}` : t.metadata?.counterparty_name;
  return (
    <li>
      <button type="button" data-testid={`wallet-txn-${t.id}`} onClick={onOpen}
        style={{ width: '100%', minHeight: 64, display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left', background: ventsColors.surface, border: `1px solid ${ventsColors.divider}`, borderRadius: 14, padding: '12px 12px', cursor: 'pointer', boxSizing: 'border-box' }}>
        <span aria-hidden style={{ width: 36, height: 36, borderRadius: 12, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: dir === 'in' ? 'rgba(52,211,153,0.12)' : 'rgba(142,92,247,0.14)' }}>
          {dir === 'in' ? <ArrowDownLeft size={18} color={ventsColors.success} /> : <ArrowUpRight size={18} color={ventsColors.accentSoft} />}
        </span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700, color: ventsColors.ink1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {walletTxnKindLabel(t)}{counterparty ? ` · ${counterparty}` : ''}
          </span>
          <span style={{ display: 'block', fontSize: 11.5, color: ventsColors.ink3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {when(t.created_at)} · Completed
          </span>
        </span>
        <span data-testid={`wallet-txn-amount-${t.id}`} style={{ fontSize: 14, fontWeight: 800, color, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
          {dir === 'in' ? '+' : dir === 'out' ? '−' : ''}{formatNaira(t.amount_kobo)}
        </span>
        <ChevronRight size={14} color={ventsColors.ink3} style={{ flexShrink: 0 }} />
      </button>
    </li>
  );
}

function ReceiptBody({ t, receipt }: { t: WalletTxn; receipt: TransferReceipt | null }) {
  const dir = walletTxnDirection(t.type);
  const isTransfer = t.type === 'transfer_in' || t.type === 'transfer_out';
  const paystackRef = typeof t.metadata?.paystack_reference === 'string' ? t.metadata.paystack_reference : null;
  const counterpartyName = receipt ? (receipt.direction === 'out' ? receipt.recipient : receipt.sender) : null;
  const note = receipt?.note ?? (typeof t.metadata?.note === 'string' ? t.metadata.note : null);
  return (
    <div data-testid="wallet-receipt-body">
      <p style={{ margin: '0 0 4px', fontSize: 12, color: ventsColors.ink3, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}>{walletTxnKindLabel(t)}</p>
      <p data-testid="wallet-receipt-amount" style={{ margin: '0 0 10px', fontSize: 30, fontWeight: 800, color: dir === 'in' ? ventsColors.success : ventsColors.white }}>
        {dir === 'in' ? '+' : dir === 'out' ? '−' : ''}{formatNaira(t.amount_kobo)}
      </p>
      <DetailRow label="Status" value={<span style={{ color: ventsColors.success }}>Completed</span>} testId="wallet-receipt-status" />
      <DetailRow label="Date and time" value={when(t.created_at)} />
      {isTransfer && (
        <DetailRow label={t.type === 'transfer_out' ? 'To' : 'From'} testId="wallet-receipt-counterparty"
          value={counterpartyName ? `${counterpartyName.name || ''}${counterpartyName.username ? ` (@${counterpartyName.username})` : ''}`
            : (t.metadata?.counterparty_username ? `@${t.metadata.counterparty_username}` : t.metadata?.counterparty_name || '—')} />
      )}
      {note && <DetailRow label="Note" value={note} />}
      {!isTransfer && t.description && <DetailRow label="Description" value={walletTxnLabel(t.type, t.description)} />}
      {t.reference_id && <DetailRow label="Reference" value={t.reference_id} mono testId="wallet-receipt-ref" />}
      {paystackRef && paystackRef !== t.reference_id && <DetailRow label="Paystack reference" value={paystackRef} mono />}
      <DetailRow label="Wallet" value="VENTS Wallet (spendable)" />
    </div>
  );
}
