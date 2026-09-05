import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronLeft, Clock, Upload, MessageSquare } from 'lucide-react';
import { Sentry } from '../../lib/sentry';
import { supabase } from '../../lib/supabase';
import { COUNTRY_CODES, DEFAULT_COUNTRY } from '../../lib/countries';
import { withTimeoutFallback } from '../../lib/withTimeoutFallback';

// KYC submission screen for the Service Provider capability, mirroring
// SettingsScreen.tsx's CACVerificationScreen (Organizer verification) --
// same country/type-aware requirements, same verification-docs storage
// bucket, same "submit -> pending -> admin decision" shape. Deliberately a
// separate component (not shared code) so Organizer verification stays
// completely untouched, per the release constraint.
//
// IMPORTANT: NIN/CAC here are validated for FORMAT/PRESENCE only, exactly
// like the Organizer flow -- neither this screen nor
// submit_service_provider_verification() calls out to a real identity- or
// business-registry verification vendor. The actual accept/reject decision
// is made by a human admin reviewing the uploaded document. See the
// project's release notes for the integration point a real KYC vendor
// (e.g. an NIN-verification API or a CAC lookup service) would plug into.

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_MIME = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/i;
const ACCEPTED_EXT = /\.(jpe?g|png|webp|heic|heif|pdf)$/i;

function validateDocFile(file: File): string | null {
  const typeOk = ACCEPTED_MIME.test(file.type) || (!file.type && ACCEPTED_EXT.test(file.name));
  if (!typeOk) return 'Please upload an image (JPG/PNG) or a PDF document.';
  if (file.size > MAX_FILE_BYTES) return 'File is too large. Please upload a document under 10MB.';
  if (file.size === 0) return 'That file appears to be empty. Please choose another.';
  return null;
}

function uploadVerificationDoc(file: File, token: string, onProgress: (pct: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const key = `${crypto.randomUUID()}-${file.name}`;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/verification-docs/${encodeURIComponent(key)}`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('apikey', import.meta.env.VITE_SUPABASE_ANON_KEY);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(`verification-docs/${key}`);
      else reject(new Error(`verification_upload_failed:${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('verification_upload_failed:network'));
    xhr.send(file);
  });
}

const SUBMIT_ERROR = "We couldn't submit your application. Please try again or contact support if the issue continues.";
const KNOWN_RPC_ERRORS = new Set([
  'Business name is required', 'CAC number is required', 'Your name is required',
  'A verification document is required', 'You already have a pending request', 'Not authenticated',
  "provider_type must be 'individual' or 'business'", 'A valid country is required',
  'A valid NIN is required', 'NIN must be 11 digits', 'Unsupported identity document type for Nigeria',
]);

interface SpVerificationRow {
  request_id: string; status: 'pending' | 'approved' | 'rejected'; admin_note: string | null;
  created_at: string; reviewed_at: string | null;
  provider_type: 'individual' | 'business'; country: string;
  owner_name: string; business_name: string | null; cac_number: string | null;
  identity_id_type: string | null; identity_id_number: string | null;
  document_url: string; reason: string | null;
}

function PendingCard({ v, onContactSupport }: { v: SpVerificationRow; onContactSupport?: () => void }) {
  const refId = `SPV-${v.request_id.slice(0, 8).toUpperCase()}`;
  const submittedDate = new Date(v.created_at).toLocaleDateString('en-NG', { dateStyle: 'medium' });
  const rows = [
    v.provider_type === 'individual' ? { label: 'Name', value: v.owner_name } : { label: 'Business Name', value: v.business_name || v.owner_name },
    { label: 'Submission Date', value: submittedDate },
    { label: 'Status', value: 'Pending Review', color: '#F59E0B' },
    { label: 'Estimated Review Time', value: '1–3 business days' },
    { label: 'Reference ID', value: refId, mono: true },
  ];
  return (
    <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', padding: '28px 20px 22px', background: 'linear-gradient(180deg, rgba(34,211,238,0.14), rgba(9,5,20,0))', borderRadius: '20px', border: '1px solid rgba(34,211,238,0.2)' }}>
        <div style={{ width: '56px', height: '56px', borderRadius: '50%', background: 'rgba(245,158,11,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Clock size={28} color="#F59E0B" />
        </div>
        <p style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 800, margin: 0, fontFamily: 'Space Grotesk, sans-serif' }}>Application Pending</p>
        <p style={{ color: '#8B8FA8', fontSize: '13px', margin: 0, lineHeight: 1.5, maxWidth: '280px' }}>
          Your Service Provider application is under review. We'll notify you once a decision is made.
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
        <button onClick={onContactSupport} style={{ width: '100%', padding: '14px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '14px', color: '#C4C9E0', fontSize: '14px', fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
          <MessageSquare size={16} /> Contact Support
        </button>
      )}
    </div>
  );
}

