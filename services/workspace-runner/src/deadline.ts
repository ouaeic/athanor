/** Long deadlines must be rearmed: Node's timer delay is a signed 32-bit millisecond value. */
export const scheduleDeadline = (at: number, expired: () => void): { cancel: () => void } => {
  if (!Number.isFinite(at) || !Number.isFinite(new Date(at).getTime()))
    throw new Error('The requested deadline is outside the supported date range');
  let timer: NodeJS.Timeout | undefined;
  let cancelled = false;
  const arm = () => {
    if (cancelled) return;
    const remaining = at - Date.now();
    if (remaining <= 0) {
      expired();
      return;
    }
    timer = setTimeout(arm, Math.min(remaining, 2_147_483_647));
    timer.unref();
  };
  // Defer even an expired deadline until the caller has installed the session record.
  timer = setTimeout(arm, Math.max(1, Math.min(at - Date.now(), 2_147_483_647)));
  timer.unref();
  return {
    cancel: () => {
      cancelled = true;
      clearTimeout(timer);
    }
  };
};
