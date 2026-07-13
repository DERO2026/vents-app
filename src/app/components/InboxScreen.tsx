import { useState, useEffect } from 'react';
import { ArrowLeft, MessageCircle, MoreVertical, Eraser, Trash2, Ban, Share2, X } from 'lucide-react';
import { insforge } from '../../lib/insforge';

interface InboxScreenProps {
  currentUser: { id: string };
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
  const [menuThread, setMenuThread] = useState<Thread | null>(null);
  const [confirmAction, setConfirmAction] = useState<'clear' | 'delete' | 'block' | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  async function load() {
    if (!currentUser?.id) return;
    try {
      const [{ data: msgs }, { data: clears }] = await Promise.all([
        insforge.database
          .from('direct_messages')
          .select('id, sender_id, recipient_id, body, created_at, read_at')
          .or(`sender_id.eq.${currentUser.id},recipient_id.eq.${currentUser.id}`)
          .order('created_at', { ascending: false })
          .limit(50),
        insforge.database
          .from('conversation_clears')
          .select('other_user_id, cleared_at')
          .eq('user_id', currentUser.id),
      ]);

      if (!msgs || msgs.length === 0) { setThreads([]); setLoading(false); return; }

      // Per-user "Clear Chat"/"Delete Chat" cutoff — messages at or before
      // this timestamp are hidden from this user's own inbox/conversation
      // view only (see migrations/20260713170000_conversation-clear-and-delete.sql).
      const clearedAtMap: Record<string, number> = {};
      (clears || []).forEach((c: any) => { clearedAtMap[c.other_user_id] = new Date(c.cleared_at).getTime(); });

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
        const cutoff = clearedAtMap[otherId];
        if (cutoff && new Date(m.created_at).getTime() <= cutoff) return;
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

  useEffect(() => { load(); }, [currentUser?.id]);

  function timeAgo(iso: string) {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'now';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  }

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  async function runConfirmedAction() {
    if (!menuThread || !confirmAction) return;
    setActionBusy(true);
    try {
      if (confirmAction === 'clear' || confirmAction === 'delete') {
        const { error } = await insforge.database.rpc('clear_conversation', { p_other_user_id: menuThread.otherUserId });
        if (error) throw error;
        setThreads((prev) => prev.filter((t) => t.otherUserId !== menuThread.otherUserId));
        flash(confirmAction === 'clear' ? 'Chat cleared.' : 'Chat deleted.');
      } else if (confirmAction === 'block') {
        const { error } = await insforge.database.rpc('block_user', { p_blocked_id: menuThread.otherUserId });
        if (error) throw error;
        setThreads((prev) => prev.filter((t) => t.otherUserId !== menuThread.otherUserId));
        flash(`${menuThread.otherUserName} blocked.`);
      }
    } catch (e: any) {
      flash(e?.message || 'Action failed. Please try again.');
    } finally {
      setActionBusy(false);
      setConfirmAction(null);
      setMenuThread(null);
    }
  }

  async function handleShare(thread: Thread) {
    const deepLink = `${window.location.origin}/?user=${thread.otherUserId}`;
    const text = `Check out ${thread.otherUserName} on Vents 👇\n${deepLink}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: thread.otherUserName, text, url: deepLink });
      } else {
        await navigator.clipboard.writeText(deepLink);
        flash('Profile link copied.');
      }
    } catch {
      // user cancelled share sheet
    }
    setMenuThread(null);
  }

  return (
    <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
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

      {toast && (
        <div style={{ padding: '8px 16px 0' }}>
          <div style={{ background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.3)', borderRadius: '10px', padding: '8px 12px', color: '#A78BFA', fontSize: '12px', fontWeight: 600 }}>
            {toast}
          </div>
        </div>
      )}

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
          <div
            key={t.otherUserId}
            style={{
              width: '100%',
              borderBottom: '1px solid rgba(255,255,255,0.04)',
              display: 'flex', alignItems: 'center', gap: '8px',
            }}
          >
            <button
              onClick={() => onOpenConversation({ id: t.otherUserId, name: t.otherUserName, avatarUrl: t.otherUserAvatar })}
              style={{
                flex: 1, background: 'none', border: 'none',
                padding: '14px 4px 14px 16px', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: '12px', textAlign: 'left', minWidth: 0,
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
            <button
              onClick={() => setMenuThread(t)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '8px 16px 8px 4px', flexShrink: 0 }}
            >
              <MoreVertical size={18} color="#8B8FA8" />
            </button>
          </div>
        ))}
      </div>

      {/* 3-dot action menu */}
      {menuThread && !confirmAction && (
        <div
          onClick={() => setMenuThread(null)}
          style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 60, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#090514', borderRadius: '24px 24px 0 0', border: '1px solid rgba(255,255,255,0.08)', padding: '16px 0 calc(24px + env(safe-area-inset-bottom))' }}>
            <div style={{ width: '36px', height: '4px', background: 'rgba(255,255,255,0.12)', borderRadius: '2px', margin: '0 auto 16px' }} />
            <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700, padding: '0 20px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>{menuThread.otherUserName}</p>
            {[
              { icon: <Eraser size={18} />, label: 'Clear Chat', color: '#A78BFA', action: () => setConfirmAction('clear') },
              { icon: <Trash2 size={18} />, label: 'Delete Chat', color: '#EF4444', action: () => setConfirmAction('delete') },
              { icon: <Ban size={18} />, label: 'Block User', color: '#EF4444', action: () => setConfirmAction('block') },
              { icon: <Share2 size={18} />, label: 'Share User', color: '#3B82F6', action: () => handleShare(menuThread) },
            ].map((item) => (
              <button
                key={item.label}
                onClick={item.action}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 20px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
              >
                <span style={{ color: item.color, display: 'flex' }}>{item.icon}</span>
                <span style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 500 }}>{item.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Confirmation step for destructive actions */}
      {menuThread && confirmAction && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
          <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '20px', padding: '20px', width: '100%', maxWidth: '340px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
              <p style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 700, margin: 0 }}>
                {confirmAction === 'clear' ? 'Clear this chat?' : confirmAction === 'delete' ? 'Delete this chat?' : `Block ${menuThread.otherUserName}?`}
              </p>
              <button onClick={() => setConfirmAction(null)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
                <X size={18} color="#8B8FA8" />
              </button>
            </div>
            <p style={{ color: '#8B8FA8', fontSize: '13px', lineHeight: 1.5, marginBottom: '18px' }}>
              {confirmAction === 'clear'
                ? 'This clears the message history for you only — it stays visible to the other person.'
                : confirmAction === 'delete'
                ? 'This removes the conversation from your inbox — it stays visible to the other person, and reappears here if they message you again.'
                : 'They won\'t be able to message you, and this conversation will disappear from your inbox.'}
            </p>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                onClick={() => setConfirmAction(null)}
                disabled={actionBusy}
                style={{ flex: 1, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', padding: '11px', color: '#C4C9E0', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={runConfirmedAction}
                disabled={actionBusy}
                style={{ flex: 1, background: '#EF4444', border: 'none', borderRadius: '12px', padding: '11px', color: '#fff', fontSize: '14px', fontWeight: 700, cursor: actionBusy ? 'not-allowed' : 'pointer', opacity: actionBusy ? 0.6 : 1 }}
              >
                {actionBusy ? 'Working…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
