import { useEffect, useState } from 'react';
import { ArrowLeft, Plus, Pencil, Trash2 } from 'lucide-react';
import { servicesColors, servicesRadii, servicesSpacing, SERVICE_CATEGORIES } from '../../lib/servicesDesignTokens';
import { servicesPayableCurrencyForCountry } from '../../lib/currencies';
import {
  fetchOwnServicesForProvider, createProviderService, updateProviderService,
  setProviderServiceActive, deleteProviderService, ProviderServiceInput,
} from '../../lib/providerServices';
import { ProviderService } from './types';
import { ConfirmDialog } from './ConfirmDialog';
import { PickerField, PickerSheet } from './shared/PickerSheet';

// Manage Your Services & Prices -- the individual priced offerings under a
// provider's listing (see supabase/migrations/0048_provider_services.sql).
// Reuses the same visual language as ServiceProviderSetupScreen/
// ServiceProviderVerificationScreen (servicesDesignTokens, plain <input>/
// <select> fields) rather than introducing a new pattern. No booking/
// payment here at all -- is_active is purely a publish/unpublish toggle.

interface ManageProviderServicesScreenProps {
  providerId: string;
  providerCategory?: string;
  accountCountry?: string;
  onBack: () => void;
}

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: servicesColors.cardBgAlt,
  border: `1px solid ${servicesColors.border}`, borderRadius: servicesRadii.sm,
  padding: '12px 14px', color: servicesColors.textPrimary, fontSize: '14px',
  outline: 'none', fontFamily: 'Inter, sans-serif',
};

function emptyForm(defaultCategory?: string, defaultCurrency?: string): ProviderServiceInput {
  return {
    name: '', description: '', price: 0, currency: defaultCurrency || 'NGN',
    durationMinutes: null, category: defaultCategory || '', isActive: true,
  };
}

// Currency source of truth: the provider's own VENTS account/profile
// currency (accountCountry -> servicesPayableCurrencyForCountry, which
// defaults to NGN rather than USD for an account with no country set --
// unlike the general currencyForCountry default, USD is never payable here
// anyway), never an arbitrary per-service pick -- a provider should never
// be able to price one service in USD and another in NGN out of confusion,
// and the booking/payment flow (create_service_booking, 0054) only accepts
// NGN for now regardless of what's stored here.

