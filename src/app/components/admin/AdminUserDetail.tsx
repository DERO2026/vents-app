// Batch 2 — User Detail. Follows design-export's v_userDetail block
// (~219-326): header card + tab strip, tabs collapse to a single pane on
// mobile with back navigation (same master-detail-collapses convention the
// export uses elsewhere, and the same "← Back" pattern AdminConsoleShell's
// topbar already provides).
//
// Real data sources:
//  - Profile: the `users` row itself (admin-readable).
//  - Audit: `admin_logs` filtered by target_user_id — same table/pattern
//    AdminDashboardScreen's Audit Log tab and writeAuditLog() already use.
//  - Wallet: `user_wallets`/`user_wallet_transactions` both carry an
//    is_admin() SELECT policy — admin-readable directly.
//  - VC: `vc_transactions` carries an is_admin() SELECT policy; the balance
//    itself lives in `vents_wallets`, which gained the matching
//    admin-select policy in 0125 (it was the one table of the four missing
//    it — user_wallets/user_wallet_transactions/vc_transactions already had
//    theirs).
// Explicit "not available" sources (see report — no admin-accessible
// per-user backend exists for these today, so they are NOT fabricated):
//  - Tickets: `tickets` RLS (select_tickets) only allows the ticket's owner
//    or the event's organizer to read it — no admin bypass and no admin
//    RPC to list a specific user's tickets exists.
//  - Reports: `reports_admin_all` (is_admin()) already covers this —
//    queried directly, filtered client-side by reporter_id/target_id.
import React, { useState, useEffect, useCallback } from 'react';
import { Shield } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { adminTheme, accentGradient } from './adminConsoleTheme';
import { isRoot as permIsRoot, isSuperAdmin as permIsSuperAdmin, type PermissionUser } from '../../../lib/permissions';
import { statusColors, verifColors, initials, staffLabel } from './AdminUsersList';
import { suspendOrUnban, toggleVerifyUser, setOrganizerCapability, setServiceProviderCapability, softDeleteUser, reinstateUser, roleChange } from './adminUserEventActions';
import { ConfirmModal } from './adminShared';
import { PickerSheet } from '../shared/PickerSheet';

interface FullUserRow {
  id: string; email: string; full_name: string | null; role: string; is_organizer: boolean; is_service_provider: boolean; username: string | null;
  phone_number: string | null; state: string | null; status: string; is_verified: boolean;
  created_at: string; banned_until: string | null; deleted_at: string | null;
}

interface AuditRow { id: string; action: string; details: Record<string, any>; created_at: string; admin_id: string | null; actor_role: string | null; }

type Tab = 'profile' | 'wallet' | 'vc' | 'tickets' | 'reports' | 'audit';
const TABS: { key: Tab; label: string }[] = [
  { key: 'profile', label: 'Profile' },
  { key: 'wallet', label: 'Wallet' },
  { key: 'vc', label: 'VENTS Cents' },
  { key: 'tickets', label: 'Tickets' },
  { key: 'reports', label: 'Reports' },
  { key: 'audit', label: 'Audit' },
];

function NotAvailable({ reason }: { reason: string }) {
  return (
    <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 24, textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5 }}>
      Not available — {reason}
    </div>
  );
}

