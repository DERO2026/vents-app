import { useState, useEffect, useRef } from 'react';
import { insforge, getAuthToken } from '../../lib/insforge';
import { sanitize } from '../../lib/sanitize';
import QRCode from 'qrcode';
import {
  ArrowLeft, User, Bell, Shield, Moon, Sun, HelpCircle, LogOut, MessageCircle,
  ChevronRight, Globe, Star, CreditCard, Plus, Trash2, CheckCircle,
  Smartphone, X, ExternalLink, ShieldCheck, Copy,
} from 'lucide-react';
import { generateTOTPSecret, verifyTOTP, makeTOTPUri } from '../../lib/totp';
import { ImageCropperModal } from './ImageCropperModal';

interface SettingsScreenProps {
  currentUser: { id: string; email: string; full_name: string | null; role: string; username?: string; phone_number?: string; state?: string } | null;
  onBack: () => void;
  onSignOut: () => void;
  onNavigate?: (screen: string) => void;
  isDark: boolean;
  onToggleDark: () => void;
  onProfileUpdated?: (fields: { full_name?: string; username?: string; bio?: string; phone_number?: string; avatar_url?: string }) => void;
  language?: string;
  onLanguageChange?: (lang: string) => void;
}

type SubScreen = null | 'profile' | 'payment' | 'language' | '2fa' | 'help' | 'change-password' | 'delete-account';


function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      onClick={() => onChange(!on)}
      style={{
        width: '44px',
        height: '26px',
        borderRadius: '13px',
        background: on ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)' : '#2A2D3E',
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
          background: danger ? 'rgba(239,68,68,0.1)' : accent ? 'rgba(168,85,247,0.1)' : 'rgba(255,255,255,0.05)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Icon size={17} color={danger ? '#EF4444' : accent ? '#A855F7' : '#C4C9E0'} />
      </div>
      <span style={{ flex: 1, color: danger ? '#EF4444' : '#F0F0FF', fontSize: '14px', fontWeight: 500 }}>
        {label}
      </span>
      {typeof toggle === 'boolean' && onToggle ? (
        <Toggle on={toggle} onChange={onToggle} />
      ) : value ? (
        <span style={{ color: '#8B8FA8', fontSize: '13px' }}>{value}</span>
      ) : onPress ? (
        <ChevronRight size={16} color="#8B8FA8" />
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '8px' }}>
      <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em', marginBottom: '2px', paddingLeft: '4px' }}>
        {title}
      </p>
      <div style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '0 14px' }}>
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
      <button onClick={onBack} style={{ background: '#1A1D2E', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '34px', height: '34px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
        <ArrowLeft size={15} color="#C4C9E0" />
      </button>
      <h2 style={{ color: '#F0F0FF', fontSize: '17px', fontWeight: 700 }}>{title}</h2>
    </div>
  );
}

// ── Sub-screens ──────────────────────────────────────────────────

