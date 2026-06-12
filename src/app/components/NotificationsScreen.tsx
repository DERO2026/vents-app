import { useState } from 'react';
import { ArrowLeft, Bell } from 'lucide-react';
import { Notification } from './types';


const TYPE_COLORS: Record<string, string> = {
  reminder: '#A855F7',
  booking: '#10B981',
  promo: '#F59E0B',
  social: '#3B82F6',
};

export function NotificationsScreen({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState<Notification[]>([]);

  const unreadCount = items.filter((n) => !n.read).length;

  const markAllRead = () => setItems((prev) => prev.map((n) => ({ ...n, read: true })));

  const markRead = (id: string) =>
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));

  return (
    <div
      style={{
        background: '#060A12',
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
          padding: '20px 16px 14px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button
            onClick={onBack}
            style={{
              background: '#131629',
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
      </div>

      {/* List */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '4px 16px 24px',
        }}
      >
        {items.length === 0 ? (
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
                background: '#131629',
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
              return (
                <div
                  key={notif.id}
                  onClick={() => markRead(notif.id)}
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
                    transition: 'opacity 0.15s ease',
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
                      <span
                        style={{
                          color: '#8B8FA8',
                          fontSize: '11px',
                          flexShrink: 0,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {notif.time}
                      </span>
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

                  {/* Unread dot */}
                  {!notif.read && (
                    <div
                      style={{
                        position: 'absolute',
                        top: '18px',
                        right: '14px',
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        background: accent,
                        boxShadow: `0 0 6px ${accent}`,
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
