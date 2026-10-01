import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, Copy, Check, Users, Zap, Wallet, ChevronRight, Lock } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { getVcBalance, invalidateVcBalanceCache } from '../../lib/vcBalanceCache';
import { haptics } from '../../lib/haptics';
import { Sentry } from '../../lib/sentry';

const MAX_REFERRALS = 5;

interface ReferralScreenProps {
  onBack: () => void;
  currentUser: { id: string; email: string; full_name: string | null; role?: string } | null;
  /** Navigates to the real VENTS Wallet (user_wallets) screen. Shown after a
   * successful VC -> Wallet conversion so the user can see the credited
   * balance and, separately, use the existing wallet withdrawal flow. */
  onGoToWallet?: () => void;
}

interface ReferralRow {
  id: string;
  invitee_email: string;
  status: 'pending' | 'joined';
  created_at: string;
}

interface VcTransactionRow {
  id: string;
  amount: number;
  type: 'earn' | 'referral' | 'spend' | 'refund' | string;
  status: 'active' | 'pending' | 'spent' | 'cancelled' | 'expired' | string;
  earned_at: string;
  campaign_key: string | null;
  metadata: Record<string, any> | null;
}

interface TierRow {
  tier: string;
  rank: number;
  min_lifetime_vc: number;
  multiplier: string | number;
}

interface TierState {
  lifetime_earned: number;
  tier: string | null;
  multiplier: string | number;
}

const TIER_LABELS: Record<string, string> = {
  bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum', elite: 'Elite', legend: 'Legend',
};
const TIER_COLORS: Record<string, string> = {
  bronze: '#CD7F32', silver: '#C0C0C0', gold: '#FFD700', platinum: '#818CF8', elite: '#A855F7', legend: '#EC4899',
};
const GOLD_RANK = 3; // bronze=1, silver=2, gold=3, platinum=4, elite=5, legend=6

function fmtMultiplier(m: string | number): string {
  const n = typeof m === 'string' ? parseFloat(m) : m;
  return `${n.toFixed(2)}×`;
}

function campaignLabel(key: string | null): string | null {
  switch (key) {
    case 'profile_complete': return 'Profile completion';
    case 'referral_referred': return 'Joined via referral';
    case 'event_checkin': return 'Event check-in';
    case 'referral_referrer_checkin': return 'Referral check-in bonus';
    case 'referral_referrer': return 'Referral bonus';
    case 'ticket_purchase': return 'Ticket purchase';
    case 'first_ticket_purchase': return 'First ticket bonus';
    default: return null;
  }
}