export function ManageProviderServicesScreen({ providerId, providerCategory, accountCountry, onBack }: ManageProviderServicesScreenProps) {
  const [services, setServices] = useState<ProviderService[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProviderService | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<ProviderServiceInput>(emptyForm(providerCategory, servicesPayableCurrencyForCountry(accountCountry)));
  const [showCategoryPicker, setShowCategoryPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = () => {
    setError(null);
    fetchOwnServicesForProvider(providerId)
      .then(setServices)
      .catch((err: any) => setError(err?.message || 'Failed to load your services.'));
  };

  useEffect(() => { load(); }, [providerId]);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm(providerCategory, servicesPayableCurrencyForCountry(accountCountry)));
    setFormError('');
    setShowForm(true);
  };

  const openEdit = (svc: ProviderService) => {
    setEditing(svc);
    setForm({
      name: svc.name,
      description: svc.description || '',
      price: svc.price,
      // Always normalized to the account's own currency on edit too --
      // never preserves a stale/mismatched currency from before this was
      // locked to the profile currency.
      currency: servicesPayableCurrencyForCountry(accountCountry),
      durationMinutes: svc.durationMinutes ?? null,
      category: svc.category || '',
      isActive: svc.isActive,
    });
    setFormError('');
    setShowForm(true);
  };

  const handleSubmit = async () => {
    if (!form.name.trim()) { setFormError('Service name is required.'); return; }
    if (!(form.price >= 0)) { setFormError('A valid price is required.'); return; }
    if (!/^[A-Z]{3}$/.test(form.currency)) { setFormError('A valid currency is required.'); return; }
    setSaving(true);
    setFormError('');
    try {
      if (editing) {
        await updateProviderService(editing.id, form);
      } else {
        await createProviderService(providerId, form);
      }
      setShowForm(false);
      load();
    } catch (err: any) {
      setFormError(err?.message || 'Failed to save this service.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (svc: ProviderService) => {
    setBusyId(svc.id);
    try {
      await setProviderServiceActive(svc.id, !svc.isActive);
      load();
    } catch (err: any) {
      setError(err?.message || 'Failed to update this service.');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (!confirmDeleteId) return;
    setBusyId(confirmDeleteId);
    try {
      await deleteProviderService(confirmDeleteId);
      setConfirmDeleteId(null);
      load();
    } catch (err: any) {
      setError(err?.message || 'Failed to delete this service.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div style={{ background: servicesColors.bg, width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: 'calc(20px + env(safe-area-inset-top)) 20px 12px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '12px' }}>
        <button onClick={onBack} style={{ background: servicesColors.cardBg, border: `1px solid ${servicesColors.border}`, borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
          <ArrowLeft size={16} color="#C4C9E0" />
        </button>
        <h1 style={{ color: servicesColors.textPrimary, fontSize: '19px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', margin: 0 }}>
          Your Services & Prices
        </h1>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', padding: `0 ${servicesSpacing.lg}px calc(100px + env(safe-area-inset-bottom))` }}>
        {error && <p style={{ color: '#EF4444', fontSize: '13px', margin: '0 0 12px' }}>{error}</p>}

        {services === null ? (
          <p style={{ color: servicesColors.textSecondary, textAlign: 'center', marginTop: '40px', fontSize: '13px' }}>Loading…</p>
        ) : services.length === 0 ? (
          <div style={{ textAlign: 'center', marginTop: '40px' }}>
            <p style={{ color: servicesColors.textPrimary, fontSize: '15px', fontWeight: 700, margin: '0 0 6px' }}>No services yet</p>
            <p style={{ color: servicesColors.textSecondary, fontSize: '13px', margin: 0 }}>Add your first service so customers can see what you offer and how much it costs.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '4px' }}>
            {services.map((svc) => (
              <div key={svc.id} style={{ background: servicesColors.cardBg, border: `1px solid ${servicesColors.border}`, borderRadius: servicesRadii.lg, padding: '14px', opacity: svc.isActive ? 1 : 0.55 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ color: servicesColors.textPrimary, fontSize: '14px', fontWeight: 700, margin: 0 }}>{svc.name}</p>
                    {svc.category && <p style={{ color: servicesColors.textTertiary, fontSize: '11px', margin: '2px 0 0' }}>{svc.category}</p>}
                  </div>
                  <span style={{ fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: servicesRadii.pill, background: svc.isActive ? 'rgba(16,185,129,0.15)' : 'rgba(148,163,184,0.15)', color: svc.isActive ? '#10B981' : '#94A3B8', flexShrink: 0 }}>
                    {svc.isActive ? 'ACTIVE' : 'INACTIVE'}
                  </span>
                </div>
                {svc.description && <p style={{ color: '#C9C9D9', fontSize: '12px', margin: '8px 0 0', lineHeight: 1.5 }}>{svc.description}</p>}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '10px' }}>
                  <span style={{ color: servicesColors.textPrimary, fontSize: '14px', fontWeight: 700 }}>
                    {svc.currency} {svc.price.toLocaleString('en-US')}
                    {svc.durationMinutes ? <span style={{ color: servicesColors.textSecondary, fontWeight: 500 }}> · {svc.durationMinutes} min</span> : null}
                  </span>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={() => handleToggleActive(svc)} disabled={busyId === svc.id} style={{ background: 'none', border: `1px solid ${servicesColors.border}`, borderRadius: servicesRadii.sm, padding: '6px 10px', color: servicesColors.textSecondary, fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
                      {svc.isActive ? 'Deactivate' : 'Activate'}
                    </button>
                    <button onClick={() => openEdit(svc)} style={{ background: 'none', border: `1px solid ${servicesColors.border}`, borderRadius: servicesRadii.sm, width: '30px', height: '30px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                      <Pencil size={13} color={servicesColors.textSecondary} />
                    </button>
                    <button onClick={() => setConfirmDeleteId(svc.id)} style={{ background: 'none', border: '1px solid rgba(239,68,68,0.3)', borderRadius: servicesRadii.sm, width: '30px', height: '30px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                      <Trash2 size={13} color="#EF4444" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: `${servicesSpacing.lg}px 20px calc(24px + env(safe-area-inset-bottom))`, background: 'linear-gradient(to top, #020005 65%, transparent)' }}>
        <button onClick={openCreate} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', border: 'none', borderRadius: servicesRadii.md, padding: '15px', color: '#fff', fontSize: '15px', fontWeight: 700, fontFamily: 'Space Grotesk, sans-serif', cursor: 'pointer' }}>
          <Plus size={18} /> Add a Service
        </button>
      </div>

      {showForm && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 9999, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }} onClick={() => !saving && setShowForm(false)}>
          <div style={{ background: '#090514', borderRadius: '24px 24px 0 0', padding: '24px 20px calc(28px + env(safe-area-inset-bottom))', width: '100%', maxWidth: '430px', maxHeight: '85vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ color: '#F0F0FF', fontSize: '17px', fontWeight: 700, margin: '0 0 4px' }}>{editing ? 'Edit Service' : 'Add a Service'}</h3>

            <input style={inputStyle} placeholder="Service name (e.g. Bridal Makeup)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <textarea style={{ ...inputStyle, resize: 'none' }} rows={3} placeholder="Description (optional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />

            <PickerField
              value={form.category || ''}
              placeholder="No category"
              onOpen={() => setShowCategoryPicker(true)}
            />

            <div style={{ display: 'flex', gap: '8px', minWidth: 0, alignItems: 'center' }}>
              <input style={{ ...inputStyle, flex: 1, minWidth: 0 }} type="number" min="0" placeholder="Price" value={form.price || ''} onChange={(e) => setForm({ ...form, price: Number(e.target.value) })} />
              {/* Locked to the account's profile currency -- not an
                  arbitrary per-service pick, see currencyForCountry note
                  above emptyForm(). */}
              <div style={{ minWidth: '64px', flexShrink: 0, padding: '12px 14px', background: servicesColors.cardBg, border: `1px solid ${servicesColors.border}`, borderRadius: servicesRadii.sm, color: servicesColors.textSecondary, fontSize: '14px', fontWeight: 700, textAlign: 'center' }}>
                {form.currency}
              </div>
            </div>

            <input style={inputStyle} type="number" min="1" placeholder="Duration in minutes (optional)" value={form.durationMinutes ?? ''} onChange={(e) => setForm({ ...form, durationMinutes: e.target.value ? Number(e.target.value) : null })} />

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', background: servicesColors.cardBg, border: `1px solid ${servicesColors.border}`, borderRadius: servicesRadii.md }}>
              <span style={{ color: servicesColors.textPrimary, fontSize: '13px', fontWeight: 600 }}>Published (visible to customers)</span>
              <div onClick={() => setForm({ ...form, isActive: !form.isActive })} style={{ width: '40px', height: '24px', borderRadius: '12px', background: form.isActive ? '#7B2FBE' : '#1A1625', cursor: 'pointer', position: 'relative' }}>
                <div style={{ position: 'absolute', top: '2px', left: form.isActive ? '18px' : '2px', width: '20px', height: '20px', borderRadius: '50%', background: '#fff', transition: 'left 0.2s ease' }} />
              </div>
            </div>

            {formError && <p style={{ color: '#EF4444', fontSize: '12px', margin: 0 }}>{formError}</p>}

            <button onClick={handleSubmit} disabled={saving} style={{ height: '48px', borderRadius: servicesRadii.md, background: 'linear-gradient(135deg,#7B2FBE,#4F46E5)', border: 'none', color: '#fff', fontSize: '15px', fontWeight: 700, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1 }}>
              {saving ? 'Saving...' : editing ? 'Save Changes' : 'Add Service'}
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDeleteId}
        title="Delete this service?"
        message="This will permanently remove it from your listing. This cannot be undone."
        confirmLabel="Delete"
        danger
        onConfirm={handleDelete}
        onCancel={() => setConfirmDeleteId(null)}
      />

      {showCategoryPicker && (
        <PickerSheet
          title="Select Category"
          options={[{ value: '', label: 'No category' }, ...SERVICE_CATEGORIES.map((c) => ({ value: c, label: c }))]}
          value={form.category || ''}
          onSelect={(v) => { setForm({ ...form, category: v }); setShowCategoryPicker(false); }}
          onClose={() => setShowCategoryPicker(false)}
          zIndex={10000}
        />
      )}

    </div>
  );
}
