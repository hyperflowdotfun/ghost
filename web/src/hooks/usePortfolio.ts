import { useState, useEffect, useCallback, useRef, useContext, useMemo } from 'react';
import { useGateway } from './useGateway';
import {
  PortfolioContext,
  type PortfolioContextValue,
  type WalletInfo,
  type Balance,
  type Position,
  type OpenOrder,
  type Notification,
  type PortfolioStatus,
  type AggregatePortfolio,
} from '../lib/portfolio-context';

const POLL_INTERVAL_MS = 10 * 1000;
const DEBOUNCE_MS = 500;


export function usePortfolioProvider(): PortfolioContextValue {
  const { request, subscribe, connected } = useGateway();
  const [status, setStatus] = useState<PortfolioStatus>('idle');
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [openOrders, setOpenOrders] = useState<OpenOrder[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadNotificationIds, setUnreadNotificationIds] = useState<Set<string>>(new Set());
  const markNotificationsRead = useCallback(() => setUnreadNotificationIds(new Set()), []);
  // Seen ids + a separate "seed has run" flag. Tracking only the set size
  // is unsafe: an empty cold-start or a failed first fetch keeps the set
  // at size 0, and the very next real notification would be silently
  // seeded with no badge bump. The flag flips on the first SUCCESSFUL
  // fetch regardless of payload length.
  const seenIdsRef = useRef<Set<string>>(new Set());
  const seedDoneRef = useRef<boolean>(false);
  // Locally dismissed ids — filtered out client-side per
  // [[feedback_notification_dismiss_clientside]]. The × is a hide, not a
  // server delete; the row stays in the DB.
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [aggregate, setAggregate] = useState<AggregatePortfolio | null>(null);
  // Mirror of `aggregate` for reading inside `fetchAll`'s useCallback
  // closure without recreating the callback on every state change (which
  // would restart the poll interval).
  const aggregateRef = useRef<AggregatePortfolio | null>(null);
  useEffect(() => { aggregateRef.current = aggregate; }, [aggregate]);
  // Mirror of `wallets` so a transient RPC failure doesn't flip the UI
  // mid-chat. Reading state directly inside the useCallback would capture
  // stale values from when fetchAll was last memoised (connected/request
  // change only).
  const walletsRef = useRef<WalletInfo[]>([]);
  useEffect(() => { walletsRef.current = wallets; }, [wallets]);
  const [error, setError] = useState<string | null>(null);
  const [paperMode, setPaperMode] = useState(false);
  const [lastFetchedAt, setLastFetchedAt] = useState(Date.now());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchAll = useCallback(async () => {
    if (!connected) return;
    setStatus('loading');

    try {
      // Wallets list (local) + aggregate (one batch for all wallets) +
      // notifications log. Active alert rules aren't fetched here — the
      // bell-dropdown displays fired notifications only; CRUD on rules
      // happens through chat tools.
      const [walletsRes, aggregateRes, notifRes] = await Promise.allSettled([
        request<WalletInfo[]>('trading.wallets.list'),
        request<AggregatePortfolio & { connected: boolean }>('trading.portfolio.aggregate'),
        request<Notification[]>('trading.notifications.list'),
      ]);

      // Principle: only update local state when the server CONFIRMS the
      // new value. A rejected RPC or a per-wallet HL 429 is transient —
      // keep the last known good values until the next successful poll.
      // Mid-chat 429 storms used to clear `wallets` to [] and flip the
      // UI to "Connect Wallet"; we now hold every field through transients.

      const walletsLoaded = walletsRes.status === 'fulfilled' && Array.isArray(walletsRes.value);
      const walletData: WalletInfo[] = walletsLoaded ? walletsRes.value : walletsRef.current;
      if (walletsLoaded) setWallets(walletData);

      if (notifRes.status === 'fulfilled' && Array.isArray(notifRes.value)) {
        // Bell-dropdown only surfaces price-target notifications per
        // product decision — other kinds (tp_hit, liquidation_risk, news, ...)
        // are still persisted and shown in chat via judge dispatch,
        // but don't crowd the bell badge.
        const priceOnly = notifRes.value.filter((n) => n.kind === 'price_target');
        setNotifications(priceOnly);
        if (!seedDoneRef.current) {
          // First successful fetch — seed seenIds, no badge bump.
          seenIdsRef.current = new Set(priceOnly.map((n) => n.id));
          seedDoneRef.current = true;
        } else {
          const newIds = priceOnly
            .map((n) => n.id)
            .filter((id) => !seenIdsRef.current.has(id));
          if (newIds.length > 0) {
            setUnreadNotificationIds((prev) => {
              const next = new Set(prev);
              for (const id of newIds) next.add(id);
              return next;
            });
            for (const id of newIds) seenIdsRef.current.add(id);
          }
        }
      }

      const aggData = aggregateRes.status === 'fulfilled' ? aggregateRes.value : null;

      // CONFIRMED no-wallet: walletsLoaded === true (local DB succeeded)
      // AND the list is empty. Only this combination allows us to clear
      // the portfolio state and show the connect-wallet CTA. A rejected
      // walletsRes is treated as "unknown — keep prior state".
      if (walletsLoaded && walletData.length === 0) {
        setAggregate(null);
        setBalance(null);
        setPositions([]);
        setOpenOrders([]);
        setStatus('no-wallet');
        setError(null);
        return;
      }

      if (!aggData || !aggData.connected) {
        // Aggregate failed or returned not-connected. If we have ANY
        // signal there's something worth keeping — cached aggregate, or
        // wallets confirmed locally — hold every displayed field. The
        // next poll will recover when the HL rate limit lifts.
        if (aggregateRef.current || walletData.length > 0) {
          return;
        }
        // Genuine cold-start failure (no cache, no prior wallets) — surface
        // the error so the user isn't staring at an empty widget. Do NOT
        // clear wallets/positions/balance — they're already empty by
        // virtue of being a cold start.
        const reason = aggregateRes.status === 'rejected'
          ? (aggregateRes.reason instanceof Error ? aggregateRes.reason.message : String(aggregateRes.reason))
          : null;
        setStatus('error');
        setError(reason ?? 'Failed to load portfolio');
        return;
      }

      // Aggregate succeeded. Extract default wallet's data for the widgets.
      const defaultAddr = walletData.find((w) => w.isDefault)?.address ?? walletData[0]?.address;
      const defaultPw = defaultAddr ? aggData.perWallet.find((pw) => pw.address.toLowerCase() === defaultAddr.toLowerCase()) : null;

      // Couldn't locate the default wallet in this aggregate snapshot —
      // possible race (walletStore changed mid-fetch, or the address
      // we picked just got removed). Hold prior displayed values
      // rather than blanking the widget on a stale snapshot.
      if (!defaultPw) {
        setAggregate(aggData);
        return;
      }

      // Per-wallet HL error (e.g. clearinghouseState 429 inside the
      // per-address try/catch) → server returns connected:true but
      // {balance:null, positions:[], openOrders:[], error}. Hold prior
      // displayed values rather than blanking the widget. Guard on
      // `error` alone — the original `&& balance === null` was
      // brittle: any future server-side partial-result path that
      // leaves balance non-null while still erroring would slip
      // through and wipe positions/orders.
      if (defaultPw.error) {
        setAggregate(aggData);
        return;
      }

      setAggregate(aggData);
      setBalance(defaultPw.balance ?? null);
      setPositions(defaultPw.positions ?? []);
      setOpenOrders(defaultPw.openOrders ?? []);
      setError(null);
      setStatus('connected');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLastFetchedAt(Date.now());
    }
  }, [connected, request]);

  useEffect(() => {
    if (!connected) return;
    request<{ paperMode?: boolean }>('status')
      .then((res) => {
        if (typeof res.paperMode === 'boolean') setPaperMode(res.paperMode);
      })
      .catch(() => {});
  }, [connected, request]);

  // Fetch on mount + when gateway connects
  useEffect(() => {
    if (connected) fetchAll();
  }, [connected, fetchAll]);

  // Refresh when wallets change (connect, remove, enable trading) — debounced
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handler = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { if (connected) fetchAll(); }, DEBOUNCE_MS);
    };
    window.addEventListener("ghost-wallet-changed", handler);
    return () => {
      window.removeEventListener("ghost-wallet-changed", handler);
      if (timer) clearTimeout(timer);
    };
  }, [connected, fetchAll]);

  // Poll only when gateway connected AND user has at least one wallet
  useEffect(() => {
    if (!connected || wallets.length === 0) return;
    pollRef.current = setInterval(fetchAll, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [connected, wallets.length, fetchAll]);

  const debouncedFetch = useMemo(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fetchAll, DEBOUNCE_MS);
    };
  }, [fetchAll]);

  // After chat.done, re-fetch on a short cascade. A single debounced fetch
  // at +500ms races Hyperliquid's `frontendOpenOrders` eventual consistency
  // — after a successful cancel/place the endpoint can still return the
  // stale list for a few seconds. The 3s + 7s retries close that window
  // without waiting for the 10s background poll.
  const chatDoneFetchCascade = useMemo(() => {
    const offsets = [DEBOUNCE_MS, 3000, 7000];
    let timers: ReturnType<typeof setTimeout>[] = [];
    return () => {
      timers.forEach(clearTimeout);
      timers = offsets.map((ms) => setTimeout(fetchAll, ms));
    };
  }, [fetchAll]);

  useEffect(() => {
    return subscribe((evt) => {
      if (evt.event === 'chat.done') chatDoneFetchCascade();
    });
  }, [subscribe, chatDoneFetchCascade]);

  // Alert lifecycle events from the gateway:
  //   set/removed → refresh (CRUD on rules can affect what the next eval
  //   tick fires, so refetch the notifications log too).
  // chat.proactive → a fired notification was just dispatched; refetch
  //   pulls the new row into the bell and the seenIds diff bumps the
  //   badge automatically.
  useEffect(() => {
    return subscribe((evt) => {
      if (
        evt.event === 'trading.alert.set' ||
        evt.event === 'trading.alert.removed' ||
        evt.event === 'chat.proactive'
      ) {
        debouncedFetch();
      }
    });
  }, [subscribe, debouncedFetch]);

  const dismissNotification = useCallback(async (id: string) => {
    // Dismiss is a soft-flag persist, not a DELETE. The × calls
    // `trading.notifications.dismiss` which sets `dismissed_at` on the
    // server row; the server's `list()` query already filters those
    // out, so reload / cross-device / next poll all stay hidden.
    // Memory invariant [[feedback_notification_dismiss_clientside]]
    // still holds — the underlying record is preserved, only flagged.
    //
    // Local `dismissedIds` is the optimistic-hide bridge between click
    // and the next poll picking up the server's filtered list.
    // `unreadNotificationIds` is stripped too so the bell badge stays
    // in sync if the user dismisses while the drawer is open.
    setDismissedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    setUnreadNotificationIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    try {
      await request('trading.notifications.dismiss', { id });
    } catch (err) {
      // Persist failed — the row will reappear on the next poll. Log
      // so we notice repeated dismiss failures, but don't error the
      // user out; they can simply click × again.
      console.warn('trading.notifications.dismiss failed', err);
    }
  }, [request]);

  const visibleNotifications = useMemo(
    () => notifications.filter((n) => !dismissedIds.has(n.id)),
    [notifications, dismissedIds],
  );

  return {
    status, wallets, balance, positions, openOrders,
    notifications: visibleNotifications, unreadNotificationIds, markNotificationsRead, dismissNotification,
    aggregate, error, paperMode,
    refresh: fetchAll, lastFetchedAt, pollIntervalMs: POLL_INTERVAL_MS,
  };
}

export function usePortfolio(): PortfolioContextValue {
  const ctx = useContext(PortfolioContext);
  if (!ctx) throw new Error('usePortfolio must be used within PortfolioProvider');
  return ctx;
}
