import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TIMEZONES, findTimezoneById, formatUtcOffset, type TimezoneOption } from '@shared/timezones-data';

interface TimezoneSettingProps {
  current: string | null;
  set: (tz: string) => Promise<{ ok: boolean; error?: string }>;
}

/** Short offset chip text ("UTC+7", "UTC-5:30") shown when the picker is closed. */
function offsetLabel(id: string | null): string {
  if (!id) return '';
  const entry = findTimezoneById(id);
  if (entry) return entry.utcOffset;
  return formatUtcOffset(id);
}

// Matches the system menu's min-w-[320px] so the picker visually nests
// under the trigger row instead of floating as an orphan panel.
const LIST_WIDTH = 320;
const LIST_MAX_HEIGHT = 360;

/** Match against label (city), IANA id, and UTC offset — case-insensitive substring. */
function filterTimezones(query: string): readonly TimezoneOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return TIMEZONES;
  return TIMEZONES.filter(
    (tz) =>
      tz.label.toLowerCase().includes(q) ||
      tz.id.toLowerCase().includes(q) ||
      tz.utcOffset.toLowerCase().includes(q),
  );
}

/**
 * Compact button that opens a portaled, filterable list of curated
 * Windows-labelled timezones. Closed state is just a tiny offset chip;
 * open state renders a search input + listbox at document.body so it
 * can't overflow the system menu's popover.
 *
 * Keyboard: ArrowUp/Down moves the active row, Enter picks it,
 * Escape closes. Typing in the input filters by city, IANA key, or
 * UTC offset.
 */
