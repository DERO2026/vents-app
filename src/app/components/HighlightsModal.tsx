import React, { useState, useEffect, useRef } from 'react';
import { X, ChevronLeft, ChevronRight, Plus, Loader } from 'lucide-react';
import { insforge, getAuthToken } from '../../lib/insforge';

interface HighlightItem {
  id: string;
  user_id: string;
  group_id: string;
  sort_order: number;
  media_url: string;
  media_type: 'image' | 'video';
  caption: string | null;
  created_at: string;
}

// A "highlight circle" = all items sharing the same group_id
interface HighlightGroup {
  group_id: string;
  caption: string | null;
  items: HighlightItem[];
}

interface HighlightsStripProps {
  userId: string;
  isOwnProfile: boolean;
  onHighlightClick: (groups: HighlightGroup[], index: number) => void;
  refreshTrigger?: number;
}

// ── Highlights horizontal strip ─────────────────────────────────────────────
export function HighlightsStrip({ userId, isOwnProfile, onHighlightClick, refreshTrigger = 0 }: HighlightsStripProps) {
  const [groups, setGroups] = useState<HighlightGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingGroupId, setDeletingGroupId] = useState<string | null>(null);

  // Create new highlight flow
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [pendingName, setPendingName] = useState('');
  const [step, setStep] = useState<'idle' | 'name'>('idle');

  // Add items to existing group flow
  const [addingToGroupId, setAddingToGroupId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const addToGroupFileRef = useRef<HTMLInputElement>(null);

  const loadHighlights = async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const { data } = await insforge.database
        .from('highlights')
        .select('id, user_id, group_id, sort_order, media_url, media_type, caption, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: true })
        .order('sort_order', { ascending: true });

      const items: HighlightItem[] = (data || []).map((row: any) => ({
        ...row,
        group_id: row.group_id || row.id,
      }));

      // Group by group_id
      const groupMap = new Map<string, HighlightItem[]>();
      const groupOrder: string[] = [];
      for (const item of items) {
        if (!groupMap.has(item.group_id)) {
          groupMap.set(item.group_id, []);
          groupOrder.push(item.group_id);
        }
        groupMap.get(item.group_id)!.push(item);
      }

      const built: HighlightGroup[] = groupOrder.map(gid => {
        const groupItems = (groupMap.get(gid) || []).sort((a, b) => a.sort_order - b.sort_order);
        return {
          group_id: gid,
          caption: groupItems[0]?.caption || null,
          items: groupItems,
        };
      });

      setGroups(built);
    } catch (err) {
      console.error('Failed to load highlights:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadHighlights();
  }, [userId, refreshTrigger]);

  const uploadFiles = async (files: File[], groupId: string, startOrder: number) => {
    const token = await getAuthToken();
    const results: { url: string; mediaType: 'image' | 'video'; order: number }[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const mediaType: 'image' | 'video' = file.type.startsWith('video/') ? 'video' : 'image';
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(
        `${import.meta.env.VITE_INSFORGE_URL}/api/storage/buckets/highlights/objects`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData }
      );
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      const data = await res.json();
      const url: string = data?.url ?? (data?.key ? `${import.meta.env.VITE_INSFORGE_URL}/api/storage/buckets/highlights/objects/${encodeURIComponent(data.key)}` : null);
      if (!url) throw new Error('No URL returned from upload');
      results.push({ url, mediaType, order: startOrder + i });
    }
    return results;
  };

  const handleCreateHighlight = async () => {
    if (pendingFiles.length === 0) return;
    const files = pendingFiles;
    const name = pendingName.trim();
    setPendingFiles([]);
    setPendingName('');
    setStep('idle');
    setUploading(true);
    try {
      const groupId = crypto.randomUUID();
      const uploads = await uploadFiles(files, groupId, 0);
      const rows = uploads.map(({ url, mediaType, order }) => ({
        user_id: userId,
        group_id: groupId,
        sort_order: order,
        media_url: url,
        media_type: mediaType,
        caption: order === 0 ? (name || null) : null,
      }));
      await insforge.database.from('highlights').insert(rows);
      await loadHighlights();
    } catch (err: any) {
      console.error('Failed to create highlight:', err);
      alert(err?.message || 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const handleAddToGroup = async (groupId: string, files: File[]) => {
    if (files.length === 0) return;
    setAddingToGroupId(groupId);
    try {
      const group = groups.find(g => g.group_id === groupId);
      const startOrder = group ? group.items.length : 0;
      const uploads = await uploadFiles(files, groupId, startOrder);
      const rows = uploads.map(({ url, mediaType, order }) => ({
        user_id: userId,
        group_id: groupId,
        sort_order: order,
        media_url: url,
        media_type: mediaType,
        caption: null,
      }));
      await insforge.database.from('highlights').insert(rows);
      await loadHighlights();
    } catch (err: any) {
      console.error('Failed to add to highlight:', err);
      alert(err?.message || 'Upload failed.');
    } finally {
      setAddingToGroupId(null);
    }
  };

  const handleDeleteGroup = async (groupId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm('Delete this highlight?')) return;
    setDeletingGroupId(groupId);
    try {
      await insforge.database.from('highlights').delete().eq('group_id', groupId);
      setGroups(prev => prev.filter(g => g.group_id !== groupId));
    } catch (err: any) {
      console.error('Failed to delete highlight:', err);
      alert('Failed to delete highlight.');
    } finally {
      setDeletingGroupId(null);
    }
  };

  if (loading && groups.length === 0) return null;
  if (groups.length === 0 && !isOwnProfile) return null;

  return (
    <div style={{ padding: '0 0 16px' }}>
      {/* Name prompt modal */}
      {step === 'name' && pendingFiles.length > 0 && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 24px' }}>
          <div style={{ background: '#1a1f2e', borderRadius: '16px', padding: '24px', width: '100%', maxWidth: '320px' }}>
            <p style={{ color: '#fff', fontWeight: 700, fontSize: '16px', margin: '0 0 6px', textAlign: 'center' }}>Name your highlight</p>
            <p style={{ color: '#8B8FA8', fontSize: '12px', margin: '0 0 16px', textAlign: 'center' }}>{pendingFiles.length} item{pendingFiles.length !== 1 ? 's' : ''} selected</p>
            <input
              autoFocus
              placeholder="e.g. Summer Vibes"
              value={pendingName}
              onChange={e => setPendingName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreateHighlight(); if (e.key === 'Escape') { setStep('idle'); setPendingFiles([]); } }}
              maxLength={30}
              style={{ width: '100%', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '10px', padding: '12px 14px', color: '#fff', fontSize: '15px', boxSizing: 'border-box', outline: 'none', marginBottom: '16px' }}
            />
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={() => { setStep('idle'); setPendingFiles([]); }} style={{ flex: 1, background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: '10px', padding: '12px', color: '#8B8FA8', fontSize: '14px', cursor: 'pointer', fontWeight: 600 }}>Cancel</button>
              <button onClick={handleCreateHighlight} style={{ flex: 1, background: 'linear-gradient(135deg,#A855F7,#EC4899)', border: 'none', borderRadius: '10px', padding: '12px', color: '#fff', fontSize: '14px', cursor: 'pointer', fontWeight: 600 }}>Add</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px 12px' }}>
        <span style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Highlights</span>
        {isOwnProfile && groups.length > 0 && (
          <span style={{ color: '#8B8FA8', fontSize: '11px' }}>{groups.length} highlight{groups.length !== 1 ? 's' : ''}</span>
        )}
      </div>

      <div style={{ display: 'flex', gap: '12px', overflowX: 'auto', paddingLeft: '20px', paddingRight: '20px', scrollbarWidth: 'none' }}>
        {/* Add button */}
        {isOwnProfile && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              style={{
                width: '64px', height: '64px', borderRadius: '50%', border: '2px dashed rgba(168,85,247,0.5)',
                background: 'rgba(168,85,247,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', flexShrink: 0,
              }}
            >
              {uploading ? <Loader size={22} color="#A855F7" style={{ animation: 'spin 1s linear infinite' }} /> : <Plus size={22} color="#A855F7" />}
            </button>
            <span style={{ color: '#8B8FA8', fontSize: '10px', textAlign: 'center', maxWidth: '68px' }}>New</span>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*"
              multiple
              style={{ display: 'none' }}
              onChange={e => {
                const files = Array.from(e.target.files || []);
                if (files.length > 0) { setPendingFiles(files); setPendingName(''); setStep('name'); }
                e.target.value = '';
              }}
            />
          </div>
        )}

        {/* Hidden file input for adding to existing group */}
        <input
          ref={addToGroupFileRef}
          type="file"
          accept="image/*,video/*"
          multiple
          style={{ display: 'none' }}
          onChange={e => {
            const files = Array.from(e.target.files || []);
            if (files.length > 0 && addingToGroupId) handleAddToGroup(addingToGroupId, files);
            e.target.value = '';
            setAddingToGroupId(null);
          }}
        />

        {/* Highlight circles */}
        {groups.map((group, idx) => {
          const cover = group.items[0];
          if (!cover) return null;
          const isDeleting = deletingGroupId === group.group_id;
          const isAddingTo = addingToGroupId === group.group_id;

          return (
            <div
              key={group.group_id}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', flexShrink: 0, cursor: 'pointer', position: 'relative' }}
              onClick={() => onHighlightClick(groups, idx)}
            >
              {/* Delete button */}
              {isOwnProfile && (
                <button
                  onClick={e => handleDeleteGroup(group.group_id, e)}
                  disabled={isDeleting}
                  style={{
                    position: 'absolute', top: '-4px', right: '-4px', zIndex: 2,
                    width: '20px', height: '20px', borderRadius: '50%',
                    background: isDeleting ? '#555' : '#EF4444',
                    border: '2px solid #000', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: 'pointer', padding: 0,
                  }}
                >
                  {isDeleting ? <Loader size={8} color="#fff" /> : <X size={10} color="#fff" />}
                </button>
              )}

              {/* Add more button */}
              {isOwnProfile && (
                <button
                  onClick={e => {
                    e.stopPropagation();
                    setAddingToGroupId(group.group_id);
                    setTimeout(() => addToGroupFileRef.current?.click(), 50);
                  }}
                  disabled={!!isAddingTo}
                  style={{
                    position: 'absolute', top: '-4px', left: '-4px', zIndex: 2,
                    width: '20px', height: '20px', borderRadius: '50%',
                    background: '#4F46E5', border: '2px solid #000',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: 'pointer', padding: 0,
                  }}
                >
                  {isAddingTo ? <Loader size={8} color="#fff" /> : <Plus size={10} color="#fff" />}
                </button>
              )}

              {/* Item count badge */}
              {group.items.length > 1 && (
                <div style={{
                  position: 'absolute', bottom: '22px', right: '-4px', zIndex: 2,
                  background: '#0D0E1A', borderRadius: '6px', padding: '1px 4px',
                  border: '1px solid rgba(255,255,255,0.2)',
                }}>
                  <span style={{ color: '#A78BFA', fontSize: '9px', fontWeight: 700 }}>{group.items.length}</span>
                </div>
              )}

              <div style={{
                width: '64px', height: '64px', borderRadius: '50%', padding: '2px',
                background: 'linear-gradient(135deg, #A855F7, #EC4899, #F97316)',
                flexShrink: 0,
              }}>
                <div style={{ width: '100%', height: '100%', borderRadius: '50%', overflow: 'hidden', border: '2px solid #000' }}>
                  {cover.media_type === 'video' ? (
                    <video
                      src={cover.media_url}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      muted
                      playsInline
                      preload="metadata"
                    />
                  ) : (
                    <img src={cover.media_url} alt={group.caption || 'Highlight'} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  )}
                </div>
              </div>
              <span style={{ color: '#8B8FA8', fontSize: '10px', textAlign: 'center', maxWidth: '68px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {group.caption || new Date(cover.created_at).toLocaleDateString('en-NG', { month: 'short', day: 'numeric' })}
              </span>
            </div>
          );
        })}
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

// ── Full-screen Highlights Modal ─────────────────────────────────────────────
export function HighlightsModal({
  groups,
  startGroupIndex,
  onClose,
}: {
  groups: HighlightGroup[];
  startGroupIndex: number;
  onClose: () => void;
}) {
  const [groupIdx, setGroupIdx] = useState(startGroupIndex);
  const [itemIdx, setItemIdx] = useState(0);
  const touchStartX = useRef<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const group = groups[groupIdx];
  if (!group) return null;
  const item = group.items[itemIdx] ?? group.items[0];
  if (!item) return null;

  const totalItems = group.items.length;
  const totalGroups = groups.length;

  const goNext = () => {
    if (itemIdx < totalItems - 1) setItemIdx(i => i + 1);
    else if (groupIdx < totalGroups - 1) { setGroupIdx(g => g + 1); setItemIdx(0); }
  };

  const goPrev = () => {
    if (itemIdx > 0) setItemIdx(i => i - 1);
    else if (groupIdx > 0) { setGroupIdx(g => g - 1); setItemIdx(0); }
  };

  const handleTouchStart = (e: React.TouchEvent) => { touchStartX.current = e.touches[0].clientX; };
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    const delta = e.changedTouches[0].clientX - touchStartX.current;
    if (Math.abs(delta) > 50) { if (delta < 0) goNext(); else goPrev(); }
    touchStartX.current = null;
  };

  // Auto-play video when item changes
  useEffect(() => {
    if (item.media_type === 'video' && videoRef.current) {
      videoRef.current.load();
      videoRef.current.play().catch(() => {});
    }
  }, [item.id]);

  const hasPrev = itemIdx > 0 || groupIdx > 0;
  const hasNext = itemIdx < totalItems - 1 || groupIdx < totalGroups - 1;

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: '#000', zIndex: 9999, display: 'flex', flexDirection: 'column' }}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Progress bars for items in this group */}
      <div style={{ display: 'flex', gap: '3px', padding: 'calc(14px + env(safe-area-inset-top)) 16px 8px', position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 }}>
        {group.items.map((_, i) => (
          <div key={i} style={{ flex: 1, height: '2px', borderRadius: '2px', background: i <= itemIdx ? '#fff' : 'rgba(255,255,255,0.3)', transition: 'background 0.3s' }} />
        ))}
      </div>

      {/* Caption */}
      {group.caption && (
        <div style={{ position: 'absolute', top: 'calc(26px + env(safe-area-inset-top))', left: '16px', right: '52px', zIndex: 11 }}>
          <span style={{ color: '#fff', fontSize: '14px', fontWeight: 600, textShadow: '0 1px 8px rgba(0,0,0,0.8)' }}>{group.caption}</span>
        </div>
      )}

      {/* Item count */}
      {totalItems > 1 && (
        <div style={{ position: 'absolute', top: 'calc(26px + env(safe-area-inset-top))', right: '56px', zIndex: 11 }}>
          <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: '12px', fontWeight: 600 }}>{itemIdx + 1}/{totalItems}</span>
        </div>
      )}

      {/* Close */}
      <button
        onClick={onClose}
        style={{ position: 'absolute', top: 'calc(26px + env(safe-area-inset-top))', right: '16px', zIndex: 11, background: 'rgba(0,0,0,0.5)', border: 'none', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
      >
        <X size={20} color="#fff" />
      </button>

      {/* Media */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {item.media_type === 'video' ? (
          <video
            key={item.id}
            ref={videoRef}
            src={item.media_url}
            autoPlay
            loop
            playsInline
            controls
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        ) : (
          <img
            key={item.id}
            src={item.media_url}
            alt={group.caption || 'Highlight'}
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        )}
      </div>

      {/* Nav arrows */}
      {hasPrev && (
        <button onClick={goPrev} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: '50%', width: '40px', height: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 10 }}>
          <ChevronLeft size={22} color="#fff" />
        </button>
      )}
      {hasNext && (
        <button onClick={goNext} style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: '50%', width: '40px', height: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 10 }}>
          <ChevronRight size={22} color="#fff" />
        </button>
      )}

      {/* Date */}
      <div style={{ position: 'absolute', bottom: 'calc(30px + env(safe-area-inset-bottom))', left: 0, right: 0, textAlign: 'center' }}>
        <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: '11px' }}>
          {new Date(item.created_at).toLocaleDateString('en-NG', { dateStyle: 'long' })}
        </span>
      </div>
    </div>
  );
}
