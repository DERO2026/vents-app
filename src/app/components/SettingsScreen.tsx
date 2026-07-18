import { useState, useEffect, useRef, useCallback } from 'react';
import { insforge, getAuthToken } from '../../lib/insforge';
import { sanitize } from '../../lib/sanitize';
import { REGION } from '../../lib/regionConfig';
import {
  ArrowLeft, Bell, Shield, HelpCircle, LogOut, MessageCircle,
  ChevronRight, Globe, Star, Plus, Trash2, CheckCircle,
  Smartphone, X, ExternalLink, ShieldCheck, Copy, ThumbsUp,
  Eye, EyeOff, Check, Clock, MessageSquare,
} from 'lucide-react';
import { SiInstagram, SiX, SiTiktok } from 'react-icons/si';
import BadgeChip from './BadgeChip';
import { compressImage } from '../../lib/compressImage';
import { withTimeoutFallback } from '../../lib/withTimeoutFallback';
import { Sentry } from '../../lib/sentry';
import { ImageCropperModal } from './ImageCropperModal';
import { NIGERIA_STATES } from './StateSelectScreen';
import { PhoneInput, COUNTRY_CODES } from './PhoneInput';

interface SettingsScreenProps {
  currentUser: { id: string; email: string; full_name: string | null; role: string; username?: string; phone_number?: string; state?: string; vc_badge?: string; is_verified?: boolean } | null;
  onBack: () => void;
  onSignOut: () => void;
  onNavigate?: (screen: string) => void;
  isDark: boolean;
  onToggleDark: () => void;
  onProfileUpdated?: (fields: { full_name?: string; username?: string; bio?: string; phone_number?: string; avatar_url?: string; state?: string }) => void;
}

type SubScreen = null | 'profile' | 'help' | 'change-password' | 'delete-account' | 'cac-verify';


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

