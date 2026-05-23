import { useCallback, useEffect, useState } from 'react';
import { useGateway } from '@/hooks/useGateway';
import { TerminalModal } from '@/components/TerminalModal';

const MAX_LEN = 2000;

interface FilterPromptModalProps {
  open: boolean;
  onClose: () => void;
  kind: 'news' | 'tweets';
}

const COPY = {
  news: {
    title: 'News Filter',
    helper: 'Tell the AI how you want your news. It will filter, sort, and summarize accordingly.',
    placeholder:
      "Only show macro news that could affect BTC in the next 24h. Skip altcoin pumps and exchange announcements. Summarize in one line from a trader's perspective.",
    toggleLabel: 'Apply filter',
    getMethod: 'trading.news.filter.get',
    setMethod: 'trading.news.filter.set',
    getEnabledMethod: 'trading.news.filter.enabled.get',
    setEnabledMethod: 'trading.news.filter.enabled.set',
  },
  tweets: {
    title: 'Tweets Filter',
    helper: 'Tell the AI how you want your tweets. It will filter, sort, and summarize accordingly.',
    placeholder:
      'Only liquidations > $1M, and major exchange or regulator announcements. Skip memecoin shilling.',
    toggleLabel: 'Apply filter',
    getMethod: 'trading.tweets.filter.get',
    setMethod: 'trading.tweets.filter.set',
    getEnabledMethod: 'trading.tweets.filter.enabled.get',
    setEnabledMethod: 'trading.tweets.filter.enabled.set',
  },
} as const;

export function FilterPromptModal({ open, onClose, kind }: FilterPromptModalProps) {
  const { request, connected } = useGateway();
  const copy = COPY[kind];
  const [prompt, setPrompt] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-fetch every open so a sibling tab's edits don't get shadowed by stale state.
  useEffect(() => {
    if (!open || !connected) return;
    let cancelled = false;
    setError(null);
    Promise.all([
      request<{ prompt: string }>(copy.getMethod).catch(() => ({ prompt: '' })),
      request<{ enabled: boolean }>(copy.getEnabledMethod).catch(() => ({ enabled: false })),
    ]).then(([promptRes, enabledRes]) => {
      if (cancelled) return;
      setPrompt(promptRes.prompt ?? '');
      setEnabled(Boolean(enabledRes.enabled));
    });
    return () => {
      cancelled = true;
    };
  }, [open, connected, request, copy.getMethod, copy.getEnabledMethod]);

  // Optimistic: flip first, roll back on RPC failure.
  const toggleEnabled = useCallback(async () => {
    const next = !enabled;
    setEnabled(next);
    try {
      const res = await request<{ ok: boolean; error?: string }>(copy.setEnabledMethod, {
        enabled: next,
      });
      if (!res.ok) {
        setEnabled(!next);
        setError(res.error ?? 'Failed to toggle filter');
      }
    } catch {
      setEnabled(!next);
      setError('Failed to toggle filter');
    }
  }, [enabled, request, copy.setEnabledMethod]);

  const save = useCallback(async () => {
    if (saving) return;
    const trimmed = prompt.trim();
    if (trimmed.length > MAX_LEN) {
      setError(`Prompt exceeds ${MAX_LEN} characters`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await request<{ ok: boolean; error?: string }>(copy.setMethod, { prompt: trimmed });
      if (res.ok) {
        onClose();
      } else {
        setError(res.error ?? 'Failed to save filter prompt');
      }
    } catch {
      setError('Failed to save filter prompt');
    } finally {
      setSaving(false);
    }
  }, [prompt, saving, request, copy.setMethod, onClose]);

  const remaining = MAX_LEN - prompt.length;
  const promptDisabled = saving || !enabled;

  return (
    <TerminalModal
      open={open}
      onClose={onClose}
      title={copy.title}
      width={460}
      hideHeader
      cardClassName="bg-[var(--color-surface-base)] border border-[var(--color-border-default)] rounded-[8px]"
      bodyClassName="flex flex-col p-0"
    >
      <header className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-[var(--color-border-subtle)]">
        <span className="text-body-md-semibold text-[var(--color-text-primary)] leading-[1.5]">
          {copy.title}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex items-center justify-center w-7 h-7 rounded-[6px] bg-transparent border-0 cursor-pointer hover:bg-[rgba(255,255,255,0.04)] focus-visible:outline-none focus-visible:bg-[rgba(255,255,255,0.04)]"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path
              d="M1 1l12 12M13 1L1 13"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              className="text-[var(--color-text-secondary)]"
            />
          </svg>
        </button>
      </header>

      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={toggleEnabled}
        className="flex items-center justify-between gap-4 w-full px-5 py-4 bg-transparent border-0 cursor-pointer text-left transition-colors duration-fast ease-out hover:bg-white/[0.02] border-b border-[var(--color-border-subtle)]"
      >
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-body-md-medium text-[var(--color-text-primary)] leading-[1.4]">
            {copy.toggleLabel}
          </span>
          <span className="text-body-sm text-[var(--color-text-tertiary)] leading-[1.4]">
            {enabled ? 'AI is filtering and sorting your feed.' : 'All articles pass through unfiltered.'}
          </span>
        </div>
        <span
          aria-hidden="true"
          className="relative inline-block w-[34px] h-[18px] rounded-full transition-colors duration-fast ease-out flex-shrink-0"
          style={{ background: enabled ? 'var(--color-brand-default)' : 'rgba(110, 116, 128, 0.5)' }}
        >
          <span
            className="absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-[left] duration-fast ease-out"
            style={{ left: enabled ? 18 : 2 }}
          />
        </span>
      </button>

      <div className={'flex flex-col gap-3 px-5 pt-4 pb-5 transition-opacity duration-fast ease-out ' + (enabled ? 'opacity-100' : 'opacity-50')}>
        <p className="text-body-sm text-[var(--color-text-tertiary)] leading-[1.5] m-0">
          {copy.helper}
        </p>
        <textarea
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            if (error) setError(null);
          }}
          placeholder={copy.placeholder}
          aria-label={copy.title}
          maxLength={MAX_LEN}
          disabled={promptDisabled}
          className="w-full h-[140px] bg-[var(--color-surface-canvas)] border border-[var(--color-border-subtle)] rounded-[6px] px-3.5 py-3 text-body-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] leading-[1.5] outline-none focus:outline-none focus-visible:outline-none resize-none disabled:cursor-not-allowed"
        />
        <div className="flex items-center justify-between gap-3 min-h-[20px]">
          {error ? (
            <span className="text-footnote text-[var(--color-error-default)]">{error}</span>
          ) : remaining < 200 ? (
            <span className="text-footnote text-[var(--color-text-tertiary)]">{remaining} chars left</span>
          ) : <span aria-hidden="true" />}
          <button
            type="button"
            onClick={save}
            disabled={promptDisabled}
            className="h-9 px-4 rounded-[6px] bg-[var(--color-brand-default)] text-[var(--color-text-on-brand)] text-body-md-semibold leading-[1.5] cursor-pointer border-0 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity duration-fast ease-out"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </TerminalModal>
  );
}

export function NewsFilterModal(props: Omit<FilterPromptModalProps, 'kind'>) {
  return <FilterPromptModal {...props} kind="news" />;
}

export function TweetsFilterModal(props: Omit<FilterPromptModalProps, 'kind'>) {
  return <FilterPromptModal {...props} kind="tweets" />;
}
