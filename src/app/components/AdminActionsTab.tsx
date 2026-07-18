// ── Admin Actions — Sub-Admin approval queue / notification center ───────────
// Super Admins: review every request (pending/approved/rejected), view full
// details, Approve (executes the underlying action server-side) or Reject with
// an optional reason, and mark notifications read. Sub-Admins: read-only view of
// their OWN request history (Pending / Approved / Rejected). Everything is
// backed by the tested maker-checker RPCs (request_/approve_/reject_admin_action,
// admin_list_action_requests, admin_pending_request_count, admin_mark_*_seen).

import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { insforge } from '../../lib/insforge';
import { CheckCircle2, XCircle, Clock, ChevronRight, Eye, Check, X, CheckCheck } from 'lucide-react';

type Status = 'pending' | 'approved' | 'rejected';

interface ActionRequest {
  id: string;
  action_type: string;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  payload: any;
  previous_values: any;
  requested_changes: any;
  requested_by: string;
  requested_by_name: string | null;
  requested_by_role: string | null;
  status: Status;
  reviewed_by: string | null;
  reviewed_by_name: string | null;
  review_reason: string | null;
  requested_at: string;
  reviewed_at: string | null;
  seen_at: string | null;
  device?: string | null;
}

// Human-readable label for an action type + its target.
function describe(r: ActionRequest): string {
  const who = r.requested_by_name || 'A Sub-Admin';
  const label = r.target_label || r.target_id?.slice(0, 8) || '';
  const map: Record<string, string> = {
    organizer_verification_approve: `${who} requested to APPROVE organizer verification`,
    organizer_verification_reject: `${who} requested to REJECT organizer verification`,
    hide_event: `${who} requested to hide event “${label}”`,
    reinstate_event: `${who} requested to unhide event “${label}”`,
    soft_delete_event: `${who} requested to delete event “${label}”`,
    restore_deleted_event: `${who} requested to restore event “${label}”`,
    set_user_role: `${who} requested to change role of ${label} → ${r.payload?.new_role || '?'}`,
    reject_payout: `${who} requested to reject a payout`,
    toggle_user_verified: `${who} requested to change verification of ${label}`,
    credit_vents_cents: `${who} requested to credit ${r.payload?.amount ?? '?'} VC to ${label}`,
  };
  return map[r.action_type] || `${who} requested: ${r.action_type} ${label}`;
}

const STATUS_META: Record<Status, { color: string; bg: string; icon: ReactNode; label: string }> = {
  pending: { color: '#F59E0B', bg: 'rgba(245,158,11,0.12)', icon: <Clock size={13} />, label: 'Pending' },
  approved: { color: '#10B981', bg: 'rgba(16,185,129,0.12)', icon: <CheckCircle2 size={13} />, label: 'Completed' },
  rejected: { color: '#EF4444', bg: 'rgba(239,68,68,0.12)', icon: <XCircle size={13} />, label: 'Rejected' },
};

