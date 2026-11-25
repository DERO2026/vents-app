import { useState, useEffect, useRef } from 'react';
import { ventsColors } from '../../lib/ventsDesignTokens';
import { ArrowLeft, Bell, Loader, Trash2, CheckCheck, ChevronRight, Megaphone, X } from 'lucide-react';
import { Notification } from './types';
import { supabase } from '../../lib/supabase';
import { onUserRealtime } from '../../lib/userRealtime';
import { analytics } from '../../lib/analyticsEvents';
import { ConfirmDialog } from './ConfirmDialog';
import { Sentry } from '../../lib/sentry';

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(isoString).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Announcements are delivered as ordinary notification rows -- by
// admin_send_broadcast (0188), admin_send_announcement (0191) and
// admin_publish_announcement (0222):
//   * type 'announcement' (sent to a role audience), or
//   * type 'broadcast' with icon '📢' (sent to everyone).
// The icon matters: the admin maker-checker functions (approve/
// reject_admin_action, 0004 ... 0186) also insert type 'broadcast' -- "Your
// request has been approved/rejected", icon '✅'/'❌' -- and those are admin
// notices, not announcements. Every announcement producer in the migration
// history uses '📢', so this rule classifies old and new rows alike without
// touching the admin notices or their delivery.
// Announcements get their own tab and a full-text reader, but stay in the
// one notification feed (same read state, badge, push and delete behaviour).
export const ANNOUNCEMENT_ICON = '📢';
export const ANNOUNCEMENT_FILTER = `type.eq.announcement,and(type.eq.broadcast,icon.eq.${ANNOUNCEMENT_ICON})`;
export const isAnnouncement = (n: { type: string; icon?: string | null }) =>
  n.type === 'announcement' || (n.type === 'broadcast' && n.icon === ANNOUNCEMENT_ICON);

