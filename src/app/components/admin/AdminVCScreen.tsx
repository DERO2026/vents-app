// VENTS Cents dashboard — ported from the legacy AdminDashboardScreen.tsx
// 'vc' tab as part of its full retirement. Adds one real fix: credit/debit
// now go through a confirmation dialog before executing (gap #3), matching
// every other destructive/consequential admin action in the new console.
import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../../lib/supabase';
import { adminTheme } from './adminConsoleTheme';
import { ConfirmModal } from './adminShared';
import { escapePostgrestOrValue } from '../../../lib/sanitize';

interface VcUser { id: string; full_name: string | null; username: string | null; email: string; avatar_url: string | null; }
interface VcCampaign {
  key: string; label: string; description: string | null; amount_vc: number;
  cap_per_user: number | null; cap_total: number | null; total_awarded: number;
  enabled: boolean; starts_at: string | null; ends_at: string | null;
}

export function AdminVCScreen() {
  const [aggregates, setAggregates] = useState({ circulation: 0, totalTxns: 0, credits: 0, debits: 0 });
  const [txns, setTxns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const [campaigns, setCampaigns] = useState<VcCampaign[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(true);
  const [editingCampaign, setEditingCampaign] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState('');
  const [editReason, setEditReason] = useState('');
  const [campaignBusy, setCampaignBusy] = useState(false);
  const [campaignMsg, setCampaignMsg] = useState<string | null>(null);
  const [confirmCampaignChange, setConfirmCampaignChange] = useState<{ key: string; enabled: boolean } | null>(null);

  const loadCampaigns = useCallback(() => {
    setCampaignsLoading(true);
    supabase.from('vc_reward_campaigns').select('*').order('key')
      .then(({ data }) => { setCampaigns((data as any) || []); setCampaignsLoading(false); }, () => setCampaignsLoading(false));
  }, []);

  useEffect(() => { loadCampaigns(); }, [loadCampaigns]);

  const toggleCampaignEnabled = async (key: string, nextEnabled: boolean) => {
    setCampaignBusy(true); setCampaignMsg(null);
    try {
      const { error } = await supabase.rpc('admin_update_vc_campaign' as any, {
        p_key: key, p_enabled: nextEnabled, p_reason: `${nextEnabled ? 'Enabled' : 'Disabled'} via Admin Console`,
      });
      if (error) throw error;
      setCampaignMsg(`✓ ${key} ${nextEnabled ? 'enabled' : 'disabled'}`);
      loadCampaigns();
    } catch (e: any) {
      setCampaignMsg(e?.message || 'Update failed.');
    } finally { setCampaignBusy(false); }
  };

  const saveCampaignAmount = async (key: string) => {
    const amount = Number(editAmount);
    if (!amount || amount <= 0 || !editReason.trim()) return;
    setCampaignBusy(true); setCampaignMsg(null);
    try {
      const { error } = await supabase.rpc('admin_update_vc_campaign' as any, {
        p_key: key, p_amount_vc: amount, p_reason: editReason.trim(),
      });
      if (error) throw error;
      setCampaignMsg(`✓ ${key} amount updated to ${amount} VC`);
      setEditingCampaign(null); setEditAmount(''); setEditReason('');
      loadCampaigns();
    } catch (e: any) {
      setCampaignMsg(e?.message || 'Update failed.');
    } finally { setCampaignBusy(false); }
  };

  const [search, setSearch] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<VcUser[]>([]);
  const [selectedUser, setSelectedUser] = useState<VcUser | null>(null);

  const [creditAmount, setCreditAmount] = useState('');
  const [creditReason, setCreditReason] = useState('');
  const [creditBusy, setCreditBusy] = useState(false);
  const [creditMsg, setCreditMsg] = useState<string | null>(null);
  const [confirmCredit, setConfirmCredit] = useState(false);

  const [debitAmount, setDebitAmount] = useState('');
  const [debitReason, setDebitReason] = useState('');
  const [debitBusy, setDebitBusy] = useState(false);
  const [debitMsg, setDebitMsg] = useState<string | null>(null);
  const [confirmDebit, setConfirmDebit] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    supabase.rpc('admin_get_vc_aggregates' as any).then(({ data }: any) => {
      const row = (data || [])[0] || {};
      setAggregates({
        circulation: Number(row.circulation || 0),
        totalTxns: Number(row.total_txns || 0),
        credits: Number(row.credits || 0),
        debits: Number(row.debits || 0),
      });
    });
    supabase.from('vc_transactions').select('id, user_id, amount, type, status, reference_id, created_at')
      .order('created_at', { ascending: false }).limit(100)
      .then(({ data }) => { setTxns(data || []); setLoading(false); }, () => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSearch = async () => {
    const q = search.trim();
    if (!q) return;
    setSearching(true);
    try {
      const like = escapePostgrestOrValue(`%${q}%`);
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      let query = supabase.from('users').select('id, full_name, username, email, avatar_url').or(`full_name.ilike.${like},username.ilike.${like},email.ilike.${like}`);
      if (uuidRe.test(q)) query = supabase.from('users').select('id, full_name, username, email, avatar_url').eq('id', q);
      const { data } = await query.limit(10);
      setSearchResults((data as any) || []);
    } finally { setSearching(false); }
  };

  const doCredit = async () => {
    if (!selectedUser || !creditAmount || Number(creditAmount) <= 0 || !creditReason.trim()) return;
    setCreditBusy(true); setCreditMsg(null);
    try {
      const { error } = await supabase.rpc('admin_credit_vents_cents' as any, { p_user_id: selectedUser.id, p_amount: Number(creditAmount), p_reason: creditReason.trim() });
      if (error) throw error;
      setCreditMsg(`✓ ${creditAmount} VC credited to ${selectedUser.username || selectedUser.full_name}`);
      setCreditAmount(''); setCreditReason('');
      load();
    } catch (e: any) {
      setCreditMsg(e?.message || 'Credit failed.');
    } finally { setCreditBusy(false); }
  };

  const doDebit = async () => {
    if (!selectedUser || !debitAmount || Number(debitAmount) <= 0 || !debitReason.trim()) return;
    setDebitBusy(true); setDebitMsg(null);
    try {
      const { error } = await supabase.rpc('admin_debit_vents_cents' as any, { p_user_id: selectedUser.id, p_amount: Number(debitAmount), p_reason: debitReason.trim() });
      if (error) throw error;
      setDebitMsg(`✓ ${debitAmount} VC debited from ${selectedUser.username || selectedUser.full_name}`);
      setDebitAmount(''); setDebitReason('');
      load();
    } catch (e: any) {
      setDebitMsg(e?.message || 'Debit failed.');
    } finally { setDebitBusy(false); }
  };

  const inputStyle: React.CSSProperties = { width: '100%', background: adminTheme.panelAlt, border: `1px solid ${adminTheme.border}`, borderRadius: 10, padding: '10px 12px', color: adminTheme.text, fontSize: 13, outline: 'none', boxSizing: 'border-box' };

  return (
    <div data-testid="admin-vc" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        {[
          { label: 'VC in Circulation', value: aggregates.circulation.toLocaleString() },
          { label: 'Total Transactions', value: aggregates.totalTxns.toLocaleString() },
          { label: 'Credits', value: aggregates.credits.toLocaleString() },
          { label: 'Debits', value: aggregates.debits.toLocaleString() },
        ].map((c) => (
          <div key={c.label} style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 14, padding: 16 }}>
            <div style={{ color: adminTheme.textFaint, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', marginBottom: 6 }}>{c.label}</div>
            <div style={{ color: adminTheme.textStrong, fontSize: 22, fontWeight: 800 }}>{loading ? '…' : c.value}</div>
          </div>
        ))}
      </div>

      <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 16, overflow: 'hidden' }}>
        <div style={{ padding: 14, borderBottom: `1px solid ${adminTheme.borderSoft}`, color: adminTheme.textStrong, fontSize: 13, fontWeight: 700 }}>Reward Campaigns</div>
        {campaignMsg && <div style={{ padding: '8px 14px', color: campaignMsg.startsWith('✓') ? adminTheme.green : adminTheme.red, fontSize: 12 }}>{campaignMsg}</div>}
        {campaignsLoading ? (
          <div style={{ padding: 24, textAlign: 'center', color: adminTheme.textFaint, fontSize: 13 }}>Loading…</div>
        ) : campaigns.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: adminTheme.textFaint, fontSize: 13 }}>No campaigns.</div>
        ) : (
          <div>
            {campaigns.map((c) => (
              <div key={c.key} style={{ padding: '12px 14px', borderBottom: `1px solid ${adminTheme.borderSoft}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ color: adminTheme.textStrong, fontSize: 13, fontWeight: 700 }}>{c.label} <span style={{ color: adminTheme.textFaint, fontWeight: 400 }}>({c.key})</span></div>
                    <div style={{ color: adminTheme.textMuted, fontSize: 11, marginTop: 2 }}>
                      {c.amount_vc} VC · cap/user: {c.cap_per_user ?? '∞'} · cap total: {c.cap_total ?? '∞'} · awarded: {c.total_awarded}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button
                      onClick={() => setEditingCampaign(editingCampaign === c.key ? null : c.key)}
                      style={{ background: adminTheme.panelAlt, border: `1px solid ${adminTheme.border}`, borderRadius: 8, padding: '6px 10px', color: adminTheme.text, fontSize: 12, cursor: 'pointer' }}
                    >
                      Edit amount
                    </button>
                    <button
                      onClick={() => setConfirmCampaignChange({ key: c.key, enabled: !c.enabled })}
                      disabled={campaignBusy}
                      style={{
                        background: c.enabled ? 'rgba(52,211,153,.12)' : 'rgba(248,113,113,.12)',
                        border: `1px solid ${c.enabled ? 'rgba(52,211,153,.3)' : 'rgba(248,113,113,.3)'}`,
                        borderRadius: 8, padding: '6px 10px',
                        color: c.enabled ? adminTheme.green : adminTheme.red,
                        fontSize: 12, fontWeight: 700, cursor: 'pointer',
                      }}
                    >
                      {c.enabled ? 'Enabled' : 'Disabled'}
                    </button>
                  </div>
                </div>
                {editingCampaign === c.key && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <input placeholder={`New amount (currently ${c.amount_vc})`} type="number" min="1" value={editAmount} onChange={(e) => setEditAmount(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
                    <input placeholder="Reason (required)" value={editReason} onChange={(e) => setEditReason(e.target.value)} style={{ ...inputStyle, flex: 2 }} />
                    <button onClick={() => saveCampaignAmount(c.key)} disabled={campaignBusy || !editAmount || !editReason.trim()} style={{ background: adminTheme.accentSoftBg, border: `1px solid ${adminTheme.accentSoftBorder}`, borderRadius: 8, padding: '0 14px', color: adminTheme.accentText, fontWeight: 600, cursor: 'pointer' }}>Save</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 16, overflow: 'hidden' }}>
        <div style={{ padding: 14, borderBottom: `1px solid ${adminTheme.borderSoft}`, color: adminTheme.textStrong, fontSize: 13, fontWeight: 700 }}>VC Transactions (last 100)</div>
        {loading ? (
          <div style={{ padding: 24, textAlign: 'center', color: adminTheme.textFaint, fontSize: 13 }}>Loading…</div>
        ) : txns.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: adminTheme.textFaint, fontSize: 13 }}>No transactions yet.</div>
        ) : (
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {txns.map((t) => (
              <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 14px', borderBottom: `1px solid ${adminTheme.borderSoft}` }}>
                <div>
                  <div style={{ color: adminTheme.text, fontSize: 12, fontWeight: 600 }}>{t.type.toUpperCase()} — {t.status}</div>
                  <div style={{ color: adminTheme.textMuted, fontSize: 11, marginTop: 2 }}>{t.user_id?.slice(0, 12)}… · {new Date(t.created_at).toLocaleDateString()}</div>
                </div>
                <div style={{ color: (t.type === 'earn' || t.type === 'referral') ? adminTheme.green : adminTheme.red, fontSize: 14, fontWeight: 700 }}>
                  {(t.type === 'earn' || t.type === 'referral') ? '+' : '-'}{Number(t.amount).toLocaleString()} VC
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 16, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ color: adminTheme.textStrong, fontSize: 13, fontWeight: 700 }}>Find a User</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleSearch()} placeholder="Search by name, @username, email, or UUID" style={{ ...inputStyle, flex: 1 }} />
          <button onClick={handleSearch} disabled={searching} style={{ background: adminTheme.accentSoftBg, border: `1px solid ${adminTheme.accentSoftBorder}`, borderRadius: 10, padding: '0 14px', color: adminTheme.accentText, fontWeight: 600, cursor: 'pointer' }}>{searching ? '…' : 'Find'}</button>
        </div>
        {searchResults.length > 0 && (
          <div style={{ border: `1px solid ${adminTheme.border}`, borderRadius: 10, maxHeight: 220, overflowY: 'auto' }}>
            {searchResults.map((u) => (
              <button key={u.id} onClick={() => { setSelectedUser(u); setSearchResults([]); setSearch(''); }} style={{ display: 'flex', width: '100%', padding: 10, background: 'none', border: 'none', borderBottom: `1px solid ${adminTheme.borderSoft}`, cursor: 'pointer', textAlign: 'left', color: adminTheme.text }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{u.full_name || u.username}</div>
                  <div style={{ fontSize: 11, color: adminTheme.textMuted }}>@{u.username} · {u.email}</div>
                </div>
              </button>
            ))}
          </div>
        )}
        {selectedUser && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(52,211,153,.08)', border: '1px solid rgba(52,211,153,.2)', borderRadius: 10, padding: '10px 12px' }}>
            <div>
              <div style={{ color: adminTheme.green, fontSize: 13, fontWeight: 700 }}>✓ {selectedUser.full_name || selectedUser.username}</div>
              <div style={{ color: adminTheme.textMuted, fontSize: 11 }}>{selectedUser.email}</div>
            </div>
            <button onClick={() => setSelectedUser(null)} style={{ background: 'none', border: 'none', color: adminTheme.textFaint, fontSize: 16, cursor: 'pointer' }}>×</button>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 16, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ color: adminTheme.textStrong, fontSize: 13, fontWeight: 700 }}>Admin Transfer (Credit)</div>
          <input placeholder="Amount (VC)" type="number" min="1" value={creditAmount} onChange={(e) => setCreditAmount(e.target.value)} style={inputStyle} />
          <input placeholder="Reason (required)" value={creditReason} onChange={(e) => setCreditReason(e.target.value)} style={inputStyle} />
          {creditMsg && <div style={{ color: creditMsg.startsWith('✓') ? adminTheme.green : adminTheme.red, fontSize: 12 }}>{creditMsg}</div>}
          <button onClick={() => setConfirmCredit(true)} disabled={creditBusy || !selectedUser || !creditAmount || !creditReason.trim()} style={{ background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', border: 'none', borderRadius: 12, padding: 12, color: '#fff', fontWeight: 700, cursor: 'pointer', opacity: (!selectedUser || !creditAmount || !creditReason.trim()) ? 0.5 : 1 }}>
            {creditBusy ? 'Crediting…' : 'Credit VC to User'}
          </button>
        </div>
        <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 16, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ color: adminTheme.textStrong, fontSize: 13, fontWeight: 700 }}>Admin Debit / Claw-back</div>
          <div style={{ color: adminTheme.textFaint, fontSize: 11 }}>Uses the user selected above. Fails if their balance is insufficient.</div>
          <input placeholder="Amount (VC)" type="number" min="1" value={debitAmount} onChange={(e) => setDebitAmount(e.target.value)} style={inputStyle} />
          <input placeholder="Reason (required)" value={debitReason} onChange={(e) => setDebitReason(e.target.value)} style={inputStyle} />
          {debitMsg && <div style={{ color: debitMsg.startsWith('✓') ? adminTheme.green : adminTheme.red, fontSize: 12 }}>{debitMsg}</div>}
          <button onClick={() => setConfirmDebit(true)} disabled={debitBusy || !selectedUser || !debitAmount || !debitReason.trim()} style={{ background: 'linear-gradient(135deg, #DC2626, #B91C1C)', border: 'none', borderRadius: 12, padding: 12, color: '#fff', fontWeight: 700, cursor: 'pointer', opacity: (!selectedUser || !debitAmount || !debitReason.trim()) ? 0.5 : 1 }}>
            {debitBusy ? 'Debiting…' : 'Debit VC from User'}
          </button>
        </div>
      </div>

      {confirmCredit && selectedUser && (
        <ConfirmModal
          title="Credit VENTS Cents?"
          message={`Credit ${creditAmount} VC to ${selectedUser.username || selectedUser.full_name}? Reason: "${creditReason.trim()}"`}
          confirmLabel="Credit"
          danger={false}
          onConfirm={() => { setConfirmCredit(false); doCredit(); }}
          onCancel={() => setConfirmCredit(false)}
        />
      )}
      {confirmCampaignChange && (
        <ConfirmModal
          title={`${confirmCampaignChange.enabled ? 'Enable' : 'Disable'} campaign?`}
          message={`${confirmCampaignChange.enabled ? 'Enable' : 'Disable'} the "${confirmCampaignChange.key}" reward campaign?`}
          confirmLabel={confirmCampaignChange.enabled ? 'Enable' : 'Disable'}
          danger={!confirmCampaignChange.enabled}
          onConfirm={() => { const target = confirmCampaignChange; setConfirmCampaignChange(null); if (target) toggleCampaignEnabled(target.key, target.enabled); }}
          onCancel={() => setConfirmCampaignChange(null)}
        />
      )}
      {confirmDebit && selectedUser && (
        <ConfirmModal
          title="Debit VENTS Cents?"
          message={`Debit ${debitAmount} VC from ${selectedUser.username || selectedUser.full_name}? Reason: "${debitReason.trim()}"`}
          confirmLabel="Debit"
          danger
          onConfirm={() => { setConfirmDebit(false); doDebit(); }}
          onCancel={() => setConfirmDebit(false)}
        />
      )}
    </div>
  );
}