export function AdminActionsTab({
  isSuperAdmin,
  flash,
  onCountChange,
}: {
  isSuperAdmin: boolean;
  flash: (ok: boolean, msg: string) => void;
  onCountChange?: () => void;
}) {
  const [filter, setFilter] = useState<Status | 'all'>(isSuperAdmin ? 'pending' : 'all');
  const [rows, setRows] = useState<ActionRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ActionRequest | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectFor, setRejectFor] = useState<ActionRequest | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await insforge.database.rpc('admin_list_action_requests' as any, {
        p_status: filter === 'all' ? null : filter,
      });
      if (error) throw error;
      setRows((data as ActionRequest[]) || []);
      // Mark the loaded pending items as seen (notification read) for admins.
      if (isSuperAdmin && filter === 'pending') {
        try { await insforge.database.rpc('admin_mark_all_requests_seen' as any, {}); } catch { /* ignore */ }
        onCountChange?.();
      }
    } catch (e: any) {
      flash(false, e?.message || 'Failed to load requests');
    } finally {
      setLoading(false);
    }
  }, [filter, isSuperAdmin, flash, onCountChange]);

  useEffect(() => { load(); }, [load]);

  const approve = async (r: ActionRequest) => {
    setBusyId(r.id);
    try {
      const { error } = await insforge.database.rpc('approve_admin_action' as any, { p_request_id: r.id });
      if (error) throw error;
      flash(true, 'Request approved — action executed.');
      setSelected(null);
      await load();
      onCountChange?.();
    } catch (e: any) {
      flash(false, e?.message || 'Approval failed');
    } finally {
      setBusyId(null);
    }
  };

  const doReject = async () => {
    if (!rejectFor) return;
    setBusyId(rejectFor.id);
    try {
      const { error } = await insforge.database.rpc('reject_admin_action' as any, {
        p_request_id: rejectFor.id,
        p_reason: rejectReason.trim() || null,
      });
      if (error) throw error;
      flash(true, 'Request rejected.');
      setRejectFor(null); setRejectReason(''); setSelected(null);
      await load();
      onCountChange?.();
    } catch (e: any) {
      flash(false, e?.message || 'Rejection failed');
    } finally {
      setBusyId(null);
    }
  };

  const filters: (Status | 'all')[] = isSuperAdmin ? ['pending', 'approved', 'rejected', 'all'] : ['all', 'pending', 'approved', 'rejected'];

  return (
    <div style={{ padding: '4px 16px 24px' }}>
      {!isSuperAdmin && (
        <p style={{ color: '#8B8FA8', fontSize: '12px', margin: '8px 0 12px', lineHeight: 1.5 }}>
          Your submitted requests await Super Admin approval. You'll see them here as Pending, then Completed or Rejected.
        </p>
      )}

      {/* Filter chips */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' }}>
        {filters.map((f) => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding: '6px 12px', borderRadius: '100px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
            background: filter === f ? 'rgba(167,139,250,0.16)' : 'rgba(255,255,255,0.03)',
            border: `1px solid ${filter === f ? 'rgba(167,139,250,0.4)' : 'rgba(255,255,255,0.08)'}`,
            color: filter === f ? '#A78BFA' : '#8B8FA8', textTransform: 'capitalize',
          }}>
            {f === 'approved' ? 'Completed' : f}
          </button>
        ))}
        {isSuperAdmin && (
          <button onClick={async () => { try { await insforge.database.rpc('admin_mark_all_requests_seen' as any, {}); } catch { /* ignore */ } onCountChange?.(); flash(true, 'All marked read.'); }}
            style={{ marginLeft: 'auto', padding: '6px 12px', borderRadius: '100px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: '#8B8FA8', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
            <CheckCheck size={13} /> Mark all read
          </button>
        )}
      </div>

      {loading ? (
        <div style={{ color: '#8B8FA8', textAlign: 'center', padding: '40px', fontSize: '13px' }}>Loading requests…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: '#8B8FA8', textAlign: 'center', padding: '40px', fontSize: '13px' }}>No {filter === 'all' ? '' : filter} requests.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {rows.map((r) => {
            const sm = STATUS_META[r.status];
            const unseen = r.status === 'pending' && !r.seen_at;
            return (
              <div key={r.id} style={{ background: '#090514', borderRadius: '14px', border: `1px solid ${unseen ? 'rgba(245,158,11,0.35)' : 'rgba(255,255,255,0.05)'}`, padding: '12px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 600, margin: 0, lineHeight: 1.4 }}>{describe(r)}</p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px', flexWrap: 'wrap' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '10.5px', fontWeight: 700, color: sm.color, background: sm.bg, borderRadius: '100px', padding: '2px 8px' }}>{sm.icon}{sm.label}</span>
                      <span style={{ color: '#555C7A', fontSize: '10.5px' }}>{new Date(r.requested_at).toLocaleString()}</span>
                      {r.requested_by_role && <span style={{ color: '#8B8FA8', fontSize: '10.5px' }}>by {r.requested_by_role}</span>}
                    </div>
                  </div>
                  <button onClick={() => setSelected(r)} aria-label="View details" style={{ background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.2)', borderRadius: '8px', padding: '6px', color: '#A78BFA', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '3px', fontSize: '11px', flexShrink: 0 }}>
                    <Eye size={13} /> Details <ChevronRight size={12} />
                  </button>
                </div>

                {isSuperAdmin && r.status === 'pending' && (
                  <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                    <button disabled={busyId === r.id} onClick={() => approve(r)} style={{ flex: 1, background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.4)', borderRadius: '10px', padding: '8px', color: '#10B981', fontSize: '12px', fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}>
                      <Check size={14} /> Approve
                    </button>
                    <button disabled={busyId === r.id} onClick={() => { setRejectFor(r); setRejectReason(''); }} style={{ flex: 1, background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: '10px', padding: '8px', color: '#EF4444', fontSize: '12px', fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}>
                      <X size={14} /> Reject
                    </button>
                  </div>
                )}

                {r.status === 'rejected' && r.review_reason && (
                  <p style={{ color: '#EF8A8A', fontSize: '11.5px', margin: '8px 0 0', background: 'rgba(239,68,68,0.06)', borderRadius: '8px', padding: '6px 10px' }}>Reason: {r.review_reason}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Detail modal */}
      {selected && (
        <div onClick={() => setSelected(null)} style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: '480px', maxHeight: '80vh', overflowY: 'auto', background: '#0A0616', borderRadius: '20px 20px 0 0', border: '1px solid rgba(255,255,255,0.08)', padding: '20px 18px calc(24px + env(safe-area-inset-bottom))' }}>
            <h3 style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 800, margin: '0 0 12px' }}>Request Details</h3>
            {([
              ['Request ID', selected.id],
              ['Action', selected.action_type],
              ['Target', `${selected.target_type || '-'} · ${selected.target_label || selected.target_id || '-'}`],
              ['Requested By', `${selected.requested_by_name || selected.requested_by} (${selected.requested_by_role || '-'})`],
              ['Requested At', new Date(selected.requested_at).toLocaleString()],
              ['Status', STATUS_META[selected.status].label],
              ...(selected.reviewed_by ? [['Reviewed By', `${selected.reviewed_by_name || selected.reviewed_by}`] as [string, string]] : []),
              ...(selected.reviewed_at ? [['Reviewed At', new Date(selected.reviewed_at).toLocaleString()] as [string, string]] : []),
              ...(selected.review_reason ? [['Reason', selected.review_reason] as [string, string]] : []),
              ...(selected.device ? [['Device', String(selected.device)] as any] : []),
            ] as [string, string][]).map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '7px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <span style={{ color: '#8B8FA8', fontSize: '12px', flexShrink: 0 }}>{k}</span>
                <span style={{ color: '#F0F0FF', fontSize: '12px', fontWeight: 600, textAlign: 'right', wordBreak: 'break-word' }}>{v}</span>
              </div>
            ))}
            {(selected.previous_values || selected.requested_changes) && (
              <div style={{ marginTop: '12px', display: 'flex', gap: '10px' }}>
                <div style={{ flex: 1 }}>
                  <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '0 0 4px', fontWeight: 700 }}>Previous</p>
                  <pre style={{ color: '#C4C9E0', fontSize: '10.5px', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', padding: '8px' }}>{JSON.stringify(selected.previous_values ?? {}, null, 1)}</pre>
                </div>
                <div style={{ flex: 1 }}>
                  <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '0 0 4px', fontWeight: 700 }}>Requested</p>
                  <pre style={{ color: '#C4C9E0', fontSize: '10.5px', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', padding: '8px' }}>{JSON.stringify(selected.requested_changes ?? selected.payload ?? {}, null, 1)}</pre>
                </div>
              </div>
            )}
            {isSuperAdmin && selected.status === 'pending' && (
              <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
                <button disabled={busyId === selected.id} onClick={() => approve(selected)} style={{ flex: 1, background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.4)', borderRadius: '12px', padding: '11px', color: '#10B981', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}>Approve & Execute</button>
                <button disabled={busyId === selected.id} onClick={() => { setRejectFor(selected); setRejectReason(''); }} style={{ flex: 1, background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: '12px', padding: '11px', color: '#EF4444', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}>Reject</button>
              </div>
            )}
            <button onClick={() => setSelected(null)} style={{ width: '100%', marginTop: '10px', background: 'none', border: 'none', color: '#8B8FA8', fontSize: '13px', cursor: 'pointer', padding: '8px' }}>Close</button>
          </div>
        </div>
      )}

      {/* Reject reason modal */}
      {rejectFor && (
        <div onClick={() => setRejectFor(null)} style={{ position: 'fixed', inset: 0, zIndex: 3100, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: '400px', background: '#0A0616', borderRadius: '18px', border: '1px solid rgba(255,255,255,0.08)', padding: '18px' }}>
            <h3 style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 800, margin: '0 0 10px' }}>Reject request</h3>
            <p style={{ color: '#8B8FA8', fontSize: '12px', margin: '0 0 10px' }}>Optional reason (shown to the Sub-Admin):</p>
            <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={3} placeholder="e.g. Not warranted — insufficient evidence" style={{ width: '100%', boxSizing: 'border-box', background: '#060A12', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', padding: '10px', color: '#F0F0FF', fontSize: '13px', outline: 'none', resize: 'vertical' }} />
            <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
              <button disabled={busyId === rejectFor.id} onClick={doReject} style={{ flex: 1, background: '#EF4444', border: 'none', borderRadius: '10px', padding: '10px', color: '#fff', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}>Confirm Reject</button>
              <button onClick={() => setRejectFor(null)} style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', padding: '10px', color: '#C4C9E0', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