export function ReferralScreen({ onBack, currentUser, onGoToWallet }: ReferralScreenProps) {
  const [referrals, setReferrals] = useState<ReferralRow[]>([]);
  const [balance, setBalance] = useState(0);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);

  // Authoritative lifetime tier/multiplier -- from vc_tier_and_multiplier_for_user(),
  // never computed or guessed on the client.
  const [tierState, setTierState] = useState<TierState | null>(null);
  const [tierLadder, setTierLadder] = useState<TierRow[]>([]);

  // Real reward-campaign amounts (vc_reward_campaigns), not hardcoded copy --
  // if the approved amounts ever change on the backend this reflects it
  // automatically instead of silently drifting out of sync.
  const [campaignAmounts, setCampaignAmounts] = useState<Record<string, number>>({});

  // Featured in People state (unrelated VC-spend feature, unchanged)
  const [featuredBusy, setFeaturedBusy] = useState(false);
  const [featuredMsg, setFeaturedMsg] = useState<string | null>(null);
  const [featuredUntil, setFeaturedUntil] = useState<string | null>(null);

  // Profile bonus state
  const [profileBonusClaimed, setProfileBonusClaimed] = useState(false);
  const [profileBonusBusy, setProfileBonusBusy] = useState(false);
  const [profileBonusMsg, setProfileBonusMsg] = useState<string | null>(null);

  const [vcActivity, setVcActivity] = useState<VcTransactionRow[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);

  // Ticket-redemption rate (app_config.vc_naira_per_1000) -- 2 VC = N1,
  // deliberately different from the 10 VC = N1 wallet-conversion rate.
  const [ngnPer1000Vc, setNgnPer1000Vc] = useState(500);

  const [convertOpen, setConvertOpen] = useState(false);

  const tierRef = useRef<HTMLDivElement | null>(null);
  const referralSectionRef = useRef<HTMLDivElement | null>(null);

  const referralCode = currentUser?.id?.slice(0, 8).toUpperCase() ?? '';
  const referralLink = `https://getvents.com/?ref=${referralCode}`;

  const loadCore = useCallback(async () => {
    if (!currentUser?.id) return;
    setLoading(true);
    try {
      const [refsRes, walletResult, userRes, bonusRes, configRes, tierRes, laddersRes, campaignsRes] = await Promise.all([
        supabase.from('referrals').select('*').eq('referrer_id', currentUser.id).order('created_at', { ascending: false }),
        getVcBalance(currentUser.id),
        supabase.from('users').select('vc_featured_until').eq('id', currentUser.id).maybeSingle(),
        supabase.from('vc_bonuses' as any).select('id').eq('user_id', currentUser.id).eq('bonus_type', 'profile_complete').maybeSingle(),
        supabase.from('app_config' as any).select('vc_naira_per_1000').maybeSingle(),
        supabase.rpc('vc_tier_and_multiplier_for_user' as any, { p_user_id: currentUser.id }),
        supabase.from('vc_badge_tiers' as any).select('tier, rank, min_lifetime_vc, multiplier').order('rank', { ascending: true }),
        supabase.from('vc_reward_campaigns' as any).select('key, amount_vc').in('key', ['profile_complete', 'referral_referred', 'event_checkin', 'referral_referrer_checkin']),
      ]);
      if (refsRes.data) setReferrals(refsRes.data);
      setBalance(walletResult?.spendable ?? 0);
      if (userRes.data) setFeaturedUntil((userRes.data as any).vc_featured_until ?? null);
      setProfileBonusClaimed(!!bonusRes.data);
      if ((configRes.data as any)?.vc_naira_per_1000 != null) {
        setNgnPer1000Vc((configRes.data as any).vc_naira_per_1000);
      }
      const tierRow = Array.isArray(tierRes.data) ? tierRes.data[0] : tierRes.data;
      if (tierRow) {
        setTierState({ lifetime_earned: tierRow.lifetime_earned ?? 0, tier: tierRow.tier ?? null, multiplier: tierRow.multiplier ?? 1 });
      }
      if (laddersRes.data) setTierLadder(laddersRes.data as TierRow[]);
      if (campaignsRes.data) {
        const map: Record<string, number> = {};
        for (const row of campaignsRes.data as any[]) map[row.key] = row.amount_vc;
        setCampaignAmounts(map);
      }
    } catch (err) {
      console.error('Failed to load VC data:', err);
      Sentry.captureException(err);
    } finally {
      setLoading(false);
    }
  }, [currentUser?.id]);

  useEffect(() => { loadCore(); }, [loadCore]);

  const loadActivity = useCallback(async () => {
    if (!currentUser?.id) return;
    setActivityLoading(true);
    try {
      const { data } = await supabase
        .from('vc_transactions')
        .select('id, amount, type, status, earned_at, campaign_key, metadata')
        .eq('user_id', currentUser.id)
        .order('earned_at', { ascending: false })
        .limit(20);
      setVcActivity(data || []);
    } catch (err) {
      console.error('Failed to load VC activity:', err);
      Sentry.captureException(err);
    } finally {
      setActivityLoading(false);
    }
  }, [currentUser?.id]);

  useEffect(() => { loadActivity(); }, [loadActivity]);

  const joinedCount = referrals.filter((r) => r.status === 'joined').length;

  async function handleCancelInvite(id: string) {
    setCancellingId(id);
    try {
      await supabase.from('referrals').delete().eq('id', id);
      setReferrals((prev) => prev.filter((r) => r.id !== id));
    } catch (err: any) {
      console.error('Could not cancel invite:', err?.message || err);
      Sentry.captureException(err?.message || err);
    } finally {
      setCancellingId(null);
      setConfirmCancel(null);
    }
  }

  async function handleClaimProfileBonus() {
    setProfileBonusBusy(true); setProfileBonusMsg(null);
    try {
      const { data, error } = await supabase.rpc('claim_profile_bonus' as any);
      if (error) throw error;
      if ((data as any)?.success) {
        invalidateVcBalanceCache();
        setProfileBonusClaimed(true);
        const award = campaignAmounts.profile_complete ?? 0;
        setBalance((prev) => prev + award);
        setProfileBonusMsg(`+${award} VC awarded!`);
      } else {
        setProfileBonusMsg((data as any)?.message || 'Not eligible yet');
      }
    } catch (err: any) {
      setProfileBonusMsg(err?.message || 'Failed. Try again.');
    } finally { setProfileBonusBusy(false); }
  }

  async function handleFeaturedInPeople() {
    setFeaturedBusy(true); setFeaturedMsg(null);
    try {
      const { error } = await supabase.rpc('feature_in_people_vc' as any);
      if (error) throw error;
      invalidateVcBalanceCache();
      setBalance((prev) => prev - 150);
      const newUntil = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      setFeaturedUntil(newUntil);
      setFeaturedMsg('You are now featured in People for 3 days!');
    } catch (err: any) {
      setFeaturedMsg(err?.message || 'Purchase failed.');
    } finally { setFeaturedBusy(false); }
  }

  function copyLink() {
    haptics.light();
    navigator.clipboard.writeText(referralLink).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }

  const isFeaturedActive = featuredUntil ? new Date(featuredUntil) > new Date() : false;
  const ticketRedemptionEstimate = Math.round((balance * ngnPer1000Vc) / 1000);

  const currentTier = tierState?.tier ?? null;
  const currentRank = currentTier ? (tierLadder.find((t) => t.tier === currentTier)?.rank ?? 0) : 0;
  const canConvert = currentRank >= GOLD_RANK;
  const nextTier = tierLadder.find((t) => t.rank === currentRank + 1) ?? null;
  const currentTierRow = tierLadder.find((t) => t.tier === currentTier) ?? null;
  const lifetimeEarned = tierState?.lifetime_earned ?? 0;
  const progressFraction = nextTier
    ? Math.max(0, Math.min(1, (lifetimeEarned - (currentTierRow?.min_lifetime_vc ?? 0)) / (nextTier.min_lifetime_vc - (currentTierRow?.min_lifetime_vc ?? 0))))
    : 1;
  const goldTierRow = tierLadder.find((t) => t.tier === 'gold');

  const referredAward = campaignAmounts.referral_referred ?? 0;
  const checkinAward = campaignAmounts.event_checkin ?? 0;
  const referrerCheckinAward = campaignAmounts.referral_referrer_checkin ?? 0;
  const profileAward = campaignAmounts.profile_complete ?? 0;
  const currentMultiplierLabel = tierState ? fmtMultiplier(tierState.multiplier) : '1.00×';

  return (
    <div style={{ background: '#08050f', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <style>{`input::placeholder{color:#555C7A;} .vc-scroll::-webkit-scrollbar{display:none;}`}</style>
      <div style={{ position: 'absolute', top: '-140px', left: '50%', transform: 'translateX(-50%)', width: '520px', height: '420px', background: 'radial-gradient(ellipse at center, rgba(168,85,247,0.35), transparent 65%)', filter: 'blur(10px)', pointerEvents: 'none' }} />
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'calc(16px + env(safe-area-inset-top)) 20px 4px', flexShrink: 0 }}>
        <button onClick={onBack} style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={16} color="#f6f4f9" />
        </button>
        <span style={{ fontSize: '12px', letterSpacing: '2px', color: '#9a93a8', fontWeight: 700 }}>VENTS CENTS</span>
        <div style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#f6f4f9', fontSize: '15px', fontWeight: 700 }}>?</div>
      </div>

      <div className="vc-scroll" style={{ position: 'relative', flex: 1, overflowY: 'auto', padding: '0 16px', maxWidth: '720px', margin: '0 auto', width: '100%', paddingBottom: 'calc(32px + env(safe-area-inset-bottom))', scrollbarWidth: 'none', boxSizing: 'border-box' }}>

        {/* Balance hero: spendable VC is the headline number. Lifetime-earned
            VC and tier are shown as clearly separate figures so spending
            never visually reads as "losing progress". */}
        <div data-testid="vc-balance-hero" style={{ marginTop: '18px', padding: '24px 20px', borderRadius: '22px', background: 'linear-gradient(135deg, rgba(168,85,247,0.22), rgba(76,29,149,0.18))', border: '1px solid rgba(168,85,247,0.32)', textAlign: 'center', boxShadow: '0 10px 40px rgba(124,58,237,0.25)', marginBottom: '14px', position: 'relative' }}>
          {currentTier && (
            <span style={{ position: 'absolute', top: '16px', right: '16px', background: TIER_COLORS[currentTier], color: currentTier === 'gold' ? '#1a1a2e' : '#fff', fontSize: '10px', fontWeight: 700, borderRadius: '20px', padding: '5px 10px', letterSpacing: '0.08em' }}>
              {TIER_LABELS[currentTier]?.toUpperCase()}
            </span>
          )}
          <div style={{ fontSize: '12px', letterSpacing: '1.5px', color: '#c3bdd1', fontWeight: 700 }}>SPENDABLE BALANCE</div>
          <div data-testid="vc-spendable-balance" style={{ fontSize: '40px', fontWeight: 900, marginTop: '8px', display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: '6px', color: '#f6f4f9', fontFamily: 'Manrope, sans-serif' }}>
            <span style={{ color: '#c084fc', fontSize: '26px' }}>◎</span>{loading ? '—' : balance.toLocaleString()}
          </div>
          <div style={{ fontSize: '12.5px', color: '#9a93a8', marginTop: '4px' }}>≈ ₦{ticketRedemptionEstimate.toLocaleString()} in ticket credit</div>

          <div style={{ display: 'flex', justifyContent: 'center', gap: '18px', marginTop: '16px', paddingTop: '14px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            <div>
              <div style={{ fontSize: '10px', letterSpacing: '1px', color: '#8B8FA8', fontWeight: 700 }}>LIFETIME EARNED</div>
              <div data-testid="vc-lifetime-earned" style={{ fontSize: '18px', fontWeight: 800, color: '#f6f4f9', marginTop: '2px' }}>{loading ? '—' : lifetimeEarned.toLocaleString()} VC</div>
            </div>
            <div style={{ width: '1px', background: 'rgba(255,255,255,0.1)' }} />
            <div>
              <div style={{ fontSize: '10px', letterSpacing: '1px', color: '#8B8FA8', fontWeight: 700 }}>MULTIPLIER</div>
              <div data-testid="vc-multiplier" style={{ fontSize: '18px', fontWeight: 800, color: '#c084fc', marginTop: '2px' }}>{currentMultiplierLabel}</div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '10px', marginTop: '18px' }}>
            <button
              onClick={() => setConvertOpen(true)}
              style={{ flex: 1, textAlign: 'center', padding: '12px 0', borderRadius: '12px', background: canConvert ? 'linear-gradient(135deg,#a855f7,#7c3aed)' : 'rgba(255,255,255,0.08)', border: canConvert ? 'none' : '1px solid rgba(255,255,255,0.14)', fontWeight: 700, fontSize: '13.5px', color: canConvert ? '#fff' : '#9a93a8', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
            >
              {!canConvert && <Lock size={12} />} Convert to Wallet
            </button>
            <button
              onClick={() => referralSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              style={{ flex: 1, textAlign: 'center', padding: '12px 0', borderRadius: '12px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.14)', fontWeight: 700, fontSize: '13.5px', color: '#f6f4f9', cursor: 'pointer' }}
            >
              Earn More
            </button>
          </div>
        </div>

        {/* Tier progress -- authoritative lifetime-earned driven, never the
            spendable balance. */}
        <div ref={tierRef} data-testid="vc-tier-progress" style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '16px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <span style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700 }}>Your Tier</span>
            {currentTier && <span style={{ color: TIER_COLORS[currentTier], fontSize: '13px', fontWeight: 700 }}>{TIER_LABELS[currentTier]} · {currentMultiplierLabel}</span>}
          </div>
          {nextTier ? (
            <>
              <div style={{ height: '8px', background: 'rgba(255,255,255,0.06)', borderRadius: '4px', overflow: 'hidden', marginBottom: '8px' }}>
                <div style={{ height: '100%', width: `${progressFraction * 100}%`, background: 'linear-gradient(90deg, #7B2FBE, #A855F7)', borderRadius: '4px', transition: 'width 0.4s ease' }} />
              </div>
              <p style={{ color: '#8B8FA8', fontSize: '12px', margin: 0 }}>
                {Math.max(0, nextTier.min_lifetime_vc - lifetimeEarned).toLocaleString()} more lifetime VC to reach{' '}
                <span style={{ color: TIER_COLORS[nextTier.tier], fontWeight: 700 }}>{TIER_LABELS[nextTier.tier]}</span> ({fmtMultiplier(nextTier.multiplier)})
              </p>
            </>
          ) : currentTier === 'legend' ? (
            <p style={{ color: '#8B8FA8', fontSize: '12px', margin: 0 }}>You've reached Legend — the highest tier.</p>
          ) : (
            <p style={{ color: '#8B8FA8', fontSize: '12px', margin: 0 }}>Earn VC to reach Bronze and unlock your first multiplier.</p>
          )}

          {/* Full tier ladder -- real thresholds/multipliers from vc_badge_tiers */}
          <div style={{ display: 'flex', gap: '6px', marginTop: '16px', overflowX: 'auto' }}>
            {tierLadder.map((t) => {
              const isCurrent = t.tier === currentTier;
              const reached = lifetimeEarned >= t.min_lifetime_vc;
              return (
                <div key={t.tier} style={{ flex: '1 0 72px', textAlign: 'center', padding: '8px 4px', borderRadius: '10px', background: isCurrent ? `${TIER_COLORS[t.tier]}1A` : 'rgba(255,255,255,0.03)', border: `1px solid ${isCurrent ? TIER_COLORS[t.tier] + '55' : 'rgba(255,255,255,0.06)'}`, opacity: reached ? 1 : 0.55 }}>
                  <div style={{ color: TIER_COLORS[t.tier], fontSize: '11px', fontWeight: 800 }}>{TIER_LABELS[t.tier]}</div>
                  <div style={{ color: '#8B8FA8', fontSize: '9.5px', marginTop: '2px' }}>{t.min_lifetime_vc.toLocaleString()}</div>
                  <div style={{ color: '#f6f4f9', fontSize: '10px', fontWeight: 700, marginTop: '1px' }}>{fmtMultiplier(t.multiplier)}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* HOW IT WORKS */}
        <p style={{ color: '#9a93a8', fontSize: '13px', letterSpacing: '1.5px', fontWeight: 700, margin: '4px 0 12px' }}>HOW IT WORKS</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
          {[
            { n: 1, title: 'Attend events', desc: 'Earn cents automatically every time you check in with a ticket.' },
            { n: 2, title: 'Refer friends', desc: 'Share your code — earn a bonus once they check in to their first event.' },
            { n: 3, title: 'Redeem for tickets', desc: 'Use cents as credit toward any ticket purchase, no minimum.' },
          ].map((st) => (
            <div key={st.n} style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '14px', padding: '13px' }}>
              <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: 'rgba(168,85,247,0.22)', color: '#c084fc', fontWeight: 800, fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{st.n}</div>
              <div>
                <div style={{ fontSize: '13.5px', fontWeight: 700, color: '#f6f4f9' }}>{st.title}</div>
                <div style={{ fontSize: '12px', color: '#9a93a8', marginTop: '3px', lineHeight: 1.4 }}>{st.desc}</div>
              </div>
            </div>
          ))}
        </div>

        {/* EARNING BREAKDOWN -- real campaign amounts; only the two
            multiplier-eligible campaigns show "x multiplier" copy. */}
        <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '16px', marginBottom: '16px' }}>
          <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', marginBottom: '12px' }}>EARNING BREAKDOWN</p>
          {[
            { label: 'Complete your profile', amount: `+${profileAward} VC`, sub: 'once, flat', icon: '✅' },
            { label: 'Friend joins with your code', amount: `+${referredAward} VC`, sub: 'they receive this, once, flat', icon: '🎉' },
            { label: 'Check in at an event', amount: `+${checkinAward} VC × multiplier`, sub: 'repeatable, every check-in', icon: '🎟️' },
            { label: "Your friend's first check-in", amount: `+${referrerCheckinAward} VC × multiplier`, sub: 'you receive this, once per referral', icon: '👥' },
          ].map((item) => (
            <div key={item.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px', gap: '10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                <span>{item.icon}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: '#C4C9E0', fontSize: '13px' }}>{item.label}</div>
                  <div style={{ color: '#555C7A', fontSize: '10.5px', marginTop: '1px' }}>{item.sub}</div>
                </div>
              </div>
              <span style={{ color: '#FFB830', fontSize: '12.5px', fontWeight: 700, whiteSpace: 'nowrap', textAlign: 'right' }}>{item.amount}</span>
            </div>
          ))}
        </div>

        {/* FEATURED IN PEOPLE (unrelated existing feature, unchanged) */}
        <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '16px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
            <Zap size={18} color="#60A5FA" />
            <span style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700 }}>Featured in People</span>
          </div>
          <p style={{ color: '#8B8FA8', fontSize: '12px', marginBottom: '12px' }}>Appear at the top of the People section in Explore for 3 days.</p>
          {isFeaturedActive && (
            <div style={{ background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.2)', borderRadius: '8px', padding: '8px 12px', marginBottom: '10px' }}>
              <p style={{ color: '#60A5FA', fontSize: '12px', fontWeight: 600 }}>Active until {new Date(featuredUntil!).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
            </div>
          )}
          {featuredMsg && <p style={{ color: featuredMsg.includes('now') ? '#10B981' : '#EF4444', fontSize: '12px', marginBottom: '8px' }}>{featuredMsg}</p>}
          <button
            onClick={handleFeaturedInPeople}
            disabled={featuredBusy || balance < 150}
            style={{ width: '100%', background: balance >= 150 ? 'linear-gradient(135deg, #1E40AF, #3B82F6)' : 'rgba(255,255,255,0.05)', border: 'none', borderRadius: '12px', padding: '12px', color: balance >= 150 ? '#fff' : '#555C7A', fontSize: '14px', fontWeight: 700, cursor: balance >= 150 && !featuredBusy ? 'pointer' : 'not-allowed' }}
          >
            {featuredBusy ? 'Processing…' : `${isFeaturedActive ? 'Extend 3 days' : 'Feature me'} · 150 VC`}
          </button>
        </div>

        {/* PROFILE BONUS */}
        <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '16px', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <span style={{ fontSize: '18px' }}>✅</span>
            <span style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>Complete Profile Bonus</span>
            <span style={{ marginLeft: 'auto', color: '#FFB830', fontSize: '13px', fontWeight: 700 }}>+{profileAward} VC</span>
          </div>
          <p style={{ color: '#8B8FA8', fontSize: '12px', marginBottom: '12px' }}>Add a photo, bio (10+ chars), and phone number to claim your one-time bonus.</p>
          {profileBonusMsg && <p style={{ color: profileBonusMsg.includes('+') ? '#10B981' : '#EF4444', fontSize: '12px', marginBottom: '8px' }}>{profileBonusMsg}</p>}
          <button
            onClick={handleClaimProfileBonus}
            disabled={profileBonusBusy || profileBonusClaimed}
            style={{ width: '100%', borderRadius: '12px', padding: '11px', background: profileBonusClaimed ? 'rgba(16,185,129,0.12)' : 'linear-gradient(135deg,#065F46,#10B981)', border: profileBonusClaimed ? '1px solid rgba(16,185,129,0.3)' : 'none', color: profileBonusClaimed ? '#10B981' : '#fff', fontSize: '14px', fontWeight: 700, cursor: profileBonusClaimed || profileBonusBusy ? 'default' : 'pointer' }}
          >
            {profileBonusClaimed ? '✓ Bonus claimed' : profileBonusBusy ? 'Checking…' : `Claim +${profileAward} VC`}
          </button>
        </div>

        {/* REFERRAL SECTION */}
        <div ref={referralSectionRef} style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '16px', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Users size={16} color="#A855F7" />
              <span style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>Invite Friends &amp; Earn</span>
            </div>
            <span style={{ color: '#A855F7', fontSize: '13px', fontWeight: 700 }}>{joinedCount} / {MAX_REFERRALS} joined</span>
          </div>
          <div style={{ height: '6px', background: 'rgba(255,255,255,0.06)', borderRadius: '3px', marginBottom: '8px' }}>
            <div style={{ height: '100%', width: `${(joinedCount / MAX_REFERRALS) * 100}%`, background: 'linear-gradient(90deg, #7B2FBE, #A855F7)', borderRadius: '3px', transition: 'width 0.4s ease' }} />
          </div>
          <p style={{ color: '#8B8FA8', fontSize: '12px', marginBottom: '14px', lineHeight: 1.5 }}>
            Your friend gets <span style={{ color: '#FFB830', fontWeight: 700 }}>{referredAward} VC</span> for joining. Once they check into their first event, you get{' '}
            <span style={{ color: '#FFB830', fontWeight: 700 }}>{referrerCheckinAward} VC × your multiplier</span>.
          </p>

          <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', marginBottom: '6px' }}>YOUR REFERRAL LINK</p>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
            <div style={{ flex: 1, background: '#090514', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '10px', padding: '10px 12px', color: '#8B8FA8', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {referralLink}
            </div>
            <button onClick={copyLink} style={{ background: copied ? 'rgba(16,185,129,0.12)' : 'rgba(168,85,247,0.12)', border: `1px solid ${copied ? 'rgba(16,185,129,0.3)' : 'rgba(168,85,247,0.3)'}`, borderRadius: '10px', padding: '10px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', color: copied ? '#10B981' : '#A855F7', fontSize: '12px', fontWeight: 700, flexShrink: 0 }}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>

        {!loading && referrals.length > 0 && (
          <div>
            <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', marginBottom: '8px' }}>YOUR INVITES</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {confirmCancel && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '24px' }}>
                  <div style={{ background: '#090514', borderRadius: '20px', padding: '24px', maxWidth: '320px', width: '100%', border: '1px solid rgba(239,68,68,0.2)' }}>
                    <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700, marginBottom: '8px' }}>Cancel invite?</p>
                    <p style={{ color: '#8B8FA8', fontSize: '13px', marginBottom: '20px' }}>This slot will not be returned. The invite will be removed.</p>
                    <div style={{ display: 'flex', gap: '10px' }}>
                      <button onClick={() => setConfirmCancel(null)} style={{ flex: 1, background: 'none', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', padding: '10px', color: '#8B8FA8', cursor: 'pointer', fontSize: '13px' }}>Keep</button>
                      <button onClick={() => handleCancelInvite(confirmCancel)} disabled={!!cancellingId} style={{ flex: 1, background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '12px', padding: '10px', color: '#EF4444', cursor: 'pointer', fontSize: '13px', fontWeight: 700 }}>
                        {cancellingId ? '...' : 'Cancel Invite'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {referrals.map((ref) => (
                <div key={ref.id} style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '12px', padding: '12px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ref.invitee_email}</p>
                    <p style={{ color: '#555C7A', fontSize: '11px', marginTop: '2px' }}>{new Date(ref.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</p>
                  </div>
                  {ref.status === 'pending' ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                      <span style={{ background: 'rgba(245,158,11,0.1)', color: '#F59E0B', border: '1px solid rgba(245,158,11,0.25)', borderRadius: '8px', padding: '3px 10px', fontSize: '11px', fontWeight: 700 }}>Pending</span>
                      <button onClick={() => setConfirmCancel(ref.id)} style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '8px', padding: '3px 8px', color: '#EF4444', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
                    </div>
                  ) : (
                    <span style={{ background: 'rgba(16,185,129,0.1)', color: '#10B981', border: '1px solid rgba(16,185,129,0.25)', borderRadius: '8px', padding: '3px 10px', fontSize: '11px', fontWeight: 700, flexShrink: 0 }}>Joined</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ACTIVITY -- real vc_transactions rows, clearly distinguishing
            earned / spent / converted-to-wallet / reversed. */}
        <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', margin: '20px 0 8px' }}>ACTIVITY</p>
        {!activityLoading && vcActivity.length === 0 && (
          <div style={{ padding: '36px 20px', borderRadius: '16px', background: 'rgba(255,255,255,0.03)', border: '1px dashed rgba(255,255,255,0.12)', textAlign: 'center' }}>
            <div style={{ fontSize: '30px' }}>◎</div>
            <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700, marginTop: '10px' }}>No activity yet</p>
            <p style={{ color: '#8B8FA8', fontSize: '12px', marginTop: '6px', lineHeight: 1.4 }}>Attend an event or invite a friend to start earning Vents Cents.</p>
          </div>
        )}
        {vcActivity.length > 0 && (
          <div data-testid="vc-activity-list" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {vcActivity.map((a) => {
              const isConversion = a.type === 'spend' && a.metadata?.reason === 'vc_to_wallet_conversion';
              const isRefund = a.type === 'refund';
              const isDebit = a.type === 'spend';
              const title = isConversion
                ? 'Converted to VENTS Wallet'
                : isRefund ? 'Refunded'
                : campaignLabel(a.campaign_key) || (isDebit ? 'Redeemed' : a.type === 'referral' ? 'Referral bonus' : 'Earned');
              const icon = isConversion ? '🏦' : isRefund ? '↩' : isDebit ? '◎' : '✓';
              const statusColor = a.status === 'active' || a.status === 'spent' ? '#34D399' : a.status === 'pending' ? '#FBBF24' : '#8B8FA8';
              return (
                <div key={a.id} data-testid="vc-activity-row" style={{ display: 'flex', alignItems: 'center', gap: '12px', background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '14px', padding: '12px' }}>
                  <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: isConversion ? 'rgba(96,165,250,0.18)' : 'rgba(168,85,247,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', flexShrink: 0 }}>{icon}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: '#F0F0FF', fontSize: '13.5px', fontWeight: 700 }}>{title}</div>
                    <div style={{ color: '#8B8FA8', fontSize: '11.5px', marginTop: '2px' }}>
                      {new Date(a.earned_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      {isConversion && typeof a.metadata?.wallet_credit_kobo === 'number' ? ` · ₦${(a.metadata.wallet_credit_kobo / 100).toLocaleString()} to Wallet` : ''}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ color: isDebit ? '#F0F0FF' : '#34D399', fontSize: '13.5px', fontWeight: 800 }}>{isDebit ? '-' : '+'}{a.amount}</div>
                    <div style={{ color: statusColor, fontSize: '10.5px', fontWeight: 700, letterSpacing: '0.5px', marginTop: '2px', textTransform: 'uppercase' }}>{a.status}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {convertOpen && (
        <ConvertToWalletModal
          spendableBalance={balance}
          canConvert={canConvert}
          currentTier={currentTier}
          lifetimeEarned={lifetimeEarned}
          goldMinimum={goldTierRow?.min_lifetime_vc ?? 4000}
          onClose={() => setConvertOpen(false)}
          onConverted={(creditedVc) => {
            setBalance((prev) => prev - creditedVc);
            invalidateVcBalanceCache();
            loadActivity();
          }}
          onGoToWallet={onGoToWallet}
        />
      )}
    </div>
  );
}

const MIN_CONVERSION_VC = 10000;
const CONVERSION_RATE_LABEL = '10 VC = ₦1';

type ConvertStep = 'amount' | 'confirm' | 'converting' | 'success' | 'error';

function ConvertToWalletModal({
  spendableBalance, canConvert, currentTier, lifetimeEarned, goldMinimum, onClose, onConverted, onGoToWallet,
}: {
  spendableBalance: number;
  canConvert: boolean;
  currentTier: string | null;
  lifetimeEarned: number;
  goldMinimum: number;
  onClose: () => void;
  onConverted: (creditedVc: number) => void;
  onGoToWallet?: () => void;
}) {
  const [amountStr, setAmountStr] = useState('');
  const [step, setStep] = useState<ConvertStep>('amount');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successResult, setSuccessResult] = useState<{ vc_amount: number; wallet_credit_naira: number } | null>(null);
  const idempotencyKeyRef = useRef<string>(crypto.randomUUID());

  const amount = parseInt(amountStr.replace(/[^0-9]/g, ''), 10) || 0;
  const isDivisibleBy10 = amount % 10 === 0;
  const meetsMinimum = amount >= MIN_CONVERSION_VC;
  const hasSufficientBalance = amount <= spendableBalance;
  const naira = isDivisibleBy10 ? amount / 10 : null;

  let validationError: string | null = null;
  if (amountStr.trim() !== '' && amount <= 0) validationError = 'Enter a valid VC amount.';
  else if (amountStr.trim() !== '' && !isDivisibleBy10) validationError = 'Amount must be a multiple of 10 VC.';
  else if (amountStr.trim() !== '' && !meetsMinimum) validationError = `Minimum conversion is ${MIN_CONVERSION_VC.toLocaleString()} VC.`;
  else if (amountStr.trim() !== '' && !hasSufficientBalance) validationError = 'Insufficient Vents Cents balance.';

  const canProceed = canConvert && amount > 0 && isDivisibleBy10 && meetsMinimum && hasSufficientBalance;

  async function runConversion() {
    setStep('converting');
    setErrorMsg(null);
    try {
      const { data, error } = await supabase.rpc('convert_vc_to_wallet' as any, {
        p_vc_amount: amount,
        p_idempotency_key: idempotencyKeyRef.current,
      });
      if (error) throw error;
      const result = data as { converted: boolean; vc_amount: number; wallet_credit_naira: number };
      if (!result?.converted) {
        // Backend did not confirm success -- never show a success state.
        setErrorMsg('Conversion could not be completed. Please try again.');
        setStep('error');
        return;
      }
      setSuccessResult({ vc_amount: result.vc_amount, wallet_credit_naira: result.wallet_credit_naira });
      onConverted(result.vc_amount);
      setStep('success');
    } catch (err: any) {
      const msg: string = err?.message || '';
      const isNetworkIssue = !msg || /network|fetch|timeout|timed out/i.test(msg);
      setErrorMsg(isNetworkIssue
        ? 'Connection issue — your request may not have gone through. Tap Retry; this is safe and will not double-convert.'
        : msg);
      setStep('error');
      // Deliberately do NOT regenerate idempotencyKeyRef here -- a retry
      // (including after a timeout) must reuse the same key so the backend
      // treats it as the same request, never a second conversion.
    }
  }

  function startOver() {
    idempotencyKeyRef.current = crypto.randomUUID();
    setAmountStr('');
    setErrorMsg(null);
    setSuccessResult(null);
    setStep('amount');
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 200 }} onClick={step === 'converting' ? undefined : onClose}>
      <div
        data-testid="convert-to-wallet-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ background: '#0d0818', borderTopLeftRadius: '24px', borderTopRightRadius: '24px', width: '100%', maxWidth: '480px', padding: '24px 20px calc(24px + env(safe-area-inset-bottom))', border: '1px solid rgba(168,85,247,0.25)', borderBottom: 'none', maxHeight: '88vh', overflowY: 'auto' }}
      >
        <div style={{ width: '36px', height: '4px', background: 'rgba(255,255,255,0.2)', borderRadius: '2px', margin: '0 auto 20px' }} />

        {!canConvert ? (
          <div style={{ textAlign: 'center', padding: '12px 0' }}>
            <Lock size={28} color="#A855F7" style={{ marginBottom: '12px' }} />
            <p style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 700, marginBottom: '8px' }}>Unlocks at Gold</p>
            <p style={{ color: '#8B8FA8', fontSize: '13px', lineHeight: 1.5, marginBottom: '16px' }}>
              Converting Vents Cents to your VENTS Wallet requires Gold tier or higher.
              You currently have <span style={{ color: '#f6f4f9', fontWeight: 700 }}>{lifetimeEarned.toLocaleString()}</span> lifetime VC
              {currentTier ? <> ({TIER_LABELS[currentTier]})</> : null} — Gold starts at <span style={{ color: '#FFD700', fontWeight: 700 }}>{goldMinimum.toLocaleString()}</span> lifetime VC.
            </p>
            <button onClick={onClose} style={{ width: '100%', padding: '13px', borderRadius: '12px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.14)', color: '#F0F0FF', fontWeight: 700, fontSize: '14px', cursor: 'pointer' }}>Got it</button>
          </div>
        ) : step === 'amount' ? (
          <>
            <p style={{ color: '#F0F0FF', fontSize: '17px', fontWeight: 800, marginBottom: '4px' }}>Convert to VENTS Wallet</p>
            <p style={{ color: '#8B8FA8', fontSize: '12.5px', marginBottom: '18px' }}>Rate {CONVERSION_RATE_LABEL} · Minimum {MIN_CONVERSION_VC.toLocaleString()} VC</p>

            <label style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em' }}>VC AMOUNT</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(255,255,255,0.04)', border: `1px solid ${validationError ? 'rgba(239,68,68,0.4)' : 'rgba(255,255,255,0.1)'}`, borderRadius: '12px', padding: '12px 14px', marginTop: '6px' }}>
              <span style={{ color: '#c084fc', fontSize: '16px' }}>◎</span>
              <input
                data-testid="convert-amount-input"
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder={`${MIN_CONVERSION_VC}`}
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value.replace(/[^0-9]/g, ''))}
                style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: '#f6f4f9', fontSize: '18px', fontWeight: 700 }}
              />
              <button onClick={() => setAmountStr(String(spendableBalance - (spendableBalance % 10)))} style={{ background: 'rgba(168,85,247,0.15)', border: 'none', borderRadius: '8px', padding: '5px 10px', color: '#c084fc', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>MAX</button>
            </div>
            <p style={{ color: '#555C7A', fontSize: '11px', marginTop: '6px' }}>Available: {spendableBalance.toLocaleString()} VC</p>

            {validationError && <p data-testid="convert-validation-error" style={{ color: '#EF4444', fontSize: '12.5px', marginTop: '10px' }}>{validationError}</p>}

            {naira !== null && meetsMinimum && hasSufficientBalance && (
              <div data-testid="convert-naira-preview" style={{ background: 'rgba(168,85,247,0.08)', border: '1px solid rgba(168,85,247,0.2)', borderRadius: '12px', padding: '12px 14px', marginTop: '14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: '#8B8FA8', fontSize: '12.5px' }}>You'll receive</span>
                <span style={{ color: '#f6f4f9', fontSize: '17px', fontWeight: 800 }}>₦{naira.toLocaleString()}</span>
              </div>
            )}

            <button
              data-testid="convert-continue-button"
              disabled={!canProceed}
              onClick={() => setStep('confirm')}
              style={{ width: '100%', padding: '14px', borderRadius: '12px', marginTop: '20px', background: canProceed ? 'linear-gradient(135deg,#a855f7,#7c3aed)' : 'rgba(255,255,255,0.06)', border: 'none', color: canProceed ? '#fff' : '#555C7A', fontWeight: 700, fontSize: '14.5px', cursor: canProceed ? 'pointer' : 'not-allowed' }}
            >
              Continue
            </button>
            <button onClick={onClose} style={{ width: '100%', padding: '12px', marginTop: '8px', background: 'none', border: 'none', color: '#8B8FA8', fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
          </>
        ) : step === 'confirm' ? (
          <>
            <p style={{ color: '#F0F0FF', fontSize: '17px', fontWeight: 800, marginBottom: '18px' }}>Confirm conversion</p>
            <div data-testid="convert-confirm-summary" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '14px', padding: '18px' }}>
              <div style={{ textAlign: 'center', marginBottom: '14px' }}>
                <p style={{ color: '#8B8FA8', fontSize: '12px', marginBottom: '4px' }}>You are converting</p>
                <p style={{ color: '#f6f4f9', fontSize: '26px', fontWeight: 900 }}>◎ {amount.toLocaleString()} VC</p>
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', margin: '8px 0' }}><ChevronRight size={18} color="#555C7A" style={{ transform: 'rotate(90deg)' }} /></div>
              <div style={{ textAlign: 'center' }}>
                <p style={{ color: '#8B8FA8', fontSize: '12px', marginBottom: '4px' }}>Into your VENTS Wallet</p>
                <p style={{ color: '#34D399', fontSize: '26px', fontWeight: 900 }}>₦{(amount / 10).toLocaleString()}</p>
              </div>
              <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', marginTop: '16px', paddingTop: '12px', display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#8B8FA8', fontSize: '12px' }}>Rate</span>
                <span style={{ color: '#C4C9E0', fontSize: '12px', fontWeight: 600 }}>{CONVERSION_RATE_LABEL}</span>
              </div>
            </div>
            <p style={{ color: '#8B8FA8', fontSize: '11.5px', marginTop: '12px', textAlign: 'center', lineHeight: 1.5 }}>
              This credits your VENTS Wallet balance. It does not initiate a bank transfer — withdraw from your Wallet separately whenever you'd like.
            </p>
            <button
              data-testid="convert-confirm-button"
              onClick={runConversion}
              style={{ width: '100%', padding: '14px', borderRadius: '12px', marginTop: '18px', background: 'linear-gradient(135deg,#a855f7,#7c3aed)', border: 'none', color: '#fff', fontWeight: 700, fontSize: '14.5px', cursor: 'pointer' }}
            >
              Confirm Conversion
            </button>
            <button onClick={() => setStep('amount')} style={{ width: '100%', padding: '12px', marginTop: '8px', background: 'none', border: 'none', color: '#8B8FA8', fontSize: '13px', cursor: 'pointer' }}>Back</button>
          </>
        ) : step === 'converting' ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <div style={{ width: '32px', height: '32px', border: '3px solid rgba(168,85,247,0.2)', borderTopColor: '#A855F7', borderRadius: '50%', margin: '0 auto 16px', animation: 'spin 0.8s linear infinite' }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            <p style={{ color: '#8B8FA8', fontSize: '13px' }}>Converting…</p>
          </div>
        ) : step === 'success' && successResult ? (
          <div data-testid="convert-success-state" style={{ textAlign: 'center', padding: '12px 0' }}>
            <div style={{ width: '56px', height: '56px', borderRadius: '50%', background: 'rgba(52,211,153,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
              <Check size={28} color="#34D399" />
            </div>
            <p style={{ color: '#F0F0FF', fontSize: '17px', fontWeight: 800, marginBottom: '6px' }}>Conversion complete</p>
            <p style={{ color: '#8B8FA8', fontSize: '13px', marginBottom: '20px' }}>
              ◎ {successResult.vc_amount.toLocaleString()} VC converted to <span style={{ color: '#34D399', fontWeight: 700 }}>₦{successResult.wallet_credit_naira.toLocaleString()}</span> in your VENTS Wallet.
            </p>
            {onGoToWallet && (
              <button onClick={() => { onClose(); onGoToWallet(); }} style={{ width: '100%', padding: '14px', borderRadius: '12px', background: 'linear-gradient(135deg,#a855f7,#7c3aed)', border: 'none', color: '#fff', fontWeight: 700, fontSize: '14.5px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                <Wallet size={16} /> View VENTS Wallet
              </button>
            )}
            <button onClick={onClose} style={{ width: '100%', padding: '12px', marginTop: '8px', background: 'none', border: 'none', color: '#8B8FA8', fontSize: '13px', cursor: 'pointer' }}>Done</button>
          </div>
        ) : (
          <div data-testid="convert-error-state" style={{ textAlign: 'center', padding: '12px 0' }}>
            <div style={{ width: '56px', height: '56px', borderRadius: '50%', background: 'rgba(239,68,68,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
              <span style={{ color: '#EF4444', fontSize: '24px', fontWeight: 800 }}>!</span>
            </div>
            <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700, marginBottom: '8px' }}>Conversion failed</p>
            <p style={{ color: '#8B8FA8', fontSize: '13px', marginBottom: '20px', lineHeight: 1.5 }}>{errorMsg}</p>
            <button data-testid="convert-retry-button" onClick={runConversion} style={{ width: '100%', padding: '14px', borderRadius: '12px', background: 'linear-gradient(135deg,#a855f7,#7c3aed)', border: 'none', color: '#fff', fontWeight: 700, fontSize: '14.5px', cursor: 'pointer' }}>Retry</button>
            <button onClick={startOver} style={{ width: '100%', padding: '12px', marginTop: '8px', background: 'none', border: 'none', color: '#8B8FA8', fontSize: '13px', cursor: 'pointer' }}>Start over</button>
          </div>
        )}
      </div>
    </div>
  );
}
