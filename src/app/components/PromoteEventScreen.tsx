import { useState, useEffect } from 'react';
import { ArrowLeft, TrendingUp, Zap, Star, Crown, CheckCircle, Lock } from 'lucide-react';
import { formatPrice } from './data';
import { insforge } from '../../lib/insforge';

interface PromoteEventScreenProps {
  onBack: () => void;
  currentUser: { id: string; email: string; full_name: string | null; role: string } | null;
  initialEventId?: string;
  onPromoted?: () => void;
}

type Plan = 'spotlight' | 'featured' | 'trending';
type Duration = 3 | 7 | 14 | 30;

const PLANS: { id: Plan; label: string; icon: React.ElementType; color: string; price: Record<Duration, number>; perks: string[] }[] = [
  {
    id: 'spotlight',
    label: 'Spotlight Boost',
    icon: Zap,
    color: '#3B82F6',
    price: { 3: 5000, 7: 10000, 14: 18000, 30: 30000 },
    perks: ['Appear in Search results', 'Spotlight badge on event card', '2× more impressions', 'Basic analytics'],
  },
  {
    id: 'featured',
    label: 'Featured Campaign',
    icon: Star,
    color: '#A855F7',
    price: { 3: 15000, 7: 28000, 14: 48000, 30: 80000 },
    perks: ['Everything in Spotlight', 'Home screen Featured listing', 'Category featured section', 'Push notifications to users'],
  },
  {
    id: 'trending',
    label: 'Trending Boost',
    icon: Crown,
    color: '#FFB830',
    price: { 3: 35000, 7: 65000, 14: 110000, 30: 180000 },
    perks: ['Everything in Featured', 'Trending Now top placement', 'Top priority in feed ranking', 'Dedicated promotion banner'],
  },
];

const DURATIONS: { value: Duration; label: string }[] = [
  { value: 3, label: '3 Days' },
  { value: 7, label: '7 Days' },
  { value: 14, label: '14 Days' },
  { value: 30, label: '30 Days' },
];

