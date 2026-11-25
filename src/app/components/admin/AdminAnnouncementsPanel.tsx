// Announcements manager (Admin Console -> System). Replaces the old
// send-only "Audience Announcement" card with draft -> edit -> publish on
// top of migration 0222 (public.announcements + admin_save_announcement_
// draft / admin_delete_announcement_draft / admin_publish_announcement).
//
// Delivery is unchanged: publishing fans out into the existing
// notifications feed (and therefore push), with the same audiences, mutes
// and notification types as admin_send_announcement (0191). There is still
// exactly one announcement composer in the console.
//
// Before 0222 is applied the announcements table does not exist. The panel
// detects that and falls back to the previous behaviour -- an immediate
// send through admin_send_announcement -- so shipping this UI ahead of the
// migration never removes the ability to send an announcement.
//
// Internal test audience (migration 0223): a fourth chip, "Internal test",
// that delivers only to an explicit allowlist of at most 10 accounts
// (public.announcement_test_recipients), so the full pipeline can be tested
// without reaching real users. The chip appears only when 0223 is applied
// (admin_list_announcement_test_recipients exists); otherwise the panel is
// exactly the three-audience panel above. Publishing to it is disabled
// while the list is empty. Adding/removing recipients is Root-only on the
// server (is_root(), audit-logged), so the management block below renders
// for Root only.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Send, Pencil, Trash2, FilePlus2, FlaskConical, UserPlus, X } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { adminTheme } from './adminConsoleTheme';
import { ConfirmModal } from './adminShared';
import { writeAuditLog } from './adminAuditLog';
import { isRoot as permIsRoot } from '../../../lib/permissions';

export type AnnouncementAudience = 'everyone' | 'organizers' | 'service_providers' | 'internal_test';

export const ANNOUNCEMENT_AUDIENCES: { value: AnnouncementAudience; label: string }[] = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'organizers', label: 'Organizers' },
  { value: 'service_providers', label: 'Service Providers' },
];

// 0223. Not part of ANNOUNCEMENT_AUDIENCES: those are the three production
// audiences; this one is shown only when 0223 is applied.
export const INTERNAL_TEST_AUDIENCE: { value: AnnouncementAudience; label: string } = { value: 'internal_test', label: 'Internal test' };
// Mirrors the server cap in 0223 (enforced on add and again on publish).
export const INTERNAL_TEST_MAX_RECIPIENTS = 10;

// Server-side caps (0191 / 0222). Mirrored for immediate feedback only.
export const ANNOUNCE_TITLE_MAX = 80;
export const ANNOUNCE_BODY_MAX = 500;

interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  audience: AnnouncementAudience;
  status: 'draft' | 'published';
  updated_at: string;
  published_at: string | null;
  recipients: number | null;
}

interface TestRecipient { user_id: string; username: string | null; added_at: string }

const audienceLabel = (a: string) => [...ANNOUNCEMENT_AUDIENCES, INTERNAL_TEST_AUDIENCE].find((x) => x.value === a)?.label ?? a;
const recipientName = (r: TestRecipient) => (r.username ? `@${r.username}` : `${r.user_id.slice(0, 8)}…`);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PostgREST reports a missing table as PGRST205 (schema cache) or 42P01.
function isMissingTableError(err: any): boolean {
  const code = String(err?.code ?? '');
  const text = `${err?.message ?? ''} ${err?.details ?? ''}`;
  return code === 'PGRST205' || code === '42P01' || /announcements/.test(text) && /(does not exist|schema cache|Could not find)/i.test(text);
}

// PostgREST reports a missing function as PGRST202 (schema cache) or 42883.
function isMissingFunctionError(err: any): boolean {
  const code = String(err?.code ?? '');
  const text = `${err?.message ?? ''} ${err?.details ?? ''}`;
  return code === 'PGRST202' || code === '42883' || /admin_list_announcement_test_recipients/.test(text) && /(does not exist|schema cache|Could not find)/i.test(text);
}

