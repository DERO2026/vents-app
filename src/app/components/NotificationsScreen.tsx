import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Bell, Loader, Trash2, CheckCheck, ChevronRight } from 'lucide-react';
import { Notification } from './types';
import { supabase } from '../../lib/supabase';
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

const TYPE_COLORS: Record<string, string> = {
  reminder: '#A855F7',
  booking: '#10B981',
  promo: '#F59E0B',
  social: '#3B82F6',
  broadcast: '#F59E0B',
  message: '#3B82F6',
  sale: '#10B981',
  event_update: '#A855F7',
};

export function NotificationsScreen({
  onBack,
  currentUser,
  onRefreshUnread,
  onRouteNotification,
}: {
  onBack: () => void;
  currentUser?: { id: string } | null;
  onRefreshUnread?: () => void;
  // The exact same function App.tsx uses to route a native push tap --
  // deliberately not reimplemented here, so an in-app tap and a push tap
  // can never resolve a notification to two different destinations.
  onRouteNotification?: (data: Record<string, any>) => void;
}) {
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
    push_data: n.push_data ?? null,
  });

  const fetchNotifications = async () => {
    if (!currentUser?.id) return;
    const myReq = ++reqIdRef.current;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', currentUser.id)
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
    } finally {
      if (myReq === reqIdRef.current) setLoading(false);
    }
  };

  // Was hard-capped at 50 with no way to see anything older.
  const loadMore = async () => {
    if (!currentUser?.id || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', currentUser.id)
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
  }, [currentUser]);

  // The unread badge (App.tsx) updates live via this same channel/event;
  // this screen only fetched once per mount, so a notification arriving
  // while it was open never appeared until the user backed out and back in.
  useEffect(() => {
    if (!currentUser?.id) return;
    // Same topic-naming convention as ConversationScreen.tsx's messaging
    // realtime — the server-side notify_new_notification() trigger
    // broadcasts here (realtime.send(..., 'new_notification',
    // 'user:'||user_id, false)).
    const channel = supabase.channel(`user:${currentUser.id}`, { config: { broadcast: { self: false } } });
    channel.on('broadcast', { event: 'new_notification' }, () => fetchNotifications());
    channel.subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id]);

  const unreadCount = items.filter((n) => !n.read).length;

  const markAllRead = async () => {
    if (!currentUser?.id) return;
    try {
      setItems((prev) => prev.map((n) => ({ ...n, read: true })));
      const { error } = await supabase
        .from('notifications')
        .update({ read: true })
        .eq('user_id', currentUser.id)
        .eq('read', false);
      if (error) throw error;
      onRefreshUnread?.();
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
      const { error } = await supabase.from('notifications').delete().eq('user_id', currentUser.id);
      if (error) throw error;
      onRefreshUnread?.();
    } catch (err) {
      console.error("Failed to clear notifications:", err);
      Sentry.captureException(err);
      setItems(prevItems);
    } finally {
      setClearing(false);
    }
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
      style={{
        background: 'radial-gradient(ellipse 520px 300px at 50% -8%, rgba(123,47,190,0.09) 0%, rgba(5,2,10,1) 40%, #050208 100%)',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        fontFamily: 'Inter, sans-serif',
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
          <ArrowLeft size={15} color="#C4C9E0" />
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
              color: '#F5F5FA',
              fontSize: '17px',
              fontWeight: 700,
              fontFamily: 'Space Grotesk, sans-serif',
              margin: 0,
              letterSpacing: '0.01em',
            }}
          >
            Notifications
          </h1>
          {unreadCount > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ width: '4px', height: '4px', borderRadius: '50%', background: '#A855F7', boxShadow: '0 0 5px rgba(168,85,247,0.8)' }} />
              <span style={{ color: '#8B8FA8', fontSize: '11px', letterSpacing: '0.02em' }}>
                {unreadCount} new
              </span>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', position: 'relative', zIndex: 1 }}>
          {unreadCount > 0 && (
            <button
              onClick={markAllRead}
              title="Mark all read"
              aria-label="Mark all read"
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
              <CheckCheck size={15} color="#B9A6E8" />
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
              <Trash2 size={14} color="#8B8FA8" />
            </button>
          )}
        </div>
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
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '150px', color: '#6B7089' }}>
            <Loader size={18} className="animate-spin" />
            <span style={{ marginLeft: '10px', fontSize: '13px' }}>Loading notifications...</span>
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
              <Bell size={24} color="#4A4E63" strokeWidth={1.5} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '5px' }}>
              <p style={{ color: '#D8D8E4', fontSize: '14px', fontWeight: 600, margin: 0, fontFamily: 'Space Grotesk, sans-serif' }}>You're all caught up</p>
              <p style={{ color: '#6B7089', fontSize: '12.5px', margin: 0 }}>New activity will show up here</p>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {items.map((notif) => {
              const accent = TYPE_COLORS[notif.type] ?? '#A855F7';
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
                        <Trash2 size={14} color="#8B8FA8" />
                      </div>
                    </div>
                  )}
                  <div
                    onClick={() => {
                      if (offsetX !== 0) return;
                      markRead(notif.id);
                      if (notif.push_data) onRouteNotification?.(notif.push_data);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault();
                      if (offsetX !== 0) return;
                      markRead(notif.id);
                      if (notif.push_data) onRouteNotification?.(notif.push_data);
                    }}
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
                          color: notif.read ? '#B8BBCC' : '#F0F0FA',
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
                              background: '#A855F7',
                              boxShadow: '0 0 4px rgba(168,85,247,0.7)',
                              flexShrink: 0,
                            }}
                          />
                        )}
                        <span
                          style={{
                            color: '#5C6079',
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
                        color: notif.read ? '#6B7089' : '#9A9DB5',
                        fontSize: '12.5px',
                        lineHeight: 1.5,
                        margin: 0,
                      }}
                    >
                      {notif.body}
                    </p>
                  </div>

                  {/* Chevron only on notifications that actually go
                      somewhere -- an informational/non-navigational
                      notification (no push_data) shouldn't look tappable. */}
                  {notif.push_data && (
                    <ChevronRight size={15} color="#4A4E63" style={{ flexShrink: 0 }} />
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
                  color: '#9A9DB5', fontSize: '13px', fontWeight: 600,
                  cursor: loadingMore ? 'not-allowed' : 'pointer', opacity: loadingMore ? 0.6 : 1,
                }}
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={showClearConfirm}
        title="Clear all notifications?"
        message="This will remove every notification and cannot be undone."
        confirmLabel="Clear All"
        danger
        onConfirm={clearAllNotifications}
        onCancel={() => setShowClearConfirm(false)}
      />
    </div>
  );
}
