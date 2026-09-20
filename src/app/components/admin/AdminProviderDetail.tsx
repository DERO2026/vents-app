// Batch 3 — Provider Detail. Follows design-export's v_providerDetail block
// (~602-668, 5 tabs: Overview/Services/Bookings/Earnings/Audit).
//
// Real data sources:
//  - Profile/listing: `service_providers` row (id, user_id, business_name,
//    category, country, status, created_at, updated_at) — same columns the
//    existing services-admin tab reads.
//  - Owner account: `users` row for the listing's user_id.
//  - Rating: service_provider_ratings via withProviderRatings() in
//    src/lib/serviceProviders.ts (0057_provider_rating_aggregate.sql) — a
//    real per-provider aggregate, not fabricated; shows "No reviews yet"
//    when reviewCount is 0/null rather than inventing a number.
//  - Services: provider_services via fetchOwnServicesForProvider (same
//    helper + provider_services_admin_select RLS the existing services-admin
//    tab's provider drill-in already uses).
//  - KYC/application status: `service_provider_requests` filtered by this
//    provider's user_id (service_provider_requests_admin_select, is_admin()
//    gated, 0033/0044) — the provider's application to BECOME a service
//    provider, decided by admin_decide_service_provider_request (0044).
//    This is a DIFFERENT admin action than the listing's draft/approved/
//    rejected `status` field: the request grants/denies the
//    is_service_provider capability itself, while service_providers.status
//    is the listing's own publish state (provider-managed, no separate admin
//    approval RPC exists for it — so no button is shown for it here).
//  - Audit: `admin_logs` filtered on target_user_id = this provider's owner
//    (service_provider_request_decision writes admin_logs with
//    target_user_id, per admin_decide_service_provider_request).
//
// Permission/maker-checker note (security-hardening follow-up,
// 0082_service_provider_kyc_maker_checker.sql):
// admin_decide_service_provider_request is SECURITY DEFINER, gated by
// is_super_admin() (Root + Admin ONLY — Sub-Admin excluded). A Sub-Admin's
// decision now routes through the SAME generic maker-checker machinery as
// organizer verification (request_admin_action / approve_admin_action /
// reject_admin_action) via the shared submitOrExecute() helper, using the
// new service_provider_kyc_approve / service_provider_kyc_reject action
// types — approve_admin_action re-derives and executes the decision
// server-side from the stored request payload, never from anything the
// approving admin's client sends beyond the request id.
import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../../lib/supabase';
import { adminTheme } from './adminConsoleTheme';
import { withProviderRatings } from '../../../lib/serviceProviders';
import { fetchOwnServicesForProvider } from '../../../lib/providerServices';
import type { ServiceProvider, ProviderService } from '../types';
import { providerStatusColors } from './AdminProvidersList';
import { submitOrExecute } from './adminUserEventActions';

interface OwnerRow { id: string; username: string | null; full_name: string | null; email: string; }
interface ProviderRequestRow {
  id: string; status: string; provider_type: string | null; business_name: string | null;
  country: string | null; document_url: string | null; admin_note: string | null;
  reviewed_at: string | null; created_at: string;
}
interface AuditRow { id: string; action: string; details: Record<string, any>; created_at: string; actor_role: string | null; }

type Tab = 'overview' | 'services' | 'bookings' | 'earnings' | 'audit';
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'services', label: 'Services' },
  { key: 'bookings', label: 'Bookings' },
  { key: 'earnings', label: 'Earnings' },
  { key: 'audit', label: 'Audit' },
];

function NotAvailable({ reason }: { reason: string }) {
  return (
    <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 24, textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5 }}>
      Not available — {reason}
    </div>
  );
}

