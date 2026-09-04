import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Search, ChevronDown, Sparkles, Scissors, PartyPopper, Shirt, Wrench } from 'lucide-react';
import { ServiceProvider } from './types';
import {
  servicesColors, servicesRadii, servicesSpacing, categoryAccents, SERVICE_CATEGORIES,
} from '../../lib/servicesDesignTokens';
import { fetchApprovedServiceProviders, filterProvidersByCountryName } from '../../lib/serviceProviders';
import { ServiceProviderCompactCard } from './ServiceProviderCard';
import { COUNTRY_CODES, CountryOption } from '../../lib/countries';
import { CountryMark } from './PhoneInput';

const CATEGORY_ICONS: Record<string, React.ElementType> = {
  'Beauty & Grooming': Scissors,
  'Events': PartyPopper,
  'Fashion': Shirt,
  'Home Services': Wrench,
};

interface ServicesHomeScreenProps {
  onBack: () => void;
  onCategoryPress: (category: string) => void;
  onProviderPress: (provider: ServiceProvider) => void;
  accountCountryIso?: string;
  discoveryCountryIso: string | undefined;
  onDiscoveryCountryChange: (iso: string) => void;
}

function CardSkeleton() {
  return (
    <div style={{ width: '160px', flexShrink: 0, borderRadius: servicesRadii.md, overflow: 'hidden', background: servicesColors.cardBg, border: `1px solid ${servicesColors.border}` }}>
      <div style={{ width: '100%', aspectRatio: '4 / 3', background: 'rgba(255,255,255,0.04)' }} />
      <div style={{ padding: '10px' }}>
        <div style={{ width: '70%', height: '12px', borderRadius: '4px', background: 'rgba(255,255,255,0.06)', marginBottom: '6px' }} />
        <div style={{ width: '50%', height: '10px', borderRadius: '4px', background: 'rgba(255,255,255,0.06)' }} />
      </div>
    </div>
  );
}

