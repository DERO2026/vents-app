import { useState, useEffect, useRef } from 'react';
import { insforge, getAuthToken } from '../../lib/insforge';
import { sanitize } from '../../lib/sanitize';
import {
  ArrowLeft, User, Bell, Shield, HelpCircle, LogOut, MessageCircle,
  ChevronRight, Globe, Star, CreditCard, Plus, Trash2, CheckCircle,
  Smartphone, X, ExternalLink, ShieldCheck, Copy, ThumbsUp, Camera, Music,
} from 'lucide-react';
import BadgeChip from './BadgeChip';
import { compressImage } from '../../lib/compressImage';
import { ImageCropperModal } from './ImageCropperModal';

interface SettingsScreenProps {
  currentUser: { id: string; email: string; full_name: string | null; role: string; username?: string; phone_number?: string; state?: string; vc_badge?: string; is_verified?: boolean } | null;
  onBack: () => void;
  onSignOut: () => void;
  onNavigate?: (screen: string) => void;
  isDark: boolean;
  onToggleDark: () => void;
  onProfileUpdated?: (fields: { full_name?: string; username?: string; bio?: string; phone_number?: string; avatar_url?: string }) => void;
}

type SubScreen = null | 'profile' | 'payment' | 'help' | 'change-password' | 'delete-account' | 'cac-verify';


function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      onClick={() => onChange(!on)}
      style={{
        width: '44px',
        height: '26px',
        borderRadius: '13px',
        background: on ? '#7B2FBE' : '#1A1625',
        cursor: 'pointer',
        position: 'relative',
        transition: 'background 0.25s ease',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          position: 'absolute',
          width: '20px',
          height: '20px',
          borderRadius: '50%',
          background: '#fff',
          top: '3px',
          left: on ? '21px' : '3px',
          transition: 'left 0.25s ease',
          boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
        }}
      />
    </div>
  );
}

function SettingRow({
  icon: Icon,
  label,
  value,
  toggle,
  onToggle,
  onPress,
  accent = false,
  danger = false,
}: {
  icon: React.ElementType;
  label: string;
  value?: string;
  toggle?: boolean;
  onToggle?: (v: boolean) => void;
  onPress?: () => void;
  accent?: boolean;
  danger?: boolean;
}) {
  return (
    <div
      onClick={onPress}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        width: '100%',
        padding: '14px 0',
        cursor: onPress || onToggle ? 'pointer' : 'default',
      }}
    >
      <div
        style={{
          width: '36px',
          height: '36px',
          borderRadius: '10px',
          background: danger ? 'rgba(239,68,68,0.1)' : 'rgba(123,47,190,0.15)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Icon size={17} color={danger ? '#EF4444' : '#7B2FBE'} />
      </div>
      <span style={{ flex: 1, color: danger ? '#EF4444' : '#FFFFFF', fontSize: '15px', fontWeight: 500 }}>
        {label}
      </span>
      {typeof toggle === 'boolean' && onToggle ? (
        <Toggle on={toggle} onChange={onToggle} />
      ) : value ? (
        <span style={{ color: '#94A3B8', fontSize: '13px' }}>{value}</span>
      ) : onPress ? (
        <ChevronRight size={16} color="#94A3B8" />
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '8px' }}>
      <p style={{ color: '#94A3B8', fontSize: '12px', fontWeight: 600, letterSpacing: '0.5px', textTransform: 'uppercase', marginBottom: '2px', paddingLeft: '4px' }}>
        {title}
      </p>
      <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '16px', padding: '0 14px' }}>
        {children}
      </div>
    </div>
  );
}

function Divider() {
  return <div style={{ height: '1px', background: 'rgba(255,255,255,0.05)' }} />;
}

function SubHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
      <button onClick={onBack} style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '34px', height: '34px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
        <ArrowLeft size={15} color="#C4C9E0" />
      </button>
      <h2 style={{ color: '#F0F0FF', fontSize: '17px', fontWeight: 700 }}>{title}</h2>
    </div>
  );
}

// ── Sub-screens ──────────────────────────────────────────────────

