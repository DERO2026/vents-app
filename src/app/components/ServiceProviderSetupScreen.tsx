import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Search, Camera, X, Plus, Scissors, PartyPopper, Shirt, Wrench, Sparkles,
  Heart, UtensilsCrossed, Music, Palette, Car,
} from 'lucide-react';
import { supabase, getAuthToken } from '../../lib/supabase';
import { pickImage } from '../../lib/pickImage';
import { compressImage } from '../../lib/compressImage';
import { withTimeoutFallback } from '../../lib/withTimeoutFallback';
import { ImageCropperModal } from './ImageCropperModal';
import { COUNTRY_CODES, CountryOption } from '../../lib/countries';
import { CountryMark } from './PhoneInput';
import { CURRENCIES, CurrencyOption, currencyForCountry } from '../../lib/currencies';
import {
  servicesColors, servicesRadii, servicesSpacing, categoryAccents, SERVICE_CATEGORIES,
} from '../../lib/servicesDesignTokens';
import { fetchOwnServiceProvider, saveAndPublishServiceProvider, ServiceProviderInput } from '../../lib/serviceProviders';
import { fetchServiceProviderCategories, setServiceProviderCategories } from '../../lib/serviceProviderCategories';
import { LocationPicker, LocationValue } from './LocationPicker';
import { ServiceProvider } from './types';

const MAX_PHOTOS = 5;
const DESCRIPTION_LIMIT = 500;

const CATEGORY_ICONS: Record<string, React.ElementType> = {
  'Beauty & Grooming': Scissors,
  'Weddings': Heart,
  'Events': PartyPopper,
  'Photography': Camera,
  'Fashion': Shirt,
  'Home Services': Wrench,
  'Catering & Food': UtensilsCrossed,
  'Entertainment': Music,
  'Decor & Design': Palette,
  'Transportation': Car,
};

interface ServiceProviderSetupScreenProps {
  currentUser: { id: string; country?: string };
  onBack: () => void;
  onSaved: (provider: ServiceProvider) => void;
  // Only meaningful once a listing exists (a service belongs to the
  // listing's own id, provider_services.provider_id -- see
  // 0048_provider_services.sql) -- omitted/unused while creating a
  // brand-new listing for the first time.
  onManageServices?: (providerId: string) => void;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ color: servicesColors.textSecondary, fontSize: '11px', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.06em', margin: '0 0 10px' }}>
      {children}
    </p>
  );
}

function TextField({ value, onChange, placeholder, maxLength }: { value: string; onChange: (v: string) => void; placeholder: string; maxLength?: number }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      maxLength={maxLength}
      style={{
        width: '100%', boxSizing: 'border-box', background: servicesColors.cardBgAlt,
        border: `1px solid ${servicesColors.border}`, borderRadius: servicesRadii.sm,
        padding: '13px 14px', color: servicesColors.textPrimary, fontSize: '14px',
        outline: 'none', fontFamily: 'Inter, sans-serif',
      }}
    />
  );
}

function ToggleRow({ label, sub, on, onChange }: { label: string; sub: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px', background: servicesColors.cardBg, border: `1px solid ${servicesColors.border}`, borderRadius: servicesRadii.md }}>
      <div style={{ minWidth: 0 }}>
        <p style={{ color: servicesColors.textPrimary, fontSize: '14px', fontWeight: 600, margin: 0 }}>{label}</p>
        <p style={{ color: servicesColors.textSecondary, fontSize: '12px', margin: '2px 0 0' }}>{sub}</p>
      </div>
      <div
        onClick={() => onChange(!on)}
        style={{ width: '44px', height: '26px', borderRadius: '13px', background: on ? '#7B2FBE' : '#1A1625', cursor: 'pointer', position: 'relative', transition: 'background 0.25s ease', flexShrink: 0 }}
      >
        <div style={{ position: 'absolute', width: '20px', height: '20px', borderRadius: '50%', background: '#fff', top: '3px', left: on ? '21px' : '3px', transition: 'left 0.25s ease', boxShadow: '0 1px 4px rgba(0,0,0,0.3)' }} />
      </div>
    </div>
  );
}

