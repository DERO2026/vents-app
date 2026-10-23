// Audit Log — ported from the legacy AdminDashboardScreen.tsx 'logs' tab
// as part of its full retirement. Same table/query, same content.
import React, { useState, useEffect } from 'react';
import { Zap } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { adminTheme } from './adminConsoleTheme';

interface AuditRow {
  id: string;
  action: string;
  details: Record<string, any>;
  created_at: string;
  admin_id: string | null;
  target_user_id: string | null;
  actor_role: string | null;
}

export function AdminAuditLogScreen() {
  const [logs, setLogs] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from('admin_logs')
      .select('id, action, details, created_at, admin_id, target_user_id, actor_role')
      .order('created_at', { ascending: false })
      .limit(200)
      .then(
        ({ data, error: err }: any) => {
          // A failed fetch previously fell through to the same "No audit
          // entries yet." empty state as a genuinely clean log -- on the
          // one screen whose entire job is to be a trustworthy compliance
          // trail, that's indistinguishable from "nothing has happened"
          // when the real story is "the query failed and we don't know."
          if (err) { setError(err.message || 'Failed to load the audit log.'); setLoading(false); return; }
          setLogs(data || []); setLoading(false);
        },
        (e: any) => { setError(e?.message || 'Failed to load the audit log.'); setLoading(false); },
      );
  }, []);

  return (
    <div data-testid="admin-audit-log">
      {error && !loading && (
        <div style={{ background: 'rgba(248,113,113,.08)', border: '1px solid rgba(248,113,113,.25)', borderRadius: 12, padding: '14px 16px', marginBottom: 14, color: adminTheme.red, fontSize: 12.5 }}>
          Could not load the audit log: {error}
        </div>
      )}
      {loading ? (
        <div style={{ textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5, padding: 32 }}>Loading audit log…</div>
      ) : error ? null : logs.length === 0 ? (
        <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 32, textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5 }}>No audit entries yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {logs.map((log) => {
            const isRootAction = log.action.startsWith('ROOT_');
            const actionColor = isRootAction ? adminTheme.accentFrom : log.action.startsWith('delete') ? adminTheme.red : log.action.startsWith('suspend') ? adminTheme.amber : adminTheme.accentText;
            return (
              <div key={log.id} style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 14, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: actionColor, background: `${actionColor}18`, padding: '2px 8px', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
                    {isRootAction && <Zap size={10} />}
                    {log.action.replace(/_/g, ' ')}
                  </span>
                  <span style={{ color: adminTheme.textFaint, fontSize: 10 }}>{new Date(log.created_at).toLocaleString('en-NG', { dateStyle: 'short', timeStyle: 'short' })}</span>
                </div>
                {log.actor_role && (
                  <span style={{
                    alignSelf: 'flex-start', fontSize: 9, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
                    color: log.actor_role === 'root' ? adminTheme.accentFrom : log.actor_role === 'sub-admin' ? adminTheme.amber : adminTheme.red,
                    background: log.actor_role === 'root' ? adminTheme.accentSoftBg : log.actor_role === 'sub-admin' ? 'rgba(251,191,36,.12)' : 'rgba(248,113,113,.12)',
                    padding: '2px 6px', borderRadius: 4,
                  }}>
                    Executed by: {log.actor_role === 'root' ? 'Root' : log.actor_role === 'sub-admin' ? 'Sub-Admin' : log.actor_role === 'admin' ? 'Admin' : log.actor_role}
                  </span>
                )}
                {Object.keys(log.details || {}).length > 0 && (
                  <p style={{ color: adminTheme.textMuted, fontSize: 11, margin: 0, wordBreak: 'break-all' }}>
                    {Object.entries(log.details).map(([k, v]) => `${k}: ${v}`).join(' · ')}
                  </p>
                )}
                <p style={{ color: adminTheme.textFainter, fontSize: 10, margin: 0 }}>
                  Target: {log.target_user_id || '—'} · Admin: {log.admin_id ? `${log.admin_id.slice(0, 8)}…` : '—'}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
