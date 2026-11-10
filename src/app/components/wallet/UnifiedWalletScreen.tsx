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
import { ArrowLeft, PlusCircle, Send, Download, ArrowDownLeft, ArrowUpRight, Ticket, CalendarCheck, RotateCcw, Coins, Info, CircleDollarSign } from 'lucide-react';
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
import { Sheet, PrimaryButton, DetailRow, Notice, inputStyle } from './walletUi';

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

// Mockup palette (black page, deep purple surfaces, lavender accents).
const W = {
  page: '#000000', cardBorder: '#2A2830', balanceCard: '#2A1B42', earningsCard: '#1B1A21',
  lavender: '#B79BFF', green: '#4CAF50', greenPillBg: '#1F2A2E', greyPillBg: '#2C2B32', greyPillText: '#D6D3DC',
  unifiedBg: '#0E2412', tabTrack: '#26183B', tabActive: '#6F42B8', sub: '#A9A5B2', divider: '#2B2931',
};

/** ₦1,190,500 for whole naira, ₦1,190,500.50 otherwise (the mockup's style; never rounds money). */
export function formatNairaShort(kobo: number): string {
  const n = (Math.abs(kobo) / 100).toLocaleString('en-NG', { minimumFractionDigits: kobo % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 });
  return `₦${n}`;
}

const when = (t: string) => new Date(t).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' });

