import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, Search } from 'lucide-react';
import { Dialog } from './Dialog.js';
import { paletteRows } from './palette-rows.js';
import type { ConversationSearchResult, Task } from './types.js';

export interface Command {
  id: string;
  label: string;
  hint?: string;
  group: string;
  run: () => void;
}

export function CommandPalette({
  open,
  onClose,
  commands,
  tasks,
  onOpenTask,
  search
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  tasks: Task[];
  onOpenTask: (task: { id: string; workspaceId: string }) => void;
  search: (query: string) => Promise<ConversationSearchResult[]>;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [remote, setRemote] = useState<ConversationSearchResult[]>([]);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    setRemote([]);
    const frame = window.requestAnimationFrame(() => field.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  // Conversation bodies live encrypted on the server, so full-text search is a request. Local
  // title matching answers instantly and the server result fills in behind it.
  useEffect(() => {
    if (!open) return;
    const term = query.trim();
    if (term.length < 2) {
      setRemote([]);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void search(term)
        .then((results) => {
          if (active) setRemote(results);
        })
        .catch(() => {
          if (active) setRemote([]);
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [open, query, search]);

  const entries = useMemo(
    () =>
      paletteRows({ query, commands, tasks, matches: remote }).map(
        (row): Command =>
          row.kind === 'command'
            ? row.command
            : {
                id: row.id,
                label: row.label,
                ...(row.hint ? { hint: row.hint } : {}),
                group: 'Conversations',
                run: () => onOpenTask({ id: row.taskId, workspaceId: row.workspaceId })
              }
      ),
    [commands, tasks, remote, query, onOpenTask]
  );

  useEffect(() => {
    setActive((current) => Math.min(current, Math.max(0, entries.length - 1)));
  }, [entries.length]);

  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const commit = (index: number) => {
    const entry = entries[index];
    if (!entry) return;
    onClose();
    entry.run();
  };

  let lastGroup = '';
  const activeId = entries[active] ? `palette-entry-${entries[active].id}` : undefined;
  return (
    <Dialog
      backdropClassName="palette-backdrop"
      className="palette"
      label="Command palette"
      onClose={onClose}
      closeOnBackdrop
    >
      <div className="palette-field">
        <Search />
        {/*
            Arrowing through the list moves `aria-activedescendant` rather than focus, which is
            what makes the ranked results audible: the input keeps focus so typing continues to
            filter, and the screen reader announces each option as it becomes active.
          */}
        <input
          ref={field}
          value={query}
          placeholder="Search conversations or run a command…"
          aria-label="Search conversations or run a command"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-results"
          aria-autocomplete="list"
          {...(activeId ? { 'aria-activedescendant': activeId } : {})}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          /* Escape is not handled here: the dialog owns it, and two handlers for one key is how
             they end up disagreeing. */
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((current) => (entries.length ? (current + 1) % entries.length : 0));
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((current) =>
                entries.length ? (current - 1 + entries.length) % entries.length : 0
              );
              return;
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              commit(active);
            }
          }}
        />
        <kbd>esc</kbd>
      </div>
      <div
        className="palette-results"
        id="palette-results"
        ref={list}
        role="listbox"
        aria-label="Results"
      >
        {entries.length === 0 && <p className="palette-empty">Nothing matches “{query}”.</p>}
        {entries.map((entry, index) => {
          const heading = entry.group !== lastGroup ? entry.group : '';
          lastGroup = entry.group;
          return (
            <div key={entry.id} {...(heading ? { role: 'group', 'aria-label': heading } : {})}>
              {heading && <p className="palette-group">{heading}</p>}
              <button
                type="button"
                id={`palette-entry-${entry.id}`}
                className="palette-entry"
                role="option"
                aria-selected={index === active}
                data-active={index === active}
                tabIndex={-1}
                onMouseEnter={() => setActive(index)}
                onClick={() => commit(index)}
              >
                <span className="palette-label">{entry.label}</span>
                {entry.hint && <span className="palette-hint">{entry.hint}</span>}
                {index === active && <CornerDownLeft />}
              </button>
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
