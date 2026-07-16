import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Wallet, TrendingUp, ArrowDownCircle, Plus, AlertCircle, Check, ChevronDown, Search, Star, Trash2, Eye, EyeOff, ShieldCheck, Fingerprint } from 'lucide-react';
import { insforge, getAuthToken } from '../../lib/insforge';

interface WalletScreenProps {
  currentUser: { id: string; email: string; full_name: string | null; role: string } | null;
  onBack: () => void;
}

interface WalletData {
  balance_kobo: number;
  total_earned_kobo: number;
  pending_kobo: number;
}

interface Transaction {
  id: string;
  type: 'credit' | 'debit' | 'payout' | 'cancelled_payout_refund';
  amount_kobo: number;
  description: string | null;
  withdrawal_request_id: string | null;
  metadata: { bank_name?: string; account_number?: string; account_name?: string } | null;
  created_at: string;
}

// Money actually leaving the wallet vs. coming into/back into it — used to
// pick the icon, color, and +/- sign for each transaction row.
const CREDIT_TYPES = new Set(['credit', 'cancelled_payout_refund']);
const TYPE_LABELS: Record<string, string> = {
  credit: 'Credit',
  debit: 'Withdrawal',
  payout: 'Payout',
  cancelled_payout_refund: 'Payout Cancelled — Refunded',
};

interface BankAccount {
  id: string;
  bank_name: string;
  bank_code: string | null;
  account_number: string;
  account_name: string;
  recipient_code: string | null;
  is_default: boolean;
}

interface Bank {
  name: string;
  code: string;
}

function fmt(kobo: number) {
  return '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function authedFetch(path: string, body: any) {
  const token = await getAuthToken();
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Request failed');
  return json;
}