// Generic searchable overlay list -- used here for both the country and
// currency pickers (same shape as ServicesHomeScreen's discovery-country
// picker, kept local rather than shared to avoid coupling this screen's
// changes to that one's).
function OverlayPicker<T>({
  title, items, getKey, getLabel, renderLeading, onSelect, onClose, placeholder, filterFn,
}: {
  title: string;
  items: T[];
  getKey: (item: T) => string;
  getLabel: (item: T) => string;
  renderLeading?: (item: T) => React.ReactNode;
  onSelect: (item: T) => void;
  onClose: () => void;
  placeholder: string;
  filterFn: (item: T, query: string) => boolean;
}) {
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => filterFn(item, q));
  }, [items, search, filterFn]);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 600, background: servicesColors.bg, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: 'calc(20px + env(safe-area-inset-top)) 20px 12px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
          <h2 style={{ color: servicesColors.textPrimary, fontSize: '18px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', margin: 0 }}>{title}</h2>
          <button onClick={onClose} style={{ background: servicesColors.cardBg, border: `1px solid ${servicesColors.border}`, borderRadius: '50%', width: '32px', height: '32px', color: servicesColors.textSecondary, cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: servicesColors.cardBgAlt, border: `1px solid ${servicesColors.border}`, borderRadius: servicesRadii.sm, padding: '11px 14px' }}>
          <Search size={16} color={servicesColors.textSecondary} style={{ flexShrink: 0 }} />
          <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder={placeholder} style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', outline: 'none', color: servicesColors.textPrimary, fontSize: '14px', fontFamily: 'Inter, sans-serif' }} />
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 16px 40px', scrollbarWidth: 'none' }}>
        {filtered.map((item) => (
          <div
            key={getKey(item)}
            onClick={() => { onSelect(item); onClose(); }}
            style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px', marginBottom: '6px', borderRadius: servicesRadii.md, cursor: 'pointer', background: servicesColors.cardBgAlt, border: `1px solid ${servicesColors.border}` }}
          >
            {renderLeading?.(item)}
            <span style={{ color: servicesColors.textPrimary, fontSize: '14px', fontWeight: 600 }}>{getLabel(item)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ServiceProviderSetupScreen({ currentUser, onBack, onSaved, onManageServices }: ServiceProviderSetupScreenProps) {
  const [loading, setLoading] = useState(true);
  const [existing, setExisting] = useState<ServiceProvider | null>(null);

  const [photos, setPhotos] = useState<string[]>([]);
  const [businessName, setBusinessName] = useState('');
  // Multiple categories a provider can offer under (Beauty & Grooming +
  // Weddings + Photography, etc). categories[0] is the PRIMARY category,
  // mirrored into service_providers.category (0034, unchanged column) via
  // set_service_provider_categories -- every existing single-category
  // reader (search filter, categoryAccents lookups) keeps working off that
  // one column; the full set is additive, stored in
  // service_provider_categories (0054).
  const [categories, setCategories] = useState<string[]>([]);
  const category = categories[0] || '';
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  // Geocoded coordinates for "Providers Near You" distance sorting
  // (0056_service_provider_geolocation.sql) -- only ever set by an actual
  // LocationPicker selection/drag, never inferred from free-typed text, so
  // a stale lat/lng can't silently point at the wrong place.
  const [latitude, setLatitude] = useState<number | null>(null);
  const [longitude, setLongitude] = useState<number | null>(null);
  const [countryIso, setCountryIso] = useState<string>('');
  const [startingPrice, setStartingPrice] = useState('');
  const [currencyCode, setCurrencyCode] = useState('');
  const [servicesOffered, setServicesOffered] = useState<string[]>([]);
  const [serviceInput, setServiceInput] = useState('');
  const [offersHomeService, setOffersHomeService] = useState(false);
  const [offersDelivery, setOffersDelivery] = useState(false);
  const [offersSameDay, setOffersSameDay] = useState(false);

  const [countryPickerOpen, setCountryPickerOpen] = useState(false);
  const [currencyPickerOpen, setCurrencyPickerOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetchOwnServiceProvider(currentUser.id)
      .then((provider) => {
        if (cancelled) return;
        if (provider) {
          setExisting(provider);
          setPhotos(provider.photoUrls);
          setBusinessName(provider.businessName);
          setCategories([provider.category]);
          fetchServiceProviderCategories(provider.id)
            .then((cats) => { if (!cancelled && cats.length) setCategories(cats); })
            .catch(() => {});
          setDescription(provider.description || '');
          setLocation(provider.location || '');
          setLatitude(provider.latitude ?? null);
          setLongitude(provider.longitude ?? null);
          setCountryIso(provider.country || currentUser.country || '');
          setStartingPrice(provider.startingPrice != null ? String(provider.startingPrice) : '');
          setCurrencyCode(provider.startingPriceCurrency || currencyForCountry(currentUser.country));
          setServicesOffered(provider.servicesOffered);
          setOffersHomeService(provider.offersHomeService);
          setOffersDelivery(provider.offersDelivery);
          setOffersSameDay(provider.offersSameDay);
        } else {
          setCountryIso(currentUser.country || '');
          setCurrencyCode(currencyForCountry(currentUser.country));
        }
      })
      .catch((err) => { if (!cancelled) setError(err?.message || 'Failed to load your profile.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [currentUser.id, currentUser.country]);

  const selectedCountry = COUNTRY_CODES.find((c) => c.iso === countryIso);
  const selectedCurrency = CURRENCIES.find((c) => c.code === currencyCode);

  const handleCountrySelect = (country: CountryOption) => {
    setCountryIso(country.iso);
    // Only re-default the currency if the provider hasn't already picked
    // one explicitly different from the previous country's default --
    // simplest correct behavior for v1: re-defaulting on every country
    // change is fine since the provider can still change it afterward.
    setCurrencyCode(currencyForCountry(country.iso));
  };

  const processPhotoFile = (file: File) => {
    if (photos.length >= MAX_PHOTOS) return;
    if (file.size > 15 * 1024 * 1024) { setError('Photo must be under 15MB.'); return; }
    setError(null);
    setCropSrc(URL.createObjectURL(file));
  };

  const openPhotoPicker = async () => {
    if (photos.length >= MAX_PHOTOS) return;
    const native = await pickImage();
    if (native) { processPhotoFile(native); return; }
    fileInputRef.current?.click();
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processPhotoFile(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleCropComplete = async (croppedBlob: Blob) => {
    setCropSrc(null);
    setUploading(true);
    setError(null);
    try {
      await getAuthToken();
      const { blob: compressed, mimeType, extension } = await compressImage(croppedBlob);
      const file = new File([compressed], `photo.${extension}`, { type: mimeType });
      const key = `${crypto.randomUUID()}.${extension}`;
      const { error: uploadError } = await withTimeoutFallback(
        supabase.storage.from('service-providers').upload(key, file, { contentType: mimeType, upsert: false }),
        { timeoutMs: 30000, timeoutMessage: 'Photo upload is taking too long. Please check your connection and try again.' }
      );
      if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);
      const { data: urlData } = supabase.storage.from('service-providers').getPublicUrl(key);
      if (urlData?.publicUrl) {
        setPhotos((prev) => [...prev, urlData.publicUrl].slice(0, MAX_PHOTOS));
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to upload photo.');
    } finally {
      setUploading(false);
    }
  };

  const removePhoto = (index: number) => {
    setPhotos((prev) => prev.filter((_, i) => i !== index));
  };

  const addServiceChip = () => {
    const v = serviceInput.trim();
    if (!v || servicesOffered.includes(v)) { setServiceInput(''); return; }
    setServicesOffered((prev) => [...prev, v]);
    setServiceInput('');
  };

  const removeServiceChip = (chip: string) => {
    setServicesOffered((prev) => prev.filter((s) => s !== chip));
  };

  const missingFields: string[] = [];
  if (!businessName.trim()) missingFields.push('Business name');
  if (categories.length === 0) missingFields.push('Category');
  if (!countryIso) missingFields.push('Country');
  if (startingPrice.trim() && !currencyCode) missingFields.push('Currency');
  const priceValue = startingPrice.trim() ? Number(startingPrice) : null;
  if (startingPrice.trim() && (Number.isNaN(priceValue) || (priceValue as number) < 0)) missingFields.push('A valid starting price');

  const canSave = missingFields.length === 0 && !saving && !uploading;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      // ROOT CAUSE (proven via live diagnostic against Preview, not
      // guessed): ProfileScreen's canAccessProviderSetup treats an
      // 'approved' service_provider_requests row as equivalent to holding
      // the capability, to close a UX race right after admin approval (the
      // atomic admin_decide_service_provider_request RPC sets both
      // service_provider_requests.status and users.is_service_provider
      // together, so in the NORMAL flow these can never disagree). But a
      // real Preview account was found with status='approved' while
      // users.is_service_provider was still false -- a genuine persisted
      // desync (most likely an out-of-band edit to the request row outside
      // that RPC), not a timing race and not an RLS defect:
      // service_providers_insert_own correctly rejected the write from an
      // account that does not actually hold the capability. The bug was
      // letting the client reach this screen and attempt the write at all
      // on a signal that can drift from the authoritative flag.
      //
      // Fix: re-check the authoritative flag directly, immediately before
      // the write -- never trust the capability-gate signal that got the
      // user onto this screen. This never touches RLS; it only stops the
      // client from attempting a write RLS was always going to correctly
      // reject, replacing a raw "row-level security policy" error with an
      // honest, actionable message.
      const { data: capRow, error: capErr } = await supabase
        .from('users')
        .select('is_service_provider')
        .eq('id', currentUser.id)
        .maybeSingle();
      if (capErr) throw capErr;
      if (!capRow?.is_service_provider) {
        setError("Your Service Provider approval isn't active yet. Please contact support or re-check your application status before publishing.");
        return;
      }

      const input: ServiceProviderInput = {
        businessName: businessName.trim(),
        category,
        description: description.trim(),
        location: location.trim(),
        latitude,
        longitude,
        country: countryIso,
        photoUrls: photos,
        startingPrice: startingPrice.trim() ? Number(startingPrice) : null,
        startingPriceCurrency: startingPrice.trim() ? currencyCode : null,
        servicesOffered,
        offersHomeService,
        offersDelivery,
        offersSameDay,
      };
      const saved = await saveAndPublishServiceProvider(currentUser.id, input);
      await setServiceProviderCategories(saved.id, categories);
      onSaved(saved);
    } catch (err: any) {
      setError(err?.message || 'Failed to save your profile. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ background: servicesColors.bg, width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 'calc(20px + env(safe-area-inset-top)) 20px 0' }}>
          <button onClick={onBack} style={{ background: servicesColors.cardBg, border: `1px solid ${servicesColors.border}`, borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <ArrowLeft size={16} color="#C4C9E0" />
          </button>
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: servicesColors.textSecondary, fontSize: '13px' }}>Loading…</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: servicesColors.bg, width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileInput} style={{ display: 'none' }} />
      {cropSrc && (
        <ImageCropperModal imageSrc={cropSrc} onCropComplete={handleCropComplete} onClose={() => setCropSrc(null)} aspect={4 / 3} cropShape="rect" title="Crop Photo" />
      )}
      {countryPickerOpen && (
        <OverlayPicker
          title="Country"
          items={COUNTRY_CODES}
          getKey={(c) => c.iso}
          getLabel={(c) => c.name}
          renderLeading={(c) => <CountryMark country={c} size={18} />}
          onSelect={handleCountrySelect}
          onClose={() => setCountryPickerOpen(false)}
          placeholder="Search country..."
          filterFn={(c, q) => c.name.toLowerCase().includes(q)}
        />
      )}
      {currencyPickerOpen && (
        <OverlayPicker
          title="Currency"
          items={CURRENCIES}
          getKey={(c) => c.code}
          getLabel={(c) => `${c.code} — ${c.name}`}
          renderLeading={(c: CurrencyOption) => <span style={{ width: '18px', textAlign: 'center', color: servicesColors.textSecondary, fontSize: '13px', fontWeight: 700 }}>{c.symbol.length <= 2 ? c.symbol : c.code}</span>}
          onSelect={(c) => setCurrencyCode(c.code)}
          onClose={() => setCurrencyPickerOpen(false)}
          placeholder="Search currency..."
          filterFn={(c, q) => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q)}
        />
      )}

      {/* Header */}
      <div style={{ padding: 'calc(20px + env(safe-area-inset-top)) 20px 12px', flexShrink: 0 }}>
        <button onClick={onBack} style={{ background: servicesColors.cardBg, border: `1px solid ${servicesColors.border}`, borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', marginBottom: '14px' }}>
          <ArrowLeft size={16} color="#C4C9E0" />
        </button>
        <h1 style={{ color: servicesColors.textPrimary, fontSize: '24px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', margin: 0 }}>
          {existing ? 'Edit Service Profile' : 'Set Up Your Service Profile'}
        </h1>
        <p style={{ color: servicesColors.textSecondary, fontSize: '13px', margin: '6px 0 0' }}>
          This is your public listing in VENTS Services.
        </p>
        {existing && onManageServices && (
          <button
            onClick={() => onManageServices(existing.id)}
            style={{ marginTop: '14px', width: '100%', padding: '13px', background: servicesColors.cardBg, border: `1px solid ${servicesColors.border}`, borderRadius: servicesRadii.md, color: servicesColors.textPrimary, fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}
          >
            Manage Your Services & Prices
          </button>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', padding: `0 ${servicesSpacing.lg}px calc(120px + env(safe-area-inset-bottom))` }}>
        {/* Photos */}
        <SectionLabel>Photos</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: servicesSpacing.sm, marginBottom: servicesSpacing.xl }}>
          {photos.map((url, i) => (
            <div key={url} style={{ position: 'relative', aspectRatio: '1 / 1', borderRadius: servicesRadii.sm, overflow: 'hidden' }}>
              <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              {i === 0 && (
                <span style={{ position: 'absolute', top: '4px', left: '4px', fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: servicesRadii.pill, background: 'rgba(0,0,0,0.6)', color: '#fff' }}>Cover</span>
              )}
              <button onClick={() => removePhoto(i)} style={{ position: 'absolute', top: '4px', right: '4px', width: '20px', height: '20px', borderRadius: '50%', background: 'rgba(0,0,0,0.65)', border: 'none', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                <X size={11} />
              </button>
            </div>
          ))}
          {photos.length < MAX_PHOTOS && (
            <button
              onClick={openPhotoPicker}
              disabled={uploading}
              style={{ aspectRatio: '1 / 1', borderRadius: servicesRadii.sm, background: servicesColors.cardBg, border: `1px dashed ${servicesColors.border}`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px', cursor: uploading ? 'wait' : 'pointer' }}
            >
              {uploading ? (
                <span style={{ color: servicesColors.textSecondary, fontSize: '11px' }}>Uploading…</span>
              ) : (
                <>
                  <Camera size={18} color={servicesColors.textSecondary} />
                  <span style={{ color: servicesColors.textSecondary, fontSize: '10px' }}>Add photo</span>
                </>
              )}
            </button>
          )}
        </div>

        {/* Business name */}
        <SectionLabel>Business Name</SectionLabel>
        <div style={{ marginBottom: servicesSpacing.xl }}>
          <TextField value={businessName} onChange={setBusinessName} placeholder="e.g. Glow Beauty Studio" />
        </div>

        {/* Category -- select up to 5. The first one selected is your
            primary category (shown on your card and used for search). */}
        <SectionLabel>Category (select up to 5, first is primary)</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: servicesSpacing.sm, marginBottom: servicesSpacing.xl }}>
          {SERVICE_CATEGORIES.map((cat) => {
            const Icon = CATEGORY_ICONS[cat] || Sparkles;
            const accent = categoryAccents[cat];
            const active = categories.includes(cat);
            const isPrimary = categories[0] === cat;
            return (
              <button
                key={cat}
                onClick={() => setCategories((prev) => {
                  if (prev.includes(cat)) return prev.filter((c) => c !== cat);
                  if (prev.length >= 5) return prev;
                  return [...prev, cat];
                })}
                style={{
                  display: 'flex', alignItems: 'center', gap: '10px', padding: '12px',
                  borderRadius: servicesRadii.md, cursor: 'pointer', textAlign: 'left',
                  background: active ? `${accent}1F` : servicesColors.cardBg,
                  border: active ? `1.5px solid ${accent}` : `1px solid ${servicesColors.border}`,
                }}
              >
                <Icon size={18} color={accent} />
                <span style={{ color: servicesColors.textPrimary, fontSize: '13px', fontWeight: 700, flex: 1 }}>{cat}</span>
                {isPrimary && (
                  <span style={{ fontSize: '9px', fontWeight: 700, color: accent, textTransform: 'uppercase' as const }}>Primary</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Description */}
        <SectionLabel>Description</SectionLabel>
        <div style={{ marginBottom: servicesSpacing.xl }}>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, DESCRIPTION_LIMIT))}
            placeholder="Tell customers what you offer..."
            rows={4}
            style={{ width: '100%', boxSizing: 'border-box', background: servicesColors.cardBgAlt, border: `1px solid ${servicesColors.border}`, borderRadius: servicesRadii.sm, padding: '13px 14px', color: servicesColors.textPrimary, fontSize: '14px', outline: 'none', resize: 'none', fontFamily: 'Inter, sans-serif' }}
          />
          <p style={{ color: servicesColors.textTertiary, fontSize: '11px', textAlign: 'right', margin: '6px 0 0' }}>{description.length}/{DESCRIPTION_LIMIT}</p>
        </div>

        {/* Location -- geocoded (reuses the same LocationPicker/Google
            Places pattern events use) so this listing gets real
            coordinates for distance-sorted "Providers Near You" discovery.
            Free-typed text alone (no selection) still saves as a plain
            address with no lat/lng, same as before -- this never blocks
            saving without a picked location. */}
        <SectionLabel>Location</SectionLabel>
        <div style={{ marginBottom: servicesSpacing.xl }}>
          <LocationPicker
            value={{ address: location, lat: latitude, lng: longitude }}
            onChange={(v: LocationValue) => {
              setLocation(v.address);
              setLatitude(v.lat);
              setLongitude(v.lng);
            }}
            placeholder="e.g. Lekki, Lagos"
          />
        </div>

        {/* Country */}
        <SectionLabel>Country</SectionLabel>
        <div style={{ marginBottom: servicesSpacing.xl }}>
          <button
            onClick={() => setCountryPickerOpen(true)}
            style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '10px', background: servicesColors.cardBgAlt, border: `1px solid ${servicesColors.border}`, borderRadius: servicesRadii.sm, padding: '13px 14px', cursor: 'pointer', textAlign: 'left' }}
          >
            {selectedCountry ? <CountryMark country={selectedCountry} size={18} /> : null}
            <span style={{ color: selectedCountry ? servicesColors.textPrimary : servicesColors.textTertiary, fontSize: '14px', fontWeight: 600, flex: 1 }}>
              {selectedCountry?.name || 'Select country'}
            </span>
          </button>
        </div>

        {/* Starting price + currency */}
        <SectionLabel>Starting Price</SectionLabel>
        <div style={{ display: 'flex', gap: servicesSpacing.sm, marginBottom: servicesSpacing.xl }}>
          <div style={{ flex: 1 }}>
            <input
              value={startingPrice}
              onChange={(e) => setStartingPrice(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="Amount"
              inputMode="decimal"
              style={{ width: '100%', boxSizing: 'border-box', background: servicesColors.cardBgAlt, border: `1px solid ${servicesColors.border}`, borderRadius: servicesRadii.sm, padding: '13px 14px', color: servicesColors.textPrimary, fontSize: '14px', outline: 'none', fontFamily: 'Inter, sans-serif' }}
            />
          </div>
          <button
            onClick={() => setCurrencyPickerOpen(true)}
            style={{ width: '110px', flexShrink: 0, background: servicesColors.cardBgAlt, border: `1px solid ${servicesColors.border}`, borderRadius: servicesRadii.sm, padding: '13px 14px', color: servicesColors.textPrimary, fontSize: '14px', fontWeight: 700, cursor: 'pointer', textAlign: 'left' }}
          >
            {selectedCurrency?.code || currencyCode || 'Currency'}
          </button>
        </div>

        {/* Services offered */}
        <SectionLabel>Services Offered</SectionLabel>
        <div style={{ marginBottom: servicesSpacing.xl }}>
          <div style={{ display: 'flex', gap: servicesSpacing.sm, marginBottom: servicesOffered.length ? servicesSpacing.sm : 0 }}>
            <input
              value={serviceInput}
              onChange={(e) => setServiceInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addServiceChip(); } }}
              placeholder="e.g. Bridal makeup"
              style={{ flex: 1, boxSizing: 'border-box', background: servicesColors.cardBgAlt, border: `1px solid ${servicesColors.border}`, borderRadius: servicesRadii.sm, padding: '13px 14px', color: servicesColors.textPrimary, fontSize: '14px', outline: 'none', fontFamily: 'Inter, sans-serif' }}
            />
            <button onClick={addServiceChip} style={{ width: '46px', flexShrink: 0, background: servicesColors.cardBg, border: `1px solid ${servicesColors.border}`, borderRadius: servicesRadii.sm, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
              <Plus size={18} color={servicesColors.textSecondary} />
            </button>
          </div>
          {servicesOffered.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {servicesOffered.map((s) => (
                <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 600, padding: '6px 10px 6px 12px', borderRadius: servicesRadii.pill, background: servicesColors.cardBgAlt, border: `1px solid ${servicesColors.border}`, color: servicesColors.textPrimary }}>
                  {s}
                  <button onClick={() => removeServiceChip(s)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}>
                    <X size={12} color={servicesColors.textSecondary} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Toggles */}
        <SectionLabel>What You Offer</SectionLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: servicesSpacing.sm, marginBottom: servicesSpacing.xl }}>
          <ToggleRow label="Home Service" sub="You travel to the customer" on={offersHomeService} onChange={setOffersHomeService} />
          <ToggleRow label="Delivery" sub="You can deliver goods/orders" on={offersDelivery} onChange={setOffersDelivery} />
          <ToggleRow label="Same-day" sub="You can fulfil on short notice" on={offersSameDay} onChange={setOffersSameDay} />
        </div>

        {error && <p style={{ color: servicesColors.error, fontSize: '13px', margin: '0 0 12px' }}>{error}</p>}
      </div>

      {/* Sticky CTA */}
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: `${servicesSpacing.lg}px 20px calc(24px + env(safe-area-inset-bottom))`, background: 'linear-gradient(to top, #020005 65%, transparent)' }}>
        {!canSave && missingFields.length > 0 && (
          <p style={{ color: servicesColors.textTertiary, fontSize: '11px', textAlign: 'center', margin: '0 0 8px' }}>
            Required: {missingFields.join(', ')}
          </p>
        )}
        <button
          onClick={handleSave}
          disabled={!canSave}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
            background: canSave ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)' : 'rgba(123,47,190,0.25)',
            border: 'none', borderRadius: servicesRadii.md, padding: '16px',
            color: canSave ? '#fff' : 'rgba(255,255,255,0.4)', fontSize: '16px', fontWeight: 700,
            fontFamily: 'Space Grotesk, sans-serif', cursor: canSave ? 'pointer' : 'not-allowed',
            boxShadow: canSave ? '0 8px 28px rgba(123,47,190,0.45)' : 'none',
          }}
        >
          {saving ? 'Saving…' : 'Save & Publish'}
        </button>
      </div>
    </div>
  );
}
