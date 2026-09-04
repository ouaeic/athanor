import { Suspense, lazy, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { CommandPalette, type Command } from '../CommandPalette.js';
import { Timeline } from '../Timeline.js';
import { UndoProvider, UndoToasts } from '../Undo.js';
import { api } from '../api.js';
import type { SendBlock } from '../composer-state.js';
import { describeFailure } from '../failure-text.js';
import { paneId } from '../shortcuts.js';
import { upsertTask } from '../task-list.js';
import type { BotWall, Bootstrap, ConversationSearchResult, Task, Workspace } from '../types.js';
import type { FireState } from '../fire.js';
import type { useUndoQueue } from '../Undo.js';

import { AppOverlays } from './AppOverlays.js';
import { ConversationSidebar } from './ConversationSidebar.js';
import { ComposerPane } from './ComposerPane.js';
import { MobileTabs } from './MobileTabs.js';
import { ShortcutSheet } from './ShortcutSheet.js';
import { WorkbenchHeader } from './WorkbenchHeader.js';
import { computerHeldBy, mayOfferReload } from './conversation-facts.js';
import type { useAgentNotices } from './use-agent-notices.js';
import type { useAttachments } from './use-attachments.js';
import type { useComposerDraft } from './use-composer-draft.js';
import type { useConversationList } from './use-conversation-list.js';
import type { useInspector } from './use-inspector.js';
import type { useMobileNav } from './use-mobile-nav.js';
import type { useModelChoice } from './use-model-choice.js';
import type { useOverlays } from './use-overlays.js';
import type { usePaneFocus } from './use-pane-focus.js';
import type { useSend } from './use-send.js';
import type { useShellStatus } from './use-shell-status.js';
import type { useSpendCeiling } from './use-spend-ceiling.js';
import type { useTrajectory } from './use-trajectory.js';
import type { useTranscript } from './use-transcript.js';
import type { useVoiceNote } from './use-voice-note.js';

const Inspector = lazy(() =>
  import('../Inspector.js').then(({ Inspector: InspectorComponent }) => ({
    default: InspectorComponent
  }))
);

/**
 * The screen, once the box has answered.
 *
 * Every prop here is one of `App`'s hooks handed over whole rather than picked apart, and that is
 * the point: each hook returns exactly the cells and actions one part of this layout needs, so the
 * seam between deciding and drawing falls where the state already divides. `App` assembles; this
 * draws, and holds no state of its own.
 *
 * `data` is not optional here. Above the auth gate it always was, and every read of it carried a
 * `?.` that could only ever be answered one way — which is the sort of question a reader has to
 * re-answer on every line.
 */
export function Workbench(props: {
  data: Bootstrap;
  workspace: Workspace | undefined;
  task: Task | undefined;
  taskId: string | undefined;
  workspaceId: string | undefined;
  taskIsActive: boolean;
  offline: boolean;
  fire: FireState;
  /** The challenge that has taken the browser away from the agent, for the whole computer. */
  browserWall: BotWall | undefined;
  blocked: SendBlock | undefined;
  turnChanges: { eventId: string; line: string } | undefined;
  shellSuperseded: boolean;
  nativeFolderPicker: boolean;
  commands: Command[];
  announcement: string;
  setAnnouncement: (sentence: string) => void;
  composer: RefObject<HTMLTextAreaElement | null>;
  approvalCard: RefObject<HTMLDivElement | null>;
  setTaskId: Dispatch<SetStateAction<string | undefined>>;
  setWorkspaceId: Dispatch<SetStateAction<string | undefined>>;
  setData: Dispatch<SetStateAction<Bootstrap | undefined>>;
  setAuth: Dispatch<SetStateAction<'loading' | 'required' | 'ready'>>;
  load: () => Promise<void>;
  startNewConversation: () => void;
  reloadForNewShell: () => void;
  pauseConversation: (target: Task) => void;
  openNotices: () => void;
  searchConversations: (
    query: string,
    thisComputerOnly?: boolean
  ) => Promise<ConversationSearchResult[]>;

  attachments: ReturnType<typeof useAttachments>;
  ceiling: ReturnType<typeof useSpendCeiling>;
  draft: ReturnType<typeof useComposerDraft>;
  inspector: ReturnType<typeof useInspector>;
  list: ReturnType<typeof useConversationList>;
  model: ReturnType<typeof useModelChoice>;
  nav: ReturnType<typeof useMobileNav>;
  notices: ReturnType<typeof useAgentNotices>;
  overlays: ReturnType<typeof useOverlays>;
  panes: ReturnType<typeof usePaneFocus>;
  send: ReturnType<typeof useSend>;
  status: ReturnType<typeof useShellStatus>;
  trajectory: ReturnType<typeof useTrajectory>;
  transcript: ReturnType<typeof useTranscript>;
  undo: ReturnType<typeof useUndoQueue>;
  voice: ReturnType<typeof useVoiceNote>;
}) {
  const {
    data,
    workspace,
    task,
    taskId,
    taskIsActive,
    blocked,
    attachments,
    ceiling,
    draft,
    inspector,
    list,
    model,
    nav,
    notices,
    overlays,
    panes,
    send,
    status,
    trajectory,
    transcript,
    undo,
    voice,
    setTaskId,
    setWorkspaceId,
    setData,
    load,
    announcement,
    setAnnouncement,
    composer,
    approvalCard
  } = props;

  return (
    <UndoProvider value={undo.queue}>
      <div className={`app-shell ${inspector.open ? '' : 'inspector-closed'}`}>
        {/*
          The first thing in the tab order, and invisible until it is reached.

          The sidebar lists every conversation the owner has, so before this the transcript was as
          many Tab presses away as there were conversations - sixty-odd on a well-used athanor. It
          moves focus itself rather than letting the browser follow the fragment, because the shell
          keeps the open conversation in the query string and a hash would push a history entry the
          back button then has to walk back through.
        */}
        <a
          className="skip-link"
          href={`#${paneId('conversation')}`}
          onClick={(event) => {
            event.preventDefault();
            panes.focusPane('conversation');
          }}
        >
          Skip to the conversation
        </a>
        <ConversationSidebar
          navOpen={nav.open}
          onCloseNav={() => nav.setOpen(false)}
          user={data.user}
          fire={props.fire}
          workspaces={data.workspaces}
          tasks={list.rows}
          scheduleRunCounts={data.scheduleRunCounts}
          schedules={data.schedules}
          selectedWorkspaceId={props.workspaceId}
          selectedTaskId={taskId}
          onTask={setTaskId}
          onNewTask={props.startNewConversation}
          onComputerSettings={() => overlays.openSettings('server')}
          onSettings={() => overlays.openSettings()}
          onSchedules={() => overlays.setSchedules(true)}
          noticeCount={notices.notices.length}
          onNotices={props.openNotices}
          onSearch={props.searchConversations}
          onRename={(id, title) => void list.rename(id, title)}
          onDelete={list.remove}
          onEarlier={data.tasksCursor ? () => void list.loadEarlier() : undefined}
          loadingEarlier={list.loadingEarlier}
          showArchived={list.showArchived}
          onShowArchived={(next) => void list.revealArchived(next)}
          loadingArchived={list.loadingArchived}
        />
        <main className="workbench">
          <WorkbenchHeader
            task={task}
            workspace={workspace}
            computerHolder={computerHeldBy(task, data.tasks)}
            taskIsActive={taskIsActive}
            inspectorOpen={inspector.open}
            offerReload={mayOfferReload({
              superseded: props.shellSuperseded,
              recording: voice.recording,
              attachmentCount: attachments.attachments.length
            })}
            onOpenNav={(opener) => {
              nav.opener.current = opener;
              nav.setOpen(true);
            }}
            onOpenTask={setTaskId}
            onReload={props.reloadForNewShell}
            onPause={props.pauseConversation}
            onShare={() => overlays.setShare(true)}
            onToggleInspector={() => inspector.setOpen(!inspector.open)}
          />
          {/* A named region with `tabIndex={-1}`: the skip link, ⌘2 and F6 all put focus here, and
              a region that can be focused has to be able to say what it is when they do. */}
          <section
            className="chat-canvas"
            id={paneId('conversation')}
            tabIndex={-1}
            aria-label="Conversation"
          >
            <Timeline
              task={task}
              tasks={data.tasks}
              events={send.timelineEvents}
              {...(props.turnChanges ? { turnChanges: props.turnChanges } : {})}
              missing={list.missing}
              modelName={model.namedModel}
              earlierAvailable={transcript.eventWindow.more}
              earlierLoading={transcript.eventWindow.loading}
              onLoadEarlier={() => void transcript.loadEarlier()}
              onOpenTask={setTaskId}
              onOpenSpendCaps={() => overlays.openSettings('ai')}
              /*
                A private preview's address is minted on request, not stored: only the hash of its
                access token is kept, so the URL on the event has no token and answers 401. Asking
                for one here is what the Preview tab has always done; the card at the end of "build
                me something and give me a link I can open" handed over the address that does not.
              */
              onOpenPreview={(previewId) => {
                void api
                  .previewAccess(previewId)
                  .then((preview) => {
                    window.open(preview.url, '_blank', 'noreferrer');
                  })
                  .catch((cause: unknown) =>
                    status.setError(describeFailure(cause, 'That preview could not be opened'))
                  );
              }}
              onCompose={(text) => {
                draft.setPrompt(text);
                window.requestAnimationFrame(() => composer.current?.focus());
              }}
              onBranch={(event) => void trajectory.branchFrom(event.id)}
              onEdit={trajectory.edit}
              onRetry={trajectory.retry}
              onOpenSurface={inspector.openTab}
              onOpenFile={inspector.openFile}
            />
          </section>
          <ComposerPane
            data={data}
            workspace={workspace}
            task={task}
            taskId={taskId}
            taskIsActive={taskIsActive}
            offline={props.offline}
            blocked={blocked}
            nativeFolderPicker={props.nativeFolderPicker}
            openTaskEvents={transcript.events}
            streamDegraded={transcript.streamDegraded}
            taskTitles={list.titles}
            composer={composer}
            approvalCard={approvalCard}
            setTaskId={setTaskId}
            setAnnouncement={setAnnouncement}
            load={load}
            attachments={attachments}
            ceiling={ceiling}
            draft={draft}
            inspector={inspector}
            model={model}
            notices={notices}
            overlays={overlays}
            send={send}
            status={status}
            voice={voice}
          />
          <MobileTabs
            inspectorOpen={inspector.open}
            shownTab={inspector.shownTab}
            onWork={() => inspector.setOpen(false)}
            onTab={inspector.openTab}
          />
        </main>
        {/*
          Built the first time it is asked for and never taken down again.

          The Inspector mounts all four panes and hides the ones behind, so that a glance at Files no
          longer closes the socket the runner kills the pty on. Rendering it behind `inspector.open`
          undid the whole of that on a phone, where "Work" is the primary destination: tapping it -
          or ⌘B, or the header toggle - unmounted the panel, and with it the terminal, so the owner's
          build died on the way to reading the answer. Same principle one level up, same `hidden`.
        */}
        {inspector.mounted.current && (
          <Suspense
            fallback={<aside className="inspector inspector-loading">Opening tools…</aside>}
          >
            <Inspector
              workspace={workspace}
              initialTab={inspector.shownTab}
              {...(props.browserWall ? { wall: props.browserWall } : {})}
              hidden={!inspector.open}
              onTab={inspector.chooseTab}
              taskIsActive={taskIsActive}
              {...(inspector.fileTarget ? { openFile: inspector.fileTarget } : {})}
            />
          </Suspense>
        )}
        {overlays.shortcutSheet && (
          <ShortcutSheet onClose={() => overlays.setShortcutSheet(false)} />
        )}
        <CommandPalette
          open={overlays.palette}
          onClose={() => overlays.setPalette(false)}
          commands={props.commands}
          tasks={data.tasks}
          onOpenTask={(target) => {
            setWorkspaceId(target.workspaceId);
            setTaskId(target.id);
            nav.setOpen(false);
          }}
          search={props.searchConversations}
        />
        <AppOverlays
          data={data}
          workspace={workspace}
          events={transcript.events}
          task={task}
          taskIsActive={taskIsActive}
          busy={status.busy}
          models={model.models}
          trajectory={trajectory.draft}
          onTrajectory={trajectory.setDraft}
          rewindPreview={trajectory.preview}
          trajectoryPrompt={trajectory.promptRef}
          onRunTrajectory={() => void trajectory.run()}
          notices={notices.notices}
          noticeLogOpen={overlays.noticeLog}
          onCloseNoticeLog={() => overlays.setNoticeLog(false)}
          onOpenTaskFromNotices={(id) => {
            setTaskId(id);
            nav.setOpen(false);
          }}
          scheduleOpen={overlays.schedules}
          onCloseSchedule={() => overlays.setSchedules(false)}
          schedulePrompt={draft.prompt}
          workspaceId={props.workspaceId}
          onSchedulesChanged={async () => {
            await load();
          }}
          settingsPage={overlays.settingsPage}
          onCloseSettings={() => {
            overlays.setSettingsPage(undefined);
            void load();
            ceiling.recheck();
          }}
          onOpenTerminal={() => {
            overlays.setSettingsPage(undefined);
            inspector.openTab('terminal');
          }}
          onOpenTask={setTaskId}
          onSettingsPage={overlays.setSettingsPage}
          onWorkspaceId={setWorkspaceId}
          shareOpen={overlays.share}
          onCloseShare={() => overlays.setShare(false)}
          onShareNotice={status.setNotice}
          onShareError={status.setError}
          onShareCount={(count) => {
            if (!task) return;
            setData((current) =>
              current
                ? { ...current, tasks: upsertTask(current.tasks, { ...task, shareCount: count }) }
                : current
            );
          }}
          onLogout={() =>
            void api
              .logout()
              .catch(() => undefined)
              .then(() => {
                overlays.setSettingsPage(undefined);
                props.setAuth('required');
                setData(undefined);
              })
          }
        />
        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>
        <UndoToasts queue={undo.queue} pending={undo.pending} />
      </div>
    </UndoProvider>
  );
}