function ProfileDetailsScreen({ currentUser, onBack, onProfileUpdated }: { currentUser: any; onBack: () => void; onProfileUpdated?: (fields: any) => void }) {
  if (!currentUser) {
    return (
      <div style={{ background: '#060A12', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8B8FA8', fontFamily: 'Inter, sans-serif' }}>
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
      console.log('[SettingsScreen] handleCropComplete (avatar) token prefix:', token.slice(0, 20));
      const croppedFile = new File([croppedBlob], 'avatar.jpg', { type: 'image/jpeg' });
      const formData = new FormData();
      formData.append('file', croppedFile);
      const res = await fetch(
        `${import.meta.env.VITE_INSFORGE_URL}/api/storage/buckets/avatars/objects`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData }
      );
      console.log('[SettingsScreen] avatar upload response status:', res.status);
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
      console.log('[SettingsScreen] handleCoverCropComplete (cover) token prefix:', token.slice(0, 20));
      const croppedFile = new File([croppedBlob], 'cover.jpg', { type: 'image/jpeg' });
      const formData = new FormData();
      formData.append('file', croppedFile);
      const res = await fetch(
        `${import.meta.env.VITE_INSFORGE_URL}/api/storage/buckets/avatars/objects`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData }
      );
      console.log('[SettingsScreen] cover upload response status:', res.status);
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
    background: '#1A1D2E',
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#060A12' }}>
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#060A12' }}>
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

const LANGUAGES = [
  { code: 'en',     name: 'English',         native: 'English',       flag: '🇬🇧', available: true },
  { code: 'pcm',    name: 'Pidgin English',  native: 'Nigerian Pidgin', flag: '🇳🇬', available: true },
  { code: 'yo',     name: 'Yoruba',          native: 'Yorùbá',        flag: '🇳🇬', available: false },
  { code: 'ig',     name: 'Igbo',            native: 'Igbo',          flag: '🇳🇬', available: false },
  { code: 'ha',     name: 'Hausa',           native: 'Hausa',         flag: '🇳🇬', available: false },
];

function LanguageScreen({
  onBack,
  selectedLanguage,
  onSelectLanguage
}: {
  onBack: () => void;
  selectedLanguage: string;
  onSelectLanguage: (lang: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#060A12' }}>
      <SubHeader title="Language" onBack={onBack} />
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px 32px', scrollbarWidth: 'none' }}>
        <p style={{ color: '#8B8FA8', fontSize: '13px', marginBottom: '16px', lineHeight: 1.5 }}>
          Select your preferred language. The app will be displayed in this language.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {LANGUAGES.map((lang) => (
            <button
              key={lang.code}
              onClick={() => lang.available && onSelectLanguage(lang.code)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '14px',
                padding: '14px',
                background: selectedLanguage === lang.code ? 'rgba(124,58,237,0.12)' : '#131629',
                border: selectedLanguage === lang.code ? '1.5px solid rgba(124,58,237,0.4)' : '1px solid rgba(255,255,255,0.05)',
                borderRadius: '14px',
                cursor: lang.available ? 'pointer' : 'default',
                textAlign: 'left',
                width: '100%',
                opacity: lang.available ? 1 : 0.55,
              }}
            >
              <span style={{ fontSize: '24px' }}>{lang.flag}</span>
              <div style={{ flex: 1 }}>
                <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>{lang.name}</p>
                <p style={{ color: '#8B8FA8', fontSize: '12px' }}>{lang.available ? lang.native : 'Coming soon'}</p>
              </div>
              {selectedLanguage === lang.code && (
                <div style={{ width: '22px', height: '22px', borderRadius: '50%', background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <CheckCircle size={14} color="#fff" />
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function TwoFAScreen({ onBack, currentUser }: { onBack: () => void; currentUser: any }) {
  const smsOtpRef = useRef<HTMLInputElement>(null);

  // SMS step state
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [smsStep, setSmsStep] = useState<'menu' | 'verify-sms'>('menu');
  const [smsCode, setSmsCode] = useState('');
  const [smsVerified, setSmsVerified] = useState(false);

  // TOTP state
  const [totpEnabled, setTotpEnabled] = useState(false);
  const [totpStep, setTotpStep] = useState<'menu' | 'qr' | 'verify'>('menu');
  const [totpSecret, setTotpSecret] = useState('');
  const [totpQr, setTotpQr] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [totpError, setTotpError] = useState<string | null>(null);
  const [totpSaving, setTotpSaving] = useState(false);
  const [secretCopied, setSecretCopied] = useState(false);
  const totpCodeRef = useRef<HTMLInputElement>(null);

  // Load existing TOTP state
  useEffect(() => {
    if (!currentUser?.id) return;
    insforge.database.from('users').select('totp_enabled').eq('id', currentUser.id).maybeSingle().then(({ data }) => {
      if (data?.totp_enabled) setTotpEnabled(true);
    });
  }, [currentUser?.id]);

  const startTotpEnrollment = async () => {
    const secret = generateTOTPSecret();
    const uri = makeTOTPUri(secret, currentUser?.email || 'user');
    const qrDataUrl = await QRCode.toDataURL(uri, { width: 220, margin: 1, color: { dark: '#F0F0FF', light: '#131629' } });
    setTotpSecret(secret);
    setTotpQr(qrDataUrl);
    setTotpCode('');
    setTotpError(null);
    setTotpStep('qr');
  };

  const handleTotpVerify = async () => {
    setTotpError(null);
    if (totpCode.length !== 6) return;
    const valid = await verifyTOTP(totpSecret, totpCode);
    if (!valid) {
      setTotpError('Incorrect code — try again.');
      setTotpCode('');
      setTimeout(() => totpCodeRef.current?.focus(), 50);
      return;
    }
    setTotpSaving(true);
    try {
      const { error } = await insforge.database.from('users').update({ totp_secret: totpSecret, totp_enabled: true }).eq('id', currentUser.id);
      if (error) throw error;
      setTotpEnabled(true);
      setTotpStep('menu');
    } catch {
      setTotpError('Failed to save. Please try again.');
    } finally {
      setTotpSaving(false);
    }
  };

  const handleTotpDisable = async () => {
    setTotpSaving(true);
    try {
      await insforge.database.from('users').update({ totp_secret: null, totp_enabled: false }).eq('id', currentUser.id);
      setTotpEnabled(false);
      setTotpSecret('');
    } catch { /* ignore */ } finally { setTotpSaving(false); }
  };

  // ── SMS verify step ───────────────────────────────────────────────────────
  if (smsStep === 'verify-sms') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#060A12' }}>
        <SubHeader title="Verify Phone" onBack={() => { setSmsStep('menu'); setSmsCode(''); }} />
        <div style={{ flex: 1, padding: '32px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{ fontSize: '52px', marginBottom: '16px' }}>📱</div>
          <h3 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 700, marginBottom: '8px', textAlign: 'center' }}>Enter verification code</h3>
          <p style={{ color: '#8B8FA8', fontSize: '13px', textAlign: 'center', marginBottom: '28px' }}>
            We'll send a 6-digit code to {currentUser?.phone_number || 'your phone number'} when SMS delivery is active.
          </p>
          {/* OTP boxes — tap any box to focus the hidden input */}
          <div style={{ display: 'flex', gap: '10px', marginBottom: '24px', cursor: 'text' }} onClick={() => smsOtpRef.current?.focus()}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} style={{ width: '42px', height: '52px', background: '#131629', border: `1px solid ${smsCode.length > i ? 'rgba(167,139,250,0.5)' : 'rgba(255,255,255,0.08)'}`, borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ color: '#F0F0FF', fontSize: '20px', fontWeight: 700 }}>{smsCode[i] ?? ''}</span>
              </div>
            ))}
          </div>
          {/* Hidden real input — type="tel" so maxLength works on mobile */}
          <input
            ref={smsOtpRef}
            type="tel"
            inputMode="numeric"
            maxLength={6}
            value={smsCode}
            onChange={e => setSmsCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            autoFocus
            style={{ position: 'absolute', opacity: 0, width: '1px', height: '1px' }}
          />
          <button
            onClick={() => { if (smsCode.length === 6) { setSmsVerified(true); setSmsStep('menu'); setSmsEnabled(true); } }}
            style={{ width: '100%', background: smsCode.length === 6 ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)' : '#1A1D2E', border: 'none', borderRadius: '14px', padding: '14px', color: smsCode.length === 6 ? '#fff' : '#8B8FA8', fontSize: '15px', fontWeight: 700, cursor: smsCode.length === 6 ? 'pointer' : 'not-allowed' }}
          >
            Verify
          </button>
          <button style={{ background: 'none', border: 'none', color: '#A78BFA', fontSize: '13px', cursor: 'pointer', marginTop: '14px' }}>
            Resend code
          </button>
        </div>
      </div>
    );
  }

  // ── TOTP QR step ─────────────────────────────────────────────────────────
  if (totpStep === 'qr' || totpStep === 'verify') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#060A12' }}>
        <SubHeader title="Set Up Authenticator" onBack={() => { setTotpStep('menu'); setTotpCode(''); setTotpError(null); }} />
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 20px 40px', display: 'flex', flexDirection: 'column', alignItems: 'center', scrollbarWidth: 'none' }}>
          <div style={{ width: '52px', height: '52px', borderRadius: '50%', background: 'rgba(79,70,229,0.12)', border: '1px solid rgba(79,70,229,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '16px' }}>
            <ShieldCheck size={24} color="#818CF8" />
          </div>
          <h3 style={{ color: '#F0F0FF', fontSize: '17px', fontWeight: 800, marginBottom: '6px', textAlign: 'center', fontFamily: 'Space Grotesk, sans-serif' }}>Scan QR Code</h3>
          <p style={{ color: '#8B8FA8', fontSize: '12px', textAlign: 'center', marginBottom: '20px', lineHeight: 1.5 }}>
            Open Google Authenticator, Authy, or any TOTP app, and scan this code.
          </p>
          {totpQr && (
            <img src={totpQr} alt="TOTP QR code" style={{ width: 200, height: 200, borderRadius: '12px', marginBottom: '16px', background: '#131629', padding: '6px' }} />
          )}
          {/* Manual secret entry */}
          <div style={{ background: '#0D0D1A', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', padding: '12px 14px', width: '100%', marginBottom: '20px' }}>
            <p style={{ color: '#8B8FA8', fontSize: '11px', marginBottom: '6px' }}>Can't scan? Enter this key manually:</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ color: '#A78BFA', fontSize: '12px', fontFamily: 'monospace', flex: 1, letterSpacing: '0.05em', wordBreak: 'break-all' }}>{totpSecret}</span>
              <button onClick={async () => { await navigator.clipboard.writeText(totpSecret); setSecretCopied(true); setTimeout(() => setSecretCopied(false), 1500); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: secretCopied ? '#10B981' : '#8B8FA8', flexShrink: 0 }}>
                {secretCopied ? <CheckCircle size={14} /> : <Copy size={14} />}
              </button>
            </div>
          </div>
          <p style={{ color: '#C4C9E0', fontSize: '13px', marginBottom: '10px', textAlign: 'center' }}>
            After scanning, enter the 6-digit code to confirm:
          </p>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px', cursor: 'text' }} onClick={() => totpCodeRef.current?.focus()}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} style={{ width: '42px', height: '52px', background: '#131629', border: `1px solid ${totpCode.length > i ? 'rgba(129,140,248,0.6)' : 'rgba(255,255,255,0.08)'}`, borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ color: '#F0F0FF', fontSize: '20px', fontWeight: 700 }}>{totpCode[i] ?? ''}</span>
              </div>
            ))}
          </div>
          <input
            ref={totpCodeRef}
            type="tel"
            inputMode="numeric"
            maxLength={6}
            value={totpCode}
            onChange={e => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={e => e.key === 'Enter' && handleTotpVerify()}
            autoFocus
            style={{ position: 'absolute', opacity: 0, width: '1px', height: '1px' }}
          />
          {totpError && (
            <p style={{ color: '#EF4444', fontSize: '12px', marginTop: '8px', textAlign: 'center' }}>{totpError}</p>
          )}
          <button
            onClick={handleTotpVerify}
            disabled={totpCode.length !== 6 || totpSaving}
            style={{ marginTop: '16px', width: '100%', background: totpCode.length === 6 && !totpSaving ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)' : '#1A1D2E', border: 'none', borderRadius: '14px', padding: '14px', color: totpCode.length === 6 && !totpSaving ? '#fff' : '#8B8FA8', fontSize: '15px', fontWeight: 700, cursor: totpCode.length === 6 && !totpSaving ? 'pointer' : 'not-allowed' }}
          >
            {totpSaving ? 'Saving…' : 'Verify & Enable'}
          </button>
        </div>
      </div>
    );
  }

  // ── Menu ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#060A12' }}>
      <SubHeader title="Two-Factor Authentication" onBack={onBack} />
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 16px 32px', scrollbarWidth: 'none' }}>
        {smsVerified && (
          <div style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: '12px', padding: '12px 14px', marginBottom: '16px', display: 'flex', gap: '8px', alignItems: 'center' }}>
            <CheckCircle size={16} color="#10B981" />
            <span style={{ color: '#10B981', fontSize: '13px', fontWeight: 600 }}>SMS 2FA enabled successfully!</span>
          </div>
        )}
        {totpEnabled && (
          <div style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: '12px', padding: '12px 14px', marginBottom: '16px', display: 'flex', gap: '8px', alignItems: 'center' }}>
            <ShieldCheck size={16} color="#10B981" />
            <span style={{ color: '#10B981', fontSize: '13px', fontWeight: 600 }}>Authenticator 2FA is active</span>
          </div>
        )}
        <p style={{ color: '#C4C9E0', fontSize: '13px', lineHeight: 1.6, marginBottom: '20px' }}>
          Two-factor authentication adds an extra layer of security to your account.
        </p>

        {/* SMS */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 0' }}>
            <div style={{ width: '40px', height: '40px', borderRadius: '11px', background: smsEnabled ? 'rgba(16,185,129,0.12)' : 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Smartphone size={18} color={smsEnabled ? '#10B981' : '#8B8FA8'} />
            </div>
            <div style={{ flex: 1 }}>
              <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>SMS Authentication</p>
              <p style={{ color: '#8B8FA8', fontSize: '12px' }}>Receive a code by text message</p>
            </div>
            <Toggle on={smsEnabled} onChange={() => { if (!smsEnabled) setSmsStep('verify-sms'); else setSmsEnabled(false); }} />
          </div>
          <div style={{ height: '1px', background: 'rgba(255,255,255,0.05)' }} />
        </div>

        {/* Authenticator App (TOTP) */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 0' }}>
            <div style={{ width: '40px', height: '40px', borderRadius: '11px', background: totpEnabled ? 'rgba(16,185,129,0.12)' : 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <ShieldCheck size={18} color={totpEnabled ? '#10B981' : '#8B8FA8'} />
            </div>
            <div style={{ flex: 1 }}>
              <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>Authenticator App</p>
              <p style={{ color: '#8B8FA8', fontSize: '12px' }}>Google Authenticator, Authy, etc.</p>
            </div>
            <Toggle on={totpEnabled} onChange={() => {
              if (totpEnabled) handleTotpDisable();
              else startTotpEnrollment();
            }} />
          </div>
          <div style={{ height: '1px', background: 'rgba(255,255,255,0.05)' }} />
        </div>

        {/* Email (informational only) */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 0' }}>
            <div style={{ width: '40px', height: '40px', borderRadius: '11px', background: 'rgba(16,185,129,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Globe size={18} color="#10B981" />
            </div>
            <div style={{ flex: 1 }}>
              <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>Email Authentication</p>
              <p style={{ color: '#8B8FA8', fontSize: '12px' }}>Always active — used for account recovery</p>
            </div>
            <Toggle on={true} onChange={() => {}} />
          </div>
        </div>

        <div style={{ background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.15)', borderRadius: '14px', padding: '14px', marginTop: '20px' }}>
          <p style={{ color: '#A78BFA', fontSize: '13px', fontWeight: 600, marginBottom: '6px' }}>🔒 Recovery</p>
          <p style={{ color: '#C4C9E0', fontSize: '12px', lineHeight: 1.5 }}>
            If you lose your 2FA device, use your account email to reset access via the forgot password flow.
          </p>
        </div>
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#060A12' }}>
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
              <p style={{ color: '#C4C9E0', fontSize: '12px' }}>ventsappltd@gmail.com</p>
            </div>
            <button
              onClick={() => window.open('mailto:ventsappltd@gmail.com', '_blank')}
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
            <div style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '0 14px' }}>
              {articles.filter((a) => a.category === cat).map((article, i, arr) => (
                <div key={article.title}>
                  <button
                    onClick={() => window.open('mailto:ventsappltd@gmail.com', '_blank')}
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
            onClick={() => window.open('mailto:ventsappltd@gmail.com', '_blank')}
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
    width: '100%', background: '#131629', border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '12px', padding: '12px 14px', color: '#F0F0FF', fontSize: '14px',
    outline: 'none', boxSizing: 'border-box',
  };

  return (
    <div style={{ background: '#060A12', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px' }}>
        <button onClick={onBack} style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
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
  isDark,
  onToggleDark,
  onProfileUpdated,
  language = 'en',
  onLanguageChange
}: SettingsScreenProps) {
  if (!currentUser) {
    return (
      <div style={{ background: '#060A12', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8B8FA8', fontFamily: 'Inter, sans-serif' }}>
        Loading settings...
      </div>
    );
  }

  const [pushNotifs, setPushNotifs] = useState(true);
  const [emailNotifs, setEmailNotifs] = useState(true);
  const [promoNotifs, setPromoNotifs] = useState(false);
  const [locationServices, setLocationServices] = useState(true);
  const [biometrics, setBiometrics] = useState(false);
  const [subScreen, setSubScreen] = useState<SubScreen>(null);

  if (subScreen === 'profile') return <ProfileDetailsScreen currentUser={currentUser} onBack={() => setSubScreen(null)} onProfileUpdated={onProfileUpdated} />;
  if (subScreen === 'payment') return <PaymentMethodsScreen onBack={() => setSubScreen(null)} />;
  if (subScreen === 'language') {
    return (
      <LanguageScreen
        onBack={() => setSubScreen(null)}
        selectedLanguage={language}
        onSelectLanguage={onLanguageChange || (() => {})}
      />
    );
  }
  if (subScreen === '2fa') return <TwoFAScreen onBack={() => setSubScreen(null)} currentUser={currentUser} />;
  if (subScreen === 'help') return <HelpCenterScreen onBack={() => setSubScreen(null)} />;
  if (subScreen === 'change-password') return <ChangePasswordScreen currentUser={currentUser} onBack={() => setSubScreen(null)} />;
  if (subScreen === 'delete-account') return <DeleteAccountScreen currentUser={currentUser} onBack={() => setSubScreen(null)} onDeleted={onSignOut} />;

  const initial = (currentUser?.full_name || currentUser?.email || 'A').trim().charAt(0).toUpperCase();
  const displayName = currentUser?.full_name || currentUser?.email || 'Guest User';
  const displayEmail = currentUser?.email || '';

  return (
    <div style={{ background: '#060A12', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px' }}>
        <button
          onClick={onBack}
          style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
        >
          <ArrowLeft size={16} color="#C4C9E0" />
        </button>
        <h1 style={{ color: '#F0F0FF', fontSize: '20px', fontWeight: 700 }}>Settings</h1>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 16px calc(120px + env(safe-area-inset-bottom))', scrollbarWidth: 'none' }}>
        {/* Profile card — shows avatar if available */}
        <div style={{ background: '#0D0D1A', border: '1px solid rgba(168,85,247,0.1)', borderRadius: '20px', padding: '16px', display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '20px' }}>
          <div style={{ width: '56px', height: '56px', borderRadius: '50%', background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden', boxShadow: '0 0 16px rgba(168,85,247,0.3)' }}>
            {(currentUser as any)?.avatar_url ? (
              <img src={(currentUser as any).avatar_url} alt="Avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <span style={{ color: '#fff', fontSize: '22px', fontWeight: 700 }}>{initial}</span>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 700 }}>{displayName}</p>
            <p style={{ color: '#8B8FA8', fontSize: '13px' }}>{displayEmail}</p>
          </div>
          <button
            onClick={() => setSubScreen('profile')}
            style={{ background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.2)', borderRadius: '10px', padding: '7px 12px', color: '#A78BFA', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
          >
            Edit
          </button>
        </div>

        <Section title="ACCOUNT">
          <SettingRow icon={User} label="Profile Details" onPress={() => setSubScreen('profile')} />
          <Divider />
          <SettingRow icon={CreditCard} label="Payment Methods" onPress={() => setSubScreen('payment')} />
          <Divider />
          <SettingRow icon={Shield} label="Change Password" onPress={() => setSubScreen('change-password')} />
          <Divider />
          <SettingRow
            icon={Globe}
            label="Language"
            value={LANGUAGES.find(l => l.code === language)?.name || 'English'}
            onPress={() => setSubScreen('language')}
          />
        </Section>

        <Section title="NOTIFICATIONS">
          <SettingRow icon={Bell} label="Push Notifications" toggle={pushNotifs} onToggle={setPushNotifs} />
          <Divider />
          <SettingRow icon={Bell} label="Email Updates" toggle={emailNotifs} onToggle={setEmailNotifs} />
          <Divider />
          <SettingRow icon={Star} label="Promotions & Deals" toggle={promoNotifs} onToggle={setPromoNotifs} />
        </Section>

        <Section title="PRIVACY & SECURITY">
          <SettingRow icon={Shield} label="Location Services" toggle={locationServices} onToggle={setLocationServices} />
          <Divider />
          <SettingRow icon={Shield} label="Biometric Login" toggle={biometrics} onToggle={setBiometrics} />
          <Divider />
          <SettingRow icon={Shield} label="Two-Factor Authentication" onPress={() => setSubScreen('2fa')} />
          <Divider />
          <SettingRow icon={Shield} label="Privacy & Security" onPress={() => onNavigate?.('privacy-security')} />
        </Section>

        {/* APPEARANCE section removed — Midnight Neon is enforced system-wide */}

        <Section title="SUPPORT & LEGAL">
          <SettingRow icon={Shield} label="Privacy Policy" onPress={() => window.open('/privacy', '_blank')} />
          <Divider />
          <SettingRow icon={Shield} label="Terms of Use" onPress={() => window.open('/terms', '_blank')} />
          <Divider />
          <SettingRow icon={HelpCircle} label="Help Center" onPress={() => setSubScreen('help')} />
        </Section>

        <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ background: '#131629', border: '1px solid rgba(239,68,68,0.15)', borderRadius: '16px', padding: '0 14px' }}>
            <SettingRow icon={LogOut} label="Sign Out" onPress={onSignOut} danger />
          </div>
          <div style={{ background: '#131629', border: '1px solid rgba(239,68,68,0.15)', borderRadius: '16px', padding: '0 14px' }}>
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
      setError('Account deletion failed. Please try again or contact ventsappltd@gmail.com.');
    } finally {
      setLoading(false);
    }
  };

  if (step === 'done') {
    return (
      <div style={{ background: '#060A12', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '32px', textAlign: 'center', fontFamily: 'Inter, sans-serif' }}>
        <span style={{ fontSize: '48px', marginBottom: '20px' }}>✓</span>
        <p style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 700, marginBottom: '12px' }}>Account Deleted</p>
        <p style={{ color: '#8B8FA8', fontSize: '14px', lineHeight: 1.6, marginBottom: '16px' }}>
          Your personal data has been anonymized and your account has been closed.
        </p>
        <p style={{ color: '#8B8FA8', fontSize: '13px', lineHeight: 1.6 }}>
          If this was a mistake, contact us:<br />
          <strong style={{ color: '#A78BFA' }}>ventsappltd@gmail.com</strong><br />
          WhatsApp: <strong style={{ color: '#A78BFA' }}>+234 9030737368</strong>
        </p>
      </div>
    );
  }

  return (
    <div style={{ background: '#060A12', height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'Inter, sans-serif' }}>
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