function CACVerificationScreen({ currentUser, onBack }: { currentUser: any; onBack: () => void }) {
  const [status, setStatus] = useState<'loading' | 'form' | 'pending' | 'rejected'>('loading');
  const [rejectReason, setRejectReason] = useState<string | null>(null);

  const [companyName, setCompanyName] = useState('');
  const [cacNumber, setCacNumber] = useState('');
  const [businessAddress, setBusinessAddress] = useState(currentUser?.state ? `${currentUser.state}, Nigeria` : '');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: '#090514',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '12px',
    padding: '12px 14px',
    color: '#F0F0FF',
    fontSize: '14px',
    outline: 'none',
    fontFamily: 'Inter, sans-serif',
    boxSizing: 'border-box',
  };

  useEffect(() => {
    if (!currentUser?.id) return;
    (async () => {
      try {
        await getAuthToken();
        const { data } = await insforge.database.rpc('my_latest_organizer_verification' as any);
        const row = Array.isArray(data) ? data[0] : data;
        if (row?.status === 'pending') { setStatus('pending'); return; }
        if (row?.status === 'rejected') { setRejectReason(row.admin_note || null); setStatus('rejected'); return; }
        setStatus('form');
      } catch {
        setStatus('form');
      }
    })();
  }, [currentUser?.id]);

  const handleSubmit = async () => {
    setError('');
    if (!companyName.trim() || !cacNumber.trim() || !businessAddress.trim()) {
      setError('All fields are required.');
      return;
    }
    if (!file) {
      setError('Please upload your Certificate of Incorporation.');
      return;
    }
    setSubmitting(true);
    try {
      await getAuthToken();
      setUploading(true);
      const { data: uploadData, error: uploadError } = await insforge.storage.from('verification-docs').uploadAuto(file);
      setUploading(false);
      if (uploadError) throw uploadError;
      if (!uploadData?.url) throw new Error('Upload failed — no URL returned.');

      const { error: rpcError } = await insforge.database.rpc('submit_organizer_verification' as any, {
        p_company_name: companyName.trim(),
        p_cac_number: cacNumber.trim(),
        p_business_address: businessAddress.trim(),
        p_document_url: uploadData.url,
      });
      if (rpcError) throw new Error(rpcError.message);
      setStatus('pending');
    } catch (err: any) {
      setError(err?.message || 'Submission failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px' }}>
        <button onClick={onBack} style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={16} color="#C4C9E0" />
        </button>
        <h1 style={{ color: '#FFFFFF', fontSize: '20px', fontWeight: 700 }}>Get Verified</h1>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 16px 40px' }}>
        {status === 'loading' && (
          <p style={{ color: '#8B8FA8', fontSize: '13px', textAlign: 'center', marginTop: '40px' }}>Loading…</p>
        )}

        {status === 'pending' && (
          <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: '16px', padding: '20px', textAlign: 'center', marginTop: '20px' }}>
            <ShieldCheck size={32} color="#F59E0B" style={{ marginBottom: '10px' }} />
            <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700, margin: '0 0 6px' }}>Verification Pending</p>
            <p style={{ color: '#8B8FA8', fontSize: '13px', margin: 0, lineHeight: 1.5 }}>Your brand verification request is under review. We'll email you once a decision is made.</p>
          </div>
        )}

        {status === 'rejected' && (
          <div style={{ marginTop: '8px' }}>
            <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '16px', padding: '16px', marginBottom: '20px' }}>
              <p style={{ color: '#EF4444', fontSize: '13px', fontWeight: 700, margin: '0 0 6px' }}>Previous request not approved</p>
              {rejectReason && <p style={{ color: '#C4C9E0', fontSize: '13px', margin: 0, lineHeight: 1.5 }}>{rejectReason}</p>}
            </div>
            <p style={{ color: '#8B8FA8', fontSize: '13px', marginBottom: '16px' }}>You can submit a new request below.</p>
            <CACForm />
          </div>
        )}

        {status === 'form' && <CACForm />}
      </div>
    </div>
  );

  function CACForm() {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: status === 'form' ? '8px' : 0 }}>
        <p style={{ color: '#8B8FA8', fontSize: '13px', lineHeight: 1.5, margin: 0 }}>
          Verify your organization with Vents to unlock a verified badge on your organizer profile — helping attendees trust your events.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 600 }}>Company Legal Registered Name</label>
          <input value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="e.g. Vents Events Ltd" style={inputStyle} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 600 }}>CAC Registration Number</label>
          <input value={cacNumber} onChange={e => setCacNumber(e.target.value)} placeholder="e.g. RC1234567" style={inputStyle} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 600 }}>Official Business Address</label>
          <textarea value={businessAddress} onChange={e => setBusinessAddress(e.target.value)} rows={3} style={{ ...inputStyle, resize: 'none', fontFamily: 'inherit' }} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 600 }}>Certificate of Incorporation</label>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf"
            onChange={e => setFile(e.target.files?.[0] || null)}
            style={{ display: 'none' }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            style={{ width: '100%', background: 'rgba(255,255,255,0.07)', border: '1px dashed rgba(255,255,255,0.2)', borderRadius: '12px', padding: '16px', color: file ? '#10B981' : '#8B8FA8', fontSize: '13px', cursor: 'pointer', textAlign: 'center' }}
          >
            {file ? `✓ ${file.name}` : 'Tap to upload document (image or PDF)'}
          </button>
        </div>

        {error && <p style={{ color: '#EF4444', fontSize: '12px', margin: 0 }}>{error}</p>}

        <button
          onClick={handleSubmit}
          disabled={submitting}
          style={{ marginTop: '4px', width: '100%', height: '48px', borderRadius: '14px', background: 'linear-gradient(135deg,#7B2FBE,#4F46E5)', border: 'none', color: '#fff', fontSize: '15px', fontWeight: 700, cursor: submitting ? 'wait' : 'pointer', opacity: submitting ? 0.7 : 1 }}
        >
          {uploading ? 'Uploading document…' : submitting ? 'Submitting…' : 'Submit for Verification'}
        </button>
      </div>
    );
  }
}