/** The second line of a history row. */
export function walletTxnSubtitle(t: Pick<WalletTxn, 'type' | 'reference_id' | 'metadata'>): string {
  const who = t.metadata?.counterparty_username ? `@${t.metadata.counterparty_username}` : null;
  switch (t.type) {
    case 'transfer_in': return who ? `From ${who}` : 'From a VENTS user';
    case 'transfer_out': return who ? `To ${who}` : 'To a VENTS user';
    case 'spend': return 'Wallet payment';
    case 'deposit': return 'Added via Paystack';
    case 'refund': return 'Returned to your wallet';
    case 'vc_conversion': return 'Added from VENTS Cents';
    default: return 'VENTS Wallet';
  }
}

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
  const [earningsKobo, setEarningsKobo] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
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
  // Withdrawable earnings for the summary card (own row only, RLS); 0 for people who don't earn.
  useEffect(() => {
    if (!currentUser?.id) return;
    Promise.resolve(supabase.from('organizer_wallets').select('balance_kobo').eq('organizer_id', currentUser.id).maybeSingle())
      .then(({ data }: any) => setEarningsKobo(Number(data?.balance_kobo ?? 0)), () => setEarningsKobo(null));
  }, [currentUser?.id]);
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
  // Switching tabs keeps the layout; if the user had scrolled below the tabs, the new tab starts at its top.
  const selectTab = (next: WalletTab) => {
    setTab(next);
    const sc = scrollRef.current, tb = tabsRef.current;
    if (sc && tb && sc.scrollTop > tb.offsetTop) sc.scrollTop = tb.offsetTop;
  };

  const onTabKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next: WalletTab = tab === 'balance' ? 'earnings' : 'balance';
    selectTab(next);
    (next === 'balance' ? balanceTabRef : earningsTabRef).current?.focus();
  };

  const tabButton = (key: WalletTab, label: string, ref: React.RefObject<HTMLButtonElement>) => {
    const active = tab === key;
    return (
      <button ref={ref} type="button" role="tab" id={`wallet-tab-${key}`} aria-selected={active} aria-controls={`wallet-panel-${key}`}
        tabIndex={active ? 0 : -1} data-testid={`wallet-tab-${key}`} onClick={() => selectTab(key)} onKeyDown={onTabKey}
        style={{ flex: 1, minHeight: 44, borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: 17, fontWeight: active ? 700 : 500,
          background: active ? W.tabActive : 'transparent', color: active ? ventsColors.white : '#E6E1F0' }}>
        {label}
      </button>
    );
  };

  return (
    <div data-testid="unified-wallet" style={{ background: W.page, height: '100%', color: ventsColors.white, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div ref={scrollRef} data-testid="wallet-scroll"
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain',
          padding: '12px 16px calc(24px + env(safe-area-inset-bottom))', paddingTop: 'calc(12px + env(safe-area-inset-top))' }}>
        <div data-testid="wallet-card" style={{ maxWidth: 560, margin: '0 auto', border: `1px solid ${W.cardBorder}`, borderRadius: 36, padding: '16px 12px 20px', background: W.page, boxSizing: 'border-box' }}>
          {/* Title row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, minHeight: 44, marginBottom: 12 }}>
            <button type="button" onClick={onBack} aria-label="Back" data-testid="wallet-back"
              style={{ width: 36, height: 44, marginLeft: -6, background: 'none', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
              <ArrowLeft size={20} color={ventsColors.white} />
            </button>
            <h1 style={{ margin: 0, fontSize: 21, fontWeight: 700, letterSpacing: '-0.01em', flex: 1, minWidth: 0 }}>VENTS Wallet</h1>
            <span data-testid="wallet-unified-pill" style={{ background: W.unifiedBg, color: W.green, fontSize: 13, fontWeight: 500, padding: '4px 11px', borderRadius: 999, flexShrink: 0 }}>Unified</span>
          </div>

          {/* Two separate balances, side by side (never added together) */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 9 }}>
            <button type="button" data-testid="wallet-balance-card" onClick={() => selectTab('balance')} aria-describedby="wallet-balance-help"
              style={{ ...summaryCard, background: W.balanceCard }}>
              <span style={summaryLabel}>Wallet Balance</span>
              <span data-testid="wallet-balance-amount" style={summaryAmount}>{loading && balanceKobo === null ? '···' : formatNairaShort(balanceKobo || 0)}</span>
              <span style={{ ...pill, background: W.greenPillBg, color: W.green }}>Spendable</span>
              <span id="wallet-balance-help" style={srOnly}>Money you can spend on VENTS tickets and services{transfersOn ? ' or send to friends' : ''}. It can't be withdrawn to a bank.</span>
            </button>
            <button type="button" data-testid="wallet-earnings-card" onClick={() => selectTab('earnings')} aria-describedby="wallet-earnings-help"
              style={{ ...summaryCard, background: W.earningsCard }}>
              <span style={summaryLabel}>Earnings</span>
              <span data-testid="wallet-earnings-amount" style={summaryAmount}>{earningsKobo === null ? '···' : formatNairaShort(earningsKobo)}</span>
              <span style={{ ...pill, background: W.greyPillBg, color: W.greyPillText }}>Withdrawable</span>
              <span id="wallet-earnings-help" style={srOnly}>Money you earned on VENTS, withdrawable to your bank after settlement. It can't be spent or sent.</span>
            </button>
          </div>

          {/* Tabs (stay on screen while the content scrolls) */}
          <div ref={tabsRef} style={{ position: 'sticky', top: -1, zIndex: 2, background: W.page, padding: '12px 0 4px', margin: '0 -2px' }}>
            <div role="tablist" aria-label="Wallet" style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 999, background: W.tabTrack }}>
              {tabButton('balance', 'Wallet', balanceTabRef)}
              {tabButton('earnings', 'Earnings', earningsTabRef)}
            </div>
          </div>

          {/* ── Wallet ── */}
          <div role="tabpanel" id="wallet-panel-balance" aria-labelledby="wallet-tab-balance" hidden={tab !== 'balance'} data-testid="wallet-panel-balance"
            style={{ display: tab === 'balance' ? 'block' : 'none' }}>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${transfersOn ? 3 : 1}, minmax(0, 1fr))`, padding: '10px 0 14px' }}>
              <ActionButton testId="wallet-deposit" icon={<PlusCircle size={26} strokeWidth={1.8} />} label="Deposit" onClick={() => { setDepositError(''); setDepositAmount(''); setShowDeposit(true); }} />
              {transfersOn && <ActionButton testId="wallet-send" icon={<Send size={26} strokeWidth={1.8} />} label="Send" onClick={() => { setSendTo(null); setShowSend(true); }} />}
              {transfersOn && <ActionButton testId="wallet-receive" icon={<Download size={26} strokeWidth={1.8} />} label="Receive" onClick={() => setShowReceive(true)} />}
            </div>
            <div style={{ height: 1, background: W.divider, margin: '0 0 22px' }} />

            {flash && <div style={{ marginBottom: 12 }}><Notice tone="ok" testId="wallet-flash">{flash}</Notice></div>}

            <section aria-label="Recent transactions">
              <h2 style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 600 }}>Recent transactions</h2>
              {loading && txns.length === 0 ? (
                <p style={{ padding: '20px 0', color: W.sub, fontSize: 14 }}>Loading…</p>
              ) : loadError ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <Notice tone="error" testId="wallet-load-error">{loadError}</Notice>
                  <PrimaryButton tone="ghost" onClick={() => void load()}>Try again</PrimaryButton>
                </div>
              ) : txns.length === 0 ? (
                <p data-testid="wallet-empty" style={{ padding: '12px 0 4px', color: W.sub, fontSize: 14, lineHeight: 1.5 }}>
                  No transactions yet. Deposits, purchases, refunds and transfers will show up here.
                </p>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {txns.map((t) => <TxnRow key={t.id} t={t} onOpen={() => openTxn(t)} />)}
                </ul>
              )}
              {hasMore && !loadError && (
                <div style={{ marginTop: 10 }}>
                  <PrimaryButton tone="ghost" testId="wallet-load-more" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : 'Load older transactions'}</PrimaryButton>
                </div>
              )}
            </section>

            <section aria-label="VENTS Cents" data-testid="wallet-vc-card"
              style={{ marginTop: 20, background: W.earningsCard, borderRadius: 26, padding: 14, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <Coins size={20} color="#FFD700" style={{ flexShrink: 0, marginTop: 2 }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>
                  VENTS Cents{vc !== null ? <span style={{ color: '#FFD700' }}> · {vc.toLocaleString('en-NG')} VC</span> : null}
                </p>
                <p style={{ margin: '4px 0 0', fontSize: 12.5, color: W.sub, lineHeight: 1.45 }}>
                  Reward points, not naira, and not part of your Wallet Balance. Use them toward eligible tickets; at Gold tier you can convert them into Wallet Balance. VENTS Cents can't be withdrawn or sent.
                </p>
                {onOpenVentsCents && (
                  <button type="button" data-testid="wallet-vc-open" onClick={onOpenVentsCents}
                    style={{ minHeight: 44, padding: 0, background: 'none', border: 'none', color: W.lavender, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                    How VENTS Cents work →
                  </button>
                )}
              </div>
            </section>
          </div>

          {/* ── Earnings ── */}
          <div role="tabpanel" id="wallet-panel-earnings" aria-labelledby="wallet-tab-earnings" hidden={tab !== 'earnings'} data-testid="wallet-panel-earnings"
            style={{ display: tab === 'earnings' ? 'block' : 'none', paddingTop: 10 }}>
            <div data-testid="earnings-explainer" style={{ background: W.earningsCard, borderRadius: 24, display: 'flex', gap: 10, padding: 12 }}>
              <Info size={16} color={W.lavender} style={{ flexShrink: 0, marginTop: 2 }} />
              <p style={{ margin: 0, fontSize: 12.5, color: W.sub, lineHeight: 1.45 }}>
                Earnings are what you make on VENTS: ticket sales, services and rewards. They become withdrawable to your bank after settlement
                (48 hours after the event ends or the booking is completed) and need your PIN. They can't be spent or sent.
              </p>
            </div>
            <WalletScreen currentUser={currentUser} onBack={onBack} embedded />
          </div>
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

const summaryCard: React.CSSProperties = {
  border: 'none', borderRadius: 28, minHeight: 112, padding: '14px 8px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
  gap: 8, cursor: 'pointer', minWidth: 0, color: '#FFFFFF', textAlign: 'center', boxSizing: 'border-box',
};
const summaryLabel: React.CSSProperties = { fontSize: 16, fontWeight: 500, color: W.lavender, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' };
const summaryAmount: React.CSSProperties = { fontSize: 'clamp(17px, 5.6vw, 22px)', fontWeight: 700, color: '#FFFFFF', letterSpacing: '-0.01em', maxWidth: '100%', overflowWrap: 'anywhere', lineHeight: 1.15 };
const pill: React.CSSProperties = { fontSize: 13.5, fontWeight: 500, padding: '5px 12px', borderRadius: 999, whiteSpace: 'nowrap' };
const srOnly: React.CSSProperties = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 };

function ActionButton({ icon, label, onClick, testId }: { icon: React.ReactNode; label: string; onClick: () => void; testId: string }) {
  return (
    <button type="button" data-testid={testId} onClick={onClick}
      style={{ minHeight: 72, background: 'none', border: 'none', color: '#FFFFFF', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 8, fontWeight: 500, fontSize: 15, cursor: 'pointer', minWidth: 0, padding: '6px 0' }}>
      <span aria-hidden style={{ color: W.lavender, display: 'flex' }}>{icon}</span>
      {label}
    </button>
  );
}

function txnIcon(t: WalletTxn): React.ReactNode {
  const ref = t.reference_id || '';
  switch (t.type) {
    case 'transfer_in': return <ArrowDownLeft size={22} color={W.green} strokeWidth={2} />;
    case 'transfer_out': return <ArrowUpRight size={22} color={W.lavender} strokeWidth={2} />;
    case 'deposit': return <PlusCircle size={22} color={W.green} strokeWidth={1.8} />;
    case 'refund': return <RotateCcw size={22} color={W.green} strokeWidth={1.8} />;
    case 'vc_conversion': return <Coins size={22} color="#FFD700" strokeWidth={1.8} />;
    case 'spend': return ref.startsWith('BKG-') ? <CalendarCheck size={24} color={W.lavender} strokeWidth={1.8} /> : <Ticket size={26} color={W.lavender} strokeWidth={1.8} />;
    default: return <CircleDollarSign size={22} color={W.sub} strokeWidth={1.8} />;
  }
}

function TxnRow({ t, onOpen }: { t: WalletTxn; onOpen: () => void }) {
  const dir = walletTxnDirection(t.type);
  return (
    <li>
      <button type="button" data-testid={`wallet-txn-${t.id}`} onClick={onOpen} aria-label={`${walletTxnKindLabel(t)}, ${walletTxnSubtitle(t)}, ${dir === 'in' ? 'plus' : dir === 'out' ? 'minus' : ''} ${formatNairaShort(t.amount_kobo)}, ${when(t.created_at)}, completed`}
        style={{ width: '100%', minHeight: 64, display: 'flex', alignItems: 'center', gap: 14, textAlign: 'left', background: 'none', border: 'none', padding: '10px 0', cursor: 'pointer', color: '#FFFFFF' }}>
        <span aria-hidden style={{ width: 28, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>{txnIcon(t)}</span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ display: 'block', fontSize: 17, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{walletTxnKindLabel(t)}</span>
          <span style={{ display: 'block', fontSize: 14, color: W.sub, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{walletTxnSubtitle(t)}</span>
        </span>
        <span data-testid={`wallet-txn-amount-${t.id}`} style={{ fontSize: 18, fontWeight: 600, color: dir === 'in' ? W.green : '#FFFFFF', flexShrink: 0 }}>
          {dir === 'in' ? '+' : dir === 'out' ? '−' : ''}{formatNairaShort(t.amount_kobo)}
        </span>
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
