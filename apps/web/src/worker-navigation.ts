type MessageTarget = Pick<ServiceWorkerContainer, 'addEventListener' | 'removeEventListener'>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function subscribeWorkerNavigation(
  target: MessageTarget,
  origin: string,
  open: (taskId: string | null) => void,
  refresh: () => void
): () => void {
  const receive = (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    const message = data as Record<string, unknown>;
    if (message.type === 'approval-resolved') {
      if (typeof message.approvalId === 'string' && UUID.test(message.approvalId)) refresh();
      return;
    }
    if (message.type !== 'navigate-task' || typeof message.url !== 'string') return;
    try {
      const url = new URL(message.url, origin);
      if (url.origin !== origin || url.pathname !== '/' || url.hash || url.username || url.password)
        return;
      if ([...url.searchParams.keys()].some((key) => key !== 'task')) return;
      const ids = url.searchParams.getAll('task');
      if (ids.length > 1 || (ids[0] !== undefined && !UUID.test(ids[0]))) return;
      open(ids[0] ?? null);
      refresh();
    } catch {
      // A malformed notification destination has no navigation authority.
    }
  };
  target.addEventListener('message', receive);
  return () => target.removeEventListener('message', receive);
}