function ProfileDetailsScreen({ currentUser, onBack, onProfileUpdated }: { currentUser: any; onBack: () => void; onProfileUpdated?: (fields: any) => void }) {
  if (!currentUser) {
    return (
      <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8B8FA8', fontFamily: 'Inter, sans-serif' }}>
        Loading profile details...
      </div>
    );
  }

  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [bio, setBio] = useState('');
  const [phone, setPhone] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [coverUrl, setCoverUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);

  const [cropImageSrc, setCropImageSrc] = useState<string | null>(null);
  const [coverCropSrc, setCoverCropSrc] = useState<string | null>(null);
  const [usernameChecking, setUsernameChecking] = useState(false);
  const [usernameAvailable, setUsernameAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    if (!username.trim()) {
      setUsernameAvailable(null);
      return;
    }
    const cleanUsername = username.trim().toLowerCase();
    if (cleanUsername === currentUser?.username?.toLowerCase()) {
      setUsernameAvailable(true);
      return;
    }

    setUsernameChecking(true);
    const delayDebounceFn = setTimeout(async () => {
      try {
        const { data, error } = await insforge.database
          .from('users')
          .select('id')
          .eq('username', cleanUsername)
          .maybeSingle();

        if (error) throw error;
        if (data) {
          setUsernameAvailable(false);
        } else {
          setUsernameAvailable(true);
        }
      } catch (err) {
        console.error("Failed to check username availability:", err);
      } finally {
        setUsernameChecking(false);
      }
    }, 500);

    return () => clearTimeout(delayDebounceFn);
  }, [username, currentUser]);

  useEffect(() => {
    async function loadProfile() {
      if (!currentUser?.id) return;
      try {
        const { data, error } = await insforge.database
          .from('users')
          .select('*')
          .eq('id', currentUser.id)
          .maybeSingle();

        if (error) throw error;
        if (data) {
          setName(data.full_name || '');
          setUsername(data.username || '');
          setBio(data.bio || '');
          setPhone(data.phone_number || '');
          setAvatarUrl(data.avatar_url || '');
          setCoverUrl(data.cover_url || '');
        }
      } catch (err) {
        console.error("Failed to load profile:", err);
      } finally {
        setLoading(false);
      }
    }
    loadProfile();
  }, [currentUser]);

  const handleUploadPhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentUser?.id) return;
    setErrorMessage(null);
    setCropImageSrc(URL.createObjectURL(file));
  };

  const handleCropComplete = async (croppedBlob: Blob) => {
    if (!currentUser?.id) return;
    setCropImageSrc(null);
    setSaving(true);
    setErrorMessage(null);
    try {
      const token = await getAuthToken();
      const { blob: compressed, mimeType, extension } = await compressImage(croppedBlob);
      const croppedFile = new File([compressed], `avatar.${extension}`, { type: mimeType });
      const formData = new FormData();
      formData.append('file', croppedFile);
      const res = await fetch(
        `${import.meta.env.VITE_INSFORGE_URL}/api/storage/buckets/avatars/objects`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData }
      );
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) throw new Error('Session expired. Please sign out and sign back in.');
        throw new Error(`Upload failed (${res.status}). Please try again.`);
      }
      const data = await res.json();
      const key: string | null = data?.key ?? null;
      const url: string | null = data?.url ?? (key ? `${import.meta.env.VITE_INSFORGE_URL}/api/storage/buckets/avatars/objects/${encodeURIComponent(key)}` : null);
      if (url) {
        setAvatarUrl(url);
        const { error: updateError } = await insforge.database
          .from('users')
          .update({ avatar_url: url })
          .eq('id', currentUser.id);
        if (updateError) throw updateError;
        if (onProfileUpdated) {
          onProfileUpdated({ avatar_url: url });
        }
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      }
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to upload photo");
    } finally {
      setSaving(false);
    }
  };

  const handleCoverUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { setErrorMessage('Cover photo must be under 15MB.'); return; }
    const reader = new FileReader();
    reader.onload = () => { if (typeof reader.result === 'string') setCoverCropSrc(reader.result); };
    reader.readAsDataURL(file);
    if (coverInputRef.current) coverInputRef.current.value = '';
  };

  const handleCoverCropComplete = async (croppedBlob: Blob) => {
    if (!currentUser?.id) return;
    setCoverCropSrc(null);
    setSaving(true);
    setErrorMessage(null);
    try {
      const token = await getAuthToken();
      const { blob: compressedCover, mimeType, extension } = await compressImage(croppedBlob);
      const croppedFile = new File([compressedCover], `cover.${extension}`, { type: mimeType });
      const formData = new FormData();
      formData.append('file', croppedFile);
      const res = await fetch(
        `${import.meta.env.VITE_INSFORGE_URL}/api/storage/buckets/avatars/objects`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData }
      );
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) throw new Error('Session expired. Please sign out and sign back in.');
        throw new Error(`Upload failed (${res.status}). Please try again.`);
      }
      const data = await res.json();
      const key: string | null = data?.key ?? null;
      const url: string | null = data?.url ?? (key ? `${import.meta.env.VITE_INSFORGE_URL}/api/storage/buckets/avatars/objects/${encodeURIComponent(key)}` : null);
      if (url) {
        setCoverUrl(url);
        const { error: updateError } = await insforge.database
          .from('users')
          .update({ cover_url: url })
          .eq('id', currentUser.id);
        if (updateError) throw updateError;
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to upload cover photo');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveProfile = async () => {
    if (!currentUser?.id) return;
    setSaving(true);
    setErrorMessage(null);
    try {
      if (username.trim().length < 3) {
        throw new Error("Username must be at least 3 characters.");
      }
      if (usernameAvailable === false) {
        throw new Error("Username is already taken.");
      }

      const rawDigits = phone.replace(/\D/g, '');
      let cleanPhone = '';
      if (rawDigits) {
        cleanPhone = rawDigits.startsWith('234') ? '+' + rawDigits : '+234' + (rawDigits.startsWith('0') ? rawDigits.slice(1) : rawDigits);
        const NIGERIAN_PHONE_REGEX = /^\+234[789][01]\d{8}$/;
        if (!NIGERIAN_PHONE_REGEX.test(cleanPhone)) {
          throw new Error("Please enter a valid Nigerian phone number (+234 format).");
        }
      }

      const { error } = await insforge.database
        .from('users')
        .update({
          full_name: sanitize(name),
          username: sanitize(username).toLowerCase(),
          bio: sanitize(bio),
          phone_number: cleanPhone
        })
        .eq('id', currentUser.id);

      if (error) throw error;
      if (onProfileUpdated) {
        onProfileUpdated({
          full_name: sanitize(name),
          username: sanitize(username).toLowerCase(),
          bio: sanitize(bio),
          phone_number: cleanPhone || phone.trim()
        });
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to update profile");
    } finally {
      setSaving(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: '#090514',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '12px',
    padding: '12px 14px',
    color: '#F0F0FF',
    fontSize: '14px',
    outline: 'none',
    fontFamily: 'Inter, sans-serif',
    boxSizing: 'border-box',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#020005' }}>
      <SubHeader title="Profile Details" onBack={onBack} />
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 16px', scrollbarWidth: 'none' }}>
        {loading ? (
          <div style={{ color: '#8B8FA8', textAlign: 'center', padding: '40px' }}>Loading profile details...</div>
        ) : (
          <>
            {/* Cover Photo */}
            <div style={{ marginBottom: '20px' }}>
              <label style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '8px' }}>Cover Photo</label>
              <div
                onClick={() => coverInputRef.current?.click()}
                style={{ width: '100%', height: '100px', borderRadius: '14px', background: coverUrl ? 'none' : '#131629', border: coverUrl ? 'none' : '2px dashed rgba(255,255,255,0.12)', overflow: 'hidden', cursor: 'pointer', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                {coverUrl ? (
                  <img src={coverUrl} alt="Cover" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <span style={{ color: '#555C7A', fontSize: '13px' }}>Tap to upload cover photo</span>
                )}
                {coverUrl && (
                  <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span style={{ color: '#fff', fontSize: '12px', fontWeight: 600 }}>Change Cover</span>
                  </div>
                )}
              </div>
              <input ref={coverInputRef} type="file" accept="image/*" onChange={handleCoverUpload} style={{ display: 'none' }} />
            </div>

            {/* Avatar */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: '28px' }}>
              <div style={{ width: '80px', height: '80px', borderRadius: '50%', background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', marginBottom: '12px', boxShadow: '0 8px 24px rgba(123,47,190,0.4)' }}>
                {avatarUrl ? (
                  <img src={avatarUrl} alt="Avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <span style={{ color: '#fff', fontSize: '28px', fontWeight: 800 }}>
                    {(name || currentUser?.email || 'A').charAt(0).toUpperCase()}
                  </span>
                )}
              </div>
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleUploadPhoto}
                style={{ display: 'none' }}
                accept="image/*"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={saving}
                style={{ background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.2)', borderRadius: '10px', padding: '8px 16px', color: '#A78BFA', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}
              >
                {saving ? 'Uploading...' : 'Change Photo'}
              </button>
            </div>

            {errorMessage && (
              <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.25)', borderRadius: '12px', padding: '12px', marginBottom: '16px', color: '#EF4444', fontSize: '13px' }}>
                {errorMessage}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <p style={{ color: '#8B8FA8', fontSize: '12px', marginBottom: '6px', fontWeight: 500 }}>Full Name</p>
                <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
              </div>

              <div>
                <p style={{ color: '#8B8FA8', fontSize: '12px', marginBottom: '6px', fontWeight: 500 }}>Username</p>
                {currentUser?.id === 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' ? (
                  <input
                    value={username}
                    readOnly
                    style={{ ...inputStyle, opacity: 0.5, cursor: 'not-allowed' }}
                  />
                ) : (
                  <div style={{ position: 'relative' }}>
                    <input
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      style={inputStyle}
                    />
                    {usernameChecking && (
                      <span style={{ position: 'absolute', right: '12px', top: '12px', color: '#A78BFA', fontSize: '12px' }}>
                        Checking...
                      </span>
                    )}
                  </div>
                )}
                {currentUser?.id !== 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' && username.trim() && username.trim().toLowerCase() !== currentUser?.username?.toLowerCase() && usernameAvailable !== null && !usernameChecking && (
                  <p style={{
                    fontSize: '12px',
                    marginTop: '4px',
                    color: usernameAvailable ? '#10B981' : '#EF4444'
                  }}>
                    {usernameAvailable ? '✓ Username is available' : '✗ Username is already taken'}
                  </p>
                )}
              </div>

              <div>
                <p style={{ color: '#8B8FA8', fontSize: '12px', marginBottom: '6px', fontWeight: 500 }}>Phone Number</p>
                <input
                  value={phone}
                  onChange={(e) => {
                    let raw = e.target.value.replace(/\D/g, '');
                    if (raw.startsWith('234')) raw = raw.slice(3);
                    else if (raw.startsWith('0')) raw = raw.slice(1);
                    raw = raw.slice(0, 10);
                    let formatted = '+234';
                    if (raw.length > 0) formatted += ' ' + raw.slice(0, 3);
                    if (raw.length > 3) formatted += ' ' + raw.slice(3, 7);
                    if (raw.length > 7) formatted += ' ' + raw.slice(7);
                    setPhone(raw.length === 0 ? '' : formatted);
                  }}
                  inputMode="tel"
                  placeholder="+234 801 234 5678"
                  style={inputStyle}
                />
                {phone.trim() && !/^\+234[789][01]\d{8}$/.test(phone.replace(/[\s\-]/g, '')) && (
                  <p style={{ color: '#EF4444', fontSize: '11px', marginTop: '4px' }}>
                    Enter a valid Nigerian number (e.g. +234 801 234 5678)
                  </p>
                )}
              </div>
              <div>
                <p style={{ color: '#8B8FA8', fontSize: '12px', marginBottom: '6px', fontWeight: 500 }}>Bio</p>
                <textarea
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  rows={3}
                  style={{ ...inputStyle, resize: 'none', lineHeight: 1.5 }}
                />
              </div>
              <div>
                <p style={{ color: '#8B8FA8', fontSize: '12px', marginBottom: '6px', fontWeight: 500 }}>Email Address</p>
                <input value={currentUser?.email || ''} readOnly style={{ ...inputStyle, opacity: 0.5 }} />
              </div>
            </div>

            {saved && (
              <div style={{ background: '#10B981', borderRadius: '12px', padding: '12px', marginTop: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <CheckCircle size={16} color="#fff" />
                <span style={{ color: '#fff', fontSize: '13px', fontWeight: 600 }}>Profile saved successfully!</span>
              </div>
            )}
          </>
        )}
      </div>
      <div style={{ padding: '12px 16px 28px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <button
          onClick={handleSaveProfile}
          disabled={loading || saving}
          style={{ width: '100%', background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', border: 'none', borderRadius: '14px', padding: '14px', color: '#fff', fontSize: '15px', fontWeight: 700, fontFamily: 'Space Grotesk, sans-serif', cursor: (loading || saving) ? 'not-allowed' : 'pointer' }}
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      {cropImageSrc && (
        <ImageCropperModal
          imageSrc={cropImageSrc}
          onCropComplete={handleCropComplete}
          onClose={() => setCropImageSrc(null)}
        />
      )}

      {coverCropSrc && (
        <ImageCropperModal
          imageSrc={coverCropSrc}
          onCropComplete={handleCoverCropComplete}
          onClose={() => setCoverCropSrc(null)}
          aspect={16 / 9}
          cropShape="rect"
          title="Crop Cover Photo"
        />
      )}
    </div>
  );
}

function PaymentMethodsScreen({ onBack }: { onBack: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#020005' }}>
      <SubHeader title="Payment Methods" onBack={onBack} />
      <div style={{ flex: 1, overflowY: 'auto', padding: '32px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
        <div style={{ width: '64px', height: '64px', borderRadius: '20px', background: 'rgba(123,47,190,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '16px' }}>
          <CreditCard size={28} color="#A78BFA" />
        </div>
        <h3 style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 700, marginBottom: '8px' }}>No payment methods saved yet</h3>
        <p style={{ color: '#8B8FA8', fontSize: '13px', lineHeight: 1.5, maxWidth: '280px' }}>
          Save your cards or link mobile money wallets during checkout for a faster payment experience.
        </p>
      </div>
    </div>
  );
}

function HelpCenterScreen({ onBack }: { onBack: () => void }) {
  const articles = [
    { title: 'How to buy a ticket', category: 'Tickets', emoji: '🎟️' },
    { title: 'Refund & cancellation policy', category: 'Tickets', emoji: '💰' },
    { title: 'How to transfer a ticket', category: 'Tickets', emoji: '↔️' },
    { title: 'Using USSD payment', category: 'Payments', emoji: '📱' },
    { title: 'Bank transfer guide', category: 'Payments', emoji: '🏦' },
    { title: 'Promo codes & discounts', category: 'Payments', emoji: '🏷️' },
    { title: 'Creating an event as organizer', category: 'Organizers', emoji: '📋' },
    { title: 'Promoting your event', category: 'Organizers', emoji: '🚀' },
    { title: 'Viewing attendee analytics', category: 'Organizers', emoji: '📊' },
  ];

  const categories = Array.from(new Set(articles.map((a) => a.category)));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#020005' }}>
      <SubHeader title="Help Center" onBack={onBack} />
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 32px', scrollbarWidth: 'none' }}>
        {/* Contact support */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
          {/* Email Support */}
          <div style={{ background: 'linear-gradient(135deg, rgba(123,47,190,0.15), rgba(79,70,229,0.15))', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '16px', display: 'flex', alignItems: 'center', gap: '14px' }}>
            <div style={{ width: '40px', height: '40px', borderRadius: '12px', background: 'rgba(168,85,247,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Globe size={18} color="#A855F7" />
            </div>
            <div style={{ flex: 1 }}>
              <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700 }}>Email Support</p>
              <p style={{ color: '#C4C9E0', fontSize: '12px' }}>support@getvents.com</p>
            </div>
            <button
              onClick={() => window.open('mailto:support@getvents.com', '_blank')}
              style={{ background: 'rgba(167,139,250,0.15)', border: 'none', borderRadius: '10px', padding: '8px 12px', cursor: 'pointer' }}
            >
              <ExternalLink size={15} color="#A78BFA" />
            </button>
          </div>

          {/* WhatsApp Support */}
          <div style={{ background: 'linear-gradient(135deg, rgba(16,185,129,0.15), rgba(16,185,129,0.05))', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '16px', display: 'flex', alignItems: 'center', gap: '14px' }}>
            <div style={{ width: '40px', height: '40px', borderRadius: '12px', background: 'rgba(16,185,129,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Smartphone size={18} color="#10B981" />
            </div>
            <div style={{ flex: 1 }}>
              <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700 }}>WhatsApp Support</p>
              <p style={{ color: '#C4C9E0', fontSize: '12px' }}>09030737368</p>
            </div>
            <button
              onClick={() => window.open('https://wa.me/2349030737368', '_blank')}
              style={{ background: 'rgba(16,185,129,0.15)', border: 'none', borderRadius: '10px', padding: '8px 12px', cursor: 'pointer' }}
            >
              <ExternalLink size={15} color="#10B981" />
            </button>
          </div>
        </div>

        {categories.map((cat) => (
          <div key={cat} style={{ marginBottom: '16px' }}>
            <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 600, letterSpacing: '0.07em', marginBottom: '8px' }}>{cat.toUpperCase()}</p>
            <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '0 14px' }}>
              {articles.filter((a) => a.category === cat).map((article, i, arr) => (
                <div key={article.title}>
                  <button
                    onClick={() => window.open('mailto:support@getvents.com', '_blank')}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      width: '100%',
                      padding: '14px 0',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ fontSize: '18px' }}>{article.emoji}</span>
                    <span style={{ flex: 1, color: '#F0F0FF', fontSize: '13px', fontWeight: 500 }}>{article.title}</span>
                    <ExternalLink size={14} color="#8B8FA8" />
                  </button>
                  {i < arr.length - 1 && <div style={{ height: '1px', background: 'rgba(255,255,255,0.05)' }} />}
                </div>
              ))}
            </div>
          </div>
        ))}

        <div style={{ textAlign: 'center', marginTop: '8px' }}>
          <p style={{ color: '#8B8FA8', fontSize: '12px', marginBottom: '8px' }}>Need more help?</p>
          <button
            onClick={() => window.open('mailto:support@getvents.com', '_blank')}
            style={{ background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.2)', borderRadius: '12px', padding: '10px 20px', color: '#A78BFA', fontSize: '13px', fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            <ExternalLink size={14} />
            Visit Full Help Center
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Change Password Sub-screen ────────────────────────────────────
function ChangePasswordScreen({ currentUser, onBack }: { currentUser: { email: string } | null; onBack: () => void }) {
  const [step, setStep] = useState<'verify' | 'otp'>('verify');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!currentUser?.email) { setError('No email on account.'); return; }
    if (newPassword === oldPassword) { setError('New password must differ from the current password.'); return; }
    if (newPassword !== confirmPassword) { setError('New passwords do not match.'); return; }
    if (newPassword.length < 6) { setError('Password must be at least 6 characters.'); return; }
    setLoading(true);
    try {
      // Verify old password via a real sign-in call — never compare against anything cached
      const { error: verifyErr } = await insforge.auth.signInWithPassword({ email: currentUser.email, password: oldPassword });
      if (verifyErr) { setError('Current password is incorrect.'); return; }
      // Send OTP to user's email for the reset step
      const { error: sendErr } = await insforge.auth.sendResetPasswordEmail({ email: currentUser.email });
      if (sendErr) throw sendErr;
      setStep('otp');
    } catch (err: any) {
      setError(err?.message || 'Failed to send reset email.');
    } finally {
      setLoading(false);
    }
  }

  async function handleOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!otp.trim()) { setError('Please enter the OTP from your email.'); return; }
    setLoading(true);
    try {
      const { error: updateErr } = await insforge.auth.resetPassword({ newPassword, otp: otp.trim() });
      if (updateErr) throw updateErr;
      setSuccess(true);
    } catch (err: any) {
      setError(err?.message || 'Failed to update password. Check your OTP and try again.');
    } finally {
      setLoading(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', background: '#090514', border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '12px', padding: '12px 14px', color: '#F0F0FF', fontSize: '14px',
    outline: 'none', boxSizing: 'border-box',
  };

  return (
    <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px' }}>
        <button onClick={onBack} style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={16} color="#C4C9E0" />
        </button>
        <h1 style={{ color: '#F0F0FF', fontSize: '20px', fontWeight: 700, margin: 0 }}>Change Password</h1>
      </div>

      {success ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '32px', gap: '16px' }}>
          <CheckCircle size={48} color="#10B981" />
          <p style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 700, textAlign: 'center', margin: 0 }}>Password updated!</p>
          <p style={{ color: '#8B8FA8', fontSize: '13px', textAlign: 'center', margin: 0 }}>Your password has been changed successfully.</p>
          <button onClick={onBack} style={{ marginTop: '8px', padding: '12px 32px', background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', border: 'none', borderRadius: '12px', color: '#fff', fontSize: '14px', fontWeight: 700, cursor: 'pointer' }}>Done</button>
        </div>
      ) : step === 'verify' ? (
        <form onSubmit={handleVerify} style={{ padding: '8px 16px 32px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {error && (
            <div style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '10px', padding: '10px 14px' }}>
              <p style={{ color: '#F87171', fontSize: '13px', margin: 0 }}>{error}</p>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 600, letterSpacing: '0.05em' }}>CURRENT PASSWORD</label>
            <input type="password" value={oldPassword} onChange={e => setOldPassword(e.target.value)} placeholder="Enter current password" required style={inputStyle} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 600, letterSpacing: '0.05em' }}>NEW PASSWORD</label>
            <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="At least 6 characters" required style={inputStyle} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 600, letterSpacing: '0.05em' }}>CONFIRM NEW PASSWORD</label>
            <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="Repeat new password" required style={inputStyle} />
          </div>
          <button type="submit" disabled={loading} style={{ marginTop: '8px', padding: '14px', background: loading ? '#2D2D4E' : 'linear-gradient(135deg, #7B2FBE, #4F46E5)', border: 'none', borderRadius: '12px', color: loading ? '#8B8FA8' : '#fff', fontSize: '14px', fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer' }}>
            {loading ? 'Verifying…' : 'Continue'}
          </button>
        </form>
      ) : (
        <form onSubmit={handleOtp} style={{ padding: '8px 16px 32px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.2)', borderRadius: '12px', padding: '14px' }}>
            <p style={{ color: '#C4C9E0', fontSize: '13px', margin: 0 }}>A verification code was sent to <strong style={{ color: '#F0F0FF' }}>{currentUser?.email}</strong>. Enter it below to confirm your new password.</p>
          </div>
          {error && (
            <div style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '10px', padding: '10px 14px' }}>
              <p style={{ color: '#F87171', fontSize: '13px', margin: 0 }}>{error}</p>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 600, letterSpacing: '0.05em' }}>VERIFICATION CODE</label>
            <input type="text" value={otp} onChange={e => setOtp(e.target.value)} placeholder="Enter code from email" required style={{ ...inputStyle, letterSpacing: '0.1em', fontSize: '16px' }} />
          </div>
          <button type="submit" disabled={loading} style={{ marginTop: '8px', padding: '14px', background: loading ? '#2D2D4E' : 'linear-gradient(135deg, #7B2FBE, #4F46E5)', border: 'none', borderRadius: '12px', color: loading ? '#8B8FA8' : '#fff', fontSize: '14px', fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer' }}>
            {loading ? 'Updating…' : 'Update Password'}
          </button>
          <button type="button" onClick={() => { setStep('verify'); setError(null); }} style={{ padding: '10px', background: 'none', border: 'none', color: '#8B8FA8', fontSize: '13px', cursor: 'pointer' }}>
            ← Back
          </button>
        </form>
      )}
    </div>
  );
}

