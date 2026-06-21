import React, { useState, useEffect, useRef } from 'react';
import { X, ChevronLeft, ChevronRight, Plus, Upload, Loader } from 'lucide-react';
import { insforge, getAuthToken } from '../../lib/insforge';

interface Highlight {
  id: string;
  user_id: string;
  media_url: string;
  media_type: 'image' | 'video';
  caption: string | null;
  created_at: string;
}

interface HighlightsStripProps {
  userId: string;
  isOwnProfile: boolean;
  onHighlightClick: (highlights: Highlight[], index: number) => void;
  refreshTrigger?: number;
}

// ── Highlights horizontal strip ─────────────────────────────────────────────
export function HighlightsStrip({ userId, isOwnProfile, onHighlightClick, refreshTrigger = 0 }: HighlightsStripProps) {
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadHighlights = async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const { data } = await insforge.database
        .from('highlights')
        .select('id, user_id, media_url, media_type, caption, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      setHighlights(data || []);
    } catch (err) {
      console.error('Failed to load highlights:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadHighlights();
  }, [userId, refreshTrigger]);

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const token = await getAuthToken();
      console.log('[HighlightsModal] handleUpload token prefix:', token.slice(0, 20));
      const mediaType = file.type.startsWith('video/') ? 'video' : 'image';
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(
        `${import.meta.env.VITE_INSFORGE_URL}/api/storage/buckets/highlights/objects`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData }
      );
      console.log('[HighlightsModal] upload response status:', res.status);
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      const data = await res.json();
      const key: string | null = data?.key ?? null;
      const url: string | null = data?.url ?? (key ? `${import.meta.env.VITE_INSFORGE_URL}/api/storage/buckets/highlights/objects/${encodeURIComponent(key)}` : null);
      if (!url) throw new Error('No URL returned from upload');

      await insforge.database.from('highlights').insert([{
        user_id: userId,
        media_url: url,
        media_type: mediaType,
        caption: null,
      }]);

      await loadHighlights();
    } catch (err: any) {
      console.error('Failed to upload highlight:', err);
      alert(err?.message || 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  if (loading && highlights.length === 0) return null;
  if (highlights.length === 0 && !isOwnProfile) return null;

  return (
    <div style={{ padding: '0 0 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px 12px' }}>
        <span style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          Highlights
        </span>
        {isOwnProfile && highlights.length > 0 && (
          <span style={{ color: '#8B8FA8', fontSize: '11px' }}>{highlights.length} highlight{highlights.length !== 1 ? 's' : ''}</span>
        )}
      </div>

      <div style={{ display: 'flex', gap: '12px', overflowX: 'auto', paddingLeft: '20px', paddingRight: '20px', scrollbarWidth: 'none' }}>
        {/* Add button (own profile) */}
        {isOwnProfile && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              style={{
                width: '64px', height: '64px', borderRadius: '50%', border: '2px dashed rgba(168,85,247,0.5)',
                background: 'rgba(168,85,247,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', flexShrink: 0, position: 'relative',
              }}
            >
              {uploading ? <Loader size={22} color="#A855F7" style={{ animation: 'spin 1s linear infinite' }} /> : <Plus size={22} color="#A855F7" />}
            </button>
            <span style={{ color: '#8B8FA8', fontSize: '10px', textAlign: 'center', maxWidth: '68px' }}>New</span>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*"
              style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); e.target.value = ''; }}
            />
          </div>
        )}

        {/* Highlight circles */}
        {highlights.map((h, idx) => (
          <div
            key={h.id}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', flexShrink: 0, cursor: 'pointer' }}
            onClick={() => onHighlightClick(highlights, idx)}
          >
            <div style={{
              width: '64px', height: '64px', borderRadius: '50%', padding: '2px',
              background: 'linear-gradient(135deg, #A855F7, #EC4899, #F97316)',
              flexShrink: 0,
            }}>
              <div style={{ width: '100%', height: '100%', borderRadius: '50%', overflow: 'hidden', border: '2px solid #000' }}>
                {h.media_type === 'video' ? (
                  <video src={h.media_url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} muted playsInline />
                ) : (
                  <img src={h.media_url} alt="Highlight" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                )}
              </div>
            </div>
            <span style={{ color: '#8B8FA8', fontSize: '10px', textAlign: 'center', maxWidth: '68px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {h.caption || new Date(h.created_at).toLocaleDateString('en-NG', { month: 'short', day: 'numeric' })}
            </span>
          </div>
        ))}
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

// ── Full-screen Highlights Modal ─────────────────────────────────────────────
export function HighlightsModal({
  highlights,
  startIndex,
  onClose,
}: {
  highlights: Highlight[];
  startIndex: number;
  onClose: () => void;
}) {
  const [current, setCurrent] = useState(startIndex);
  const touchStartX = useRef<number | null>(null);

  const prev = () => setCurrent(c => Math.max(0, c - 1));
  const next = () => setCurrent(c => Math.min(highlights.length - 1, c + 1));

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    const delta = e.changedTouches[0].clientX - touchStartX.current;
    if (Math.abs(delta) > 50) {
      if (delta < 0) next();
      else prev();
    }
    touchStartX.current = null;
  };

  const h = highlights[current];
  if (!h) return null;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: '#000', zIndex: 9999,
        display: 'flex', flexDirection: 'column',
      }}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Progress bar */}
      <div style={{ display: 'flex', gap: '4px', padding: 'calc(16px + env(safe-area-inset-top)) 16px 12px', position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 }}>
        {highlights.map((_, i) => (
          <div key={i} style={{ flex: 1, height: '2px', borderRadius: '2px', background: i <= current ? '#fff' : 'rgba(255,255,255,0.3)', transition: 'background 0.3s' }} />
        ))}
      </div>

      {/* Close */}
      <button
        onClick={onClose}
        style={{ position: 'absolute', top: 'calc(28px + env(safe-area-inset-top))', right: '16px', zIndex: 11, background: 'rgba(0,0,0,0.5)', border: 'none', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
      >
        <X size={20} color="#fff" />
      </button>

      {/* Media */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {h.media_type === 'video' ? (
          <video
            key={h.id}
            src={h.media_url}
            autoPlay
            loop
            muted
            playsInline
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <img
            key={h.id}
            src={h.media_url}
            alt="Highlight"
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        )}
      </div>

      {/* Caption */}
      {h.caption && (
        <div style={{ position: 'absolute', bottom: 'calc(60px + env(safe-area-inset-bottom))', left: '16px', right: '16px' }}>
          <p style={{ color: '#fff', fontSize: '14px', textAlign: 'center', textShadow: '0 1px 8px rgba(0,0,0,0.8)', margin: 0 }}>{h.caption}</p>
        </div>
      )}

      {/* Navigation arrows */}
      {current > 0 && (
        <button onClick={prev} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: '50%', width: '40px', height: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 10 }}>
          <ChevronLeft size={22} color="#fff" />
        </button>
      )}
      {current < highlights.length - 1 && (
        <button onClick={next} style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: '50%', width: '40px', height: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 10 }}>
          <ChevronRight size={22} color="#fff" />
        </button>
      )}

      {/* Date watermark */}
      <div style={{ position: 'absolute', bottom: 'calc(30px + env(safe-area-inset-bottom))', left: 0, right: 0, textAlign: 'center' }}>
        <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: '11px' }}>
          {new Date(h.created_at).toLocaleDateString('en-NG', { dateStyle: 'long' })}
        </span>
      </div>
    </div>
  );
}