export function AdminUserDetail({ userId, currentUser, isMobile, onBack }: {
  userId: string; currentUser: PermissionUser | null | undefined; isMobile: boolean; onBack: () => void;
}) {
  const isRoot = permIsRoot(currentUser);
  const isSuperAdmin = permIsSuperAdmin(currentUser);
  const isSubAdmin = !isSuperAdmin;

  const [user, setUser] = useState<FullUserRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('profile');
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [walletBalanceKobo, setWalletBalanceKobo] = useState<number | null>(null);
  const [walletTxns, setWalletTxns] = useState<{ id: string; type: string; amount_kobo: number; description: string | null; created_at: string }[]>([]);
  const [walletLoading, setWalletLoading] = useState(false);
  const [vcBalance, setVcBalance] = useState<number | null>(null);
  const [vcTxns, setVcTxns] = useState<{ id: string; amount: number; type: string; status: string; created_at: string }[]>([]);
  const [vcLoading, setVcLoading] = useState(false);
  const [reports, setReports] = useState<{ id: string; reporter_id: string; target_type: string; target_id: string; reason: string; status: string; created_at: string }[]>([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [banPickerOpen, setBanPickerOpen] = useState(false);
  const [rolePickerOpen, setRolePickerOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ title: string; message: string; confirmLabel: string; danger: boolean; requireReason?: boolean; optionalReason?: boolean; onConfirm: (reason?: string) => void } | null>(null);

  const loadUser = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const { data, error: err } = await supabase
        .from('users')
        .select('id, email, full_name, role, is_organizer, is_service_provider, username, phone_number, state, status, is_verified, created_at, banned_until, deleted_at')
        .eq('id', userId)
        .maybeSingle();
      if (err) throw err;
      if (!data) throw new Error('User not found.');
      setUser(data);
    } catch (e: any) {
      setError(e?.message || 'Failed to load user.');
    } finally { setLoading(false); }
  }, [userId]);

  useEffect(() => { loadUser(); }, [loadUser]);

  useEffect(() => {
    if (tab !== 'audit') return;
    setAuditLoading(true);
    Promise.resolve(
      supabase.from('admin_logs').select('id, action, details, created_at, admin_id, actor_role')
        .eq('target_user_id', userId).order('created_at', { ascending: false }).limit(50),
    )
      .then(({ data }: any) => setAudit(data || []))
      .finally(() => setAuditLoading(false));
  }, [tab, userId]);

  useEffect(() => {
    if (tab !== 'wallet') return;
    setWalletLoading(true);
    Promise.all([
      supabase.from('user_wallets').select('balance_kobo').eq('user_id', userId).maybeSingle(),
      supabase.from('user_wallet_transactions').select('id, type, amount_kobo, description, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(20),
    ])
      .then(([w, txns]: any) => {
        setWalletBalanceKobo(w.data?.balance_kobo ?? 0);
        setWalletTxns(txns.data || []);
      })
      .finally(() => setWalletLoading(false));
  }, [tab, userId]);

  useEffect(() => {
    if (tab !== 'vc') return;
    setVcLoading(true);
    Promise.all([
      supabase.from('vents_wallets').select('balance').eq('user_id', userId).maybeSingle(),
      supabase.from('vc_transactions').select('id, amount, type, status, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(20),
    ])
      .then(([w, txns]: any) => {
        setVcBalance(w.data?.balance ?? 0);
        setVcTxns(txns.data || []);
      })
      .finally(() => setVcLoading(false));
  }, [tab, userId]);

  useEffect(() => {
    if (tab !== 'reports') return;
    setReportsLoading(true);
    Promise.resolve(
      supabase.from('reports').select('id, reporter_id, target_type, target_id, reason, status, created_at')
        .or(`reporter_id.eq.${userId},and(target_type.eq.user,target_id.eq.${userId})`)
        .order('created_at', { ascending: false }).limit(50),
    )
      .then(({ data }: any) => setReports(data || []))
      .finally(() => setReportsLoading(false));
  }, [tab, userId]);

  const flash = (ok: boolean, m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3500); };

  const run = async (fn: () => Promise<{ ok: boolean; message: string }>, refresh = true) => {
    setBusy(true);
    const res = await fn();
    flash(res.ok, res.message);
    if (res.ok && refresh) await loadUser();
    setBusy(false);
  };

  if (loading) return <div style={{ color: adminTheme.textFaint, fontSize: 12.5, padding: 32, textAlign: 'center' }}>Loading user…</div>;
  if (error || !user) return (
    <div>
      <div onClick={onBack} style={{ cursor: 'pointer', fontSize: 12.5, color: adminTheme.accentText, marginBottom: 14 }}>← Back to Users</div>
      <div style={{ color: adminTheme.red, fontSize: 12.5 }}>{error || 'User not found.'}</div>
    </div>
  );

  const isRootUser = permIsRoot(user);
  const st = statusColors(user.status);
  const vf = verifColors(user.is_verified);
  const locked = isRootUser || (isSubAdmin && ['admin', 'sub-admin'].includes(user.role));

  return (
    <div data-testid="admin-user-detail">
      <div onClick={onBack} style={{ cursor: 'pointer', fontSize: 12.5, color: adminTheme.accentText, marginBottom: 14 }}>← Back to Users</div>

      {msg && <div style={{ fontSize: 12.5, color: adminTheme.text, marginBottom: 10 }}>{msg}</div>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 16, background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 14, padding: isMobile ? 16 : '20px 22px', marginBottom: 18, flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
        <div style={{ width: 54, height: 54, borderRadius: '50%', background: accentGradient, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
          {initials(user.full_name, user.email)}
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: adminTheme.textStrong }}>{user.full_name || 'No name'}</div>
          <div style={{ fontSize: 12.5, color: adminTheme.textMuted, marginTop: 2 }}>{user.email} · {user.phone_number || 'no phone'} · {user.state || 'unknown state'}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6, background: st.bg, color: st.fg }}>{st.label}</span>
            <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6, background: vf.bg, color: vf.fg }}>{vf.label}</span>
            <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6, background: adminTheme.borderChip, color: adminTheme.textMuted }}>
              Joined {new Date(user.created_at).toLocaleDateString('en-NG', { dateStyle: 'medium' })}
            </span>
            {user.is_organizer && <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6, background: 'rgba(163,92,255,.16)', color: adminTheme.accentText }}>Organizer</span>}
            {user.is_service_provider && <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6, background: 'rgba(96,165,250,.14)', color: adminTheme.blue }}>Service Provider</span>}
            {isRootUser && <span style={{ fontSize: 10, fontWeight: 700, color: '#A855F7', background: 'rgba(168,85,247,.12)', border: '1px solid rgba(168,85,247,.3)', padding: '3px 8px', borderRadius: 6 }}>ROOT</span>}
          </div>
        </div>
        {!locked && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button disabled={busy} onClick={() => setConfirmAction({
              title: user.is_verified ? 'Remove verification?' : 'Verify this account?',
              message: user.is_verified ? `@${user.username || user.email} will lose their verified badge.` : `@${user.username || user.email} will be marked verified.`,
              confirmLabel: user.is_verified ? 'Unverify' : 'Verify', danger: user.is_verified,
              onConfirm: () => { setConfirmAction(null); run(() => toggleVerifyUser(isSuperAdmin, user.id, user.username || user.email, user.is_verified)); },
            })}
              style={{ fontSize: 12, fontWeight: 600, padding: '9px 14px', borderRadius: 8, background: adminTheme.borderChip, border: `1px solid ${adminTheme.border}`, color: adminTheme.text, cursor: busy ? 'not-allowed' : 'pointer' }}>
              {user.is_verified ? 'Unverify' : 'Verify'}
            </button>
            {!isRootUser && (isRoot || user.role === 'sub-admin') && (
              <button disabled={busy} onClick={() => setRolePickerOpen(true)}
                style={{ fontSize: 12, fontWeight: 600, padding: '9px 14px', borderRadius: 8, background: user.role === 'sub-admin' ? 'rgba(168,85,247,.14)' : adminTheme.borderChip, border: `1px solid ${user.role === 'sub-admin' ? 'rgba(168,85,247,.32)' : adminTheme.border}`, color: user.role === 'sub-admin' ? '#A855F7' : adminTheme.text, cursor: busy ? 'not-allowed' : 'pointer' }}>
                Staff Tier…
              </button>
            )}
            <button disabled={busy} onClick={() => setConfirmAction({
              title: user.is_organizer ? 'Remove Organizer capability?' : 'Grant Organizer capability?',
              message: user.is_organizer ? `@${user.username || user.email} loses the independent Organizer capability. Their account, staff tier, and Service Provider capability (if any) are unaffected.` : `@${user.username || user.email} will be granted the independent Organizer capability.`,
              confirmLabel: user.is_organizer ? 'Remove Organizer' : 'Grant Organizer', danger: user.is_organizer,
              onConfirm: () => { setConfirmAction(null); run(() => setOrganizerCapability(isSuperAdmin, user.id, user.username || user.email, user.is_organizer, !user.is_organizer)); },
            })}
              style={{ fontSize: 12, fontWeight: 600, padding: '9px 14px', borderRadius: 8, background: user.is_organizer ? 'rgba(163,92,255,.14)' : adminTheme.borderChip, border: `1px solid ${user.is_organizer ? 'rgba(163,92,255,.32)' : adminTheme.border}`, color: user.is_organizer ? adminTheme.accentText : adminTheme.text, cursor: busy ? 'not-allowed' : 'pointer' }}>
              {user.is_organizer ? 'Remove Organizer' : 'Grant Organizer'}
            </button>
            <button disabled={busy} onClick={() => setConfirmAction({
              title: user.is_service_provider ? 'Remove Service Provider capability?' : 'Grant Service Provider capability?',
              message: user.is_service_provider ? `@${user.username || user.email} loses the independent Service Provider capability. Their account, staff tier, and Organizer capability (if any) are unaffected.` : `@${user.username || user.email} will be granted the independent Service Provider capability.`,
              confirmLabel: user.is_service_provider ? 'Remove Provider' : 'Grant Provider', danger: user.is_service_provider,
              onConfirm: () => { setConfirmAction(null); run(() => setServiceProviderCapability(isSuperAdmin, user.id, user.username || user.email, user.is_service_provider, !user.is_service_provider)); },
            })}
              style={{ fontSize: 12, fontWeight: 600, padding: '9px 14px', borderRadius: 8, background: user.is_service_provider ? 'rgba(96,165,250,.14)' : adminTheme.borderChip, border: `1px solid ${user.is_service_provider ? 'rgba(96,165,250,.32)' : adminTheme.border}`, color: user.is_service_provider ? adminTheme.blue : adminTheme.text, cursor: busy ? 'not-allowed' : 'pointer' }}>
              {user.is_service_provider ? 'Remove Provider' : 'Grant Provider'}
            </button>
            {user.status === 'suspended' ? (
              <button disabled={busy} onClick={() => setConfirmAction({
                title: 'Reactivate this account?', message: `@${user.username || user.email} will regain normal access immediately.`,
                confirmLabel: 'Reactivate', danger: false,
                onConfirm: () => { setConfirmAction(null); run(() => suspendOrUnban(isSuperAdmin, user.id, user.username || user.email, user.status, null)); },
              })}
                style={{ fontSize: 12, fontWeight: 600, padding: '9px 14px', borderRadius: 8, background: 'rgba(52,211,153,.1)', border: '1px solid rgba(52,211,153,.3)', color: adminTheme.green, cursor: busy ? 'not-allowed' : 'pointer' }}>
                Reactivate
              </button>
            ) : user.status !== 'deleted' && (
              <button disabled={busy} onClick={() => setBanPickerOpen(true)}
                style={{ fontSize: 12, fontWeight: 600, padding: '9px 14px', borderRadius: 8, background: 'rgba(248,113,113,.1)', border: '1px solid rgba(248,113,113,.3)', color: adminTheme.red, cursor: busy ? 'not-allowed' : 'pointer' }}>
                Suspend…
              </button>
            )}
            {user.status === 'deleted' ? (
              <button disabled={busy} onClick={() => setConfirmAction({
                title: 'Reinstate this account?', message: `@${user.username || user.email} regains login and visibility immediately.`,
                confirmLabel: 'Reinstate', danger: false,
                onConfirm: () => { setConfirmAction(null); run(() => reinstateUser(isSuperAdmin, user.id, user.username || user.email, user.status)); },
              })}
                style={{ fontSize: 12, fontWeight: 600, padding: '9px 14px', borderRadius: 8, background: 'rgba(52,211,153,.1)', border: '1px solid rgba(52,211,153,.3)', color: adminTheme.green, cursor: busy ? 'not-allowed' : 'pointer' }}>
                Reinstate
              </button>
            ) : (
              <button disabled={busy} onClick={() => setConfirmAction({
                title: 'Delete this account?', message: `Soft-delete @${user.username || user.email}? They will be blocked from login. You can reinstate them later.`,
                confirmLabel: 'Delete', danger: true, optionalReason: true,
                onConfirm: (reason) => { setConfirmAction(null); run(() => softDeleteUser(isSuperAdmin, user.id, user.username || user.email, user.status, reason?.trim() || null)); },
              })}
                style={{ fontSize: 12, fontWeight: 600, padding: '9px 14px', borderRadius: 8, background: 'rgba(248,113,113,.08)', border: '1px solid rgba(248,113,113,.2)', color: adminTheme.red, cursor: busy ? 'not-allowed' : 'pointer' }}>
                Delete
              </button>
            )}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${adminTheme.borderSoft}`, marginBottom: 18, overflowX: 'auto', whiteSpace: 'nowrap' }}>
        {TABS.map((t) => (
          <div key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '10px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', flexShrink: 0,
            color: tab === t.key ? adminTheme.text : adminTheme.textFaint,
            borderBottom: tab === t.key ? `2px solid ${adminTheme.accentFrom}` : '2px solid transparent',
          }}>{t.label}</div>
        ))}
      </div>

      {tab === 'profile' && (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: 14 }}>
          {[
            { label: 'ADMINISTRATIVE ACCESS', value: staffLabel(user.role) },
            { label: 'CAPABILITIES', value: [user.is_organizer && 'Organizer', user.is_service_provider && 'Service Provider'].filter(Boolean).join(', ') || 'None' },
            { label: 'USERNAME', value: user.username ? `@${user.username}` : '—' },
            { label: 'BANNED UNTIL', value: user.banned_until ? new Date(user.banned_until).toLocaleDateString('en-NG') : (user.status === 'suspended' ? 'Permanent' : '—') },
            { label: 'USER ID', value: user.id.slice(0, 8) + '…' },
          ].map((s) => (
            <div key={s.label} style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 11, color: adminTheme.textFainter, fontWeight: 600, marginBottom: 8 }}>{s.label}</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: adminTheme.textStrong, wordBreak: 'break-word' }}>{s.value}</div>
            </div>
          ))}
          {locked && (
            <div style={{ gridColumn: '1 / -1', fontSize: 11.5, color: adminTheme.textFaint, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Shield size={12} /> {isRootUser ? 'Root account — protected from all admin actions.' : 'Admin/Sub-Admin account — Super Admin only.'}
            </div>
          )}
        </div>
      )}

      {tab === 'wallet' && (
        walletLoading ? <div style={{ color: adminTheme.textFaint, fontSize: 12.5, padding: 24, textAlign: 'center' }}>Loading…</div> : (
          <div>
            <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 16, marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: adminTheme.textFainter, fontWeight: 600, marginBottom: 8 }}>VENTS WALLET BALANCE</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: adminTheme.textStrong }}>₦{((walletBalanceKobo ?? 0) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</div>
            </div>
            {walletTxns.length === 0 ? <NotAvailable reason="no wallet transactions yet." /> : walletTxns.map((t) => (
              <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: `1px solid ${adminTheme.borderSoft}` }}>
                <div>
                  <div style={{ fontSize: 13, color: adminTheme.text, fontWeight: 600 }}>{t.description || t.type}</div>
                  <div style={{ fontSize: 11, color: adminTheme.textFainter }}>{new Date(t.created_at).toLocaleString('en-NG')}</div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, color: ['deposit', 'refund'].includes(t.type) ? adminTheme.green : adminTheme.text }}>
                  {['deposit', 'refund'].includes(t.type) ? '+' : '-'}₦{(t.amount_kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}
                </div>
              </div>
            ))}
          </div>
        )
      )}
      {tab === 'vc' && (
        vcLoading ? <div style={{ color: adminTheme.textFaint, fontSize: 12.5, padding: 24, textAlign: 'center' }}>Loading…</div> : (
          <div>
            <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 16, marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: adminTheme.textFainter, fontWeight: 600, marginBottom: 8 }}>VENTS CENTS BALANCE</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: adminTheme.textStrong }}>{(vcBalance ?? 0).toLocaleString('en-NG')} VC</div>
            </div>
            {vcTxns.length === 0 ? <NotAvailable reason="no VENTS Cents transactions yet." /> : vcTxns.map((t) => (
              <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: `1px solid ${adminTheme.borderSoft}` }}>
                <div>
                  <div style={{ fontSize: 13, color: adminTheme.text, fontWeight: 600, textTransform: 'capitalize' }}>{t.type}</div>
                  <div style={{ fontSize: 11, color: adminTheme.textFainter }}>{new Date(t.created_at).toLocaleString('en-NG')} · {t.status}</div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, color: t.amount >= 0 ? adminTheme.green : adminTheme.red }}>{t.amount >= 0 ? '+' : ''}{t.amount} VC</div>
              </div>
            ))}
          </div>
        )
      )}
      {tab === 'tickets' && <NotAvailable reason="tickets RLS (select_tickets) only allows the ticket owner or the event's organizer to read it — there is no admin bypass or admin RPC to list a specific user's tickets." />}
      {tab === 'reports' && (
        reportsLoading ? <div style={{ color: adminTheme.textFaint, fontSize: 12.5, padding: 24, textAlign: 'center' }}>Loading…</div> :
        reports.length === 0 ? <NotAvailable reason="no reports filed by or against this user." /> : reports.map((r) => (
          <div key={r.id} style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 14, marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: adminTheme.text }}>
                {r.reporter_id === userId ? 'Filed by this user' : `Filed against this user (${r.target_type})`}
              </span>
              <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 8, color: adminTheme.textMuted }}>{r.status}</span>
            </div>
            <div style={{ fontSize: 13, color: adminTheme.text, marginBottom: 4 }}>{r.reason}</div>
            <div style={{ fontSize: 11, color: adminTheme.textFainter }}>{new Date(r.created_at).toLocaleString('en-NG')}</div>
          </div>
        ))
      )}

      {tab === 'audit' && (
        auditLoading ? (
          <div style={{ color: adminTheme.textFaint, fontSize: 12.5, textAlign: 'center', padding: 24 }}>Loading audit trail…</div>
        ) : audit.length === 0 ? (
          <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 24, textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5 }}>No admin actions recorded for this user.</div>
        ) : (
          <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, overflow: 'hidden' }}>
            {audit.map((a) => (
              <div key={a.id} style={{ display: 'flex', gap: 12, padding: '13px 16px', borderBottom: `1px solid ${adminTheme.borderSoft}`, fontSize: 12.5, flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
                <div style={{ color: adminTheme.textFaint, width: isMobile ? '100%' : 130, flexShrink: 0 }}>{new Date(a.created_at).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}</div>
                <div style={{ color: adminTheme.text, flex: 1 }}>{a.action.replace(/_/g, ' ')}</div>
                <div style={{ color: adminTheme.textMuted }}>{a.actor_role || '—'}</div>
              </div>
            ))}
          </div>
        )
      )}

      {banPickerOpen && (
        <PickerSheet
          title="Suspend User"
          searchable={false}
          options={[
            { value: '1', label: '1 day' },
            { value: '7', label: '7 days' },
            { value: '30', label: '30 days' },
            { value: 'permanent', label: 'Permanent' },
          ]}
          value=""
          onSelect={(v) => {
            setBanPickerOpen(false);
            const days = v === 'permanent' ? null : Number(v);
            setConfirmAction({
              title: 'Suspend this account?',
              message: `@${user.username || user.email} will be suspended ${v === 'permanent' ? 'permanently' : `for ${v} day(s)`}.`,
              confirmLabel: 'Suspend', danger: true,
              onConfirm: () => { setConfirmAction(null); run(() => suspendOrUnban(isSuperAdmin, user.id, user.username || user.email, user.status, days)); },
            });
          }}
          onClose={() => setBanPickerOpen(false)}
        />
      )}

      {rolePickerOpen && (
        <PickerSheet
          title="Staff Tier"
          searchable={false}
          options={[
            ...(user.role !== 'user' ? [{ value: 'user', label: 'User (no admin access)' }] : []),
            ...(isRoot && user.role !== 'sub-admin' ? [{ value: 'sub-admin', label: 'Sub-Admin' }] : []),
          ]}
          value=""
          onSelect={(newRole) => {
            setRolePickerOpen(false);
            const label = newRole === 'sub-admin' ? 'Sub-Admin' : 'User';
            setConfirmAction({
              title: `Set staff tier to ${label}?`,
              message: newRole === 'sub-admin'
                ? `@${user.username || user.email} will gain Sub-Admin access (maker-checker: their actions require Super Admin approval). This does not affect their Organizer/Service Provider capabilities.`
                : `@${user.username || user.email} will lose all administrative access. This does not affect their Organizer/Service Provider capabilities.`,
              confirmLabel: 'Confirm', danger: newRole === 'user' && user.role !== 'user',
              onConfirm: () => { setConfirmAction(null); run(() => roleChange(isSuperAdmin, user.id, user.role, newRole, user.username || user.email)); },
            });
          }}
          onClose={() => setRolePickerOpen(false)}
        />
      )}

      {confirmAction && (
        <ConfirmModal
          title={confirmAction.title}
          message={confirmAction.message}
          confirmLabel={confirmAction.confirmLabel}
          danger={confirmAction.danger}
          requireReason={confirmAction.requireReason}
          optionalReason={confirmAction.optionalReason}
          onConfirm={confirmAction.onConfirm}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </div>
  );
}
