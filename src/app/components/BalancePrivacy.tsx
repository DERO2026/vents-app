// Shared UI for the global hide/show balances preference (lib/balancePrivacy).
//   <PrivateAmount>{formatNaira(kobo)}</PrivateAmount>  -- masks when hidden
//   <BalanceVisibilityToggle />                          -- the eye button
// Every balance surface uses these two, so one preference controls all of
// them and they all mask the same way.
import type { CSSProperties, ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { MASK_NAIRA, toggleBalanceHidden, useBalanceHidden } from '../../lib/balancePrivacy';

export function PrivateAmount({ children, mask = MASK_NAIRA, testId }: {
  children: ReactNode;
  /** Masked text, e.g. MASK_VC for VENTS Cents. Defaults to ₦••••••. */
  mask?: string;
  testId?: string;
}) {
  const hidden = useBalanceHidden();
  if (!hidden) return <>{children}</>;
  return (
    <span data-testid={testId} data-balance-masked="true" aria-label="Hidden amount" style={{ letterSpacing: '0.04em' }}>
      {mask}
    </span>
  );
}

export function BalanceVisibilityToggle({ size = 16, color = 'currentColor', style, testId = 'balance-visibility-toggle' }: {
  size?: number;
  color?: string;
  style?: CSSProperties;
  testId?: string;
}) {
  const hidden = useBalanceHidden();
  const label = hidden ? 'Show balances' : 'Hide balances';
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={(e) => { e.stopPropagation(); toggleBalanceHidden(); }}
      aria-label={label}
      aria-pressed={hidden}
      title={label}
      style={{
        background: 'none', border: 'none', padding: 6, margin: -6, cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color, lineHeight: 0, flexShrink: 0,
        ...style,
      }}
    >
      {hidden ? <EyeOff size={size} /> : <Eye size={size} />}
    </button>
  );
}
