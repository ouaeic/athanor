import { Archive, MessageSquarePlus, Monitor, Play, TerminalSquare } from 'lucide-react';
import type { InspectorTab } from '../client-state.js';

/** The five destinations a phone can reach, and the icon each answers to. */
const destinations = [
  ['work', 'Work', MessageSquarePlus],
  ['files', 'Files', Archive],
  ['computer', 'Computer', Monitor],
  ['terminal', 'Terminal', TerminalSquare],
  ['preview', 'Running', Play]
] as const;

/**
 * The tab that is showing, which is not always the tab that was chosen.
 *
 * While the panel is following the running work this bar has to point at the pane actually on
 * screen, or the phone says the owner is looking at Files while a terminal fills the window.
 * Exported because it is the whole of this component's judgement and the only part worth reading
 * back without a browser.
 */
export const activeMobileTab = (input: {
  id: (typeof destinations)[number][0];
  inspectorOpen: boolean;
  shownTab: InspectorTab;
}): boolean =>
  input.id === 'work' ? !input.inspectorOpen : input.inspectorOpen && input.shownTab === input.id;

/**
 * One pane switcher on a phone, and it reaches everywhere.
 *
 * This bar and the Inspector's own strip were two switchers doing the same job and disagreeing
 * about what existed: three of the seven destinations were only in the strip, so a phone reached
 * them through an overflow menu that was a second mental model. There are four surfaces now, they
 * all fit, and the menu is gone.
 */
export function MobileTabs(props: {
  inspectorOpen: boolean;
  shownTab: InspectorTab;
  onWork: () => void;
  onTab: (tab: InspectorTab) => void;
}) {
  return (
    <nav className="mobile-tabs" aria-label="Primary">
      {destinations.map(([id, label, Icon]) => {
        const active = activeMobileTab({
          id,
          inspectorOpen: props.inspectorOpen,
          shownTab: props.shownTab
        });
        return (
          <button
            key={id}
            onClick={() => (id === 'work' ? props.onWork() : props.onTab(id))}
            className={active ? 'active' : ''}
            aria-current={active ? 'page' : undefined}
          >
            <Icon />
            {label}
          </button>
        );
      })}
    </nav>
  );
}
