import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Home, Truck, Zap } from 'lucide-react';
import { ServiceProvider } from './types';
import { servicesColors, servicesRadii, servicesSpacing, categoryAccents } from '../../lib/servicesDesignTokens';
import { fetchApprovedServiceProviders } from '../../lib/serviceProviders';
import { ServiceProviderCard } from './ServiceProviderCard';

interface ServiceCategoryScreenProps {
  category: string;
  onBack: () => void;
  onProviderPress: (provider: ServiceProvider) => void;
}

const FILTER_CHIPS: { key: 'home' | 'delivery' | 'sameDay'; label: string; icon: React.ElementType }[] = [
  { key: 'home', label: 'Home Service', icon: Home },
  { key: 'delivery', label: 'Delivery', icon: Truck },
  { key: 'sameDay', label: 'Same-day', icon: Zap },
];

function ListSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: servicesSpacing.md }}>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} style={{ display: 'flex', gap: '12px', padding: '14px', borderRadius: servicesRadii.md, background: servicesColors.cardBg, border: `1px solid ${servicesColors.border}` }}>
          <div style={{ width: '60px', height: '60px', borderRadius: '12px', background: 'rgba(255,255,255,0.05)', flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ width: '60%', height: '13px', borderRadius: '4px', background: 'rgba(255,255,255,0.06)', marginBottom: '8px' }} />
            <div style={{ width: '40%', height: '10px', borderRadius: '4px', background: 'rgba(255,255,255,0.06)', marginBottom: '8px' }} />
            <div style={{ width: '80%', height: '10px', borderRadius: '4px', background: 'rgba(255,255,255,0.05)' }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ServiceCategoryScreen({ category, onBack, onProviderPress }: ServiceCategoryScreenProps) {
  const [providers, setProviders] = useState<ServiceProvider[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [activeChips, setActiveChips] = useState<Set<'home' | 'delivery' | 'sameDay'>>(new Set());
  const accent = categoryAccents[category] || servicesColors.accentPurple;

  useEffect(() => {
    let cancelled = false;
    setProviders(null);
    setLoadError(false);
    fetchApprovedServiceProviders({ category })
      .then((rows) => { if (!cancelled) setProviders(rows); })
      .catch(() => { if (!cancelled) { setProviders([]); setLoadError(true); } });
    return () => { cancelled = true; };
  }, [category]);

  const toggleChip = (key: 'home' | 'delivery' | 'sameDay') => {
    setActiveChips((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const filtered = useMemo(() => {
    if (!providers) return [];
    return providers.filter((p) => {
      if (activeChips.has('home') && !p.offersHomeService) return false;
      if (activeChips.has('delivery') && !p.offersDelivery) return false;
      if (activeChips.has('sameDay') && !p.offersSameDay) return false;
      return true;
    });
  }, [providers, activeChips]);

  return (
    <div style={{ background: servicesColors.bg, width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ padding: 'calc(20px + env(safe-area-inset-top)) 20px 12px', flexShrink: 0 }}>
        <button onClick={onBack} style={{ background: servicesColors.cardBg, border: `1px solid ${servicesColors.border}`, borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', marginBottom: '14px' }}>
          <ArrowLeft size={16} color="#C4C9E0" />
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
          <div style={{ width: '34px', height: '34px', borderRadius: '50%', background: `${accent}26`, flexShrink: 0 }} />
          <h1 style={{ color: servicesColors.textPrimary, fontSize: '22px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', margin: 0 }}>{category}</h1>
        </div>
        <p style={{ color: servicesColors.textSecondary, fontSize: '13px', margin: '0 0 14px' }}>
          {providers === null ? 'Loading providers…' : `${filtered.length} provider${filtered.length === 1 ? '' : 's'}`}
        </p>

        {/* Filter chips */}
        <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', scrollbarWidth: 'none' }}>
          {FILTER_CHIPS.map(({ key, label, icon: Icon }) => {
            const active = activeChips.has(key);
            return (
              <button
                key={key}
                onClick={() => toggleChip(key)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0,
                  padding: '8px 14px', borderRadius: servicesRadii.pill, fontSize: '12px', fontWeight: 700,
                  cursor: 'pointer', whiteSpace: 'nowrap',
                  background: active ? `${accent}26` : servicesColors.cardBgAlt,
                  border: active ? `1px solid ${accent}66` : `1px solid ${servicesColors.border}`,
                  color: active ? accent : servicesColors.textSecondary,
                }}
              >
                <Icon size={12} />
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', padding: `0 ${servicesSpacing.lg}px calc(40px + env(safe-area-inset-bottom))` }}>
        {providers === null ? (
          <ListSkeleton />
        ) : loadError ? (
          <p style={{ color: servicesColors.textSecondary, fontSize: '13px', textAlign: 'center', padding: '40px 0' }}>
            Couldn't load providers right now. Pull down to try again.
          </p>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 20px' }}>
            <p style={{ color: servicesColors.textPrimary, fontSize: '16px', fontWeight: 700, margin: '0 0 6px' }}>
              No {category} providers yet
            </p>
            <p style={{ color: servicesColors.textSecondary, fontSize: '13px', margin: 0 }}>
              Try another country or check back soon
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: servicesSpacing.md }}>
            {filtered.map((p) => (
              <ServiceProviderCard key={p.id} provider={p} onPress={onProviderPress} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