// Small overlay list-picker for the Services discovery-country filter.
// Deliberately separate from CountrySelectScreen (the signup account-
// country step) -- different intent (a per-session discovery filter, not
// account metadata) and different call-to-action, so keeping them
// independent avoids coupling two screens that should be free to diverge.
function DiscoveryCountryPicker({ selectedIso, onSelect, onClose }: { selectedIso?: string; onSelect: (c: CountryOption) => void; onClose: () => void }) {
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return COUNTRY_CODES;
    return COUNTRY_CODES.filter((c) => c.name.toLowerCase().includes(q));
  }, [search]);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 500, background: servicesColors.bg, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: 'calc(20px + env(safe-area-inset-top)) 20px 12px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
          <h2 style={{ color: servicesColors.textPrimary, fontSize: '18px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', margin: 0 }}>Browse services in</h2>
          <button onClick={onClose} style={{ background: servicesColors.cardBg, border: `1px solid ${servicesColors.border}`, borderRadius: '50%', width: '32px', height: '32px', color: servicesColors.textSecondary, cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: servicesColors.cardBgAlt, border: `1px solid ${servicesColors.border}`, borderRadius: servicesRadii.sm, padding: '11px 14px' }}>
          <Search size={16} color={servicesColors.textSecondary} style={{ flexShrink: 0 }} />
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search country..."
            style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', outline: 'none', color: servicesColors.textPrimary, fontSize: '14px', fontFamily: 'Inter, sans-serif' }}
          />
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 16px 40px', scrollbarWidth: 'none' }}>
        {filtered.map((country) => {
          const isSelected = selectedIso === country.iso;
          return (
            <div
              key={country.iso}
              onClick={() => { onSelect(country); onClose(); }}
              style={{
                display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px', marginBottom: '6px',
                borderRadius: servicesRadii.md, cursor: 'pointer',
                background: isSelected ? 'rgba(168,85,247,0.12)' : servicesColors.cardBgAlt,
                border: isSelected ? `1.5px solid ${servicesColors.borderSelected}` : `1px solid ${servicesColors.border}`,
              }}
            >
              <CountryMark country={country} size={18} />
              <span style={{ color: servicesColors.textPrimary, fontSize: '14px', fontWeight: 600 }}>{country.name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ServicesHomeScreen({
  onBack, onCategoryPress, onProviderPress, accountCountryIso, discoveryCountryIso, onDiscoveryCountryChange,
}: ServicesHomeScreenProps) {
  const [search, setSearch] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [providers, setProviders] = useState<ServiceProvider[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  const activeIso = discoveryCountryIso || accountCountryIso;
  const activeCountry = COUNTRY_CODES.find((c) => c.iso === activeIso);

  useEffect(() => {
    let cancelled = false;
    setProviders(null);
    setLoadError(false);
    fetchApprovedServiceProviders({ limit: 20 })
      .then((rows) => { if (!cancelled) setProviders(rows); })
      .catch(() => { if (!cancelled) { setProviders([]); setLoadError(true); } });
    return () => { cancelled = true; };
  }, []);

  const nearYou = useMemo(() => {
    if (!providers) return [];
    return activeCountry ? filterProvidersByCountryName(providers, activeCountry.name) : providers;
  }, [providers, activeCountry]);

  const filteredNearYou = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return nearYou;
    return nearYou.filter((p) => p.businessName.toLowerCase().includes(q) || p.category.toLowerCase().includes(q));
  }, [nearYou, search]);

  return (
    <div style={{ background: servicesColors.bg, width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {pickerOpen && (
        <DiscoveryCountryPicker
          selectedIso={activeIso}
          onSelect={(c) => onDiscoveryCountryChange(c.iso)}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {/* Header */}
      <div style={{ padding: 'calc(20px + env(safe-area-inset-top)) 20px 12px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
          <button onClick={onBack} style={{ background: servicesColors.cardBg, border: `1px solid ${servicesColors.border}`, borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <ArrowLeft size={16} color="#C4C9E0" />
          </button>
          <h1 style={{ color: servicesColors.textPrimary, fontSize: '26px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', margin: 0 }}>Services</h1>
          <button
            onClick={() => setPickerOpen(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px', background: servicesColors.cardBgAlt,
              border: `1px solid ${servicesColors.border}`, borderRadius: servicesRadii.pill, padding: '7px 12px', cursor: 'pointer',
            }}
          >
            {activeCountry ? <CountryMark country={activeCountry} size={14} /> : null}
            <span style={{ color: servicesColors.textPrimary, fontSize: '12px', fontWeight: 600, maxWidth: '80px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {activeCountry?.name || 'Everywhere'}
            </span>
            <ChevronDown size={13} color={servicesColors.textSecondary} />
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: servicesColors.cardBgAlt, border: `1px solid ${servicesColors.border}`, borderRadius: servicesRadii.sm, padding: '11px 14px' }}>
          <Search size={16} color={servicesColors.textSecondary} style={{ flexShrink: 0 }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search services or providers"
            style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', outline: 'none', color: servicesColors.textPrimary, fontSize: '14px', fontFamily: 'Inter, sans-serif' }}
          />
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', padding: `0 ${servicesSpacing.lg}px calc(40px + env(safe-area-inset-bottom))` }}>
        {/* Category grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: servicesSpacing.md, marginBottom: servicesSpacing.xl }}>
          {SERVICE_CATEGORIES.map((cat) => {
            const Icon = CATEGORY_ICONS[cat] || Sparkles;
            const accent = categoryAccents[cat];
            return (
              <button
                key={cat}
                onClick={() => onCategoryPress(cat)}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '10px',
                  padding: '16px', borderRadius: servicesRadii.md, minHeight: '104px',
                  background: servicesColors.cardBg, border: `1px solid ${servicesColors.border}`,
                  cursor: 'pointer', transition: 'transform 0.15s ease',
                }}
                onPointerDown={(e) => { e.currentTarget.style.transform = 'scale(0.97)'; }}
                onPointerUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
                onPointerLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
              >
                <div style={{ width: '44px', height: '44px', borderRadius: '50%', background: `${accent}26`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon size={22} color={accent} />
                </div>
                <span style={{ color: servicesColors.textPrimary, fontSize: '14px', fontWeight: 700, textAlign: 'left' }}>{cat}</span>
              </button>
            );
          })}
        </div>

        {/* Providers near you */}
        <p style={{ color: servicesColors.textSecondary, fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase' as const, margin: '0 0 12px' }}>
          Providers Near You
        </p>

        {providers === null ? (
          <div style={{ display: 'flex', gap: servicesSpacing.md, overflowX: 'auto', scrollbarWidth: 'none' }}>
            {Array.from({ length: 3 }).map((_, i) => <CardSkeleton key={i} />)}
          </div>
        ) : loadError ? (
          <p style={{ color: servicesColors.textSecondary, fontSize: '13px', textAlign: 'center', padding: '24px 0' }}>
            Couldn't load providers right now. Pull down to try again.
          </p>
        ) : filteredNearYou.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '32px 20px' }}>
            <p style={{ color: servicesColors.textPrimary, fontSize: '15px', fontWeight: 700, margin: '0 0 6px' }}>
              No providers in {activeCountry?.name || 'this area'} yet
            </p>
            <p style={{ color: servicesColors.textSecondary, fontSize: '13px', margin: 0 }}>
              Try another country or check back soon
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: servicesSpacing.md, overflowX: 'auto', scrollbarWidth: 'none', paddingBottom: '4px' }}>
            {filteredNearYou.map((p) => (
              <ServiceProviderCompactCard key={p.id} provider={p} onPress={onProviderPress} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
