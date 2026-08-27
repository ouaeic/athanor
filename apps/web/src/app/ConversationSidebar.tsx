import type { ComponentProps } from 'react';
import { Sidebar } from '../Sidebar.js';
import { paneId } from '../shortcuts.js';

/** Everything the list needs, minus the two props the two copies of it disagree about. */
type SidebarProps = Omit<ComponentProps<typeof Sidebar>, 'regionId' | 'onTask' | 'onNotices'>;

/**
 * The conversation list, mounted twice, described once.
 *
 * The same sidebar serves the narrow layout and the wide one and CSS decides which is seen — the
 * drawer cannot simply be the desktop copy moved, because both have to exist for the transition
 * between them to be a stylesheet rather than a remount. What that cost until now was eighty lines
 * of identical props written out twice, one of the two silently drifting from the other being a
 * matter of time.
 *
 * The three real differences are here and nowhere else: the region id belongs to the visible copy
 * only, because an id has to be unique and on a phone the drawer is inert or off-screen and so is
 * not a place focus can go; and opening a conversation or the notice log from the drawer also
 * closes the drawer.
 */
export function ConversationSidebar(
  props: SidebarProps & {
    navOpen: boolean;
    onCloseNav: () => void;
    onTask: (id: string) => void;
    onNotices: () => void;
  }
) {
  const { navOpen, onCloseNav, onTask, onNotices, ...shared } = props;
  return (
    <>
      {/* `inert` is what stops the unseen copy from also being there for a screen reader and for the
          tab order: without it the page offers two conversation lists and two search fields, one of
          them invisible. */}
      <div className={`mobile-sidebar ${navOpen ? 'open' : ''}`} inert={!navOpen}>
        <Sidebar
          {...shared}
          onTask={(id) => {
            onTask(id);
            onCloseNav();
          }}
          onNotices={() => {
            onNotices();
            onCloseNav();
          }}
        />
      </div>
      {navOpen && (
        // Named, because a bare button is announced as "button" and nothing else. It is the one
        // overlay in the product that is not a Dialog - the panel it dims is the same sidebar the
        // desktop layout uses, so it cannot simply be wrapped in one - which is why Escape and a
        // name had to be given to it directly.
        <button className="mobile-scrim" aria-label="Close navigation" onClick={onCloseNav} />
      )}
      <Sidebar
        regionId={paneId('conversations')}
        {...shared}
        onTask={onTask}
        onNotices={onNotices}
      />
    </>
  );
}
