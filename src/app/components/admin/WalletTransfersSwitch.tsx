// VENTS Admin only: turn VENTS-to-VENTS wallet transfers (0215) on or off.
// Off until switched on. The database enforces both the switch
// (transfer_wallet_funds) and who may flip it (admin_set_wallet_transfers_enabled).
import React, { useEffect, useState } from 'react';
import { Repeat } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { adminTheme } from './adminConsoleTheme';
import { fetchTransferStatus } from '../../../lib/walletTransfers';

export function WalletTransfersSwitch() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => fetchTransferStatus().then((s) => { setAvailable(!!s); setEnabled(s ? s.enabled : null); }, () => setAvailable(false));
  useEffect(() => { void load(); }, []);

  const toggle = async () => {
    if (enabled === null || busy) return;
    const next = !enabled;
    const ok = window.confirm(next
      ? 'Turn ON money transfers between VENTS users? Users will be able to send their VENTS Wallet balance to other users (PIN, limits and checks apply).'
      : 'Turn OFF money transfers? New transfers are blocked immediately; completed transfers are not affected.');
    if (!ok) return;
    setBusy(true); setMsg(null);
    const { error } = await supabase.rpc('admin_set_wallet_transfers_enabled' as any, { p_enabled: next });
    setBusy(false);
    if (error) { setMsg(error.message); return; }
    setMsg(next ? 'Transfers are on.' : 'Transfers are off.');
    await load();
  };

  return (
    <div data-testid="wallet-transfers-switch" style={{ background: adminTheme.panel, borderRadius: 16, border: `1px solid ${adminTheme.border}`, padding: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <div style={{ width: 36, height: 36, borderRadius: 10, background: adminTheme.accentSoftBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Repeat size={17} color={adminTheme.accentFrom} />
      </div>
      <div style={{ flex: '1 1 200px', minWidth: 0 }}>
        <p style={{ color: adminTheme.textStrong, fontSize: 14, fontWeight: 600, margin: 0 }}>Wallet Transfers (VENTS to VENTS)</p>
        <p data-testid="wallet-transfers-state" style={{ color: adminTheme.textFaint, fontSize: 11, margin: '2px 0 0' }}>
          {!available ? 'Not available: needs database migration 0215'
            : enabled === null ? 'Loading…'
            : enabled ? 'On — users can send VENTS Wallet balance to other users'
            : 'Off — Send and Receive are hidden and transfers are refused'}
        </p>
        {msg && <p style={{ color: adminTheme.textMuted, fontSize: 11, margin: '4px 0 0' }}>{msg}</p>}
      </div>
      {available && enabled !== null && (
        <button data-testid="wallet-transfers-toggle" onClick={toggle} disabled={busy}
          style={{ minHeight: 40, padding: '0 14px', borderRadius: 10, border: `1px solid ${adminTheme.border}`, background: enabled ? 'rgba(248,113,113,.12)' : 'rgba(52,211,153,.15)',
            color: enabled ? adminTheme.red : adminTheme.green, fontWeight: 700, fontSize: 12, cursor: busy ? 'wait' : 'pointer' }}>
          {busy ? 'Saving…' : enabled ? 'Turn off' : 'Turn on'}
        </button>
      )}
    </div>
  );
}
