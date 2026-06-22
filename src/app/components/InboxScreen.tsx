import { useState, useEffect } from 'react';
import { ArrowLeft, MessageCircle } from 'lucide-react';
import { insforge } from '../../lib/insforge';
import { UserProfile } from './types';

interface InboxScreenProps {
  currentUser: UserProfile;
  onBack: () => void;
  onOpenConversation: (otherUser: { id: string; name: string; avatarUrl?: string }) => void;
}

interface Thread {
  otherUserId: string;
  otherUserName: string;
  otherUserAvatar?: string;
  lastBody: string;
  lastAt: string;
  unread: number;
}

export function InboxScreen({ currentUser, onBack, onOpenConversation }: InboxScreenProps) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      if (!currentUser?.id) return;
      try {
        const { data: msgs } = await insforge.database
          .from('direct_messages')
          .select('id, sender_id, recipient_id, body, created_at, read_at')
          .or(`sender_id.eq.${currentUser.id},recipient_id.eq.${currentUser.id}`)
          .order('created_at', { ascending: false })
          .limit(50);

        if (!msgs || msgs.length === 0) { setLoading(false); return; }

        const otherIds = [...new Set(msgs.map((m: any) =>
          m.sender_id === currentUser.id ? m.recipient_id : m.sender_id
        ))];

        // Fetch profiles in parallel (not sequentially after msgs)
        const [{ data: profiles }] = await Promise.all([
          insforge.database
            .from('public_profiles')
            .select('id, full_name, username, avatar_url')
            .in('id', otherIds as string[]),
        ]);

        const profileMap: Record<string, any> = {};
        (profiles || []).forEach((p: any) => { profileMap[p.id] = p; });

        const threadMap: Record<string, Thread> = {};
        msgs.forEach((m: any) => {
          const otherId = m.sender_id === currentUser.id ? m.recipient_id : m.sender_id;
          if (!threadMap[otherId]) {
            const p = profileMap[otherId];
            threadMap[otherId] = {
              otherUserId: otherId,
              otherUserName: p?.full_name || p?.username || 'Unknown',
              otherUserAvatar: p?.avatar_url,
              lastBody: m.body,
              lastAt: m.created_at,
              unread: 0,
            };
          }
          if (m.recipient_id === currentUser.id && !m.read_at) {
            threadMap[otherId].unread++;
          }
        });

        setThreads(Object.values(threadMap).sort(
          (a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime()
        ));
      } catch (e) {
        console.error('InboxScreen load error', e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [currentUser?.id]);

  function timeAgo(iso: string) {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'now';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  }

  return (
    <div style={{ background: '#060A12', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: '12px',
        padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        flexShrink: 0,
      }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
          <ArrowLeft size={24} color="#A78BFA" />
        </button>
        <h1 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 700, margin: 0 }}>Messages</h1>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none' }}>
        {loading ? (
          <p style={{ color: '#8B8FA8', textAlign: 'center', padding: '40px 16px' }}>Loading…</p>
        ) : threads.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '60px 24px', gap: '12px' }}>
            <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: 'rgba(167,139,250,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <MessageCircle size={28} color="#A78BFA" />
            </div>
            <p style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 700, margin: 0 }}>No messages yet</p>
            <p style={{ color: '#8B8FA8', fontSize: '13px', textAlign: 'center', margin: 0 }}>
              Message an organiser from an event page or their profile.
            </p>
          </div>
        ) : threads.map((t) => (
          <button
            key={t.otherUserId}
            onClick={() => onOpenConversation({ id: t.otherUserId, name: t.otherUserName, avatarUrl: t.otherUserAvatar })}
            style={{
              width: '100%', background: 'none', border: 'none',
              borderBottom: '1px solid rgba(255,255,255,0.04)',
              padding: '14px 16px', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: '12px', textAlign: 'left',
            }}
          >
            <div style={{
              width: '44px', height: '44px', borderRadius: '50%', flexShrink: 0,
              background: t.otherUserAvatar ? 'transparent' : 'rgba(167,139,250,0.2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
            }}>
              {t.otherUserAvatar
                ? <img src={t.otherUserAvatar} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : <span style={{ color: '#A78BFA', fontSize: '18px', fontWeight: 700 }}>{t.otherUserName[0]?.toUpperCase()}</span>
              }
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                <span style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>{t.otherUserName}</span>
                <span style={{ color: '#8B8FA8', fontSize: '11px', flexShrink: 0 }}>{timeAgo(t.lastAt)}</span>
              </div>
              <p style={{ color: '#8B8FA8', fontSize: '12px', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t.lastBody}
              </p>
            </div>
            {t.unread > 0 && (
              <div style={{
                background: '#A78BFA', color: '#fff', fontSize: '11px', fontWeight: 700,
                width: '20px', height: '20px', borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                {t.unread > 9 ? '9+' : t.unread}
              </div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