function formatWhen(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function AdminAnnouncementsPanel({ currentUser, onFlash }: {
  currentUser: { id: string; role?: string };
  onFlash: (ok: boolean, text: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<AnnouncementAudience>('everyone');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'save' | 'publish' | 'delete' | 'recipients'>(null);
  const [rows, setRows] = useState<AnnouncementRow[]>([]);
  // null = still checking; false = 0222 not applied (legacy immediate send).
  const [draftsAvailable, setDraftsAvailable] = useState<boolean | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  // 0223: internalAvailable false = not applied (no Internal test chip). testRecipients null =
  // list not loaded/failed -> publishing to Internal test stays disabled.
  const [internalAvailable, setInternalAvailable] = useState(false);
  const [testRecipients, setTestRecipients] = useState<TestRecipient[] | null>(null);
  const [testRecipientsError, setTestRecipientsError] = useState<string | null>(null);
  const [newRecipientId, setNewRecipientId] = useState('');
  const isRootUser = permIsRoot(currentUser as any);
  // A second click on ConfirmModal's Confirm lands before React re-renders
  // with the new busy state; a synchronous ref closes that double-send race.
  const inFlight = useRef(false);
  const [confirm, setConfirm] = useState<null | { title: string; message: string; confirmLabel: string; danger: boolean; onConfirm: () => void }>(null);

  const titleTrimmed = title.trim();
  const bodyTrimmed = body.trim();
  const valid = !!titleTrimmed && !!bodyTrimmed && titleTrimmed.length <= ANNOUNCE_TITLE_MAX && bodyTrimmed.length <= ANNOUNCE_BODY_MAX;
  const label = audienceLabel(audience);
  const isInternal = audience === 'internal_test';
  const recipientCount = testRecipients?.length ?? 0;
  // Empty-list and 10-recipient safeguards (the server refuses both too).
  const internalBlocked = isInternal && (testRecipients === null || recipientCount === 0 || recipientCount > INTERNAL_TEST_MAX_RECIPIENTS);

  const loadTestRecipients = useCallback(async () => {
    setTestRecipientsError(null);
    let data: any = null; let error: any = null;
    try {
      ({ data, error } = await supabase.rpc('admin_list_announcement_test_recipients'));
    } catch (err: any) {
      error = err ?? { message: 'Could not load internal test recipients.' };
    }
    if (error) {
      if (isMissingFunctionError(error)) { setInternalAvailable(false); setTestRecipients(null); return; }
      setInternalAvailable(true); setTestRecipients(null);
      setTestRecipientsError(error.message || 'Could not load internal test recipients.');
      return;
    }
    if (!Array.isArray(data)) { setInternalAvailable(false); setTestRecipients(null); return; }
    setInternalAvailable(true);
    setTestRecipients(data as TestRecipient[]);
  }, []);

  const load = useCallback(async () => {
    setListError(null);
    let data: any = null; let error: any = null;
    try {
      ({ data, error } = await supabase
        .from('announcements')
        .select('id, title, body, audience, status, updated_at, published_at, recipients')
        .order('updated_at', { ascending: false })
        .limit(50));
    } catch (err: any) {
      error = err ?? { message: 'Could not load announcements.' };
    }
    if (error) {
      if (isMissingTableError(error)) { setDraftsAvailable(false); return; }
      setDraftsAvailable(true);
      setListError(error.message || 'Could not load announcements.');
      return;
    }
    setDraftsAvailable(true);
    setRows((data ?? []) as AnnouncementRow[]);
    await loadTestRecipients();
  }, [loadTestRecipients]);

  useEffect(() => { load(); }, [load]);

  const resetComposer = () => { setTitle(''); setBody(''); setAudience('everyone'); setEditingId(null); };

  const saveDraft = async (): Promise<string | null> => {
    const { data, error } = await supabase.rpc('admin_save_announcement_draft', {
      p_id: editingId, p_audience: audience, p_title: titleTrimmed, p_body: bodyTrimmed,
    });
    if (error) throw error;
    return (data as string) ?? null;
  };

  const handleSaveDraft = async () => {
    if (!valid || busy || draftsAvailable !== true) return;
    setBusy('save');
    try {
      const id = await saveDraft();
      setEditingId(id);
      onFlash(true, 'Draft saved. It has not been sent to anyone.');
      await load();
    } catch (err: any) {
      onFlash(false, err?.message || 'Failed to save draft.');
    } finally { setBusy(null); }
  };

  const doPublish = async () => {
    if (inFlight.current || internalBlocked) return;
    inFlight.current = true;
    setConfirm(null);
    setBusy('publish');
    const t = titleTrimmed; const a = audience; const l = label;
    try {
      let recipients = 0;
      if (draftsAvailable === true) {
        // Save first so what is published is exactly what is on screen.
        const id = await saveDraft();
        const { data, error } = await supabase.rpc('admin_publish_announcement', { p_id: id });
        if (error) { if (id) setEditingId(id); throw error; }
        recipients = (data as any)?.recipients ?? 0;
      } else {
        const { data, error } = await supabase.rpc('admin_send_announcement', { p_audience: a, p_title: t, p_body: bodyTrimmed });
        if (error) throw error;
        recipients = (data as any)?.recipients ?? 0;
      }
      await writeAuditLog(currentUser, 'ROOT_announcement', null, { audience: a, title: t, recipients });
      resetComposer();
      onFlash(true, `Announcement published to ${recipients} ${l.toLowerCase()} recipient${recipients === 1 ? '' : 's'}.`);
      if (draftsAvailable === true) await load();
    } catch (err: any) {
      onFlash(false, err?.message || 'Failed to publish announcement.');
      if (draftsAvailable === true) await load();
    } finally { setBusy(null); inFlight.current = false; }
  };

  const handlePublish = () => {
    if (!valid || busy || internalBlocked) return;
    const target = isInternal
      ? `${label} (${recipientCount} account${recipientCount === 1 ? '' : 's'}: ${(testRecipients ?? []).map(recipientName).join(', ')})`
      : label;
    setConfirm({
      title: 'Publish Announcement',
      message: `Publish "${titleTrimmed}" to ${target}? Recipients are notified immediately (in-app and by push) and it cannot be edited afterwards.`,
      confirmLabel: 'Publish', danger: false,
      onConfirm: doPublish,
    });
  };

  const handleEdit = (row: AnnouncementRow) => {
    if (row.status !== 'draft' || busy) return;
    setEditingId(row.id); setTitle(row.title); setBody(row.body); setAudience(row.audience);
  };

  const handleDelete = (row: AnnouncementRow) => {
    if (row.status !== 'draft' || busy) return;
    setConfirm({
      title: 'Delete Draft', message: `Delete the draft "${row.title}"? It was never sent.`, confirmLabel: 'Delete', danger: true,
      onConfirm: async () => {
        setConfirm(null); setBusy('delete');
        try {
          const { error } = await supabase.rpc('admin_delete_announcement_draft', { p_id: row.id });
          if (error) throw error;
          if (editingId === row.id) resetComposer();
          onFlash(true, 'Draft deleted.');
          await load();
        } catch (err: any) { onFlash(false, err?.message || 'Failed to delete draft.'); } finally { setBusy(null); }
      },
    });
  };

  // ── Internal test recipients (Root only; server enforces is_root()) ──
  const changeRecipient = async (fn: 'admin_add_announcement_test_recipient' | 'admin_remove_announcement_test_recipient', userId: string, okText: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setConfirm(null); setBusy('recipients');
    try {
      const { error } = await supabase.rpc(fn, { p_user_id: userId });
      if (error) throw error;
      onFlash(true, okText);
      if (fn === 'admin_add_announcement_test_recipient') setNewRecipientId('');
    } catch (err: any) {
      onFlash(false, err?.message || 'Failed to update internal test recipients.');
    } finally {
      await loadTestRecipients();
      setBusy(null); inFlight.current = false;
    }
  };
  const atCap = recipientCount >= INTERNAL_TEST_MAX_RECIPIENTS;
  const rootListed = !!testRecipients?.some((r) => r.user_id === currentUser.id);
  const newIdTrimmed = newRecipientId.trim();
  const newIdValid = UUID_RE.test(newIdTrimmed);
  const handleAddSelf = () => {
    if (busy || atCap || rootListed) return;
    changeRecipient('admin_add_announcement_test_recipient', currentUser.id, 'You were added to the internal test audience.');
  };
  const handleAddById = () => {
    if (busy || atCap || !newIdValid) return;
    setConfirm({
      title: 'Add Internal Test Recipient',
      message: `Add user ${newIdTrimmed} to the internal test audience? They will receive every Internal test announcement (in-app and by push) until removed.`,
      confirmLabel: 'Add', danger: false,
      onConfirm: () => changeRecipient('admin_add_announcement_test_recipient', newIdTrimmed, 'Internal test recipient added.'),
    });
  };
  const handleRemoveRecipient = (r: TestRecipient) => {
    if (busy) return;
    changeRecipient('admin_remove_announcement_test_recipient', r.user_id, `${recipientName(r)} removed from the internal test audience.`);
  };

  const drafts = rows.filter((r) => r.status === 'draft');
  const published = rows.filter((r) => r.status === 'published');
  const disabled = !!busy;

  const chip = (selected: boolean) => ({
    padding: '6px 12px', borderRadius: 100, fontSize: 12, fontWeight: 700, cursor: disabled ? 'default' : 'pointer',
    background: selected ? adminTheme.accentSoftBg : adminTheme.panelAlt,
    border: `1px solid ${selected ? adminTheme.accentSoftBorder : adminTheme.border}`,
    color: selected ? adminTheme.accentFrom : adminTheme.textFaint,
  } as const);
  const field = { background: adminTheme.panelAlt, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 12, color: adminTheme.text, fontSize: 13, outline: 'none' } as const;

  return (
    <div data-testid="announcement-card" style={{ background: adminTheme.panel, borderRadius: 16, border: `1px solid ${adminTheme.border}`, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: adminTheme.accentSoftBg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Send size={17} color={adminTheme.accentFrom} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ color: adminTheme.textStrong, fontSize: 14, fontWeight: 600, margin: 0 }}>Announcements</p>
          <p style={{ color: adminTheme.textFaint, fontSize: 11, margin: '2px 0 0' }}>Draft, edit and publish announcements to Everyone, Organizers, or Service Providers</p>
        </div>
        {editingId && (
          <button type="button" onClick={resetComposer} disabled={disabled} aria-label="New announcement" style={{ ...chip(false), display: 'flex', alignItems: 'center', gap: 4 }}>
            <FilePlus2 size={12} /> New
          </button>
        )}
      </div>

      {draftsAvailable === false && (
        <p data-testid="announcement-legacy-notice" style={{ color: adminTheme.textFaint, fontSize: 11, margin: 0, padding: '8px 10px', borderRadius: 10, background: adminTheme.panelAlt, border: `1px solid ${adminTheme.border}` }}>
          Drafts are not available yet (database migration 0222 not applied). Publishing sends immediately.
        </p>
      )}
      {editingId && (
        <p data-testid="announcement-editing" style={{ color: adminTheme.accentFrom, fontSize: 11, fontWeight: 700, margin: 0 }}>Editing draft</p>
      )}

      <div role="radiogroup" aria-label="Announcement audience" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {[...ANNOUNCEMENT_AUDIENCES, ...(internalAvailable && draftsAvailable === true ? [INTERNAL_TEST_AUDIENCE] : [])].map((a) => (
          <button key={a.value} type="button" role="radio" aria-checked={audience === a.value} onClick={() => setAudience(a.value)} disabled={disabled} style={chip(audience === a.value)}>
            {a.label}
          </button>
        ))}
      </div>
      <p style={{ color: adminTheme.textFaint, fontSize: 11, margin: 0 }}>
        Sending to: <span style={{ color: adminTheme.textStrong, fontWeight: 700 }}>{label}</span>
      </p>
      {isInternal && (
        <div data-testid="internal-test-audience" style={{ padding: '8px 10px', borderRadius: 10, background: adminTheme.panelAlt, border: `1px solid ${adminTheme.border}`, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <p style={{ color: adminTheme.textFaint, fontSize: 11, margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
            <FlaskConical size={12} /> Only explicitly designated test accounts receive this ({recipientCount}/{INTERNAL_TEST_MAX_RECIPIENTS}){recipientCount > 0 ? `: ${(testRecipients ?? []).map(recipientName).join(', ')}` : ''}.
          </p>
          {testRecipientsError && <p style={{ color: adminTheme.red, fontSize: 11, margin: 0 }}>{testRecipientsError}</p>}
          {testRecipients !== null && recipientCount === 0 && (
            <p data-testid="internal-test-empty" style={{ color: adminTheme.red, fontSize: 11, fontWeight: 700, margin: 0 }}>
              No internal test recipients are designated, so publishing is disabled.{isRootUser ? ' Add one below.' : ' Only Root can add recipients.'}
            </p>
          )}
          {isRootUser && (
            <div data-testid="internal-test-recipients" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(testRecipients ?? []).map((r) => (
                <div key={r.user_id} data-testid="internal-test-recipient-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flex: 1, color: adminTheme.textStrong, fontSize: 12 }}>{recipientName(r)}{r.user_id === currentUser.id ? ' (you)' : ''}</span>
                  <button type="button" aria-label={`Remove ${recipientName(r)} from internal test`} onClick={() => handleRemoveRecipient(r)} disabled={disabled} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}><X size={14} color={adminTheme.red} /></button>
                </div>
              ))}
              {testRecipients !== null && (atCap ? (
                <p data-testid="internal-test-cap" style={{ color: adminTheme.textFaint, fontSize: 11, margin: 0 }}>Limit of {INTERNAL_TEST_MAX_RECIPIENTS} recipients reached. Remove one to add another.</p>
              ) : (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {!rootListed && (
                    <button type="button" onClick={handleAddSelf} disabled={disabled} style={{ ...chip(false), display: 'flex', alignItems: 'center', gap: 4 }}><UserPlus size={12} /> Add me</button>
                  )}
                  <input value={newRecipientId} onChange={(e) => setNewRecipientId(e.target.value)} placeholder="User ID to add" aria-label="User ID to add to internal test" disabled={disabled} style={{ ...field, flex: 1, minWidth: 160, padding: '6px 10px', fontSize: 12 }} />
                  <button type="button" onClick={handleAddById} disabled={disabled || !newIdValid} style={{ ...chip(false), opacity: newIdValid ? 1 : 0.5 }}>Add</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" maxLength={ANNOUNCE_TITLE_MAX} disabled={disabled} style={field} />
      <p style={{ color: adminTheme.textFainter, fontSize: 10, margin: '-6px 0 0', textAlign: 'right' }}>{titleTrimmed.length}/{ANNOUNCE_TITLE_MAX}</p>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Message" rows={4} maxLength={ANNOUNCE_BODY_MAX} disabled={disabled} style={{ ...field, resize: 'none' }} />
      <p style={{ color: adminTheme.textFainter, fontSize: 10, margin: '-6px 0 0', textAlign: 'right' }}>{bodyTrimmed.length}/{ANNOUNCE_BODY_MAX}</p>

      <div style={{ display: 'flex', gap: 8 }}>
        {draftsAvailable === true && (
          <button type="button" onClick={handleSaveDraft} disabled={disabled || !valid} style={{ flex: 1, background: adminTheme.panelAlt, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 12, color: valid ? adminTheme.textStrong : adminTheme.textFainter, fontSize: 13, fontWeight: 700, cursor: valid && !disabled ? 'pointer' : 'default' }}>
            {busy === 'save' ? 'Saving…' : editingId ? 'Update draft' : 'Save draft'}
          </button>
        )}
        <button type="button" onClick={handlePublish} disabled={disabled || !valid || draftsAvailable === null || internalBlocked} style={{ flex: 2, background: valid ? adminTheme.accentSoftBg : adminTheme.panelAlt, border: `1px solid ${valid ? adminTheme.accentSoftBorder : adminTheme.border}`, borderRadius: 12, padding: 12, color: valid ? adminTheme.accentFrom : adminTheme.textFainter, fontSize: 14, fontWeight: 700, cursor: valid && !disabled ? 'pointer' : 'default' }}>
          {busy === 'publish' ? 'Publishing…' : `📣 Publish to ${label}`}
        </button>
      </div>

      {listError && <p style={{ color: adminTheme.red, fontSize: 11, margin: 0 }}>{listError}</p>}

      {draftsAvailable === true && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ color: adminTheme.textFaint, fontSize: 11, fontWeight: 700, margin: '4px 0 0', textTransform: 'uppercase', letterSpacing: 0.4 }}>Drafts ({drafts.length})</p>
          {drafts.length === 0 && <p style={{ color: adminTheme.textFainter, fontSize: 11, margin: 0 }}>No drafts.</p>}
          {drafts.map((r) => (
            <div key={r.id} data-testid="announcement-draft-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 10, background: r.id === editingId ? adminTheme.accentSoftBg : adminTheme.panelAlt, border: `1px solid ${adminTheme.border}` }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ color: adminTheme.textStrong, fontSize: 12, fontWeight: 700, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</p>
                <p style={{ color: adminTheme.textFaint, fontSize: 10, margin: '2px 0 0' }}>{audienceLabel(r.audience)} · edited {formatWhen(r.updated_at)}</p>
              </div>
              <button type="button" aria-label={`Edit draft ${r.title}`} onClick={() => handleEdit(r)} disabled={disabled} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}><Pencil size={14} color={adminTheme.textFaint} /></button>
              <button type="button" aria-label={`Delete draft ${r.title}`} onClick={() => handleDelete(r)} disabled={disabled} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}><Trash2 size={14} color={adminTheme.red} /></button>
            </div>
          ))}
          <p style={{ color: adminTheme.textFaint, fontSize: 11, fontWeight: 700, margin: '6px 0 0', textTransform: 'uppercase', letterSpacing: 0.4 }}>Published ({published.length})</p>
          {published.length === 0 && <p style={{ color: adminTheme.textFainter, fontSize: 11, margin: 0 }}>Nothing published yet.</p>}
          {published.map((r) => (
            <div key={r.id} data-testid="announcement-published-row" style={{ padding: '8px 10px', borderRadius: 10, background: adminTheme.panelAlt, border: `1px solid ${adminTheme.border}` }}>
              <p style={{ color: adminTheme.textStrong, fontSize: 12, fontWeight: 700, margin: 0 }}>{r.title}</p>
              <p style={{ color: adminTheme.textFaint, fontSize: 10, margin: '2px 0 0' }}>{audienceLabel(r.audience)} · {r.recipients ?? 0} recipient{r.recipients === 1 ? '' : 's'} · {formatWhen(r.published_at)}</p>
            </div>
          ))}
        </div>
      )}

      {confirm && (
        <ConfirmModal title={confirm.title} message={confirm.message} confirmLabel={confirm.confirmLabel} danger={confirm.danger} onConfirm={confirm.onConfirm} onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
}
