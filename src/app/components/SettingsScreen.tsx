import { useState, useEffect, useRef } from 'react';
import { insforge } from '../../lib/insforge';
import {
  ArrowLeft, User, Bell, Shield, Moon, Sun, HelpCircle, LogOut,
  ChevronRight, Globe, Star, CreditCard, Plus, Trash2, CheckCircle,
  Smartphone, X, ExternalLink,
} from 'lucide-react';
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

type SubScreen = null | 'profile' | 'payment' | 'language' | '2fa' | 'help' | 'change-password';


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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [cropImageSrc, setCropImageSrc] = useState<string | null>(null);
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
      const croppedFile = new File([croppedBlob], 'avatar.jpg', { type: 'image/jpeg' });
      const { data, error } = await insforge.storage.from('avatars').uploadAuto(croppedFile);
      if (error) throw error;
      if (data?.url) {
        setAvatarUrl(data.url);
        const { error: updateError } = await insforge.database
          .from('users')
          .update({ avatar_url: data.url })
          .eq('id', currentUser.id);
        if (updateError) throw updateError;
        if (onProfileUpdated) {
          onProfileUpdated({ avatar_url: data.url });
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

  const handleSaveProfile = async () => {
    if (!currentUser?.id) return;
    setSaving(true);
    setErrorMessage(null);
    try {
      if (usernameAvailable === false) {
        throw new Error("Username is already taken.");
      }

      const cleanPhone = phone.replace(/\s/g, '').trim();
      if (cleanPhone) {
        const NIGERIAN_PHONE_REGEX = /^(\+234|0)[789][01]\d{8}$/;
        if (!NIGERIAN_PHONE_REGEX.test(cleanPhone)) {
          throw new Error("Please enter a valid Nigerian phone number.");
        }
      }

      const { error } = await insforge.database
        .from('users')
        .update({
          full_name: name.trim(),
          username: username.trim().toLowerCase(),
          bio: bio.trim(),
          phone_number: cleanPhone
        })
        .eq('id', currentUser.id);

      if (error) throw error;
      if (onProfileUpdated) {
        onProfileUpdated({
          full_name: name.trim(),
          username: username.trim().toLowerCase(),
          bio: bio.trim(),
          phone_number: phone.trim()
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
            {/* Avatar */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: '28px' }}>
              <div style={{ width: '80px', height: '80px', borderRadius: '22px', background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', marginBottom: '12px', boxShadow: '0 8px 24px rgba(123,47,190,0.4)' }}>
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
                    // Strip all non-digits, then format as Nigerian number
                    let raw = e.target.value.replace(/\D/g, '');
                    // If user typed leading +234, strip the country code prefix for formatting
                    if (raw.startsWith('234') && raw.length > 3) raw = '0' + raw.slice(3);
                    // Cap at 11 digits (0XX XXXX XXXX)
                    raw = raw.slice(0, 11);
                    // Format: 0XXX XXX XXXX
                    let formatted = raw;
                    if (raw.length > 7) formatted = raw.slice(0, 4) + ' ' + raw.slice(4, 7) + ' ' + raw.slice(7);
                    else if (raw.length > 4) formatted = raw.slice(0, 4) + ' ' + raw.slice(4);
                    setPhone(formatted);
                  }}
                  inputMode="tel"
                  placeholder="0801 234 5678"
                  style={inputStyle}
                />
                {phone.trim() && !/^(\+234|0)[789][01]\d{8}$/.test(phone.replace(/\s/g, '')) && (
                  <p style={{ color: '#EF4444', fontSize: '11px', marginTop: '4px' }}>
                    Enter a valid Nigerian number (e.g. 0801 234 5678)
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
  { code: 'en', name: 'English', native: 'English', flag: '🇬🇧' },
  { code: 'yo', name: 'Yoruba', native: 'Yorùbá', flag: '🇳🇬' },
  { code: 'ha', name: 'Hausa', native: 'Hausa', flag: '🇳🇬' },
  { code: 'ig', name: 'Igbo', native: 'Igbo', flag: '🇳🇬' },
  { code: 'fr', name: 'French', native: 'Français', flag: '🇫🇷' },
  { code: 'pt', name: 'Portuguese', native: 'Português', flag: '🇵🇹' },
  { code: 'ar', name: 'Arabic', native: 'العربية', flag: '🇸🇦' },
  { code: 'sw', name: 'Swahili', native: 'Kiswahili', flag: '🇰🇪' },
  { code: 'zu', name: 'Zulu', native: 'isiZulu', flag: '🇿🇦' },
  { code: 'de', name: 'German', native: 'Deutsch', flag: '🇩🇪' },
  { code: 'es', name: 'Spanish', native: 'Español', flag: '🇪🇸' },
  { code: 'zh', name: 'Chinese', native: '中文', flag: '🇨🇳' },
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
              onClick={() => onSelectLanguage(lang.code)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '14px',
                padding: '14px',
                background: selectedLanguage === lang.code ? 'rgba(124,58,237,0.12)' : '#131629',
                border: selectedLanguage === lang.code ? '1.5px solid rgba(124,58,237,0.4)' : '1px solid rgba(255,255,255,0.05)',
                borderRadius: '14px',
                cursor: 'pointer',
                textAlign: 'left',
                width: '100%',
              }}
            >
              <span style={{ fontSize: '24px' }}>{lang.flag}</span>
              <div style={{ flex: 1 }}>
                <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>{lang.name}</p>
                <p style={{ color: '#8B8FA8', fontSize: '12px' }}>{lang.native}</p>
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

function TwoFAScreen({ onBack }: { onBack: () => void }) {
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [appEnabled, setAppEnabled] = useState(false);
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [step, setStep] = useState<'menu' | 'verify-sms'>('menu');
  const [code, setCode] = useState('');
  const [verified, setVerified] = useState(false);

  if (step === 'verify-sms') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#060A12' }}>
        <SubHeader title="Verify Phone" onBack={() => setStep('menu')} />
        <div style={{ flex: 1, padding: '32px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{ fontSize: '52px', marginBottom: '16px' }}>📱</div>
          <h3 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 700, marginBottom: '8px', textAlign: 'center' }}>Enter verification code</h3>
          <p style={{ color: '#8B8FA8', fontSize: '13px', textAlign: 'center', marginBottom: '28px' }}>
            We sent a 6-digit code to your phone number ending in •••0932
          </p>
          <div style={{ display: 'flex', gap: '10px', marginBottom: '24px' }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} style={{ width: '42px', height: '52px', background: '#131629', border: `1px solid ${code.length > i ? 'rgba(167,139,250,0.5)' : 'rgba(255,255,255,0.08)'}`, borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ color: '#F0F0FF', fontSize: '20px', fontWeight: 700 }}>{code[i] ?? ''}</span>
              </div>
            ))}
          </div>
          <input
            type="number"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.slice(0, 6))}
            style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
            autoFocus
          />
          <button
            onClick={() => { if (code.length === 6) { setVerified(true); setStep('menu'); setSmsEnabled(true); } }}
            style={{ width: '100%', background: code.length === 6 ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)' : '#1A1D2E', border: 'none', borderRadius: '14px', padding: '14px', color: code.length === 6 ? '#fff' : '#8B8FA8', fontSize: '15px', fontWeight: 700, cursor: code.length === 6 ? 'pointer' : 'not-allowed' }}
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#060A12' }}>
      <SubHeader title="Two-Factor Authentication" onBack={onBack} />
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 16px 32px', scrollbarWidth: 'none' }}>
        {verified && (
          <div style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: '12px', padding: '12px 14px', marginBottom: '16px', display: 'flex', gap: '8px', alignItems: 'center' }}>
            <CheckCircle size={16} color="#10B981" />
            <span style={{ color: '#10B981', fontSize: '13px', fontWeight: 600 }}>SMS 2FA enabled successfully!</span>
          </div>
        )}
        <p style={{ color: '#C4C9E0', fontSize: '13px', lineHeight: 1.6, marginBottom: '20px' }}>
          Two-factor authentication adds an extra layer of security to your account. Choose one or more methods below.
        </p>

        {[
          { icon: Smartphone, label: 'SMS Authentication', desc: 'Receive a code by text message', enabled: smsEnabled, onToggle: () => { if (!smsEnabled) setStep('verify-sms'); else setSmsEnabled(false); } },
          { icon: Shield, label: 'Authenticator App', desc: 'Use Google Authenticator or Authy', enabled: appEnabled, onToggle: () => setAppEnabled(!appEnabled) },
          { icon: Globe, label: 'Email Authentication', desc: 'Receive a code via email', enabled: emailEnabled, onToggle: () => setEmailEnabled(!emailEnabled) },
        ].map(({ icon: Icon, label, desc, enabled, onToggle }, i, arr) => (
          <div key={label}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 0' }}>
              <div style={{ width: '40px', height: '40px', borderRadius: '11px', background: enabled ? 'rgba(16,185,129,0.12)' : 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Icon size={18} color={enabled ? '#10B981' : '#8B8FA8'} />
              </div>
              <div style={{ flex: 1 }}>
                <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>{label}</p>
                <p style={{ color: '#8B8FA8', fontSize: '12px' }}>{desc}</p>
              </div>
              <Toggle on={enabled} onChange={onToggle} />
            </div>
            {i < arr.length - 1 && <div style={{ height: '1px', background: 'rgba(255,255,255,0.05)' }} />}
          </div>
        ))}

        <div style={{ background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.15)', borderRadius: '14px', padding: '14px', marginTop: '20px' }}>
          <p style={{ color: '#A78BFA', fontSize: '13px', fontWeight: 600, marginBottom: '6px' }}>🔒 Recovery Codes</p>
          <p style={{ color: '#C4C9E0', fontSize: '12px', lineHeight: 1.5 }}>
            Save your recovery codes in a safe place. You can use them to access your account if you lose your 2FA device.
          </p>
          <button style={{ marginTop: '10px', background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.2)', borderRadius: '8px', padding: '8px 14px', color: '#A78BFA', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
            View Recovery Codes
          </button>
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
                    onClick={() => window.open('https://help.vents.ng', '_blank')}
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
            onClick={() => window.open('https://help.vents.ng', '_blank')}
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
  if (subScreen === '2fa') return <TwoFAScreen onBack={() => setSubScreen(null)} />;
  if (subScreen === 'help') return <HelpCenterScreen onBack={() => setSubScreen(null)} />;
  if (subScreen === 'change-password') return <ChangePasswordScreen currentUser={currentUser} onBack={() => setSubScreen(null)} />;

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
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 16px 40px', scrollbarWidth: 'none' }}>
        {/* Profile card — shows avatar if available */}
        <div style={{ background: '#0D0D1A', border: '1px solid rgba(168,85,247,0.1)', borderRadius: '20px', padding: '16px', display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '20px' }}>
          <div style={{ width: '56px', height: '56px', borderRadius: '16px', background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden', boxShadow: '0 0 16px rgba(168,85,247,0.3)' }}>
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
        </Section>

        {/* APPEARANCE section removed — Midnight Neon is enforced system-wide */}

        <Section title="SUPPORT & LEGAL">
          <SettingRow icon={Shield} label="Privacy Policy" onPress={() => onNavigate?.('privacy-policy')} />
          <Divider />
          <SettingRow icon={HelpCircle} label="Help Center" onPress={() => setSubScreen('help')} />
          <Divider />
          <SettingRow icon={Star} label="Rate VENTS" accent onPress={() => window.open('https://play.google.com/store', '_blank')} />
        </Section>

        <div style={{ marginTop: '8px' }}>
          <div style={{ background: '#131629', border: '1px solid rgba(239,68,68,0.15)', borderRadius: '16px', padding: '0 14px' }}>
            <SettingRow icon={LogOut} label="Sign Out" onPress={onSignOut} danger />
          </div>
        </div>

        <p style={{ textAlign: 'center', color: '#555C7A', fontSize: '11px', marginTop: '20px' }}>
          VENTS v1.1.0 | © VENTS LTD
        </p>
      </div>
    </div>
  );
}
