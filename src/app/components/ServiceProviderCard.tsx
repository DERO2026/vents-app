import { MapPin, Home, Truck, Zap, ChevronRight } from 'lucide-react';
import { ServiceProvider } from './types';
import { servicesColors, servicesRadii, categoryAccents } from '../../lib/servicesDesignTokens';

function formatStartingPrice(provider: ServiceProvider): string | null {
  if (provider.startingPrice == null) return null;
  const amount = provider.startingPrice.toLocaleString('en-US');
  const currency = provider.startingPriceCurrency || '';
  return currency ? `From ${currency} ${amount}` : `From ${amount}`;
}

function BadgeChips({ provider, compact }: { provider: ServiceProvider; compact?: boolean }) {
  const badges: { label: string; icon: React.ElementType }[] = [];
  if (provider.offersHomeService) badges.push({ label: 'Home Service', icon: Home });
  if (provider.offersSameDay) badges.push({ label: 'Same-day', icon: Zap });
  if (!compact && provider.offersDelivery) badges.push({ label: 'Delivery', icon: Truck });
  if (badges.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
      {badges.slice(0, 2).map(({ label, icon: Icon }) => (
        <span
          key={label}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '3px',
            fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: servicesRadii.pill,
            background: 'rgba(255,255,255,0.06)', color: servicesColors.textSecondary,
          }}
        >
          <Icon size={9} />
          {label}
        </span>
      ))}
    </div>
  );
}

function ProviderThumb({ provider, size, radius }: { provider: ServiceProvider; size: number; radius: number }) {
  const accent = categoryAccents[provider.category] || servicesColors.accentPurple;
  const photo = provider.photoUrls[0];
  return (
    <div style={{ width: size, height: size, borderRadius: radius, overflow: 'hidden', flexShrink: 0, background: `${accent}22`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {photo ? (
        <img src={photo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : (
        <span style={{ color: accent, fontSize: size * 0.4, fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif' }}>
          {provider.businessName.charAt(0).toUpperCase()}
        </span>
      )}
    </div>
  );
}

interface ServiceProviderCardProps {
  provider: ServiceProvider;
  onPress: (provider: ServiceProvider) => void;
}

// Full variant -- used in category browsing lists.
export function ServiceProviderCard({ provider, onPress }: ServiceProviderCardProps) {
  const accent = categoryAccents[provider.category] || servicesColors.accentPurple;
  const price = formatStartingPrice(provider);
  return (
    <button
      onClick={() => onPress(provider)}
      style={{
        width: '100%', display: 'flex', alignItems: 'flex-start', gap: '12px',
        padding: '14px', borderRadius: servicesRadii.md,
        background: servicesColors.cardBg, border: `1px solid ${servicesColors.border}`,
        cursor: 'pointer', textAlign: 'left', transition: 'transform 0.15s ease, opacity 0.15s ease',
      }}
      onPointerDown={(e) => { e.currentTarget.style.transform = 'scale(0.97)'; e.currentTarget.style.opacity = '0.9'; }}
      onPointerUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.opacity = '1'; }}
      onPointerLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.opacity = '1'; }}
    >
      <ProviderThumb provider={provider} size={60} radius={12} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ color: servicesColors.textPrimary, fontSize: '14px', fontWeight: 700, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {provider.businessName}
        </p>
        <span style={{ display: 'inline-block', marginTop: '4px', fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: servicesRadii.pill, background: `${accent}22`, color: accent }}>
          {provider.category}
        </span>
        {provider.description && (
          <p style={{ color: servicesColors.textSecondary, fontSize: '12px', margin: '6px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {provider.description}
          </p>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '6px', flexWrap: 'wrap' }}>
          {provider.location && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: servicesColors.textSecondary }}>
              <MapPin size={11} />
              {provider.location}
            </span>
          )}
          {price && (
            <span style={{ fontSize: '11px', fontWeight: 700, color: servicesColors.textPrimary }}>{price}</span>
          )}
        </div>
        <BadgeChips provider={provider} />
      </div>
      <ChevronRight size={16} color={servicesColors.textTertiary} style={{ flexShrink: 0, marginTop: '4px' }} />
    </button>
  );
}

// Compact variant -- used in the Services home "Providers near you" rail.
export function ServiceProviderCompactCard({ provider, onPress }: ServiceProviderCardProps) {
  const price = formatStartingPrice(provider);
  return (
    <button
      onClick={() => onPress(provider)}
      style={{
        width: '160px', flexShrink: 0, display: 'flex', flexDirection: 'column',
        borderRadius: servicesRadii.md, overflow: 'hidden',
        background: servicesColors.cardBg, border: `1px solid ${servicesColors.border}`,
        boxShadow: '0 10px 26px rgba(88,28,135,0.14), 0 2px 8px rgba(0,0,0,0.25)',
        cursor: 'pointer', textAlign: 'left', transition: 'transform 0.15s ease, opacity 0.15s ease',
      }}
      onPointerDown={(e) => { e.currentTarget.style.transform = 'scale(0.97)'; e.currentTarget.style.opacity = '0.9'; }}
      onPointerUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.opacity = '1'; }}
      onPointerLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.opacity = '1'; }}
    >
      <div style={{ width: '100%', aspectRatio: '4 / 3' }}>
        <ProviderThumb provider={provider} size={160} radius={0} />
      </div>
      <div style={{ padding: '10px' }}>
        <p style={{ color: servicesColors.textPrimary, fontSize: '13px', fontWeight: 700, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {provider.businessName}
        </p>
        {provider.location && (
          <p style={{ color: servicesColors.textSecondary, fontSize: '11px', margin: '3px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {provider.location}
          </p>
        )}
        {!!provider.reviewCount && provider.avgRating != null && (
          <p style={{ color: '#F59E0B', fontSize: '11px', fontWeight: 700, margin: '4px 0 0', display: 'flex', alignItems: 'center', gap: '3px' }}>
            ★ {provider.avgRating.toFixed(1)} <span style={{ color: servicesColors.textSecondary, fontWeight: 500 }}>({provider.reviewCount})</span>
          </p>
        )}
        {price && (
          <p style={{ color: servicesColors.textPrimary, fontSize: '11px', fontWeight: 700, margin: '4px 0 0' }}>{price}</p>
        )}
      </div>
    </button>
  );
}
