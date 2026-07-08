import { useState, useEffect } from 'react';
import { ArrowLeft, Shield, Eye, MessageCircle, Search, CheckCircle, AlertCircle } from 'lucide-react';
import { insforge } from '../../lib/insforge';

interface Props {
  currentUser: { id: string } | null;
  onBack: () => void;
}

interface Settings {
  profile_visible: 'everyone' | 'followers' | 'nobody';
  can_message: 'everyone' | 'followers' | 'nobody';
  show_in_search: boolean;
  show_attended_events: boolean;
}

const VISIBILITY_OPTIONS = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'followers', label: 'Followers only' },
  { value: 'nobody', label: 'No one' },
];

export function PrivacySecurityScreen({ currentUser, onBack }: Props) {
  const [settings, setSettings] = useState<Settings>({
    profile_visible: 'everyone',
    can_message: 'everyone',
    show_in_search: true,
    show_attended_events: true,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!currentUser?.id) return;
    insforge.database
      .from('user_privacy_settings')
      .select('profile_visible, can_message, show_in_search, show_attended_events')
      .eq('user_id', currentUser.id)
      .maybeSingle()
      .then(({ data }) => {
        if (data) setSettings(data as Settings);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [currentUser?.id]);

  const save = async () => {
    if (!currentUser?.id) return;
    setSaving(true);
    setMsg(null);
    try {
      const { error } = await (insforge.database as any).rpc('upsert_privacy_settings', {
        p_profile_visible: settings.profile_visible,
        p_can_message: settings.can_message,
        p_show_in_search: settings.show_in_search,
        p_show_attended_events: settings.show_attended_events,
      });
      if (error) throw error;
      setMsg({ ok: true, text: 'Privacy settings saved.' });
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || 'Failed to save.' });
    } finally {
      setSaving(false);
      setTimeout(() => setMsg(null), 3000);
    }
  };

  const row = (label: string, sub: string, icon: React.ReactNode, children: React.ReactNode) => (
    <div style={{ background: '#090514', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.06)', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'rgba(167,139,250,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          {icon}
        </div>
        <div>
          <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600, margin: 0 }}>{label}</p>
          <p style={{ color: '#8B8FA8', fontSize: '12px', margin: '2px 0 0' }}>{sub}</p>
        </div>
      </div>
      {children}
    </div>
  );

  const toggle = (checked: boolean, onChange: (v: boolean) => void) => (
    <div
      onClick={() => onChange(!checked)}
      style={{
        width: '44px', height: '26px', borderRadius: '13px',
        background: checked ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)' : '#2A2D3E',
        cursor: 'pointer', position: 'relative', transition: 'background 0.25s', flexShrink: 0,
      }}
    >
      <div style={{
        position: 'absolute', width: '20px', height: '20px', borderRadius: '50%',
        background: '#fff', top: '3px', left: checked ? '21px' : '3px',
        transition: 'left 0.25s', boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
      }} />
    </div>
  );

  const dropdown = (val: string, onChange: (v: any) => void) => (
    <select
      value={val}
      onChange={e => onChange(e.target.value)}
      style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', padding: '8px 12px', color: '#F0F0FF', fontSize: '13px', outline: 'none', cursor: 'pointer' }}
    >
      {VISIBILITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );

  return (
    <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflowY: 'auto', scrollbarWidth: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(18px + env(safe-area-inset-top)) 20px 16px', background: '#020005', flexShrink: 0 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.05)', border: 'none', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={18} color="#C4C9E0" />
        </button>
        <div>
          <h1 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', margin: 0 }}>Privacy & Security</h1>
          <p style={{ color: '#8B8FA8', fontSize: '12px', margin: '2px 0 0' }}>Control who sees your activity</p>
        </div>
        <Shield size={20} color="#A78BFA" style={{ marginLeft: 'auto' }} />
      </div>

      {loading ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8B8FA8', fontSize: '14px' }}>Loading…</div>
      ) : (
        <div style={{ flex: 1, padding: '8px 20px 40px', display: 'flex', flexDirection: 'column', gap: '12px' }}>

          {row('Profile visibility', 'Who can see your profile and events', <Eye size={17} color="#A78BFA" />,
            dropdown(settings.profile_visible, v => setSettings(s => ({ ...s, profile_visible: v })))
          )}

          {row('Messages', 'Who can send you direct messages', <MessageCircle size={17} color="#A78BFA" />,
            dropdown(settings.can_message, v => setSettings(s => ({ ...s, can_message: v })))
          )}

          {row('Appear in search', 'Show your account in People search results', <Search size={17} color="#A78BFA" />,
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ color: '#C4C9E0', fontSize: '13px' }}>{settings.show_in_search ? 'Visible' : 'Hidden'}</span>
              {toggle(settings.show_in_search, v => setSettings(s => ({ ...s, show_in_search: v })))}
            </div>
          )}

          {row('Event attendance', 'Show events you have attended on your profile', <CheckCircle size={17} color="#A78BFA" />,
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ color: '#C4C9E0', fontSize: '13px' }}>{settings.show_attended_events ? 'Visible' : 'Hidden'}</span>
              {toggle(settings.show_attended_events, v => setSettings(s => ({ ...s, show_attended_events: v })))}
            </div>
          )}

          {msg && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px', borderRadius: '12px', background: msg.ok ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${msg.ok ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}` }}>
              {msg.ok ? <CheckCircle size={14} color="#10B981" /> : <AlertCircle size={14} color="#EF4444" />}
              <span style={{ color: msg.ok ? '#10B981' : '#EF4444', fontSize: '13px' }}>{msg.text}</span>
            </div>
          )}

          <button
            onClick={save}
            disabled={saving}
            style={{ background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', border: 'none', borderRadius: '14px', padding: '14px', color: '#fff', fontSize: '15px', fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}
          >
            {saving ? 'Saving…' : 'Save Settings'}
          </button>

          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '14px', padding: '14px' }}>
            <p style={{ color: '#8B8FA8', fontSize: '12px', lineHeight: 1.6, margin: 0 }}>
              These settings only affect how your profile appears to other Vents users. Organizers of events you purchase tickets for will always be able to see your name and contact information.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
