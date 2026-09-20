import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, ChevronDown, Check, Landmark } from 'lucide-react';
import { supabase, getAuthToken } from '../../lib/supabase';
import { apiUrl } from '../../lib/apiBase';
import { Sentry } from '../../lib/sentry';

interface VcCashoutScreenProps {
  onBack: () => void;
  currentUser: { id: string; email: string; full_name: string | null } | null;
  balance: number;
  onBalanceChange: (next: number) => void;
}

interface Bank { name: string; code: string; }

interface VcBankAccount {
  id: string;
  bank_name: string;
  account_number: string;
  account_name: string;
  recipient_code: string | null;
  is_default: boolean;
  is_active: boolean;
}

interface VcWithdrawalRow {
  id: string;
  vc_amount: number;
  ngn_amount_kobo: number;
  status: string;
  created_at: string;
  failure_reason: string | null;
}

const DEFAULT_MIN_VC = 250000; // app_config.vc_cashout_min_vc default (₦25,000 @ the default rate) -- the server (request_vc_cashout) is the authoritative gate; this is only the initial display value before load() fetches the real config.
// Nigeria-scoped: NUBAN account numbers are always exactly 10 digits. Named
// explicitly for this rail so a future non-Nigerian rail doesn't inherit an
// unlabeled "10" assumption elsewhere in this file.
const NUBAN_ACCOUNT_NUMBER_LENGTH = 10;

function fmtNaira(kobo: number): string {
  return '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
}

async function authedFetch(path: string, body: any) {
  const token = await getAuthToken();
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Request failed');
  return json;
}

