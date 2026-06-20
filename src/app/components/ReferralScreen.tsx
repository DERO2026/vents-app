import { useState, useEffect } from 'react';
import { ArrowLeft, Copy, Check, Gift, Users, Coins } from 'lucide-react';
import { insforge } from '../../lib/insforge';

const MAX_REFERRALS = 5;
const CENTS_PER_REFERRAL = 500; // Vents Cents earned per joined friend

interface ReferralScreenProps {
  onBack: () => void;
  currentUser: { id: string; email: string; full_name: string | null } | null;
}

interface ReferralRow {
  id: string;
  invitee_email: string;
  status: 'pending' | 'joined';
  created_at: string;
}

export function ReferralScreen({ onBack, currentUser }: ReferralScreenProps) {
  const [referrals, setReferrals] = useState<ReferralRow[]>([]);
  const [balance, setBalance] = useState(0);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [copied, setCopied] = useState(false);

  const referralCode = currentUser?.id?.slice(0, 8).toUpperCase() ?? '';
  const referralLink = `https://getvents.com/?ref=${referralCode}`;

  useEffect(() => {
    if (!currentUser?.id) return;
    async function load() {
      setLoading(true);
      try {
        const { data: refs } = await insforge.database
          .from('referrals')
          .select('*')
          .eq('referrer_id', currentUser!.id)
          .order('created_at', { ascending: false });
        if (refs) setReferrals(refs);

        const { data: wallet } = await insforge.database
          .from('vents_wallets')
          .select('balance')
          .eq('user_id', currentUser!.id)
          .maybeSingle();
        if (wallet) setBalance(wallet.balance ?? 0);
      } catch (err) {
        console.error('Failed to load referral data:', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [currentUser?.id]);

  const joinedCount = referrals.filter((r) => r.status === 'joined').length;
  const canInviteMore = referrals.length < MAX_REFERRALS;
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);

  async function handleCancelInvite(id: string) {
    setCancellingId(id);
    try {
      await insforge.database.from('referrals').delete().eq('id', id);
      setReferrals((prev) => prev.filter((r) => r.id !== id));
    } catch (err: any) {
      setSendError(err?.message || 'Could not cancel invite.');
    } finally {
      setCancellingId(null);
      setConfirmCancel(null);
    }
  }

  async function handleSendInvite() {
    if (!currentUser?.id) return;
    const email = inviteEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      setSendError('Enter a valid email address.');
      return;
    }
    if (!canInviteMore) {
      setSendError(`You've reached the ${MAX_REFERRALS}-invite limit.`);
      return;
    }
    if (referrals.some((r) => r.invitee_email === email)) {
      setSendError('You already invited this person.');
      return;
    }
    setSending(true);
    setSendError('');
    try {
      const { error } = await insforge.database
        .from('referrals')
        .insert([{ referrer_id: currentUser.id, invitee_email: email, status: 'pending' }]);
      if (error) throw error;
      setReferrals((prev) => [
        { id: Date.now().toString(), invitee_email: email, status: 'pending', created_at: new Date().toISOString() },
        ...prev,
      ]);
      setInviteEmail('');
    } catch (err: any) {
      setSendError(err?.message || 'Failed to send invite. Try again.');
    } finally {
      setSending(false);
    }
  }

  function copyLink() {
    navigator.clipboard.writeText(referralLink).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div style={{ background: '#060A12', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px' }}>
        <button
          onClick={onBack}
          style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
        >
          <ArrowLeft size={16} color="#C4C9E0" />
        </button>
        <h1 style={{ color: '#F0F0FF', fontSize: '20px', fontWeight: 700 }}>Invite Friends</h1>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px', paddingBottom: 'calc(32px + env(safe-area-inset-bottom))', scrollbarWidth: 'none' }}>

        {/* Balance card */}
        <div style={{ background: 'linear-gradient(135deg, #1A0D2E, #0D1429)', border: '1px solid rgba(168,85,247,0.25)', borderRadius: '20px', padding: '20px', marginBottom: '20px', position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', top: '-40px', right: '-40px', width: '140px', height: '140px', borderRadius: '50%', background: 'radial-gradient(circle, rgba(168,85,247,0.25) 0%, transparent 70%)' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
            <Coins size={22} color="#FFB830" />
            <span style={{ color: '#C4C9E0', fontSize: '14px', fontWeight: 600 }}>Vents Cents Balance</span>
          </div>
          <p style={{ color: '#FFB830', fontSize: '36px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif' }}>
            {balance.toLocaleString()}
            <span style={{ fontSize: '16px', color: '#8B8FA8', marginLeft: '6px' }}>VC</span>
          </p>
          <p style={{ color: '#8B8FA8', fontSize: '12px', marginTop: '6px' }}>
            Use Vents Cents for in-app discounts on tickets.
          </p>
          <div style={{ background: 'rgba(255,184,48,0.07)', border: '1px solid rgba(255,184,48,0.15)', borderRadius: '8px', padding: '8px 10px', marginTop: '10px' }}>
            <p style={{ color: '#FFB830', fontSize: '11px', fontWeight: 600 }}>⚠ Vents Cents are not withdrawable or convertible to cash.</p>
          </div>
        </div>

        {/* Progress */}
        <div style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '16px', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Users size={16} color="#A855F7" />
              <span style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>Referral Progress</span>
            </div>
            <span style={{ color: '#A855F7', fontSize: '13px', fontWeight: 700 }}>{joinedCount} / {MAX_REFERRALS} joined</span>
          </div>
          <div style={{ height: '6px', background: 'rgba(255,255,255,0.06)', borderRadius: '3px' }}>
            <div style={{ height: '100%', width: `${(joinedCount / MAX_REFERRALS) * 100}%`, background: 'linear-gradient(90deg, #7B2FBE, #A855F7)', borderRadius: '3px', transition: 'width 0.4s ease' }} />
          </div>
          <p style={{ color: '#8B8FA8', fontSize: '12px', marginTop: '8px' }}>
            Earn <span style={{ color: '#FFB830', fontWeight: 700 }}>{CENTS_PER_REFERRAL} VC</span> for each friend who joins. Up to {MAX_REFERRALS} invites total.
          </p>
        </div>

        {/* Copy link */}
        <div style={{ marginBottom: '20px' }}>
          <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', marginBottom: '8px' }}>YOUR REFERRAL LINK</p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <div style={{ flex: 1, background: '#131629', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', padding: '11px 14px', color: '#8B8FA8', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {referralLink}
            </div>
            <button
              onClick={copyLink}
              style={{ background: copied ? 'rgba(16,185,129,0.12)' : 'rgba(168,85,247,0.12)', border: `1px solid ${copied ? 'rgba(16,185,129,0.3)' : 'rgba(168,85,247,0.3)'}`, borderRadius: '12px', padding: '11px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', color: copied ? '#10B981' : '#A855F7', fontSize: '12px', fontWeight: 700, flexShrink: 0 }}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>

        {/* Send by email */}
        {canInviteMore && (
          <div style={{ marginBottom: '20px' }}>
            <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', marginBottom: '8px' }}>INVITE BY EMAIL ({MAX_REFERRALS - referrals.length} left)</p>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => { setInviteEmail(e.target.value); setSendError(''); }}
                placeholder="friend@example.com"
                style={{ flex: 1, background: '#131629', border: `1px solid ${sendError ? 'rgba(239,68,68,0.4)' : 'rgba(255,255,255,0.07)'}`, borderRadius: '12px', padding: '11px 14px', color: '#F0F0FF', fontSize: '14px', outline: 'none', fontFamily: 'Inter, sans-serif' }}
              />
              <button
                onClick={handleSendInvite}
                disabled={sending || !inviteEmail.trim()}
                style={{ background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', border: 'none', borderRadius: '12px', padding: '11px 18px', color: '#fff', fontSize: '13px', fontWeight: 700, cursor: sending ? 'default' : 'pointer', opacity: sending ? 0.6 : 1, flexShrink: 0 }}
              >
                {sending ? '...' : 'Invite'}
              </button>
            </div>
            {sendError && <p style={{ color: '#EF4444', fontSize: '12px', marginTop: '6px' }}>{sendError}</p>}
          </div>
        )}

        {/* Invite list */}
        {loading ? (
          <p style={{ color: '#8B8FA8', fontSize: '13px', textAlign: 'center', paddingTop: '20px' }}>Loading...</p>
        ) : referrals.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '32px 0' }}>
            <Gift size={40} color="#2A2D3E" />
            <p style={{ color: '#8B8FA8', fontSize: '14px', marginTop: '10px' }}>No invites sent yet.</p>
            <p style={{ color: '#555C7A', fontSize: '12px', marginTop: '4px' }}>Invite up to {MAX_REFERRALS} friends and earn Vents Cents when they join.</p>
          </div>
        ) : (
          <div>
            <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', marginBottom: '8px' }}>YOUR INVITES</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {/* Cancel confirmation overlay */}
              {confirmCancel && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '24px' }}>
                  <div style={{ background: '#131629', borderRadius: '20px', padding: '24px', maxWidth: '320px', width: '100%', border: '1px solid rgba(239,68,68,0.2)' }}>
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
                <div key={ref.id} style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '12px', padding: '12px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ref.invitee_email}</p>
                    <p style={{ color: '#555C7A', fontSize: '11px', marginTop: '2px' }}>
                      {new Date(ref.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </p>
                  </div>
                  {ref.status === 'pending' ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                      <span style={{ background: 'rgba(245,158,11,0.1)', color: '#F59E0B', border: '1px solid rgba(245,158,11,0.25)', borderRadius: '8px', padding: '3px 10px', fontSize: '11px', fontWeight: 700 }}>Pending</span>
                      <button
                        onClick={() => setConfirmCancel(ref.id)}
                        style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '8px', padding: '3px 8px', color: '#EF4444', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}
                      >Cancel</button>
                    </div>
                  ) : (
                    <span style={{ background: 'rgba(16,185,129,0.1)', color: '#10B981', border: '1px solid rgba(16,185,129,0.25)', borderRadius: '8px', padding: '3px 10px', fontSize: '11px', fontWeight: 700, flexShrink: 0 }}>
                      +{CENTS_PER_REFERRAL} VC
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
