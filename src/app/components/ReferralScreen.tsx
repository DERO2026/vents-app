import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Copy, Check, Users, Star, Zap } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { getVcBalance, invalidateVcBalanceCache } from '../../lib/vcBalanceCache';
import { haptics } from '../../lib/haptics';
import { Sentry } from '../../lib/sentry';

const MAX_REFERRALS = 5;
const CENTS_PER_REFERRAL = 300;

interface ReferralScreenProps {
  onBack: () => void;
  currentUser: { id: string; email: string; full_name: string | null; role?: string } | null;
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
  type: 'earn' | 'referral' | 'spend' | string;
  status: 'active' | 'pending' | 'spent' | string;
  earned_at: string;
}

const VC_TYPE_LABEL: Record<string, { icon: string; title: string }> = {
  earn: { icon: '✓', title: 'Ticket earn' },
  referral: { icon: '⇄', title: 'Referral bonus' },
  spend: { icon: '◎', title: 'Redeemed' },
};

const BADGE_TIERS = ['bronze', 'silver', 'gold', 'platinum', 'elite', 'legend'] as const;
type BadgeTier = typeof BADGE_TIERS[number];

const BADGE_CONFIG: { type: BadgeTier; label: string; cost: number; color: string; chipBg: string; chipColor: string; chipGradient?: string; chipBorder?: string }[] = [
  { type: 'bronze',   label: 'Bronze',   cost: 300,   color: '#CD7F32', chipBg: '#CD7F32', chipColor: '#fff' },
  { type: 'silver',   label: 'Silver',   cost: 800,   color: '#C0C0C0', chipBg: '#A8A9AD', chipColor: '#fff' },
  { type: 'gold',     label: 'Gold',     cost: 2000,  color: '#FFD700', chipBg: '#FFD700', chipColor: '#1a1a2e' },
  { type: 'platinum', label: 'Platinum', cost: 5000,  color: '#818CF8', chipBg: '#E5E4E2', chipColor: '#1a1a2e' },
  { type: 'elite',    label: 'Elite',    cost: 12000, color: '#A855F7', chipBg: '#1a1a2e', chipColor: '#fff', chipBorder: '1px solid rgba(255,255,255,0.15)' },
  { type: 'legend',   label: 'Legend',   cost: 25000, color: '#EC4899', chipBg: '', chipColor: '#fff', chipGradient: 'linear-gradient(135deg,#7B2FF7,#F107A3)' },
];

