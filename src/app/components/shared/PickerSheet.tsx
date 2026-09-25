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
          fontFamily: 'Manrope, sans-serif',
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

  // Handoff PK1/PK3: a bottom sheet anchored to the screen edge, not a
  // centered floating card. Long/searchable lists (country, state) open
  // tall (top: 14%, ~86% of the viewport, per PK1); short fixed lists that
  // skip search (category, a handful of options, per P23) size to content
  // up to 60% of the viewport (PK3). Rows are a plain divided list --
  // underline dividers, no per-row card background/border -- with a single
  // purple checkmark marking the selection, not a highlighted card.
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(4,3,8,0.6)',
        zIndex,
        animation: 'pickerBackdropIn 0.2s ease',
      }}
    >
      <style>{`
        @keyframes pickerBackdropIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes pickerSheetIn { from { transform: translateY(24px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
      `}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          ...(searchable ? { top: '14%' } : { maxHeight: '60%' }),
          borderRadius: '28px 28px 0 0',
          background: 'rgba(18,16,25,0.96)',
          backdropFilter: 'blur(34px)',
          WebkitBackdropFilter: 'blur(34px)',
          borderTop: '1px solid rgba(255,255,255,0.12)',
          display: 'flex',
          flexDirection: 'column',
          padding: '12px 20px calc(20px + env(safe-area-inset-bottom))',
          animation: 'pickerSheetIn 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        <div style={{ width: '38px', height: '4px', borderRadius: '99px', background: 'rgba(255,255,255,0.22)', alignSelf: 'center', marginBottom: '14px', flexShrink: 0 }} />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px', flexShrink: 0 }}>
          <h3 style={{ color: '#fff', fontSize: '18px', fontWeight: 800, fontFamily: 'Manrope, sans-serif', margin: 0 }}>
            {title}
          </h3>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', padding: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}
          >
            <X size={18} color="rgba(237,234,245,0.5)" />
          </button>
        </div>

        {searchable && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              background: '#1A1724',
              border: '1px solid rgba(142,92,247,0.4)',
              borderRadius: '12px',
              height: '44px',
              padding: '0 14px',
              gap: '10px',
              marginBottom: '14px',
              flexShrink: 0,
            }}
          >
            <Search size={16} color="rgba(237,234,245,0.5)" />
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
                color: '#fff',
                fontSize: '14px',
                fontFamily: 'Manrope, sans-serif',
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
            scrollbarWidth: 'none',
            WebkitOverflowScrolling: 'touch',
            overscrollBehavior: 'contain',
            minHeight: 0,
          }}
        >
          {filtered.length === 0 && !showCustomOption && (
            <p style={{ color: 'rgba(237,234,245,0.5)', fontSize: '13px', textAlign: 'center', margin: '24px 0' }}>
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
                marginBottom: '4px',
              }}
            >
              {customLabel(trimmedQuery)}
            </div>
          )}
          {filtered.map((o, i) => {
            const isSelected = value === o.value;
            return (
              <div
                key={o.value}
                onClick={() => onSelect(o.value)}
                style={{
                  padding: '13px 0',
                  borderBottom: i < filtered.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                  cursor: 'pointer',
                  color: isSelected ? '#fff' : '#EDEAF5',
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                      {o.icon}
                      <div style={{ minWidth: 0 }}>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</div>
                        {o.sublabel && <div style={{ color: 'rgba(237,234,245,0.55)', fontSize: '12px', fontWeight: 500 }}>{o.sublabel}</div>}
                      </div>
                    </div>
                    {isSelected && <Check size={16} color="#8E5CF7" style={{ flexShrink: 0 }} />}
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