export function WalletScreen({ currentUser, onBack }: WalletScreenProps) {
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [txns, setTxns] = useState<Transaction[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [loading, setLoading] = useState(true);

  // Which account a withdrawal pays out to (defaults to the org's default).
  const [withdrawAccountId, setWithdrawAccountId] = useState<string | null>(null);

  // Password/biometric confirmation gate for every bank mutation. When set, a
  // modal collects the password; on confirm we run `action(password)`.
  const [confirm, setConfirm] = useState<{ label: string; action: (password: string) => Promise<void> } | null>(null);
  const [confirmPassword, setConfirmPassword] = useState('');
  const [confirmError, setConfirmError] = useState('');
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [showConfirmPw, setShowConfirmPw] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  // In-memory only (never persisted): lets a biometric unlock reuse the
  // password the organizer already typed once this session.
  const cachedPassword = useRef<string | null>(null);
  // null while loading; the RPC checks auth.users.email_verified for the
  // caller — the same platform flag InsForge itself gates login on. Wallet
  // actions are also enforced server-side (request_organizer_payout /
  // add_bank_account_confirmed reject unverified callers); this is the
  // UI-side reflection of that gate.
  const [emailVerified, setEmailVerified] = useState<boolean | null>(null);

  // Withdraw flow
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawError, setWithdrawError] = useState('');

  // Bank account flow
  const [showAddBank, setShowAddBank] = useState(false);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [banksLoading, setBanksLoading] = useState(false);
  const [showBankPicker, setShowBankPicker] = useState(false);
  const [bankSearch, setBankSearch] = useState('');
  const [selectedBank, setSelectedBank] = useState<Bank | null>(null);
  const [accountNumber, setAccountNumber] = useState('');
  const [resolvedName, setResolvedName] = useState('');
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState('');
  const [savingBank, setSavingBank] = useState(false);
  const [bankSaveError, setBankSaveError] = useState('');
  const resolveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = async () => {
    if (!currentUser?.id) return;
    setLoading(true);
    try {
      const [wRes, tRes, bRes, vRes] = await Promise.all([
        insforge.database.from('organizer_wallets').select('balance_kobo, total_earned_kobo, pending_kobo').eq('organizer_id', currentUser.id).maybeSingle(),
        insforge.database.from('organizer_transactions').select('id, type, amount_kobo, description, withdrawal_request_id, metadata, created_at').eq('organizer_id', currentUser.id).order('created_at', { ascending: false }).limit(30),
        insforge.database.from('organizer_bank_accounts').select('id, bank_name, bank_code, account_number, account_name, recipient_code, is_default').eq('organizer_id', currentUser.id).order('is_default', { ascending: false }).order('created_at', { ascending: true }),
        insforge.database.rpc('is_email_verified'),
      ]);
      setWallet(wRes.data || { balance_kobo: 0, total_earned_kobo: 0, pending_kobo: 0 });
      setTxns(tRes.data || []);
      const accounts: BankAccount[] = (bRes.data as BankAccount[]) || [];
      setBankAccounts(accounts);
      // Preselect the default (or first) account for withdrawals.
      setWithdrawAccountId(prev => prev && accounts.some(a => a.id === prev) ? prev : (accounts.find(a => a.is_default)?.id ?? accounts[0]?.id ?? null));
      setEmailVerified(vRes.data === true);
    } catch (e) {
      console.error('Wallet load error:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [currentUser?.id]);

  // Detect a real platform authenticator (Face ID / Touch ID / Android
  // biometric) so the "Use biometrics" button is only offered when it can
  // actually run — we never pretend it exists.
  useEffect(() => {
    let alive = true;
    const anyWin = window as any;
    const w: any = anyWin.PublicKeyCredential;
    if (w?.isUserVerifyingPlatformAuthenticatorAvailable) {
      w.isUserVerifyingPlatformAuthenticatorAvailable().then((ok: boolean) => { if (alive) setBiometricAvailable(!!ok); }).catch(() => {});
    } else if (anyWin.Capacitor?.isNativePlatform?.()) {
      setBiometricAvailable(true); // native shell exposes biometric APIs
    }
    return () => { alive = false; };
  }, []);

  // Open the password/biometric confirmation gate for a sensitive bank action.
  const requestConfirm = (label: string, action: (password: string) => Promise<void>) => {
    setConfirmError('');
    setConfirmPassword('');
    setShowConfirmPw(false);
    setConfirm({ label, action });
  };

  const runConfirm = async (password: string) => {
    if (!password) { setConfirmError('Please enter your password to continue.'); return; }
    setConfirmBusy(true);
    setConfirmError('');
    try {
      await confirm!.action(password);
      cachedPassword.current = password; // in-memory only, for biometric reuse
      setConfirm(null);
      setConfirmPassword('');
    } catch (e: any) {
      setConfirmError(e?.message || 'Confirmation failed. Please try again.');
    } finally {
      setConfirmBusy(false);
    }
  };

  // Real biometric user-verification. On success we reuse the password the
  // organizer typed earlier this session (never stored anywhere) — the server
  // still verifies that password. If none is cached yet, ask them to type it
  // once so biometrics can carry it forward afterwards.
  const confirmWithBiometrics = async () => {
    setConfirmError('');
    try {
      const anyWin = window as any;
      if (anyWin.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable) {
        const challenge = new Uint8Array(32); crypto.getRandomValues(challenge);
        await navigator.credentials.get({
          publicKey: { challenge, timeout: 60000, userVerification: 'required', rpId: window.location.hostname },
        } as any).catch(() => { throw new Error('Biometric check was cancelled.'); });
      }
      if (!cachedPassword.current) {
        setConfirmError('Enter your password once to enable biometric confirmation.');
        return;
      }
      await runConfirm(cachedPassword.current);
    } catch (e: any) {
      setConfirmError(e?.message || 'Biometric confirmation is unavailable — please use your password.');
    }
  };

  // Live account-number resolution, debounced, as soon as a bank is picked
  // and 10 digits are entered.
  useEffect(() => {
    setResolvedName('');
    setResolveError('');
    if (resolveTimer.current) clearTimeout(resolveTimer.current);
    if (!selectedBank || !/^\d{10}$/.test(accountNumber)) return;

    resolveTimer.current = setTimeout(async () => {
      setResolving(true);
      try {
        const result = await authedFetch('/api/v1/wallet/resolve-account', {
          account_number: accountNumber,
          bank_code: selectedBank.code,
        });
        setResolvedName(result.account_name);
      } catch (e: any) {
        setResolveError(e.message || 'Could not verify account');
      } finally {
        setResolving(false);
      }
    }, 500);
    return () => { if (resolveTimer.current) clearTimeout(resolveTimer.current); };
  }, [selectedBank, accountNumber]);

  const openAddBank = async () => {
    setBankSaveError('');
    setSelectedBank(null);
    setAccountNumber('');
    setResolvedName('');
    setResolveError('');
    setShowAddBank(true);
    if (banks.length === 0) {
      setBanksLoading(true);
      try {
        const res = await fetch('/api/v1/wallet/banks');
        const json = await res.json();
        if (res.ok) setBanks(json.banks || []);
      } catch (e) {
        console.error('Failed to load bank list:', e);
      } finally {
        setBanksLoading(false);
      }
    }
  };

  const handleWithdraw = async () => {
    setWithdrawError('');
    if (!emailVerified) { setWithdrawError('Please verify your email before requesting a withdrawal'); return; }
    const amount = parseFloat(withdrawAmount.replace(/[^0-9.]/g, ''));
    if (!amount || amount < 100) { setWithdrawError('Minimum withdrawal is ₦100'); return; }
    const kobo = Math.floor(amount * 100);
    if (!wallet || kobo > wallet.balance_kobo) { setWithdrawError('Insufficient balance'); return; }
    const payoutAccountId = withdrawAccountId || bankAccounts.find(a => a.is_default)?.id || bankAccounts[0]?.id;
    if (!payoutAccountId) { setWithdrawError('Add a bank account first'); return; }

    setWithdrawing(true);
    try {
      await getAuthToken();
      const { error } = await insforge.database.rpc('request_organizer_payout', {
        p_amount_kobo: kobo,
        p_bank_account_id: payoutAccountId,
      });
      if (error) throw new Error(error.message);
      setShowWithdraw(false);
      setWithdrawAmount('');
      await load();
    } catch (e: any) {
      setWithdrawError(e.message || 'Withdrawal failed');
    } finally {
      setWithdrawing(false);
    }
  };

  // Adding a bank account — gated by password/biometric confirmation.
  const handleSaveBank = () => {
    if (!selectedBank || !resolvedName || resolving) return;
    if (!emailVerified) { setBankSaveError('Please verify your email before adding a payout bank account'); return; }
    setShowAddBank(false);
    requestConfirm('Add this bank account', async (password) => {
      await authedFetch('/api/v1/wallet/save-bank', {
        account_number: accountNumber,
        bank_code: selectedBank.code,
        bank_name: selectedBank.name,
        password,
      });
      await load();
    });
  };

  // Set a linked account as the payout default — gated.
  const handleSetDefault = (acct: BankAccount) => {
    requestConfirm(`Make ${acct.bank_name} · ${acct.account_number} your default`, async (password) => {
      await authedFetch('/api/v1/wallet/save-bank', { action: 'set_default', account_id: acct.id, password });
      await load();
    });
  };

  // Remove a linked account — gated.
  const handleRemoveBank = (acct: BankAccount) => {
    requestConfirm(`Remove ${acct.bank_name} · ${acct.account_number}`, async (password) => {
      await authedFetch('/api/v1/wallet/save-bank', { action: 'remove', account_id: acct.id, password });
      await load();
    });
  };

  const balance = wallet?.balance_kobo ?? 0;
  const pending = wallet?.pending_kobo ?? 0;
  const totalEarned = wallet?.total_earned_kobo ?? 0;
  const filteredBanks = bankSearch.trim()
    ? banks.filter(b => b.name.toLowerCase().includes(bankSearch.toLowerCase()))
    : banks;

  return (
    <div style={{ background: '#020005', height: '100%', display: 'flex', flexDirection: 'column', color: '#F0F0FF', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '16px 20px', paddingTop: 'calc(16px + env(safe-area-inset-top))', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
          <ArrowLeft size={22} color="#F0F0FF" />
        </button>
        <span style={{ fontSize: '18px', fontWeight: 700 }}>My Wallet</span>
      </div>

      {loading ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ color: '#8B8FA8' }}>Loading…</span>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'scroll', WebkitOverflowScrolling: 'touch', padding: '20px' }}>
          {emailVerified === false && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: '12px', padding: '12px 16px', marginBottom: '20px' }}>
              <AlertCircle size={16} color="#F59E0B" style={{ flexShrink: 0 }} />
              <span style={{ color: '#F59E0B', fontSize: '13px' }}>Verify your email to withdraw funds or add a payout bank account.</span>
            </div>
          )}
          {/* Balance card */}
          <div style={{ background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', borderRadius: '20px', padding: '28px 24px', marginBottom: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <Wallet size={18} color="rgba(255,255,255,0.7)" />
              <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: '13px' }}>Available Balance</span>
            </div>
            <p style={{ fontSize: `clamp(20px, ${Math.max(20, 36 - Math.max(0, fmt(balance).length - 10) * 2)}px, 36px)`, fontWeight: 800, margin: '0 0 16px', color: '#fff', wordBreak: 'break-all' }}>{fmt(balance)}</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <TrendingUp size={14} color="rgba(255,255,255,0.6)" />
              <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '12px' }}>Total earned: {fmt(totalEarned)}</span>
            </div>
            {pending > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '12px' }}>Pending withdrawal: {fmt(pending)}</span>
              </div>
            )}
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: '12px', marginBottom: '24px' }}>
            <button
              onClick={() => setShowWithdraw(true)}
              style={{ flex: 1, background: balance > 0 && emailVerified !== false ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)', border: '1px solid rgba(168,85,247,0.3)', borderRadius: '100px', padding: '14px', cursor: balance > 0 && emailVerified !== false ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
              disabled={balance === 0 || emailVerified === false}
              title={emailVerified === false ? 'Verify your email to withdraw funds' : undefined}
            >
              <ArrowDownCircle size={18} color={balance > 0 && emailVerified !== false ? '#A855F7' : '#555'} />
              <span style={{ color: balance > 0 && emailVerified !== false ? '#A855F7' : '#555', fontWeight: 600, fontSize: '14px' }}>Withdraw</span>
            </button>
            <button
              onClick={openAddBank}
              style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '14px', padding: '14px', cursor: emailVerified === false ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', opacity: emailVerified === false ? 0.5 : 1 }}
              disabled={emailVerified === false}
              title={emailVerified === false ? 'Verify your email to add a payout bank account' : undefined}
            >
              <Plus size={18} color="#8B8FA8" />
              <span style={{ color: '#8B8FA8', fontWeight: 600, fontSize: '14px' }}>Add Bank</span>
            </button>
          </div>

          {/* Payout bank accounts (multiple; one Default) */}
          {bankAccounts.length > 0 && (
            <div style={{ marginBottom: '24px' }}>
              <p style={{ fontSize: '13px', fontWeight: 700, color: '#8B8FA8', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '12px' }}>Payout Accounts</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {bankAccounts.map(acct => (
                  <div key={acct.id} style={{ background: 'rgba(255,255,255,0.04)', border: acct.is_default ? '1px solid rgba(168,85,247,0.5)' : '1px solid rgba(255,255,255,0.06)', borderRadius: '14px', padding: '14px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <p style={{ margin: 0, fontSize: '13px', color: '#F0F0FF', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{acct.bank_name}</p>
                          {acct.is_default && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', background: 'rgba(168,85,247,0.18)', color: '#C4B5FD', fontSize: '10px', fontWeight: 700, padding: '2px 7px', borderRadius: '100px', flexShrink: 0 }}>
                              <Star size={9} fill="#C4B5FD" color="#C4B5FD" /> DEFAULT
                            </span>
                          )}
                          {acct.recipient_code && <Check size={13} color="#10B981" style={{ flexShrink: 0 }} />}
                        </div>
                        <p style={{ margin: '3px 0 0', fontSize: '12px', color: '#8B8FA8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{acct.account_number} · {acct.account_name}</p>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                      {!acct.is_default && (
                        <button onClick={() => handleSetDefault(acct)} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', padding: '9px', color: '#C4C9E0', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
                          <Star size={13} /> Set default
                        </button>
                      )}
                      <button onClick={() => handleRemoveBank(acct)} style={{ flex: acct.is_default ? 1 : 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '10px', padding: '9px 14px', color: '#F87171', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
                        <Trash2 size={13} /> Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Transaction history */}
          <p style={{ fontSize: '13px', fontWeight: 700, color: '#8B8FA8', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '12px' }}>Transactions</p>
          {txns.length === 0 ? (
            <p style={{ color: '#8B8FA8', fontSize: '13px', textAlign: 'center', padding: '24px 0' }}>No transactions yet</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {txns.map(t => {
                const isCredit = CREDIT_TYPES.has(t.type);
                const bank = t.metadata;
                return (
                  <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px', borderRadius: '12px', background: 'rgba(255,255,255,0.03)' }}>
                    <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: isCredit ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <span style={{ fontSize: '16px' }}>{isCredit ? '↓' : '↑'}</span>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ margin: 0, fontSize: '13px', color: '#F0F0FF', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.description || TYPE_LABELS[t.type] || 'Transaction'}</p>
                      {t.type === 'payout' && bank?.bank_name && (
                        <p style={{ margin: '2px 0 0', fontSize: '11px', color: '#8B8FA8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          Paid to {bank.bank_name}{bank.account_number ? ` · ${bank.account_number}` : ''}{bank.account_name ? ` · ${bank.account_name}` : ''}
                        </p>
                      )}
                      <p style={{ margin: '2px 0 0', fontSize: '11px', color: '#8B8FA8' }}>{new Date(t.created_at).toLocaleDateString('en-NG', { dateStyle: 'medium' })}</p>
                    </div>
                    <span style={{ color: isCredit ? '#10B981' : '#EF4444', fontWeight: 700, fontSize: '14px', flexShrink: 0 }}>
                      {isCredit ? '+' : '-'}{fmt(t.amount_kobo)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Withdraw modal */}
      {showWithdraw && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 9000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div style={{ background: '#090514', borderRadius: '20px 20px 0 0', padding: '24px', width: '100%', maxWidth: '390px', paddingBottom: 'calc(24px + env(safe-area-inset-bottom))' }}>
            <p style={{ fontSize: '18px', fontWeight: 700, margin: '0 0 4px' }}>Withdraw Funds</p>
            <p style={{ fontSize: '13px', color: '#8B8FA8', margin: '0 0 20px' }}>Available: {fmt(balance)}</p>
            <input
              type="number"
              placeholder="Amount in ₦ (e.g. 5000)"
              value={withdrawAmount}
              onChange={e => setWithdrawAmount(e.target.value)}
              style={{ width: '100%', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '12px', padding: '14px', color: '#fff', fontSize: '16px', boxSizing: 'border-box', outline: 'none', marginBottom: '12px' }}
            />
            {bankAccounts.length > 0 && (
              <div style={{ marginBottom: '12px' }}>
                <p style={{ fontSize: '12px', color: '#8B8FA8', margin: '0 0 8px' }}>Pay out to</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {bankAccounts.map(acct => {
                    const selected = (withdrawAccountId || bankAccounts.find(a => a.is_default)?.id) === acct.id;
                    return (
                      <button key={acct.id} onClick={() => setWithdrawAccountId(acct.id)} style={{ display: 'flex', alignItems: 'center', gap: '10px', textAlign: 'left', background: selected ? 'rgba(168,85,247,0.12)' : 'rgba(255,255,255,0.05)', border: `1px solid ${selected ? 'rgba(168,85,247,0.5)' : 'rgba(255,255,255,0.08)'}`, borderRadius: '12px', padding: '11px 13px', cursor: 'pointer' }}>
                        <div style={{ width: '16px', height: '16px', borderRadius: '50%', border: `2px solid ${selected ? '#A855F7' : '#555'}`, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {selected && <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#A855F7' }} />}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ margin: 0, fontSize: '12px', color: '#F0F0FF', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{acct.bank_name}{acct.is_default ? ' · Default' : ''}</p>
                          <p style={{ margin: '1px 0 0', fontSize: '11px', color: '#8B8FA8' }}>{acct.account_number}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {withdrawError && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '12px' }}>
                <AlertCircle size={14} color="#EF4444" />
                <span style={{ color: '#EF4444', fontSize: '13px' }}>{withdrawError}</span>
              </div>
            )}
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={() => { setShowWithdraw(false); setWithdrawError(''); }} style={{ flex: 1, background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: '12px', padding: '14px', color: '#8B8FA8', fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleWithdraw} disabled={withdrawing} style={{ flex: 1, background: 'linear-gradient(135deg,#7C3AED,#A855F7)', border: 'none', borderRadius: '12px', padding: '14px', color: '#fff', fontWeight: 700, cursor: withdrawing ? 'not-allowed' : 'pointer', opacity: withdrawing ? 0.6 : 1 }}>
                {withdrawing ? 'Processing…' : 'Withdraw'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add/Update bank modal */}
      {showAddBank && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 9000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div style={{ background: '#090514', borderRadius: '20px 20px 0 0', padding: '24px', width: '100%', maxWidth: '390px', paddingBottom: 'calc(24px + env(safe-area-inset-bottom))' }}>
            <p style={{ fontSize: '18px', fontWeight: 700, margin: '0 0 6px' }}>Add Bank Account</p>
            <p style={{ fontSize: '12px', color: '#8B8FA8', margin: '0 0 18px', display: 'flex', alignItems: 'center', gap: '5px' }}>
              <ShieldCheck size={13} color="#A855F7" /> You'll confirm with your password before it's saved.
            </p>

            {/* Bank picker */}
            <button
              onClick={() => setShowBankPicker(true)}
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '12px', padding: '14px', color: selectedBank ? '#fff' : '#8B8FA8', fontSize: '15px', marginBottom: '10px', cursor: 'pointer' }}
            >
              <span>{selectedBank ? selectedBank.name : banksLoading ? 'Loading banks…' : 'Select bank'}</span>
              <ChevronDown size={16} color="#8B8FA8" />
            </button>

            <input
              placeholder="10-digit account number"
              value={accountNumber}
              onChange={e => setAccountNumber(e.target.value.replace(/\D/g, '').slice(0, 10))}
              inputMode="numeric"
              style={{ width: '100%', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '12px', padding: '14px', color: '#fff', fontSize: '15px', boxSizing: 'border-box', outline: 'none', marginBottom: '10px' }}
            />

            {resolving && <p style={{ color: '#8B8FA8', fontSize: '13px', margin: '0 0 10px' }}>Verifying account…</p>}
            {resolveError && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px' }}>
                <AlertCircle size={14} color="#EF4444" />
                <span style={{ color: '#EF4444', fontSize: '13px' }}>{resolveError}</span>
              </div>
            )}
            {resolvedName && !resolving && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: '12px', padding: '12px 14px', marginBottom: '10px' }}>
                <Check size={16} color="#10B981" />
                <span style={{ color: '#10B981', fontSize: '14px', fontWeight: 600 }}>{resolvedName}</span>
              </div>
            )}

            {bankSaveError && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px' }}>
                <AlertCircle size={14} color="#EF4444" />
                <span style={{ color: '#EF4444', fontSize: '13px' }}>{bankSaveError}</span>
              </div>
            )}

            <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
              <button onClick={() => setShowAddBank(false)} style={{ flex: 1, background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: '12px', padding: '14px', color: '#8B8FA8', fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
              <button
                onClick={handleSaveBank}
                disabled={savingBank || !resolvedName || resolving}
                style={{ flex: 1, background: 'linear-gradient(135deg,#7C3AED,#A855F7)', border: 'none', borderRadius: '12px', padding: '14px', color: '#fff', fontWeight: 700, cursor: (savingBank || !resolvedName) ? 'not-allowed' : 'pointer', opacity: (savingBank || !resolvedName) ? 0.6 : 1 }}
              >
                {savingBank ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bank picker modal */}
      {showBankPicker && (
        <div style={{ position: 'fixed', inset: 0, background: '#020005', zIndex: 9500, display: 'flex', flexDirection: 'column', padding: 'calc(20px + env(safe-area-inset-top)) 20px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <p style={{ fontSize: '18px', fontWeight: 700, margin: 0 }}>Select Bank</p>
            <button onClick={() => { setShowBankPicker(false); setBankSearch(''); }} style={{ background: 'none', border: 'none', color: '#8B8FA8', fontSize: '14px', cursor: 'pointer' }}>Close</button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: '#090514', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '100px', padding: '10px 16px', marginBottom: '14px' }}>
            <Search size={16} color="#8B8FA8" />
            <input
              placeholder="Search banks…"
              value={bankSearch}
              onChange={e => setBankSearch(e.target.value)}
              style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: '#fff', fontSize: '14px' }}
              autoFocus
            />
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {filteredBanks.map(bank => (
              <button
                key={bank.code}
                onClick={() => { setSelectedBank(bank); setShowBankPicker(false); setBankSearch(''); }}
                style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', borderBottom: '1px solid rgba(255,255,255,0.05)', padding: '14px 4px', color: '#fff', fontSize: '15px', cursor: 'pointer' }}
              >
                {bank.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Security gate: password / biometric confirmation for bank mutations */}
      {confirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 9800, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div style={{ background: '#090514', borderRadius: '20px 20px 0 0', padding: '24px', width: '100%', maxWidth: '390px', paddingBottom: 'calc(24px + env(safe-area-inset-bottom))' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
              <ShieldCheck size={20} color="#A855F7" />
              <p style={{ fontSize: '17px', fontWeight: 700, margin: 0 }}>Confirm it's you</p>
            </div>
            <p style={{ fontSize: '13px', color: '#8B8FA8', margin: '0 0 18px', lineHeight: 1.5 }}>{confirm.label}. For your security, re-enter your password{biometricAvailable ? ' or use biometrics' : ''} to continue.</p>

            <div style={{ position: 'relative', marginBottom: '10px' }}>
              <input
                type={showConfirmPw ? 'text' : 'password'}
                placeholder="Your account password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                autoComplete="current-password"
                autoCapitalize="off"
                autoCorrect="off"
                onKeyDown={e => { if (e.key === 'Enter' && !confirmBusy) runConfirm(confirmPassword); }}
                style={{ width: '100%', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '12px', padding: '14px 44px 14px 14px', color: '#fff', fontSize: '15px', boxSizing: 'border-box', outline: 'none' }}
              />
              <button type="button" onClick={() => setShowConfirmPw(v => !v)} tabIndex={-1} style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: '6px', color: '#8B8FA8', display: 'flex' }}>
                {showConfirmPw ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>

            {biometricAvailable && (
              <button onClick={confirmWithBiometrics} disabled={confirmBusy} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', background: 'rgba(168,85,247,0.1)', border: '1px solid rgba(168,85,247,0.3)', borderRadius: '12px', padding: '12px', color: '#C4B5FD', fontSize: '14px', fontWeight: 600, cursor: 'pointer', marginBottom: '10px' }}>
                <Fingerprint size={17} /> Use Face ID / Touch ID
              </button>
            )}

            {confirmError && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px' }}>
                <AlertCircle size={14} color="#EF4444" />
                <span style={{ color: '#EF4444', fontSize: '13px' }}>{confirmError}</span>
              </div>
            )}

            <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
              <button onClick={() => { setConfirm(null); setConfirmPassword(''); setConfirmError(''); }} disabled={confirmBusy} style={{ flex: 1, background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: '12px', padding: '14px', color: '#8B8FA8', fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
              <button onClick={() => runConfirm(confirmPassword)} disabled={confirmBusy || !confirmPassword} style={{ flex: 1, background: 'linear-gradient(135deg,#7C3AED,#A855F7)', border: 'none', borderRadius: '12px', padding: '14px', color: '#fff', fontWeight: 700, cursor: (confirmBusy || !confirmPassword) ? 'not-allowed' : 'pointer', opacity: (confirmBusy || !confirmPassword) ? 0.6 : 1 }}>
                {confirmBusy ? 'Confirming…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