export function ReferralScreen({ onBack, currentUser }: ReferralScreenProps) {
  const [referrals, setReferrals] = useState<ReferralRow[]>([]);
  const [balance, setBalance] = useState(0);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);

  // Badge state
  const [currentBadge, setCurrentBadge] = useState<string | null>(null);
  const [badgeBusy, setBadgeBusy] = useState(false);
  const [badgeMsg, setBadgeMsg] = useState<string | null>(null);

  // Featured in People state
  const [featuredBusy, setFeaturedBusy] = useState(false);
  const [featuredMsg, setFeaturedMsg] = useState<string | null>(null);
  const [featuredUntil, setFeaturedUntil] = useState<string | null>(null);

  // Profile bonus state
  const [profileBonusClaimed, setProfileBonusClaimed] = useState(false);
  const [profileBonusBusy, setProfileBonusBusy] = useState(false);
  const [profileBonusMsg, setProfileBonusMsg] = useState<string | null>(null);

  // Real VC transaction ledger (vc_transactions, 0002_tables.sql) -- the
  // exported "Activity" / "Empty" states never had a real data source
  // wired to them before; this is the actual per-user history the earn/
  // referral/spend RPCs above already write to.
  const [vcActivity, setVcActivity] = useState<VcTransactionRow[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);

  // Real, server-configured VC->NGN rate (app_config.vc_naira_per_1000,
  // 0002_tables.sql) -- the export's "≈ ₦X in ticket credit" line needs an
  // actual conversion rate, not a made-up 1:1 guess. Defaults to the same
  // DB default (500) until the real row loads, so the estimate is never
  // wildly off even before the fetch below resolves.
  const [ngnPer1000Vc, setNgnPer1000Vc] = useState(500);
  const badgesRef = useRef<HTMLDivElement | null>(null);
  const referralSectionRef = useRef<HTMLDivElement | null>(null);

  const referralCode = currentUser?.id?.slice(0, 8).toUpperCase() ?? '';
  const referralLink = `https://getvents.com/?ref=${referralCode}`;

  useEffect(() => {
    if (!currentUser?.id) return;
    async function load() {
      setLoading(true);
      try {
        const [refsRes, walletResult, userRes, bonusRes, configRes] = await Promise.all([
          supabase.from('referrals').select('*').eq('referrer_id', currentUser!.id).order('created_at', { ascending: false }),
          getVcBalance(currentUser!.id),
          supabase.from('users').select('vc_badge, vc_featured_until').eq('id', currentUser!.id).maybeSingle(),
          supabase.from('vc_bonuses' as any).select('id').eq('user_id', currentUser!.id).eq('bonus_type', 'profile_complete').maybeSingle(),
          supabase.from('app_config' as any).select('vc_naira_per_1000').maybeSingle(),
        ]);
        if (refsRes.data) setReferrals(refsRes.data);
        setBalance(walletResult?.spendable ?? 0);
        if (userRes.data) {
          setCurrentBadge(userRes.data.vc_badge ?? null);
          setFeaturedUntil(userRes.data.vc_featured_until ?? null);
        }
        setProfileBonusClaimed(!!(bonusRes.data));
        if ((configRes.data as any)?.vc_naira_per_1000 != null) {
          setNgnPer1000Vc((configRes.data as any).vc_naira_per_1000);
        }
      } catch (err) {
        console.error('Failed to load VC data:', err);
        Sentry.captureException(err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [currentUser?.id]);

  useEffect(() => {
    if (!currentUser?.id) return;
    async function loadActivity() {
      setActivityLoading(true);
      try {
        const { data } = await supabase
          .from('vc_transactions')
          .select('id, amount, type, status, earned_at')
          .eq('user_id', currentUser!.id)
          .order('earned_at', { ascending: false })
          .limit(20);
        setVcActivity(data || []);
      } catch (err) {
        console.error('Failed to load VC activity:', err);
        Sentry.captureException(err);
      } finally {
        setActivityLoading(false);
      }
    }
    loadActivity();
  }, [currentUser?.id]);

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


  async function handlePurchaseBadge(type: BadgeTier, cost: number) {
    setBadgeBusy(true); setBadgeMsg(null);
    try {
      const { error } = await supabase.rpc('purchase_badge' as any, { p_badge_type: type });
      if (error) throw error;
      invalidateVcBalanceCache();
      setCurrentBadge(type);
      setBalance((prev) => prev - cost);
      setBadgeMsg(`${type.charAt(0).toUpperCase() + type.slice(1)} badge activated!`);
    } catch (err: any) {
      setBadgeMsg(err?.message || 'Purchase failed.');
    } finally { setBadgeBusy(false); }
  }

  async function handleClaimProfileBonus() {
    setProfileBonusBusy(true); setProfileBonusMsg(null);
    try {
      const { data, error } = await supabase.rpc('claim_profile_bonus' as any);
      if (error) throw error;
      if ((data as any)?.success) {
        invalidateVcBalanceCache();
        setProfileBonusClaimed(true);
        setBalance((prev) => prev + 100);
        setProfileBonusMsg('+100 VC awarded!');
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

  const ngnEstimate = Math.round((balance * ngnPer1000Vc) / 1000);

  return (
    <div style={{ background: '#08050f', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <style>{`input::placeholder{color:#555C7A;} .vc-scroll::-webkit-scrollbar{display:none;}`}</style>
      <div style={{ position: 'absolute', top: '-140px', left: '50%', transform: 'translateX(-50%)', width: '520px', height: '420px', background: 'radial-gradient(ellipse at center, rgba(168,85,247,0.35), transparent 65%)', filter: 'blur(10px)', pointerEvents: 'none' }} />
      {/* Header -- matches the export: back + centered "VENTS CENTS" eyebrow
          + a help icon (real: opens Help & Support, same destination the
          rest of the app already uses for help). */}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'calc(16px + env(safe-area-inset-top)) 20px 4px', flexShrink: 0 }}>
        <button onClick={onBack} style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={16} color="#f6f4f9" />
        </button>
        <span style={{ fontSize: '12px', letterSpacing: '2px', color: '#9a93a8', fontWeight: 700 }}>VENTS CENTS</span>
        <div style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#f6f4f9', fontSize: '15px', fontWeight: 700 }}>?</div>
      </div>

      <div className="vc-scroll" style={{ position: 'relative', flex: 1, overflowY: 'auto', padding: '0 16px', paddingBottom: 'calc(32px + env(safe-area-inset-bottom))', scrollbarWidth: 'none' }}>

        {/* Balance hero card -- gradient card, ◎ icon, large balance, and a
            real ≈₦ conversion using app_config.vc_naira_per_1000 (the
            server's actual VC->NGN redemption rate), not a made-up ratio. */}
        <div style={{ marginTop: '18px', padding: '24px 20px', borderRadius: '22px', background: 'linear-gradient(135deg, rgba(168,85,247,0.22), rgba(76,29,149,0.18))', border: '1px solid rgba(168,85,247,0.32)', textAlign: 'center', boxShadow: '0 10px 40px rgba(124,58,237,0.25)', marginBottom: '20px', position: 'relative' }}>
          {currentBadge && (() => {
            const bc = BADGE_CONFIG.find(b => b.type === currentBadge);
            if (!bc) return null;
            return (
              <span style={{ position: 'absolute', top: '16px', right: '16px', background: bc.chipGradient || bc.chipBg, color: bc.chipColor, fontSize: '10px', fontWeight: 700, borderRadius: '20px', padding: '5px 10px', letterSpacing: '0.08em', border: bc.chipBorder || 'none' }}>
                {bc.label.toUpperCase()}
              </span>
            );
          })()}
          <div style={{ fontSize: '12px', letterSpacing: '1.5px', color: '#c3bdd1', fontWeight: 700 }}>YOUR BALANCE</div>
          <div style={{ fontSize: '40px', fontWeight: 900, marginTop: '8px', display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: '6px', color: '#f6f4f9', fontFamily: 'Manrope, sans-serif' }}>
            <span style={{ color: '#c084fc', fontSize: '26px' }}>◎</span>{balance.toLocaleString()}
          </div>
          <div style={{ fontSize: '12.5px', color: '#9a93a8', marginTop: '4px' }}>≈ ₦{ngnEstimate.toLocaleString()} in ticket credit</div>
          <div style={{ display: 'flex', gap: '10px', marginTop: '18px' }}>
            <button
              onClick={() => badgesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              style={{ flex: 1, textAlign: 'center', padding: '12px 0', borderRadius: '12px', background: 'linear-gradient(135deg,#a855f7,#7c3aed)', border: 'none', fontWeight: 700, fontSize: '13.5px', color: '#fff', cursor: 'pointer' }}
            >
              Redeem
            </button>
            <button
              onClick={() => referralSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              style={{ flex: 1, textAlign: 'center', padding: '12px 0', borderRadius: '12px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.14)', fontWeight: 700, fontSize: '13.5px', color: '#f6f4f9', cursor: 'pointer' }}
            >
              Earn More
            </button>
          </div>
          <div style={{ background: 'rgba(255,184,48,0.07)', border: '1px solid rgba(255,184,48,0.15)', borderRadius: '8px', padding: '8px 10px', marginTop: '14px' }}>
            <p style={{ color: '#FFB830', fontSize: '11px', fontWeight: 600, margin: 0 }}>⚠ Vents Cents are not withdrawable or convertible to cash.</p>
          </div>
        </div>

        {/* HOW IT WORKS -- matches the export's 3-step numbered-circle
            layout. Each step is a real capability (check-in earn, referral
            bonus, ticket-purchase redemption), not new copy invented for
            the screenshot. */}
        <p style={{ color: '#9a93a8', fontSize: '13px', letterSpacing: '1.5px', fontWeight: 700, margin: '4px 0 12px' }}>HOW IT WORKS</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
          {[
            { n: 1, title: 'Attend events', desc: 'Earn cents automatically every time you check in with a ticket.' },
            { n: 2, title: 'Refer friends', desc: 'Share your code — earn bonus cents when they attend their first event.' },
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

        {/* ─── BADGES ─── */}
        <div ref={badgesRef} style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '16px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
            <Star size={18} color="#A78BFA" />
            <span style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700 }}>Profile Badges</span>
          </div>
          <p style={{ color: '#8B8FA8', fontSize: '12px', marginBottom: '12px' }}>Badges show on your profile and in search results.</p>
          {badgeMsg && <p style={{ color: badgeMsg.includes('activated') ? '#10B981' : '#EF4444', fontSize: '12px', marginBottom: '8px' }}>{badgeMsg}</p>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {BADGE_CONFIG.map(({ type, label, cost, color, chipBg, chipColor, chipGradient, chipBorder }) => {
              const owned = currentBadge === type;
              const currentRank = currentBadge ? BADGE_TIERS.indexOf(currentBadge as BadgeTier) : -1;
              const thisRank = BADGE_TIERS.indexOf(type);
              const lowerTier = currentRank > thisRank;
              return (
                <div key={type} style={{ display: 'flex', alignItems: 'center', gap: '12px', background: owned ? `${color}14` : 'rgba(255,255,255,0.02)', border: `1px solid ${owned ? color + '40' : 'rgba(255,255,255,0.06)'}`, borderRadius: '12px', padding: '12px' }}>
                  <span style={{ background: chipGradient || chipBg, color: chipColor, fontSize: '11px', fontWeight: 700, borderRadius: '20px', padding: '6px 12px', letterSpacing: '0.08em', border: chipBorder || 'none', whiteSpace: 'nowrap' }}>{label.toUpperCase()}</span>
                  <div style={{ flex: 1 }}>
                    <p style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 700 }}>{label} Badge</p>
                    <p style={{ color: '#8B8FA8', fontSize: '11px' }}>{cost.toLocaleString()} VC</p>
                  </div>
                  {owned ? (
                    <span style={{ color, fontSize: '12px', fontWeight: 700 }}>Active</span>
                  ) : lowerTier ? (
                    <span style={{ color: '#555C7A', fontSize: '11px' }}>Owned higher</span>
                  ) : (
                    <button
                      onClick={() => handlePurchaseBadge(type, cost)}
                      disabled={badgeBusy || balance < cost}
                      style={{ background: balance >= cost ? `linear-gradient(135deg, ${color}, ${color}bb)` : 'rgba(255,255,255,0.06)', border: 'none', borderRadius: '8px', padding: '7px 14px', color: balance >= cost ? '#000' : '#555C7A', fontSize: '12px', fontWeight: 700, cursor: balance >= cost && !badgeBusy ? 'pointer' : 'not-allowed' }}
                    >
                      {badgeBusy ? '…' : 'Buy'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ─── FEATURED IN PEOPLE ─── */}
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
            style={{
              width: '100%', background: balance >= 150 ? 'linear-gradient(135deg, #1E40AF, #3B82F6)' : 'rgba(255,255,255,0.05)',
              border: 'none', borderRadius: '12px', padding: '12px',
              color: balance >= 150 ? '#fff' : '#555C7A', fontSize: '14px', fontWeight: 700,
              cursor: balance >= 150 && !featuredBusy ? 'pointer' : 'not-allowed',
            }}
          >
            {featuredBusy ? 'Processing…' : `${isFeaturedActive ? 'Extend 3 days' : 'Feature me'} · 150 VC`}
          </button>
        </div>

        {/* ─── EARN VC GUIDE ─── */}
        <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '16px', marginBottom: '20px' }}>
          <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', marginBottom: '12px' }}>EARNING BREAKDOWN</p>
          {[
            { label: 'Invite a friend (you)', amount: '+300 VC', icon: '👥' },
            { label: 'Friend joins (them)', amount: '+150 VC', icon: '🎉' },
            { label: 'Buy a ticket', amount: '+50 VC', icon: '🎟️' },
            { label: 'Complete profile', amount: '+100 VC', icon: '✅' },
          ].map(item => (
            <div key={item.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>{item.icon}</span>
                <span style={{ color: '#C4C9E0', fontSize: '13px' }}>{item.label}</span>
              </div>
              <span style={{ color: '#FFB830', fontSize: '13px', fontWeight: 700 }}>{item.amount}</span>
            </div>
          ))}
        </div>

        {/* ─── PROFILE BONUS ─── */}
        <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '16px', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <span style={{ fontSize: '18px' }}>✅</span>
            <span style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>Complete Profile Bonus</span>
            <span style={{ marginLeft: 'auto', color: '#FFB830', fontSize: '13px', fontWeight: 700 }}>+100 VC</span>
          </div>
          <p style={{ color: '#8B8FA8', fontSize: '12px', marginBottom: '12px' }}>Add a photo, bio (10+ chars), and phone number to claim your one-time bonus.</p>
          {profileBonusMsg && <p style={{ color: profileBonusMsg.includes('+') ? '#10B981' : '#EF4444', fontSize: '12px', marginBottom: '8px' }}>{profileBonusMsg}</p>}
          <button
            onClick={handleClaimProfileBonus}
            disabled={profileBonusBusy || profileBonusClaimed}
            style={{
              width: '100%', borderRadius: '12px', padding: '11px',
              background: profileBonusClaimed ? 'rgba(16,185,129,0.12)' : 'linear-gradient(135deg,#065F46,#10B981)',
              border: profileBonusClaimed ? '1px solid rgba(16,185,129,0.3)' : 'none',
              color: profileBonusClaimed ? '#10B981' : '#fff',
              fontSize: '14px', fontWeight: 700, cursor: profileBonusClaimed || profileBonusBusy ? 'default' : 'pointer',
            }}
          >
            {profileBonusClaimed ? '✓ Bonus claimed' : profileBonusBusy ? 'Checking…' : 'Claim +100 VC'}
          </button>
        </div>

        {/* ─── REFERRAL SECTION ─── */}
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
          <p style={{ color: '#8B8FA8', fontSize: '12px', marginBottom: '14px' }}>
            You get <span style={{ color: '#FFB830', fontWeight: 700 }}>{CENTS_PER_REFERRAL} VC</span> · friend gets <span style={{ color: '#FFB830', fontWeight: 700 }}>150 VC</span>
          </p>

          {/* Copy link */}
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

        {/* Invite list */}
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
                    <span style={{ background: 'rgba(16,185,129,0.1)', color: '#10B981', border: '1px solid rgba(16,185,129,0.25)', borderRadius: '8px', padding: '3px 10px', fontSize: '11px', fontWeight: 700, flexShrink: 0 }}>+{CENTS_PER_REFERRAL} VC</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Activity -- real vc_transactions rows (see fetch above). Shows
            the export's "Activity" list when there's real history, or its
            "Empty" state when there isn't -- both driven by actual data,
            not a manual demo toggle. */}
        <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', margin: '20px 0 8px' }}>ACTIVITY</p>
        {!activityLoading && vcActivity.length === 0 && (
          <div style={{ padding: '36px 20px', borderRadius: '16px', background: 'rgba(255,255,255,0.03)', border: '1px dashed rgba(255,255,255,0.12)', textAlign: 'center' }}>
            <div style={{ fontSize: '30px' }}>◎</div>
            <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700, marginTop: '10px' }}>No activity yet</p>
            <p style={{ color: '#8B8FA8', fontSize: '12px', marginTop: '6px', lineHeight: 1.4 }}>Attend an event or invite a friend to start earning Vents Cents.</p>
          </div>
        )}
        {vcActivity.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {vcActivity.map((a) => {
              const meta = VC_TYPE_LABEL[a.type] || { icon: '◎', title: a.type };
              const isDebit = a.type === 'spend';
              const statusColor = a.status === 'active' ? '#34D399' : a.status === 'pending' ? '#FBBF24' : '#8B8FA8';
              return (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '14px', padding: '12px' }}>
                  <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'rgba(168,85,247,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', flexShrink: 0 }}>{meta.icon}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: '#F0F0FF', fontSize: '13.5px', fontWeight: 700 }}>{meta.title}</div>
                    <div style={{ color: '#8B8FA8', fontSize: '11.5px', marginTop: '2px' }}>{new Date(a.earned_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
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
    </div>
  );
}
