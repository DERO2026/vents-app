import { describe, it, expect } from 'vitest';
import {
  firstAvailableTicketId, initialTicketQuantities, nextQuantity, maxQuantity, selectionProblem, selectionLabel,
  isFreeSelection, isTicketAvailable,
} from './ticketSelection';

const GUYS = { id: 'g', name: 'Guys', price: 70000, available: 3 };
const LADIES = { id: 'l', name: 'Ladies', price: 20000, available: 0 };
const VIP = { id: 'v', name: 'VIP', price: 100000, available: null };

describe('ticket selection (one category per order)', () => {
  it('pre-selects the first available category, skipping sold-out ones', () => {
    expect(firstAvailableTicketId([LADIES, GUYS])).toBe('g');
    expect(firstAvailableTicketId([LADIES])).toBe('');
  });
  it('quantity 1 only for the pre-selected available category; sold-out categories are 0', () => {
    expect(initialTicketQuantities([LADIES, GUYS, VIP])).toEqual({ l: 0, g: 1, v: 0 });
    expect(initialTicketQuantities([LADIES])).toEqual({ l: 0 });
  });
  it('quantities are clamped to what is left (unchanged: 10 when no count is published)', () => {
    expect(maxQuantity(GUYS)).toBe(3);
    expect(maxQuantity(VIP)).toBe(10);
    expect(maxQuantity(LADIES)).toBe(0);
    expect(nextQuantity(GUYS, 3, 1)).toBe(3);
    expect(nextQuantity(GUYS, 0, -1)).toBe(0);
    expect(nextQuantity(LADIES, 0, 1)).toBe(0);
  });
  it('invalid selections cannot be bought', () => {
    expect(selectionProblem(undefined, 1)).toBe('none_selected');
    expect(selectionProblem(LADIES, 1)).toBe('sold_out');
    expect(selectionProblem(GUYS, 0)).toBe('zero_quantity');
    expect(selectionProblem(GUYS, 4)).toBe('too_many');
    expect(selectionProblem(GUYS, 2)).toBeNull();
  });
  it('the label is the selected category and quantity, never a minimum price', () => {
    expect(selectionLabel(GUYS, 1)).toBe('Guys × 1');
    expect(selectionLabel({ ...GUYS, name: 'Ladies' }, 2)).toBe('Ladies × 2');
    expect(selectionLabel(undefined, 0)).toBe('Select a ticket');
    expect(selectionLabel(GUYS, 1)).not.toMatch(/from/i);
  });
  it('free tickets are recognised; availability of an unlimited category', () => {
    expect(isFreeSelection({ id: 'f', name: 'Free', price: 0 }, 1)).toBe(true);
    expect(isFreeSelection(GUYS, 1)).toBe(false);
    expect(isTicketAvailable(VIP)).toBe(true);
  });
});