function formatFullDate(isoString: string): string {
  return new Date(isoString).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const TYPE_COLORS: Record<string, string> = {
  reminder: ventsColors.accent,
  booking: ventsColors.success,
  promo: ventsColors.pending,
  social: ventsColors.info,
  broadcast: ventsColors.pending,
  message: ventsColors.info,
  sale: ventsColors.success,
  event_update: ventsColors.accent,
  announcement: ventsColors.pending,
};

export function NotificationsScreen({
  onBack,
  currentUser,
  onRefreshUnread,
  onRouteNotification,
  initialTab = 'all',
  focusAnnouncementId = null,
  onFocusConsumed,
}: {
  onBack: () => void;
  currentUser?: { id: string } | null;
  onRefreshUnread?: () => void;
  // The exact same function App.tsx uses to route a native push tap --
  // deliberately not reimplemented here, so an in-app tap and a push tap
  // can never resolve a notification to two different destinations.
  onRouteNotification?: (data: Record<string, any>) => void;
  // Opened from an announcement push: start on the Announcements tab and
  // open that announcement's reader once it is in the list.
  initialTab?: 'all' | 'announcements';
  focusAnnouncementId?: string | null;
  onFocusConsumed?: () => void;
}) {
  const [tab, setTab] = useState<'all' | 'announcements'>(focusAnnouncementId ? 'announcements' : initialTab);
  const [reader, setReader] = useState<Notification | null>(null);
  const [announcementUnread, setAnnouncementUnread] = useState(0);
  const focusHandledRef = useRef<string | null>(null);
  const PAGE_SIZE = 50;
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [swipe, setSwipe] = useState<{ id: string; offsetX: number } | null>(null);
  const swipeStartX = useRef<number | null>(null);
  // Press feedback only -- purely visual, no effect on markRead/routing/
  // swipe-to-delete below.
  const [pressedId, setPressedId] = useState<string | null>(null);
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const pullStartY = useRef<number | null>(null);
  // Distinct from `items.length === 0` -- previously a failed fetch just
  // logged to console and left `items` at [], rendering identically to the
  // genuine "You're all caught up" empty state below.
  const [loadError, setLoadError] = useState<string | null>(null);
  // Guards fetchNotifications against out-of-order responses: the initial
  // mount fetch and the realtime broadcast handler can both call it, and
  // aren't sequenced against each other or against an in-flight
  // markRead/markAllRead's own optimistic update — without this, a slower
  // response landing after a faster/newer one can silently revert read
  // state the user just saw change (e.g. re-show a badge as unread).
  const reqIdRef = useRef(0);

  const mapRow = (n: any): Notification => ({
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    read: n.read,
    icon: n.icon,
    time: formatRelativeTime(n.created_at),
    createdAt: n.created_at,
    push_data: n.push_data ?? null,
  });

  // Restricts a notifications query to announcements on that tab. Reads the
  // tab through a ref: the realtime listener below is registered once and
  // would otherwise keep the tab from its first render (release audit H1).
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const scoped = (q: any) => (tabRef.current === 'announcements' ? q.or(ANNOUNCEMENT_FILTER) : q);

  // Unread across every notification type (the header) -- server-side, so it
  // is right even when the list is paginated. The bell badge (App.tsx) uses
  // the same count.
  const [totalUnread, setTotalUnread] = useState<number | null>(null);
  const fetchTotalUnread = async () => {
    if (!currentUser?.id) return;
    try {
      const { count, error } = await supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', currentUser.id)
        .eq('read', false);
      if (!error && typeof count === 'number') setTotalUnread(count);
    } catch { /* falls back to the loaded rows below */ }
  };
  const refreshCounts = () => { fetchAnnouncementUnread(); fetchTotalUnread(); };

  const fetchAnnouncementUnread = async () => {
    if (!currentUser?.id) return;
    try {
      const { count, error } = await supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', currentUser.id)
        .eq('read', false)
        .or(ANNOUNCEMENT_FILTER);
      if (!error && typeof count === 'number') setAnnouncementUnread(count);
    } catch { /* tab badge only; the main badge is App's */ }
  };

  const fetchNotifications = async () => {
    if (!currentUser?.id) return;
    const myReq = ++reqIdRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const { data, error } = await scoped(supabase
        .from('notifications')
        .select('*')
        .eq('user_id', currentUser.id))
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE);

      if (error) throw error;
      if (myReq !== reqIdRef.current) return; // a newer fetch superseded this one
      if (data) {
        setHasMore(data.length === PAGE_SIZE);
        setItems(data.map(mapRow));
      }
    } catch (err) {
      console.error("Failed to fetch notifications:", err);
      Sentry.captureException(err);
      if (myReq === reqIdRef.current) setLoadError('Pull down or tap Retry to try again.');
    } finally {
      if (myReq === reqIdRef.current) setLoading(false);
    }
  };

  // Was hard-capped at 50 with no way to see anything older.
  const loadMore = async () => {
    if (!currentUser?.id || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const { data, error } = await scoped(supabase
        .from('notifications')
        .select('*')
        .eq('user_id', currentUser.id))
        .order('created_at', { ascending: false })
        .range(items.length, items.length + PAGE_SIZE - 1);

      if (error) throw error;
      if (data) {
        setHasMore(data.length === PAGE_SIZE);
        setItems((prev) => [...prev, ...data.map(mapRow)]);
      }
    } catch (err) {
      console.error("Failed to load more notifications:", err);
      Sentry.captureException(err);
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    fetchNotifications();
    refreshCounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser, tab]);

  // Escape closes the announcement reader.
  useEffect(() => {
    if (!reader) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setReader(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [reader]);

  // Announcement push tap: open its reader once the row is loaded.
  useEffect(() => {
    if (!focusAnnouncementId || focusHandledRef.current === focusAnnouncementId || loading) return;
    const match = items.find((n) => (n.push_data as any)?.announcementId === focusAnnouncementId);
    focusHandledRef.current = focusAnnouncementId;
    if (match) openReader(match);
    onFocusConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAnnouncementId, items, loading]);

  // The unread badge (App.tsx) updates live via this same channel/event;
  // this screen only fetched once per mount, so a notification arriving
  // while it was open never appeared until the user backed out and back in.
  useEffect(() => {
    if (!currentUser?.id) return;
    // My own private topic -- the server-side notify_new_notification()
    // trigger signals new_notification here. Only I can join it (0199).
    // The channel is shared with App's badge listener (userRealtime), so
    // leaving this screen only drops this handler, never the channel.
    return onUserRealtime(currentUser.id, 'new_notification', () => { fetchNotifications(); refreshCounts(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id]);

  // Header: unread across ALL notifications (server count; loaded rows until
  // it arrives). The Announcements chip carries the announcement-only count.
  const loadedUnread = items.filter((n) => !n.read).length;
  const unreadCount = totalUnread ?? (tab === 'all' ? loadedUnread : 0);
  // What "Mark all read" on this tab would change.
  const tabUnread = tab === 'announcements' ? Math.max(announcementUnread, loadedUnread) : Math.max(unreadCount, loadedUnread);

  const markAllRead = async () => {
    if (!currentUser?.id) return;
    try {
      setItems((prev) => prev.map((n) => ({ ...n, read: true })));
      const { error } = await scoped(supabase
        .from('notifications')
        .update({ read: true })
        .eq('user_id', currentUser.id)
        .eq('read', false));
      if (error) throw error;
      onRefreshUnread?.();
      refreshCounts();
    } catch (err) {
      console.error("Failed to mark all as read:", err);
      Sentry.captureException(err);
      fetchNotifications();
    }
  };

  const markRead = async (id: string) => {
    try {
      const opened = items.find((n) => n.id === id);
      if (opened && !opened.read) analytics.notificationOpened((opened as any).type);
      setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
      const { error } = await supabase
        .from('notifications')
        .update({ read: true })
        .eq('id', id);
      if (error) throw error;
      onRefreshUnread?.();
      refreshCounts();
    } catch (err) {
      console.error("Failed to mark notification as read:", err);
      Sentry.captureException(err);
      fetchNotifications();
    }
  };

  const deleteNotification = async (id: string) => {
    const prevItems = items;
    setItems((prev) => prev.filter((n) => n.id !== id));
    setSwipe(null);
    try {
      const { error } = await supabase.from('notifications').delete().eq('id', id);
      if (error) throw error;
      onRefreshUnread?.();
      refreshCounts();
    } catch (err) {
      console.error("Failed to delete notification:", err);
      Sentry.captureException(err);
      setItems(prevItems);
    }
  };

  const clearAllNotifications = async () => {
    if (!currentUser?.id || clearing) return;
    setShowClearConfirm(false);
    setClearing(true);
    const prevItems = items;
    setItems([]);
    try {
      // On the Announcements tab, "Clear all" clears announcements only.
      const { error } = await scoped(supabase.from('notifications').delete().eq('user_id', currentUser.id));
      if (error) throw error;
      onRefreshUnread?.();
      refreshCounts();
    } catch (err) {
      console.error("Failed to clear notifications:", err);
      Sentry.captureException(err);
      setItems(prevItems);
    } finally {
      setClearing(false);
    }
  };

  const openReader = (n: Notification) => {
    markRead(n.id);
    setReader(n);
  };
  // One tap handler for click and keyboard: announcements open the reader;
  // everything else keeps its existing behaviour (mark read + route).
  const activate = (notif: Notification) => {
    if (isAnnouncement(notif)) { openReader(notif); return; }
    markRead(notif.id);
    if (notif.push_data) onRouteNotification?.(notif.push_data);
  };

  const handleSwipeStart = (id: string, x: number) => {
    swipeStartX.current = x;
    setSwipe({ id, offsetX: 0 });
  };
  const handleSwipeMove = (id: string, x: number) => {
    if (swipeStartX.current === null) return;
    const delta = Math.min(0, x - swipeStartX.current); // only allow left swipe
    setSwipe({ id, offsetX: Math.max(delta, -90) });
  };
  const handleSwipeEnd = (id: string) => {
    swipeStartX.current = null;
    if (swipe && swipe.id === id && swipe.offsetX < -60) {
      deleteNotification(id);
    } else {
      setSwipe(null);
    }
  };

  return (
    <div
      className="notifications-content"
      style={{
        background: '#050208',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        fontFamily: 'Manrope, sans-serif',
      }}
      onTouchStart={(e) => { pullStartY.current = e.touches[0].clientY; }}
      onTouchEnd={(e) => {
        if (pullStartY.current === null) return;
        const dy = e.changedTouches[0].clientY - pullStartY.current;
        pullStartY.current = null;
        if (dy > 400 && !pullRefreshing) {
          setPullRefreshing(true);
          fetchNotifications().finally(() => setPullRefreshing(false));
        }
      }}
    >
      <style>{`
        @media (min-width: 900px) {
          .notifications-content > * { max-width: 640px; margin-left: auto; margin-right: auto; width: 100%; box-sizing: border-box; }
        }
      `}</style>
      {pullRefreshing && (
        <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 200 }}>
          <div style={{ width: '34px', height: '34px', borderRadius: '50%', border: '2.5px solid rgba(168,85,247,0.15)', borderTop: '2.5px solid #A855F7', animation: 'spin 0.8s linear infinite' }} />
        </div>
      )}
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px',
          position: 'relative',
        }}
      >
        <button
          onClick={onBack}
          aria-label="Back"
          style={{
            background: 'rgba(255,255,255,0.04)',
            backdropFilter: 'blur(20px) saturate(180%)',
            WebkitBackdropFilter: 'blur(20px) saturate(180%)',
            border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: '50%',
            width: '34px',
            height: '34px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <ArrowLeft size={15} color={ventsColors.ink2} />
        </button>

        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 'calc(20px + env(safe-area-inset-top))',
            bottom: '14px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            gap: '4px',
          }}
        >
          <h1
            style={{
              color: ventsColors.ink1,
              fontSize: '17px',
              fontWeight: 700,
              fontFamily: 'Manrope, sans-serif',
              margin: 0,
              letterSpacing: '0.01em',
            }}
          >
            Notifications
          </h1>
          {unreadCount > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ width: '4px', height: '4px', borderRadius: '50%', background: ventsColors.accent, boxShadow: '0 0 5px rgba(168,85,247,0.8)' }} />
              <span style={{ color: ventsColors.ink2, fontSize: '11px', letterSpacing: '0.02em' }}>
                <span data-testid="notifications-unread-total">{unreadCount} unread</span>
              </span>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', position: 'relative', zIndex: 1 }}>
          {tabUnread > 0 && (
            <button
              onClick={markAllRead}
              title={tab === 'announcements' ? 'Mark all announcements read' : 'Mark all read'}
              aria-label={tab === 'announcements' ? 'Mark all announcements read' : 'Mark all read'}
              style={{
                background: 'rgba(255,255,255,0.04)',
                backdropFilter: 'blur(20px) saturate(180%)',
                WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: '50%',
                width: '34px',
                height: '34px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <CheckCheck size={15} color={ventsColors.accentSoft} />
            </button>
          )}
          {items.length > 0 && (
            <button
              onClick={() => setShowClearConfirm(true)}
              disabled={clearing}
              title="Clear all"
              aria-label="Clear all"
              style={{
                background: 'rgba(255,255,255,0.04)',
                backdropFilter: 'blur(20px) saturate(180%)',
                WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: '50%',
                width: '34px',
                height: '34px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: clearing ? 'not-allowed' : 'pointer',
                opacity: clearing ? 0.6 : 1,
                flexShrink: 0,
              }}
            >
              <Trash2 size={14} color={ventsColors.ink2} />
            </button>
          )}
        </div>
      </div>

      {/* Tabs: everything, or announcements only. Same feed underneath. */}
      <div role="tablist" aria-label="Notification filter" style={{ display: 'flex', gap: '8px', padding: '0 16px 10px' }}>
        {([['all', 'All'], ['announcements', 'Announcements']] as const).map(([key, label]) => {
          const active = tab === key;
          return (
            <button
              key={key}
              role="tab"
              aria-selected={active}
              onClick={() => { if (!active) { setItems([]); setHasMore(false); setTab(key); } }}
              style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                padding: '7px 14px', borderRadius: '100px', fontSize: '12.5px', fontWeight: 700, cursor: 'pointer',
                background: active ? 'rgba(168,85,247,0.14)' : 'rgba(255,255,255,0.03)',
                border: active ? '1px solid rgba(168,85,247,0.35)' : '1px solid rgba(255,255,255,0.06)',
                color: active ? ventsColors.ink1 : ventsColors.ink3,
              }}
            >
              {key === 'announcements' && <Megaphone size={12} />}
              {label}
              {key === 'announcements' && announcementUnread > 0 && (
                <span data-testid="announcements-unread" aria-label={`${announcementUnread} unread announcements`} style={{ minWidth: '16px', height: '16px', padding: '0 4px', borderRadius: '8px', background: ventsColors.accent, color: '#fff', fontSize: '10px', fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                  {announcementUnread > 99 ? '99+' : announcementUnread}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* List */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '4px 16px 24px',
        }}
      >
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '150px', color: ventsColors.ink3 }}>
            <Loader size={18} className="animate-spin" />
            <span style={{ marginLeft: '10px', fontSize: '13px' }}>Loading notifications...</span>
          </div>
        ) : loadError ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              paddingTop: '96px',
              gap: '18px',
            }}
          >
            <div
              style={{
                width: '64px',
                height: '64px',
                borderRadius: '50%',
                background: 'rgba(239,68,68,0.08)',
                backdropFilter: 'blur(20px) saturate(180%)',
                WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                border: '1px solid rgba(239,68,68,0.2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Bell size={24} color={ventsColors.error} strokeWidth={1.5} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '5px' }}>
              <p style={{ color: ventsColors.ink1, fontSize: '14px', fontWeight: 600, margin: 0, fontFamily: 'Manrope, sans-serif' }}>Couldn't load your notifications</p>
              <p style={{ color: ventsColors.ink3, fontSize: '12.5px', margin: 0, textAlign: 'center', padding: '0 24px' }}>{loadError}</p>
            </div>
            <button
              onClick={fetchNotifications}
              style={{ background: 'rgba(239,68,68,0.12)', border: `1px solid ${ventsColors.error}`, borderRadius: '12px', padding: '10px 20px', color: ventsColors.error, fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}
            >
              Retry
            </button>
          </div>
        ) : items.length === 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              paddingTop: '96px',
              gap: '18px',
            }}
          >
            <div
              style={{
                width: '64px',
                height: '64px',
                borderRadius: '50%',
                background: 'rgba(255,255,255,0.03)',
                backdropFilter: 'blur(20px) saturate(180%)',
                WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                border: '1px solid rgba(255,255,255,0.06)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Bell size={24} color={ventsColors.ink3} strokeWidth={1.5} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '5px' }}>
              <p style={{ color: ventsColors.ink1, fontSize: '14px', fontWeight: 600, margin: 0, fontFamily: 'Manrope, sans-serif' }}>{tab === 'announcements' ? 'No announcements yet' : "You're all caught up"}</p>
              <p style={{ color: ventsColors.ink3, fontSize: '12.5px', margin: 0 }}>{tab === 'announcements' ? 'Important updates from VENTS will show up here' : 'New activity will show up here'}</p>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {items.map((notif) => {
              const accent = TYPE_COLORS[notif.type] ?? ventsColors.accent;
              const offsetX = swipe?.id === notif.id ? swipe.offsetX : 0;
              return (
                <div key={notif.id} style={{ position: 'relative', borderRadius: '18px', overflow: 'hidden' }}>
                  {/* Delete-reveal background — only exists in the DOM for
                      the row actually mid-swipe, rather than being rendered
                      for every row and relying solely on the parent's
                      overflow:hidden to clip it. A translated sibling can
                      get promoted to its own compositing layer in some
                      WebView versions, which has been known to ignore the
                      ancestor's overflow:hidden clip and show through —
                      not rendering it at all when idle removes that failure
                      mode entirely instead of depending on clipping. */}
                  {offsetX !== 0 && (
                    <div style={{
                      position: 'absolute', inset: 0, background: 'rgba(239,68,68,0.12)',
                      display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '0 22px',
                    }}>
                      <div
                        style={{
                          width: '32px',
                          height: '32px',
                          borderRadius: '50%',
                          background: 'rgba(255,255,255,0.04)',
                          backdropFilter: 'blur(20px) saturate(180%)',
                          WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                          border: '1px solid rgba(255,255,255,0.07)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        <Trash2 size={14} color={ventsColors.ink2} />
                      </div>
                    </div>
                  )}
                  <div
                    onClick={() => {
                      if (offsetX !== 0) return;
                      activate(notif);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault();
                      if (offsetX !== 0) return;
                      activate(notif);
                    }}
                    data-testid="notification-row"
                    role="button" tabIndex={0}
                    onTouchStart={(e) => { handleSwipeStart(notif.id, e.touches[0].clientX); setPressedId(notif.id); }}
                    onTouchMove={(e) => handleSwipeMove(notif.id, e.touches[0].clientX)}
                    onTouchEnd={() => { handleSwipeEnd(notif.id); setPressedId(null); }}
                    onMouseDown={() => setPressedId(notif.id)}
                    onMouseUp={() => setPressedId(null)}
                    onMouseLeave={() => setPressedId((id) => (id === notif.id ? null : id))}
                    style={{
                      background: notif.read ? 'rgba(255,255,255,0.025)' : 'rgba(168,85,247,0.045)',
                      backdropFilter: 'blur(20px) saturate(180%)',
                      WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                      border: notif.read
                        ? '1px solid rgba(255,255,255,0.045)'
                        : '1px solid rgba(168,85,247,0.16)',
                      borderRadius: '18px',
                      padding: '16px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '13px',
                      cursor: 'pointer',
                      position: 'relative',
                      transform: `translateX(${offsetX}px) scale(${pressedId === notif.id && offsetX === 0 ? 0.985 : 1})`,
                      opacity: pressedId === notif.id && offsetX === 0 ? 0.88 : 1,
                      transition: swipe?.id === notif.id ? 'none' : 'transform 0.15s ease, opacity 0.15s ease',
                    }}
                  >
                  {/* Icon — small and contextual, not a large colorful bubble */}
                  <div
                    style={{
                      width: '34px',
                      height: '34px',
                      borderRadius: '50%',
                      background: 'rgba(255,255,255,0.04)',
                      border: notif.read ? '1px solid rgba(255,255,255,0.06)' : `1px solid ${accent}35`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '14px',
                      flexShrink: 0,
                    }}
                  >
                    {notif.icon}
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                        marginBottom: '3px',
                        gap: '8px',
                      }}
                    >
                      <span
                        style={{
                          color: notif.read ? ventsColors.ink2 : ventsColors.ink1,
                          fontSize: '14px',
                          fontWeight: notif.read ? 500 : 650,
                          letterSpacing: '0.001em',
                        }}
                      >
                        {notif.title}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0, marginTop: '2px' }}>
                        {!notif.read && (
                          <div
                            style={{
                              width: '5px',
                              height: '5px',
                              borderRadius: '50%',
                              background: ventsColors.accent,
                              boxShadow: '0 0 4px rgba(168,85,247,0.7)',
                              flexShrink: 0,
                            }}
                          />
                        )}
                        <span
                          style={{
                            color: ventsColors.ink3,
                            fontSize: '11px',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {notif.time}
                        </span>
                      </div>
                    </div>
                    <p
                      style={{
                        color: notif.read ? ventsColors.ink3 : ventsColors.ink3,
                        fontSize: '12.5px',
                        lineHeight: 1.5,
                        margin: 0,
                        ...(isAnnouncement(notif) ? { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden' } : {}),
                      }}
                    >
                      {notif.body}
                    </p>
                  </div>

                  {/* Chevron only on notifications that actually go
                      somewhere -- an informational/non-navigational
                      notification (no push_data) shouldn't look tappable. */}
                  {(notif.push_data || isAnnouncement(notif)) && (
                    <ChevronRight size={15} color={ventsColors.ink3} style={{ flexShrink: 0 }} />
                  )}
                  </div>
                </div>
              );
            })}
            {hasMore && (
              <button
                onClick={loadMore}
                disabled={loadingMore}
                style={{
                  marginTop: '4px', padding: '13px', borderRadius: '16px',
                  background: 'rgba(255,255,255,0.03)', backdropFilter: 'blur(20px) saturate(180%)', WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                  border: '1px solid rgba(255,255,255,0.06)',
                  color: ventsColors.ink3, fontSize: '13px', fontWeight: 600,
                  cursor: loadingMore ? 'not-allowed' : 'pointer', opacity: loadingMore ? 0.6 : 1,
                }}
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            )}
          </div>
        )}
      </div>

      {reader && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Announcement"
          data-testid="announcement-reader"
          style={{ position: 'fixed', inset: 0, zIndex: 300, background: '#050208', display: 'flex', flexDirection: 'column', fontFamily: 'Manrope, sans-serif' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px', maxWidth: '640px', width: '100%', margin: '0 auto', boxSizing: 'border-box' }}>
            <button
              onClick={() => setReader(null)}
              aria-label="Close announcement"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '50%', width: '34px', height: '34px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}
            >
              <X size={15} color={ventsColors.ink2} />
            </button>
            <span style={{ display: 'flex', alignItems: 'center', gap: '6px', color: ventsColors.ink3, fontSize: '12px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
              <Megaphone size={13} /> Announcement
            </span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 20px calc(32px + env(safe-area-inset-bottom))', maxWidth: '640px', width: '100%', margin: '0 auto', boxSizing: 'border-box' }}>
            <h2 style={{ color: ventsColors.ink1, fontSize: '22px', fontWeight: 800, lineHeight: 1.3, margin: '0 0 8px' }}>{reader.title}</h2>
            {reader.createdAt && (
              <p style={{ color: ventsColors.ink3, fontSize: '12.5px', margin: '0 0 20px' }}>
                <time dateTime={reader.createdAt}>{formatFullDate(reader.createdAt)}</time>
              </p>
            )}
            <p style={{ color: ventsColors.ink2, fontSize: '15px', lineHeight: 1.65, margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{reader.body}</p>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={showClearConfirm}
        title={tab === 'announcements' ? 'Clear all announcements?' : 'Clear all notifications?'}
        message={tab === 'announcements' ? 'This will remove every announcement from your feed and cannot be undone.' : 'This will remove every notification and cannot be undone.'}
        confirmLabel="Clear All"
        danger
        onConfirm={clearAllNotifications}
        onCancel={() => setShowClearConfirm(false)}
      />
    </div>
  );
}
