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
// Permission/maker-checker note (RECONCILED against current main —
// 0091_reconcile_request_decisions.sql / 0092_dual_control_case_wiring.sql /
// 0095_admin_action_default_deny_self_approval.sql; this screen's original
// branch pointed at a stale, never-merged 0082 migration and its own
// separate service_provider_kyc_approve/_reject action types, which were
// never wired into approve_admin_action's executor and would have hit
// "No executor mapped for action_type" forever):
// admin_decide_service_provider_request is SECURITY DEFINER, gated by
// is_super_admin() (Root + Admin ONLY — Sub-Admin excluded). A Sub-Admin's
// decision routes through the SAME generic maker-checker machinery as
// organizer verification (request_admin_action / approve_admin_action /
// reject_admin_action) via the shared submitOrExecute() helper, using the
// single 'decide_service_provider_request' action type main already ships
// (payload-carried status, not separate approve/reject action types) —
// approve_admin_action re-derives and executes the decision server-side
// from the stored request payload, never from anything the approving
// admin's client sends beyond the request id.
import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../../lib/supabase';
import { adminTheme } from './adminConsoleTheme';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { withProviderRatings } from '../../../lib/serviceProviders';
import { fetchOwnServicesForProvider, createProviderService, updateProviderService, setProviderServiceActive, deleteProviderService, ProviderServiceInput } from '../../../lib/providerServices';
import { fetchAdminServiceBookings, AdminServiceBookingRow } from '../../../lib/serviceBookings';
import { CURRENCIES } from '../../../lib/currencies';
import type { ServiceProvider, ProviderService } from '../types';
import { providerStatusColors } from './AdminProvidersList';
import { submitOrExecute } from './adminUserEventActions';
import { ConfirmModal } from './adminShared';
import { PickerSheet } from '../shared/PickerSheet';

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
  const [serviceForm, setServiceForm] = useState<{ editing: ProviderService | null; input: ProviderServiceInput } | null>(null);
  const [serviceFormError, setServiceFormError] = useState('');
  const [serviceSaving, setServiceSaving] = useState(false);
  const [serviceBusyId, setServiceBusyId] = useState<string | null>(null);
  const [confirmDeleteService, setConfirmDeleteService] = useState<ProviderService | null>(null);
  const [showCurrencyPicker, setShowCurrencyPicker] = useState(false);

  const [bookings, setBookings] = useState<AdminServiceBookingRow[] | null>(null);
  const [bookingsLoading, setBookingsLoading] = useState(false);
  const [bookingsError, setBookingsError] = useState<string | null>(null);

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

  const loadServices = useCallback(() => {
    setServicesLoading(true); setServicesError(null);
    return fetchOwnServicesForProvider(providerId)
      .then((rows) => setServices(rows))
      .catch((e: any) => setServicesError(e?.message || 'Failed to load services for this provider.'))
      .finally(() => setServicesLoading(false));
  }, [providerId]);

  useEffect(() => {
    if (!providerId) { setServices(null); return; }
    if (tab !== 'services') return;
    loadServices();
  }, [tab, providerId, loadServices]);

  useEffect(() => {
    if (tab !== 'bookings') return;
    setBookingsLoading(true); setBookingsError(null);
    fetchAdminServiceBookings({ providerId, limit: 50, offset: 0 })
      .then((rows) => setBookings(rows))
      .catch((e: any) => setBookingsError(e?.message || 'Failed to load bookings for this provider.'))
      .finally(() => setBookingsLoading(false));
  }, [tab, providerId]);

  const openServiceForm = (existing: ProviderService | null) => {
    setServiceFormError('');
    setServiceForm({
      editing: existing,
      input: existing
        ? { name: existing.name, description: existing.description || '', price: existing.price, currency: existing.currency, durationMinutes: existing.durationMinutes ?? null, category: existing.category || provider?.category || '', isActive: existing.isActive }
        : { name: '', description: '', price: 0, currency: CURRENCIES[0]?.code || 'NGN', durationMinutes: null, category: provider?.category || '', isActive: true },
    });
  };

  const submitServiceForm = async () => {
    if (!serviceForm) return;
    const { editing, input } = serviceForm;
    if (!input.name.trim()) { setServiceFormError('Service name is required.'); return; }
    if (!(input.price >= 0)) { setServiceFormError('A valid price is required.'); return; }
    if (!/^[A-Z]{3}$/.test(input.currency)) { setServiceFormError('A valid currency is required.'); return; }
    setServiceSaving(true); setServiceFormError('');
    try {
      if (editing) await updateProviderService(editing.id, input);
      else await createProviderService(providerId, input);
      setServiceForm(null);
      await loadServices();
      flash(true, editing ? 'Service updated.' : 'Service added.');
    } catch (e: any) {
      setServiceFormError(e?.message || 'Failed to save this service.');
    } finally { setServiceSaving(false); }
  };

  const toggleServiceActive = async (svc: ProviderService) => {
    setServiceBusyId(svc.id);
    try {
      await setProviderServiceActive(svc.id, !svc.isActive);
      await loadServices();
      flash(true, svc.isActive ? 'Service deactivated.' : 'Service activated.');
    } catch (e: any) { flash(false, e?.message || 'Failed to update service.'); } finally { setServiceBusyId(null); }
  };

  const confirmedDeleteService = async (svc: ProviderService) => {
    setConfirmDeleteService(null);
    setServiceBusyId(svc.id);
    try {
      const result = await deleteProviderService(svc.id);
      await loadServices();
      flash(true, result === 'deleted' ? 'Service deleted.' : 'Service archived (it has existing bookings).');
    } catch (e: any) { flash(false, e?.message || 'Failed to delete service.'); } finally { setServiceBusyId(null); }
  };

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
    // RECONCILED: the branch's two separate action types
    // (service_provider_kyc_approve/_reject) were never wired into
    // approve_admin_action's executor CASE and would have hit "No executor
    // mapped" forever. main's own dual-control reconciliation
    // (0092_dual_control_case_wiring.sql) already shipped this exact
    // decision under one payload-carried action type instead — reuse it.
    const adminNote = status === 'rejected' ? rejectReason.trim() : null;
    const res = await submitOrExecute(isSuperAdmin, 'decide_service_provider_request',
      { target_type: 'service_provider_request', target_id: request.id, target_label: provider?.businessName || request.business_name || 'Service provider application', payload: { request_id: request.id, status, admin_note: adminNote } },
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
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button onClick={() => openServiceForm(null)} style={{ display: 'flex', alignItems: 'center', gap: 6, background: adminTheme.accentSoftBg, border: `1px solid ${adminTheme.accentSoftBorder}`, borderRadius: 8, padding: '8px 14px', color: adminTheme.accentText, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
              <Plus size={13} /> Add Service
            </button>
          </div>
          {servicesLoading ? <div style={{ color: adminTheme.textFaint, fontSize: 12.5, textAlign: 'center', padding: 24 }}>Loading services…</div>
          : servicesError ? <NotAvailable reason={servicesError} />
          : !services || services.length === 0 ? (
            <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 24, textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5 }}>No services listed.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {services.map((sv) => (
                <div key={sv.id} style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 14, opacity: sv.isActive ? 1 : 0.65 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <p style={{ color: adminTheme.textStrong, fontSize: 14, fontWeight: 700, margin: 0 }}>{sv.name}</p>
                      {sv.category && <p style={{ color: adminTheme.textFaint, fontSize: 11, margin: '2px 0 0' }}>{sv.category}</p>}
                    </div>
                    <span style={{ fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 8, background: sv.isActive ? 'rgba(52,211,153,.15)' : adminTheme.borderChip, color: sv.isActive ? adminTheme.green : adminTheme.textMuted, flexShrink: 0 }}>{sv.isActive ? 'ACTIVE' : 'INACTIVE'}</span>
                  </div>
                  {sv.description && <p style={{ color: adminTheme.textMuted, fontSize: 12, margin: '8px 0 0', lineHeight: 1.4 }}>{sv.description}</p>}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
                    <span style={{ color: adminTheme.textStrong, fontSize: 14, fontWeight: 700 }}>
                      {sv.currency} {sv.price.toLocaleString('en-NG')}{sv.durationMinutes ? <span style={{ color: adminTheme.textMuted, fontWeight: 500 }}> · {sv.durationMinutes} min</span> : null}
                    </span>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => toggleServiceActive(sv)} disabled={serviceBusyId === sv.id} style={{ background: 'none', border: `1px solid ${adminTheme.border}`, borderRadius: 8, padding: '6px 10px', color: adminTheme.text, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                        {sv.isActive ? 'Deactivate' : 'Activate'}
                      </button>
                      <button onClick={() => openServiceForm(sv)} style={{ background: 'none', border: `1px solid ${adminTheme.border}`, borderRadius: 8, width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                        <Pencil size={12} color={adminTheme.text} />
                      </button>
                      <button onClick={() => setConfirmDeleteService(sv)} disabled={serviceBusyId === sv.id} style={{ background: 'none', border: '1px solid rgba(248,113,113,.3)', borderRadius: 8, width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                        <Trash2 size={12} color={adminTheme.red} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'bookings' && (
        bookingsLoading ? <div style={{ color: adminTheme.textFaint, fontSize: 12.5, textAlign: 'center', padding: 24 }}>Loading bookings…</div>
        : bookingsError ? <NotAvailable reason={bookingsError} />
        : !bookings || bookings.length === 0 ? (
          <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 24, textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5 }}>No bookings for this provider yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {bookings.map((b) => (
              <div key={b.bookingId} style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ color: adminTheme.textStrong, fontSize: 13, fontWeight: 600 }}>{b.customerName || b.customerEmail || b.customerId.slice(0, 8)}</span>
                  <span style={{ color: adminTheme.accentFrom, fontSize: 13, fontWeight: 700 }}>{b.currency} {(b.totalKobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</span>
                </div>
                <div style={{ fontSize: 11, color: adminTheme.textMuted }}>{b.status.replace('_', ' ')} · {b.paymentStatus.replace('_', ' ')} · {new Date(b.createdAt).toLocaleDateString('en-NG')}</div>
              </div>
            ))}
          </div>
        )
      )}

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

      {serviceForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 9998, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }} onClick={() => !serviceSaving && setServiceForm(null)}>
          <div style={{ background: adminTheme.panel, borderRadius: '20px 20px 0 0', padding: 20, width: '100%', maxWidth: 460, maxHeight: '85vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ color: adminTheme.textStrong, fontSize: 16, fontWeight: 700, margin: '0 0 4px' }}>{serviceForm.editing ? 'Edit Service' : 'Add Service'}</h3>
            <input value={serviceForm.input.name} onChange={(e) => setServiceForm({ ...serviceForm, input: { ...serviceForm.input, name: e.target.value } })} placeholder="Service name" style={{ height: 38, background: adminTheme.panelAlt, border: `1px solid ${adminTheme.border}`, borderRadius: 10, padding: '0 12px', color: adminTheme.text, fontSize: 13, outline: 'none' }} />
            <textarea value={serviceForm.input.description} onChange={(e) => setServiceForm({ ...serviceForm, input: { ...serviceForm.input, description: e.target.value } })} placeholder="Description (optional)" rows={3} style={{ background: adminTheme.panelAlt, border: `1px solid ${adminTheme.border}`, borderRadius: 10, padding: '10px 12px', color: adminTheme.text, fontSize: 13, outline: 'none', resize: 'none' }} />
            <input value={serviceForm.input.category || ''} onChange={(e) => setServiceForm({ ...serviceForm, input: { ...serviceForm.input, category: e.target.value } })} placeholder="Category (optional)" style={{ height: 38, background: adminTheme.panelAlt, border: `1px solid ${adminTheme.border}`, borderRadius: 10, padding: '0 12px', color: adminTheme.text, fontSize: 13, outline: 'none' }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="number" min={0} value={serviceForm.input.price || ''} onChange={(e) => setServiceForm({ ...serviceForm, input: { ...serviceForm.input, price: Number(e.target.value) } })} placeholder="Price" style={{ flex: 1, height: 38, background: adminTheme.panelAlt, border: `1px solid ${adminTheme.border}`, borderRadius: 10, padding: '0 12px', color: adminTheme.text, fontSize: 13, outline: 'none' }} />
              <button type="button" onClick={() => setShowCurrencyPicker(true)} style={{ width: 100, height: 38, background: adminTheme.panelAlt, border: `1px solid ${adminTheme.border}`, borderRadius: 10, padding: '0 8px', color: adminTheme.text, fontSize: 13, cursor: 'pointer', textAlign: 'left' }}>
                {serviceForm.input.currency}
              </button>
            </div>
            <input type="number" min={1} value={serviceForm.input.durationMinutes ?? ''} onChange={(e) => setServiceForm({ ...serviceForm, input: { ...serviceForm.input, durationMinutes: e.target.value ? Number(e.target.value) : null } })} placeholder="Duration in minutes (optional)" style={{ height: 38, background: adminTheme.panelAlt, border: `1px solid ${adminTheme.border}`, borderRadius: 10, padding: '0 12px', color: adminTheme.text, fontSize: 13, outline: 'none' }} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', background: adminTheme.panelAlt, border: `1px solid ${adminTheme.border}`, borderRadius: 10 }}>
              <span style={{ color: adminTheme.text, fontSize: 12, fontWeight: 600 }}>Published (visible to customers)</span>
              <div onClick={() => setServiceForm({ ...serviceForm, input: { ...serviceForm.input, isActive: !serviceForm.input.isActive } })} style={{ width: 38, height: 22, borderRadius: 11, background: serviceForm.input.isActive ? adminTheme.accentFrom : adminTheme.borderChip, cursor: 'pointer', position: 'relative' }}>
                <div style={{ position: 'absolute', top: 2, left: serviceForm.input.isActive ? 18 : 2, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left 0.2s ease' }} />
              </div>
            </div>
            {serviceFormError && <p style={{ color: adminTheme.red, fontSize: 12, margin: 0 }}>{serviceFormError}</p>}
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button onClick={() => setServiceForm(null)} disabled={serviceSaving} style={{ flex: 1, height: 42, borderRadius: 10, background: adminTheme.borderChip, border: `1px solid ${adminTheme.border}`, color: adminTheme.text, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
              <button onClick={submitServiceForm} disabled={serviceSaving} style={{ flex: 1, height: 42, borderRadius: 10, background: 'linear-gradient(135deg,#7B2FBE,#4F46E5)', border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, cursor: serviceSaving ? 'wait' : 'pointer', opacity: serviceSaving ? 0.7 : 1 }}>
                {serviceSaving ? 'Saving...' : serviceForm.editing ? 'Save Changes' : 'Add Service'}
              </button>
            </div>
          </div>
        </div>
      )}

      {serviceForm && showCurrencyPicker && (
        <PickerSheet
          title="Select Currency"
          options={CURRENCIES.map((c) => ({ value: c.code, label: c.code }))}
          value={serviceForm.input.currency}
          onSelect={(v) => { setServiceForm({ ...serviceForm, input: { ...serviceForm.input, currency: v } }); setShowCurrencyPicker(false); }}
          onClose={() => setShowCurrencyPicker(false)}
          zIndex={9999}
        />
      )}

      {confirmDeleteService && (
        <ConfirmModal
          title="Delete this service?"
          message={`"${confirmDeleteService.name}" will be removed from this provider's listing. If it has existing bookings, it is archived (hidden, not deleted) instead.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => confirmedDeleteService(confirmDeleteService)}
          onCancel={() => setConfirmDeleteService(null)}
        />
      )}
    </div>
  );
}
