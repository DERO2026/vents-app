import { useEffect, useState } from 'react';
import { ventsColors } from '../../lib/ventsDesignTokens';
import { ArrowLeft, TrendingUp, Star, Megaphone, Clock, RefreshCw, AlertCircle } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useDesktopWideShell } from '../../lib/useDesktopWideShell';

// Creator Studio → Promotions (monitor/manage an organizer's own event
// promotions). Pairs with PromoteEventScreen.tsx, which is purchase-only --
// confirmed in the Phase 4 audit that no screen anywhere let an organizer
// see which of their events currently have an active Trending/Featured
// promotion or when it expires. This screen fills exactly that gap and
// does nothing else: no cancel/renew/refund action is offered, because no
// backend RPC for any of those exists yet (activate_event_promotion only
// ever creates a row; nothing updates or deletes one) -- adding fake
// buttons for actions the server can't actually perform would be worse
// than not having them.
//
// Query security: event_promotions' SELECT RLS policy (select_event_promotions,
// 0181) now matches every WRITE policy already on this table -- authenticated
// only, organizer_id = auth.uid() -- so the database itself, not just this
// screen's own .eq('organizer_id', currentUser.id) filter, guarantees an
// organizer can never read another organizer's promotion rows. (Prior to
// 0181 this policy was public -- "anon, authenticated ... USING (true)" --
// and this screen's ownership filter was the only thing enforcing that;
// App.tsx's Home/Explore feed now gets its public badge data from the
// get_public_event_promotion_badges RPC instead of reading this table.)
//
// Status derivation: event_promotions.status is written once at
// activation time ('active') and never updated afterward by any existing
// function (confirmed: no UPDATE ... SET status anywhere in this
// codebase's migrations) -- there is no server-side cron that flips a row
// to 'expired'. The real, authoritative signal is the same one
// App.tsx's own Home/Explore query already uses: comparing start_date/
// end_date against now(). This mirrors that exact pattern rather than
// inventing a new one -- "Active"/"Scheduled"/"Expired" are computed from
// those two real timestamps, never guessed from anything else. A
// 'pending'/'inactive' raw status value (allowed by the table's own CHECK
// constraint but never written by any current code path) is shown as-is
// rather than silently hidden, since this screen must not invent meaning
// the data doesn't have.

type PromotionPlanType = 'trending' | 'featured' | 'boosted' | string;

interface PromotionRow {
  id: string;
  event_id: string;
  plan_type: PromotionPlanType;
  start_date: string;
  end_date: string;
  status: string;
  created_at: string;
  events: { id: string; title: string | null; image_url: string | null; event_date: string | null } | null;
}

type DerivedStatus = 'active' | 'scheduled' | 'expired' | 'other';

function deriveStatus(row: PromotionRow, now: Date): DerivedStatus {
  // Only a row whose own status is still 'active' (the only value any
  // current code path ever writes) gets date-derived treatment -- a
  // 'pending'/'inactive' raw value (schema-legal, never actually
  // produced today) falls into 'other' rather than being silently
  // reinterpreted as if it were a normal active/expired promotion.
  if (row.status !== 'active') return 'other';
  const start = new Date(row.start_date).getTime();
  const end = new Date(row.end_date).getTime();
  const t = now.getTime();
  if (t < start) return 'scheduled';
  if (t > end) return 'expired';
  return 'active';
}

function planLabel(plan: PromotionPlanType): string {
  if (plan === 'trending') return 'Trending';
  if (plan === 'featured') return 'Featured';
  // 'boosted' (Spotlight) is no longer purchasable (Phase 6) but historical
  // rows with this plan_type are preserved and must still display
  // correctly, not as a blank or an error.
  if (plan === 'boosted') return 'Spotlight';
  return plan;
}

