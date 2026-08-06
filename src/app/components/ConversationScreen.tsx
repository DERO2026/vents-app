import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import BadgeChip from './BadgeChip';
import { ArrowLeft, Send, Image, Trash2, Check, CheckCheck, X, Search, Reply } from 'lucide-react';
import { insforge, getAuthToken } from '../../lib/insforge';
import { compressImage } from '../../lib/compressImage';
import { withTimeoutFallback } from '../../lib/withTimeoutFallback';
import { haptics } from '../../lib/haptics';
import { pickImage } from '../../lib/pickImage';
import { isOnline as isDeviceOnline } from '../../lib/isOnline';

interface ConversationScreenProps {
  currentUser: { id: string };
  otherUser: { id: string; name: string; avatarUrl?: string; vc_badge?: string };
  eventId?: string;
  eventTitle?: string;
  onBack: () => void;
  onNavigateToProfile?: (userId: string) => void;
}

interface DM {
  id: string;
  sender_id: string;
  recipient_id: string;
  body: string;
  image_url?: string | null;
  media_type?: string | null;
  reply_to_id?: string | null;
  deleted_by_sender?: boolean;
  created_at: string;
  read_at?: string | null;
  /** Client-only: set on optimistic messages not yet confirmed by the server. */
  _pending?: 'sending' | 'queued';
}

type RequestStatus = 'loading' | 'accepted' | 'pending_incoming' | 'pending_outgoing' | 'declined';

const REACTION_EMOJI = ['❤️', '😂', '😮', '😢', '👍', '🙏'];

