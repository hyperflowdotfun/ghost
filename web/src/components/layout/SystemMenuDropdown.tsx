import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Popover } from '@/components/Popover';
import { UpdateAvailableModal } from '@/components/UpdateAvailableModal';
import { TimezoneSetting } from '@/components/layout/TimezoneSetting';
import { useGateway } from '@/hooks/useGateway';
import { useTimezone } from '@/hooks/useTimezone';
import {
  loadWidgetState,
  setWidgetHidden,
  subscribeWidgetVisibility,
} from '@/lib/widget-visibility';
import { DEFAULT_ORDER } from '@/components/layout/Sidebar';
import settingsIcon from '@/assets/topbar-settings.svg';

const BTN_CLS =
  'inline-flex items-center justify-center w-8 h-8 rounded-full ' +
  'bg-[var(--color-surface-base)] border border-[var(--color-border-subtle)] ' +
  'text-[var(--color-text-secondary)] ' +
  'cursor-pointer transition-colors duration-fast ease-out ' +
  'hover:border-[var(--color-border-default)] hover:text-[var(--color-text-primary)]';

/** Read "is tweets widget visible?" from shared widget state. */
function readTweetsVisible(): boolean {
  return !(loadWidgetState()?.hidden.has('tweets') ?? false);
}

interface VersionStatus {
  /** Installed version, or `null` while the first status call is in flight. */
  current: string | null;
  /** True only when the registry has a newer semver. */
  updateAvailable: boolean | null;
}

/** Poll the gateway `status` once on connect. Returns nulls until the first
 *  response so the UI doesn't flicker the "Update" badge on boot. */
function useVersionStatus(): VersionStatus {
  const { connected, request } = useGateway();
  const [state, setState] = useState<VersionStatus>({ current: null, updateAvailable: null });

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    request<{ version?: string; updateAvailable?: boolean }>('status')
      .then((r) => {
        if (cancelled) return;
        setState({
          current: typeof r.version === 'string' && r.version !== 'unknown' ? r.version : null,
          updateAvailable: Boolean(r.updateAvailable),
        });
      })
      .catch(() => {
        if (!cancelled) setState({ current: null, updateAvailable: false });
      });
    return () => { cancelled = true; };
  }, [connected, request]);

  return state;
}

/**
 * GitHub docs URL for the "Expose to internet" hint. Opening in a new tab
 * (rather than embedding tunneling recipes in-app) keeps Ghost itself from
 * suggesting any particular network-exposure strategy — users follow the
 * canonical docs and make their own choice.
 */
const NETWORK_EXPOSURE_DOCS_URL =
  'https://github.com/hyperflowdotfun/ghost/blob/main/docs/security/network-exposure.md';

