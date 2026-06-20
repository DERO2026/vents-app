import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, Send, Image, Trash2, Check, CheckCheck, MapPin } from 'lucide-react';
import { insforge, getAuthToken } from '../../lib/insforge';
import { UserProfile } from './types';

interface ConversationScreenProps {
  currentUser: UserProfile;
  otherUser: { id: string; name: string; avatarUrl?: string };
  eventId?: string;
  eventTitle?: string;
  onBack: () => void;
}

interface DM {
  id: string;
  sender_id: string;
  body: string;
  image_url?: string | null;
  media_type?: string | null;
  deleted_by_sender?: boolean;
  created_at: string;
  read_at?: string | null;
}

export function ConversationScreen({ currentUser, otherUser, eventId, eventTitle, onBack }: ConversationScreenProps) {
  const [messages, setMessages] = useState<DM[]>([]);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [longPressId, setLongPressId] = useState<string | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [uploadingImg, setUploadingImg] = useState(false);
  const [swipeStartX, setSwipeStartX] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!currentUser?.id || !otherUser?.id) return;
    load();

    // Realtime: subscribe to user's channel and reload on new message from this conversation
    const channel = `user:${currentUser.id}`;
    let subscribed = false;
    insforge.realtime.connect().then(() => {
      insforge.realtime.subscribe(channel).then(() => { subscribed = true; });
    }).catch(() => {});

    const handler = (payload: any) => {
      if (
        payload?.sender_id === otherUser.id ||
        payload?.recipient_id === otherUser.id
      ) {
        load();
      }
    };
    insforge.realtime.on('new_message', handler);

    // Fallback poll every 8s in case WS drops
    const interval = setInterval(load, 8000);
    return () => {
      clearInterval(interval);
      insforge.realtime.off?.('new_message', handler);
      if (subscribed) insforge.realtime.unsubscribe(channel);
    };
  }, [currentUser?.id, otherUser?.id]);

  const sendImageMessage = useCallback(async (file: File) => {
    setUploadingImg(true);
    try {
      const token = await getAuthToken();
      const formData = new FormData();
      formData.append('file', new File([file], `dm-${Date.now()}.${file.name.split('.').pop()}`, { type: file.type }));
      const res = await fetch(
        `${import.meta.env.VITE_INSFORGE_URL}/api/storage/buckets/direct_messages/objects`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData }
      );
      if (!res.ok) throw new Error('Upload failed');
      const data = await res.json();
      const url = data?.url ?? (data?.key ? `${import.meta.env.VITE_INSFORGE_URL}/api/storage/buckets/direct_messages/objects/${encodeURIComponent(data.key)}` : null);
      if (!url) throw new Error('No URL');
      await insforge.database.from('direct_messages').insert({
        sender_id: currentUser.id, recipient_id: otherUser.id,
        event_id: eventId || null, body: '', image_url: url, media_type: 'image',
      });
      await load();
    } catch (e) { console.error('Image send failed', e); }
    finally { setUploadingImg(false); }
  }, [currentUser.id, otherUser.id, eventId]);

  const sendLocation = useCallback(async () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(async pos => {
      const { latitude, longitude } = pos.coords;
      const mapsUrl = `https://www.google.com/maps?q=${latitude},${longitude}`;
      await insforge.database.from('direct_messages').insert({
        sender_id: currentUser.id, recipient_id: otherUser.id,
        event_id: eventId || null,
        body: `📍 Location: ${mapsUrl}`,
      });
      await load();
    });
  }, [currentUser.id, otherUser.id, eventId]);

  const deleteMessage = useCallback(async (id: string) => {
    await insforge.database.from('direct_messages').update({ deleted_by_sender: true }).eq('id', id).eq('sender_id', currentUser.id);
    setMessages(prev => prev.map(m => m.id === id ? { ...m, deleted_by_sender: true, body: '' } : m));
    setLongPressId(null);
  }, [currentUser.id]);

  async function load() {
    try {
      const { data } = await insforge.database
        .from('direct_messages')
        .select('id, sender_id, body, image_url, media_type, deleted_by_sender, created_at, read_at')
        .or(
          `and(sender_id.eq.${currentUser.id},recipient_id.eq.${otherUser.id}),and(sender_id.eq.${otherUser.id},recipient_id.eq.${currentUser.id})`
        )
        .order('created_at', { ascending: true })
        .limit(100);

      setMessages((data as DM[]) || []);

      // Mark unread incoming messages as read
      const unread = (data || []).filter(
        (m: any) => m.recipient_id !== currentUser.id && !m.read_at
      );
      if (unread.length > 0) {
        await insforge.database
          .from('direct_messages')
          .update({ read_at: new Date().toISOString() })
          .in('id', unread.map((m: any) => m.id));
      }
    } catch (e) {
      console.error('ConversationScreen load error', e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function sendMessage() {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    setBody('');
    try {
      await insforge.database.from('direct_messages').insert({
        sender_id: currentUser.id,
        recipient_id: otherUser.id,
        event_id: eventId || null,
        body: text,
      });
      await load();
    } catch (e: any) {
      setBody(text);
      console.error('Send failed', e);
    } finally {
      setSending(false);
    }
  }

  function formatTime(iso: string) {
    return new Date(iso).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  return (
    <div
      style={{ background: '#060A12', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}
      onTouchStart={e => setSwipeStartX(e.touches[0].clientX)}
      onTouchEnd={e => {
        if (swipeStartX !== null && e.changedTouches[0].clientX - swipeStartX > 60) onBack();
        setSwipeStartX(null);
      }}
    >
      {/* Image lightbox */}
      {lightboxUrl && (
        <div onClick={() => setLightboxUrl(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.97)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <img src={lightboxUrl} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        </div>
      )}
      {/* Long-press context menu */}
      {longPressId && (
        <div onClick={() => setLongPressId(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#1A1D2E', borderRadius: '16px', padding: '8px', minWidth: '180px' }}>
            <button
              onClick={e => { e.stopPropagation(); deleteMessage(longPressId); }}
              style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%', padding: '14px 16px', background: 'none', border: 'none', color: '#EF4444', fontSize: '14px', cursor: 'pointer', borderRadius: '12px' }}
            >
              <Trash2 size={16} /> Delete message
            </button>
          </div>
        </div>
      )}
      <input ref={imgInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) sendImageMessage(f); e.target.value = ''; }} />
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '12px',
        padding: 'calc(14px + env(safe-area-inset-top)) 16px 12px',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        flexShrink: 0,
        background: '#0D1220',
      }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
          <ArrowLeft size={22} color="#A78BFA" />
        </button>
        <div style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(167,139,250,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
          {otherUser.avatarUrl
            ? <img src={otherUser.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <span style={{ color: '#A78BFA', fontSize: '15px', fontWeight: 700 }}>{otherUser.name[0]?.toUpperCase()}</span>
          }
        </div>
        <div>
          <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700, margin: 0 }}>{otherUser.name}</p>
          {eventTitle && <p style={{ color: '#8B8FA8', fontSize: '11px', margin: 0 }}>Re: {eventTitle}</p>}
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px', scrollbarWidth: 'none' }}>
        {loading ? (
          <p style={{ color: '#8B8FA8', textAlign: 'center', padding: '20px' }}>Loading…</p>
        ) : messages.length === 0 ? (
          <p style={{ color: '#8B8FA8', textAlign: 'center', padding: '20px', fontSize: '13px' }}>
            No messages yet. Say hello!
          </p>
        ) : messages.map((m) => {
          const isMine = m.sender_id === currentUser.id;
          const isDeleted = m.deleted_by_sender;
          const isLocationMsg = m.body?.startsWith('📍 Location: ');
          const locationUrl = isLocationMsg ? m.body.replace('📍 Location: ', '') : null;
          return (
            <div
              key={m.id}
              style={{ display: 'flex', justifyContent: isMine ? 'flex-end' : 'flex-start' }}
              onTouchStart={() => { longPressTimer.current = setTimeout(() => { if (isMine && !isDeleted) setLongPressId(m.id); }, 600); }}
              onTouchEnd={() => { if (longPressTimer.current) clearTimeout(longPressTimer.current); }}
              onContextMenu={e => { e.preventDefault(); if (isMine && !isDeleted) setLongPressId(m.id); }}
            >
              <div style={{
                maxWidth: '75%',
                background: isDeleted ? 'rgba(255,255,255,0.04)' : isMine ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)' : '#131629',
                borderRadius: isMine ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
                padding: m.image_url && !isDeleted ? '4px' : '10px 14px',
                border: isMine && !isDeleted ? 'none' : '1px solid rgba(255,255,255,0.06)',
              }}>
                {isDeleted ? (
                  <p style={{ color: '#8B8FA8', fontSize: '13px', margin: 0, fontStyle: 'italic' }}>This message was deleted</p>
                ) : m.image_url ? (
                  <img
                    src={m.image_url} alt="Sent image"
                    onClick={() => setLightboxUrl(m.image_url!)}
                    style={{ maxWidth: '200px', maxHeight: '200px', borderRadius: '14px', objectFit: 'cover', cursor: 'zoom-in', display: 'block' }}
                  />
                ) : locationUrl ? (
                  <a href={locationUrl} target="_blank" rel="noreferrer" style={{ color: '#A78BFA', fontSize: '13px', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <MapPin size={14} /> View location
                  </a>
                ) : (
                  <p style={{ color: '#F0F0FF', fontSize: '14px', margin: 0, lineHeight: 1.45, wordBreak: 'break-word' }}>{m.body}</p>
                )}
                {!isDeleted && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '3px', marginTop: '4px' }}>
                    <span style={{ color: isMine ? 'rgba(255,255,255,0.55)' : '#8B8FA8', fontSize: '10px' }}>{formatTime(m.created_at)}</span>
                    {isMine && (m.read_at
                      ? <CheckCheck size={12} color="#A78BFA" />
                      : <Check size={12} color="rgba(255,255,255,0.4)" />
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{
        padding: '10px 16px',
        paddingBottom: 'calc(10px + env(safe-area-inset-bottom))',
        background: '#0D1220',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        display: 'flex', gap: '8px', alignItems: 'flex-end', flexShrink: 0,
      }}>
        <button onClick={() => imgInputRef.current?.click()} disabled={uploadingImg} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 2px', flexShrink: 0 }}>
          <Image size={20} color={uploadingImg ? '#555C7A' : '#8B8FA8'} />
        </button>
        <button onClick={sendLocation} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 2px', flexShrink: 0 }}>
          <MapPin size={20} color="#8B8FA8" />
        </button>
        <textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
          placeholder="Type a message…"
          rows={1}
          style={{
            flex: 1, background: '#131629', border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '20px', padding: '10px 14px',
            color: '#F0F0FF', fontSize: '14px', resize: 'none',
            outline: 'none', fontFamily: 'inherit', lineHeight: 1.4,
            maxHeight: '120px', overflowY: 'auto', scrollbarWidth: 'none',
          }}
        />
        <button
          onClick={sendMessage}
          disabled={!body.trim() || sending}
          style={{
            width: '40px', height: '40px', borderRadius: '50%', flexShrink: 0,
            background: body.trim() ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)' : '#1A1D2E',
            border: 'none', cursor: body.trim() ? 'pointer' : 'not-allowed',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background 0.2s',
          }}
        >
          <Send size={16} color={body.trim() ? '#fff' : '#555C7A'} />
        </button>
      </div>
    </div>
  );
}
