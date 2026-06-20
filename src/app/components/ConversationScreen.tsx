import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Send } from 'lucide-react';
import { insforge } from '../../lib/insforge';
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
  created_at: string;
  read_at?: string | null;
}

export function ConversationScreen({ currentUser, otherUser, eventId, eventTitle, onBack }: ConversationScreenProps) {
  const [messages, setMessages] = useState<DM[]>([]);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!currentUser?.id || !otherUser?.id) return;
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [currentUser?.id, otherUser?.id]);

  async function load() {
    try {
      const { data } = await insforge.database
        .from('direct_messages')
        .select('id, sender_id, body, created_at, read_at')
        .or(
          `and(sender_id.eq.${currentUser.id},recipient_id.eq.${otherUser.id}),and(sender_id.eq.${otherUser.id},recipient_id.eq.${currentUser.id})`
        )
        .order('created_at', { ascending: true });

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
    return new Date(iso).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' });
  }

  return (
    <div style={{ background: '#060A12', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
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
          return (
            <div key={m.id} style={{ display: 'flex', justifyContent: isMine ? 'flex-end' : 'flex-start' }}>
              <div style={{
                maxWidth: '75%',
                background: isMine ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)' : '#131629',
                borderRadius: isMine ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
                padding: '10px 14px',
                border: isMine ? 'none' : '1px solid rgba(255,255,255,0.06)',
              }}>
                <p style={{ color: '#F0F0FF', fontSize: '14px', margin: 0, lineHeight: 1.45, wordBreak: 'break-word' }}>{m.body}</p>
                <p style={{ color: isMine ? 'rgba(255,255,255,0.55)' : '#8B8FA8', fontSize: '10px', margin: '4px 0 0', textAlign: 'right' }}>
                  {formatTime(m.created_at)}
                </p>
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
        display: 'flex', gap: '10px', alignItems: 'flex-end', flexShrink: 0,
      }}>
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