export function SystemMenuDropdown() {
  const [open, setOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [tweetsVisible, setTweetsVisible] = useState(readTweetsVisible);
  const containerRef = useRef<HTMLDivElement>(null);
  const { current: currentVersion, updateAvailable } = useVersionStatus();
  const { tz: currentTz, set: setTz } = useTimezone();

  useEffect(() => subscribeWidgetVisibility(() => setTweetsVisible(readTweetsVisible())), []);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (containerRef.current?.contains(t)) return;
      // The timezone picker is portaled to document.body — treat clicks
      // inside it as "inside" so picking a tz doesn't close this popover.
      if (t?.closest('[data-tz-picker-portal]')) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const toggleTweets = useCallback(() => {
    setWidgetHidden('tweets', tweetsVisible /* now visible → hide */, DEFAULT_ORDER);
  }, [tweetsVisible]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="System menu"
        aria-expanded={open}
        className={BTN_CLS}
      >
        <img src={settingsIcon} alt="" className="w-[18px] h-[18px]" />
      </button>
      <Popover
        open={open}
        origin="top-right"
        onEscape={() => setOpen(false)}
        initialFocus="first"
        trapArrowKeys={true}
        className={
          'absolute right-0 top-[calc(100%+8px)] z-50 min-w-[320px] ' +
          'bg-[var(--color-surface-raised)] border border-[var(--color-border-subtle)] ' +
          'drop-shadow-[0_16px_19px_rgba(0,0,0,0.45)] rounded-[4px] ' +
          'px-[14px] py-3 flex flex-col gap-3'
        }
        role="menu"
        aria-label="System menu"
      >
        <div className="flex flex-col gap-4 pb-4 border-b border-[var(--color-border-subtle)] w-full">
          <MenuItem
            icon={<XLogoIcon />}
            label="Show X"
            onClick={toggleTweets}
            trailing={<ToggleSwitch on={tweetsVisible} />}
          />
          <MenuItem
            icon={<MouseCircleIcon />}
            label="Expose to internet"
            onClick={() => {
              setOpen(false);
              window.open(NETWORK_EXPOSURE_DOCS_URL, '_blank', 'noopener,noreferrer');
            }}
          />
          <div className="flex items-center justify-between gap-2 w-full">
            <span className="flex items-center gap-2">
              <span className="inline-flex shrink-0 size-4 items-center justify-center text-text-secondary">
                <GlobeIcon />
              </span>
              <span className="text-body-sm text-text-primary">Timezone</span>
            </span>
            <TimezoneSetting current={currentTz} set={setTz} />
          </div>
        </div>
        <VersionRow
          label={currentVersion ? `Version ${currentVersion}` : 'Version'}
          updateAvailable={Boolean(updateAvailable)}
          onUpdateClick={() => { setOpen(false); setUpdateOpen(true); }}
        />
      </Popover>
      <UpdateAvailableModal open={updateOpen} onClose={() => setUpdateOpen(false)} />
    </div>
  );
}

interface MenuItemProps {
  icon: ReactNode;
  label: string;
  trailing?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}

function MenuItem({ icon, label, trailing, onClick, disabled = false }: MenuItemProps) {
  const baseCls =
    'flex items-center justify-between gap-2 w-full bg-transparent border-none p-0 text-left ' +
    'transition-colors duration-fast ease-out';
  const enabledCls =
    'cursor-pointer text-text-secondary hover:text-text-primary focus-visible:text-text-primary btn-press';
  const disabledCls = 'cursor-not-allowed text-text-tertiary';

  return (
    <button
      type="button"
      role="menuitem"
      onClick={disabled ? undefined : onClick}
      aria-disabled={disabled || undefined}
      title={disabled ? 'Coming soon' : undefined}
      className={`${baseCls} ${disabled ? disabledCls : enabledCls}`}
    >
      <span className="flex items-center gap-2">
        <span className="inline-flex shrink-0 size-4 items-center justify-center">
          {icon}
        </span>
        <span className={disabled ? 'text-body-sm' : 'text-body-sm text-text-primary'}>{label}</span>
      </span>
      {trailing}
    </button>
  );
}

/** Figma 888:10158 — 29×16 pill, mint when on, neutral-700 when off; 14×14 white knob. */
function ToggleSwitch({ on }: { on: boolean }) {
  return (
    <span
      className={
        'inline-flex shrink-0 items-center w-[29px] h-[16px] rounded-[9px] p-px transition-colors duration-fast ease-out ' +
        (on ? 'bg-[var(--color-brand-default)]' : 'bg-[#2a2c31]')
      }
      aria-hidden="true"
    >
      <span
        className="size-[14px] rounded-[8px] bg-white transition-transform duration-fast ease-out"
        style={{ transform: on ? 'translateX(13px)' : 'translateX(0)' }}
      />
    </span>
  );
}

function XLogoIcon() {
  // Figma 888:10155 (h4CksA.tif) — 14×12.444 native, fits inside the 16×16 icon slot.
  return (
    <svg width="14" height="13" viewBox="0 0 14 12.4444" fill="none" aria-hidden="true">
      <path
        d="M4.41968 0L7.50759 3.96959L11.0353 0H13.1765L8.50958 5.26967L14 12.4444H9.70409L6.30015 8.10018L2.43469 12.4087L2.37473 12.4444H0.274494L5.26654 6.80359L0 0H4.41968ZM11.447 11.1573L11.101 10.6772L3.74692 1.20682H2.49795L10.2803 11.157H11.447V11.1573Z"
        fill="currentColor"
      />
    </svg>
  );
}

interface VersionRowProps {
  label: string;
  updateAvailable: boolean;
  onUpdateClick: () => void;
}

/** Bottom row of the system menu. Always shows the installed version with
 *  the primary text color (matches "Show X" / "Expose to internet" above).
 *  When an update is available, the whole row becomes clickable and gets an
 *  "Update" badge on the right. */
function VersionRow({ label, updateAvailable, onUpdateClick }: VersionRowProps) {
  const content = (
    <>
      <span className="flex items-center gap-2">
        <span className="inline-flex shrink-0 size-4 items-center justify-center text-text-secondary">
          <InfoCircleIcon />
        </span>
        <span className="text-body-sm text-text-primary">{label}</span>
      </span>
      {updateAvailable && <UpdateBadge />}
    </>
  );

  if (!updateAvailable) {
    return (
      <div className="flex items-center justify-between gap-2 w-full">
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      role="menuitem"
      onClick={onUpdateClick}
      className="flex items-center justify-between gap-2 w-full bg-transparent border-none p-0 text-left cursor-pointer transition-colors duration-fast ease-out btn-press"
    >
      {content}
    </button>
  );
}

function UpdateBadge() {
  return (
    <span
      className={
        'inline-flex items-center justify-center h-5 px-[7px] rounded-[2px] ' +
        'bg-[var(--color-warning-subtle)] text-warning-text text-footnote whitespace-nowrap'
      }
    >
      Update New Version
    </span>
  );
}

function MouseCircleIcon() {
  // Figma 888:10148 — vuesax/outline/mouse-circle. Two-path open icon.
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M10.9135 15.18C10.9068 15.18 10.9068 15.18 10.9001 15.18C10.2268 15.1733 9.66681 14.76 9.46681 14.1134L8.23347 10.1467C8.06681 9.60001 8.20681 9.01334 8.61347 8.62001C9.01347 8.22667 9.59348 8.08001 10.1268 8.24667L14.1001 9.48001C14.7401 9.68001 15.1601 10.24 15.1668 10.9133C15.1735 11.58 14.7668 12.1467 14.1268 12.36L13.0401 12.7267C12.8868 12.78 12.7668 12.8933 12.7201 13.0467L12.3468 14.14C12.1401 14.7733 11.5801 15.18 10.9135 15.18ZM9.67348 9.18C9.49348 9.18 9.37348 9.28 9.32014 9.32667C9.18014 9.46667 9.13348 9.66001 9.19348 9.85334L10.4268 13.82C10.5335 14.16 10.8268 14.1733 10.9201 14.18C11.0135 14.18 11.3001 14.1533 11.4068 13.8267L11.7801 12.7333C11.9268 12.2867 12.2868 11.9334 12.7335 11.78L13.8201 11.4133C14.1535 11.3067 14.1735 11.0134 14.1735 10.9267C14.1735 10.84 14.1468 10.5467 13.8135 10.44L9.84014 9.20668C9.77348 9.18668 9.72014 9.18 9.67348 9.18Z" fill="currentColor" />
      <path d="M8 15.1667C4.04667 15.1667 0.833333 11.9533 0.833333 8C0.833333 4.04667 4.04667 0.833333 8 0.833333C11.9533 0.833333 15.1667 4.04667 15.1667 8C15.1667 8.27333 14.94 8.5 14.6667 8.5C14.3933 8.5 14.1667 8.27333 14.1667 8C14.1667 4.6 11.4 1.83333 8 1.83333C4.6 1.83333 1.83333 4.6 1.83333 8C1.83333 11.4 4.6 14.1667 8 14.1667C8.27333 14.1667 8.5 14.3933 8.5 14.6667C8.5 14.94 8.27333 15.1667 8 15.1667Z" fill="currentColor" />
    </svg>
  );
}

function GlobeIcon() {
  // Figma 1317:5733 — vuesax/outline/global. Five strokes: outer circle, two
  // vertical meridians, two horizontal parallels.
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 15.1667C4.04667 15.1667 0.833333 11.9533 0.833333 8C0.833333 4.04667 4.04667 0.833333 8 0.833333C11.9533 0.833333 15.1667 4.04667 15.1667 8C15.1667 11.9533 11.9533 15.1667 8 15.1667ZM8 1.83333C4.6 1.83333 1.83333 4.6 1.83333 8C1.83333 11.4 4.6 14.1667 8 14.1667C11.4 14.1667 14.1667 11.4 14.1667 8C14.1667 4.6 11.4 1.83333 8 1.83333Z" fill="currentColor" />
      <path d="M6 14.5H5.33333C5.06 14.5 4.83333 14.2733 4.83333 14C4.83333 13.7267 5.04667 13.5067 5.32 13.5C4.27333 9.92667 4.27333 6.07333 5.32 2.5C5.04667 2.49333 4.83333 2.27333 4.83333 2C4.83333 1.72667 5.06 1.5 5.33333 1.5H6C6.16 1.5 6.31333 1.58 6.40667 1.70667C6.5 1.84 6.52667 2.00667 6.47333 2.16C5.22 5.92667 5.22 10.0733 6.47333 13.8467C6.52667 14 6.5 14.1667 6.40667 14.3C6.31333 14.42 6.16 14.5 6 14.5Z" fill="currentColor" />
      <path d="M10 14.5C9.94667 14.5 9.89333 14.4933 9.84 14.4733C9.58 14.3867 9.43333 14.1 9.52667 13.84C10.78 10.0733 10.78 5.92667 9.52667 2.15333C9.44 1.89333 9.58 1.60667 9.84 1.52C10.1067 1.43333 10.3867 1.57333 10.4733 1.83333C11.8 5.80667 11.8 10.18 10.4733 14.1467C10.4067 14.3667 10.2067 14.5 10 14.5Z" fill="currentColor" />
      <path d="M8 11.4667C6.14 11.4667 4.28667 11.2067 2.5 10.68C2.49333 10.9467 2.27333 11.1667 2 11.1667C1.72667 11.1667 1.5 10.94 1.5 10.6667V10C1.5 9.84 1.58 9.68667 1.70667 9.59333C1.84 9.5 2.00667 9.47333 2.16 9.52667C5.92667 10.78 10.08 10.78 13.8467 9.52667C14 9.47333 14.1667 9.5 14.3 9.59333C14.4333 9.68667 14.5067 9.84 14.5067 10V10.6667C14.5067 10.94 14.28 11.1667 14.0067 11.1667C13.7333 11.1667 13.5133 10.9533 13.5067 10.68C11.7133 11.2067 9.86 11.4667 8 11.4667Z" fill="currentColor" />
      <path d="M14 6.5C13.9467 6.5 13.8933 6.49333 13.84 6.47333C10.0733 5.22 5.92 5.22 2.15333 6.47333C1.88667 6.56 1.60667 6.42 1.52 6.16C1.44 5.89333 1.58 5.61333 1.84 5.52667C5.81333 4.2 10.1867 4.2 14.1533 5.52667C14.4133 5.61333 14.56 5.9 14.4667 6.16C14.4067 6.36667 14.2067 6.5 14 6.5Z" fill="currentColor" />
    </svg>
  );
}

