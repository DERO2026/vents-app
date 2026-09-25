// VENTS-native date-of-birth picker.
//
// Replaces the native `<input type="date">` used on the signup form.
// That control is reliable on desktop and iOS Safari, but on Android
// Chrome it opens a full calendar-grid dialog with only prev/next-month
// arrows -- reaching a birth year like 1985 or 1990 from "today" means
// stepping the month arrow ~450-500 times, or hunting for a small year
// spinner buried in the dialog chrome. There is no fast "jump to year"
// affordance, which is exactly the complaint this component fixes.
//
// Design: year is entered directly as digits (fastest possible input for
// "far back" years -- no scrolling/tapping at all), then month and day are
// picked from compact tap-friendly grids. The day grid is (re)computed from
// the selected year+month so it always reflects the real number of days,
// leap years included. Selecting a future month/day is disabled outright,
// and the emitted value is the same `YYYY-MM-DD` string the native input
// produced, so callers (and their validation) don't need to change.
import { useMemo, useState } from 'react';
import { ventsColors, ventsTypography } from '../../lib/ventsDesignTokens';

export interface DobPickerProps {
  /** ISO `YYYY-MM-DD`, or '' when nothing has been picked yet. */
  value: string;
  /** Called with an ISO `YYYY-MM-DD` string once year, month and day are all set. */
  onChange: (value: string) => void;
  /** Mirrors the field-level error styling the old input used. */
  hasError?: boolean;
  background?: string;
  borderColor?: string;
  radius?: string;
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function daysInMonth(year: number, month1to12: number): number {
  // Day 0 of the *next* month is the last day of this one -- correctly
  // resolves leap years (Feb has 29 days whenever `year` is a leap year).
  return new Date(year, month1to12, 0).getDate();
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function parseValue(value: string): { year: string; month: string; day: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!m) return { year: '', month: '', day: '' };
  return { year: m[1], month: m[2], day: m[3] };
}

export function DobPicker({
  value,
  onChange,
  hasError = false,
  background = ventsColors.elevated,
  borderColor = ventsColors.glassBorder,
  radius = '14px',
}: DobPickerProps) {
  const parsed = parseValue(value);
  const [year, setYear] = useState(parsed.year);
  const [month, setMonth] = useState(parsed.month);
  const [day, setDay] = useState(parsed.day);

  const now = useMemo(() => new Date(), []);
  const todayYear = now.getFullYear();
  const todayMonth = now.getMonth() + 1;
  const todayDay = now.getDate();

  const yearNum = year.length === 4 ? parseInt(year, 10) : null;
  const monthNum = month ? parseInt(month, 10) : null;

  const isFutureYear = yearNum !== null && yearNum > todayYear;
  const maxMonthForYear = yearNum === todayYear ? todayMonth : 12;
  const dayCount = yearNum !== null && monthNum !== null ? daysInMonth(yearNum, monthNum) : 31;
  const maxDayForSelection = yearNum === todayYear && monthNum === todayMonth ? todayDay : dayCount;

  const emit = (y: string, m: string, d: string) => {
    if (y.length === 4 && m && d) {
      onChange(`${y}-${m}-${d}`);
    }
  };

  const handleYearChange = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, 4);
    setYear(digits);
    // A year change can invalidate the previously-picked month/day (e.g.
    // switching to the current year while March 15 was selected, and
    // today is only Feb 3) -- clear whichever no longer fits.
    let nextMonth = month;
    let nextDay = day;
    const yNum = digits.length === 4 ? parseInt(digits, 10) : null;
    if (yNum === todayYear && nextMonth && parseInt(nextMonth, 10) > todayMonth) {
      nextMonth = '';
      nextDay = '';
    }
    if (yNum !== null && nextMonth) {
      const maxD = yNum === todayYear && parseInt(nextMonth, 10) === todayMonth
        ? todayDay
        : daysInMonth(yNum, parseInt(nextMonth, 10));
      if (nextDay && parseInt(nextDay, 10) > maxD) nextDay = '';
    }
    if (nextMonth !== month) setMonth(nextMonth);
    if (nextDay !== day) setDay(nextDay);
    emit(digits, nextMonth, nextDay);
  };

  const handleMonthSelect = (m: number) => {
    if (yearNum === todayYear && m > todayMonth) return; // future month, blocked
    const mm = pad2(m);
    let nextDay = day;
    if (nextDay && yearNum !== null) {
      const maxD = yearNum === todayYear && m === todayMonth ? todayDay : daysInMonth(yearNum, m);
      if (parseInt(nextDay, 10) > maxD) nextDay = '';
    }
    setMonth(mm);
    if (nextDay !== day) setDay(nextDay);
    emit(year, mm, nextDay);
  };

  const handleDaySelect = (d: number) => {
    if (d > maxDayForSelection) return; // future date, blocked
    const dd = pad2(d);
    setDay(dd);
    emit(year, month, dd);
  };

  const dayOptions = Array.from({ length: dayCount }, (_, i) => i + 1);
  const yearComplete = year.length === 4 && !isFutureYear;

  return (
    <div
      style={{
        width: '100%',
        maxWidth: '320px',
        background,
        border: `1px solid ${hasError ? 'rgba(239,68,68,0.6)' : borderColor}`,
        borderRadius: radius,
        padding: '14px 16px',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
      }}
    >
      {/* Year: direct digit entry -- the fastest path to "far back" years,
          no scrolling required at all. */}
      <div>
        <label
          htmlFor="dob-year-input"
          style={{
            display: 'block', color: '#94A3B8', fontSize: '11px', fontWeight: 700,
            marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.08em',
          }}
        >
          Year
        </label>
        <input
          id="dob-year-input"
          data-testid="dob-year-input"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={4}
          placeholder="e.g. 1990"
          value={year}
          onChange={(e) => handleYearChange(e.target.value)}
          aria-label="Birth year"
          style={{
            width: '100%', height: '48px', background: 'rgba(255,255,255,0.04)',
            border: `1px solid ${isFutureYear ? 'rgba(239,68,68,0.6)' : ventsColors.border}`,
            borderRadius: '10px', padding: '0 14px', color: '#FFFFFF', fontSize: '18px',
            fontWeight: 700, letterSpacing: '0.04em', outline: 'none', boxSizing: 'border-box',
            fontFamily: ventsTypography.fontMono,
          }}
        />
        {isFutureYear && (
          <p style={{ color: '#EF4444', fontSize: '11px', marginTop: '4px' }}>
            Year can't be in the future.
          </p>
        )}
      </div>

      {/* Month: compact 12-option grid, only usable once a valid year is set. */}
      <div>
        <span
          style={{
            display: 'block', color: '#94A3B8', fontSize: '11px', fontWeight: 700,
            marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.08em',
          }}
        >
          Month
        </span>
        <div
          role="group"
          aria-label="Birth month"
          style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px' }}
        >
          {MONTHS.map((label, idx) => {
            const m = idx + 1;
            const mm = pad2(m);
            const disabled = !yearComplete || m > maxMonthForYear;
            const selected = month === mm;
            return (
              <button
                key={mm}
                type="button"
                data-testid={`dob-month-${mm}`}
                disabled={disabled}
                aria-pressed={selected}
                onClick={() => handleMonthSelect(m)}
                style={{
                  minHeight: '40px', borderRadius: '8px', fontSize: '13px', fontWeight: 700,
                  border: `1px solid ${selected ? ventsColors.accent : ventsColors.border}`,
                  background: selected ? 'rgba(142,92,247,0.22)' : 'rgba(255,255,255,0.03)',
                  color: disabled ? 'rgba(148,163,184,0.4)' : selected ? '#FFFFFF' : '#CBD5E1',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  opacity: disabled ? 0.5 : 1,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Day: grid sized to the actual month+year, so Feb only ever shows
          28 or 29 options depending on leap years. */}
      <div>
        <span
          style={{
            display: 'block', color: '#94A3B8', fontSize: '11px', fontWeight: 700,
            marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.08em',
          }}
        >
          Day
        </span>
        <div
          role="group"
          aria-label="Birth day"
          style={{
            display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '6px',
            maxHeight: '168px', overflowY: 'auto',
          }}
        >
          {dayOptions.map((d) => {
            const dd = pad2(d);
            const disabled = !month || d > maxDayForSelection;
            const selected = day === dd;
            return (
              <button
                key={dd}
                type="button"
                data-testid={`dob-day-${dd}`}
                disabled={disabled}
                aria-pressed={selected}
                onClick={() => handleDaySelect(d)}
                style={{
                  minHeight: '36px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                  border: `1px solid ${selected ? ventsColors.accent : ventsColors.border}`,
                  background: selected ? 'rgba(142,92,247,0.22)' : 'rgba(255,255,255,0.03)',
                  color: disabled ? 'rgba(148,163,184,0.4)' : selected ? '#FFFFFF' : '#CBD5E1',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  opacity: disabled ? 0.5 : 1,
                }}
              >
                {d}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