export function AdminProviderDetail({ providerId, isSuperAdmin, isMobile, onBack }: {
  providerId: string; isSuperAdmin: boolean; isMobile: boolean; onBack: () => void;
}) {
  const [provider, setProvider] = useState<(ServiceProvider & { id: string }) | null>(null);
  const [owner, setOwner] = useState<OwnerRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');

  const [request, setRequest] = useState<ProviderRequestRow | null>(null);
  const [requestLoading, setRequestLoading] = useState(false);
  const [requestFetched, setRequestFetched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectBox, setShowRejectBox] = useState(false);

  const [services, setServices] = useState<ProviderService[] | null>(null);
  const [servicesLoading, setServicesLoading] = useState(false);
  const [servicesError, setServicesError] = useState<string | null>(null);

  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  const flash = (ok: boolean, m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3500); };

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const { data, error: err } = await supabase
        .from('service_providers')
        .select('id, user_id, business_name, category, country, status, created_at, updated_at')
        .eq('id', providerId)
        .maybeSingle();
      if (err) throw err;
      if (!data) throw new Error('Service provider not found.');

      const [rated] = await withProviderRatings([{
        id: data.id, userId: data.user_id, businessName: data.business_name, category: data.category,
        country: data.country, photoUrls: [], servicesOffered: [], offersHomeService: false,
        offersDelivery: false, offersSameDay: false, status: data.status, createdAt: data.created_at,
        updatedAt: data.updated_at,
      } as ServiceProvider]);
      setProvider({ ...(rated as ServiceProvider), id: data.id });

      const { data: ownerRow } = await supabase.from('users').select('id, username, full_name, email').eq('id', data.user_id).maybeSingle();
      setOwner(ownerRow || null);
    } catch (e: any) {
      setError(e?.message || 'Failed to load this service provider.');
    } finally { setLoading(false); }
  }, [providerId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (tab !== 'overview' || !provider?.userId || requestFetched) return;
    setRequestLoading(true);
    Promise.resolve(
      supabase
        .from('service_provider_requests')
        .select('id, status, provider_type, business_name, country, document_url, admin_note, reviewed_at, created_at')
        .eq('user_id', provider.userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    )
      .then(({ data }: any) => setRequest(data || null))
      .finally(() => { setRequestLoading(false); setRequestFetched(true); });
  }, [tab, provider?.userId, requestFetched]);

  useEffect(() => {
    if (!providerId) { setServices(null); return; }
    if (tab !== 'services') return;
    setServicesLoading(true); setServicesError(null);
    fetchOwnServicesForProvider(providerId)
      .then((rows) => setServices(rows))
      .catch((e: any) => setServicesError(e?.message || 'Failed to load services for this provider.'))
      .finally(() => setServicesLoading(false));
  }, [tab, providerId]);

  useEffect(() => {
    if (tab !== 'audit' || !provider?.userId) return;
    setAuditLoading(true);
    Promise.resolve(
      supabase.from('admin_logs').select('id, action, details, created_at, actor_role')
        .eq('target_user_id', provider.userId)
        .eq('action', 'service_provider_request_decision')
        .order('created_at', { ascending: false }).limit(50),
    )
      .then(({ data }: any) => setAudit(data || []))
      .finally(() => setAuditLoading(false));
  }, [tab, provider?.userId]);

  const decide = async (status: 'approved' | 'rejected') => {
    if (!request) return;
    if (status === 'rejected' && !rejectReason.trim()) { flash(false, 'A rejection reason is required.'); return; }
    setBusy(true);
    const actionType = status === 'approved' ? 'service_provider_kyc_approve' : 'service_provider_kyc_reject';
    const adminNote = status === 'rejected' ? rejectReason.trim() : null;
    const res = await submitOrExecute(isSuperAdmin, actionType,
      { target_type: 'service_provider_request', target_id: request.id, target_label: provider?.businessName || request.business_name || 'Service provider application', payload: { request_id: request.id, reason: adminNote } },
      async () => {
        const { error: err } = await supabase.rpc('admin_decide_service_provider_request' as any, {
          p_request_id: request.id, p_status: status, p_admin_note: adminNote,
        });
        if (err) throw new Error(err.message);
      });
    flash(res.ok, res.message);
    if (res.ok && isSuperAdmin) {
      setRequest({ ...request, status, admin_note: adminNote ?? request.admin_note });
    }
    setShowRejectBox(false);
    setRejectReason('');
    setBusy(false);
  };

  if (loading) return <div style={{ color: adminTheme.textFaint, fontSize: 12.5, padding: 32, textAlign: 'center' }}>Loading service provider…</div>;
  if (error || !provider) return (
    <div>
      <div onClick={onBack} style={{ cursor: 'pointer', fontSize: 12.5, color: adminTheme.accentText, marginBottom: 14 }}>← Back to Service Providers</div>
      <div style={{ color: adminTheme.red, fontSize: 12.5 }}>{error || 'Service provider not found.'}</div>
    </div>
  );

  const st = providerStatusColors(provider.status);
  const ratingLabel = provider.reviewCount ? `★ ${(provider.avgRating || 0).toFixed(1)} (${provider.reviewCount} reviews)` : 'No reviews yet';

  return (
    <div data-testid="admin-provider-detail">
      <div onClick={onBack} style={{ cursor: 'pointer', fontSize: 12.5, color: adminTheme.accentText, marginBottom: 14 }}>← Back to Service Providers</div>
      {msg && <div style={{ fontSize: 12.5, color: adminTheme.text, marginBottom: 10 }}>{msg}</div>}

      <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 14, padding: isMobile ? 16 : '20px 22px', marginBottom: 18 }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: adminTheme.textStrong }}>{provider.businessName}</div>
        <div style={{ fontSize: 12.5, color: adminTheme.textMuted, marginTop: 4 }}>
          {provider.category} · {provider.country || 'Unknown country'} · {ratingLabel}
        </div>
        <div style={{ fontSize: 12, color: adminTheme.textFaint, marginTop: 2 }}>
          Owner: {owner?.username ? `@${owner.username}` : owner?.email || 'Unknown'}
        </div>
        <span style={{ display: 'inline-block', marginTop: 8, fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6, background: st.bg, color: st.fg }}>{st.label}</span>
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

      {tab === 'overview' && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: 14, marginBottom: 18 }}>
            {[
              { label: 'CATEGORY', value: provider.category },
              { label: 'COUNTRY', value: provider.country || '—' },
              { label: 'LISTING STATUS', value: st.label },
              { label: 'RATING', value: ratingLabel },
            ].map((s) => (
              <div key={s.label} style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 11, color: adminTheme.textFainter, fontWeight: 600, marginBottom: 8 }}>{s.label}</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: adminTheme.textStrong, wordBreak: 'break-word' }}>{s.value}</div>
              </div>
            ))}
          </div>

          <div style={{ fontSize: 13, fontWeight: 700, color: adminTheme.textStrong, marginBottom: 10 }}>Provider Application (KYC)</div>
          {requestLoading ? (
            <div style={{ color: adminTheme.textFaint, fontSize: 12.5, padding: 12 }}>Loading application status…</div>
          ) : !request ? (
            <NotAvailable reason="no service_provider_requests row exists for this owner — they were granted the capability another way (e.g. admin_set_service_provider_capability), not through the application flow." />
          ) : (
            <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 12.5, color: adminTheme.text, marginBottom: 8 }}>
                Status: <strong style={{ textTransform: 'capitalize' }}>{request.status}</strong>
                {request.reviewed_at && ` · reviewed ${new Date(request.reviewed_at).toLocaleDateString('en-NG', { dateStyle: 'medium' })}`}
              </div>
              {request.admin_note && <div style={{ fontSize: 12, color: adminTheme.textMuted, marginBottom: 8 }}>Note: {request.admin_note}</div>}
              {request.document_url && (
                <div style={{ fontSize: 12, color: adminTheme.textFaint, marginBottom: 8 }}>Document on file: {request.document_url}</div>
              )}
              {request.status === 'pending' && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                  <button disabled={busy} onClick={() => decide('approved')}
                    style={{ fontSize: 12, fontWeight: 600, padding: '9px 14px', borderRadius: 8, background: 'rgba(52,211,153,.1)', border: '1px solid rgba(52,211,153,.3)', color: adminTheme.green, cursor: busy ? 'not-allowed' : 'pointer' }}>
                    Approve
                  </button>
                  {!showRejectBox ? (
                    <button disabled={busy} onClick={() => setShowRejectBox(true)}
                      style={{ fontSize: 12, fontWeight: 600, padding: '9px 14px', borderRadius: 8, background: 'rgba(248,113,113,.1)', border: '1px solid rgba(248,113,113,.3)', color: adminTheme.red, cursor: busy ? 'not-allowed' : 'pointer' }}>
                      Reject
                    </button>
                  ) : (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', width: '100%' }}>
                      <input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Rejection reason…"
                        style={{ flex: 1, minWidth: 180, background: adminTheme.panelAlt, border: `1px solid ${adminTheme.border}`, borderRadius: 8, padding: '9px 12px', fontSize: 12.5, color: adminTheme.text, outline: 'none' }} />
                      <button disabled={busy} onClick={() => decide('rejected')}
                        style={{ fontSize: 12, fontWeight: 600, padding: '9px 14px', borderRadius: 8, background: 'rgba(248,113,113,.1)', border: '1px solid rgba(248,113,113,.3)', color: adminTheme.red, cursor: busy ? 'not-allowed' : 'pointer' }}>
                        Confirm Reject
                      </button>
                    </div>
                  )}
                </div>
              )}
              {!isSuperAdmin && (
                <div style={{ fontSize: 11, color: adminTheme.textFaint, marginTop: 8 }}>
                  Sub-Admin: this sends a request for Super Admin approval via request_admin_action — it does not execute directly.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'services' && (
        servicesLoading ? <div style={{ color: adminTheme.textFaint, fontSize: 12.5, textAlign: 'center', padding: 24 }}>Loading services…</div>
        : servicesError ? <NotAvailable reason={servicesError} />
        : !services || services.length === 0 ? (
          <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 24, textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5 }}>No services listed.</div>
        ) : (
          <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, overflow: 'hidden' }}>
            {services.map((sv) => (
              <div key={sv.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 16px', borderBottom: `1px solid ${adminTheme.borderSoft}`, fontSize: 12.5 }}>
                <div style={{ color: adminTheme.text, fontWeight: 600 }}>{sv.name}{!sv.isActive && <span style={{ color: adminTheme.textFaint, fontWeight: 400 }}> (inactive)</span>}</div>
                <div style={{ color: adminTheme.text }}>{sv.currency} {sv.price.toLocaleString('en-NG')}</div>
              </div>
            ))}
          </div>
        )
      )}

      {tab === 'bookings' && <NotAvailable reason="no booking/appointment table exists for service providers today (grepped supabase/migrations and migrations for booking_requests/provider_bookings — neither exists), so no admin-accessible client-booking list can be shown." />}

      {tab === 'earnings' && <NotAvailable reason="no provider earnings/payout table exists (provider_services only stores listed prices, not transactions) — this is a missing backend source, not fabricated data." />}

      {tab === 'audit' && (
        auditLoading ? <div style={{ color: adminTheme.textFaint, fontSize: 12.5, textAlign: 'center', padding: 24 }}>Loading audit trail…</div>
        : audit.length === 0 ? <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 24, textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5 }}>No admin actions recorded for this provider's application.</div>
        : (
          <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, overflow: 'hidden' }}>
            {audit.map((a) => (
              <div key={a.id} style={{ display: 'flex', gap: 12, padding: '13px 16px', borderBottom: `1px solid ${adminTheme.borderSoft}`, fontSize: 12.5, flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
                <div style={{ color: adminTheme.textFaint, width: isMobile ? '100%' : 130, flexShrink: 0 }}>{new Date(a.created_at).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}</div>
                <div style={{ color: adminTheme.text, flex: 1 }}>{a.action.replace(/_/g, ' ')} — {a.details?.status || ''}</div>
                <div style={{ color: adminTheme.textMuted }}>{a.actor_role || '—'}</div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}
