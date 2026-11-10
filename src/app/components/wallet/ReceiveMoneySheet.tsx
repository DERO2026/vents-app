// Receive Money (0215): the user's VENTS username, a QR code and a link that
// open Send Money to them. Nothing here moves money; the sender still
// confirms the recipient, amount and their own PIN.
import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Copy, Share2 } from 'lucide-react';
import { ventsColors } from '../../../lib/ventsDesignTokens';
import { payLinkFor } from '../../../lib/walletTransfers';
import { shareLink } from '../../../lib/shareLink';
import { Sheet, PrimaryButton, Notice } from './walletUi';

export function ReceiveMoneySheet({ username, displayName, onClose }: { username: string | null; displayName: string | null; onClose: () => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const link = username ? payLinkFor(username) : null;

  useEffect(() => {
    if (!link) return;
    let alive = true;
    QRCode.toDataURL(link, { margin: 1, width: 480, color: { dark: '#0B0912', light: '#FFFFFF' } })
      .then((url) => { if (alive) setQr(url); })
      .catch(() => { if (alive) setQr(null); });
    return () => { alive = false; };
  }, [link]);

  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); setMsg(`${what} copied`); }
    catch { setMsg(`Copy failed. ${what}: ${text}`); }
  };
  const share = async () => {
    if (!link || !username) return;
    const r = await shareLink({ title: 'Send me money on VENTS', text: `Send money to @${username} on VENTS`, url: link });
    if (r === 'copied') setMsg('Link copied');
  };

  return (
    <Sheet title="Receive Money" onClose={onClose} testId="receive-money-sheet">
      {!username ? (
        <Notice tone="warn" testId="receive-no-username">
          You need a VENTS username to receive money. Add one in your profile (Edit Profile → Username), then come back here.
        </Notice>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <p style={{ margin: 0, fontSize: 13, color: ventsColors.ink2, textAlign: 'center', lineHeight: 1.5 }}>
            Friends send money to your username. It lands in your VENTS Wallet balance, ready for tickets and services.
          </p>
          <div style={{ background: '#fff', padding: 12, borderRadius: 18, boxShadow: '0 0 40px rgba(142,92,247,0.35)', width: 'min(240px, 70vw)', aspectRatio: '1 / 1', boxSizing: 'border-box' }}>
            {qr ? <img data-testid="receive-qr" src={qr} alt={`QR code to send money to @${username}`} style={{ width: '100%', height: '100%', display: 'block' }} />
              : <div style={{ width: '100%', height: '100%' }} aria-hidden />}
          </div>
          <div style={{ textAlign: 'center' }}>
            {displayName && <p style={{ margin: 0, fontWeight: 800, color: ventsColors.ink1 }}>{displayName}</p>}
            <p data-testid="receive-username" style={{ margin: '2px 0 0', fontSize: 18, fontWeight: 800, color: ventsColors.accentSoft }}>@{username}</p>
          </div>
          <div style={{ display: 'flex', gap: 8, width: '100%', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 140px' }}>
              <PrimaryButton tone="ghost" testId="receive-copy-username" onClick={() => copy(`@${username}`, 'Username')}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Copy size={16} /> Copy username</span>
              </PrimaryButton>
            </div>
            <div style={{ flex: '1 1 140px' }}>
              <PrimaryButton testId="receive-share" onClick={share}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Share2 size={16} /> Share</span>
              </PrimaryButton>
            </div>
          </div>
          <button type="button" data-testid="receive-copy-link" onClick={() => link && copy(link, 'Link')}
            style={{ minHeight: 44, background: 'none', border: 'none', color: ventsColors.ink2, fontSize: 12.5, textDecoration: 'underline', cursor: 'pointer' }}>
            Copy payment link
          </button>
          {msg && <p role="status" data-testid="receive-msg" style={{ margin: 0, fontSize: 12.5, color: ventsColors.success }}>{msg}</p>}
          <p style={{ margin: 0, fontSize: 11.5, color: ventsColors.ink3, textAlign: 'center' }}>
            Never share your PIN. Receiving money never needs it.
          </p>
        </div>
      )}
    </Sheet>
  );
}