// Cash-out flow for VENTS Cents -> NGN, launched from ReferralScreen. Reuses
// the EXACT same Paystack bank-resolve/save-bank machinery as the organizer
// payout flow (api/wallet/banks.ts, resolve-account.ts, save-bank.ts with
// scope: 'vc') and calls request_vc_cashout, which computes the NGN amount
// SERVER-SIDE from app_config.vc_cashout_naira_per_1000 -- this screen only
// ever displays that number back, it never sends it to the server.
//
// Copy is deliberately honest at every state: a submitted/pending/processing
// request is never described as money having arrived -- only 'completed'
// (set exclusively by the Paystack webhook / reconciliation poller, never
// this screen) says that.
export function VcCashoutScreen({ onBack, currentUser, balance, onBalanceChange }: VcCashoutScreenProps) {
  const [rate, setRate] = useState(100); // app_config.vc_cashout_naira_per_1000 default
  const [minVc, setMinVc] = useState(DEFAULT_MIN_VC); // app_config.vc_cashout_min_vc
  const [accounts, setAccounts] = useState<VcBankAccount[]>([]);
  const [history, setHistory] = useState<VcWithdrawalRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [amount, setAmount] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [step, setStep] = useState<'form' | 'confirm' | 'add_bank' | 'password'>('form');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');

  // Add-bank sub-form state
  const [banks, setBanks] = useState<Bank[]>([]);
  const [banksLoading, setBanksLoading] = useState(false);
  const [showBankPicker, setShowBankPicker] = useState(false);
  const [selectedBank, setSelectedBank] = useState<Bank | null>(null);
  const [bankSearch, setBankSearch] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [resolvedName, setResolvedName] = useState('');
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState('');
  const resolveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [password, setPassword] = useState('');
  const [pendingAction, setPendingAction] = useState<null | (() => Promise<void>)>(null);

  async function load() {
    if (!currentUser?.id) return;
    setLoading(true);
    try {
      const [configRes, acctRes, histRes] = await Promise.all([
        supabase.from('app_config' as any).select('vc_cashout_naira_per_1000, vc_cashout_min_vc').maybeSingle(),
        supabase.from('vc_bank_accounts' as any).select('id, bank_name, account_number, account_name, recipient_code, is_default, is_active').eq('user_id', currentUser.id).eq('is_active', true).order('is_default', { ascending: false }),
        supabase.from('vc_withdrawal_requests' as any).select('id, vc_amount, ngn_amount_kobo, status, created_at, failure_reason').eq('user_id', currentUser.id).order('created_at', { ascending: false }).limit(20),
      ]);
      if ((configRes.data as any)?.vc_cashout_naira_per_1000 != null) setRate((configRes.data as any).vc_cashout_naira_per_1000);
      if ((configRes.data as any)?.vc_cashout_min_vc != null) setMinVc((configRes.data as any).vc_cashout_min_vc);
      const accts = (acctRes.data as any) || [];
      setAccounts(accts);
      if (!selectedAccountId && accts.length > 0) setSelectedAccountId(accts.find((a: VcBankAccount) => a.is_default)?.id || accts[0].id);
      setHistory((histRes.data as any) || []);
    } catch (err) {
      console.error('Failed to load VC cash-out data:', err);
      Sentry.captureException(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [currentUser?.id]);

  useEffect(() => {
    setResolvedName(''); setResolveError('');
    if (resolveTimer.current) clearTimeout(resolveTimer.current);
    if (!selectedBank || accountNumber.length !== NUBAN_ACCOUNT_NUMBER_LENGTH || !/^\d+$/.test(accountNumber)) return;
    resolveTimer.current = setTimeout(async () => {
      setResolving(true);
      try {
        const result = await authedFetch('/api/v1/wallet/resolve-account', { account_number: accountNumber, bank_code: selectedBank.code });
        setResolvedName(result.account_name);
      } catch (e: any) {
        setResolveError(e.message || 'Could not verify account');
      } finally { setResolving(false); }
    }, 500);
    return () => { if (resolveTimer.current) clearTimeout(resolveTimer.current); };
  }, [selectedBank, accountNumber]);

  const filteredBanks = bankSearch.trim()
    ? banks.filter(b => b.name.toLowerCase().includes(bankSearch.trim().toLowerCase()))
    : banks;

  async function openAddBank() {
    setError(''); setSelectedBank(null); setBankSearch(''); setAccountNumber(''); setResolvedName(''); setResolveError('');
    setStep('add_bank');
    if (banks.length === 0) {
      setBanksLoading(true);
      try {
        const token = await getAuthToken();
        const res = await fetch(apiUrl('/api/v1/wallet/banks'), { headers: { Authorization: `Bearer ${token}` } });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || 'Failed to load bank list');
        setBanks(json.banks || []);
      } catch (e: any) {
        setError(e?.message || 'Failed to load bank list');
      } finally { setBanksLoading(false); }
    }
  }

  function requestPassword(action: () => Promise<void>) {
    setPassword(''); setError(''); setPendingAction(() => action); setStep('password');
  }

  async function confirmPassword() {
    if (!password) { setError('Enter your password'); return; }
    setBusy(true); setError('');
    try {
      await pendingAction?.();
    } catch (e: any) {
      setError(e?.message || 'Failed');
    } finally { setBusy(false); }
  }

  function saveBank() {
    if (!selectedBank || !resolvedName || resolving) return;
    requestPassword(async () => {
      await authedFetch('/api/v1/wallet/save-bank', {
        scope: 'vc',
        account_number: accountNumber,
        bank_code: selectedBank.code,
        bank_name: selectedBank.name,
        password,
      });
      setStep('form');
      await load();
    });
  }

  const vcAmount = Math.max(0, Math.floor(Number(amount.replace(/[^0-9]/g, '')) || 0));
  const ngnEstimateKobo = Math.floor((vcAmount * rate * 100) / 1000);
  const canSubmit = vcAmount >= minVc && vcAmount <= balance && !!selectedAccountId;

  async function submitCashout() {
    setError('');
    if (!canSubmit) return;
    setBusy(true);
    try {
      const idempotencyKey = `vc_${currentUser?.id}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const { error: rpcErr } = await supabase.rpc('request_vc_cashout' as any, {
        p_vc_amount: vcAmount,
        p_bank_account_id: selectedAccountId,
        p_idempotency_key: idempotencyKey,
      });
      if (rpcErr) throw new Error(rpcErr.message);
      onBalanceChange(balance - vcAmount);
      setAmount('');
      setStep('form');
      setSuccessMsg('Cash-out requested. This is NOT yet paid — it is pending admin review, then a bank transfer. You will see the status update below once it is processed.');
      await load();
    } catch (e: any) {
      setError(e?.message || 'Cash-out request failed');
      setStep('form');
    } finally { setBusy(false); }
  }

  const STATUS_LABEL: Record<string, { label: string; color: string; honest: string }> = {
    pending: { label: 'Pending review', color: '#F59E0B', honest: 'Submitted — awaiting admin review. No money has moved yet.' },
    processing: { label: 'Processing', color: '#60A5FA', honest: 'Transfer initiated with our payment provider — not yet confirmed as received.' },
    completed: { label: 'Paid', color: '#10B981', honest: 'Confirmed paid to your bank account.' },
    failed: { label: 'Failed — VC returned', color: '#EF4444', honest: 'The transfer failed. Your Vents Cents were returned to your balance.' },
    rejected: { label: 'Rejected — VC returned', color: '#EF4444', honest: 'This request was rejected. Your Vents Cents were returned to your balance.' },
    cancelled: { label: 'Cancelled — VC returned', color: '#8B8FA8', honest: 'This request was cancelled. Your Vents Cents were returned to your balance.' },
  };

  return (
    <div style={{ background: '#08050f', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'calc(16px + env(safe-area-inset-top)) 20px 4px', flexShrink: 0 }}>
        <button onClick={onBack} style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={16} color="#f6f4f9" />
        </button>
        <span style={{ fontSize: '12px', letterSpacing: '2px', color: '#9a93a8', fontWeight: 700 }}>CASH OUT VC</span>
        <div style={{ width: '36px' }} />
      </div>

      <div style={{ position: 'relative', flex: 1, overflowY: 'auto', padding: '0 16px', paddingBottom: 'calc(32px + env(safe-area-inset-bottom))' }}>
        {step === 'form' && (
          <>
            <div style={{ marginTop: '18px', padding: '18px 20px', borderRadius: '18px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', marginBottom: '16px' }}>
              <div style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em' }}>AVAILABLE BALANCE</div>
              <div style={{ color: '#F0F0FF', fontSize: '28px', fontWeight: 900, marginTop: '4px' }}>◎ {balance.toLocaleString()} VC</div>
              <div style={{ color: '#8B8FA8', fontSize: '12px', marginTop: '4px' }}>Rate: 1,000 VC = {fmtNaira(rate * 100)}</div>
            </div>

            {successMsg && (
              <div style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: '10px', padding: '10px 12px', marginBottom: '14px', color: '#10B981', fontSize: '12.5px', lineHeight: 1.4 }}>{successMsg}</div>
            )}

            <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', marginBottom: '8px' }}>AMOUNT TO CASH OUT (VC)</p>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder={`Minimum ${minVc.toLocaleString()} VC`}
              style={{ width: '100%', boxSizing: 'border-box', background: '#090514', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', padding: '14px', color: '#F0F0FF', fontSize: '16px', fontWeight: 700, marginBottom: '10px' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', color: '#8B8FA8', fontSize: '12.5px', marginBottom: '18px' }}>
              <span>You'll receive (estimate)</span>
              <span style={{ color: '#10B981', fontWeight: 700 }}>{fmtNaira(ngnEstimateKobo)}</span>
            </div>

            <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', marginBottom: '8px' }}>PAY TO</p>
            {accounts.length === 0 ? (
              <button onClick={openAddBank} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '10px', background: '#090514', border: '1px dashed rgba(255,255,255,0.18)', borderRadius: '12px', padding: '14px', color: '#A855F7', fontSize: '13.5px', fontWeight: 700, cursor: 'pointer', marginBottom: '18px' }}>
                <Landmark size={16} /> Add a bank account
              </button>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '18px' }}>
                {accounts.map(a => (
                  <button key={a.id} onClick={() => setSelectedAccountId(a.id)} style={{ display: 'flex', alignItems: 'center', gap: '10px', background: selectedAccountId === a.id ? 'rgba(168,85,247,0.12)' : '#090514', border: `1px solid ${selectedAccountId === a.id ? 'rgba(168,85,247,0.4)' : 'rgba(255,255,255,0.08)'}`, borderRadius: '12px', padding: '12px', color: '#F0F0FF', fontSize: '13px', cursor: 'pointer', textAlign: 'left' }}>
                    <Landmark size={16} color="#A855F7" />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700 }}>{a.bank_name}</div>
                      <div style={{ color: '#8B8FA8', fontSize: '11.5px' }}>{a.account_number} · {a.account_name}</div>
                    </div>
                    {selectedAccountId === a.id && <Check size={16} color="#A855F7" />}
                  </button>
                ))}
                <button onClick={openAddBank} style={{ background: 'none', border: 'none', color: '#A855F7', fontSize: '12.5px', fontWeight: 700, cursor: 'pointer', textAlign: 'left', padding: '4px 0' }}>+ Add another bank account</button>
              </div>
            )}

            {error && <p style={{ color: '#EF4444', fontSize: '12.5px', marginBottom: '10px' }}>{error}</p>}
            {vcAmount > 0 && vcAmount < minVc && <p style={{ color: '#F59E0B', fontSize: '12px', marginBottom: '10px' }}>Minimum cash-out is {minVc.toLocaleString()} VC.</p>}
            {vcAmount > balance && <p style={{ color: '#EF4444', fontSize: '12px', marginBottom: '10px' }}>You don't have enough Vents Cents for this amount.</p>}

            <button
              onClick={() => setStep('confirm')}
              disabled={!canSubmit}
              style={{ width: '100%', padding: '14px', borderRadius: '12px', border: 'none', fontWeight: 800, fontSize: '14px', cursor: canSubmit ? 'pointer' : 'not-allowed', background: canSubmit ? 'linear-gradient(135deg,#a855f7,#7c3aed)' : 'rgba(255,255,255,0.06)', color: canSubmit ? '#fff' : '#555C7A', marginBottom: '24px' }}
            >
              Review Cash-out
            </button>

            <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', margin: '8px 0' }}>WITHDRAWAL HISTORY</p>
            {loading ? (
              <p style={{ color: '#8B8FA8', fontSize: '12px' }}>Loading…</p>
            ) : history.length === 0 ? (
              <p style={{ color: '#8B8FA8', fontSize: '12px' }}>No cash-out requests yet.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {history.map(h => {
                  const meta = STATUS_LABEL[h.status] || { label: h.status, color: '#8B8FA8', honest: '' };
                  return (
                    <div key={h.id} style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', padding: '12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 700 }}>{h.vc_amount.toLocaleString()} VC → {fmtNaira(h.ngn_amount_kobo)}</div>
                        <span style={{ color: meta.color, fontSize: '11px', fontWeight: 700 }}>{meta.label}</span>
                      </div>
                      <div style={{ color: '#8B8FA8', fontSize: '11px', marginTop: '4px' }}>{new Date(h.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
                      {meta.honest && <div style={{ color: '#8B8FA8', fontSize: '11px', marginTop: '4px', lineHeight: 1.4 }}>{meta.honest}</div>}
                      {h.failure_reason && h.status === 'failed' && <div style={{ color: '#EF4444', fontSize: '11px', marginTop: '4px' }}>{h.failure_reason}</div>}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {step === 'confirm' && (
          <div style={{ marginTop: '20px' }}>
            <div style={{ background: 'rgba(255,184,48,0.08)', border: '1px solid rgba(255,184,48,0.2)', borderRadius: '12px', padding: '12px', marginBottom: '18px', color: '#FFB830', fontSize: '12.5px', lineHeight: 1.4 }}>
              Confirming submits a cash-out request for admin review. This does NOT pay you instantly — funds arrive only after the request is approved and the bank transfer is confirmed.
            </div>
            <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '14px', padding: '16px', marginBottom: '18px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}><span style={{ color: '#8B8FA8', fontSize: '13px' }}>VC to redeem</span><span style={{ color: '#F0F0FF', fontWeight: 700 }}>{vcAmount.toLocaleString()} VC</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}><span style={{ color: '#8B8FA8', fontSize: '13px' }}>Estimated NGN</span><span style={{ color: '#10B981', fontWeight: 700 }}>{fmtNaira(ngnEstimateKobo)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#8B8FA8', fontSize: '13px' }}>To</span><span style={{ color: '#F0F0FF', fontWeight: 700 }}>{accounts.find(a => a.id === selectedAccountId)?.bank_name} · {accounts.find(a => a.id === selectedAccountId)?.account_number}</span></div>
            </div>
            {error && <p style={{ color: '#EF4444', fontSize: '12.5px', marginBottom: '10px' }}>{error}</p>}
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={() => setStep('form')} style={{ flex: 1, padding: '13px', borderRadius: '12px', background: 'none', border: '1px solid rgba(255,255,255,0.12)', color: '#8B8FA8', fontWeight: 700, cursor: 'pointer' }}>Back</button>
              <button onClick={submitCashout} disabled={busy} style={{ flex: 1, padding: '13px', borderRadius: '12px', background: 'linear-gradient(135deg,#a855f7,#7c3aed)', border: 'none', color: '#fff', fontWeight: 800, cursor: busy ? 'default' : 'pointer' }}>{busy ? 'Submitting…' : 'Confirm Request'}</button>
            </div>
          </div>
        )}

        {step === 'add_bank' && (
          <div style={{ marginTop: '20px' }}>
            <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', marginBottom: '8px' }}>BANK</p>
            <button onClick={() => setShowBankPicker(v => !v)} style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#090514', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', padding: '14px', color: selectedBank ? '#F0F0FF' : '#555C7A', fontSize: '13.5px', marginBottom: '10px', cursor: 'pointer' }}>
              {banksLoading ? 'Loading banks…' : (selectedBank?.name || 'Select bank')} <ChevronDown size={16} />
            </button>
            {showBankPicker && (
              <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', marginBottom: '10px', overflow: 'hidden' }}>
                <input
                  value={bankSearch}
                  onChange={(e) => setBankSearch(e.target.value)}
                  placeholder="Search banks…"
                  autoFocus
                  style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,0.04)', border: 'none', borderBottom: '1px solid rgba(255,255,255,0.08)', padding: '12px 14px', color: '#F0F0FF', fontSize: '13.5px', outline: 'none' }}
                />
                <div style={{ maxHeight: '220px', overflowY: 'auto' }}>
                  {filteredBanks.length === 0 ? (
                    <div style={{ padding: '16px 14px', color: '#8B8FA8', fontSize: '13px', textAlign: 'center' }}>No banks found</div>
                  ) : (
                    filteredBanks.map(b => (
                      <button key={b.code} onClick={() => { setSelectedBank(b); setShowBankPicker(false); setBankSearch(''); }} style={{ width: '100%', textAlign: 'left', padding: '14px', minHeight: '44px', background: 'none', border: 'none', borderBottom: '1px solid rgba(255,255,255,0.05)', color: '#F0F0FF', fontSize: '13px', cursor: 'pointer' }}>{b.name}</button>
                    ))
                  )}
                </div>
              </div>
            )}
            <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', marginBottom: '8px' }}>ACCOUNT NUMBER</p>
            <input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value.replace(/[^0-9]/g, '').slice(0, NUBAN_ACCOUNT_NUMBER_LENGTH))} placeholder={`${NUBAN_ACCOUNT_NUMBER_LENGTH}-digit account number`} style={{ width: '100%', boxSizing: 'border-box', background: '#090514', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', padding: '14px', color: '#F0F0FF', fontSize: '14px', marginBottom: '10px' }} />
            {resolving && <p style={{ color: '#8B8FA8', fontSize: '12px' }}>Verifying…</p>}
            {resolvedName && <p style={{ color: '#10B981', fontSize: '13px', fontWeight: 700 }}>✓ {resolvedName}</p>}
            {resolveError && <p style={{ color: '#EF4444', fontSize: '12px' }}>{resolveError}</p>}
            {error && <p style={{ color: '#EF4444', fontSize: '12.5px', margin: '10px 0' }}>{error}</p>}
            <div style={{ display: 'flex', gap: '10px', marginTop: '16px' }}>
              <button onClick={() => setStep('form')} style={{ flex: 1, padding: '13px', borderRadius: '12px', background: 'none', border: '1px solid rgba(255,255,255,0.12)', color: '#8B8FA8', fontWeight: 700, cursor: 'pointer' }}>Cancel</button>
              <button onClick={saveBank} disabled={!selectedBank || !resolvedName || resolving} style={{ flex: 1, padding: '13px', borderRadius: '12px', background: (selectedBank && resolvedName) ? 'linear-gradient(135deg,#a855f7,#7c3aed)' : 'rgba(255,255,255,0.06)', border: 'none', color: (selectedBank && resolvedName) ? '#fff' : '#555C7A', fontWeight: 800, cursor: (selectedBank && resolvedName) ? 'pointer' : 'not-allowed' }}>Continue</button>
            </div>
          </div>
        )}

        {step === 'password' && (
          <div style={{ marginTop: '20px' }}>
            <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700, marginBottom: '10px' }}>Confirm your password</p>
            <p style={{ color: '#8B8FA8', fontSize: '12.5px', marginBottom: '14px' }}>Adding a payout bank account requires re-entering your password.</p>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" style={{ width: '100%', boxSizing: 'border-box', background: '#090514', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', padding: '14px', color: '#F0F0FF', fontSize: '14px', marginBottom: '10px' }} />
            {error && <p style={{ color: '#EF4444', fontSize: '12.5px', marginBottom: '10px' }}>{error}</p>}
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={() => setStep('add_bank')} style={{ flex: 1, padding: '13px', borderRadius: '12px', background: 'none', border: '1px solid rgba(255,255,255,0.12)', color: '#8B8FA8', fontWeight: 700, cursor: 'pointer' }}>Back</button>
              <button onClick={confirmPassword} disabled={busy} style={{ flex: 1, padding: '13px', borderRadius: '12px', background: 'linear-gradient(135deg,#a855f7,#7c3aed)', border: 'none', color: '#fff', fontWeight: 800, cursor: busy ? 'default' : 'pointer' }}>{busy ? 'Confirming…' : 'Confirm'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
