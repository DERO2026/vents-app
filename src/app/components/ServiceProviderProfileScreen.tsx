import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, MapPin, Tag, Zap, MessageCircle, Check } from 'lucide-react';
import { ServiceProvider, ProviderService } from './types';
import { servicesColors, servicesRadii, servicesSpacing, categoryAccents } from '../../lib/servicesDesignTokens';
import { fetchServiceProviderById, withProviderRatings } from '../../lib/serviceProviders';
import { fetchServiceProviderCategories } from '../../lib/serviceProviderCategories';
import { fetchActiveServicesForProvider } from '../../lib/providerServices';
import { createServiceBooking, verifyServiceBookingPayment, logServiceMarketplaceEvent } from '../../lib/serviceBookings';
import { openPaystackPopup } from '../../lib/paystack';
import { fetchMyWalletBalanceKobo, payServiceBookingWithWallet } from '../../lib/userWallet';
import { formatServiceAmount } from '../../lib/currencies';

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
          <ArrowLeft size={16} color={servicesColors.textSecondary} />
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
  // Wallet payment option for Services bookings, same shape as
  // CheckoutScreen.tsx's ticket flow (0066_wallet_payments.sql). Balance is
  // informational only -- the real sufficiency check happens server-side.
  const [paymentMethod, setPaymentMethod] = useState<'paystack' | 'wallet'>('paystack');
  const [walletBalanceKobo, setWalletBalanceKobo] = useState<number | null>(null);
  const [walletBalanceLoading, setWalletBalanceLoading] = useState(false);
  // Real fields create_service_booking already accepts (0054_service_
  // bookings_marketplace.sql: p_scheduled_date/p_scheduled_time) but this
  // screen never collected before now -- closing that gap with the actual
  // backend-supported fields, not a fabricated calendar/availability
  // system the repo has no support for (see the mockup's own P21 note).
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  // SV3 handoff: Services/About/Reviews tab strip. Purely a view switch
  // over data this screen already fetches -- no new data source.
  const [activeTab, setActiveTab] = useState<'services' | 'about' | 'reviews'>('services');

  useEffect(() => {
    let cancelled = false;
    setWalletBalanceLoading(true);
    fetchMyWalletBalanceKobo()
      .then((kobo) => { if (!cancelled) setWalletBalanceKobo(kobo); })
      .catch(() => { if (!cancelled) setWalletBalanceKobo(null); })
      .finally(() => { if (!cancelled) setWalletBalanceLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (initialProvider && initialProvider.id === providerId) return;
    let cancelled = false;
    setProvider(undefined);
    setNotFound(false);
    fetchServiceProviderById(providerId)
      .then(async (p) => {
        if (cancelled || !p) { if (!cancelled) { setProvider(p); setNotFound(!p); } return; }
        const [rated] = await withProviderRatings([p]);
        if (!cancelled) setProvider(rated);
      })
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
        selectedServices.map((s) => ({ serviceId: s.id, quantity: selection[s.id] || 1 })),
        { scheduledDate: scheduledDate || null, scheduledTime: scheduledTime || null }
      );
      logServiceMarketplaceEvent('checkout_started', { providerId, bookingId: result.bookingId });

      if (paymentMethod === 'wallet') {
        logServiceMarketplaceEvent('payment_attempted', { providerId, bookingId: result.bookingId });
        const walletResult = await payServiceBookingWithWallet(result.paymentRef);
        if (walletResult.status !== 'success') {
          setBooking(false);
          setBookingError(
            walletResult.status === 'insufficient_balance'
              ? 'Insufficient Wallet balance. Choose Paystack or top up your Wallet first.'
              : walletResult.error || 'Wallet payment could not be completed.'
          );
          return;
        }
        logServiceMarketplaceEvent('payment_completed', { providerId, bookingId: result.bookingId });
        setBooking(false);
        setBookingSuccess(true);
        setSelection({});
        return;
      }

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
            <ArrowLeft size={16} color={servicesColors.textSecondary} />
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
    ? formatServiceAmount(provider.startingPrice, provider.startingPriceCurrency)
    : '—';
  const badgeLabels = [
    provider.offersHomeService && 'Home',
    provider.offersDelivery && 'Delivery',
    provider.offersSameDay && 'Same-day',
  ].filter(Boolean) as string[];
  const coverPhoto = provider.photoUrls[0];

  return (
    <div style={{ background: servicesColors.bg, width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <style>{`
        @media (min-width: 900px) {
          .sp-profile-content { max-width: 640px; margin-left: auto; margin-right: auto; }
        }
      `}</style>
      <div className="sp-profile-content" style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', paddingBottom: '110px' }}>
        {/* SV3 hero -- shorter cover band (200px, was 260px) with a
            floating profile card overlapping it, rather than the name
            baked into the photo itself. Real cover photo (photoUrls[0])
            kept when set; falls back to the export's gradient-glow
            treatment otherwise. */}
        <div style={{ position: 'relative', height: '200px', background: coverPhoto ? undefined : 'linear-gradient(160deg,#3b0764,#0d0616 70%)', overflow: 'hidden' }}>
          {coverPhoto ? (
            <img src={coverPhoto} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <div style={{ position: 'absolute', top: '-80px', left: '50%', transform: 'translateX(-50%)', width: '420px', height: '300px', background: `radial-gradient(ellipse at center, ${accent}66, transparent 65%)` }} />
          )}
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, rgba(2,0,5,0.1) 0%, rgba(2,0,5,0.85) 100%)' }} />
          <div style={{ position: 'absolute', top: 'calc(16px + env(safe-area-inset-top))', left: '20px' }}>
            <button onClick={onBack} style={{ background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(6px)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
              <ArrowLeft size={16} color="#fff" />
            </button>
          </div>
          {/* No real "save/favorite provider" capability exists in the
              backend -- the export's heart icon isn't reproduced here
              rather than wiring it to nothing. */}
        </div>

        {/* Floating profile card -- real business name, category, rating
            (service_provider_ratings aggregate) and location. No verified
            checkmark: ServiceProvider has no isVerified/is_verified field
            anywhere, so that part of the export isn't reproduced either. */}
        <div style={{ position: 'relative', margin: '-40px 20px 0', padding: '18px', borderRadius: '20px', background: 'rgba(20,12,30,0.85)', border: '1px solid rgba(255,255,255,0.1)', backdropFilter: 'blur(16px)' }}>
          <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-start' }}>
            <div style={{ width: '64px', height: '64px', borderRadius: '16px', background: `linear-gradient(145deg, ${accent}, #4c1d95)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px', fontWeight: 800, color: '#fff', flexShrink: 0, boxShadow: '0 0 0 3px rgba(8,5,15,0.9)', overflow: 'hidden' }}>
              {coverPhoto ? null : provider.businessName.split(' ').map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '4px' }}>
                {(categories.length ? categories : [provider.category]).map((cat) => (
                  <span key={cat} style={{ display: 'inline-block', fontSize: '11px', fontWeight: 700, padding: '3px 10px', borderRadius: servicesRadii.pill, background: `${categoryAccents[cat] || accent}33`, color: categoryAccents[cat] || accent, border: `1px solid ${categoryAccents[cat] || accent}66` }}>
                    {cat}
                  </span>
                ))}
              </div>
              <span style={{ fontSize: '17px', fontWeight: 800, color: '#f6f4f9' }}>{provider.businessName}</span>
              <div style={{ display: 'flex', gap: '10px', marginTop: '6px', fontSize: '12px', color: '#c3bdd1', flexWrap: 'wrap' }}>
                {provider.reviewCount ? (
                  <span>★ {provider.avgRating?.toFixed(1) ?? '—'} ({provider.reviewCount})</span>
                ) : (
                  <span>No reviews yet</span>
                )}
                {provider.location && <><span>•</span><span>{provider.location}</span></>}
              </div>
            </div>
          </div>
        </div>

        {/* Stat row */}
        <div style={{ display: 'flex', gap: servicesSpacing.md, padding: `${servicesSpacing.lg}px` }}>
          <StatTile icon={MapPin} label="Location" value={provider.location || 'Not specified'} />
          <StatTile icon={Tag} label="Starting Price" value={priceLabel} />
          <StatTile icon={Zap} label="Offers" value={badgeLabels.length ? badgeLabels.join(', ') : 'Standard'} />
        </div>

        {/* Services / About / Reviews tab strip (SV3) */}
        <div style={{ display: 'flex', margin: `0 ${servicesSpacing.lg}px ${servicesSpacing.lg}px`, borderBottom: `1px solid ${servicesColors.border}` }}>
          {([
            { key: 'services', label: 'Services' },
            { key: 'about', label: 'About' },
            { key: 'reviews', label: 'Reviews' },
          ] as const).map((t) => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              style={{
                flex: 1, textAlign: 'center', padding: '0 0 12px', background: 'none', border: 'none', cursor: 'pointer',
                fontSize: '13.5px', fontWeight: 700,
                color: activeTab === t.key ? servicesColors.textPrimary : servicesColors.textSecondary,
                borderBottom: activeTab === t.key ? `2px solid ${accent}` : '2px solid transparent',
                marginBottom: '-1px',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {activeTab === 'services' && (
          <>
            {services && services.length > 0 ? (
              <div style={{ padding: `0 ${servicesSpacing.lg}px ${servicesSpacing.lg}px` }}>
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
                            {svc.description && <p style={{ color: servicesColors.textSecondary, fontSize: '12px', margin: '4px 0 0', lineHeight: 1.5 }}>{svc.description}</p>}
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
                          {formatServiceAmount(svc.price, svc.currency)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div style={{ margin: `0 ${servicesSpacing.lg}px ${servicesSpacing.lg}px`, padding: '20px', textAlign: 'center' }}>
                <p style={{ color: servicesColors.textSecondary, fontSize: '13px', margin: 0 }}>This provider hasn't listed priced services yet.</p>
              </div>
            )}
          </>
        )}

        {activeTab === 'about' && (
          <>
            {provider.description && (
              <div style={{ padding: `0 ${servicesSpacing.lg}px ${servicesSpacing.lg}px` }}>
                <p style={{ color: servicesColors.textSecondary, fontSize: '14px', lineHeight: 1.6, margin: 0 }}>{provider.description}</p>
              </div>
            )}
            {provider.servicesOffered.length > 0 && (
              <div style={{ padding: `0 ${servicesSpacing.lg}px ${servicesSpacing.lg}px` }}>
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
              <div style={{ padding: `0 ${servicesSpacing.lg}px ${servicesSpacing.lg}px` }}>
                <p style={{ color: servicesColors.textSecondary, fontSize: '11px', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.06em', margin: '0 0 10px' }}>Photos</p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  {provider.photoUrls.slice(1).map((url, i) => (
                    <img key={i} src={url} alt="" style={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'cover', borderRadius: servicesRadii.sm }} />
                  ))}
                </div>
              </div>
            )}
            {!provider.description && provider.servicesOffered.length === 0 && provider.photoUrls.length <= 1 && (
              <div style={{ margin: `0 ${servicesSpacing.lg}px ${servicesSpacing.lg}px`, padding: '20px', textAlign: 'center' }}>
                <p style={{ color: servicesColors.textSecondary, fontSize: '13px', margin: 0 }}>This provider hasn't added an About section yet.</p>
              </div>
            )}
          </>
        )}

        {activeTab === 'reviews' && (
          <>
            {/* Handoff SV3: the export's Reviews tab shows individual named
                review quotes, but the schema only stores an AGGREGATE
                (service_provider_ratings: avg_rating, review_count) -- no
                per-review text/reviewer is fetchable anywhere. Showing the
                real aggregate honestly, rather than inventing reviewer
                names and quotes to visually match the mockup. */}
            {provider.reviewCount ? (
              <div style={{ margin: `0 ${servicesSpacing.lg}px ${servicesSpacing.lg}px`, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ color: '#FCD34D', fontSize: '14px', fontWeight: 700 }}>★ {provider.avgRating?.toFixed(1) ?? '—'}</span>
                <span style={{ color: servicesColors.textSecondary, fontSize: '13px' }}>({provider.reviewCount} review{provider.reviewCount === 1 ? '' : 's'})</span>
              </div>
            ) : (
              <div style={{ margin: `0 ${servicesSpacing.lg}px ${servicesSpacing.lg}px`, display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '14px', borderRadius: servicesRadii.lg, background: 'rgba(255,255,255,0.04)', border: `1px solid ${servicesColors.border}` }}>
                <span style={{ width: '18px', height: '18px', borderRadius: '50%', background: 'rgba(237,234,245,0.16)', color: '#EDEAF5', fontSize: '11px', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>i</span>
                <p style={{ color: servicesColors.textSecondary, fontSize: '13px', lineHeight: 1.5, margin: 0 }}>
                  No reviews yet for this provider — ratings only appear once real bookings are reviewed.
                </p>
              </div>
            )}
          </>
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
            <p style={{ color: servicesColors.success, fontSize: '13px', fontWeight: 700, margin: 0 }}>Booking confirmed! Check My Bookings for details.</p>
          </div>
        )}
        {bookingError && (
          <div style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: servicesRadii.md, padding: '12px 14px' }}>
            <p style={{ color: servicesColors.error, fontSize: '13px', fontWeight: 600, margin: 0 }}>{bookingError}</p>
          </div>
        )}

        {/* SV3 idle state: no services selected yet -- "Starting from ₦X" +
            a single "Book this provider" CTA, matching the export. Tapping
            it jumps to the real Services tab so the user can actually pick
            something, rather than faking an instant one-tap purchase this
            multi-service marketplace was never built to support. */}
        {selectedServices.length === 0 && (
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '11px', color: servicesColors.textSecondary }}>Starting from</div>
              <div style={{ fontSize: '16px', fontWeight: 800, color: servicesColors.textPrimary }}>{priceLabel}</div>
            </div>
            <button
              onClick={() => setActiveTab('services')}
              style={{
                flex: 2, textAlign: 'center', padding: '15px 0', borderRadius: servicesRadii.md,
                background: 'linear-gradient(135deg,#a855f7,#7c3aed)', border: 'none',
                fontWeight: 700, fontSize: '14.5px', color: '#fff', cursor: 'pointer',
                boxShadow: '0 8px 26px rgba(168,85,247,0.4)',
              }}
            >
              Book this provider
            </button>
          </div>
        )}

        {selectedServices.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 4px 0' }}>
            <span style={{ color: servicesColors.textSecondary, fontSize: '12px', fontWeight: 600 }}>
              {selectedServices.length} selected
            </span>
            <span style={{ color: servicesColors.textPrimary, fontSize: '15px', fontWeight: 700 }}>
              {formatServiceAmount(subtotal, cartCurrency)}
            </span>
          </div>
        )}

        {selectedServices.length > 0 && canPayCurrency && (
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              type="date"
              value={scheduledDate}
              onChange={(e) => setScheduledDate(e.target.value)}
              min={new Date().toISOString().slice(0, 10)}
              style={{ flex: 1, minWidth: 0, height: '44px', borderRadius: servicesRadii.md, border: `1px solid ${servicesColors.border}`, background: servicesColors.cardBgAlt, color: servicesColors.textPrimary, fontSize: '13px', fontFamily: 'Manrope, sans-serif', padding: '0 12px', colorScheme: 'dark' }}
            />
            <input
              type="time"
              value={scheduledTime}
              onChange={(e) => setScheduledTime(e.target.value)}
              style={{ flex: 1, minWidth: 0, height: '44px', borderRadius: servicesRadii.md, border: `1px solid ${servicesColors.border}`, background: servicesColors.cardBgAlt, color: servicesColors.textPrimary, fontSize: '13px', fontFamily: 'Manrope, sans-serif', padding: '0 12px', colorScheme: 'dark' }}
            />
          </div>
        )}

        {selectedServices.length > 0 && canPayCurrency && (
          <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '12px 14px', borderRadius: servicesRadii.md, background: 'rgba(96,165,250,0.09)', border: '1px solid rgba(96,165,250,0.28)' }}>
            <span style={{ width: '18px', height: '18px', borderRadius: '50%', background: '#60A5FA', color: '#06121f', fontSize: '11px', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>i</span>
            <span style={{ color: 'rgba(237,234,245,0.75)', fontSize: '12px', lineHeight: 1.5 }}>
              Services are paid in NGN through Paystack or your VENTS Wallet, regardless of the currency shown on this provider's profile.
            </span>
          </div>
        )}

        {selectedServices.length > 0 && canPayCurrency && (() => {
          const totalKobo = Math.round(subtotal * 1.05 * 100);
          const insufficientForWallet = walletBalanceKobo !== null && walletBalanceKobo < totalKobo;
          return (
            <div style={{ display: 'flex', gap: '8px' }}>
              {(['paystack', 'wallet'] as const).map((method) => (
                <button
                  key={method}
                  onClick={() => setPaymentMethod(method)}
                  disabled={method === 'wallet' && walletBalanceLoading}
                  style={{
                    flex: 1, minHeight: '44px', borderRadius: servicesRadii.md, padding: '6px',
                    border: `1px solid ${paymentMethod === method ? accent : servicesColors.border}`,
                    background: paymentMethod === method ? `${accent}22` : 'transparent',
                    color: paymentMethod === method ? accent : servicesColors.textSecondary,
                    fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '2px',
                  }}
                >
                  <span>{method === 'paystack' ? 'Card / Bank / USSD' : 'VENTS Wallet'}</span>
                  {method === 'wallet' && (
                    <span style={{ fontSize: '10px', color: insufficientForWallet ? servicesColors.error : servicesColors.textTertiary }}>
                      {walletBalanceLoading
                        ? 'Loading…'
                        : walletBalanceKobo === null
                        ? 'Unavailable'
                        : insufficientForWallet
                        ? `Insufficient (₦${(walletBalanceKobo / 100).toLocaleString('en-US')})`
                        : `₦${(walletBalanceKobo / 100).toLocaleString('en-US')} available`}
                    </span>
                  )}
                </button>
              ))}
            </div>
          );
        })()}

        {selectedServices.length > 0 && (() => {
          const totalKobo = Math.round(subtotal * 1.05 * 100);
          const walletInsufficient = canPayCurrency && paymentMethod === 'wallet' && walletBalanceKobo !== null && walletBalanceKobo < totalKobo;
          const disabled = booking || walletInsufficient;
          return (
            <button
              onClick={handleBookAndPay}
              disabled={disabled}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
                background: 'linear-gradient(135deg, #10B981, #059669)',
                border: 'none', borderRadius: servicesRadii.md, padding: '16px',
                color: '#fff', fontSize: '16px', fontWeight: 700,
                fontFamily: 'Manrope, sans-serif', cursor: disabled ? 'not-allowed' : 'pointer',
                boxShadow: '0 8px 28px rgba(16,185,129,0.4)', opacity: disabled ? 0.7 : 1,
              }}
            >
              {booking
                ? 'Processing…'
                : walletInsufficient
                ? 'Insufficient Wallet Balance'
                : `Book & Pay ${formatServiceAmount(subtotal, cartCurrency)}`}
            </button>
          );
        })()}

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
            fontFamily: 'Manrope, sans-serif', cursor: onContactProvider ? 'pointer' : 'not-allowed',
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
