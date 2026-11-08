import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrganizerCommissionNotice, TicketNetEarnings, ORGANIZER_COMMISSION_NOTICE } from './OrganizerCommissionNotice';

let container: HTMLDivElement; let root: Root;
function render(el: React.ReactElement) {
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container); act(() => { root.render(el); });
}
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('organizer commission notice (event creation, before publishing)', () => {
  it('states the 3.5% commission with the owner-approved example', () => {
    render(<OrganizerCommissionNotice />);
    expect(container.textContent).toBe(ORGANIZER_COMMISSION_NOTICE);
    expect(container.textContent).toContain('VENTS charges a 3.5% commission on every ticket sold.');
    expect(container.textContent).toContain('a ₦10,000 ticket earns you ₦9,650');
  });
  it('shows the live net per ticket as the price changes', () => {
    render(<TicketNetEarnings price="10000" />);
    expect(container.textContent).toBe('You earn ₦9,650 per ticket (₦10,000 − ₦350 VENTS commission).');
    act(() => { root.render(<TicketNetEarnings price="1001" />); });
    expect(container.textContent).toBe('You earn ₦965.96 per ticket (₦1,001 − ₦35.04 VENTS commission).');
  });
  it('free tickets carry no commission', () => {
    render(<TicketNetEarnings price="" />);
    expect(container.textContent).toBe('Free ticket: no commission is charged.');
  });
  it('is placed in the ticket step for every ticket type, and on the review step', () => {
    const src = readFileSync(join(__dirname, 'CreateEventScreen.tsx'), 'utf8');
    expect(src).toMatch(/Ticket Types<\/p>\n\s+<OrganizerCommissionNotice \/>/);
    expect(src).toMatch(/<TicketNetEarnings price=\{ticket\.price\} \/>/);
    expect(src).toMatch(/label: 'VENTS commission', value: '3\.5% of every ticket sold, deducted automatically'/);
  });
});
