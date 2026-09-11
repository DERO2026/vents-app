// Reusable VENTS-user search/autocomplete, shared by "Someone Else Pays"
// (CheckoutScreen.tsx) and Ticket Transfer (MyTicketsScreen.tsx) -- both
// previously asked for a raw, typed-blind email/username with zero
// feedback until final submit. Server-side resolution (create_pending_
// purchase's p_payer_identifier, initiate_ticket_transfer's recipient
// identifier) stays the sole authority on who actually gets picked; this
// is purely a UX layer that fills the same text value a manually-typed
// identifier already would have.
import { useState, useEffect, useRef } from 'react';
import { AlertCircle, User as UserIcon } from 'lucide-react';
import { searchUsers, UserSearchResult } from '../../../lib/userSearch';

interface UserAutocompleteProps {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onSelect: (user: UserSearchResult) => void;
  error?: string;
  helperText?: string;
}

const DEBOUNCE_MS = 300;

export function UserAutocomplete({ label, placeholder, value, onChange, onSelect, error, helperText }: UserAutocompleteProps) {
  const [results, setResults] = useState<UserSearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  // Tracks the identifier of the last *selected* suggestion so re-opening
  // the dropdown on every keystroke doesn't immediately re-fire a search
  // for a value the user just picked (onChange still fires once on select
  // to keep the input controlled).
  const lastSelectedRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === lastSelectedRef.current || trimmed.length < 2) {
      setResults([]);
      setSearchError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    const thisRequestId = ++requestIdRef.current;
    const timer = setTimeout(() => {
      searchUsers(trimmed)
        .then((users) => {
          if (requestIdRef.current !== thisRequestId) return; // superseded by a newer keystroke
          setResults(users);
          setSearchError(null);
        })
        .catch((err: any) => {
          if (requestIdRef.current !== thisRequestId) return;
          setResults([]);
          setSearchError(err?.message || 'Could not search VENTS users right now.');
        })
        .finally(() => {
          if (requestIdRef.current === thisRequestId) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [value]);

  const handleSelect = (user: UserSearchResult) => {
    // Only username is a valid identifier for the downstream resolution
    // RPCs (create_pending_purchase/initiate_ticket_transfer match against
    // lower(email) = norm OR lower(username) = norm, never full_name).
    // search_users_for_request (0069) already excludes usernameless users
    // from results, so this is never empty for a real suggestion -- but the
    // fallback stays for defense-in-depth rather than filling the field
    // with an unmatchable value.
    const identifier = user.username || '';
    lastSelectedRef.current = identifier;
    onChange(identifier);
    onSelect(user);
    setOpen(false);
    setResults([]);
  };

  const showDropdown = open && value.trim().length >= 2;

  return (
    <div style={{ width: '100%', minWidth: 0, position: 'relative' }}>
      <p style={{ color: '#94A3B8', fontSize: '12px', marginBottom: '6px', fontWeight: 500, textTransform: 'uppercase' }}>{label}</p>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          background: '#090514',
          border: `1px solid ${error ? 'rgba(239,68,68,0.5)' : 'rgba(255,255,255,0.1)'}`,
          borderRadius: '16px',
          height: '52px',
          padding: '0 14px',
          gap: '10px',
          width: '100%',
          boxSizing: 'border-box',
        }}
      >
        <UserIcon size={16} color="#8B8FA8" />
        <input
          type="text"
          placeholder={placeholder}
          value={value}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => {
            lastSelectedRef.current = null;
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // Delay so a click on a dropdown row registers before the
            // dropdown unmounts.
            setTimeout(() => setOpen(false), 150);
          }}
          style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', outline: 'none', color: '#FFFFFF', fontSize: '14px', fontFamily: 'Inter, sans-serif' }}
        />
      </div>

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '4px' }}>
          <AlertCircle size={11} color="#EF4444" />
          <p style={{ color: '#EF4444', fontSize: '11px', margin: 0 }}>{error}</p>
        </div>
      )}
      {helperText && !error && (
        <p style={{ color: '#8B8FA8', fontSize: '12px', marginTop: '6px', lineHeight: 1.5 }}>{helperText}</p>
      )}

      {showDropdown && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: '6px',
            background: '#12101C',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '14px',
            overflow: 'hidden',
            zIndex: 20,
            maxHeight: '260px',
            overflowY: 'auto',
            boxShadow: '0 12px 30px rgba(0,0,0,0.4)',
          }}
        >
          {loading && (
            <div style={{ padding: '14px', color: '#8B8FA8', fontSize: '13px' }}>Searching…</div>
          )}
          {!loading && searchError && (
            <div style={{ padding: '14px', color: '#EF4444', fontSize: '13px' }}>{searchError}</div>
          )}
          {!loading && !searchError && results.length === 0 && (
            <div style={{ padding: '14px', color: '#8B8FA8', fontSize: '13px' }}>No VENTS users found.</div>
          )}
          {!loading && !searchError && results.map((user) => (
            <button
              key={user.id}
              onClick={() => handleSelect(user)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                width: '100%',
                padding: '10px 14px',
                background: 'none',
                border: 'none',
                borderBottom: '1px solid rgba(255,255,255,0.05)',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              {user.avatarUrl ? (
                <img src={user.avatarUrl} alt="" style={{ width: '32px', height: '32px', borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
              ) : (
                <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'rgba(124,58,237,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <UserIcon size={14} color="#C4B5FD" />
                </div>
              )}
              <div style={{ minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: '#F0F0FF', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {user.fullName || user.username || 'VENTS user'}
                </p>
                {user.username && (
                  <p style={{ margin: 0, fontSize: '12px', color: '#8B8FA8' }}>@{user.username}</p>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