export function ConversationScreen({ currentUser, otherUser, eventId, eventTitle, onBack, onNavigateToProfile }: ConversationScreenProps) {
  const [messages, setMessages] = useState<DM[]>([]);
  const [pendingMessages, setPendingMessages] = useState<DM[]>([]);
  const [reactions, setReactions] = useState<Record<string, { emoji: string; user_id: string }[]>>({});
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(true);
  const [requestStatus, setRequestStatus] = useState<RequestStatus>('loading');
  const [respondingRequest, setRespondingRequest] = useState(false);
  const [actionMsg, setActionMsg] = useState<DM | null>(null); // long-press context menu target
  const [replyTo, setReplyTo] = useState<DM | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [uploadingImg, setUploadingImg] = useState(false);
  const [swipeStartX, setSwipeStartX] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [imageSharingEnabled, setImageSharingEnabled] = useState(true);
  const [otherTyping, setOtherTyping] = useState(false);
  const [otherLastActiveAt, setOtherLastActiveAt] = useState<string | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<DM[]>([]);
  const [searching, setSearching] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSentRef = useRef(0);
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  // Immediately mark all unread incoming messages as read on mount — fire and forget.
  useEffect(() => {
    if (!currentUser?.id || !otherUser?.id) return;
    insforge.database
      .from('direct_messages')
      .update({ read_at: new Date().toISOString() })
      .eq('recipient_id', currentUser.id)
      .eq('sender_id', otherUser.id)
      .is('read_at', null)
      .then(() => {}, () => {});
  }, [currentUser?.id, otherUser?.id]);

  useEffect(() => {
    insforge.database
      .from('app_config')
      .select('image_sharing_enabled')
      .maybeSingle()
      .then(
        ({ data }: any) => { if (typeof data?.image_sharing_enabled === 'boolean') setImageSharingEnabled(data.image_sharing_enabled); },
        () => {}
      );
  }, []);

  // Request status — who started this conversation and whether it's been
  // accepted yet. Loaded independently of message history so a pending
  // request still opens (you can read/reconsider) without any messages
  // having loaded first.
  const loadRequestStatus = useCallback(async () => {
    if (!currentUser?.id || !otherUser?.id) return;
    const { data } = await insforge.database
      .from('conversation_requests')
      .select('requester_id, recipient_id, status')
      .or(`and(requester_id.eq.${currentUser.id},recipient_id.eq.${otherUser.id}),and(requester_id.eq.${otherUser.id},recipient_id.eq.${currentUser.id})`)
      .maybeSingle();
    const row = data as any;
    if (!row) { setRequestStatus('accepted'); return; } // no row yet = brand new thread, first send creates it
    if (row.status === 'accepted') setRequestStatus('accepted');
    else if (row.status === 'declined') setRequestStatus('declined');
    else setRequestStatus(row.requester_id === currentUser.id ? 'pending_outgoing' : 'pending_incoming');
  }, [currentUser?.id, otherUser?.id]);

  useEffect(() => { loadRequestStatus(); }, [loadRequestStatus]);

  useEffect(() => {
    if (!otherUser?.id) return;
    insforge.database
      .from('public_profiles')
      .select('last_active_at')
      .eq('id', otherUser.id)
      .maybeSingle()
      .then(({ data }: any) => setOtherLastActiveAt(data?.last_active_at || null), () => {});
  }, [otherUser?.id]);

  const isOnline = useMemo(() => {
    if (!otherLastActiveAt) return false;
    return Date.now() - new Date(otherLastActiveAt).getTime() < 60_000;
  }, [otherLastActiveAt]);

  async function loadReactions(messageIds: string[]) {
    if (messageIds.length === 0) return;
    const { data } = await insforge.database
      .from('message_reactions')
      .select('message_id, emoji, user_id')
      .in('message_id', messageIds);
    const grouped: Record<string, { emoji: string; user_id: string }[]> = {};
    (data || []).forEach((r: any) => {
      (grouped[r.message_id] ||= []).push({ emoji: r.emoji, user_id: r.user_id });
    });
    setReactions(grouped);
  }

  async function load() {
    try {
      const { data: clearRow } = await insforge.database
        .from('conversation_clears')
        .select('cleared_at')
        .eq('user_id', currentUser.id)
        .eq('other_user_id', otherUser.id)
        .maybeSingle();

      let query = insforge.database
        .from('direct_messages')
        .select('id, sender_id, recipient_id, body, image_url, media_type, reply_to_id, deleted_by_sender, created_at, read_at')
        .or(
          `and(sender_id.eq.${currentUser.id},recipient_id.eq.${otherUser.id}),and(sender_id.eq.${otherUser.id},recipient_id.eq.${currentUser.id})`
        );
      if ((clearRow as any)?.cleared_at) query = query.gt('created_at', (clearRow as any).cleared_at);

      const { data } = await query.order('created_at', { ascending: true }).limit(100);
      const rows = (data as DM[]) || [];
      setMessages(rows);
      loadReactions(rows.map((m) => m.id));

      const unread = rows.filter((m) => m.recipient_id === currentUser.id && !m.read_at);
      if (unread.length > 0) {
        await insforge.database
          .from('direct_messages')
          .update({ read_at: new Date().toISOString() })
          .in('id', unread.map((m) => m.id));
      }
    } catch (e) {
      console.error('ConversationScreen load error', e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!currentUser?.id || !otherUser?.id) return;
    load();

    const channel = `user:${currentUser.id}`;
    let subscribed = false;
    let torn = false;
    insforge.realtime.connect().then(() => {
      insforge.realtime.subscribe(channel).then(() => {
        if (torn) { insforge.realtime.unsubscribe(channel); return; }
        subscribed = true;
      });
    }).catch(() => {});

    const onNewMessage = (payload: any) => {
      if (payload?.sender_id === otherUser.id || payload?.recipient_id === otherUser.id) {
        load();
        loadRequestStatus();
      }
    };
    const onTyping = (payload: any) => {
      if (payload?.from !== otherUser.id) return;
      setOtherTyping(true);
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = setTimeout(() => setOtherTyping(false), 3000);
    };
    insforge.realtime.on('new_message', onNewMessage);
    insforge.realtime.on('typing', onTyping);

    const interval = setInterval(load, 8000);
    return () => {
      torn = true;
      clearInterval(interval);
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      insforge.realtime.off?.('new_message', onNewMessage);
      insforge.realtime.off?.('typing', onTyping);
      if (subscribed) insforge.realtime.unsubscribe(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id, otherUser?.id]);

  const sendTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastTypingSentRef.current < 2000) return; // throttle
    lastTypingSentRef.current = now;
    insforge.realtime.publish(`user:${otherUser.id}`, 'typing', { from: currentUser.id }).catch(() => {});
  }, [currentUser.id, otherUser.id]);

  const sendImageMessage = useCallback(async (file: File) => {
    if (!imageSharingEnabled) { flash('Image sharing is temporarily unavailable.'); return; }
    setUploadingImg(true);
    try {
      const token = await getAuthToken();
      const { blob: compressedBlob, mimeType, extension } = await compressImage(file);
      const formData = new FormData();
      formData.append('file', new File([compressedBlob], `dm-${Date.now()}.${extension}`, { type: mimeType }));
      const res = await withTimeoutFallback(
        fetch(
          `${import.meta.env.VITE_INSFORGE_URL}/api/storage/buckets/direct_messages/objects`,
          { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData }
        ),
        { timeoutMs: 8000, timeoutMessage: 'Image upload is taking too long.' }
      );
      if (!res.ok) throw new Error('Upload failed');
      const data = await res.json();
      const url = data?.url ?? (data?.key ? `${import.meta.env.VITE_INSFORGE_URL}/api/storage/buckets/direct_messages/objects/${encodeURIComponent(data.key)}` : null);
      if (!url) throw new Error('No URL');
      const { error } = await insforge.database.rpc('send_direct_message', {
        p_recipient_id: otherUser.id, p_body: '', p_event_id: eventId || null,
        p_image_url: url, p_media_type: 'image', p_reply_to_id: null,
      });
      if (error) throw error;
      await load();
      loadRequestStatus();
    } catch (e: any) {
      console.error('Image send failed', e);
      flash(e?.message || 'Failed to send image');
    } finally { setUploadingImg(false); }
  }, [currentUser.id, otherUser.id, eventId, imageSharingEnabled]);

  const deleteMessage = useCallback(async (id: string) => {
    await insforge.database.from('direct_messages').update({ deleted_by_sender: true }).eq('id', id).eq('sender_id', currentUser.id);
    setMessages(prev => prev.map(m => m.id === id ? { ...m, deleted_by_sender: true, body: '' } : m));
    setActionMsg(null);
  }, [currentUser.id]);

  const toggleReaction = useCallback(async (messageId: string, emoji: string) => {
    haptics.light();
    setActionMsg(null);
    // Optimistic toggle.
    setReactions(prev => {
      const list = prev[messageId] || [];
      const mine = list.some(r => r.user_id === currentUser.id && r.emoji === emoji);
      const next = mine
        ? list.filter(r => !(r.user_id === currentUser.id && r.emoji === emoji))
        : [...list, { emoji, user_id: currentUser.id }];
      return { ...prev, [messageId]: next };
    });
    const { error } = await insforge.database.rpc('toggle_message_reaction', { p_message_id: messageId, p_emoji: emoji });
    if (error) { loadReactions(messages.map(m => m.id)); flash('Could not update reaction'); }
  }, [currentUser.id, messages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function attemptSend(localId: string, text: string, replyToId: string | null, attempt: number) {
    if (!(await isDeviceOnline())) {
      if (isMountedRef.current) setPendingMessages(prev => prev.map(m => m.id === localId ? { ...m, _pending: 'queued' } : m));
      return;
    }
    if (isMountedRef.current) setPendingMessages(prev => prev.map(m => m.id === localId ? { ...m, _pending: 'sending' } : m));
    try {
      const { error } = await insforge.database.rpc('send_direct_message', {
        p_recipient_id: otherUser.id, p_body: text, p_event_id: eventId || null,
        p_image_url: null, p_media_type: null, p_reply_to_id: replyToId,
      });
      if (error) throw error;
      if (!isMountedRef.current) return;
      setPendingMessages(prev => prev.filter(m => m.id !== localId));
      await load();
      loadRequestStatus();
    } catch (e: any) {
      if (String(e?.message || e).includes('blocked') || String(e?.message || e).includes('not accepting')) {
        if (isMountedRef.current) {
          setPendingMessages(prev => prev.filter(m => m.id !== localId));
          flash(e?.message || 'This message could not be delivered.');
        }
        return;
      }
      const delay = Math.min(30000, 1000 * 2 ** attempt);
      if (isMountedRef.current) setPendingMessages(prev => prev.map(m => m.id === localId ? { ...m, _pending: 'queued' } : m));
      setTimeout(() => { if (isMountedRef.current) attemptSend(localId, text, replyToId, attempt + 1); }, delay);
    }
  }

  useEffect(() => {
    function flushQueueOnReconnect() {
      setPendingMessages(prev => {
        prev.forEach(m => attemptSend(m.id, m.body, m.reply_to_id || null, 0));
        return prev;
      });
    }
    window.addEventListener('online', flushQueueOnReconnect);
    return () => window.removeEventListener('online', flushQueueOnReconnect);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sendMessage() {
    const text = body.trim();
    if (!text) return;
    if (requestStatus === 'declined') { flash("This user isn't accepting messages from you right now."); return; }
    haptics.light();
    setBody('');
    const replyToId = replyTo?.id || null;
    setReplyTo(null);
    const localId = `pending_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setPendingMessages(prev => [...prev, {
      id: localId, sender_id: currentUser.id, recipient_id: otherUser.id,
      body: text, reply_to_id: replyToId, created_at: new Date().toISOString(), _pending: 'sending',
    }]);
    attemptSend(localId, text, replyToId, 0);
  }

  async function respondToRequest(action: 'accept' | 'decline') {
    setRespondingRequest(true);
    try {
      const { error } = await insforge.database.rpc('respond_to_message_request', { p_requester_id: otherUser.id, p_action: action });
      if (error) throw error;
      if (action === 'accept') { setRequestStatus('accepted'); flash('Messaging enabled — say hello!'); }
      else { setRequestStatus('declined'); flash(`Declined ${otherUser.name}'s request.`); }
    } catch (e: any) {
      flash(e?.message || 'Could not update this request.');
    } finally {
      setRespondingRequest(false);
    }
  }

  async function runSearch(q: string) {
    setSearchQuery(q);
    if (!q.trim()) { setSearchResults([]); return; }
    setSearching(true);
    try {
      const { data } = await insforge.database.rpc('search_direct_messages', { p_query: q.trim(), p_other_user_id: otherUser.id });
      setSearchResults((data as DM[]) || []);
    } finally {
      setSearching(false);
    }
  }

  function jumpToMessage(id: string) {
    setShowSearch(false);
    setSearchQuery('');
    setSearchResults([]);
    setTimeout(() => {
      const el = messageRefs.current[id];
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.transition = 'background 0.3s';
        el.style.background = 'rgba(167,139,250,0.18)';
        setTimeout(() => { el.style.background = ''; }, 900);
      }
    }, 100);
  }

  function formatTime(iso: string) {
    return new Date(iso).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  const byId = useMemo(() => {
    const map: Record<string, DM> = {};
    messages.forEach(m => { map[m.id] = m; });
    return map;
  }, [messages]);

  return (
    <div
      style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}
      onTouchStart={e => setSwipeStartX(e.touches[0].clientX)}
      onTouchEnd={e => {
        if (swipeStartX !== null && e.changedTouches[0].clientX - swipeStartX > 60) onBack();
        setSwipeStartX(null);
      }}
    >
      <style>{`
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        @keyframes bubbleIn { from { opacity: 0; transform: translateY(8px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
        @keyframes typingDot { 0%, 60%, 100% { transform: translateY(0); opacity: 0.5; } 30% { transform: translateY(-3px); opacity: 1; } }
        @keyframes sheetSlideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
      `}</style>

      {toast && (
        <div style={{ position: 'fixed', bottom: '90px', left: '50%', transform: 'translateX(-50%)', background: '#090514', border: '1px solid rgba(167,139,250,0.3)', borderRadius: '12px', padding: '10px 16px', zIndex: 9999, maxWidth: '320px', textAlign: 'center', animation: 'bubbleIn 0.2s ease' }}>
          <p style={{ color: '#F0F0FF', fontSize: '13px', margin: 0 }}>{toast}</p>
        </div>
      )}

      {lightboxUrl && (
        <div onClick={() => setLightboxUrl(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.97)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <img src={lightboxUrl} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        </div>
      )}

      {/* Long-press context menu: react / reply / delete */}
      {actionMsg && (
        <div onClick={() => setActionMsg(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#090514', borderRadius: '20px', padding: '14px', minWidth: '220px', border: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px', padding: '0 4px' }}>
              {REACTION_EMOJI.map(e => (
                <button key={e} onClick={() => toggleReaction(actionMsg.id, e)} style={{ background: 'none', border: 'none', fontSize: '22px', cursor: 'pointer', padding: '4px' }}>{e}</button>
              ))}
            </div>
            <button
              onClick={() => { setReplyTo(actionMsg); setActionMsg(null); }}
              style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%', padding: '12px 16px', background: 'none', border: 'none', color: '#F0F0FF', fontSize: '14px', cursor: 'pointer', borderRadius: '12px' }}
            >
              <Reply size={16} color="#A78BFA" /> Reply
            </button>
            {actionMsg.sender_id === currentUser.id && !actionMsg.deleted_by_sender && (
              <button
                onClick={() => deleteMessage(actionMsg.id)}
                style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%', padding: '12px 16px', background: 'none', border: 'none', color: '#EF4444', fontSize: '14px', cursor: 'pointer', borderRadius: '12px' }}
              >
                <Trash2 size={16} /> Delete message
              </button>
            )}
          </div>
        </div>
      )}

      {/* Search overlay */}
      {showSearch && (
        <div style={{ position: 'fixed', inset: 0, background: '#020005', zIndex: 9500, display: 'flex', flexDirection: 'column', padding: 'calc(16px + env(safe-area-inset-top)) 16px 16px', animation: 'sheetSlideUp 0.25s cubic-bezier(0.16, 1, 0.3, 1)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '10px', background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '14px', padding: '10px 14px' }}>
              <Search size={16} color="#8B8FA8" />
              <input
                autoFocus
                value={searchQuery}
                onChange={e => runSearch(e.target.value)}
                placeholder={`Search in chat with ${otherUser.name}`}
                style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: '#F0F0FF', fontSize: '14px' }}
              />
            </div>
            <button onClick={() => { setShowSearch(false); setSearchQuery(''); setSearchResults([]); }} style={{ background: 'none', border: 'none', color: '#A78BFA', fontSize: '14px', cursor: 'pointer' }}>Cancel</button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' }}>
            {searching ? (
              <p style={{ color: '#8B8FA8', textAlign: 'center', marginTop: '24px', fontSize: '13px' }}>Searching…</p>
            ) : searchQuery && searchResults.length === 0 ? (
              <p style={{ color: '#8B8FA8', textAlign: 'center', marginTop: '24px', fontSize: '13px' }}>No messages found.</p>
            ) : (
              searchResults.map(m => (
                <button
                  key={m.id}
                  onClick={() => jumpToMessage(m.id)}
                  style={{ display: 'block', width: '100%', textAlign: 'left', background: '#131629', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '12px', padding: '12px 14px', marginBottom: '8px', cursor: 'pointer' }}
                >
                  <p style={{ color: '#F0F0FF', fontSize: '13px', margin: 0, lineHeight: 1.4 }}>{m.body}</p>
                  <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '4px 0 0' }}>{formatTime(m.created_at)}</p>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      <input ref={imgInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) sendImageMessage(f); e.target.value = ''; }} />

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '12px',
        padding: 'calc(14px + env(safe-area-inset-top)) 16px 12px',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        flexShrink: 0, background: 'rgba(9,5,20,0.85)', backdropFilter: 'blur(16px)',
      }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, flexShrink: 0 }}>
          <ArrowLeft size={22} color="#A78BFA" />
        </button>
        <div
          onClick={() => onNavigateToProfile?.(otherUser.id)}
          style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(167,139,250,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0, cursor: onNavigateToProfile ? 'pointer' : 'default', position: 'relative' }}
        >
          {otherUser.avatarUrl
            ? <img src={otherUser.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <span style={{ color: '#A78BFA', fontSize: '15px', fontWeight: 700 }}>{otherUser.name[0]?.toUpperCase()}</span>
          }
          {isOnline && (
            <div style={{ position: 'absolute', bottom: '-1px', right: '-1px', width: '11px', height: '11px', borderRadius: '50%', background: '#10B981', border: '2px solid #090514' }} />
          )}
        </div>
        <div onClick={() => onNavigateToProfile?.(otherUser.id)} style={{ cursor: onNavigateToProfile ? 'pointer' : 'default', flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{otherUser.name}</p>
            <BadgeChip tier={otherUser.vc_badge} />
          </div>
          <p style={{ color: otherTyping ? '#A78BFA' : '#8B8FA8', fontSize: '11px', margin: 0, fontWeight: otherTyping ? 600 : 400 }}>
            {otherTyping ? 'typing…' : eventTitle ? `Re: ${eventTitle}` : isOnline ? 'Online' : ''}
          </p>
        </div>
        <button onClick={() => setShowSearch(true)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', flexShrink: 0 }}>
          <Search size={18} color="#8B8FA8" />
        </button>
      </div>

      {/* Pending request banner — only shown to the RECIPIENT of an
          unanswered request; the requester just sees their messages sitting
          there (iMessage/IG both let the sender keep composing while it's
          pending). */}
      {requestStatus === 'pending_incoming' && (
        <div style={{ padding: '12px 16px', background: 'rgba(167,139,250,0.08)', borderBottom: '1px solid rgba(167,139,250,0.15)', flexShrink: 0 }}>
          <p style={{ color: '#F0F0FF', fontSize: '13px', margin: '0 0 10px', textAlign: 'center' }}>
            <b>{otherUser.name}</b> wants to message you.
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={() => respondToRequest('decline')} disabled={respondingRequest} style={{ flex: 1, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', padding: '10px', color: '#C4C9E0', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>Decline</button>
            <button onClick={() => respondToRequest('accept')} disabled={respondingRequest} style={{ flex: 1, background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', border: 'none', borderRadius: '12px', padding: '10px', color: '#fff', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}>Accept</button>
          </div>
        </div>
      )}
      {requestStatus === 'pending_outgoing' && (
        <div style={{ padding: '8px 16px', background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0 }}>
          <p style={{ color: '#8B8FA8', fontSize: '12px', margin: 0, textAlign: 'center' }}>Message request sent — you'll be notified when {otherUser.name} accepts.</p>
        </div>
      )}
      {requestStatus === 'declined' && (
        <div style={{ padding: '8px 16px', background: 'rgba(239,68,68,0.08)', borderBottom: '1px solid rgba(239,68,68,0.15)', flexShrink: 0 }}>
          <p style={{ color: '#EF4444', fontSize: '12px', margin: 0, textAlign: 'center' }}>This conversation isn't open — {otherUser.name} isn't accepting messages from you right now.</p>
        </div>
      )}

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px', scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' }}>
        {loading ? (
          <p style={{ color: '#8B8FA8', textAlign: 'center', padding: '20px' }}>Loading…</p>
        ) : messages.length === 0 && pendingMessages.length === 0 ? (
          <p style={{ color: '#8B8FA8', textAlign: 'center', padding: '20px', fontSize: '13px' }}>No messages yet. Say hello!</p>
        ) : [...messages, ...pendingMessages].map((m) => {
          const isMine = m.sender_id === currentUser.id;
          const isDeleted = m.deleted_by_sender;
          const msgReactions = reactions[m.id] || [];
          const reactionCounts = msgReactions.reduce<Record<string, number>>((acc, r) => { acc[r.emoji] = (acc[r.emoji] || 0) + 1; return acc; }, {});
          const quoted = m.reply_to_id ? byId[m.reply_to_id] : null;
          return (
            <div
              key={m.id}
              ref={el => { messageRefs.current[m.id] = el; }}
              style={{ display: 'flex', flexDirection: 'column', alignItems: isMine ? 'flex-end' : 'flex-start', animation: 'bubbleIn 0.22s cubic-bezier(0.16, 1, 0.3, 1)' }}
              onTouchStart={() => { longPressTimer.current = setTimeout(() => { if (!isDeleted) { haptics.light(); setActionMsg(m); } }, 500); }}
              onTouchEnd={() => { if (longPressTimer.current) clearTimeout(longPressTimer.current); }}
              onContextMenu={e => { e.preventDefault(); if (!isDeleted) setActionMsg(m); }}
            >
              <div style={{
                maxWidth: '75%',
                background: isDeleted ? 'rgba(255,255,255,0.04)' : isMine ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)' : '#131629',
                borderRadius: isMine ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
                padding: (m.image_url && !isDeleted) ? '8px' : '10px 14px',
                border: isMine && !isDeleted ? 'none' : '1px solid rgba(255,255,255,0.06)',
              }}>
                {quoted && !isDeleted && (
                  <div style={{ borderLeft: `2px solid ${isMine ? 'rgba(255,255,255,0.5)' : '#A78BFA'}`, paddingLeft: '8px', marginBottom: '6px', opacity: 0.75 }}>
                    <p style={{ fontSize: '11px', color: isMine ? 'rgba(255,255,255,0.85)' : '#A78BFA', margin: 0, fontWeight: 600 }}>
                      {quoted.sender_id === currentUser.id ? 'You' : otherUser.name}
                    </p>
                    <p style={{ fontSize: '12px', color: isMine ? 'rgba(255,255,255,0.7)' : '#8B8FA8', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {quoted.deleted_by_sender ? 'Message deleted' : quoted.image_url ? '📷 Photo' : quoted.body}
                    </p>
                  </div>
                )}
                {isDeleted ? (
                  <p style={{ color: '#8B8FA8', fontSize: '13px', margin: 0, fontStyle: 'italic' }}>This message was deleted</p>
                ) : m.image_url ? (
                  <img
                    src={m.image_url} alt="Sent image" loading="lazy" decoding="async"
                    onClick={() => setLightboxUrl(m.image_url!)}
                    style={{ maxWidth: '200px', maxHeight: '200px', borderRadius: '14px', objectFit: 'cover', cursor: 'zoom-in', display: 'block' }}
                  />
                ) : (
                  <p style={{ color: '#F0F0FF', fontSize: '14px', margin: 0, lineHeight: 1.45, wordBreak: 'break-word' }}>{m.body}</p>
                )}
                {!isDeleted && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '3px', marginTop: '4px' }}>
                    <span style={{ color: isMine ? 'rgba(255,255,255,0.55)' : '#8B8FA8', fontSize: '10px' }}>
                      {m._pending === 'queued' ? 'Waiting for connection…' : m._pending === 'sending' ? 'Sending…' : formatTime(m.created_at)}
                    </span>
                    {isMine && !m._pending && (m.read_at
                      ? <CheckCheck size={12} color="#A78BFA" />
                      : <Check size={12} color="rgba(255,255,255,0.4)" />
                    )}
                  </div>
                )}
              </div>
              {Object.keys(reactionCounts).length > 0 && (
                <div style={{ display: 'flex', gap: '3px', marginTop: '3px', flexWrap: 'wrap', justifyContent: isMine ? 'flex-end' : 'flex-start' }}>
                  {Object.entries(reactionCounts).map(([emoji, count]) => {
                    const mine = msgReactions.some(r => r.emoji === emoji && r.user_id === currentUser.id);
                    return (
                      <button
                        key={emoji}
                        onClick={() => toggleReaction(m.id, emoji)}
                        style={{ display: 'flex', alignItems: 'center', gap: '3px', background: mine ? 'rgba(167,139,250,0.2)' : '#131629', border: `1px solid ${mine ? 'rgba(167,139,250,0.4)' : 'rgba(255,255,255,0.08)'}`, borderRadius: '10px', padding: '2px 6px', cursor: 'pointer', width: 'fit-content' }}
                      >
                        <span style={{ fontSize: '11px' }}>{emoji}</span>
                        {count > 1 && <span style={{ fontSize: '10px', color: '#8B8FA8', fontWeight: 600 }}>{count}</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {otherTyping && (
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <div style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '18px 18px 18px 4px', padding: '12px 16px', display: 'flex', gap: '4px', animation: 'bubbleIn 0.2s ease' }}>
              {[0, 1, 2].map(i => (
                <span key={i} style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#8B8FA8', display: 'inline-block', animation: `typingDot 1.1s ${i * 0.15}s infinite ease-in-out` }} />
              ))}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Reply preview */}
      {replyTo && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 16px', background: '#090514', borderTop: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
          <Reply size={14} color="#A78BFA" style={{ flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: '11px', color: '#A78BFA', margin: 0, fontWeight: 600 }}>Replying to {replyTo.sender_id === currentUser.id ? 'yourself' : otherUser.name}</p>
            <p style={{ fontSize: '12px', color: '#8B8FA8', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{replyTo.image_url ? '📷 Photo' : replyTo.body}</p>
          </div>
          <button onClick={() => setReplyTo(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}>
            <X size={16} color="#8B8FA8" />
          </button>
        </div>
      )}

      {/* Input */}
      <div style={{
        padding: '10px 16px', paddingBottom: 'calc(10px + env(safe-area-inset-bottom))',
        background: '#090514', borderTop: replyTo ? 'none' : '1px solid rgba(255,255,255,0.06)',
        display: 'flex', gap: '8px', alignItems: 'flex-end', flexShrink: 0,
        transform: 'translateZ(0)', position: 'relative', zIndex: 10,
      }}>
        {imageSharingEnabled && (
          <button onClick={async () => { const native = await pickImage(); if (native) { sendImageMessage(native); return; } imgInputRef.current?.click(); }} disabled={uploadingImg} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 2px', flexShrink: 0 }}>
            <Image size={20} color={uploadingImg ? '#555C7A' : '#8B8FA8'} />
          </button>
        )}
        <textarea
          value={body}
          onChange={e => { setBody(e.target.value); if (e.target.value) sendTyping(); }}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
          placeholder="Type a message…"
          rows={1}
          style={{
            flex: 1, background: '#131629', border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '20px', padding: '10px 14px', color: '#F0F0FF', fontSize: '14px',
            resize: 'none', outline: 'none', fontFamily: 'inherit', lineHeight: 1.4,
            maxHeight: '120px', overflowY: 'auto', scrollbarWidth: 'none',
          }}
        />
        <button
          onClick={sendMessage}
          disabled={!body.trim()}
          style={{
            width: '40px', height: '40px', borderRadius: '50%', flexShrink: 0,
            background: body.trim() ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)' : '#1A1D2E',
            border: 'none', cursor: body.trim() ? 'pointer' : 'not-allowed',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <Send size={16} color={body.trim() ? '#fff' : '#555C7A'} />
        </button>
      </div>
    </div>
  );
}
