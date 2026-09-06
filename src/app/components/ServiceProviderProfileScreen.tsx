import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, MapPin, Tag, Zap, MessageCircle, Check } from 'lucide-react';
import { ServiceProvider, ProviderService } from './types';
import { servicesColors, servicesRadii, servicesSpacing, categoryAccents } from '../../lib/servicesDesignTokens';
import { fetchServiceProviderById } from '../../lib/serviceProviders';
import { fetchServiceProviderCategories } from '../../lib/serviceProviderCategories';
import { fetchActiveServicesForProvider } from '../../lib/providerServices';
import { createServiceBooking, verifyServiceBookingPayment, logServiceMarketplaceEvent } from '../../lib/serviceBookings';
import { openPaystackPopup } from '../../lib/paystack';

interface ServiceProviderProfileScreenProps {
  providerId: string;
  initialProvider?: ServiceProvider | null;
  onBack: () => void;
  currentUserId?: string;
  currentUserEmail?: string;
  // Wired to the existing Chats/conversation flow in App.tsx (Stage 4) --
  // reuses the same onOpenConversation pattern as Explore/Inbox, so
  // conversation-request gating and everything else about DMs is
  // unchanged. Left optional (button renders disabled without it) so
  // this screen degrades gracefully if ever rendered without a handler.
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

export function ServiceProviderProfileScreen({ providerId, initialProvider, onBack, currentUserId, currentUserEmail, onContactProvider }: ServiceProviderProfileScreenProps) {
  const [provider, setProvider] = useState<ServiceProvider | null | undefined>(initialProvider);
  const [notFound, setNotFound] = useState(false);
  const [services, setServices] = useState<ProviderService[] | null>(null);
  const [categories, setCategories] = useState<string[]>([]);

  // Booking cart: serviceId -> quantity. A service can be selected/
  // deselected by tapping it; quantity defaults to 1 once selected.
  const [selection, setSelection] = useState<Record<string, number>>({});
  const [booking, setBooking] = useState(false);
  const [bookingError, setBookingError] = useState<string | null>(null);
  const [bookingSuccess, setBookingSuccess] = useState(false);

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

  // Real priced offerings (0048_provider_services.sql) -- RLS already
  // restricts this to active services under an approved listing, so no
  // extra "is this provider approved" check is needed here, same as how
  // fetchServiceProviderById itself only ever resolves an approved row.
  useEffect(() => {
    let cancelled = false;
    setServices(null);
    fetchActiveServicesForProvider(providerId)
      .then((rows) => { if (!cancelled) setServices(rows); })
      .catch(() => { if (!cancelled) setServices([]); });
    return () => { cancelled = true; };
  }, [providerId]);

  useEffect(() => {
    let cancelled = false;
    fetchServiceProviderCategories(providerId)
      .then((cats) => { if (!cancelled && cats.length) setCategories(cats); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [providerId]);

  useEffect(() => {
    logServiceMarketplaceEvent('service_provider_viewed', { providerId });
  }, [providerId]);

  const toggleService = (svc: ProviderService) => {
    setBookingError(null);
    setSelection((prev) => {
      const next = { ...prev };
      if (next[svc.id]) {
        delete next[svc.id];
      } else {
        next[svc.id] = 1;
        logServiceMarketplaceEvent('service_selected', { providerId, serviceId: svc.id });
      }
      return next;
    });
  };

  const setQuantity = (serviceId: string, qty: number) => {
    setSelection((prev) => (prev[serviceId] ? { ...prev, [serviceId]: Math.max(1, qty) } : prev));
  };

  const selectedServices = useMemo(
    () => (services || []).filter((s) => selection[s.id]),
    [services, selection]
  );
  const cartCurrency = selectedServices[0]?.currency;
  const mixedCurrency = selectedServices.some((s) => s.currency !== cartCurrency);
  const subtotal = selectedServices.reduce((sum, s) => sum + s.price * (selection[s.id] || 1), 0);
  const canPayCurrency = !mixedCurrency && cartCurrency === 'NGN';

  const handleBookAndPay = async () => {
    if (!currentUserId) {
      setBookingError('Please sign in to book a service.');
      return;
    }
    if (selectedServices.length === 0) return;
    if (mixedCurrency) {
      setBookingError('Please select services in the same currency, or book them separately.');
      return;
    }
    if (!canPayCurrency) {
      setBookingError('Online booking for this currency is coming soon. VENTS currently supports payments in NGN.');
      return;
    }

    setBooking(true);
    setBookingError(null);
    logServiceMarketplaceEvent('booking_initiated', { providerId, metadata: { serviceCount: selectedServices.length } });
    try {
      const result = await createServiceBooking(
        providerId,
        selectedServices.map((s) => ({ serviceId: s.id, quantity: selection[s.id] || 1 }))
      );
      logServiceMarketplaceEvent('checkout_started', { providerId, bookingId: result.bookingId });

      openPaystackPopup({
        email: currentUserEmail || '',
        amountKobo: result.totalKobo,
        ref: result.paymentRef,
        label: provider?.businessName || '',
        metadata: { provider_id: providerId, booking_id: result.bookingId },
        onSuccess: async () => {
          logServiceMarketplaceEvent('payment_attempted', { providerId, bookingId: result.bookingId });
          const verify = await verifyServiceBookingPayment(result.paymentRef);
          if (verify.status === 'error') {
            setBooking(false);
            setBookingError(verify.error);
            return;
          }
          logServiceMarketplaceEvent('payment_completed', { providerId, bookingId: result.bookingId });
          setBooking(false);
          setBookingSuccess(true);
          setSelection({});
        },
        onClose: () => { setBooking(false); },
        onError: (message) => { setBooking(false); setBookingError(message); },
      });
    } catch (err: any) {
      setBooking(false);
      setBookingError(err?.message || 'Could not start this booking. Please try again.');
    }
  };

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
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
              {(categories.length ? categories : [provider.category]).map((cat) => (
                <span key={cat} style={{ display: 'inline-block', fontSize: '11px', fontWeight: 700, padding: '3px 10px', borderRadius: servicesRadii.pill, background: `${categoryAccents[cat] || accent}33`, color: categoryAccents[cat] || accent, border: `1px solid ${categoryAccents[cat] || accent}66` }}>
                  {cat}
                </span>
              ))}
            </div>
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

        {services && services.length > 0 && (
          <div style={{ padding: `0 ${servicesSpacing.lg}px ${servicesSpacing.lg}px` }}>
            <p style={{ color: servicesColors.textSecondary, fontSize: '11px', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.06em', margin: '0 0 10px' }}>Services</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {services.map((svc) => {
                const qty = selection[svc.id];
                const isSelected = !!qty;
                return (
                  <div
                    key={svc.id}
                    onClick={() => toggleService(svc)}
                    style={{
                      background: isSelected ? `${accent}14` : servicesColors.cardBg,
                      border: isSelected ? `1.5px solid ${accent}` : `1px solid ${servicesColors.border}`,
                      borderRadius: servicesRadii.lg, padding: '14px', display: 'flex', justifyContent: 'space-between',
                      alignItems: 'flex-start', gap: '12px', cursor: 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', gap: '10px', minWidth: 0, flex: 1 }}>
                      <div style={{
                        width: '20px', height: '20px', borderRadius: '6px', flexShrink: 0, marginTop: '2px',
                        border: isSelected ? `1.5px solid ${accent}` : `1.5px solid ${servicesColors.border}`,
                        background: isSelected ? accent : 'transparent',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        {isSelected && <Check size={13} color="#fff" />}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <p style={{ color: servicesColors.textPrimary, fontSize: '14px', fontWeight: 700, margin: 0 }}>{svc.name}</p>
                        {svc.description && <p style={{ color: '#C9C9D9', fontSize: '12px', margin: '4px 0 0', lineHeight: 1.5 }}>{svc.description}</p>}
                        {svc.durationMinutes && <p style={{ color: servicesColors.textTertiary, fontSize: '11px', margin: '4px 0 0' }}>{svc.durationMinutes} min</p>}
                        {isSelected && (
                          <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                            <button onClick={() => setQuantity(svc.id, qty - 1)} style={{ width: '24px', height: '24px', borderRadius: '6px', border: `1px solid ${servicesColors.border}`, background: 'none', color: servicesColors.textPrimary, cursor: 'pointer' }}>−</button>
                            <span style={{ color: servicesColors.textPrimary, fontSize: '13px', fontWeight: 700, minWidth: '16px', textAlign: 'center' }}>{qty}</span>
                            <button onClick={() => setQuantity(svc.id, qty + 1)} style={{ width: '24px', height: '24px', borderRadius: '6px', border: `1px solid ${servicesColors.border}`, background: 'none', color: servicesColors.textPrimary, cursor: 'pointer' }}>+</button>
                          </div>
                        )}
                      </div>
                    </div>
                    <span style={{ color: accent, fontSize: '14px', fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0 }}>
                      {svc.currency} {svc.price.toLocaleString('en-US')}
                    </span>
                  </div>
                );
              })}
            </div>
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

      {/* Sticky CTA -- this is the moment VENTS stops being a directory and
          starts being a transaction platform: a real, selectable cart with
          a clear running total, "Book & Pay" as the primary action, and
          Contact Provider kept underneath for anything that isn't a
          straightforward purchase (availability questions, custom
          requests). */}
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: `${servicesSpacing.lg}px 20px calc(24px + env(safe-area-inset-bottom))`, background: 'linear-gradient(to top, #020005 75%, transparent)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {bookingSuccess && (
          <div style={{ background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.4)', borderRadius: servicesRadii.md, padding: '12px 14px' }}>
            <p style={{ color: '#10B981', fontSize: '13px', fontWeight: 700, margin: 0 }}>Booking confirmed! Check My Bookings for details.</p>
          </div>
        )}
        {bookingError && (
          <div style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: servicesRadii.md, padding: '12px 14px' }}>
            <p style={{ color: '#EF4444', fontSize: '13px', fontWeight: 600, margin: 0 }}>{bookingError}</p>
          </div>
        )}

        {selectedServices.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 4px 0' }}>
            <span style={{ color: servicesColors.textSecondary, fontSize: '12px', fontWeight: 600 }}>
              {selectedServices.length} selected
            </span>
            <span style={{ color: servicesColors.textPrimary, fontSize: '15px', fontWeight: 700 }}>
              {cartCurrency} {subtotal.toLocaleString('en-US')}
            </span>
          </div>
        )}

        {selectedServices.length > 0 && (
          <button
            onClick={handleBookAndPay}
            disabled={booking}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
              background: 'linear-gradient(135deg, #10B981, #059669)',
              border: 'none', borderRadius: servicesRadii.md, padding: '16px',
              color: '#fff', fontSize: '16px', fontWeight: 700,
              fontFamily: 'Space Grotesk, sans-serif', cursor: booking ? 'wait' : 'pointer',
              boxShadow: '0 8px 28px rgba(16,185,129,0.4)', opacity: booking ? 0.7 : 1,
            }}
          >
            {booking ? 'Processing…' : `Book & Pay ${cartCurrency || ''} ${subtotal.toLocaleString('en-US')}`}
          </button>
        )}

        <button
          onClick={() => onContactProvider?.(provider)}
          disabled={!onContactProvider}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
            background: selectedServices.length > 0 ? servicesColors.cardBg : (onContactProvider ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)' : 'rgba(123,47,190,0.25)'),
            border: selectedServices.length > 0 ? `1px solid ${servicesColors.border}` : 'none',
            borderRadius: servicesRadii.md, padding: '16px',
            color: selectedServices.length > 0 ? servicesColors.textPrimary : (onContactProvider ? '#fff' : 'rgba(255,255,255,0.4)'),
            fontSize: '16px', fontWeight: 700,
            fontFamily: 'Space Grotesk, sans-serif', cursor: onContactProvider ? 'pointer' : 'not-allowed',
            boxShadow: selectedServices.length === 0 && onContactProvider ? '0 8px 28px rgba(123,47,190,0.45)' : 'none',
          }}
        >
          <MessageCircle size={17} />
          Contact Provider
        </button>
      </div>
    </div>
  );
}