function planIcon(plan: PromotionPlanType) {
  if (plan === 'trending') return TrendingUp;
  if (plan === 'featured') return Star;
  return Megaphone;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

function formatRemaining(endIso: string, now: Date): string {
  const ms = new Date(endIso).getTime() - now.getTime();
  if (ms <= 0) return 'Ended';
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'} left`;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'} left`;
  const minutes = Math.max(1, Math.floor(ms / (60 * 1000)));
  return `${minutes} minute${minutes === 1 ? '' : 's'} left`;
}

const STATUS_META: Record<DerivedStatus, { label: string; bg: string; color: string; border: string }> = {
  active: { label: 'Active', bg: 'rgba(16,185,129,0.12)', color: ventsColors.success, border: 'rgba(16,185,129,0.3)' },
  scheduled: { label: 'Scheduled', bg: 'rgba(96,165,250,0.12)', color: ventsColors.info, border: 'rgba(96,165,250,0.3)' },
  expired: { label: 'Expired', bg: 'rgba(139,143,168,0.1)', color: ventsColors.ink3, border: 'rgba(255,255,255,0.08)' },
  other: { label: 'Unknown', bg: 'rgba(251,191,36,0.12)', color: ventsColors.pending, border: 'rgba(251,191,36,0.3)' },
};

interface PromotionsScreenProps {
  onBack: () => void;
  currentUser: { id: string } | null;
  onPromoteEvent: () => void;
  // Desktop-only Creator Studio sidebar -- same convention as
  // ManageEventsScreen.tsx/SalesAnalyticsScreen.tsx's own onNavigate prop.
  onNavigate?: (screen: 'org-dashboard' | 'manage-events' | 'sales-analytics' | 'wallet') => void;
}

export function PromotionsScreen({ onBack, currentUser, onPromoteEvent, onNavigate }: PromotionsScreenProps) {
  useDesktopWideShell();
  const [rows, setRows] = useState<PromotionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  async function load() {
    if (!currentUser?.id) { setRows([]); setLoading(false); return; }
    setLoading(true);
    setLoadError(null);
    try {
      // Explicitly scoped to the current organizer -- see this file's top
      // comment on why this filter, not the table's own SELECT policy, is
      // what keeps this screen from ever showing another organizer's rows.
      const { data, error } = await supabase
        .from('event_promotions')
        .select('id, event_id, plan_type, start_date, end_date, status, created_at, events(id, title, image_url, event_date)')
        .eq('organizer_id', currentUser.id)
        .order('start_date', { ascending: false });
      if (error) throw error;
      setRows((data as any[])?.map((r) => ({ ...r, events: Array.isArray(r.events) ? r.events[0] ?? null : r.events })) ?? []);
    } catch (err: any) {
      setLoadError(err?.message || 'Could not load your promotions.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id]);

  // Re-derive Active/Scheduled/Expired every minute while this screen is
  // open, so a promotion that expires while an organizer is looking at it
  // updates without needing a manual refresh -- no new network call, just
  // recomputing against the same already-fetched start/end dates.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(id);
  }, []);

  const sidebarItems = onNavigate
    ? [
        { key: 'overview', label: 'Overview', action: () => onNavigate('org-dashboard') },
        { key: 'events', label: 'Events', action: () => onNavigate('manage-events') },
        { key: 'sales', label: 'Sales & Analytics', action: () => onNavigate('sales-analytics') },
        { key: 'promotions', label: 'Promotions', action: undefined },
        { key: 'earnings', label: 'Earnings', action: () => onNavigate('wallet') },
      ]
    : null;

  return (
    <div style={{ background: ventsColors.bg, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <style>{`
        .promotions-cs-sidebar { display: none; }
        @media (min-width: 900px) {
          .promotions-cs-shell { display: flex; align-items: flex-start; max-width: 1200px; width: 100%; margin: 0 auto; }
          .promotions-cs-sidebar {
            display: flex; flex-direction: column; gap: 4px; width: 220px; flex: none;
            padding: 20px 14px; border-right: 1px solid rgba(255,255,255,0.07); position: sticky; top: 81px;
          }
          .promotions-cs-sidebar-item {
            display: flex; align-items: center; height: 42px; border-radius: 12px; padding: 0 12px;
            font-size: 14px; font-weight: 600; cursor: pointer; border: 1px solid transparent; background: none; text-align: left; width: 100%;
          }
          .promotions-cs-shell > main { max-width: none; margin: 0; }
        }
      `}</style>

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <button
          onClick={onBack}
          aria-label="Back"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '50%', width: '40px', height: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}
        >
          <ArrowLeft size={18} color={ventsColors.ink2} />
        </button>
        <div style={{ flex: 1 }}>
          <h1 style={{ color: ventsColors.ink1, fontSize: '20px', fontWeight: 700, fontFamily: 'Manrope, sans-serif', margin: 0 }}>Promotions</h1>
          <p style={{ color: ventsColors.ink2, fontSize: '12px', margin: 0 }}>Monitor and manage your event promotions</p>
        </div>
        <button
          onClick={onPromoteEvent}
          data-testid="promotions-promote-new"
          style={{
            background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)', border: 'none', borderRadius: '12px',
            padding: '9px 14px', color: '#fff', fontSize: '13px', fontWeight: 700, fontFamily: 'Manrope, sans-serif', cursor: 'pointer', flexShrink: 0,
          }}
        >
          + Promote
        </button>
      </div>

      <div className="promotions-cs-shell" style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
        {sidebarItems && (
          <nav className="promotions-cs-sidebar" aria-label="Creator Studio navigation">
            {sidebarItems.map((item) => (
              <button
                key={item.key}
                className="promotions-cs-sidebar-item"
                onClick={item.action}
                disabled={!item.action}
                style={
                  item.key === 'promotions'
                    ? { background: 'rgba(142,92,247,0.14)', border: '1px solid rgba(142,92,247,0.4)', color: ventsColors.white }
                    : { color: ventsColors.ink2, cursor: item.action ? 'pointer' : 'default' }
                }
              >
                {item.label}
              </button>
            ))}
          </nav>
        )}

        <main style={{ flex: 1, overflowY: 'auto', padding: '20px 16px calc(32px + env(safe-area-inset-bottom, 0px))', maxWidth: '800px', width: '100%', boxSizing: 'border-box', margin: '0 auto' }}>
          {loading ? (
            <div data-testid="promotions-loading" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', padding: '60px 0', color: ventsColors.ink2 }}>
              <RefreshCw size={22} style={{ animation: 'promotionsSpin 1s linear infinite' }} />
              <span style={{ fontSize: '13px' }}>Loading your promotions…</span>
              <style>{`@keyframes promotionsSpin { to { transform: rotate(360deg); } }`}</style>
            </div>
          ) : loadError ? (
            <div data-testid="promotions-error" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', padding: '60px 20px', textAlign: 'center' }}>
              <AlertCircle size={28} color={ventsColors.error} />
              <p style={{ color: ventsColors.ink2, fontSize: '13px', margin: 0 }}>{loadError}</p>
              <button
                onClick={load}
                style={{ background: ventsColors.surface, border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', padding: '8px 16px', color: ventsColors.ink1, fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}
              >
                Try again
              </button>
            </div>
          ) : rows.length === 0 ? (
            <div data-testid="promotions-empty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px', padding: '60px 24px', textAlign: 'center' }}>
              <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: 'rgba(142,92,247,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Megaphone size={28} color={ventsColors.accent} />
              </div>
              <div>
                <p style={{ color: ventsColors.ink1, fontSize: '16px', fontWeight: 700, margin: '0 0 4px' }}>No promotions yet</p>
                <p style={{ color: ventsColors.ink2, fontSize: '13px', margin: 0, maxWidth: '280px' }}>
                  Promote one of your live events to get more visibility with Trending or Featured placement.
                </p>
              </div>
              <button
                onClick={onPromoteEvent}
                data-testid="promotions-empty-cta"
                style={{
                  background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)', border: 'none', borderRadius: '14px',
                  padding: '12px 22px', color: '#fff', fontSize: '14px', fontWeight: 700, fontFamily: 'Manrope, sans-serif', cursor: 'pointer', marginTop: '6px',
                }}
              >
                Promote an event
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {rows.map((row) => {
                const derived = deriveStatus(row, now);
                const meta = STATUS_META[derived];
                const Icon = planIcon(row.plan_type);
                return (
                  <div
                    key={row.id}
                    data-testid={`promotion-row-${row.id}`}
                    style={{ background: ventsColors.surface, border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '16px' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px', marginBottom: '10px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                        <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: `${meta.color}20`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <Icon size={16} color={meta.color} />
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <p style={{ color: ventsColors.ink1, fontSize: '14px', fontWeight: 700, margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {row.events?.title || 'Event'}
                          </p>
                          <p style={{ color: ventsColors.ink2, fontSize: '12px', margin: 0 }}>{planLabel(row.plan_type)}</p>
                        </div>
                      </div>
                      <span
                        data-testid={`promotion-status-${row.id}`}
                        style={{ flexShrink: 0, fontSize: '11px', fontWeight: 700, padding: '4px 10px', borderRadius: '999px', background: meta.bg, color: meta.color, border: `1px solid ${meta.border}` }}
                      >
                        {meta.label}
                      </span>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', fontSize: '12px', color: ventsColors.ink2 }}>
                      <span>{formatDate(row.start_date)} – {formatDate(row.end_date)}</span>
                      {derived === 'active' && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: ventsColors.success }}>
                          <Clock size={12} /> {formatRemaining(row.end_date, now)}
                        </span>
                      )}
                      {derived === 'scheduled' && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: ventsColors.info }}>
                          <Clock size={12} /> Starts {formatDate(row.start_date)}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