export function PromoteEventScreen({ onBack, currentUser, initialEventId, onPromoted }: PromoteEventScreenProps) {
  if (!currentUser) {
    return (
      <div style={{ background: '#060A12', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8B8FA8', fontFamily: 'Inter, sans-serif' }}>
        Loading promotions...
      </div>
    );
  }

  const [selectedPlan, setSelectedPlan] = useState<Plan>('featured');
  const [selectedDuration, setSelectedDuration] = useState<Duration>(7);
  const [loading, setLoading] = useState(false);
  const [paid, setPaid] = useState(false);
  const [events, setEvents] = useState<any[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>(initialEventId || '');

  const plan = PLANS.find((p) => p.id === selectedPlan)!;
  const price = plan.price[selectedDuration];

  useEffect(() => {
    if (currentUser?.id) {
      fetchOrganizerEvents();
    }
  }, [currentUser, initialEventId]);

  const fetchOrganizerEvents = async () => {
    try {
      const { data, error } = await insforge.database
        .from('events')
        .select('*')
        .eq('organizer_id', currentUser.id)
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      if (data) {
        setEvents(data);
        if (data.length > 0) {
          if (initialEventId && data.some((e: any) => e.id === initialEventId)) {
            setSelectedEventId(initialEventId);
          } else {
            setSelectedEventId(data[0].id);
          }
        }
      }
    } catch (err) {
      console.error('Failed to fetch organizer events:', err);
    }
  };

  const handlePay = async () => {
    if (!selectedEventId || !currentUser) return;
    setLoading(true);
    try {
      const planTypeMap: Record<Plan, string> = {
        spotlight: 'boosted',
        featured: 'featured',
        trending: 'trending'
      };
      
      const start = new Date();
      const end = new Date();
      end.setDate(start.getDate() + selectedDuration);
      
      const { error } = await insforge.database
        .from('event_promotions')
        .insert([{
          event_id: selectedEventId,
          organizer_id: currentUser.id,
          plan_type: planTypeMap[selectedPlan],
          start_date: start.toISOString(),
          end_date: end.toISOString(),
          status: 'active'
        }]);

      if (error) throw error;
      
      setPaid(true);
      if (onPromoted) {
        onPromoted();
      }
    } catch (err) {
      console.error('Failed to save event promotion:', err);
    } finally {
      setLoading(false);
    }
  };

  if (paid) {
    return (
      <div style={{ background: '#060A12', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '32px 24px' }}>
        <div style={{ width: '80px', height: '80px', borderRadius: '50%', background: 'rgba(16,185,129,0.15)', border: '2px solid rgba(16,185,129,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '20px', boxShadow: '0 0 40px rgba(16,185,129,0.2)' }}>
          <CheckCircle size={40} color="#10B981" />
        </div>
        <h1 style={{ color: '#F0F0FF', fontSize: '24px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', marginBottom: '8px', textAlign: 'center' }}>
          Promotion Active!
        </h1>
        <p style={{ color: '#8B8FA8', fontSize: '14px', textAlign: 'center', lineHeight: 1.6, marginBottom: '8px' }}>
          Your event is now on the <span style={{ color: plan.color, fontWeight: 600 }}>{plan.label}</span> plan for {selectedDuration} days.
        </p>
        <p style={{ color: '#8B8FA8', fontSize: '13px', textAlign: 'center', marginBottom: '32px' }}>
          You'll see increased visibility and analytics in your dashboard.
        </p>
        <div style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '16px', padding: '16px', width: '100%', marginBottom: '24px' }}>
          {plan.perks.map((perk) => (
            <div key={perk} style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
              <CheckCircle size={14} color="#10B981" />
              <span style={{ color: '#C4C9E0', fontSize: '13px' }}>{perk}</span>
            </div>
          ))}
        </div>
        <button onClick={onBack} style={{ width: '100%', background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)', border: 'none', borderRadius: '16px', padding: '15px', color: '#fff', fontSize: '16px', fontWeight: 700, fontFamily: 'Space Grotesk, sans-serif', cursor: 'pointer' }}>
          Back to Dashboard
        </button>
      </div>
    );
  }

  return (
    <div style={{ background: '#060A12', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflowY: 'auto', scrollbarWidth: 'none' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px' }}>
        <button onClick={onBack} style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={16} color="#C4C9E0" />
        </button>
        <div>
          <h1 style={{ color: '#F0F0FF', fontSize: '20px', fontWeight: 700 }}>Promote Your Event</h1>
          <p style={{ color: '#8B8FA8', fontSize: '12px' }}>Get more visibility on VENTS</p>
        </div>
      </div>

      <div style={{ flex: 1, padding: '4px 16px 120px' }}>
        {/* Hero */}
        <div style={{ background: 'linear-gradient(135deg, rgba(123,47,190,0.2) 0%, rgba(79,70,229,0.15) 100%)', border: '1px solid rgba(167,139,250,0.2)', borderRadius: '20px', padding: '20px', marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ width: '52px', height: '52px', borderRadius: '14px', background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <TrendingUp size={24} color="#fff" />
          </div>
          <div>
            <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700 }}>Reach more people</p>
            <p style={{ color: '#C4C9E0', fontSize: '12px', lineHeight: 1.5 }}>Promoted events get up to 10× more views and sell 3× faster</p>
          </div>
        </div>

        {/* Select event */}
        <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 600, letterSpacing: '0.07em', marginBottom: '12px' }}>SELECT EVENT</p>
        <div style={{ marginBottom: '24px' }}>
          {events.length === 0 ? (
            <div style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '12px', padding: '14px', color: '#8B8FA8', fontSize: '13px' }}>
              No events found. Please create an event first.
            </div>
          ) : (
            <select
              value={selectedEventId}
              onChange={(e) => setSelectedEventId(e.target.value)}
              style={{
                width: '100%',
                background: '#131629',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '12px',
                padding: '12px 14px',
                color: '#F0F0FF',
                fontSize: '14px',
                outline: 'none',
                fontFamily: 'Inter, sans-serif',
              }}
            >
              {events.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Plan selector */}
        <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 600, letterSpacing: '0.07em', marginBottom: '12px' }}>CHOOSE A PLAN</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '24px' }}>
          {PLANS.map((p) => {
            const Icon = p.icon;
            const isSelected = selectedPlan === p.id;
            return (
              <div
                key={p.id}
                onClick={() => setSelectedPlan(p.id)}
                style={{
                  background: isSelected ? `${p.color}12` : '#131629',
                  border: isSelected ? `1.5px solid ${p.color}50` : '1px solid rgba(255,255,255,0.06)',
                  borderRadius: '16px',
                  padding: '16px',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '10px' }}>
                  <div style={{ width: '38px', height: '38px', borderRadius: '10px', background: `${p.color}20`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <Icon size={18} color={p.color} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700 }}>{p.label}</p>
                    <p style={{ color: p.color, fontSize: '13px', fontWeight: 600 }}>
                      From {formatPrice(p.price[3])}
                    </p>
                  </div>
                  <div style={{ width: '20px', height: '20px', borderRadius: '50%', border: isSelected ? 'none' : '2px solid rgba(255,255,255,0.2)', background: isSelected ? `linear-gradient(135deg, ${p.color}, ${p.color}aa)` : 'transparent', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {isSelected && <CheckCircle size={14} color="#fff" />}
                  </div>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {p.perks.map((perk) => (
                    <span key={perk} style={{ background: `${p.color}15`, border: `1px solid ${p.color}25`, borderRadius: '6px', padding: '3px 8px', color: '#C4C9E0', fontSize: '10px' }}>
                      {perk}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Duration selector */}
        <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 600, letterSpacing: '0.07em', marginBottom: '12px' }}>PROMOTION DURATION</p>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '24px' }}>
          {DURATIONS.map((d) => {
            const isSelected = selectedDuration === d.value;
            return (
              <button
                key={d.value}
                onClick={() => setSelectedDuration(d.value)}
                style={{
                  flex: 1,
                  background: isSelected ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)' : '#131629',
                  border: isSelected ? 'none' : '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '12px',
                  padding: '12px 6px',
                  cursor: 'pointer',
                  boxShadow: isSelected ? '0 4px 12px rgba(123,47,190,0.35)' : 'none',
                  transition: 'all 0.2s ease',
                }}
              >
                <p style={{ color: isSelected ? '#fff' : '#F0F0FF', fontSize: '13px', fontWeight: 700 }}>{d.label}</p>
                <p style={{ color: isSelected ? 'rgba(255,255,255,0.7)' : '#8B8FA8', fontSize: '11px', marginTop: '2px' }}>
                  {formatPrice(plan.price[d.value])}
                </p>
              </button>
            );
          })}
        </div>

        {/* Price summary */}
        <div style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '16px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span style={{ color: '#C4C9E0', fontSize: '13px' }}>{plan.label}</span>
            <span style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 600 }}>{formatPrice(price)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span style={{ color: '#C4C9E0', fontSize: '13px' }}>Duration</span>
            <span style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 600 }}>{selectedDuration} days</span>
          </div>
          <div style={{ height: '1px', background: 'rgba(255,255,255,0.07)', margin: '8px 0' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700 }}>Total</span>
            <span style={{ color: '#FFB830', fontSize: '18px', fontWeight: 800 }}>{formatPrice(price)}</span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
          <Lock size={12} color="#8B8FA8" />
          <span style={{ color: '#8B8FA8', fontSize: '11px' }}>Secured payment · Cancel anytime</span>
        </div>
      </div>

      {/* CTA */}
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(6,10,18,0.95)', backdropFilter: 'blur(20px)', borderTop: '1px solid rgba(255,255,255,0.08)', padding: '14px 16px 28px' }}>
        <button
          onClick={handlePay}
          disabled={loading}
          style={{
            width: '100%',
            background: loading ? 'rgba(123,47,190,0.4)' : 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
            border: 'none',
            borderRadius: '16px',
            padding: '15px',
            color: '#fff',
            fontSize: '16px',
            fontWeight: 700,
            fontFamily: 'Space Grotesk, sans-serif',
            cursor: loading ? 'not-allowed' : 'pointer',
            boxShadow: loading ? 'none' : '0 6px 24px rgba(123,47,190,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
          }}
        >
          {loading ? (
            <>
              <div style={{ width: '16px', height: '16px', borderRadius: '50%', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', animation: 'spin 0.7s linear infinite' }} />
              Processing Payment...
            </>
          ) : (
            <>
              <TrendingUp size={16} color="#fff" />
              Promote for {formatPrice(price)}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