function InfoCircleIcon() {
  // Figma 841:6503 — vuesax/outline/info-circle.
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 15.1667C4.04667 15.1667 0.833333 11.9533 0.833333 8C0.833333 4.04667 4.04667 0.833333 8 0.833333C11.9533 0.833333 15.1667 4.04667 15.1667 8C15.1667 11.9533 11.9533 15.1667 8 15.1667ZM8 1.83333C4.6 1.83333 1.83333 4.6 1.83333 8C1.83333 11.4 4.6 14.1667 8 14.1667C11.4 14.1667 14.1667 11.4 14.1667 8C14.1667 4.6 11.4 1.83333 8 1.83333Z" fill="currentColor" />
      <path d="M8 9.16667C7.72667 9.16667 7.5 8.94 7.5 8.66667V5.33333C7.5 5.06 7.72667 4.83333 8 4.83333C8.27333 4.83333 8.5 5.06 8.5 5.33333V8.66667C8.5 8.94 8.27333 9.16667 8 9.16667Z" fill="currentColor" />
      <path d="M8 11.3333C7.91333 11.3333 7.82667 11.3133 7.74667 11.28C7.66667 11.2467 7.59333 11.2 7.52667 11.14C7.46667 11.0733 7.42 11.0067 7.38667 10.92C7.35333 10.84 7.33333 10.7533 7.33333 10.6667C7.33333 10.58 7.35333 10.4933 7.38667 10.4133C7.42 10.3333 7.46667 10.26 7.52667 10.1933C7.59333 10.1333 7.66667 10.0867 7.74667 10.0533C7.90667 9.98667 8.09333 9.98667 8.25333 10.0533C8.33333 10.0867 8.40667 10.1333 8.47333 10.1933C8.53333 10.26 8.58 10.3333 8.61333 10.4133C8.64667 10.4933 8.66667 10.58 8.66667 10.6667C8.66667 10.7533 8.64667 10.84 8.61333 10.92C8.58 11.0067 8.53333 11.0733 8.47333 11.14C8.40667 11.2 8.33333 11.2467 8.25333 11.28C8.17333 11.3133 8.08667 11.3333 8 11.3333Z" fill="currentColor" />
    </svg>
  );
}