export function TimezoneSetting({ current, set }: TimezoneSettingProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // First scroll after open should center the seeded row; subsequent
  // keyboard navigation should only nudge it into view.
  const initialScrollRef = useRef(false);

  const filtered = useMemo(() => filterTimezones(query), [query]);

  // Anchor the list to the chip's right edge; viewport-clamp so it stays
  // visible when the chip is close to the screen edge.
  useLayoutEffect(() => {
    if (!open) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(window.innerWidth - LIST_WIDTH - 8, r.right - LIST_WIDTH));
    const top = Math.min(window.innerHeight - LIST_MAX_HEIGHT - 8, r.bottom + 4);
    setPos({ top, left });
  }, [open]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btnRef.current?.contains(t) && !popoverRef.current?.contains(t)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  // Reset search + active row when opening; focus input + seed active
  // row to the current tz (or first row) so Enter is meaningful.
  useEffect(() => {
    if (!open) {
      initialScrollRef.current = false;
      return;
    }
    setQuery('');
    setError(null);
    const seedIdx = current ? TIMEZONES.findIndex((t) => t.id === current) : 0;
    setActiveIndex(seedIdx >= 0 ? seedIdx : 0);
    initialScrollRef.current = true;
    // Defer focus until after the portal mounts.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, current]);

  // Clamp active index when the filtered list shrinks.
  useEffect(() => {
    if (activeIndex >= filtered.length) setActiveIndex(Math.max(0, filtered.length - 1));
  }, [filtered, activeIndex]);

  // Scroll the active row into view as the user navigates. First scroll
  // after opening centers the seeded row so the current timezone is
  // obvious; later nav keys only nudge it into view.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    if (!el) return;
    const block: ScrollLogicalPosition = initialScrollRef.current ? 'center' : 'nearest';
    initialScrollRef.current = false;
    el.scrollIntoView({ block });
  }, [open, activeIndex]);

  const onPick = useCallback(
    async (id: string) => {
      if (id === current) {
        setOpen(false);
        return;
      }
      setSaving(true);
      setError(null);
      const r = await set(id);
      setSaving(false);
      if (r.ok) setOpen(false);
      else setError(r.error ?? 'Save failed');
    },
    [current, set],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // The parent system-menu Popover attaches its keydown listener to
      // its own DOM node (Escape to close, arrow-key roving focus). The
      // picker is portaled out of that subtree, so today the listener
      // wouldn't see these events — but a future refactor to a
      // document-level listener would silently steal navigation away
      // from the picker. Defense-in-depth: scope nav keys to the picker.
      const stopAll = () => {
        e.preventDefault();
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
      };
      if (e.key === 'ArrowDown') {
        stopAll();
        setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        stopAll();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        stopAll();
        const pick = filtered[activeIndex];
        if (pick) void onPick(pick.id);
      } else if (e.key === 'Escape') {
        stopAll();
        setOpen(false);
        btnRef.current?.focus();
      } else if (e.key === 'Home') {
        stopAll();
        setActiveIndex(0);
      } else if (e.key === 'End') {
        stopAll();
        setActiveIndex(Math.max(0, filtered.length - 1));
      }
    },
    [filtered, activeIndex, onPick],
  );

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={saving}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={
          'inline-flex items-center gap-1 bg-transparent border-none p-0 m-0 cursor-pointer ' +
          'text-body-sm text-[var(--color-text-secondary)] ' +
          'hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-text-primary)] ' +
          'btn-press ' +
          (error ? 'text-[var(--color-error-text)] ' : '')
        }
      >
        <span>{saving ? 'Saving…' : offsetLabel(current)}</span>
        <ChevronDownIcon open={open} />
      </button>
      {open && pos && createPortal(
        <div
          ref={popoverRef}
          data-tz-picker-portal
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            width: LIST_WIDTH,
            maxHeight: LIST_MAX_HEIGHT,
          }}
          className={
            'z-[1000] flex flex-col rounded-[4px] p-2 gap-2 ' +
            'bg-[var(--color-surface-raised)] border border-[var(--color-border-subtle)] ' +
            'drop-shadow-[0_16px_19px_rgba(0,0,0,0.45)]'
          }
          onKeyDown={onKeyDown}
        >
          <div className="relative flex-shrink-0">
            <span
              aria-hidden="true"
              className={
                'absolute left-2.5 top-1/2 -translate-y-1/2 ' +
                'text-[var(--color-text-tertiary)] pointer-events-none ' +
                'inline-flex'
              }
            >
              <SearchIcon />
            </span>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              placeholder="Search timezone"
              spellCheck={false}
              aria-label="Filter timezones"
              aria-controls="tz-listbox"
              aria-activedescendant={filtered[activeIndex] ? `tz-opt-${activeIndex}` : undefined}
              className={
                'w-full bg-[var(--color-surface-base)] border border-[var(--color-border-default)] ' +
                'focus:border-[rgba(0,255,136,0.4)] rounded-[4px] ' +
                'pl-9 pr-9 py-2 text-body-sm text-[var(--color-text-primary)] ' +
                'placeholder:text-[var(--color-text-tertiary)] outline-none ' +
                'transition-colors duration-fast ease-out box-border'
              }
            />
            {query && (
              <button
                type="button"
                aria-label="Clear filter"
                onClick={() => {
                  setQuery('');
                  setActiveIndex(0);
                  inputRef.current?.focus();
                }}
                className={
                  'absolute right-2 top-1/2 -translate-y-1/2 ' +
                  'inline-flex items-center justify-center size-5 ' +
                  'bg-transparent border-none cursor-pointer p-0 ' +
                  'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] ' +
                  'transition-colors duration-fast ease-out'
                }
              >
                <ClearIcon />
              </button>
            )}
          </div>
          <ul
            ref={listRef}
            id="tz-listbox"
            role="listbox"
            aria-label="Timezones"
            className="m-0 p-0 list-none overflow-y-auto flex-1"
          >
            {filtered.length === 0 && (
              <li className="px-2.5 py-2 text-body-sm text-[var(--color-text-tertiary)]">
                No matching timezone
              </li>
            )}
            {filtered.map((tz, i) => {
              const selected = tz.id === current;
              const active = i === activeIndex;
              return (
                <li
                  key={`${tz.id}|${tz.label}`}
                  id={`tz-opt-${i}`}
                  data-tz={tz.id}
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => void onPick(tz.id)}
                  className={
                    'px-2.5 py-1.5 cursor-pointer text-body-sm truncate rounded-[3px] ' +
                    (selected
                      ? 'text-[var(--color-brand-default)] font-medium '
                      : active
                        ? 'text-[var(--color-text-primary)] '
                        : 'text-[var(--color-text-secondary)] ') +
                    (active ? 'bg-[var(--color-brand-subtle)]' : '')
                  }
                >
                  {tz.label}
                </li>
              );
            })}
          </ul>
          {error && (
            <p
              role="alert"
              className={
                'flex-shrink-0 px-2.5 py-1.5 text-footnote rounded-[3px] ' +
                'bg-[rgba(255,80,80,0.08)] text-[var(--color-error-text)]'
              }
            >
              {error}
            </p>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

function SearchIcon() {
  // vuesax/outline/search-normal — 16×16, 1.25px stroke for legibility.
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7.5" cy="7.5" r="5" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M13.5 13.5L11.3 11.3"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ClearIcon() {
  // Thin × — 1.25px stroke matches the search icon weight.
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M2.5 2.5L9.5 9.5M9.5 2.5L2.5 9.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ChevronDownIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={'transition-transform duration-fast ease-out ' + (open ? 'rotate-180' : '')}
    >
      <path
        d="M8 11.2C7.53333 11.2 7.06667 11.02 6.71333 10.6667L2.36667 6.32C2.17333 6.12667 2.17333 5.80667 2.36667 5.61333C2.56 5.42 2.88 5.42 3.07333 5.61333L7.42 9.96C7.74 10.28 8.26 10.28 8.58 9.96L12.9267 5.61333C13.12 5.42 13.44 5.42 13.6333 5.61333C13.8267 5.80667 13.8267 6.12667 13.6333 6.32L9.28667 10.6667C8.93333 11.02 8.46667 11.2 8 11.2Z"
        fill="currentColor"
      />
    </svg>
  );
}
