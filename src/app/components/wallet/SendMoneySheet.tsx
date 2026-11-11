// Send Money (0215): recipient -> amount -> review + PIN -> receipt.
// Every decision is the server's (transfer_wallet_funds); this sheet only
// collects input, shows exactly what will happen, and never sends twice:
// one idempotency key per attempt, reused on retry, plus an in-flight guard.
import React, { useEffect, useRef, useState } from 'react';
import { BadgeCheck, Search, ArrowLeft } from 'lucide-react';
import { ventsColors } from '../../../lib/ventsDesignTokens';
import {
  findRecipient, usernameProblem, parseNairaToKobo, transferAmountProblem, formatNaira, newTransferKey, sendMoney,
  transferRefusalText, sendBlockReason, type TransferRecipient, type TransferStatus, type TransferResult,
} from '../../../lib/walletTransfers';
import { PIN_LENGTH, pinProblem, createPin } from '../../../lib/withdrawals';
import { Sheet, PrimaryButton, FieldLabel, inputStyle, DetailRow, Notice } from './walletUi';

type Step = 'recipient' | 'amount' | 'review' | 'done';

export function SendMoneySheet({ balanceKobo, status, initialUsername, onClose, onSent, onStatusChanged }: {
  balanceKobo: number;
  status: TransferStatus;
  initialUsername?: string | null;
  onClose: () => void;
  onSent: (result: TransferResult) => void;
  onStatusChanged: () => void;
}) {
  const [step, setStep] = useState<Step>('recipient');
  const [username, setUsername] = useState(initialUsername || '');
  const [searching, setSearching] = useState(false);
  const [recipient, setRecipient] = useState<TransferRecipient | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [amountText, setAmountText] = useState('');
  const [note, setNote] = useState('');
  const [pin, setPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [newPinConfirm, setNewPinConfirm] = useState('');
  const [hasPin, setHasPin] = useState(status.has_pin);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TransferResult | null>(null);
  const inFlight = useRef(false);
  const keyRef = useRef<string | null>(null);

  const amountKobo = parseNairaToKobo(amountText);
  const amountProblem = transferAmountProblem(amountKobo, balanceKobo, status);
  const noteMax = status.policy?.note_max_length ?? 140;
  // Account-level reasons the server would refuse anyway (email, account age, PIN lock, daily limit): said up front.
  const block = sendBlockReason(status);

  const lookup = async (raw = username) => {
    const problem = usernameProblem(raw);
    if (problem) { setLookupError(problem); return; }
    setSearching(true); setLookupError(null); setRecipient(null);
    try {
      const r = await findRecipient(raw);
      if (r.recipient) { setRecipient(r.recipient); keyRef.current = null; }
      else setLookupError(r.message || 'That user could not be found');
    } catch (e: any) {
      setLookupError(e?.message || 'Search failed. Try again.');
    } finally { setSearching(false); }
  };
  // A ?pay=<username> link (Receive QR) opens straight to the lookup.
  useEffect(() => { if (initialUsername) void lookup(initialUsername); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toReview = () => {
    if (amountProblem || !recipient) return;
    if (note.length > noteMax) { setError(`Keep the note under ${noteMax} characters`); return; }
    setError(null); setPin('');
    if (!keyRef.current) keyRef.current = newTransferKey();
    setStep('review');
  };

  const create = async () => {
    const problem = pinProblem(newPin, newPinConfirm);
    if (problem) { setError(problem); return; }
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      await createPin(newPin, newPinConfirm);
      setHasPin(true); setNewPin(''); setNewPinConfirm('');
      onStatusChanged();
    } catch (e: any) { setError(e?.message || 'Could not create the PIN'); }
    finally { inFlight.current = false; setBusy(false); }
  };

  const confirm = async () => {
    if (!recipient || amountKobo === null || !keyRef.current) return;
    if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) { setError(`Enter your ${PIN_LENGTH}-digit PIN`); return; }
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    const typed = pin; setPin('');
    try {
      const r = await sendMoney(recipient.id, amountKobo, note, typed, keyRef.current);
      if (r.ok) {
        keyRef.current = null;
        setResult(r); setStep('done'); onSent(r);
      } else {
        setError(transferRefusalText(r));
        // A different attempt (new key) is only needed when the server refused this exact request for good.
        if (!['wrong_pin', 'rate_limited'].includes(r.code || '')) keyRef.current = null;
        if (r.code === 'pin_not_set') setHasPin(false);
      }
    } catch (e: any) {
      // Network failure: the key is kept, so retrying can never send a second transfer.
      setError(`${e?.message || 'Network error'}. Retrying is safe: it cannot send twice.`);
    } finally { inFlight.current = false; setBusy(false); }
  };

  const back = () => { setError(null); setStep(step === 'review' ? 'amount' : 'recipient'); };

  return (
    <Sheet title={step === 'done' ? 'Money sent' : 'Send Money'} onClose={onClose} testId="send-money-sheet" busy={busy}>
      {block && step !== 'done' ? (
        <div data-testid="send-blocked">
          <Notice tone="warn">{block}</Notice>
          <p style={{ margin: '10px 0 14px', fontSize: 12.5, color: ventsColors.ink2, lineHeight: 1.5 }}>Nothing was sent. Your Wallet Balance is unchanged.</p>
          <PrimaryButton tone="ghost" onClick={onClose}>Close</PrimaryButton>
        </div>
      ) : (<>
      {step !== 'recipient' && step !== 'done' && (
        <button type="button" onClick={back} disabled={busy} data-testid="send-back"
          style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 44, background: 'none', border: 'none', color: ventsColors.ink2, fontSize: 13, cursor: 'pointer', padding: 0, marginTop: -8 }}>
          <ArrowLeft size={16} /> Back
        </button>
      )}

      {step === 'recipient' && (
        <div>
          <p style={{ margin: '0 0 6px', fontSize: 13, color: ventsColors.ink2, lineHeight: 1.5 }}>
            Send from your VENTS Wallet balance to another VENTS user. It arrives in their VENTS Wallet instantly and can be spent on tickets and services.
          </p>
          <FieldLabel htmlFor="send-username">Their VENTS username</FieldLabel>
          <form onSubmit={(e) => { e.preventDefault(); void lookup(); }} style={{ display: 'flex', gap: 8 }}>
            <input id="send-username" data-testid="send-username" value={username} autoCapitalize="none" autoCorrect="off" spellCheck={false}
              onChange={(e) => { setUsername(e.target.value); setRecipient(null); setLookupError(null); }}
              placeholder="@username" style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
            <button type="submit" data-testid="send-find" disabled={searching} aria-label="Find user"
              style={{ minWidth: 48, minHeight: 48, borderRadius: 999, border: 'none', background: ventsColors.accentStrong, color: '#fff', cursor: 'pointer' }}>
              <Search size={18} />
            </button>
          </form>
          <p style={{ margin: '6px 0 0', fontSize: 11.5, color: ventsColors.ink3 }}>Only an exact username matches. Ask them for it, or scan their Receive QR code.</p>
          {searching && <p style={{ fontSize: 13, color: ventsColors.ink2 }}>Searching…</p>}
          {lookupError && <div style={{ marginTop: 10 }}><Notice tone="error" testId="send-lookup-error">{lookupError}</Notice></div>}
          {recipient && (
            <div data-testid="send-recipient" style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14, padding: 12, borderRadius: 24, background: 'rgba(142,92,247,0.12)', border: '1px solid rgba(142,92,247,0.35)' }}>
              {recipient.avatar_url
                ? <img src={recipient.avatar_url} alt="" style={{ width: 44, height: 44, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                : <div aria-hidden style={{ width: 44, height: 44, borderRadius: '50%', background: ventsColors.accentStrong, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, flexShrink: 0 }}>{(recipient.name || recipient.username).slice(0, 1).toUpperCase()}</div>}
              <div style={{ minWidth: 0, flex: 1 }}>
                <p style={{ margin: 0, fontWeight: 800, color: ventsColors.ink1, overflowWrap: 'anywhere', display: 'flex', alignItems: 'center', gap: 6 }}>
                  {recipient.name}{recipient.is_verified && <BadgeCheck size={15} color={ventsColors.accentSoft} aria-label="Verified" />}
                </p>
                <p style={{ margin: '2px 0 0', fontSize: 12.5, color: ventsColors.ink2 }}>@{recipient.username}</p>
              </div>
            </div>
          )}
          <div style={{ marginTop: 16 }}>
            <PrimaryButton testId="send-next" disabled={!recipient} onClick={() => { setError(null); setStep('amount'); }}>Continue</PrimaryButton>
          </div>
        </div>
      )}

      {step === 'amount' && recipient && (
        <div>
          <p style={{ margin: 0, fontSize: 13, color: ventsColors.ink2 }}>To <b style={{ color: ventsColors.ink1 }}>{recipient.name}</b> (@{recipient.username})</p>
          <FieldLabel htmlFor="send-amount">Amount (₦)</FieldLabel>
          <input id="send-amount" data-testid="send-amount" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)}
            placeholder="0.00" style={{ ...inputStyle, fontSize: 22, fontWeight: 800 }} />
          <p data-testid="send-available" style={{ margin: '6px 0 0', fontSize: 12, color: ventsColors.ink3 }}>
            Available: {formatNaira(balanceKobo)} · You can send {formatNaira(status.remaining_today_kobo)} more today
          </p>
          {amountText && amountProblem && <p data-testid="send-amount-problem" style={{ margin: '6px 0 0', fontSize: 12.5, color: ventsColors.error }}>{amountProblem}</p>}
          <FieldLabel htmlFor="send-note">Note (optional)</FieldLabel>
          <input id="send-note" data-testid="send-note" value={note} maxLength={noteMax} onChange={(e) => setNote(e.target.value)} placeholder="What's it for?" style={inputStyle} />
          {error && <div style={{ marginTop: 10 }}><Notice tone="error">{error}</Notice></div>}
          <div style={{ marginTop: 16 }}>
            <PrimaryButton testId="send-review" disabled={!!amountProblem} onClick={toReview}>Review</PrimaryButton>
          </div>
        </div>
      )}

      {step === 'review' && recipient && amountKobo !== null && (
        <div>
          <div style={{ textAlign: 'center', padding: '6px 0 12px' }}>
            <p style={{ margin: 0, fontSize: 12, color: ventsColors.ink3, letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 700 }}>You are sending</p>
            <p data-testid="send-review-amount" style={{ margin: '4px 0 0', fontSize: 32, fontWeight: 800, color: ventsColors.white }}>{formatNaira(amountKobo)}</p>
          </div>
          <DetailRow label="To" value={<>{recipient.name}<br /><span style={{ color: ventsColors.ink2 }}>@{recipient.username}</span></>} testId="send-review-to" />
          <DetailRow label="From" value="Your VENTS Wallet balance" />
          {note.trim() && <DetailRow label="Note" value={note.trim()} />}
          <DetailRow label="Arrives" value="Instantly, in their VENTS Wallet" />
          <DetailRow label="Fee" value="Free" />
          <p style={{ margin: '10px 0 0', fontSize: 11.5, color: ventsColors.ink3, lineHeight: 1.45 }}>
            Check the name and username. A completed transfer cannot be reversed by VENTS.
          </p>
          {hasPin ? (
            <>
              <FieldLabel htmlFor="send-pin">Your {PIN_LENGTH}-digit VENTS PIN</FieldLabel>
              <input id="send-pin" data-testid="send-pin" type="password" inputMode="numeric" autoComplete="off" maxLength={PIN_LENGTH}
                value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} style={{ ...inputStyle, letterSpacing: '0.4em', fontSize: 20 }} />
              {error && <div style={{ marginTop: 10 }}><Notice tone="error" testId="send-error">{error}</Notice></div>}
              <div style={{ marginTop: 14 }}>
                <PrimaryButton testId="send-confirm" disabled={busy || pin.length !== PIN_LENGTH} onClick={confirm}>
                  {busy ? 'Sending…' : `Send ${formatNaira(amountKobo)}`}
                </PrimaryButton>
              </div>
            </>
          ) : (
            <div data-testid="send-create-pin">
              <Notice tone="info">Create a 4-digit VENTS PIN. It protects every transfer and withdrawal. VENTS will never ask you for it.</Notice>
              <FieldLabel htmlFor="send-new-pin">New PIN</FieldLabel>
              <input id="send-new-pin" data-testid="send-new-pin" type="password" inputMode="numeric" maxLength={PIN_LENGTH} value={newPin}
                onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))} style={{ ...inputStyle, letterSpacing: '0.4em' }} />
              <FieldLabel htmlFor="send-new-pin2">Enter it again</FieldLabel>
              <input id="send-new-pin2" data-testid="send-new-pin2" type="password" inputMode="numeric" maxLength={PIN_LENGTH} value={newPinConfirm}
                onChange={(e) => setNewPinConfirm(e.target.value.replace(/\D/g, ''))} style={{ ...inputStyle, letterSpacing: '0.4em' }} />
              {error && <div style={{ marginTop: 10 }}><Notice tone="error">{error}</Notice></div>}
              <div style={{ marginTop: 14 }}><PrimaryButton testId="send-create-pin-submit" disabled={busy} onClick={create}>{busy ? 'Saving…' : 'Create PIN'}</PrimaryButton></div>
            </div>
          )}
        </div>
      )}

      {step === 'done' && result?.ok && recipient && (
        <div data-testid="send-done">
          <Notice tone="ok">{result.replayed ? 'This transfer had already gone through. Nothing was sent twice.' : `Sent. ${recipient.name} has the money now.`}</Notice>
          <DetailRow label="Amount" value={formatNaira(result.amountKobo ?? 0)} />
          <DetailRow label="To" value={`${recipient.name} (@${recipient.username})`} />
          <DetailRow label="Status" value={<span style={{ color: ventsColors.success }}>Completed</span>} />
          <DetailRow label="Reference" value={result.reference} mono testId="send-done-ref" />
          {result.balanceKobo !== undefined && <DetailRow label="Your new balance" value={formatNaira(result.balanceKobo)} />}
          <div style={{ marginTop: 16 }}><PrimaryButton testId="send-done-close" onClick={onClose}>Done</PrimaryButton></div>
        </div>
      )}
      </>)}
    </Sheet>
  );
}
