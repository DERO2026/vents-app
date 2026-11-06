import { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { ventsColors } from '../../../lib/ventsDesignTokens';
import type { RequestStatus } from '../../../lib/workRoles';

// "Become an Organizer" application sheet, moved here from ProfileScreen
// unchanged so VENTS Work can open it. Always openable (never a dead end):
// idle/rejected shows the form, pending shows a read-only status view.
// Inserting into organizer_requests is the only client step; a Super Admin
// decides it through admin_decide_organizer_request, which is the only
// path that grants organizer capability.
export function OrganizerRequestSheet({ userId, status, adminNote, submittedReason, onClose, onSubmitted }: {
  userId: string;
  status: RequestStatus;
  adminNote: string | null;
  submittedReason: string | null;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [orgRequestStatus, setOrgRequestStatus] = useState<'idle' | 'sending' | 'pending' | 'rejected' | 'approved'>(
    status === 'none' ? 'idle' : status,
  );
  const [orgRequestReason, setOrgRequestReason] = useState(status === 'pending' ? submittedReason ?? '' : '');
  const [orgRequestError, setOrgRequestError] = useState('');

  // Draft persistence: unsent text survives closing the sheet (per-user
  // key). Nothing reaches the database until Submit.
  const orgDraftKey = `vents_org_request_draft_${userId}`;
  useEffect(() => {
    if (status === 'pending') return;
    try {
      const saved = localStorage.getItem(orgDraftKey);
      if (saved) setOrgRequestReason(saved);
    } catch { /* ignore */ }
  }, [orgDraftKey, status]);

  const handleOrgReasonChange = (value: string) => {
    setOrgRequestReason(value);
    try {
      if (value.trim()) localStorage.setItem(orgDraftKey, value);
      else localStorage.removeItem(orgDraftKey);
    } catch { /* ignore */ }
  };

  const submitOrgRequest = async () => {
    if (orgRequestStatus === 'sending') return;
    setOrgRequestStatus('sending');
    setOrgRequestError('');
    try {
      const { error } = await supabase
        .from('organizer_requests')
        .insert([{ user_id: userId, reason: orgRequestReason.trim() || null }]);
      if (error) throw error;
      try { localStorage.removeItem(orgDraftKey); } catch { /* ignore */ }
      setOrgRequestStatus('pending');
      onSubmitted();
    } catch (err: any) {
      // A duplicate-submit race hits organizer_requests_one_pending_per_user:
      // that means "you already have one pending", not a failure.
      if (err?.code === '23505') {
        setOrgRequestStatus('pending');
        onSubmitted();
        return;
      }
      setOrgRequestError(err?.message || 'Failed to submit request.');
      setOrgRequestStatus(status === 'rejected' ? 'rejected' : 'idle');
    }
  };

  return (
    <div data-testid="organizer-request-sheet" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 9999, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
      onClick={onClose}>
      <div role="dialog" aria-modal="true" style={{ background: ventsColors.surface, borderRadius: '24px 24px 0 0', padding: '24px 20px calc(32px + env(safe-area-inset-bottom))', width: '100%', maxWidth: '430px', boxSizing: 'border-box' }}
        onClick={(e) => e.stopPropagation()}>
        {orgRequestStatus === 'pending' ? (
          <>
            <h3 style={{ color: ventsColors.ink1, fontSize: '17px', fontWeight: 700, margin: '0 0 8px' }}>Application Submitted</h3>
            <p style={{ color: ventsColors.ink2, fontSize: '13px', margin: '0 0 16px', lineHeight: 1.5 }}>
              Your organizer request is under review. Our team typically responds within 1–3 business days.
            </p>
            {orgRequestReason && (
              <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', padding: '12px', color: ventsColors.ink1, fontSize: '13px', lineHeight: 1.5 }}>
                {orgRequestReason}
              </div>
            )}
          </>
        ) : (
          <>
            <h3 style={{ color: ventsColors.ink1, fontSize: '17px', fontWeight: 700, margin: '0 0 8px' }}>
              {orgRequestStatus === 'rejected' ? 'Apply Again' : 'Become an Organizer'}
            </h3>
            <p style={{ color: ventsColors.ink2, fontSize: '13px', margin: '0 0 16px', lineHeight: 1.5 }}>
              Tell us briefly why you want to become an organizer. Our team will review your request within 1–3 business days.
            </p>
            {orgRequestStatus === 'rejected' && adminNote && (
              <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '12px', padding: '12px', marginBottom: '12px' }}>
                <p style={{ color: ventsColors.error, fontSize: '12px', fontWeight: 700, margin: '0 0 4px' }}>Your previous application wasn&apos;t approved</p>
                <p style={{ color: ventsColors.ink2, fontSize: '12px', margin: 0 }}>{adminNote}</p>
              </div>
            )}
            <textarea
              value={orgRequestReason}
              onChange={(e) => handleOrgReasonChange(e.target.value)}
              placeholder="e.g. I want to host tech meetups in Lagos..."
              rows={4}
              aria-label="Why do you want to become an organizer?"
              style={{ width: '100%', background: ventsColors.surface, border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '12px', color: ventsColors.ink1, fontSize: '14px', resize: 'none', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' }}
            />
            {orgRequestError && <p style={{ color: ventsColors.error, fontSize: '12px', marginTop: '8px' }}>{orgRequestError}</p>}
            <button
              onClick={submitOrgRequest}
              disabled={orgRequestStatus === 'sending'}
              style={{ marginTop: '16px', width: '100%', height: '48px', borderRadius: '14px', background: ventsColors.accentStrong, border: 'none', color: '#fff', fontSize: '15px', fontWeight: 700, cursor: orgRequestStatus === 'sending' ? 'wait' : 'pointer', opacity: orgRequestStatus === 'sending' ? 0.7 : 1 }}
            >
              {orgRequestStatus === 'sending' ? 'Submitting...' : 'Submit Request'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
