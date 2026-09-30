// Verification queue — ported from the legacy AdminDashboardScreen.tsx
// 'verify' tab as part of its full retirement. Two sections: brand/CAC
// verification requests (organizer_verification_requests, a global cross-
// organizer queue distinct from the per-organizer KYC tab in
// AdminOrganizerDetail) and a quick "Unverified Organizers" queue.
// RECONCILED against 0121_organizer_capability_independent_of_role.sql:
// the "Reject" action here revokes the is_organizer capability directly
// (admin_set_organizer_capability), never touches role.
import React, { useState, useEffect, useCallback } from 'react';
import { ShieldCheck, BadgeCheck } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { adminTheme } from './adminConsoleTheme';
import { ConfirmModal } from './adminShared';
import { notifyByEmail } from './adminAuditLog';

interface VerifyStats { pendingCount: number; approvedToday: number; rejectedToday: number; avgReviewHours: number | null; totalVerified: number; }

export function AdminVerificationScreen() {
  const [section, setSection] = useState<'cac' | 'unverified'>('cac');
  const [stats, setStats] = useState<VerifyStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  const [statusFilter, setStatusFilter] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending');
  const [search, setSearch] = useState('');
  const [requests, setRequests] = useState<any[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [pendingOrgs, setPendingOrgs] = useState<any[]>([]);
  const [pendingOrgsLoading, setPendingOrgsLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectOrgConfirm, setRejectOrgConfirm] = useState<any | null>(null);

  const flash = (ok: boolean, m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3500); };

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const { data, error } = await supabase.rpc('admin_get_verification_stats' as any);
      if (error) throw error;
      const row = (data || [])[0] || {};
      setStats({
        pendingCount: Number(row.pending_count || 0),
        approvedToday: Number(row.approved_today || 0),
        rejectedToday: Number(row.rejected_today || 0),
        avgReviewHours: row.avg_review_hours != null ? Number(row.avg_review_hours) : null,
        totalVerified: Number(row.total_verified || 0),
      });
    } catch { setStats(null); } finally { setStatsLoading(false); }
  }, []);

  const loadRequests = useCallback(async () => {
    setRequestsLoading(true);
    try {
      const { data, error } = await supabase.rpc('admin_list_organizer_verifications' as any, {
        p_status: statusFilter, p_search: search || null, p_limit: 50, p_offset: 0,
      });
      if (error) throw error;
      setRequests(data || []);
    } catch { setRequests([]); } finally { setRequestsLoading(false); }
  }, [statusFilter, search]);

  const loadPendingOrgs = useCallback(async () => {
    setPendingOrgsLoading(true);
    const { data } = await supabase
      .from('users')
      .select('id, full_name, username, email, state, created_at, is_verified')
      .eq('is_organizer', true)
      .eq('is_verified', false)
      .order('created_at', { ascending: false })
      .limit(50);
    setPendingOrgs(data || []);
    setPendingOrgsLoading(false);
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadRequests(); }, [loadRequests]);
  useEffect(() => { loadPendingOrgs(); }, [loadPendingOrgs]);

  const handleApprove = async (requestId: string) => {
    setActionLoading(requestId);
    try {
      const { error } = await supabase.rpc('admin_approve_organizer_verification' as any, { p_request_id: requestId });
      if (error) throw error;
      flash(true, 'Brand verified ✓');
      await loadRequests(); loadStats();
      notifyByEmail('cac', requestId, 'approved');
    } catch (e: any) { flash(false, e?.message || 'Approve failed.'); }
    setExpandedId(null); setActionLoading(null);
  };

  const handleReject = async (requestId: string) => {
    const reason = rejectReason.trim();
    if (!reason) { flash(false, 'A rejection reason is required'); return; }
    setActionLoading(requestId);
    try {
      const { error } = await supabase.rpc('admin_reject_organizer_verification' as any, { p_request_id: requestId, p_reason: reason });
      if (error) throw error;
      flash(false, 'Verification rejected');
      await loadRequests(); loadStats();
      notifyByEmail('cac', requestId, 'rejected', reason);
    } catch (e: any) { flash(false, e?.message || 'Reject failed.'); }
    setExpandedId(null); setRejectingId(null); setRejectReason(''); setActionLoading(null);
  };

  const handlePreviewDocument = async (requestId: string, documentUrl: string) => {
    setPreviewLoadingId(requestId);
    try {
      const key = documentUrl.replace(/^verification-docs\//, '');
      const { data, error } = await supabase.storage.from('verification-docs').createSignedUrl(key, 60);
      if (error || !data?.signedUrl) throw new Error(error?.message || 'Could not load document');
      window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
    } catch (e: any) { flash(false, e.message || 'Could not open document'); } finally { setPreviewLoadingId(null); }
  };

  const verifyUser = async (u: any) => {
    setBusyId(u.id);
    try {
      const { error } = await supabase.rpc('admin_toggle_user_verified', { p_user_id: u.id, p_verified: true, p_reason: null });
      if (error) throw error;
      setPendingOrgs((prev) => prev.filter((x) => x.id !== u.id));
      flash(true, `@${u.username} verified ✓`);
    } catch (e: any) { flash(false, e?.message || 'Failed to verify.'); }
    setBusyId(null);
  };

  const rejectOrgCapability = async (u: any) => {
    setBusyId(u.id);
    try {
      const { error } = await supabase.rpc('admin_set_organizer_capability' as any, { p_user_id: u.id, p_enabled: false });
      if (error) throw error;
      setPendingOrgs((prev) => prev.filter((x) => x.id !== u.id));
      flash(false, `@${u.username}'s Organizer capability removed.`);
    } catch (e: any) { flash(false, e?.message || 'Failed to remove capability.'); }
    setBusyId(null); setRejectOrgConfirm(null);
  };

  return (
    <div data-testid="admin-verification" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {msg && <div style={{ fontSize: 12.5, color: adminTheme.text }}>{msg}</div>}
      {statsLoading && !stats ? (
        <div style={{ textAlign: 'center', color: adminTheme.textFaint, fontSize: 13, padding: 20 }}>Loading stats…</div>
      ) : stats ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
          {[
            { label: 'Pending Review', value: stats.pendingCount.toLocaleString(), color: adminTheme.amber },
            { label: 'Approved Today', value: stats.approvedToday.toLocaleString(), color: adminTheme.green },
            { label: 'Rejected Today', value: stats.rejectedToday.toLocaleString(), color: adminTheme.red },
            { label: 'Avg. Review Time', value: stats.avgReviewHours != null ? `${stats.avgReviewHours} hrs` : '—', color: adminTheme.accentText },
            { label: 'Total Verified', value: stats.totalVerified.toLocaleString(), color: adminTheme.green },
          ].map((c) => (
            <div key={c.label} style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 14, padding: 14 }}>
              <div style={{ color: adminTheme.textFaint, fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', marginBottom: 6 }}>{c.label}</div>
              <div style={{ color: c.color, fontSize: 20, fontWeight: 800 }}>{c.value}</div>
            </div>
          ))}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8 }}>
        {(['cac', 'unverified'] as const).map((s) => (
          <button key={s} onClick={() => setSection(s)} style={{ padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 12, background: section === s ? adminTheme.accentSoftBg : adminTheme.panel, color: section === s ? adminTheme.accentText : adminTheme.textMuted }}>
            {s === 'cac' ? 'Verification Requests' : 'Unverified Organizers'}
          </button>
        ))}
      </div>

      {section === 'cac' ? (
        <>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by business/organizer name, CAC/ID number, or email…" style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 10, padding: '10px 12px', color: adminTheme.text, fontSize: 13, outline: 'none' }} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(['pending', 'approved', 'rejected', 'all'] as const).map((s) => (
              <button key={s} onClick={() => setStatusFilter(s)} style={{ padding: '5px 12px', borderRadius: 7, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 11, textTransform: 'capitalize', background: statusFilter === s ? adminTheme.accentSoftBg : adminTheme.panelAlt, color: statusFilter === s ? adminTheme.accentText : adminTheme.textMuted }}>{s}</button>
            ))}
          </div>

          {requestsLoading ? (
            <div style={{ textAlign: 'center', color: adminTheme.textFaint, fontSize: 13, padding: 20 }}>Loading…</div>
          ) : requests.length === 0 ? (
            <div style={{ textAlign: 'center', color: adminTheme.textFaint, fontSize: 13, padding: 20 }}>No {statusFilter === 'all' ? '' : statusFilter + ' '}brand verification requests</div>
          ) : requests.map((r: any) => {
            const expanded = expandedId === r.request_id;
            const statusColor = r.status === 'pending' ? adminTheme.amber : r.status === 'approved' ? adminTheme.green : adminTheme.red;
            const isRejecting = rejectingId === r.request_id;
            return (
              <div key={r.request_id} style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 14, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div onClick={() => setExpandedId(expanded ? null : r.request_id)} style={{ display: 'flex', justifyContent: 'space-between', cursor: 'pointer' }}>
                  <div>
                    <div style={{ color: adminTheme.textStrong, fontSize: 14, fontWeight: 700 }}>{r.company_name || r.owner_name || r.full_name}</div>
                    <div style={{ color: adminTheme.textMuted, fontSize: 12 }}>{r.full_name || 'No Name'} · {r.state || 'No state'}</div>
                    <div style={{ color: adminTheme.textFainter, fontSize: 11 }}>{r.email}</div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                    <span style={{ fontSize: 10, color: statusColor, background: `${statusColor}1A`, padding: '2px 8px', borderRadius: 6, fontWeight: 600, textTransform: 'uppercase' }}>{r.status}</span>
                    <span style={{ fontSize: 9, color: adminTheme.textMuted, background: adminTheme.borderChip, padding: '2px 7px', borderRadius: 6, fontWeight: 600, textTransform: 'uppercase' }}>{r.organizer_type === 'individual' ? 'Individual' : 'Business'} · {r.country || 'NG'}</span>
                  </div>
                </div>
                <div style={{ color: adminTheme.textFainter, fontSize: 10 }}>Submitted {new Date(r.created_at).toLocaleDateString('en-NG', { dateStyle: 'medium' })}</div>

                {expanded && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: adminTheme.panelAlt, borderRadius: 10, padding: '8px 10px' }}>
                      <div style={{ width: 32, height: 32, borderRadius: '50%', background: adminTheme.accentSoftBg, display: 'flex', alignItems: 'center', justifyContent: 'center', color: adminTheme.accentText, fontSize: 13, fontWeight: 700 }}>
                        {(r.full_name || r.email || '?').charAt(0).toUpperCase()}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ color: adminTheme.textStrong, fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4 }}>
                          {r.full_name || 'No Name'} {r.is_verified && <ShieldCheck size={11} color={adminTheme.green} />}
                        </div>
                        <div style={{ color: adminTheme.textMuted, fontSize: 11 }}>{r.phone_number || 'No phone on file'}</div>
                      </div>
                    </div>
                    <div style={{ background: adminTheme.panelAlt, borderRadius: 10, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <p style={{ margin: 0, fontSize: 12, color: adminTheme.text }}><strong style={{ color: adminTheme.textMuted }}>{r.organizer_type === 'individual' ? 'Full Name' : 'Owner/Director'}:</strong> {r.owner_name || '—'}</p>
                      {r.organizer_type === 'individual' ? (
                        r.identity_id_type ? (
                          <p style={{ margin: 0, fontSize: 12, color: adminTheme.text }}><strong style={{ color: adminTheme.textMuted }}>{r.identity_id_type}:</strong> {r.identity_id_number || '—'}</p>
                        ) : (
                          <p style={{ margin: 0, fontSize: 12, color: adminTheme.textFainter }}>No structured ID requirement for {r.country || 'this country'} yet — see uploaded document.</p>
                        )
                      ) : (
                        <>
                          {r.cac_number && <p style={{ margin: 0, fontSize: 12, color: adminTheme.text }}><strong style={{ color: adminTheme.textMuted }}>CAC Number:</strong> {r.cac_number}</p>}
                          <p style={{ margin: 0, fontSize: 12, color: adminTheme.text }}><strong style={{ color: adminTheme.textMuted }}>Registration Date:</strong> {r.registration_date ? new Date(r.registration_date).toLocaleDateString('en-NG', { dateStyle: 'medium' }) : '—'}</p>
                          <p style={{ margin: 0, fontSize: 12, color: adminTheme.text }}><strong style={{ color: adminTheme.textMuted }}>Business Email:</strong> {r.business_email || '—'}</p>
                          <p style={{ margin: 0, fontSize: 12, color: adminTheme.text }}><strong style={{ color: adminTheme.textMuted }}>Business Phone:</strong> {r.business_phone || '—'}</p>
                          <p style={{ margin: 0, fontSize: 12, color: adminTheme.text }}><strong style={{ color: adminTheme.textMuted }}>Business Address:</strong> {r.business_address || '—'}</p>
                        </>
                      )}
                      {r.status !== 'pending' && r.admin_note && <p style={{ margin: 0, fontSize: 12, color: adminTheme.red }}><strong style={{ color: adminTheme.textMuted }}>Rejection Reason:</strong> {r.admin_note}</p>}
                      <button onClick={() => handlePreviewDocument(r.request_id, r.document_url)} disabled={previewLoadingId === r.request_id} style={{ alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0, color: adminTheme.accentFrom, fontSize: 12, fontWeight: 600, textDecoration: 'underline', cursor: previewLoadingId === r.request_id ? 'wait' : 'pointer' }}>
                        {previewLoadingId === r.request_id ? 'Opening…' : 'Preview uploaded CAC document ↗'}
                      </button>
                    </div>
                    {isRejecting && (
                      <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Reason for rejecting this request (shown to the organizer)…" rows={2} style={{ background: 'rgba(248,113,113,.06)', border: '1px solid rgba(248,113,113,.25)', borderRadius: 10, padding: '8px 10px', color: adminTheme.text, fontSize: 12, outline: 'none', resize: 'none' }} />
                    )}
                  </div>
                )}

                {r.status === 'pending' && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    {isRejecting ? (
                      <>
                        <button onClick={() => handleReject(r.request_id)} disabled={actionLoading === r.request_id || !rejectReason.trim()} style={{ flex: 1, background: 'rgba(248,113,113,.15)', border: '1px solid rgba(248,113,113,.3)', borderRadius: 10, padding: 8, color: adminTheme.red, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                          {actionLoading === r.request_id ? 'Rejecting…' : 'Confirm Rejection'}
                        </button>
                        <button onClick={() => { setRejectingId(null); setRejectReason(''); }} style={{ flex: 1, background: adminTheme.borderChip, border: `1px solid ${adminTheme.border}`, borderRadius: 10, padding: 8, color: adminTheme.textMuted, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => handleApprove(r.request_id)} disabled={actionLoading === r.request_id} style={{ flex: 1, background: 'rgba(52,211,153,.15)', border: '1px solid rgba(52,211,153,.3)', borderRadius: 10, padding: 8, color: adminTheme.green, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                          {actionLoading === r.request_id ? 'Processing…' : 'Approve & Verify Brand'}
                        </button>
                        <button onClick={() => { setExpandedId(r.request_id); setRejectingId(r.request_id); setRejectReason(''); }} disabled={actionLoading === r.request_id} style={{ flex: 1, background: 'rgba(248,113,113,.1)', border: '1px solid rgba(248,113,113,.2)', borderRadius: 10, padding: 8, color: adminTheme.red, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Reject Verification</button>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </>
      ) : pendingOrgsLoading ? (
        <div style={{ textAlign: 'center', color: adminTheme.textFaint, fontSize: 13, padding: 20 }}>Loading…</div>
      ) : pendingOrgs.length === 0 ? (
        <div style={{ textAlign: 'center', color: adminTheme.textFaint, fontSize: 13, padding: 20 }}>All organizers verified ✓</div>
      ) : pendingOrgs.map((u) => (
        <div key={u.id} style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 14, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div>
              <div style={{ color: adminTheme.textStrong, fontSize: 14, fontWeight: 700 }}>{u.full_name || 'No Name'}</div>
              <div style={{ color: adminTheme.textMuted, fontSize: 12 }}>@{u.username || 'no_username'} · {u.state || 'No state'}</div>
              <div style={{ color: adminTheme.textFainter, fontSize: 11 }}>{u.email}</div>
            </div>
            <span style={{ fontSize: 10, color: adminTheme.amber, background: 'rgba(251,191,36,.1)', padding: '2px 8px', borderRadius: 6, fontWeight: 600 }}>UNVERIFIED</span>
          </div>
          <div style={{ color: adminTheme.textFainter, fontSize: 10 }}>Joined {new Date(u.created_at).toLocaleDateString('en-NG', { dateStyle: 'medium' })}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button disabled={busyId === u.id} onClick={() => verifyUser(u)} style={{ flex: 1, background: 'rgba(96,165,250,.12)', border: '1px solid rgba(96,165,250,.3)', borderRadius: 10, padding: 8, color: adminTheme.blue, fontSize: 12, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <BadgeCheck size={13} /> Verify
            </button>
            <button disabled={busyId === u.id} onClick={() => setRejectOrgConfirm(u)} style={{ flex: 1, background: 'rgba(248,113,113,.1)', border: '1px solid rgba(248,113,113,.2)', borderRadius: 10, padding: 8, color: adminTheme.red, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Reject</button>
          </div>
        </div>
      ))}

      {rejectOrgConfirm && (
        <ConfirmModal
          title="Remove Organizer capability?"
          message={`This removes @${rejectOrgConfirm.username || rejectOrgConfirm.email}'s Organizer capability. Their account, staff tier, and Service Provider capability (if any) are unaffected.`}
          confirmLabel="Remove Organizer"
          danger
          onConfirm={() => rejectOrgCapability(rejectOrgConfirm)}
          onCancel={() => setRejectOrgConfirm(null)}
        />
      )}
    </div>
  );
}