// Same row layout/sizing as SettingRow, but with a brand-colored icon
// swatch (for platform recognition) instead of the fixed purple one.
function SocialRow({ icon: Icon, label, background, onPress }: { icon: React.ElementType; label: string; background: string; onPress: () => void }) {
  return (
    <div onClick={onPress} style={{ display: 'flex', alignItems: 'center', gap: '12px', width: '100%', padding: '14px 0', cursor: 'pointer' }}>
      <div style={{ width: '36px', height: '36px', borderRadius: '10px', background, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon size={16} color="#fff" />
      </div>
      <span style={{ flex: 1, color: '#FFFFFF', fontSize: '15px', fontWeight: 500 }}>{label}</span>
      <ChevronRight size={16} color="#94A3B8" />
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

// Never surface a raw DB/RLS/network error to the user — this is what's
// shown instead, no matter what actually failed underneath.
const VERIFICATION_UPLOAD_ERROR = "We couldn't upload your certificate. Please try again or contact support if the issue continues.";

// Client-side upload validation (Task 8). The storage bucket also enforces a
// hard 50MB cap server-side, but validating type + size here gives the user
// instant feedback and avoids wasting an upload round-trip on a bad file.
const MAX_CAC_FILE_BYTES = 10 * 1024 * 1024; // 10MB — a CAC certificate scan
const ACCEPTED_CAC_MIME = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/i;
const ACCEPTED_CAC_EXT = /\.(jpe?g|png|webp|heic|heif|pdf)$/i;
// Returns an error string if the file is invalid, or null if it's acceptable.
function validateCacFile(file: File): string | null {
  const typeOk = ACCEPTED_CAC_MIME.test(file.type) || (!file.type && ACCEPTED_CAC_EXT.test(file.name));
  if (!typeOk) return 'Please upload an image (JPG/PNG) or a PDF document.';
  if (file.size > MAX_CAC_FILE_BYTES) return 'File is too large. Please upload a document under 10MB.';
  if (file.size === 0) return 'That file appears to be empty. Please choose another.';
  return null;
}

// Real byte-level upload progress via XHR (fetch has no upload progress
// event). Uploads straight to the verification-docs bucket's storage
// endpoint; the RLS policy on storage.objects (bucket='verification-docs')
// is what actually authorizes this write for the signed-in user.
function uploadVerificationCertificate(file: File, token: string, onProgress: (pct: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${import.meta.env.VITE_INSFORGE_URL}/api/storage/buckets/verification-docs/objects`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let data: any = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON error body */ }
      if (xhr.status >= 200 && xhr.status < 300 && data?.url) {
        resolve(data.url as string);
      } else {
        reject(new Error(`verification_upload_failed:${xhr.status}:${data?.error || data?.message || 'unknown'}`));
      }
    };
    xhr.onerror = () => reject(new Error('verification_upload_failed:network'));
    const fd = new FormData();
    fd.append('file', file);
    xhr.send(fd);
  });
}

// Deliberate, curated business-rule messages submit_organizer_verification
// raises on purpose (see migrations/20260716175945_organizer-verification-
// workflow-v2.sql) — safe to show verbatim. Anything else (a genuine bug, an
// RLS error, a network failure) falls back to a generic friendly message.
const VERIFICATION_SUBMIT_ERROR = "We couldn't submit your verification request. Please try again or contact support if the issue continues.";
const KNOWN_VERIFICATION_RPC_ERRORS = new Set([
  'Business name is required', 'CAC number is required', 'Business address is required',
  'Owner name is required', 'A valid registration date is required', 'A valid business email is required',
  'Business phone is required', 'A certificate document is required',
  'Only organizers can request brand verification', 'You already have a pending verification request',
  'Not authenticated',
]);

interface VerificationRow {
  request_id: string; status: 'pending' | 'approved' | 'rejected'; admin_note: string | null;
  created_at: string; reviewed_at: string | null;
  company_name: string; cac_number: string; owner_name: string; registration_date: string;
  business_email: string; business_phone: string; business_address: string; document_url: string;
}

// Professional "Verification Pending" status page (Task 4) — business name,
// submission date, status, estimated review time, a friendly reference ID
// derived from the request UUID, and a Contact Support action.
function VerificationPendingCard({ v, onContactSupport }: { v: VerificationRow; onContactSupport?: () => void }) {
  const refId = `VER-${v.request_id.slice(0, 8).toUpperCase()}`;
  const submittedDate = new Date(v.created_at).toLocaleDateString('en-NG', { dateStyle: 'medium' });
  const rows: { label: string; value: string; color?: string; mono?: boolean }[] = [
    { label: 'Business Name', value: v.company_name },
    { label: 'Submission Date', value: submittedDate },
    { label: 'Status', value: 'Pending Review', color: '#F59E0B' },
    { label: 'Estimated Review Time', value: '1–3 business days' },
    { label: 'Verification Reference ID', value: refId, mono: true },
  ];
  return (
    <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', padding: '28px 20px 22px', background: 'linear-gradient(180deg, rgba(123,47,190,0.16), rgba(9,5,20,0))', borderRadius: '20px', border: '1px solid rgba(168,85,247,0.2)' }}>
        <div style={{ width: '56px', height: '56px', borderRadius: '50%', background: 'rgba(245,158,11,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Clock size={28} color="#F59E0B" />
        </div>
        <p style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 800, margin: 0, fontFamily: 'Space Grotesk, sans-serif' }}>Verification Pending</p>
        <p style={{ color: '#8B8FA8', fontSize: '13px', margin: 0, lineHeight: 1.5, maxWidth: '280px' }}>
          Your brand verification request is under review. We'll email you once a decision is made.
        </p>
      </div>

      <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '4px 16px' }}>
        {rows.map((row, i) => (
          <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', borderBottom: i < rows.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none', gap: '12px' }}>
            <span style={{ color: '#8B8FA8', fontSize: '13px', flexShrink: 0 }}>{row.label}</span>
            <span style={{ color: row.color || '#F0F0FF', fontSize: '13px', fontWeight: 700, fontFamily: row.mono ? 'ui-monospace, monospace' : 'inherit', textAlign: 'right' }}>{row.value}</span>
          </div>
        ))}
      </div>

      {onContactSupport && (
        <button
          onClick={onContactSupport}
          style={{ width: '100%', padding: '14px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '14px', color: '#C4C9E0', fontSize: '14px', fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
        >
          <MessageSquare size={16} /> Contact Support
        </button>
      )}
    </div>
  );
}

function CACVerificationScreen({ currentUser, onBack, onContactSupport }: { currentUser: any; onBack: () => void; onContactSupport?: () => void }) {
  const [status, setStatus] = useState<'loading' | 'form' | 'pending' | 'rejected'>('loading');
  const [verification, setVerification] = useState<VerificationRow | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);

  const [companyName, setCompanyName] = useState('');
  const [cacNumber, setCacNumber] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [registrationDate, setRegistrationDate] = useState('');
  const [businessEmail, setBusinessEmail] = useState('');
  const [businessPhone, setBusinessPhone] = useState('');
  const [phoneCountryCode, setPhoneCountryCode] = useState<string>(REGION.phoneCountryCode);
  const [businessAddress, setBusinessAddress] = useState(currentUser?.state ? `${currentUser.state}, Nigeria` : '');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Guards against setState after unmount (the success overlay's timer, or a
  // slow upload/RPC that resolves after the user has navigated away) — no
  // memory leaks / "setState on unmounted component" warnings (Task 9).
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const todayStr = new Date().toISOString().slice(0, 10);

  // Validate the chosen certificate immediately on selection (Task 8), before
  // it's ever uploaded, so a wrong type/oversize file is caught up front.
  const handleFileSelect = useCallback((f: File | null) => {
    setError('');
    if (!f) { setFile(null); return; }
    const problem = validateCacFile(f);
    if (problem) { setError(problem); setFile(null); return; }
    setFile(f);
  }, []);

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

  const loadLatest = useCallback(async () => {
    if (!currentUser?.id) return;
    try {
      await getAuthToken();
      const { data } = await insforge.database.rpc('my_latest_organizer_verification' as any);
      const row = Array.isArray(data) ? data[0] : data;
      if (row?.status === 'pending' || row?.status === 'rejected') {
        setVerification(row as VerificationRow);
        setStatus(row.status);
        return;
      }
      setStatus('form');
    } catch {
      setStatus('form');
    }
  }, [currentUser?.id]);

  useEffect(() => { loadLatest(); }, [loadLatest]);

  const handleSubmit = async () => {
    setError('');
    // 1. Validate every field before touching the network.
    if (!companyName.trim()) { setError('Business name is required.'); return; }
    if (!cacNumber.trim()) { setError('CAC registration number is required.'); return; }
    if (!businessAddress.trim()) { setError('Business address is required.'); return; }
    if (!ownerName.trim()) { setError('Owner name is required.'); return; }
    if (!registrationDate) { setError('Registration date is required.'); return; }
    if (registrationDate > todayStr) { setError('Registration date cannot be in the future.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(businessEmail.trim())) { setError('A valid business email is required.'); return; }
    if (businessPhone.replace(/\D/g, '').length < 6) { setError('A valid business phone number is required.'); return; }
    if (!file) { setError('Please upload your Certificate of Incorporation.'); return; }

    setSubmitting(true);
    try {
      const token = await getAuthToken();

      // 2. Upload the certificate (real progress shown throughout) → get
      // back its secure storage URL. Upload failures are never shown raw.
      setUploading(true);
      setUploadProgress(0);
      let documentUrl: string;
      try {
        documentUrl = await withTimeoutFallback(
          uploadVerificationCertificate(file, token, setUploadProgress),
          { timeoutMs: 20000, timeoutMessage: 'verification_upload_failed:timeout' }
        );
      } catch (uploadErr) {
        Sentry.captureException(uploadErr, { tags: { feature: 'organizer-verification-upload' }, extra: { userId: currentUser?.id } });
        setError(VERIFICATION_UPLOAD_ERROR);
        return;
      } finally {
        setUploading(false);
      }

      // 3. Save that URL directly into the organizer's verification record
      // (status defaults to 'pending'; the RPC also blocks duplicate
      // pending submissions server-side).
      const { error: rpcError } = await insforge.database.rpc('submit_organizer_verification' as any, {
        p_company_name: companyName.trim(),
        p_cac_number: cacNumber.trim(),
        p_business_address: businessAddress.trim(),
        p_document_url: documentUrl,
        p_owner_name: ownerName.trim(),
        p_registration_date: registrationDate,
        p_business_email: businessEmail.trim(),
        p_business_phone: `${phoneCountryCode}${businessPhone.replace(/\D/g, '')}`,
      });
      if (rpcError) throw rpcError;

      // 4. Success confirmation, then land on the Pending status page.
      if (!mountedRef.current) return;
      setShowSuccess(true);
      await loadLatest();
      setTimeout(() => { if (mountedRef.current) setShowSuccess(false); }, 1800);
    } catch (err: any) {
      const msg = err?.message || '';
      Sentry.captureException(err, { tags: { feature: 'organizer-verification-submit' }, extra: { userId: currentUser?.id } });
      setError(KNOWN_VERIFICATION_RPC_ERRORS.has(msg) ? msg : VERIFICATION_SUBMIT_ERROR);
    } finally {
      setSubmitting(false);
    }
  };

  // Plain JSX (not a nested component function) — this is the actual fix for
  // the keyboard-dismiss-on-every-keystroke bug. The previous implementation
  // declared `function CACForm() { ... }` INSIDE this component's body and
  // rendered it as `<CACForm />`. Every keystroke updates state here, which
  // re-renders CACVerificationScreen, which re-creates a BRAND NEW CACForm
  // function value each time — React treats a new function/component
  // reference as a different component type, so the reconciler unmounted and
  // remounted the entire input subtree (and its DOM nodes) on every single
  // keystroke, which is exactly what drops focus and dismisses the mobile
  // keyboard. Inlined `<input>`/`<textarea>` elements are plain DOM tags, not
  // components — their "type" is the stable string 'input'/'textarea', so
  // React patches attributes in place across renders instead of remounting.
  const form = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: status === 'form' ? '8px' : 0 }}>
      <p style={{ color: '#8B8FA8', fontSize: '13px', lineHeight: 1.5, margin: 0 }}>
        Verify your organization with Vents to unlock a verified badge on your organizer profile — helping attendees trust your events.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <label style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 600 }}>Business Legal Registered Name</label>
        <input value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="e.g. Vents Events Ltd" style={inputStyle} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <label style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 600 }}>CAC Registration Number</label>
        <input value={cacNumber} onChange={e => setCacNumber(e.target.value)} placeholder="e.g. RC1234567" style={inputStyle} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <label style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 600 }}>Owner / Director Full Name</label>
        <input value={ownerName} onChange={e => setOwnerName(e.target.value)} placeholder="e.g. Jane Doe" style={inputStyle} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <label style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 600 }}>CAC Registration Date</label>
        <input
          type="date" value={registrationDate} max={todayStr}
          onChange={e => setRegistrationDate(e.target.value)}
          style={{ ...inputStyle, colorScheme: 'dark' }}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <label style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 600 }}>Business Email</label>
        <input type="email" value={businessEmail} onChange={e => setBusinessEmail(e.target.value)} placeholder="business@yourcompany.com" style={inputStyle} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <label style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 600 }}>Business Phone</label>
        <PhoneInput countryCode={phoneCountryCode} onCountryCodeChange={setPhoneCountryCode} value={businessPhone} onChange={setBusinessPhone} placeholder="801 234 5678" height={45} />
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
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"
          onChange={e => handleFileSelect(e.target.files?.[0] || null)}
          style={{ display: 'none' }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading || submitting}
          style={{ width: '100%', background: 'rgba(255,255,255,0.07)', border: '1px dashed rgba(255,255,255,0.2)', borderRadius: '12px', padding: '16px', color: file ? '#10B981' : '#8B8FA8', fontSize: '13px', cursor: (uploading || submitting) ? 'not-allowed' : 'pointer', textAlign: 'center' }}
        >
          {file ? `✓ ${file.name}` : 'Tap to upload document (image or PDF)'}
        </button>

        {uploading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '2px' }}>
            <div style={{ width: '100%', height: '6px', borderRadius: '3px', background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${uploadProgress}%`, height: '100%', borderRadius: '3px',
                  background: 'linear-gradient(90deg,#7B2FBE,#4F46E5)',
                  transition: 'width 0.2s ease',
                }}
              />
            </div>
            <span style={{ color: '#8B8FA8', fontSize: '11px' }}>Uploading certificate… {uploadProgress}%</span>
          </div>
        )}
      </div>

      {error && <p style={{ color: '#EF4444', fontSize: '12px', margin: 0 }}>{error}</p>}

      <button
        onClick={handleSubmit}
        disabled={submitting}
        style={{ marginTop: '4px', width: '100%', height: '48px', borderRadius: '14px', background: 'linear-gradient(135deg,#7B2FBE,#4F46E5)', border: 'none', color: '#fff', fontSize: '15px', fontWeight: 700, cursor: submitting ? 'wait' : 'pointer', opacity: submitting ? 0.7 : 1 }}
      >
        {uploading ? `Uploading… ${uploadProgress}%` : submitting ? 'Submitting…' : 'Submit for Verification'}
      </button>
    </div>
  );

  return (
    <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <style>{`@keyframes vfFadeIn { from { opacity: 0; } to { opacity: 1; } }`}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px' }}>
        <button onClick={onBack} style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={16} color="#C4C9E0" />
        </button>
        <h1 style={{ color: '#FFFFFF', fontSize: '20px', fontWeight: 700 }}>Get Verified</h1>
      </div>

      {showSuccess && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(2,0,5,0.94)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', zIndex: 10, animation: 'vfFadeIn .25s ease' }}>
          <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: 'rgba(16,185,129,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <CheckCircle size={36} color="#10B981" />
          </div>
          <p style={{ color: '#F0F0FF', fontSize: '17px', fontWeight: 800, margin: 0 }}>Request Submitted!</p>
          <p style={{ color: '#8B8FA8', fontSize: '13px', margin: 0 }}>Your certificate is now under review.</p>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 16px 40px' }}>
        {status === 'loading' && (
          <p style={{ color: '#8B8FA8', fontSize: '13px', textAlign: 'center', marginTop: '40px' }}>Loading…</p>
        )}

        {status === 'pending' && verification && (
          <VerificationPendingCard v={verification} onContactSupport={onContactSupport} />
        )}

        {status === 'rejected' && (
          <div style={{ marginTop: '8px' }}>
            <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '16px', padding: '16px', marginBottom: '20px' }}>
              <p style={{ color: '#EF4444', fontSize: '13px', fontWeight: 700, margin: '0 0 6px' }}>Previous request not approved</p>
              {verification?.admin_note && <p style={{ color: '#C4C9E0', fontSize: '13px', margin: 0, lineHeight: 1.5 }}>{verification.admin_note}</p>}
            </div>
            <p style={{ color: '#8B8FA8', fontSize: '13px', marginBottom: '16px' }}>You can submit a new request below.</p>
            {form}
          </div>
        )}

        {status === 'form' && form}
      </div>
    </div>
  );
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
  // Raw national-number digits only — country dial code tracked separately.
  const [phone, setPhone] = useState('');
  const [phoneCountryCode, setPhoneCountryCode] = useState<string>(REGION.phoneCountryCode);
  const [stateValue, setStateValue] = useState('');
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
          {
            const storedPhone: string = data.phone_number || '';
            const matchedCountry = COUNTRY_CODES.find((c) => storedPhone.startsWith(c.code));
            if (matchedCountry) {
              setPhoneCountryCode(matchedCountry.code);
              setPhone(storedPhone.slice(matchedCountry.code.length));
            } else {
              setPhone(storedPhone.replace(/\D/g, ''));
            }
          }
          setStateValue(data.state || '');
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

  const closeCropper = useCallback(() => {
    setCropImageSrc((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  const closeCoverCropper = useCallback(() => {
    setCoverCropSrc((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  const handleUploadPhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentUser?.id) return;
    setErrorMessage(null);
    setCropImageSrc(URL.createObjectURL(file));
  };

  const handleCropComplete = async (croppedBlob: Blob) => {
    if (!currentUser?.id) return;
    closeCropper();
    setSaving(true);
    setErrorMessage(null);
    try {
      const token = await getAuthToken();
      const { blob: compressed, mimeType, extension } = await compressImage(croppedBlob);
      const croppedFile = new File([compressed], `avatar.${extension}`, { type: mimeType });
      const formData = new FormData();
      formData.append('file', croppedFile);
      // Failsafe: a hung upload must never leave the profile photo picker stuck.
      const res = await withTimeoutFallback(
        fetch(
          `${import.meta.env.VITE_INSFORGE_URL}/api/storage/buckets/avatars/objects`,
          { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData }
        ),
        { timeoutMs: 8000, timeoutMessage: 'Photo upload is taking too long. Please check your connection and try again.' }
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
    setCoverCropSrc(URL.createObjectURL(file));
    if (coverInputRef.current) coverInputRef.current.value = '';
  };

  const handleCoverCropComplete = async (croppedBlob: Blob) => {
    if (!currentUser?.id) return;
    closeCoverCropper();
    setSaving(true);
    setErrorMessage(null);
    try {
      const token = await getAuthToken();
      const { blob: compressedCover, mimeType, extension } = await compressImage(croppedBlob);
      const croppedFile = new File([compressedCover], `cover.${extension}`, { type: mimeType });
      const formData = new FormData();
      formData.append('file', croppedFile);
      // Failsafe: a hung upload must never leave the cover photo picker stuck.
      const res = await withTimeoutFallback(
        fetch(
          `${import.meta.env.VITE_INSFORGE_URL}/api/storage/buckets/avatars/objects`,
          { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData }
        ),
        { timeoutMs: 8000, timeoutMessage: 'Cover photo upload is taking too long. Please check your connection and try again.' }
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

      const rawDigits = phone.replace(/\D/g, '').replace(/^0+/, '');
      let cleanPhone = '';
      if (rawDigits) {
        cleanPhone = phoneCountryCode + rawDigits;
        if (phoneCountryCode === REGION.phoneCountryCode && !REGION.phoneRegex.test(cleanPhone)) {
          throw new Error("Please enter a valid Nigerian phone number (+234 format).");
        }
      }

      const { error } = await insforge.database
        .from('users')
        .update({
          full_name: sanitize(name),
          username: sanitize(username).toLowerCase(),
          bio: sanitize(bio),
          phone_number: cleanPhone,
          state: stateValue || null,
        })
        .eq('id', currentUser.id);

      if (error) throw error;
      if (onProfileUpdated) {
        onProfileUpdated({
          full_name: sanitize(name),
          username: sanitize(username).toLowerCase(),
          bio: sanitize(bio),
          phone_number: cleanPhone,
          state: stateValue || undefined,
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
                <PhoneInput
                  countryCode={phoneCountryCode}
                  onCountryCodeChange={setPhoneCountryCode}
                  value={phone}
                  onChange={setPhone}
                />
                {phone.trim() && phoneCountryCode === REGION.phoneCountryCode && !REGION.phoneRegex.test(phoneCountryCode + phone.replace(/^0+/, '')) && (
                  <p style={{ color: '#EF4444', fontSize: '11px', marginTop: '4px' }}>
                    Enter a valid Nigerian number (e.g. 0801 234 5678)
                  </p>
                )}
              </div>
              <div>
                <p style={{ color: '#8B8FA8', fontSize: '12px', marginBottom: '6px', fontWeight: 500 }}>State / Location</p>
                <select
                  value={stateValue}
                  onChange={(e) => setStateValue(e.target.value)}
                  style={{ ...inputStyle, cursor: 'pointer', appearance: 'none' as const }}
                >
                  <option value="">Select your state</option>
                  {NIGERIA_STATES.map((st) => (
                    <option key={st.name} value={st.name}>{st.name}</option>
                  ))}
                </select>
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
          onClose={closeCropper}
        />
      )}

      {coverCropSrc && (
        <ImageCropperModal
          imageSrc={coverCropSrc}
          onCropComplete={handleCoverCropComplete}
          onClose={closeCoverCropper}
          aspect={16 / 9}
          cropShape="rect"
          title="Crop Cover Photo"
        />
      )}
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
const pwInputStyle: React.CSSProperties = {
  width: '100%', background: '#090514', border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '12px', padding: '12px 44px 12px 14px', color: '#F0F0FF', fontSize: '14px',
  outline: 'none', boxSizing: 'border-box',
};
const pwLabelStyle: React.CSSProperties = { color: '#8B8FA8', fontSize: '12px', fontWeight: 600, letterSpacing: '0.05em' };

// A masked password input with its OWN independent Show/Hide eye toggle.
// Masked (type="password") by default; the eye cross-fades smoothly on toggle.
function PasswordField({
  label, value, onChange, placeholder, show, onToggleShow, autoComplete, enterKeyHint, invalid,
}: {
  label: string; value: string; onChange: (v: string) => void; placeholder: string;
  show: boolean; onToggleShow: () => void; autoComplete: string;
  enterKeyHint?: 'next' | 'done'; invalid?: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <label style={pwLabelStyle}>{label}</label>
      <div style={{ position: 'relative' }}>
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          required
          autoComplete={autoComplete}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint={enterKeyHint}
          style={{ ...pwInputStyle, border: `1px solid ${invalid ? 'rgba(239,68,68,0.45)' : 'rgba(255,255,255,0.08)'}` }}
        />
        <button
          type="button"
          onClick={onToggleShow}
          aria-label={show ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          tabIndex={-1}
          style={{
            position: 'absolute', right: '6px', top: '50%', transform: 'translateY(-50%)',
            width: '34px', height: '34px', display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: '#8B8FA8',
          }}
        >
          <span
            key={show ? 'on' : 'off'}
            style={{ display: 'inline-flex', animation: 'pwEyeFade .18s ease' }}
          >
            {show ? <EyeOff size={17} /> : <Eye size={17} />}
          </span>
        </button>
      </div>
    </div>
  );
}

function ChangePasswordScreen({ currentUser, onBack }: { currentUser: { email: string } | null; onBack: () => void }) {
  const [step, setStep] = useState<'verify' | 'otp'>('verify');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showOld, setShowOld] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // ── Live password-strength rules ──────────────────────────────────
  const rules = [
    { key: 'len', label: 'At least 8 characters', met: newPassword.length >= 8 },
    { key: 'upper', label: 'One uppercase letter', met: /[A-Z]/.test(newPassword) },
    { key: 'number', label: 'One number', met: /\d/.test(newPassword) },
    { key: 'symbol', label: 'One symbol', met: /[^A-Za-z0-9]/.test(newPassword) },
  ];
  const metCount = rules.filter(r => r.met).length;
  const allRulesMet = metCount === rules.length;
  const passwordsMatch = confirmPassword.length > 0 && newPassword === confirmPassword;
  const differsFromOld = newPassword.length > 0 && newPassword !== oldPassword;
  // Continue stays STRICTLY disabled until every requirement passes.
  const canSubmit = !!oldPassword && allRulesMet && passwordsMatch && differsFromOld && !loading;

  const strengthColor = metCount <= 1 ? '#EF4444' : metCount === 2 ? '#F59E0B' : metCount === 3 ? '#FBBF24' : '#10B981';
  const strengthLabel = metCount <= 1 ? 'Weak' : metCount === 2 ? 'Fair' : metCount === 3 ? 'Good' : 'Strong';

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!currentUser?.email) { setError('No email on account.'); return; }
    if (!differsFromOld) { setError('New password must differ from the current password.'); return; }
    if (!allRulesMet) { setError('New password does not meet the strength requirements.'); return; }
    if (!passwordsMatch) { setError('New passwords do not match.'); return; }
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

  // Keyboard-safe scroll region: the form scrolls independently and carries a
  // tall bottom pad so the on-screen keyboard (iOS/Android WebView) can never
  // overlap the focused field or the Continue button.
  const scrollFormStyle: React.CSSProperties = {
    flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch',
    padding: '8px 16px calc(120px + env(safe-area-inset-bottom))',
    display: 'flex', flexDirection: 'column', gap: '16px',
  };

  return (
    <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <style>{`@keyframes pwEyeFade { from { opacity: 0; transform: scale(.8); } to { opacity: 1; transform: scale(1); } }`}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px', flexShrink: 0 }}>
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
        <form onSubmit={handleVerify} style={scrollFormStyle}>
          {error && (
            <div style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '10px', padding: '10px 14px' }}>
              <p style={{ color: '#F87171', fontSize: '13px', margin: 0 }}>{error}</p>
            </div>
          )}

          <PasswordField
            label="CURRENT PASSWORD" value={oldPassword} onChange={setOldPassword}
            placeholder="Enter current password" show={showOld} onToggleShow={() => setShowOld(v => !v)}
            autoComplete="current-password" enterKeyHint="next"
          />

          <PasswordField
            label="NEW PASSWORD" value={newPassword} onChange={setNewPassword}
            placeholder="Create a strong password" show={showNew} onToggleShow={() => setShowNew(v => !v)}
            autoComplete="new-password" enterKeyHint="next"
          />

          {/* Live strength meter + requirement checklist */}
          {newPassword.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '-6px' }}>
              <div style={{ display: 'flex', gap: '6px' }}>
                {rules.map((_, i) => (
                  <div key={i} style={{ flex: 1, height: '4px', borderRadius: '2px', background: i < metCount ? strengthColor : 'rgba(255,255,255,0.1)', transition: 'background .3s ease' }} />
                ))}
              </div>
              <span style={{ fontSize: '11px', fontWeight: 600, color: strengthColor }}>Strength: {strengthLabel}</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '2px' }}>
                {rules.map(r => (
                  <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {r.met ? <Check size={12} color="#10B981" /> : <X size={12} color="#8B8FA8" />}
                    <span style={{ fontSize: '11px', color: r.met ? '#10B981' : '#8B8FA8', transition: 'color .2s ease' }}>{r.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <PasswordField
            label="CONFIRM NEW PASSWORD" value={confirmPassword} onChange={setConfirmPassword}
            placeholder="Repeat new password" show={showConfirm} onToggleShow={() => setShowConfirm(v => !v)}
            autoComplete="new-password" enterKeyHint="done"
            invalid={confirmPassword.length > 0 && !passwordsMatch}
          />
          {confirmPassword.length > 0 && !passwordsMatch && (
            <p style={{ color: '#F87171', fontSize: '11px', margin: '-8px 0 0', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <X size={12} /> Passwords don't match
            </p>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            style={{
              marginTop: '8px', padding: '14px',
              background: canSubmit ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)' : '#2D2D4E',
              border: 'none', borderRadius: '12px',
              color: canSubmit ? '#fff' : '#6B6F8A', fontSize: '14px', fontWeight: 700,
              cursor: canSubmit ? 'pointer' : 'not-allowed', opacity: canSubmit ? 1 : 0.85,
              transition: 'background .2s ease, opacity .2s ease',
            }}
          >
            {loading ? 'Verifying…' : 'Continue'}
          </button>
        </form>
      ) : (
        <form onSubmit={handleOtp} style={scrollFormStyle}>
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
            <input type="text" value={otp} onChange={e => setOtp(e.target.value)} placeholder="Enter code from email" required inputMode="numeric" autoComplete="one-time-code" enterKeyHint="done" style={{ ...inputStyle, letterSpacing: '0.1em', fontSize: '16px' }} />
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
  if (subScreen === 'help') return <HelpCenterScreen onBack={() => setSubScreen(null)} />;
  if (subScreen === 'change-password') return <ChangePasswordScreen currentUser={currentUser} onBack={() => setSubScreen(null)} />;
  if (subScreen === 'delete-account') return <DeleteAccountScreen currentUser={currentUser} onBack={() => setSubScreen(null)} onDeleted={onSignOut} />;
  if (subScreen === 'cac-verify') return <CACVerificationScreen currentUser={currentUser} onBack={() => setSubScreen(null)} onContactSupport={() => setSubScreen('help')} />;

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
          {/* "Profile Details" row removed — it duplicated the Edit button on the
              Profile Card above (both open the same editor). */}
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
          <SettingRow icon={MessageCircle} label="Contact Support" onPress={() => window.open('mailto:support@getvents.com')} />
          <Divider />
          <SocialRow icon={SiInstagram} label="Follow on Instagram" background="linear-gradient(45deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888)" onPress={() => window.open('https://instagram.com/TheVentsApp', '_blank')} />
          <Divider />
          <SocialRow icon={SiX} label="Follow on X" background="#000" onPress={() => window.open('https://twitter.com/TheVentsApp', '_blank')} />
          <Divider />
          <SocialRow icon={SiTiktok} label="Follow on TikTok" background="#000" onPress={() => window.open('https://www.tiktok.com/@theventsapp', '_blank')} />
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
                <li>Delete reviews you have written and messages you have sent</li>
                <li>Cancel any pending ticket reservations</li>
                <li>Block future sign-up with this email address</li>
              </ul>
            </div>
            <div style={{ background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.15)', borderRadius: '16px', padding: '16px', marginBottom: '24px' }}>
              <p style={{ color: '#10B981', fontSize: '13px', fontWeight: 600, marginBottom: '6px' }}>What is kept:</p>
              <ul style={{ color: '#C4C9E0', fontSize: '13px', lineHeight: 1.8, paddingLeft: '20px' }}>
                <li>Ticket purchase history (required by Nigerian law for 7 years)</li>
                <li>Organizer wallet balance and transaction history, if any — for financial record-keeping. Contact support to withdraw a remaining balance first.</li>
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
