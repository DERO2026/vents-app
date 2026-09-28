import { OTPInput } from 'input-otp';
import { ventsColors } from '../../lib/ventsDesignTokens';

// Shared OTP entry UI for both the signup-verification and forgot-password
// screens in AuthScreen.tsx. Replaces two hand-rolled "transparent input
// overlaid on decorative boxes" implementations that had no real per-box
// caret and couldn't move focus to a specific box on tap (a single shared
// overlay input has no way to map a tap's x-position to a caret index).
// `input-otp` (already a dependency, already vendored as the shadcn
// InputOTP primitive under ./ui/input-otp.tsx but previously unused
// anywhere in the app) is a purpose-built library for exactly this pattern:
// each slot is individually focusable/tappable, the active slot renders a
// real blinking caret, and paste/SMS-autofill fills every slot from a
// single hidden input under the hood — all without any hand-rolled
// per-box focus/backspace logic.
//
// Renders its own slot (rather than reusing ./ui/input-otp's InputOTPSlot)
// because that component's active-state styling depends on a `--ring` CSS
// variable this app never defines, which would show as an unthemed default
// ring instead of the app's purple accent -- this applies the exact colors
// the old hand-rolled boxes used, so the visual design is unchanged, only
// the interaction model is fixed.
//
// Takes its slot data as a prop (from OTPInput's `render` callback), NOT
// via OTPInputContext -- confirmed root cause of the live "digits/caret
// never appear" bug: input-otp only wraps its output in
// OTPInputContext.Provider on the `children` path; passing a `render` prop
// (as this component does) calls that function directly with the slots
// data and never mounts the Provider, so a Slot reading
// useContext(OTPInputContext) always saw the default empty context --
// char/isActive/hasFakeCaret were permanently falsy. The underlying real
// <input> kept capturing keystrokes and forwarding them to onChange
// regardless (verification still succeeded), so this was purely a display
// bug, invisible to any test that only asserts the resulting value.
function Slot({ slot, hasError }: { slot: { char: string | null; isActive: boolean; hasFakeCaret: boolean }; hasError: boolean }) {
  const isActive = slot.isActive;
  const char = slot.char ?? '';
  const border = hasError
    ? '1px solid rgba(248,113,113,0.6)'
    : isActive
    ? '1px solid rgba(142,92,247,0.7)'
    : '1px solid rgba(255,255,255,0.12)';
  const bg = hasError ? 'rgba(248,113,113,0.07)' : ventsColors.elevated;
  return (
    <div
      style={{
        flex: 1,
        height: '64px',
        background: bg,
        border,
        boxShadow: isActive && !hasError ? '0 0 0 3px rgba(142,92,247,0.18)' : 'none',
        borderRadius: '14px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
      }}
    >
      <span style={{ color: '#fff', fontSize: '24px', fontWeight: 800, fontVariantNumeric: 'tabular-nums lining-nums' }}>
        {char}
      </span>
      {slot.hasFakeCaret && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <div style={{ width: '1px', height: '28px', background: '#fff', animation: 'vents-otp-caret-blink 1s step-end infinite' }} />
        </div>
      )}
    </div>
  );
}

export function OtpCodeBoxes({
  length,
  value,
  onChange,
  onKeyDown,
  hasError,
  autoFocus,
  inputRef,
}: {
  length: number;
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  hasError: boolean;
  autoFocus?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <>
      <style>{'@keyframes vents-otp-caret-blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }'}</style>
      <OTPInput
        ref={inputRef}
        maxLength={length}
        value={value}
        onChange={(val) => onChange(val.replace(/\D/g, ''))}
        onKeyDown={onKeyDown}
        autoFocus={autoFocus}
        inputMode="numeric"
        containerClassName="flex gap-2 w-full"
        render={({ slots }) => (
          <>
            {slots.map((slot, i) => (
              <Slot key={i} slot={slot} hasError={hasError} />
            ))}
          </>
        )}
      />
    </>
  );
}
