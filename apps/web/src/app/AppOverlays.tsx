import { Suspense, lazy, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { SettingsPage } from '../SelfHostedSettings.js';
import type { TrajectoryDraft } from '../rewind.js';
import type {
  Bootstrap,
  CatalogueModel,
  Task,
  TaskEvent,
  TaskRewindPreview,
  Workspace
} from '../types.js';
import type { AgentNotification } from '../notice-log.js';

/**
 * Rewind is reached by an explicit click on a control that is itself behind a menu, and it is the
 * one dialog in the product nobody opens by accident. Behind `lazy` it costs the first paint
 * nothing, and the fetch it does cost lands while the owner is still reading a dialog that asks
 * them to confirm undoing a turn.
 */
const RewindDialog = lazy(() =>
  import('../RewindDialog.js').then(({ RewindDialog: Dialog }) => ({ default: Dialog }))
);

/**
 * Scheduling and the notice log are both reached by an explicit choice from a menu, and both
 * carried their whole weight into the first paint because `Approvals` sat in the same file and an
 * approval has to be eager. Splitting the file is what lets these two leave; the owner who opens
 * one is looking at a dialog while it arrives.
 */
const ScheduleModal = lazy(() =>
  import('../ScheduleModal.js').then(({ ScheduleModal: Schedules }) => ({ default: Schedules }))
);

const NoticeLog = lazy(() =>
  import('../NoticeLog.js').then(({ NoticeLog: Notices }) => ({ default: Notices }))
);

/**
 * Sharing is a deliberate act on one conversation, reached from the palette or from the badge a
 * shared conversation wears, and the dialog carries the preview renderer and the link list with
 * it. Behind `lazy`, the first paint pays for the badge and nothing else.
 */
const ShareDialog = lazy(() =>
  import('../ShareDialog.js').then(({ ShareDialog: Share }) => ({ default: Share }))
);

/**
 * Settings is a modal nobody has open on first paint, and it carries the provider forms, the spend
 * limits, the connector catalogue, the security pages and the QR encoder with it. Behind `lazy` all
 * of that costs nothing until the owner actually opens Settings.
 */
const SelfHostedSettings = lazy(() =>
  import('../SelfHostedSettings.js').then(({ SelfHostedSettings: Settings }) => ({
    default: Settings
  }))
);

/**
 * The five things that open over the workbench, and nothing else.
 *
 * Every one of them is code-split, every one is reached by a deliberate act, and none of them is on
 * screen when the app opens — which is the whole reason they are one component: the workbench below
 * does not need to know they exist, and the first paint does not need to carry them.
 */
export function AppOverlays(props: {
  data: Bootstrap;
  workspace: Workspace | undefined;
  events: TaskEvent[];
  task: Task | undefined;
  taskIsActive: boolean;
  busy: boolean;
  models: CatalogueModel[];

  trajectory: TrajectoryDraft | undefined;
  onTrajectory: Dispatch<SetStateAction<TrajectoryDraft | undefined>>;
  rewindPreview: TaskRewindPreview | undefined;
  trajectoryPrompt: RefObject<HTMLTextAreaElement | null>;
  onRunTrajectory: () => void;

  notices: AgentNotification[];
  noticeLogOpen: boolean;
  onCloseNoticeLog: () => void;
  /** Opening a conversation from the log also closes the phone drawer; opening one from Settings does not. */
  onOpenTaskFromNotices: (id: string) => void;

  scheduleOpen: boolean;
  onCloseSchedule: () => void;
  schedulePrompt: string;
  workspaceId: string | undefined;
  onSchedulesChanged: () => Promise<void>;

  settingsPage: SettingsPage | undefined;
  onCloseSettings: () => void;
  onOpenTerminal: () => void;
  onOpenTask: (id: string) => void;
  onLogout: () => void;
  onSettingsPage: (page: SettingsPage | undefined) => void;
  onWorkspaceId: (id: string) => void;

  shareOpen: boolean;
  onCloseShare: () => void;
  onShareNotice: (message: string) => void;
  onShareError: (message: string) => void;
  onShareCount: (count: number) => void;
}) {
  return (
    <>
      {props.trajectory && props.task && (
        <Suspense fallback={null}>
          <RewindDialog
            trajectory={props.trajectory}
            onChange={props.onTrajectory}
            preview={props.rewindPreview}
            promptRef={props.trajectoryPrompt}
            taskIsActive={props.taskIsActive}
            busy={props.busy}
            /*
              The catalogue and the model this conversation is already on. The dialog draws no
              model row without both, deliberately: it would rather offer nothing than offer a
              choice this caller then drops, which is what happened until `run` below learned to
              carry `modelId`.
            */
            models={props.models}
            currentModelId={props.task.modelId}
            onConfirm={props.onRunTrajectory}
            onCancel={() => props.onTrajectory(undefined)}
            onOpenRecoveryPoints={() => props.onSettingsPage('server')}
          />
        </Suspense>
      )}
      {props.noticeLogOpen && (
        <Suspense fallback={null}>
          <NoticeLog
            notices={props.notices}
            onOpenTask={props.onOpenTaskFromNotices}
            onClose={props.onCloseNoticeLog}
          />
        </Suspense>
      )}
      {props.scheduleOpen && (
        <Suspense fallback={null}>
          <ScheduleModal
            schedules={props.data.schedules}
            workspaces={props.data.workspaces}
            models={props.data.models}
            {...(props.workspaceId ? { defaultWorkspaceId: props.workspaceId } : {})}
            initialPrompt={props.schedulePrompt}
            onClose={props.onCloseSchedule}
            onChanged={props.onSchedulesChanged}
          />
        </Suspense>
      )}
      {props.shareOpen && props.task && (
        <Suspense fallback={null}>
          <ShareDialog
            task={props.task}
            onClose={props.onCloseShare}
            onNotice={props.onShareNotice}
            onError={props.onShareError}
            onShareCount={props.onShareCount}
          />
        </Suspense>
      )}
      {props.settingsPage && (
        <Suspense fallback={null}>
          <SelfHostedSettings
            user={props.data.user}
            workspace={props.workspace}
            tasks={props.data.tasks}
            conversationEvents={props.events}
            legal={props.data.legal}
            initialPage={props.settingsPage}
            onOpenTerminal={props.onOpenTerminal}
            onOpenTask={(id) => {
              const target = props.data.tasks.find((item) => item.id === id);
              if (target) props.onWorkspaceId(target.workspaceId);
              props.onSettingsPage(undefined);
              props.onOpenTask(id);
            }}
            onClose={props.onCloseSettings}
            onLogout={props.onLogout}
          />
        </Suspense>
      )}
    </>
  );
}
