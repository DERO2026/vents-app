import { ReactNode, useState } from 'react';
import { Search, X, Check, ChevronDown } from 'lucide-react';

export interface PickerOption {
  value: string;
  label: string;
  /** Optional leading visual (e.g. a country flag) — rendered before the
   *  label in the default row layout. Ignored when `renderOption` is set. */
  icon?: ReactNode;
  /** Optional secondary line under the label (e.g. a dial-code format hint). */
  sublabel?: string;
}

// The trigger field — matches the app's INPUT_STYLE surfaces (dark field,
// 12px radius, 45px height) so it drops into any form next to plain
// <input>s without looking out of place.
export function PickerField({
  value,
  placeholder,
  onOpen,
  disabled,
}: {
  value: string;
  placeholder: string;
  onOpen: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      onClick={disabled ? undefined : onOpen}
      style={{
        width: '100%',
        boxSizing: 'border-box',
        background: '#090514',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '12px',
        padding: '12px 14px',
        height: '45px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span
        style={{
          color: value ? '#F0F0FF' : '#8B8FA8',
          fontSize: '14px',
          fontFamily: 'Inter, sans-serif',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value || placeholder}
      </span>
      <ChevronDown size={16} color="#8B8FA8" style={{ flexShrink: 0, marginLeft: '8px' }} />
    </div>
  );
}

// The searchable picker sheet used everywhere a native <select> would
// otherwise stand in for a real dropdown (state, city, visibility, event
// pickers, etc.) — a translucent-blur backdrop over a bottom sheet that
// slides up, closes on backdrop tap, and never covers the whole screen the
// way the earlier full-screen picker overlay did.
export function PickerSheet({
  title,
  options,
  value,
  onSelect,
  onClose,
  searchPlaceholder = 'Search...',
  searchable = true,
  // For lists that can never be exhaustive (e.g. every neighbourhood in
  // Nigeria) — when the typed query matches nothing, offers "Use '<query>'"
  // so the list is a set of suggestions, not a hard allowlist that blocks
  // anyone whose city isn't already in it.
  allowCustom = false,
  customLabel = (q: string) => `Use "${q}"`,
  // Lets a host that renders its own modal above this sheet's default 1000
  // (e.g. a bottom-sheet form already at a higher z-index) push this above
  // it, so the picker isn't stuck rendering behind its own host.
  zIndex = 1000,
  // Escape hatch for a row that needs more than icon+label+sublabel (e.g.
  // PhoneInput's dial-code trailing chip) — receives the option and whether
  // it's the current value, returns the row's full inner content.
  renderOption,
}: {
  title: string;
  options: PickerOption[];
  value: string;
  onSelect: (v: string) => void;
  onClose: () => void;
  searchPlaceholder?: string;
  searchable?: boolean;
  allowCustom?: boolean;
  customLabel?: (query: string) => string;
  zIndex?: number;
  renderOption?: (option: PickerOption, isSelected: boolean) => ReactNode;
}) {
  const [query, setQuery] = useState('');
  const filtered = searchable
    ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : options;
  const trimmedQuery = query.trim();
  const exactMatchExists = filtered.some((o) => o.label.toLowerCase() === trimmedQuery.toLowerCase());
  const showCustomOption = allowCustom && trimmedQuery.length > 0 && !exactMatchExists;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(2,0,5,0.55)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        zIndex,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // Room on every side so the card never touches an edge -- and, with
        // the keyboard open, this padding responds like any other flex
        // centering: the card re-centers in whatever visual space is left
        // above the keyboard rather than getting shoved off-screen.
        padding: '24px',
        boxSizing: 'border-box',
        animation: 'pickerBackdropIn 0.2s ease',
      }}
    >
      <style>{`
        @keyframes pickerBackdropIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes pickerCardIn { from { transform: scale(0.94); opacity: 0; } to { transform: scale(1); opacity: 1; } }
      `}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          // A centered floating card, not a sheet anchored to any edge --
          // margins on all four sides via the backdrop's own padding above,
          // rounded on every corner, capped width so it reads as a compact
          // control (an action sheet / context menu), never a screen.
          width: '100%',
          maxWidth: '360px',
          // Capped well below "nearly full screen" -- short lists (a handful
          // of options) size to their own content via the column layout
          // below; long lists (e.g. every country) stop scrolling within
          // this, never anywhere near 90-100% of the viewport. min() against
          // the viewport also keeps it clear of the keyboard: a shorter
          // visual viewport (keyboard open) shrinks this along with it.
          maxHeight: 'min(50vh, 420px)',
          display: 'flex',
          flexDirection: 'column',
          // Translucent frosted-glass surface: a solid sheet reads as
          // "another screen", not a floating overlay. blur+alpha here lets
          // the dimmed app behind bleed through, the way an iOS blur-
          // material menu/sheet does.
          background: 'rgba(13,10,26,0.78)',
          backdropFilter: 'blur(24px) saturate(1.4)',
          WebkitBackdropFilter: 'blur(24px) saturate(1.4)',
          borderRadius: '20px',
          border: '1px solid rgba(255,255,255,0.1)',
          boxShadow: '0 20px 50px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.03)',
          padding: '14px 16px 16px',
          animation: 'pickerCardIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
          <h3 style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif' }}>
            {title}
          </h3>
          <button
            onClick={onClose}
            style={{
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '50%',
              width: '28px',
              height: '28px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <X size={14} color="#C4C9E0" />
          </button>
        </div>

        {searchable && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              background: '#090514',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '14px',
              padding: '12px 16px',
              gap: '12px',
              marginBottom: '14px',
              flexShrink: 0,
            }}
          >
            <Search size={18} color="#8B8FA8" />
            <input
              type="text"
              placeholder={searchPlaceholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{
                flex: 1,
                background: 'none',
                border: 'none',
                outline: 'none',
                color: '#F0F0FF',
                fontSize: '14px',
                fontFamily: 'Inter, sans-serif',
              }}
              autoFocus
            />
          </div>
        )}

        <div
          style={{
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            scrollbarWidth: 'none',
            WebkitOverflowScrolling: 'touch',
            overscrollBehavior: 'contain',
          }}
        >
          {filtered.length === 0 && !showCustomOption && (
            <p style={{ color: '#8B8FA8', fontSize: '13px', textAlign: 'center', margin: '24px 0' }}>
              No results found.
            </p>
          )}
          {showCustomOption && (
            <div
              onClick={() => onSelect(trimmedQuery)}
              style={{
                background: 'rgba(168,85,247,0.1)',
                border: '1.5px dashed rgba(168,85,247,0.4)',
                borderRadius: '12px',
                padding: '14px 16px',
                cursor: 'pointer',
                color: '#A78BFA',
                fontSize: '14px',
                fontWeight: 600,
                flexShrink: 0,
              }}
            >
              {customLabel(trimmedQuery)}
            </div>
          )}
          {filtered.map((o) => {
            const isSelected = value === o.value;
            return (
              <div
                key={o.value}
                onClick={() => onSelect(o.value)}
                style={{
                  background: isSelected ? 'rgba(168,85,247,0.12)' : '#131629',
                  border: isSelected ? '1.5px solid rgba(168,85,247,0.45)' : '1px solid rgba(255,255,255,0.06)',
                  borderRadius: '12px',
                  padding: '14px 16px',
                  cursor: 'pointer',
                  color: '#F0F0FF',
                  fontSize: '14px',
                  fontWeight: isSelected ? 700 : 500,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexShrink: 0,
                  gap: '12px',
                }}
              >
                {renderOption ? (
                  renderOption(o, isSelected)
                ) : (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                      {o.icon}
                      <div style={{ minWidth: 0 }}>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</div>
                        {o.sublabel && <div style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 500 }}>{o.sublabel}</div>}
                      </div>
                    </div>
                    {isSelected && <Check size={16} color="#A78BFA" style={{ flexShrink: 0 }} />}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
