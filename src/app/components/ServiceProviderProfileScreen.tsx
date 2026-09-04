import { useEffect, useState } from 'react';
import { ArrowLeft, MapPin, Tag, Zap, MessageCircle } from 'lucide-react';
import { ServiceProvider } from './types';
import { servicesColors, servicesRadii, servicesSpacing, categoryAccents } from '../../lib/servicesDesignTokens';
import { fetchServiceProviderById } from '../../lib/serviceProviders';

interface ServiceProviderProfileScreenProps {
  providerId: string;
  initialProvider?: ServiceProvider | null;
  onBack: () => void;
  // Stage 2 is discovery-only -- Contact Provider is visually present (per
  // the approved spec) but wiring it to the real Chats flow is explicitly
  // a later stage. Left optional so this screen degrades gracefully until
  // that stage wires a real handler.
  onContactProvider?: (provider: ServiceProvider) => void;
}

function StatTile({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <div style={{ flex: 1, background: servicesColors.cardBg, border: `1px solid ${servicesColors.border}`, borderRadius: servicesRadii.lg, padding: '12px', display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 }}>
      <Icon size={16} color={servicesColors.textSecondary} />
      <span style={{ color: servicesColors.textTertiary, fontSize: '10px', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>{label}</span>
      <span style={{ color: servicesColors.textPrimary, fontSize: '13px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  );
}

function ProfileSkeleton({ onBack }: { onBack: () => void }) {
  return (
    <div style={{ background: servicesColors.bg, width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: 'calc(20px + env(safe-area-inset-top)) 20px 0' }}>
        <button onClick={onBack} style={{ background: servicesColors.cardBg, border: `1px solid ${servicesColors.border}`, borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={16} color="#C4C9E0" />
        </button>
      </div>
      <div style={{ margin: '16px 20px 0', height: '220px', borderRadius: servicesRadii.xl, background: servicesColors.cardBg }} />
      <div style={{ padding: '20px', display: 'flex', gap: servicesSpacing.md }}>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} style={{ flex: 1, height: '76px', borderRadius: servicesRadii.lg, background: servicesColors.cardBg }} />
        ))}
      </div>
    </div>
  );
}

export function ServiceProviderProfileScreen({ providerId, initialProvider, onBack, onContactProvider }: ServiceProviderProfileScreenProps) {
  const [provider, setProvider] = useState<ServiceProvider | null | undefined>(initialProvider);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (initialProvider && initialProvider.id === providerId) return;
    let cancelled = false;
    setProvider(undefined);
    setNotFound(false);
    fetchServiceProviderById(providerId)
      .then((p) => { if (!cancelled) { setProvider(p); if (!p) setNotFound(true); } })
      .catch(() => { if (!cancelled) { setProvider(null); setNotFound(true); } });
    return () => { cancelled = true; };
  }, [providerId, initialProvider]);

  if (provider === undefined) {
    return <ProfileSkeleton onBack={onBack} />;
  }

  if (notFound || !provider) {
    return (
      <div style={{ background: servicesColors.bg, width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 'calc(20px + env(safe-area-inset-top)) 20px 0' }}>
          <button onClick={onBack} style={{ background: servicesColors.cardBg, border: `1px solid ${servicesColors.border}`, borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <ArrowLeft size={16} color="#C4C9E0" />
          </button>
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '20px', textAlign: 'center' }}>
          <p style={{ color: servicesColors.textPrimary, fontSize: '16px', fontWeight: 700, margin: '0 0 6px' }}>This provider isn't available right now</p>
          <p style={{ color: servicesColors.textSecondary, fontSize: '13px', margin: 0 }}>They may have removed their listing.</p>
        </div>
      </div>
    );
  }

  const accent = categoryAccents[provider.category] || servicesColors.accentPurple;
  const priceLabel = provider.startingPrice != null
    ? `${provider.startingPriceCurrency || ''} ${provider.startingPrice.toLocaleString('en-US')}`.trim()
    : '—';
  const badgeLabels = [
    provider.offersHomeService && 'Home',
    provider.offersDelivery && 'Delivery',
    provider.offersSameDay && 'Same-day',
  ].filter(Boolean) as string[];
  const coverPhoto = provider.photoUrls[0];

  return (
    <div style={{ background: servicesColors.bg, width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', paddingBottom: '110px' }}>
        {/* Photo header */}
        <div style={{ position: 'relative', margin: '0 0 0', height: '260px' }}>
          {coverPhoto ? (
            <img src={coverPhoto} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <div style={{ width: '100%', height: '100%', background: `linear-gradient(135deg, ${accent}33, ${servicesColors.bg})` }} />
          )}
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, rgba(2,0,5,0.1) 0%, rgba(2,0,5,0.85) 100%)' }} />
          <div style={{ position: 'absolute', top: 'calc(16px + env(safe-area-inset-top))', left: '16px' }}>
            <button onClick={onBack} style={{ background: 'rgba(9,5,20,0.7)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
              <ArrowLeft size={16} color="#fff" />
            </button>
          </div>
          <div style={{ position: 'absolute', bottom: '18px', left: '20px', right: '20px' }}>
            <span style={{ display: 'inline-block', marginBottom: '8px', fontSize: '11px', fontWeight: 700, padding: '3px 10px', borderRadius: servicesRadii.pill, background: `${accent}33`, color: accent, border: `1px solid ${accent}66` }}>
              {provider.category}
            </span>
            <h1 style={{ color: '#fff', fontSize: '24px', fontWeight: 700, fontFamily: 'Inter, sans-serif', margin: 0 }}>{provider.businessName}</h1>
          </div>
        </div>

        {/* Stat row */}
        <div style={{ display: 'flex', gap: servicesSpacing.md, padding: `${servicesSpacing.lg}px` }}>
          <StatTile icon={MapPin} label="Location" value={provider.location || 'Not specified'} />
          <StatTile icon={Tag} label="Starting Price" value={priceLabel} />
          <StatTile icon={Zap} label="Offers" value={badgeLabels.length ? badgeLabels.join(', ') : 'Standard'} />
        </div>

        {provider.description && (
          <div style={{ padding: `0 ${servicesSpacing.lg}px ${servicesSpacing.lg}px` }}>
            <p style={{ color: '#C9C9D9', fontSize: '14px', lineHeight: 1.6, margin: 0 }}>{provider.description}</p>
          </div>
        )}

        {provider.servicesOffered.length > 0 && (
          <div style={{ padding: `0 ${servicesSpacing.lg}px ${servicesSpacing.lg}px` }}>
            <p style={{ color: servicesColors.textSecondary, fontSize: '11px', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.06em', margin: '0 0 10px' }}>Services Offered</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {provider.servicesOffered.map((s) => (
                <span key={s} style={{ fontSize: '12px', fontWeight: 600, padding: '6px 12px', borderRadius: servicesRadii.pill, background: servicesColors.cardBgAlt, border: `1px solid ${servicesColors.border}`, color: servicesColors.textPrimary }}>
                  {s}
                </span>
              ))}
            </div>
          </div>
        )}

        {provider.photoUrls.length > 1 && (
          <div style={{ padding: `0 ${servicesSpacing.lg}px` }}>
            <p style={{ color: servicesColors.textSecondary, fontSize: '11px', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.06em', margin: '0 0 10px' }}>Photos</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              {provider.photoUrls.slice(1).map((url, i) => (
                <img key={i} src={url} alt="" style={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'cover', borderRadius: servicesRadii.sm }} />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Sticky CTA */}
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: `${servicesSpacing.lg}px 20px calc(24px + env(safe-area-inset-bottom))`, background: 'linear-gradient(to top, #020005 65%, transparent)' }}>
        <button
          onClick={() => onContactProvider?.(provider)}
          disabled={!onContactProvider}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
            background: onContactProvider ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)' : 'rgba(123,47,190,0.25)',
            border: 'none', borderRadius: servicesRadii.md, padding: '16px',
            color: onContactProvider ? '#fff' : 'rgba(255,255,255,0.4)', fontSize: '16px', fontWeight: 700,
            fontFamily: 'Space Grotesk, sans-serif', cursor: onContactProvider ? 'pointer' : 'not-allowed',
            boxShadow: onContactProvider ? '0 8px 28px rgba(123,47,190,0.45)' : 'none',
          }}
        >
          <MessageCircle size={17} />
          Contact Provider
        </button>
      </div>
    </div>
  );
}
