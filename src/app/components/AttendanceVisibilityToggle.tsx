import { Users } from 'lucide-react';
import { ventsColors } from '../../lib/ventsDesignTokens';
import { ATTENDANCE_SETTING_DESCRIPTION, ATTENDANCE_SETTING_LABEL } from '../../lib/attendanceVisibility';

// Create / Edit Event setting: whether the public sees the attendance count
// (events.show_attendance_count, 0221). Same look as the Settings step's other
// toggles, but a real switch (role="switch", aria-checked, keyboard-operable).
export function AttendanceVisibilityToggle({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <div
      data-testid="attendance-visibility-setting"
      style={{
        background: ventsColors.surface,
        border: checked ? '1px solid rgba(168,85,247,0.3)' : '1px solid rgba(255,255,255,0.06)',
        borderRadius: '14px',
        padding: '14px',
      }}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ATTENDANCE_SETTING_LABEL}
        aria-describedby="attendance-visibility-description"
        data-testid="attendance-visibility-toggle"
        onClick={() => onChange(!checked)}
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', width: '100%',
          background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', color: 'inherit', font: 'inherit',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{ width: '34px', height: '34px', borderRadius: '10px', background: checked ? 'rgba(168,85,247,0.15)' : 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Users size={16} color={checked ? ventsColors.accent : ventsColors.ink2} />
          </div>
          <div>
            <p style={{ color: ventsColors.ink1, fontSize: '14px', fontWeight: 500 }}>{ATTENDANCE_SETTING_LABEL}</p>
            <p id="attendance-visibility-description" style={{ color: ventsColors.ink2, fontSize: '12px' }}>{ATTENDANCE_SETTING_DESCRIPTION}</p>
          </div>
        </div>
        <span aria-hidden="true" style={{ width: '44px', height: '26px', borderRadius: '13px', background: checked ? '#8E5CF7' : ventsColors.elevated, position: 'relative', transition: 'background 0.2s', flexShrink: 0, display: 'block' }}>
          <span style={{ position: 'absolute', top: '3px', width: '20px', height: '20px', borderRadius: '50%', background: ventsColors.white, transition: 'left 0.2s', left: checked ? '21px' : '3px', display: 'block' }} />
        </span>
      </button>
      {!checked && (
        <p data-testid="attendance-visibility-hidden-note" style={{ color: ventsColors.ink2, fontSize: '11px', marginTop: '8px', lineHeight: 1.4 }}>
          Your event stays visible and on sale. Only you and VENTS admins will see how many people are attending.
        </p>
      )}
    </div>
  );
}