// ── Main Settings Screen ──────────────────────────────────────────

export function SettingsScreen({
  currentUser,
  onBack,
  onSignOut,
  onNavigate,
  isDark,
  onToggleDark,
  onProfileUpdated,
}: SettingsScreenProps) {
  if (!currentUser) {
    return (
      <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8B8FA8', fontFamily: 'Inter, sans-serif' }}>
        Loading settings...
      </div>
    );
  }

  const [pushNotifs, setPushNotifs] = useState(true);
  const [emailNotifs, setEmailNotifs] = useState(true);
  const [promoNotifs, setPromoNotifs] = useState(true);
  const [locationServices, setLocationServices] = useState(true);
  const [subScreen, setSubScreen] = useState<SubScreen>(null);
  const [clearingNotifs, setClearingNotifs] = useState(false);
  const [notifsCleared, setNotifsCleared] = useState(false);

  const handleClearNotifications = async () => {
    if (!currentUser?.id || clearingNotifs) return;
    if (!window.confirm('Clear all notification history? This cannot be undone.')) return;
    setClearingNotifs(true);
    try {
      await getAuthToken();
      const { error } = await insforge.database
        .from('notifications')
        .delete()
        .eq('user_id', currentUser.id);
      if (error) throw error;
      setNotifsCleared(true);
      setTimeout(() => setNotifsCleared(false), 2500);
    } catch (err) {
      console.error('Failed to clear notifications:', err);
    } finally {
      setClearingNotifs(false);
    }
  };

  // Load promotions_enabled from DB on mount
  useEffect(() => {
    if (!currentUser?.id) return;
    insforge.database
      .from('users')
      .select('promotions_enabled')
      .eq('id', currentUser.id)
      .maybeSingle()
      .then(({ data }) => {
        if (data && typeof data.promotions_enabled === 'boolean') {
          setPromoNotifs(data.promotions_enabled);
        }
      });
  }, [currentUser?.id]);

  const handlePromoToggle = async (val: boolean) => {
    setPromoNotifs(val);
    if (!currentUser?.id) return;
    await insforge.database
      .from('users')
      .update({ promotions_enabled: val })
      .eq('id', currentUser.id);
  };

  if (subScreen === 'profile') return <ProfileDetailsScreen currentUser={currentUser} onBack={() => setSubScreen(null)} onProfileUpdated={onProfileUpdated} />;
  if (subScreen === 'payment') return <PaymentMethodsScreen onBack={() => setSubScreen(null)} />;
  if (subScreen === 'help') return <HelpCenterScreen onBack={() => setSubScreen(null)} />;
  if (subScreen === 'change-password') return <ChangePasswordScreen currentUser={currentUser} onBack={() => setSubScreen(null)} />;
  if (subScreen === 'delete-account') return <DeleteAccountScreen currentUser={currentUser} onBack={() => setSubScreen(null)} onDeleted={onSignOut} />;
  if (subScreen === 'cac-verify') return <CACVerificationScreen currentUser={currentUser} onBack={() => setSubScreen(null)} />;

  const initial = (currentUser?.full_name || currentUser?.email || 'A').trim().charAt(0).toUpperCase();
  const displayName = currentUser?.full_name || currentUser?.email || 'Guest User';
  const displayEmail = currentUser?.email || '';

  return (
    <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px' }}>
        <button
          onClick={onBack}
          style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
        >
          <ArrowLeft size={16} color="#C4C9E0" />
        </button>
        <h1 style={{ color: '#FFFFFF', fontSize: '24px', fontWeight: 700 }}>Settings</h1>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 16px calc(120px + env(safe-area-inset-bottom))', scrollbarWidth: 'none' }}>
        {/* Profile card — shows avatar if available */}
        <div style={{ background: '#090514', border: '1px solid rgba(168,85,247,0.1)', borderRadius: '20px', padding: '16px', display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '20px' }}>
          <div style={{ width: '56px', height: '56px', borderRadius: '50%', background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden', boxShadow: '0 0 16px rgba(168,85,247,0.3)' }}>
            {(currentUser as any)?.avatar_url ? (
              <img src={(currentUser as any).avatar_url} alt="Avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <span style={{ color: '#fff', fontSize: '22px', fontWeight: 700 }}>{initial}</span>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
              <p style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 700, margin: 0 }}>{displayName}</p>
              <BadgeChip tier={(currentUser as any)?.vc_badge} />
            </div>
            <p style={{ color: '#8B8FA8', fontSize: '13px', marginTop: '2px' }}>{displayEmail}</p>
          </div>
          <button
            onClick={() => setSubScreen('profile')}
            style={{ background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.2)', borderRadius: '10px', padding: '7px 12px', color: '#A78BFA', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
          >
            Edit
          </button>
        </div>

        {currentUser?.role === 'organizer' && (
          currentUser?.is_verified ? (
            <div style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: '16px', padding: '14px 16px', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <ShieldCheck size={20} color="#10B981" />
              <span style={{ color: '#10B981', fontSize: '14px', fontWeight: 700 }}>Verified Organizer</span>
            </div>
          ) : (
            <div
              onClick={() => setSubScreen('cac-verify')}
              style={{ background: 'linear-gradient(135deg, rgba(123,47,190,0.18), rgba(79,70,229,0.18))', border: '1px solid rgba(168,85,247,0.35)', borderRadius: '16px', padding: '14px 16px', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer' }}
            >
              <div style={{ width: '38px', height: '38px', borderRadius: '12px', background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <ShieldCheck size={19} color="#fff" />
              </div>
              <div style={{ flex: 1 }}>
                <p style={{ margin: 0, color: '#F0F0FF', fontSize: '14px', fontWeight: 700 }}>Get Verified as an Organizer</p>
                <p style={{ margin: '2px 0 0', color: '#A78BFA', fontSize: '12px' }}>Submit your CAC details for a verified badge</p>
              </div>
              <ChevronRight size={16} color="#A78BFA" />
            </div>
          )
        )}

        <Section title="ACCOUNT">
          <SettingRow icon={User} label="Profile Details" onPress={() => setSubScreen('profile')} />
          <Divider />
          <SettingRow icon={CreditCard} label="Payment Methods" onPress={() => setSubScreen('payment')} />
          <Divider />
          <SettingRow icon={Shield} label="Change Password" onPress={() => setSubScreen('change-password')} />
        </Section>

        <Section title="NOTIFICATIONS">
          <SettingRow icon={Bell} label="Push Notifications" toggle={pushNotifs} onToggle={setPushNotifs} />
          <Divider />
          <SettingRow icon={Bell} label="Email Updates" toggle={emailNotifs} onToggle={setEmailNotifs} />
          <Divider />
          <SettingRow icon={Star} label="Promotions & Deals" toggle={promoNotifs} onToggle={handlePromoToggle} />
          <Divider />
          <SettingRow
            icon={Trash2}
            label={clearingNotifs ? 'Clearing…' : notifsCleared ? 'Cleared ✓' : 'Clear Notification History'}
            onPress={handleClearNotifications}
          />
        </Section>

        <Section title="PRIVACY & SECURITY">
          <SettingRow icon={Shield} label="Location Services" toggle={locationServices} onToggle={setLocationServices} />
          <Divider />
          <SettingRow icon={Shield} label="Privacy & Security" onPress={() => onNavigate?.('privacy-security')} />
        </Section>

        {/* APPEARANCE section removed — Midnight Neon is enforced system-wide */}

        <Section title="SUPPORT & LEGAL">
          <SettingRow icon={Shield} label="Privacy Policy" onPress={() => window.open('https://getvents.com/privacy', '_blank')} />
          <Divider />
          <SettingRow icon={Shield} label="Terms of Use" onPress={() => window.open('https://getvents.com/terms', '_blank')} />
          <Divider />
          <SettingRow icon={Shield} label="Refund Policy" onPress={() => window.open('https://getvents.com/refunds', '_blank')} />
          <Divider />
          <SettingRow icon={HelpCircle} label="Help Center" onPress={() => onNavigate?.('help-support')} />
        </Section>

        <Section title="RESOURCES">
          <SettingRow icon={Star} label="Rate this App" onPress={() => window.open('https://apps.apple.com/app/vents', '_blank')} />
          <Divider />
          <SettingRow icon={MessageCircle} label="Contact Support" onPress={() => window.open('mailto:support@getvents.com')} />
          <Divider />
          {/* Instagram */}
          <div
            onClick={() => window.open('https://instagram.com/TheVentsApp', '_blank')}
            style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '13px 0', cursor: 'pointer' }}
          >
            <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: 'linear-gradient(45deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Camera size={16} color="#fff" />
            </div>
            <span style={{ flex: 1, color: '#FFFFFF', fontSize: '15px', fontWeight: 500 }}>Follow on Instagram</span>
            <ChevronRight size={16} color="#94A3B8" />
          </div>
          <Divider />
          {/* Twitter/X */}
          <div
            onClick={() => window.open('https://twitter.com/TheVentsApp', '_blank')}
            style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '13px 0', cursor: 'pointer' }}
          >
            <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <span style={{ color: '#fff', fontSize: '15px', fontWeight: 900, lineHeight: 1 }}>X</span>
            </div>
            <span style={{ flex: 1, color: '#FFFFFF', fontSize: '15px', fontWeight: 500 }}>Follow on Twitter/X</span>
            <ChevronRight size={16} color="#94A3B8" />
          </div>
          <Divider />
          {/* TikTok */}
          <div
            onClick={() => window.open('https://tiktok.com/@TheVentsApp', '_blank')}
            style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '13px 0', cursor: 'pointer' }}
          >
            <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, position: 'relative' }}>
              <Music size={16} color="#fff" />
              <span style={{ position: 'absolute', bottom: '4px', right: '4px', width: '7px', height: '7px', borderRadius: '50%', background: '#69C9D0', border: '1px solid #000' }} />
            </div>
            <span style={{ flex: 1, color: '#FFFFFF', fontSize: '15px', fontWeight: 500 }}>Follow on TikTok</span>
            <ChevronRight size={16} color="#94A3B8" />
          </div>
        </Section>

        <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '16px', padding: '0 14px' }}>
            <SettingRow icon={LogOut} label="Sign Out" onPress={onSignOut} danger />
          </div>
          <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.4)', borderRadius: '16px', padding: '0 14px' }}>
            <SettingRow icon={Trash2} label="Delete Account" onPress={() => setSubScreen('delete-account')} danger />
          </div>
        </div>

        <p style={{ textAlign: 'center', color: '#555C7A', fontSize: '11px', marginTop: '20px' }}>
          VENTS v1.1.0 | © VENTS LTD
        </p>
      </div>
    </div>
  );
}

