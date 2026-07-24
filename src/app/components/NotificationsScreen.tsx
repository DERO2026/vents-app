import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Bell, Loader, Trash2 } from 'lucide-react';
import { Notification } from './types';
import { insforge, getAuthToken } from '../../lib/insforge';
import { analytics } from '../../lib/analyticsEvents';
import { ConfirmDialog } from './ConfirmDialog';

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
};

export function NotificationsScreen({
  onBack,
  currentUser,
  onRefreshUnread,
}: {
  onBack: () => void;
  currentUser?: { id: string } | null;
  onRefreshUnread?: () => void;
}) {
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [swipe, setSwipe] = useState<{ id: string; offsetX: number } | null>(null);
  const swipeStartX = useRef<number | null>(null);

  const fetchNotifications = async () => {
    if (!currentUser?.id) return;
    setLoading(true);
    try {
      const { data, error } = await insforge.database
        .from('notifications')
        .select('*')
        .eq('user_id', currentUser.id)
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) throw error;
      if (data) {
        setItems(data.map((n: any) => ({
          id: n.id,
          type: n.type,
          title: n.title,
          body: n.body,
          read: n.read,
          icon: n.icon,
          time: formatRelativeTime(n.created_at)
        })));
      }
    } catch (err) {
      console.error("Failed to fetch notifications:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchNotifications();
  }, [currentUser]);

  const unreadCount = items.filter((n) => !n.read).length;

  const markAllRead = async () => {
    if (!currentUser?.id) return;
    try {
      setItems((prev) => prev.map((n) => ({ ...n, read: true })));
      const { error } = await insforge.database
        .from('notifications')
        .update({ read: true })
        .eq('user_id', currentUser.id)
        .eq('read', false);
      if (error) throw error;
      onRefreshUnread?.();
    } catch (err) {
      console.error("Failed to mark all as read:", err);
      fetchNotifications();
    }
  };

  const markRead = async (id: string) => {
    try {
      const opened = items.find((n) => n.id === id);
      if (opened && !opened.read) analytics.notificationOpened((opened as any).type);
      setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
      const { error } = await insforge.database
        .from('notifications')
        .update({ read: true })
        .eq('id', id);
      if (error) throw error;
      onRefreshUnread?.();
    } catch (err) {
      console.error("Failed to mark notification as read:", err);
      fetchNotifications();
    }
  };

  const deleteNotification = async (id: string) => {
    const prevItems = items;
    setItems((prev) => prev.filter((n) => n.id !== id));
    setSwipe(null);
    try {
      await getAuthToken();
      const { error } = await insforge.database.from('notifications').delete().eq('id', id);
      if (error) throw error;
      onRefreshUnread?.();
    } catch (err) {
      console.error("Failed to delete notification:", err);
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
      await getAuthToken();
      const { error } = await insforge.database.from('notifications').delete().eq('user_id', currentUser.id);
      if (error) throw error;
      onRefreshUnread?.();
    } catch (err) {
      console.error("Failed to clear notifications:", err);
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
        background: '#020005',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button
            onClick={onBack}
            style={{
              background: '#090514',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '50%',
              width: '36px',
              height: '36px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            <ArrowLeft size={16} color="#C4C9E0" />
          </button>
          <div>
            <h1 style={{ color: '#F0F0FF', fontSize: '20px', fontWeight: 700 }}>Notifications</h1>
            {unreadCount > 0 && (
              <span style={{ color: '#8B8FA8', fontSize: '12px' }}>
                {unreadCount} unread
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {unreadCount > 0 && (
            <button
              onClick={markAllRead}
              style={{
                background: 'rgba(167,139,250,0.1)',
                border: '1px solid rgba(167,139,250,0.2)',
                borderRadius: '10px',
                padding: '6px 12px',
                color: '#A78BFA',
                fontSize: '12px',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Mark all read
            </button>
          )}
          {items.length > 0 && (
            <button
              onClick={() => setShowClearConfirm(true)}
              disabled={clearing}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                background: 'rgba(239,68,68,0.1)',
                border: '1px solid rgba(239,68,68,0.25)',
                borderRadius: '10px',
                padding: '6px 12px',
                color: '#EF4444',
                fontSize: '12px',
                fontWeight: 500,
                cursor: clearing ? 'not-allowed' : 'pointer',
                opacity: clearing ? 0.6 : 1,
              }}
            >
              <Trash2 size={12} />
              Clear All
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
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '150px', color: '#8B8FA8' }}>
            <Loader size={20} className="animate-spin" />
            <span style={{ marginLeft: '10px', fontSize: '13px' }}>Loading notifications...</span>
          </div>
        ) : items.length === 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              paddingTop: '80px',
              gap: '12px',
            }}
          >
            <div
              style={{
                width: '72px',
                height: '72px',
                borderRadius: '20px',
                background: '#090514',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Bell size={32} color="#2A2D3E" />
            </div>
            <p style={{ color: '#8B8FA8', fontSize: '15px' }}>No notifications yet</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {items.map((notif) => {
              const accent = TYPE_COLORS[notif.type] ?? '#A855F7';
              const offsetX = swipe?.id === notif.id ? swipe.offsetX : 0;
              return (
                <div key={notif.id} style={{ position: 'relative', borderRadius: '16px', overflow: 'hidden' }}>
                  {/* Delete-reveal background */}
                  <div style={{
                    position: 'absolute', inset: 0, background: 'rgba(239,68,68,0.15)',
                    display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '0 20px',
                  }}>
                    <Trash2 size={18} color="#EF4444" />
                  </div>
                  <div
                    onClick={() => { if (offsetX === 0) markRead(notif.id); }}
                    onTouchStart={(e) => handleSwipeStart(notif.id, e.touches[0].clientX)}
                    onTouchMove={(e) => handleSwipeMove(notif.id, e.touches[0].clientX)}
                    onTouchEnd={() => handleSwipeEnd(notif.id)}
                    style={{
                      background: notif.read ? '#131629' : 'rgba(168,85,247,0.07)',
                      border: notif.read
                        ? '1px solid rgba(255,255,255,0.05)'
                        : '1px solid rgba(168,85,247,0.22)',
                      borderRadius: '16px',
                      padding: '14px',
                      display: 'flex',
                      gap: '12px',
                      cursor: 'pointer',
                      position: 'relative',
                      transform: `translateX(${offsetX}px)`,
                      transition: swipe?.id === notif.id ? 'none' : 'transform 0.2s ease, opacity 0.15s ease',
                    }}
                  >
                  {/* Icon bubble */}
                  <div
                    style={{
                      width: '44px',
                      height: '44px',
                      borderRadius: '13px',
                      background: `${accent}18`,
                      border: `1px solid ${accent}30`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '20px',
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
                        marginBottom: '4px',
                        gap: '8px',
                      }}
                    >
                      <span
                        style={{
                          color: '#F0F0FF',
                          fontSize: '14px',
                          fontWeight: notif.read ? 500 : 700,
                        }}
                      >
                        {notif.title}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                        {!notif.read && (
                          <div
                            style={{
                              width: '8px',
                              height: '8px',
                              borderRadius: '50%',
                              background: accent,
                              boxShadow: `0 0 6px ${accent}`,
                              flexShrink: 0,
                            }}
                          />
                        )}
                        <span
                          style={{
                            color: '#8B8FA8',
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
                        color: notif.read ? '#8B8FA8' : '#C4C9E0',
                        fontSize: '13px',
                        lineHeight: 1.45,
                      }}
                    >
                      {notif.body}
                    </p>
                  </div>

                  {/* Unread dot moved inline with timestamp above */}
                  </div>
                </div>
              );
            })}
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