export function ServiceProviderVerificationScreen({ currentUser, onBack, onApprovedSetup }: { currentUser: { id: string; country?: string } | null; onBack: () => void; onApprovedSetup?: () => void }) {
  const [status, setStatus] = useState<'loading' | 'form' | 'pending' | 'rejected'>('loading');
  const [verification, setVerification] = useState<SpVerificationRow | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);

  const [providerType, setProviderType] = useState<'individual' | 'business'>('individual');
  const [country, setCountry] = useState<string>(currentUser?.country || DEFAULT_COUNTRY.iso);
  const [ownerName, setOwnerName] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [cacNumber, setCacNumber] = useState('');
  const [nin, setNin] = useState('');
  const [reason, setReason] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const isNigeriaIndividual = providerType === 'individual' && country === 'NG';
  const requiresCac = providerType === 'business' && country === 'NG';

  const inputStyle: React.CSSProperties = {
    width: '100%', background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px',
    padding: '12px 14px', color: '#F0F0FF', fontSize: '14px', outline: 'none', fontFamily: 'Inter, sans-serif', boxSizing: 'border-box',
  };

  const handleFileSelect = useCallback((f: File | null) => {
    setError('');
    if (!f) { setFile(null); return; }
    const problem = validateDocFile(f);
    if (problem) { setError(problem); setFile(null); return; }
    setFile(f);
  }, []);

  const loadLatest = useCallback(async () => {
    if (!currentUser?.id) return;
    try {
      const { data } = await supabase.rpc('my_latest_service_provider_verification' as any);
      const row = Array.isArray(data) ? data[0] : data;
      if (row?.status === 'pending' || row?.status === 'rejected') {
        setVerification(row as SpVerificationRow);
        setStatus(row.status);
        if (row.status === 'approved' && onApprovedSetup) onApprovedSetup();
        return;
      }
      setStatus('form');
    } catch {
      setStatus('form');
    }
  }, [currentUser?.id, onApprovedSetup]);

  useEffect(() => { loadLatest(); }, [loadLatest]);

  const handleSubmit = async () => {
    setError('');
    if (!ownerName.trim()) { setError('Your name is required.'); return; }
    if (!file) { setError('Please upload your verification document.'); return; }
    if (providerType === 'business') {
      if (!businessName.trim()) { setError('Business name is required.'); return; }
      if (requiresCac && !cacNumber.trim()) { setError('CAC registration number is required.'); return; }
    } else if (isNigeriaIndividual) {
      if (!/^\d{11}$/.test(nin.trim())) { setError('A valid 11-digit NIN is required.'); return; }
    }

    setSubmitting(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error('Session expired. Please sign out and back in.');

      setUploading(true);
      setUploadProgress(0);
      let documentUrl: string;
      try {
        documentUrl = await withTimeoutFallback(
          uploadVerificationDoc(file, token, setUploadProgress),
          { timeoutMs: 20000, timeoutMessage: 'verification_upload_failed:timeout' }
        );
      } catch (uploadErr) {
        Sentry.captureException(uploadErr, { tags: { feature: 'service-provider-verification-upload' }, extra: { userId: currentUser?.id } });
        setError("We couldn't upload your document. Please try again or contact support if the issue continues.");
        return;
      } finally {
        setUploading(false);
      }

      const { error: rpcError } = await supabase.rpc('submit_service_provider_verification' as any, {
        p_provider_type: providerType,
        p_country: country,
        p_owner_name: ownerName.trim(),
        p_document_url: documentUrl,
        p_reason: reason.trim() || undefined,
        p_business_name: providerType === 'business' ? businessName.trim() : undefined,
        p_cac_number: providerType === 'business' ? cacNumber.trim() : undefined,
        p_identity_id_type: isNigeriaIndividual ? 'NIN' : undefined,
        p_identity_id_number: isNigeriaIndividual ? nin.trim() : undefined,
      });
      if (rpcError) throw rpcError;

      if (!mountedRef.current) return;
      setShowSuccess(true);
      await loadLatest();
      setTimeout(() => { if (mountedRef.current) setShowSuccess(false); }, 1800);
    } catch (err: any) {
      const msg = err?.message || '';
      Sentry.captureException(err, { tags: { feature: 'service-provider-verification-submit' }, extra: { userId: currentUser?.id } });
      setError(KNOWN_RPC_ERRORS.has(msg) ? msg : SUBMIT_ERROR);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(16px + env(safe-area-inset-top)) 16px 12px' }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex' }}>
          <ChevronLeft size={22} color="#F0F0FF" />
        </button>
        <h1 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', margin: 0 }}>
          Become a Service Provider
        </h1>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 32px' }}>
        {status === 'loading' && <p style={{ color: '#8B8FA8', textAlign: 'center', marginTop: '40px' }}>Loading...</p>}

        {status === 'pending' && verification && <PendingCard v={verification} />}

        {status === 'rejected' && verification && (
          <div style={{ marginTop: '12px' }}>
            <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '14px', padding: '14px', marginBottom: '16px' }}>
              <p style={{ color: '#EF4444', fontSize: '13px', fontWeight: 700, margin: '0 0 4px' }}>Application not approved</p>
              {verification.admin_note && <p style={{ color: '#8B8FA8', fontSize: '12px', margin: 0 }}>{verification.admin_note}</p>}
            </div>
            <button onClick={() => setStatus('form')} style={{ width: '100%', height: '48px', borderRadius: '14px', background: 'linear-gradient(135deg,#0891B2,#22D3EE)', border: 'none', color: '#fff', fontSize: '15px', fontWeight: 700, cursor: 'pointer' }}>
              Apply Again
            </button>
          </div>
        )}

        {status === 'form' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '8px' }}>
            <p style={{ color: '#8B8FA8', fontSize: '13px', margin: 0, lineHeight: 1.5 }}>
              Tell us about yourself and upload an identity/business document. Our team reviews every application within 1–3 business days.
            </p>

            <div style={{ display: 'flex', gap: '8px' }}>
              {(['individual', 'business'] as const).map((t) => (
                <button key={t} onClick={() => setProviderType(t)} style={{ flex: 1, height: '40px', borderRadius: '10px', border: `1px solid ${providerType === t ? '#22D3EE' : 'rgba(255,255,255,0.08)'}`, background: providerType === t ? 'rgba(34,211,238,0.12)' : '#090514', color: providerType === t ? '#22D3EE' : '#8B8FA8', fontSize: '13px', fontWeight: 700, cursor: 'pointer', textTransform: 'capitalize' }}>
                  {t}
                </button>
              ))}
            </div>

            <select value={country} onChange={(e) => setCountry(e.target.value)} style={inputStyle}>
              {COUNTRY_CODES.map((c) => <option key={c.iso} value={c.iso}>{c.name}</option>)}
            </select>

            <input type="text" placeholder="Your full name" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} style={inputStyle} />

            {providerType === 'business' && (
              <>
                <input type="text" placeholder="Business name" value={businessName} onChange={(e) => setBusinessName(e.target.value)} style={inputStyle} />
                {country === 'NG' && (
                  <input type="text" placeholder="CAC registration number" value={cacNumber} onChange={(e) => setCacNumber(e.target.value)} style={inputStyle} />
                )}
              </>
            )}

            {isNigeriaIndividual && (
              <input type="text" inputMode="numeric" placeholder="NIN (11 digits)" value={nin} onChange={(e) => setNin(e.target.value.replace(/\D/g, '').slice(0, 11))} style={inputStyle} />
            )}

            <textarea placeholder="What services will you offer? (optional)" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} style={{ ...inputStyle, resize: 'none' }} />

            <div>
              <input ref={fileInputRef} type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={(e) => handleFileSelect(e.target.files?.[0] || null)} />
              <button onClick={() => fileInputRef.current?.click()} style={{ width: '100%', height: '52px', borderRadius: '12px', border: '1px dashed rgba(34,211,238,0.35)', background: 'rgba(34,211,238,0.06)', color: '#22D3EE', fontSize: '13px', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                <Upload size={16} /> {file ? file.name : 'Upload identity/business document'}
              </button>
              {uploading && <p style={{ color: '#8B8FA8', fontSize: '12px', marginTop: '6px' }}>Uploading... {uploadProgress}%</p>}
            </div>

            {error && <p style={{ color: '#EF4444', fontSize: '12px', margin: 0 }}>{error}</p>}

            <button onClick={handleSubmit} disabled={submitting} style={{ height: '50px', borderRadius: '14px', background: 'linear-gradient(135deg,#0891B2,#22D3EE)', border: 'none', color: '#fff', fontSize: '15px', fontWeight: 700, cursor: submitting ? 'wait' : 'pointer', opacity: submitting ? 0.7 : 1 }}>
              {submitting ? 'Submitting...' : 'Submit Application'}
            </button>
          </div>
        )}

        {showSuccess && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <p style={{ color: '#22D3EE', fontSize: '16px', fontWeight: 700 }}>Application submitted ✓</p>
          </div>
        )}
      </div>
    </div>
  );
}
