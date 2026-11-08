import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The organizer contact card must go through src/lib/contactPhone.ts:
// local Nigerian display, tel:+234..., wa.me/234... Before this fix it used
// the stored digits directly (tel:9152579794, wa.me/9152579794).
const ROOT = join(__dirname, '..', '..');
const details = readFileSync(join(ROOT, 'src/app/components/EventDetailsScreen.tsx'), 'utf8');
const create = readFileSync(join(ROOT, 'src/app/components/CreateEventScreen.tsx'), 'utf8');

describe('organizer contact wiring', () => {
  it('event details shows, dials and opens WhatsApp only through contactPhoneLinks', () => {
    expect(details).toMatch(/const contactPhone = contactPhoneLinks\(event\.contactPhone\)/);
    expect(details).toMatch(/\{contactPhone\.display\}/);
    expect(details).toMatch(/href=\{contactPhone\.telHref\}/);
    expect(details).toMatch(/https:\/\/wa\.me\/\$\{contactPhone\.whatsappNumber\}/);
    expect(details).not.toMatch(/tel:\$\{event\.contactPhone\}/);
    expect(details).not.toMatch(/wa\.me\/\$\{event\.contactPhone/);
  });
  it('create/edit event stores E.164 and splits it back on edit', () => {
    expect(create.match(/toE164ContactPhone\(contactPhoneCountryCode, contactPhone\)/g)?.length).toBe(5);
    expect(create).toMatch(/splitStoredContactPhone\(row\.show_phone \? row\.contact_phone : ''\)/);
    expect(create).not.toMatch(/contact_phone: showPhone \? contactPhone : null/);
  });
});