function DeleteAccountScreen({
  currentUser,
  onBack,
  onDeleted,
}: {
  currentUser: { id: string; email: string; full_name: string | null; role: string } | null;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const [confirmText, setConfirmText] = useState('');
  const [step, setStep] = useState<'warn' | 'confirm' | 'done'>('warn');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    if (confirmText !== 'DELETE') return;
    setLoading(true);
    setError(null);
    try {
      const { error: rpcErr } = await insforge.database.rpc('delete_own_account' as any);
      if (rpcErr) throw rpcErr;
      setStep('done');
      setTimeout(() => onDeleted(), 3000);
    } catch (err: any) {
      setError('Account deletion failed. Please try again or contact support@getvents.com.');
    } finally {
      setLoading(false);
    }
  };

  if (step === 'done') {
    return (
      <div style={{ background: '#020005', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '32px', textAlign: 'center', fontFamily: 'Inter, sans-serif' }}>
        <span style={{ fontSize: '48px', marginBottom: '20px' }}>✓</span>
        <p style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 700, marginBottom: '12px' }}>Account Deleted</p>
        <p style={{ color: '#8B8FA8', fontSize: '14px', lineHeight: 1.6, marginBottom: '16px' }}>
          Your personal data has been anonymized and your account has been closed.
        </p>
        <p style={{ color: '#8B8FA8', fontSize: '13px', lineHeight: 1.6 }}>
          If this was a mistake, contact us:<br />
          <strong style={{ color: '#A78BFA' }}>support@getvents.com</strong><br />
          WhatsApp: <strong style={{ color: '#A78BFA' }}>+234 9030737368</strong>
        </p>
      </div>
    );
  }

  return (
    <div style={{ background: '#020005', height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'Inter, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', color: '#8B8FA8', cursor: 'pointer', padding: '4px' }}>
          <ArrowLeft size={20} />
        </button>
        <span style={{ color: '#EF4444', fontSize: '16px', fontWeight: 700 }}>Delete Account</span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 16px' }}>
        {step === 'warn' && (
          <>
            <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '16px', padding: '20px', marginBottom: '20px' }}>
              <p style={{ color: '#EF4444', fontSize: '15px', fontWeight: 700, marginBottom: '12px' }}>⚠️ This cannot be undone</p>
              <p style={{ color: '#C4C9E0', fontSize: '13px', lineHeight: 1.6 }}>Deleting your account will permanently:</p>
              <ul style={{ color: '#C4C9E0', fontSize: '13px', lineHeight: 1.8, marginTop: '8px', paddingLeft: '20px' }}>
                <li>Anonymize your name, email, username, and profile photo</li>
                <li>Remove your bio, phone number, and cover photo</li>
                <li>Cancel any pending ticket reservations</li>
                <li>Block future sign-up with this email address</li>
              </ul>
            </div>
            <div style={{ background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.15)', borderRadius: '16px', padding: '16px', marginBottom: '24px' }}>
              <p style={{ color: '#10B981', fontSize: '13px', fontWeight: 600, marginBottom: '6px' }}>What is kept:</p>
              <ul style={{ color: '#C4C9E0', fontSize: '13px', lineHeight: 1.8, paddingLeft: '20px' }}>
                <li>Ticket purchase history (required by Nigerian law for 7 years)</li>
                <li>Reviews you have written</li>
              </ul>
            </div>
            <button onClick={() => setStep('confirm')} style={{ width: '100%', background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '14px', padding: '14px', color: '#EF4444', fontSize: '15px', fontWeight: 700, cursor: 'pointer', marginBottom: '8px' }}>
              I understand, continue
            </button>
            <button onClick={onBack} style={{ width: '100%', background: 'none', border: 'none', color: '#8B8FA8', fontSize: '14px', cursor: 'pointer', padding: '10px' }}>
              Cancel
            </button>
          </>
        )}

        {step === 'confirm' && (
          <>
            <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700, marginBottom: '8px' }}>Type DELETE to confirm</p>
            <p style={{ color: '#8B8FA8', fontSize: '13px', marginBottom: '20px', lineHeight: 1.5 }}>
              Type the word <strong style={{ color: '#EF4444' }}>DELETE</strong> in capital letters to permanently delete your account.
            </p>
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="Type DELETE here"
              style={{ width: '100%', background: 'rgba(255,255,255,0.04)', border: confirmText === 'DELETE' ? '1px solid #EF4444' : '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', padding: '14px', color: '#F0F0FF', fontSize: '16px', fontWeight: 700, outline: 'none', boxSizing: 'border-box', letterSpacing: '2px', fontFamily: 'inherit', marginBottom: '16px' }}
            />
            {error && <p style={{ color: '#EF4444', fontSize: '13px', marginBottom: '12px' }}>{error}</p>}
            <button
              onClick={handleDelete}
              disabled={confirmText !== 'DELETE' || loading}
              style={{ width: '100%', background: confirmText === 'DELETE' ? '#EF4444' : 'rgba(239,68,68,0.15)', border: 'none', borderRadius: '14px', padding: '14px', color: '#fff', fontSize: '15px', fontWeight: 700, cursor: confirmText === 'DELETE' ? 'pointer' : 'not-allowed', opacity: loading ? 0.7 : 1, marginBottom: '8px' }}
            >
              {loading ? 'Deleting...' : 'Permanently Delete My Account'}
            </button>
            <button onClick={() => setStep('warn')} style={{ width: '100%', background: 'none', border: 'none', color: '#8B8FA8', fontSize: '14px', cursor: 'pointer', padding: '10px' }}>
              Go back
            </button>
          </>
        )}
      </div>
    </div>
  );
}
