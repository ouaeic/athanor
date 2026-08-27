import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { computerChangeLine, turnComputerQuery } from '../completion-card.js';
import type { TaskEvent } from '../types.js';

/**
 * What the finished turn changed on the computer, which is the answer to the question the card at
 * the end of a turn was never able to answer.
 *
 * The box already computes it - a turn takes a restore point before its first call that could
 * change anything, and the same preview that the rewind dialog reads carries the added, changed
 * and deleted paths. Until now the only way to that answer was to open the control offering to
 * destroy the turn. `turnComputerQuery` decides whether asking would be honest at all; a turn
 * that took no restore point never reaches the network.
 */
export const useTurnChanges = (input: {
  taskId: string | undefined;
  events: TaskEvent[];
  status: string;
}) => {
  const { taskId, events, status } = input;
  const query = useMemo(() => turnComputerQuery(events, status), [events, status]);
  const [changes, setChanges] = useState<{ eventId: string; line: string }>();
  useEffect(() => {
    setChanges(undefined);
    if (!taskId || !query) return;
    let active = true;
    void api
      .taskRewindPreview(taskId, query.eventId)
      .then((preview) => {
        const line = computerChangeLine(preview, query.fromSequence);
        // Nothing changed, or the restore point that came back belongs to an earlier turn. Both
        // are answered with silence rather than a sentence saying so.
        if (active && line) setChanges({ eventId: query.eventId, line });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [taskId, query?.eventId, query?.fromSequence]);
  return changes;
};
