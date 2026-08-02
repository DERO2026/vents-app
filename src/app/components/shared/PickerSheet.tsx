import { useState } from 'react';
import { Search, X, Check, ChevronDown } from 'lucide-react';

export interface PickerOption {
  value: string;
  label: string;
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
}: {
  title: string;
  options: PickerOption[];
  value: string;
  onSelect: (v: string) => void;
  onClose: () => void;
  searchPlaceholder?: string;
  searchable?: boolean;
}) {
  const [query, setQuery] = useState('');
  const filtered = searchable
    ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : options;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(2,0,5,0.55)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'flex-end',
        animation: 'pickerBackdropIn 0.2s ease',
      }}
    >
      <style>{`
        @keyframes pickerBackdropIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes pickerSheetIn { from { transform: translateY(24px); opacity: 0.6; } to { transform: translateY(0); opacity: 1; } }
      `}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxHeight: '75vh',
          display: 'flex',
          flexDirection: 'column',
          background: '#0D0A1A',
          borderTopLeftRadius: '24px',
          borderTopRightRadius: '24px',
          border: '1px solid rgba(255,255,255,0.08)',
          borderBottom: 'none',
          boxShadow: '0 -20px 50px rgba(0,0,0,0.45)',
          padding: '12px 20px calc(20px + env(safe-area-inset-bottom))',
          animation: 'pickerSheetIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {/* Grab handle — the standard bottom-sheet affordance signalling
            this can be swiped/tapped away, distinct from a full page. */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '12px' }}>
          <div style={{ width: '36px', height: '4px', borderRadius: '2px', background: 'rgba(255,255,255,0.15)' }} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
          <h3 style={{ color: '#F0F0FF', fontSize: '17px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif' }}>
            {title}
          </h3>
          <button
            onClick={onClose}
            style={{
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '50%',
              width: '30px',
              height: '30px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <X size={15} color="#C4C9E0" />
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
          {filtered.length === 0 && (
            <p style={{ color: '#8B8FA8', fontSize: '13px', textAlign: 'center', margin: '24px 0' }}>
              No results found.
            </p>
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
                }}
              >
                {o.label}
                {isSelected && <Check size={16} color="#A78BFA" />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
