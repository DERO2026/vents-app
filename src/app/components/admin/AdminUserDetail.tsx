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
// Explicit "not available" sources (see report — no admin-accessible
// per-user backend exists for these today, so they are NOT fabricated):
//  - Wallet: `vents_wallets` RLS only allows a user to read their own row
//    (see migrations/20260713110000_admin-vc-aggregates-rpc.sql's own
//    comment on this exact limitation); no admin_get_user_wallet RPC exists.
//  - VC: same RLS story for `vc_transactions`; admin_get_vc_aggregates()
//    is platform-wide only, not per-user.
//  - Tickets: `tickets` RLS (select_tickets) only allows the ticket's owner
//    or the event's organizer to read it — no admin bypass and no admin
//    RPC to list a specific user's tickets exists.
//  - Reports: filed-by/against this specific user — no query exists that
//    both an admin can run and is scoped to one user's reports without a
//    dedicated RPC; left as "not available" rather than approximating.
import React, { useState, useEffect, useCallback } from 'react';
import { Shield } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { adminTheme, accentGradient } from './adminConsoleTheme';
import { isRoot as permIsRoot, isSuperAdmin as permIsSuperAdmin, type PermissionUser } from '../../../lib/permissions';
import { statusColors, verifColors, initials } from './AdminUsersList';
import { suspendOrUnban, toggleVerifyUser } from './adminUserEventActions';

interface FullUserRow {
  id: string; email: string; full_name: string | null; role: string; username: string | null;
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
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const loadUser = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const { data, error: err } = await supabase
        .from('users')
        .select('id, email, full_name, role, username, phone_number, state, status, is_verified, created_at, banned_until, deleted_at')
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
            {isRootUser && <span style={{ fontSize: 10, fontWeight: 700, color: '#A855F7', background: 'rgba(168,85,247,.12)', border: '1px solid rgba(168,85,247,.3)', padding: '3px 8px', borderRadius: 6 }}>ROOT</span>}
          </div>
        </div>
        {!locked && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button disabled={busy} onClick={() => run(() => toggleVerifyUser(isSuperAdmin, user.id, user.username || user.email, user.is_verified))}
              style={{ fontSize: 12, fontWeight: 600, padding: '9px 14px', borderRadius: 8, background: adminTheme.borderChip, border: `1px solid ${adminTheme.border}`, color: adminTheme.text, cursor: busy ? 'not-allowed' : 'pointer' }}>
              {user.is_verified ? 'Unverify' : 'Verify'}
            </button>
            {user.status === 'suspended' ? (
              <button disabled={busy} onClick={() => run(() => suspendOrUnban(isSuperAdmin, user.id, user.username || user.email, user.status, null))}
                style={{ fontSize: 12, fontWeight: 600, padding: '9px 14px', borderRadius: 8, background: 'rgba(52,211,153,.1)', border: '1px solid rgba(52,211,153,.3)', color: adminTheme.green, cursor: busy ? 'not-allowed' : 'pointer' }}>
                Reactivate
              </button>
            ) : (
              <button disabled={busy} onClick={() => run(() => suspendOrUnban(isSuperAdmin, user.id, user.username || user.email, user.status, 7))}
                style={{ fontSize: 12, fontWeight: 600, padding: '9px 14px', borderRadius: 8, background: 'rgba(248,113,113,.1)', border: '1px solid rgba(248,113,113,.3)', color: adminTheme.red, cursor: busy ? 'not-allowed' : 'pointer' }}>
                Suspend (7d)
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
            { label: 'ROLE', value: user.role },
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

      {tab === 'wallet' && <NotAvailable reason="no admin-accessible query or RPC exists for a specific user's VENTS Wallet — vents_wallets RLS only allows a user to read their own row, and no admin_get_user_wallet-style RPC exists." />}
      {tab === 'vc' && <NotAvailable reason="admin_get_vc_aggregates() only returns platform-wide totals, and vc_transactions RLS does not allow an admin to read another user's rows." />}
      {tab === 'tickets' && <NotAvailable reason="tickets RLS (select_tickets) only allows the ticket owner or the event's organizer to read it — there is no admin bypass or admin RPC to list a specific user's tickets." />}
      {tab === 'reports' && <NotAvailable reason="no RPC or admin-readable query scopes the reports table to one user's filed/received reports today." />}

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
    </div>
  );
}
