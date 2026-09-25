import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { DobPicker } from './DobPicker';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(ui);
  });
  return container;
}

function setYear(el: HTMLDivElement, year: string) {
  const input = el.querySelector('[data-testid="dob-year-input"]') as HTMLInputElement;
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    nativeSetter.call(input, year);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function clickMonth(el: HTMLDivElement, mm: string) {
  const btn = el.querySelector(`[data-testid="dob-month-${mm}"]`) as HTMLButtonElement;
  act(() => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function clickDay(el: HTMLDivElement, dd: string) {
  const btn = el.querySelector(`[data-testid="dob-day-${dd}"]`) as HTMLButtonElement;
  act(() => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-20T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
});

describe('DobPicker', () => {
  it('selects a recent year (2005) via direct digit entry, no scrolling widget involved', () => {
    const onChange = vi.fn();
    const el = render(<DobPicker value="" onChange={onChange} />);
    // The year field is a plain numeric text input, not a <select> -- so
    // there is no 100+ <option> element to render/scroll through.
    const yearInput = el.querySelector('[data-testid="dob-year-input"]');
    expect(yearInput?.tagName).toBe('INPUT');
    expect(el.querySelector('select')).toBeNull();

    setYear(el, '2005');
    clickMonth(el, '06');
    clickDay(el, '15');
    expect(onChange).toHaveBeenLastCalledWith('2005-06-15');
  });

  it('selects an older year (1985) exactly as fast as a recent one -- same three interactions', () => {
    const onChange = vi.fn();
    const el = render(<DobPicker value="" onChange={onChange} />);
    setYear(el, '1985');
    clickMonth(el, '03');
    clickDay(el, '02');
    expect(onChange).toHaveBeenLastCalledWith('1985-03-02');
  });

  it('offers Feb 29 only in a leap year', () => {
    const onChange = vi.fn();
    const el = render(<DobPicker value="" onChange={onChange} />);
    setYear(el, '2000'); // leap year
    clickMonth(el, '02');
    expect(el.querySelector('[data-testid="dob-day-29"]')).not.toBeNull();
    clickDay(el, '29');
    expect(onChange).toHaveBeenLastCalledWith('2000-02-29');
  });

  it('caps February at 28 days in a non-leap year, with day 29 absent', () => {
    const onChange = vi.fn();
    const el = render(<DobPicker value="" onChange={onChange} />);
    setYear(el, '2001'); // not a leap year
    clickMonth(el, '02');
    expect(el.querySelector('[data-testid="dob-day-29"]')).toBeNull();
    clickDay(el, '28');
    expect(onChange).toHaveBeenLastCalledWith('2001-02-28');
  });

  it('blocks selecting a future month within the current year', () => {
    const onChange = vi.fn();
    // "today" is fixed at 2026-09-20 above.
    const el = render(<DobPicker value="" onChange={onChange} />);
    setYear(el, '2026');
    const decBtn = el.querySelector('[data-testid="dob-month-12"]') as HTMLButtonElement;
    expect(decBtn.disabled).toBe(true);
    clickMonth(el, '12');
    expect(onChange).not.toHaveBeenCalled();
    // The current month is selectable.
    clickMonth(el, '09');
    expect(onChange).not.toHaveBeenCalled(); // day not chosen yet
  });

  it('blocks selecting a future day within the current month/year', () => {
    const onChange = vi.fn();
    const el = render(<DobPicker value="" onChange={onChange} />);
    setYear(el, '2026');
    clickMonth(el, '09');
    const futureDayBtn = el.querySelector('[data-testid="dob-day-25"]') as HTMLButtonElement;
    expect(futureDayBtn.disabled).toBe(true);
    clickDay(el, '25');
    expect(onChange).not.toHaveBeenCalled();
    clickDay(el, '20'); // today, still allowed
    expect(onChange).toHaveBeenLastCalledWith('2026-09-20');
  });

  it('rejects a future year outright', () => {
    const onChange = vi.fn();
    const el = render(<DobPicker value="" onChange={onChange} />);
    setYear(el, '2030');
    expect(el.textContent).toContain("Year can't be in the future.");
    // No month becomes enabled for a future year.
    const janBtn = el.querySelector('[data-testid="dob-month-01"]') as HTMLButtonElement;
    expect(janBtn.disabled).toBe(true);
  });

  it('initializes from an existing ISO value (e.g. editing a pre-filled dob)', () => {
    const onChange = vi.fn();
    const el = render(<DobPicker value="1990-11-04" onChange={onChange} />);
    const yearInput = el.querySelector('[data-testid="dob-year-input"]') as HTMLInputElement;
    expect(yearInput.value).toBe('1990');
    const novBtn = el.querySelector('[data-testid="dob-month-11"]') as HTMLButtonElement;
    expect(novBtn.getAttribute('aria-pressed')).toBe('true');
    const dayBtn = el.querySelector('[data-testid="dob-day-04"]') as HTMLButtonElement;
    expect(dayBtn.getAttribute('aria-pressed')).toBe('true');
  });
});
