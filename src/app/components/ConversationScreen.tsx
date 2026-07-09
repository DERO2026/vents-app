import { useState, useEffect, useRef, useCallback } from 'react';
import BadgeChip from './BadgeChip';
import { ArrowLeft, Send, Image, Trash2, Check, CheckCheck, MapPin, Mic, Square, Play, Pause } from 'lucide-react';
import { insforge, getAuthToken } from '../../lib/insforge';

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
  duration_seconds?: number | null;
  deleted_by_sender?: boolean;
  created_at: string;
  read_at?: string | null;
  /** Client-only: set on optimistic messages not yet confirmed by the server. */
  _pending?: 'sending' | 'queued';
}

async function compressImage(file: File, maxPx = 1200, quality = 0.82): Promise<File> {
  if (!file.type.startsWith('image/')) return file;
  return new Promise((resolve) => {
    const img = new window.Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (Math.max(width, height) > maxPx) {
        const ratio = maxPx / Math.max(width, height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => resolve(blob ? new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' }) : file),
        'image/jpeg', quality
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

export function ConversationScreen({ currentUser, otherUser, eventId, eventTitle, onBack, onNavigateToProfile }: ConversationScreenProps) {
  const [messages, setMessages] = useState<DM[]>([]);
  const [pendingMessages, setPendingMessages] = useState<DM[]>([]);
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(true);
  const [longPressId, setLongPressId] = useState<string | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [uploadingImg, setUploadingImg] = useState(false);
  const [swipeStartX, setSwipeStartX] = useState<number | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [voiceToast, setVoiceToast] = useState<string | null>(null);
  const [locationModalVisible, setLocationModalVisible] = useState(false);
  const pendingLocationRef = useRef(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioCacheRef = useRef<Record<string, HTMLAudioElement>>({});
  const durationMsRef = useRef(0);

  // Immediately mark all unread incoming messages as read on mount — fire and forget
  // This runs before load() completes so InboxScreen sees zero unread when user goes back
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
      const compressed = await compressImage(file);
      const formData = new FormData();
      formData.append('file', new File([compressed], `dm-${Date.now()}.jpg`, { type: compressed.type }));
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

  const doGetLocation = useCallback(async () => {
    if (!navigator.geolocation) {
      setVoiceToast('Location not available on this device');
      setTimeout(() => setVoiceToast(null), 3000);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async pos => {
        const { latitude: lat, longitude: lng } = pos.coords;
        await insforge.database.from('direct_messages').insert({
          sender_id: currentUser.id, recipient_id: otherUser.id,
          event_id: eventId || null,
          body: JSON.stringify({ lat, lng, label: 'Current Location' }),
          media_type: 'location',
        });
        await load();
      },
      () => {
        setVoiceToast('Location permission denied');
        setTimeout(() => setVoiceToast(null), 3000);
      }
    );
  }, [currentUser.id, otherUser.id, eventId]);

  const sendLocation = useCallback(async () => {
    if (localStorage.getItem('vents_location_asked')) {
      doGetLocation();
    } else {
      setLocationModalVisible(true);
    }
  }, [doGetLocation]);

  const startRecording = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setVoiceToast('Voice messages are not supported on your current browser. Please use Chrome or update your browser.');
      setTimeout(() => setVoiceToast(null), 5000);
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setVoiceToast('Microphone permission denied. Please allow mic access and try again.');
      setTimeout(() => setVoiceToast(null), 4000);
      return;
    }
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
      ? 'audio/webm'
      : MediaRecorder.isTypeSupported('audio/mp4')
      ? 'audio/mp4'
      : '';
    let mr: MediaRecorder;
    try {
      mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      mr = new MediaRecorder(stream);
    }
    audioChunksRef.current = [];
    durationMsRef.current = 0;
    mr.ondataavailable = e => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
    mr.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(audioChunksRef.current, { type: mr.mimeType || 'audio/webm' });
      if (blob.size < 500) return;
      setUploadingImg(true);
      try {
        const token = await getAuthToken();
        const mt = mr.mimeType || 'audio/webm';
        const ext = mt.includes('ogg') ? 'ogg' : mt.includes('mp4') ? 'mp4' : 'webm';
        const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: mt });
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch(
          `${import.meta.env.VITE_INSFORGE_URL}/api/storage/buckets/direct_messages/objects`,
          { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData }
        );
        if (!res.ok) throw new Error('Upload failed');
        const data = await res.json();
        const url = data?.url ?? (data?.key ? `${import.meta.env.VITE_INSFORGE_URL}/api/storage/buckets/direct_messages/objects/${encodeURIComponent(data.key)}` : null);
        if (!url) throw new Error('No URL');
        const durSec = Math.max(1, Math.round(durationMsRef.current / 1000));
        await insforge.database.from('direct_messages').insert({
          sender_id: currentUser.id, recipient_id: otherUser.id,
          event_id: eventId || null, body: '', image_url: url, media_type: 'audio',
          duration_seconds: durSec,
        });
        await load();
      } catch (e) {
        console.error('Voice send failed', e);
        setVoiceToast('Failed to send voice message');
        setTimeout(() => setVoiceToast(null), 3000);
      } finally { setUploadingImg(false); }
    };
    mr.start(100);
    mediaRecorderRef.current = mr;
    setRecording(true);
    setRecordingSeconds(0);
    durationMsRef.current = 0;
    recordingTimerRef.current = setInterval(() => {
      durationMsRef.current += 100;
      const secs = Math.floor(durationMsRef.current / 1000);
      setRecordingSeconds(secs);
      if (secs >= 60) stopRecording();
    }, 100);
  }, [currentUser.id, otherUser.id, eventId]);

  const stopRecording = useCallback(() => {
    if (recordingTimerRef.current) { clearInterval(recordingTimerRef.current); recordingTimerRef.current = null; }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setRecording(false);
    setRecordingSeconds(0);
  }, []);

  // toggleAudio: storage URLs redirect 302 → CDN signed URL, no auth header needed.
  // Cache Audio elements per message id so repeated taps don't re-fetch.
  const toggleAudio = useCallback((id: string, url: string) => {
    setAudioError(null);
    if (playingId === id) {
      audioRef.current?.pause();
      setPlayingId(null);
      return;
    }
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    setPlayingId(id);
    let a = audioCacheRef.current[id];
    if (!a) {
      a = new Audio(url);
      a.preload = 'auto';
      a.onended = () => { setPlayingId(null); };
      // Attach to DOM so mobile browsers honour the user-gesture play context.
      a.style.display = 'none';
      document.body.appendChild(a);
      a.onerror = () => { document.body.removeChild(a); delete audioCacheRef.current[id]; };
      audioCacheRef.current[id] = a;
    }
    audioRef.current = a;
    a.play().catch(e => {
      console.error('Audio play failed', e);
      setPlayingId(null);
      setAudioError('Could not play audio');
      setTimeout(() => setAudioError(null), 3000);
    });
  }, [playingId]);

  const deleteMessage = useCallback(async (id: string) => {
    await insforge.database.from('direct_messages').update({ deleted_by_sender: true }).eq('id', id).eq('sender_id', currentUser.id);
    setMessages(prev => prev.map(m => m.id === id ? { ...m, deleted_by_sender: true, body: '' } : m));
    setLongPressId(null);
  }, [currentUser.id]);

  async function load() {
    try {
      const { data } = await insforge.database
        .from('direct_messages')
        .select('id, sender_id, recipient_id, body, image_url, media_type, duration_seconds, deleted_by_sender, created_at, read_at')
        .or(
          `and(sender_id.eq.${currentUser.id},recipient_id.eq.${otherUser.id}),and(sender_id.eq.${otherUser.id},recipient_id.eq.${currentUser.id})`
        )
        .order('created_at', { ascending: true })
        .limit(50);

      setMessages((data as DM[]) || []);

      // Mark unread incoming messages as read
      const unread = (data || []).filter(
        (m: any) => m.recipient_id === currentUser.id && !m.read_at
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

  // Offline-resilient send: a message that fails (or has no connection at
  // all) stays visible as "pending" and retries with exponential backoff,
  // then again immediately on reconnect — never a hard "failed to send".
  async function attemptSend(localId: string, text: string, attempt: number) {
    if (!navigator.onLine) {
      setPendingMessages(prev => prev.map(m => m.id === localId ? { ...m, _pending: 'queued' } : m));
      return; // the 'online' listener below will retry once connectivity returns
    }
    setPendingMessages(prev => prev.map(m => m.id === localId ? { ...m, _pending: 'sending' } : m));
    try {
      await insforge.database.from('direct_messages').insert({
        sender_id: currentUser.id,
        recipient_id: otherUser.id,
        event_id: eventId || null,
        body: text,
      });
      setPendingMessages(prev => prev.filter(m => m.id !== localId));
      await load();
    } catch (e) {
      const delay = Math.min(30000, 1000 * 2 ** attempt); // 1s, 2s, 4s... capped at 30s
      setPendingMessages(prev => prev.map(m => m.id === localId ? { ...m, _pending: 'queued' } : m));
      setTimeout(() => attemptSend(localId, text, attempt + 1), delay);
    }
  }

  useEffect(() => {
    function flushQueueOnReconnect() {
      setPendingMessages(prev => {
        prev.forEach(m => attemptSend(m.id, m.body, 0));
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
    setBody('');
    const localId = `pending_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setPendingMessages(prev => [...prev, {
      id: localId,
      sender_id: currentUser.id,
      recipient_id: otherUser.id,
      body: text,
      created_at: new Date().toISOString(),
      _pending: 'sending',
    }]);
    attemptSend(localId, text, 0);
  }

  function formatTime(iso: string) {
    return new Date(iso).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  return (
    <div
      style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}
      onTouchStart={e => setSwipeStartX(e.touches[0].clientX)}
      onTouchEnd={e => {
        if (swipeStartX !== null && e.changedTouches[0].clientX - swipeStartX > 60) onBack();
        setSwipeStartX(null);
      }}
    >
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>
      {/* Toast / error banners */}
      {(voiceToast || audioError) && (
        <div style={{ position: 'fixed', bottom: '90px', left: '50%', transform: 'translateX(-50%)', background: '#090514', border: '1px solid rgba(167,139,250,0.3)', borderRadius: '12px', padding: '10px 16px', zIndex: 9999, maxWidth: '320px', textAlign: 'center' }}>
          <p style={{ color: '#F0F0FF', fontSize: '13px', margin: 0 }}>{voiceToast || audioError}</p>
        </div>
      )}
      {/* Location permission modal */}
      {locationModalVisible && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 10000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div style={{ background: '#090514', borderRadius: '20px 20px 0 0', padding: '28px 24px 36px', width: '100%', maxWidth: '480px', border: '1px solid rgba(255,255,255,0.08)' }}>
            <h3 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 700, marginBottom: '10px', fontFamily: 'Space Grotesk, sans-serif' }}>Allow Location Access</h3>
            <p style={{ color: '#8B8FA8', fontSize: '14px', lineHeight: 1.6, marginBottom: '24px' }}>Vents uses your location to show events near you. Your location is never stored or shared.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <button
                onClick={() => { localStorage.setItem('vents_location_asked', 'true'); setLocationModalVisible(false); doGetLocation(); }}
                style={{ background: '#7B2FF7', border: 'none', borderRadius: '14px', padding: '14px', color: '#fff', fontSize: '15px', fontWeight: 700, cursor: 'pointer' }}
              >Allow</button>
              <button
                onClick={() => { localStorage.setItem('vents_location_asked', 'true'); setLocationModalVisible(false); }}
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '14px', padding: '14px', color: '#8B8FA8', fontSize: '15px', fontWeight: 600, cursor: 'pointer' }}
              >Not Now</button>
            </div>
          </div>
        </div>
      )}
      {/* Image lightbox */}
      {lightboxUrl && (
        <div onClick={() => setLightboxUrl(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.97)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <img src={lightboxUrl} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        </div>
      )}
      {/* Long-press context menu */}
      {longPressId && (
        <div onClick={() => setLongPressId(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#090514', borderRadius: '16px', padding: '8px', minWidth: '180px' }}>
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
        background: '#090514',
      }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
          <ArrowLeft size={22} color="#A78BFA" />
        </button>
        <div
          onClick={() => onNavigateToProfile?.(otherUser.id)}
          style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(167,139,250,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0, cursor: onNavigateToProfile ? 'pointer' : 'default' }}
        >
          {otherUser.avatarUrl
            ? <img src={otherUser.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <span style={{ color: '#A78BFA', fontSize: '15px', fontWeight: 700 }}>{otherUser.name[0]?.toUpperCase()}</span>
          }
        </div>
        <div onClick={() => onNavigateToProfile?.(otherUser.id)} style={{ cursor: onNavigateToProfile ? 'pointer' : 'default' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700, margin: 0 }}>{otherUser.name}</p>
            <BadgeChip tier={otherUser.vc_badge} />
          </div>
          {eventTitle && <p style={{ color: '#8B8FA8', fontSize: '11px', margin: 0 }}>Re: {eventTitle}</p>}
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px', scrollbarWidth: 'none' }}>
        {loading ? (
          <p style={{ color: '#8B8FA8', textAlign: 'center', padding: '20px' }}>Loading…</p>
        ) : messages.length === 0 && pendingMessages.length === 0 ? (
          <p style={{ color: '#8B8FA8', textAlign: 'center', padding: '20px', fontSize: '13px' }}>
            No messages yet. Say hello!
          </p>
        ) : [...messages, ...pendingMessages].map((m) => {
          const isMine = m.sender_id === currentUser.id;
          const isDeleted = m.deleted_by_sender;
          let locationData: { lat: number; lng: number; label: string } | null = null;
          if (m.media_type === 'location') {
            try { locationData = JSON.parse(m.body); } catch { locationData = null; }
          }
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
                padding: (m.image_url && !isDeleted) || (m.media_type === 'location' && !isDeleted) ? '8px' : '10px 14px',
                border: isMine && !isDeleted ? 'none' : '1px solid rgba(255,255,255,0.06)',
              }}>
                {isDeleted ? (
                  <p style={{ color: '#8B8FA8', fontSize: '13px', margin: 0, fontStyle: 'italic' }}>This message was deleted</p>
                ) : m.media_type === 'audio' && m.image_url ? (
                  <button
                    onClick={() => toggleAudio(m.id, m.image_url!)}
                    style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', minWidth: '140px' }}
                  >
                    <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: isMine ? 'rgba(255,255,255,0.2)' : 'rgba(167,139,250,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {playingId === m.id ? <Pause size={14} color="#fff" /> : <Play size={14} color={isMine ? '#fff' : '#A78BFA'} />}
                    </div>
                    {(() => {
                      const dur = m.duration_seconds ?? 1;
                      const pct = Math.min((dur / 60) * 100, 100);
                      const mins = Math.floor(dur / 60);
                      const secs = dur % 60;
                      const label = `${mins}:${secs.toString().padStart(2, '0')}`;
                      return (
                        <>
                          <div style={{ flex: 1, height: '4px', background: isMine ? 'rgba(255,255,255,0.2)' : 'rgba(167,139,250,0.2)', borderRadius: '2px', overflow: 'hidden', minWidth: '60px' }}>
                            <div style={{ width: `${pct}%`, height: '100%', background: isMine ? '#fff' : '#A78BFA', borderRadius: '2px', opacity: playingId === m.id ? 1 : 0.7 }} />
                          </div>
                          <span style={{ color: isMine ? 'rgba(255,255,255,0.7)' : '#8B8FA8', fontSize: '11px', flexShrink: 0 }}>{label}</span>
                        </>
                      );
                    })()}
                  </button>
                ) : m.image_url ? (
                  <img
                    src={m.image_url} alt="Sent image"
                    onClick={() => setLightboxUrl(m.image_url!)}
                    style={{ maxWidth: '200px', maxHeight: '200px', borderRadius: '14px', objectFit: 'cover', cursor: 'zoom-in', display: 'block' }}
                  />
                ) : locationData ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ borderRadius: '10px', overflow: 'hidden', width: '200px', height: '110px', background: '#090514' }}>
                      <iframe
                        title="map"
                        src={`https://www.openstreetmap.org/export/embed.html?bbox=${locationData.lng - 0.01},${locationData.lat - 0.01},${locationData.lng + 0.01},${locationData.lat + 0.01}&layer=mapnik&marker=${locationData.lat},${locationData.lng}`}
                        style={{ width: '100%', height: '100%', border: 'none', pointerEvents: 'none' }}
                        loading="lazy"
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'space-between' }}>
                      <span style={{ color: isMine ? 'rgba(255,255,255,0.7)' : '#C4C9E0', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <MapPin size={12} /> {locationData.label}
                      </span>
                      <button
                        onClick={() => {
                          if (!window.confirm('Open this location in your Maps app?')) return;
                          const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
                          const isAndroid = /android/i.test(navigator.userAgent);
                          const url = isIOS
                            ? `maps://maps.apple.com/?q=${locationData!.lat},${locationData!.lng}`
                            : isAndroid
                            ? `geo:${locationData!.lat},${locationData!.lng}?q=${locationData!.lat},${locationData!.lng}(${encodeURIComponent(locationData!.label)})`
                            : `https://maps.google.com/?q=${locationData!.lat},${locationData!.lng}`;
                          window.open(url, '_blank');
                        }}
                        style={{ color: '#A78BFA', fontSize: '11px', fontWeight: 700, textDecoration: 'none', background: 'rgba(167,139,250,0.15)', padding: '3px 8px', borderRadius: '6px', border: 'none', cursor: 'pointer' }}
                      >
                        Open ↗
                      </button>
                    </div>
                  </div>
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
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{
        padding: '10px 16px',
        paddingBottom: 'calc(10px + env(safe-area-inset-bottom))',
        background: '#090514',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        display: 'flex', gap: '8px', alignItems: 'flex-end', flexShrink: 0,
        transform: 'translateZ(0)',
        WebkitTransform: 'translateZ(0)',
        position: 'relative',
        zIndex: 10,
      }}>
        {recording ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '10px', background: '#090514', border: '1px solid rgba(239,68,68,0.4)', borderRadius: '20px', padding: '10px 14px' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#EF4444', animation: 'pulse 1s infinite' }} />
            <span style={{ color: '#EF4444', fontSize: '13px', fontWeight: 600 }}>
              {`${Math.floor(recordingSeconds / 60)}:${(recordingSeconds % 60).toString().padStart(2, '0')}`} / 1:00
            </span>
            <button onClick={stopRecording} style={{ marginLeft: 'auto', background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '8px', padding: '4px 10px', color: '#EF4444', fontSize: '12px', fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Square size={12} /> Send
            </button>
          </div>
        ) : (
          <>
            <button onClick={() => imgInputRef.current?.click()} disabled={uploadingImg} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 2px', flexShrink: 0 }}>
              <Image size={20} color={uploadingImg ? '#555C7A' : '#8B8FA8'} />
            </button>
            <button onClick={sendLocation} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 2px', flexShrink: 0 }}>
              <MapPin size={20} color="#8B8FA8" />
            </button>
            <button
              onMouseDown={startRecording}
              onMouseUp={stopRecording}
              onMouseLeave={stopRecording}
              onTouchStart={(e) => { e.preventDefault(); startRecording(); }}
              onTouchEnd={(e) => { e.preventDefault(); stopRecording(); }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 2px', flexShrink: 0 }}
              title="Hold to record voice message"
            >
              <Mic size={20} color="#8B8FA8" />
            </button>
          </>
        )}
        {!recording && (
          <>
            <textarea
              value={body}
              onChange={e => setBody(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
              placeholder="Type a message…"
              rows={1}
              style={{
                flex: 1, background: '#090514', border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '20px', padding: '10px 14px',
                color: '#F0F0FF', fontSize: '14px', resize: 'none',
                outline: 'none', fontFamily: 'inherit', lineHeight: 1.4,
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
                transition: 'background 0.2s',
              }}
            >
              <Send size={16} color={body.trim() ? '#fff' : '#555C7A'} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
