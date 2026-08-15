import { useState } from 'react';
import { CheckCircle } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { CATEGORIES } from './categories';

interface InterestsScreenProps {
  userId: string;
  onDone: () => void;
}

export function InterestsScreen({ userId, onDone }: InterestsScreenProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  async function handleContinue() {
    if (selected.length < 3) { setError('Pick at least 3 interests to continue.'); return; }
    setSaving(true);
    setError(null);
    try {
      await supabase.from('users').update({ interests: selected }).eq('id', userId);
      onDone();
    } catch (err: any) {
      setError(err?.message || 'Failed to save interests.');
      setSaving(false);
    }
  }

  return (
    <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', padding: 'calc(40px + env(safe-area-inset-top)) 24px 32px' }}>
      <div style={{ marginBottom: '32px' }}>
        <h1 style={{ color: '#F0F0FF', fontSize: '26px', fontWeight: 800, margin: '0 0 8px', fontFamily: 'Space Grotesk, sans-serif' }}>What are you into?</h1>
        <p style={{ color: '#8B8FA8', fontSize: '14px', margin: 0 }}>Pick at least 3 interests — we'll use them to personalize your Vents feed.</p>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
          {CATEGORIES.map((cat) => {
            const active = selected.includes(cat.id);
            return (
              <button
                key={cat.id}
                onClick={() => toggle(cat.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '10px 16px',
                  borderRadius: '24px',
                  background: active ? 'rgba(167,139,250,0.18)' : '#131629',
                  border: `1.5px solid ${active ? '#A78BFA' : 'rgba(255,255,255,0.1)'}`,
                  color: active ? '#C4B5FD' : '#C4C9E0',
                  fontSize: '13px',
                  fontWeight: active ? 700 : 500,
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  position: 'relative',
                }}
              >
                <span style={{ fontSize: '18px' }}>{cat.icon}</span>
                <span>{cat.label}</span>
                {active && (
                  <CheckCircle size={14} color="#A78BFA" style={{ position: 'absolute', top: '-5px', right: '-5px' }} />
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ marginTop: '24px' }}>
        {error && <p style={{ color: '#F87171', fontSize: '13px', textAlign: 'center', marginBottom: '12px' }}>{error}</p>}
        <p style={{ color: '#8B8FA8', fontSize: '12px', textAlign: 'center', marginBottom: '12px' }}>
          {selected.length} selected {selected.length < 3 ? `(${3 - selected.length} more needed)` : '✓'}
        </p>
        <button
          onClick={handleContinue}
          disabled={saving || selected.length < 3}
          style={{
            width: '100%',
            padding: '15px',
            background: selected.length >= 3 ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)' : '#1A1D36',
            border: 'none',
            borderRadius: '14px',
            color: selected.length >= 3 ? '#fff' : '#4B5563',
            fontSize: '15px',
            fontWeight: 700,
            cursor: selected.length >= 3 ? 'pointer' : 'not-allowed',
            transition: 'background 0.2s',
          }}
        >
          {saving ? 'Saving…' : 'Continue →'}
        </button>
      </div>
    </div>
  );
}
