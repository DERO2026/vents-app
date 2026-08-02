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

// The full-screen search + list sheet itself — the "premium" picker style
// first built for Venue-step State selection. Centralised here so every
// dropdown in the app (state, city, visibility, event pickers, etc.) opens
// the exact same searchable, keyboard-friendly sheet instead of a native
// <select>, which WebKit/WebView render inconsistently and can't be
// restyled to match the rest of the UI.
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
      style={{
        position: 'fixed',
        inset: 0,
        background: '#020005',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        padding: 'calc(20px + env(safe-area-inset-top)) 24px 40px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
        <h3 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif' }}>
          {title}
        </h3>
        <button
          onClick={onClose}
          style={{
            background: '#090514',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '50%',
            width: '32px',
            height: '32px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <X size={16} color="#C4C9E0" />
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
            marginBottom: '16px',
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
          flex: 1,
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
          <p style={{ color: '#8B8FA8', fontSize: '13px', textAlign: 'center', marginTop: '24px' }}>
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
              }}
            >
              {o.label}
              {isSelected && <Check size={16} color="#A78BFA" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
