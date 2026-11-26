import { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { ventsColors } from '../../../lib/ventsDesignTokens';
import type { RequestStatus } from '../../../lib/workRoles';

// "Become an Organizer" (VENTS Work / Creator Studio).
//
// Decision D1a (owner, 2026-11-26, docs/repair-tracker.md): selecting the
// Organizer role is sufficient -- there is no separate admin approval before
// publishing events or selling paid tickets. So this is a one-step choice,
// the same as choosing "Organizer" at sign-up: it calls set_signup_role
// ('organizer') (0121), which sets only the caller's own is_organizer flag
// (staff accounts are refused server-side). It never calls
// promote_to_organizer (revoked from clients by 0116) and never touches
// role, verification or any other account field.
//
// Legacy organizer_requests rows (pending/rejected from before D1a) no
// longer block anyone: those users see the same one-step choice. Admins can
// still view old requests in the admin console.
export function OrganizerRequestSheet({ status, onClose, onSubmitted, onOpenCreatorStudio }: {
  userId: string;
  status: RequestStatus;
  // Kept for the existing call site; unused since D1a (no application).
  adminNote?: string | null;
  submittedReason?: string | null;
  onClose: () => void;
  onSubmitted: () => void;
  onOpenCreatorStudio?: () => void;
}) {
  const [state, setState] = useState<'idle' | 'sending' | 'active'>(status === 'approved' ? 'active' : 'idle');
  const [error, setError] = useState('');

  useEffect(() => {
    if (status === 'approved') setState('active');
  }, [status]);

  const becomeOrganizer = async () => {
    if (state === 'sending') return;
    setState('sending');
    setError('');
    const { error: rpcError } = await supabase.rpc('set_signup_role' as any, { p_role: 'organizer' });
    if (rpcError) {
      setError(rpcError.message || 'Could not turn on organizer tools. Please try again.');
      setState('idle');
      return;
    }
    setState('active');
    onSubmitted();
  };

  return (
    <div data-testid="organizer-request-sheet" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 9999, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
      onClick={onClose}>
      <div role="dialog" aria-modal="true" style={{ background: ventsColors.surface, borderRadius: '24px 24px 0 0', padding: '24px 20px calc(32px + env(safe-area-inset-bottom))', width: '100%', maxWidth: '430px', boxSizing: 'border-box' }}
        onClick={(e) => e.stopPropagation()}>
        {state === 'active' ? (
          <>
            <h3 style={{ color: ventsColors.ink1, fontSize: '17px', fontWeight: 700, margin: '0 0 8px' }}>You&apos;re an Organizer</h3>
            <p style={{ color: ventsColors.ink2, fontSize: '13px', margin: '0 0 16px', lineHeight: 1.5 }}>
              Create events and sell tickets in Creator Studio.
            </p>
            {onOpenCreatorStudio && (
              <button
                data-testid="org-sheet-open-studio"
                onClick={onOpenCreatorStudio}
                style={{ width: '100%', height: '48px', borderRadius: '14px', background: ventsColors.accentStrong, border: 'none', color: '#fff', fontSize: '15px', fontWeight: 700, cursor: 'pointer' }}
              >
                Open Creator Studio
              </button>
            )}
          </>
        ) : (
          <>
            <h3 style={{ color: ventsColors.ink1, fontSize: '17px', fontWeight: 700, margin: '0 0 8px' }}>Become an Organizer</h3>
            <p style={{ color: ventsColors.ink2, fontSize: '13px', margin: '0 0 16px', lineHeight: 1.5 }}>
              Create events and sell tickets on VENTS. Organizer tools turn on as soon as you continue.
            </p>
            {error && <p role="alert" style={{ color: ventsColors.error, fontSize: '12px', margin: '0 0 8px' }}>{error}</p>}
            <button
              data-testid="org-sheet-become-organizer"
              onClick={becomeOrganizer}
              disabled={state === 'sending'}
              style={{ width: '100%', height: '48px', borderRadius: '14px', background: ventsColors.accentStrong, border: 'none', color: '#fff', fontSize: '15px', fontWeight: 700, cursor: state === 'sending' ? 'wait' : 'pointer', opacity: state === 'sending' ? 0.7 : 1 }}
            >
              {state === 'sending' ? 'Turning on…' : 'Become an Organizer'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
