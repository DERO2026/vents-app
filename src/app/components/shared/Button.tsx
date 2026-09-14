import React from 'react';
import { haptics } from '../../../lib/haptics';
import { ventsColors, ventsTypography } from '../../../lib/ventsDesignTokens';

// One shared sizing/spacing scale for every button in the app — the
// "Get Directions" / "Add to Calendar" inconsistency (11px vs 12px padding,
// 12px vs 14px radius, defined ad-hoc per screen) is exactly the class of
// drift this exists to stop. Primary = the one action a screen wants you to
// take; Secondary = a supporting action that should never visually compete
// with it.
const HEIGHT = { sm: 38, md: 46, lg: 52 } as const;
const RADIUS = { sm: '10px', md: '14px', lg: '16px' } as const;
const FONT = { sm: '13px', md: '14px', lg: '15px' } as const;

type ButtonSize = keyof typeof HEIGHT;

interface BaseProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: React.ReactNode;
  size?: ButtonSize;
  fullWidth?: boolean;
  /** Skips the light haptic tap this component fires by default — for
   *  buttons that already trigger their own (e.g. success/error) haptic. */
  noHaptic?: boolean;
}

export function PrimaryButton({
  icon, size = 'md', fullWidth = true, noHaptic, onClick, style, disabled, children, ...rest
}: BaseProps) {
  return (
    <button
      {...rest}
      disabled={disabled}
      onClick={(e) => { if (!noHaptic && !disabled) haptics.light(); onClick?.(e); }}
      style={{
        width: fullWidth ? '100%' : undefined,
        height: `${HEIGHT[size]}px`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        background: disabled ? 'rgba(255,255,255,0.05)' : ventsColors.accent,
        border: 'none',
        borderRadius: RADIUS[size],
        padding: '0 20px',
        color: disabled ? ventsColors.ink3 : ventsColors.white,
        fontSize: FONT[size],
        fontWeight: 700,
        fontFamily: ventsTypography.fontBody,
        cursor: disabled ? 'not-allowed' : 'pointer',
        boxShadow: disabled ? 'none' : '0 10px 30px -12px rgba(142,92,247,0.9)',
        boxSizing: 'border-box',
        ...style,
      }}
    >
      {icon}
      {children}
    </button>
  );
}

export function SecondaryButton({
  icon, size = 'md', fullWidth = true, noHaptic, onClick, style, disabled, children, ...rest
}: BaseProps) {
  return (
    <button
      {...rest}
      disabled={disabled}
      onClick={(e) => { if (!noHaptic && !disabled) haptics.light(); onClick?.(e); }}
      style={{
        width: fullWidth ? '100%' : undefined,
        height: `${HEIGHT[size]}px`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        background: ventsColors.glassBg,
        border: `1px solid ${ventsColors.glassBorder}`,
        borderRadius: RADIUS[size],
        padding: '0 16px',
        color: ventsColors.white,
        fontSize: FONT[size],
        fontWeight: 700,
        fontFamily: ventsTypography.fontBody,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        boxSizing: 'border-box',
        ...style,
      }}
    >
      {icon}
      {children}
    </button>
  );
}
