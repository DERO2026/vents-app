import { useState, useEffect } from 'react';
import { ArrowLeft, Wallet, TrendingUp, ArrowDownCircle, Plus, AlertCircle } from 'lucide-react';
import { insforge } from '../../lib/insforge';

interface WalletScreenProps {
  currentUser: { id: string; email: string; full_name: string | null; role: string } | null;
  onBack: () => void;
}

interface WalletData {
  balance_kobo: number;
  total_earned_kobo: number;
}

interface Transaction {
  id: string;
  type: 'credit' | 'debit' | 'payout';
  amount_kobo: number;
  description: string | null;
  created_at: string;
}

interface BankAccount {
  id: string;
  bank_name: string;
  account_number: string;
  account_name: string;
}

function fmt(kobo: number) {
  return '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function WalletScreen({ currentUser, onBack }: WalletScreenProps) {
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [txns, setTxns] = useState<Transaction[]>([]);
  const [bankAccount, setBankAccount] = useState<BankAccount | null>(null);
  const [loading, setLoading] = useState(true);

  // Withdraw flow
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawError, setWithdrawError] = useState('');

  // Bank account flow
  const [showAddBank, setShowAddBank] = useState(false);
  const [bankName, setBankName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [accountName, setAccountName] = useState('');
  const [savingBank, setSavingBank] = useState(false);

  const load = async () => {
    if (!currentUser?.id) return;
    setLoading(true);
    try {
      const [wRes, tRes, bRes] = await Promise.all([
        insforge.database.from('organizer_wallets').select('balance_kobo, total_earned_kobo').eq('organizer_id', currentUser.id).maybeSingle(),
        insforge.database.from('organizer_transactions').select('id, type, amount_kobo, description, created_at').eq('organizer_id', currentUser.id).order('created_at', { ascending: false }).limit(30),
        insforge.database.from('organizer_bank_accounts').select('id, bank_name, account_number, account_name').eq('organizer_id', currentUser.id).maybeSingle(),
      ]);
      setWallet(wRes.data || { balance_kobo: 0, total_earned_kobo: 0 });
      setTxns(tRes.data || []);
      setBankAccount(bRes.data || null);
    } catch (e) {
      console.error('Wallet load error:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [currentUser?.id]);

  const handleWithdraw = async () => {
    setWithdrawError('');
    const amount = parseFloat(withdrawAmount.replace(/[^0-9.]/g, ''));
    if (!amount || amount < 100) { setWithdrawError('Minimum withdrawal is ₦100'); return; }
    const kobo = Math.floor(amount * 100);
    if (!wallet || kobo > wallet.balance_kobo) { setWithdrawError('Insufficient balance'); return; }
    if (!bankAccount) { setWithdrawError('Add a bank account first'); return; }

    setWithdrawing(true);
    try {
      const { error } = await insforge.database.rpc('request_organizer_payout', {
        p_amount_kobo: kobo,
        p_bank_account_id: bankAccount.id,
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

  const handleSaveBank = async () => {
    if (!bankName.trim() || !accountNumber.trim() || !accountName.trim()) return;
    setSavingBank(true);
    try {
      await insforge.database.from('organizer_bank_accounts').upsert({
        organizer_id: currentUser!.id,
        bank_name: bankName.trim(),
        account_number: accountNumber.trim(),
        account_name: accountName.trim(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'organizer_id' });
      setShowAddBank(false);
      await load();
    } catch (e: any) {
      alert(e.message || 'Failed to save bank account');
    } finally {
      setSavingBank(false);
    }
  };

  const balance = wallet?.balance_kobo ?? 0;
  const totalEarned = wallet?.total_earned_kobo ?? 0;

  return (
    <div style={{ background: '#0D0E1A', minHeight: '100%', display: 'flex', flexDirection: 'column', color: '#F0F0FF' }}>
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
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
          {/* Balance card */}
          <div style={{ background: 'linear-gradient(135deg,#4F46E5,#7C3AED,#A855F7)', borderRadius: '20px', padding: '28px 24px', marginBottom: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <Wallet size={18} color="rgba(255,255,255,0.7)" />
              <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: '13px' }}>Available Balance</span>
            </div>
            <p style={{ fontSize: `clamp(20px, ${Math.max(20, 36 - Math.max(0, fmt(balance).length - 10) * 2)}px, 36px)`, fontWeight: 800, margin: '0 0 16px', color: '#fff', wordBreak: 'break-all' }}>{fmt(balance)}</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <TrendingUp size={14} color="rgba(255,255,255,0.6)" />
              <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '12px' }}>Total earned: {fmt(totalEarned)}</span>
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: '12px', marginBottom: '24px' }}>
            <button
              onClick={() => setShowWithdraw(true)}
              style={{ flex: 1, background: balance > 0 ? 'rgba(168,85,247,0.15)' : 'rgba(255,255,255,0.05)', border: '1px solid rgba(168,85,247,0.3)', borderRadius: '14px', padding: '14px', cursor: balance > 0 ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
              disabled={balance === 0}
            >
              <ArrowDownCircle size={18} color={balance > 0 ? '#A855F7' : '#555'} />
              <span style={{ color: balance > 0 ? '#A855F7' : '#555', fontWeight: 600, fontSize: '14px' }}>Withdraw</span>
            </button>
            <button
              onClick={() => { setBankName(bankAccount?.bank_name || ''); setAccountNumber(bankAccount?.account_number || ''); setAccountName(bankAccount?.account_name || ''); setShowAddBank(true); }}
              style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '14px', padding: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
            >
              <Plus size={18} color="#8B8FA8" />
              <span style={{ color: '#8B8FA8', fontWeight: 600, fontSize: '14px' }}>{bankAccount ? 'Update Bank' : 'Add Bank'}</span>
            </button>
          </div>

          {/* Bank account summary */}
          {bankAccount && (
            <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: '14px', padding: '14px 16px', marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div style={{ flex: 1 }}>
                <p style={{ margin: 0, fontSize: '13px', color: '#F0F0FF', fontWeight: 600 }}>{bankAccount.bank_name}</p>
                <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#8B8FA8' }}>{bankAccount.account_number} · {bankAccount.account_name}</p>
              </div>
            </div>
          )}

          {/* Transaction history */}
          <p style={{ fontSize: '13px', fontWeight: 700, color: '#8B8FA8', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '12px' }}>Transactions</p>
          {txns.length === 0 ? (
            <p style={{ color: '#8B8FA8', fontSize: '13px', textAlign: 'center', padding: '24px 0' }}>No transactions yet</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {txns.map(t => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px', borderRadius: '12px', background: 'rgba(255,255,255,0.03)' }}>
                  <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: t.type === 'credit' ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <span style={{ fontSize: '16px' }}>{t.type === 'credit' ? '↓' : '↑'}</span>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: 0, fontSize: '13px', color: '#F0F0FF', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.description || (t.type === 'credit' ? 'Credit' : 'Withdrawal')}</p>
                    <p style={{ margin: '2px 0 0', fontSize: '11px', color: '#8B8FA8' }}>{new Date(t.created_at).toLocaleDateString('en-NG', { dateStyle: 'medium' })}</p>
                  </div>
                  <span style={{ color: t.type === 'credit' ? '#10B981' : '#EF4444', fontWeight: 700, fontSize: '14px', flexShrink: 0 }}>
                    {t.type === 'credit' ? '+' : '-'}{fmt(t.amount_kobo)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Withdraw modal */}
      {showWithdraw && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 9000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div style={{ background: '#1a1f2e', borderRadius: '20px 20px 0 0', padding: '24px', width: '100%', maxWidth: '390px', paddingBottom: 'calc(24px + env(safe-area-inset-bottom))' }}>
            <p style={{ fontSize: '18px', fontWeight: 700, margin: '0 0 4px' }}>Withdraw Funds</p>
            <p style={{ fontSize: '13px', color: '#8B8FA8', margin: '0 0 20px' }}>Available: {fmt(balance)}</p>
            <input
              type="number"
              placeholder="Amount in ₦ (e.g. 5000)"
              value={withdrawAmount}
              onChange={e => setWithdrawAmount(e.target.value)}
              style={{ width: '100%', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '12px', padding: '14px', color: '#fff', fontSize: '16px', boxSizing: 'border-box', outline: 'none', marginBottom: '12px' }}
            />
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

      {/* Add/Edit bank modal */}
      {showAddBank && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 9000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div style={{ background: '#1a1f2e', borderRadius: '20px 20px 0 0', padding: '24px', width: '100%', maxWidth: '390px', paddingBottom: 'calc(24px + env(safe-area-inset-bottom))' }}>
            <p style={{ fontSize: '18px', fontWeight: 700, margin: '0 0 20px' }}>{bankAccount ? 'Update Bank Account' : 'Add Bank Account'}</p>
            {(['Bank Name', 'Account Number', 'Account Name'] as const).map((label, i) => {
              const vals = [bankName, accountNumber, accountName];
              const setters = [setBankName, setAccountNumber, setAccountName];
              return (
                <input
                  key={label}
                  placeholder={label}
                  value={vals[i]}
                  onChange={e => setters[i](e.target.value)}
                  style={{ width: '100%', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '12px', padding: '14px', color: '#fff', fontSize: '15px', boxSizing: 'border-box', outline: 'none', marginBottom: '10px' }}
                />
              );
            })}
            <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
              <button onClick={() => setShowAddBank(false)} style={{ flex: 1, background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: '12px', padding: '14px', color: '#8B8FA8', fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleSaveBank} disabled={savingBank} style={{ flex: 1, background: 'linear-gradient(135deg,#7C3AED,#A855F7)', border: 'none', borderRadius: '12px', padding: '14px', color: '#fff', fontWeight: 700, cursor: savingBank ? 'not-allowed' : 'pointer', opacity: savingBank ? 0.6 : 1 }}>
                {savingBank ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
