import { useState } from 'react';
import { X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { sanitize } from '../../lib/sanitize';
import { PrimaryButton } from './shared/Button';

const REASONS = ['Spam', 'Inappropriate content', 'Scam/Fraud', 'Fake event', 'Harassment', 'Other'];

interface Props {
  reporterId: string;
  targetType: 'event' | 'user';
  targetId: string;
  targetName?: string;
  onClose: () => void;
}

export function ReportModal({ reporterId, targetType, targetId, targetName, onClose }: Props) {
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!reason) return;
    setSubmitting(true);
    setError(null);
    try {
      const { error: err } = await supabase.from('reports').insert([{
        reporter_id: reporterId,
        target_type: targetType,
        target_id: targetId,
        reason,
        details: details.trim() ? sanitize(details) : null,
      }]);
      if (err) throw err;
      setDone(true);
    } catch (e: any) {
      setError('Failed to submit report. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 1000 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: '390px', background: '#090514', borderRadius: '24px 24px 0 0', padding: '20px 16px 36px', border: '1px solid rgba(255,255,255,0.08)' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <span style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700 }}>
            Report {targetType === 'event' ? 'Event' : 'User'}{targetName ? `: ${targetName}` : ''}
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#8B8FA8', cursor: 'pointer', padding: '4px' }}>
            <X size={18} />
          </button>
        </div>

        {done ? (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <span style={{ fontSize: '36px', display: 'block', marginBottom: '12px' }}>✓</span>
            <p style={{ color: '#10B981', fontSize: '14px', fontWeight: 600 }}>Report submitted</p>
            <p style={{ color: '#8B8FA8', fontSize: '12px', marginTop: '6px' }}>Our team will review it within 48 hours.</p>
            <button onClick={onClose} style={{ marginTop: '16px', background: 'rgba(255,255,255,0.05)', border: 'none', borderRadius: '12px', padding: '10px 24px', color: '#F0F0FF', fontSize: '14px', cursor: 'pointer' }}>
              Close
            </button>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
              {REASONS.map((r) => (
                <button
                  key={r}
                  onClick={() => setReason(r)}
                  style={{ background: reason === r ? 'rgba(168,85,247,0.15)' : 'rgba(255,255,255,0.04)', border: reason === r ? '1px solid rgba(168,85,247,0.4)' : '1px solid rgba(255,255,255,0.06)', borderRadius: '12px', padding: '12px 14px', color: reason === r ? '#A78BFA' : '#C4C9E0', fontSize: '14px', fontWeight: reason === r ? 600 : 400, textAlign: 'left', cursor: 'pointer' }}
                >
                  {r}
                </button>
              ))}
            </div>

            {reason === 'Other' && (
              <textarea
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                placeholder="Please describe the issue..."
                rows={3}
                style={{ width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', padding: '12px', color: '#F0F0FF', fontSize: '13px', resize: 'none', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box', marginBottom: '12px' }}
              />
            )}

            {error && <p style={{ color: '#EF4444', fontSize: '12px', marginBottom: '8px' }}>{error}</p>}

            <PrimaryButton
              onClick={submit}
              disabled={!reason || submitting}
              style={{ opacity: submitting ? 0.7 : 1 }}
            >
              {submitting ? 'Submitting...' : 'Submit Report'}
            </PrimaryButton>
          </>
        )}
      </div>
    </div>
  );
}
