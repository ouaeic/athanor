import type { Database } from './database.js';
import { IdentityStore } from './store/identity.js';
import { BillingStore } from './store/billing.js';
import { ConnectorStore } from './store/connectors.js';
import { NotificationStore } from './store/notifications.js';
import { MemoryStore } from './store/memory.js';
import { TaskSignals, TaskStore } from './store/tasks.js';
import { ScheduleStore } from './store/schedules.js';
import { WorkspaceStore } from './store/workspaces.js';
import { MaintenanceStore } from './store/maintenance.js';

/**
 * Re-exported for one release. `MEMORY_SOURCE_SEARCH_PER_TASK` moved to `store/sql/memory.ts`
 * with the statement whose cap it is, and `@athanor/data` publishes this file wholesale - so
 * without this line the package would silently stop exporting a name it has always exported. It can
 * go once nothing outside this package reaches for it through the barrel.
 */
export { MEMORY_SOURCE_SEARCH_PER_TASK } from './store/sql/memory.js';

/**
 * Re-exported for the same reason and on the same terms. `MAX_APPROVAL_PAGE`,
 * `agentNotificationAad` and `StoredNotificationSettings` moved in Wave 6.3 to the domain files
 * whose statements they belong to, and `@athanor/data` publishes this file wholesale - so without
 * these lines the package would silently stop exporting three names it has always exported, and
 * `apps/api` and `apps/worker` would stop compiling. They can go once every importer names
 * `@athanor/data`'s new modules directly.
 */
export { MAX_APPROVAL_PAGE } from './store/connectors.js';
export { agentNotificationAad } from './store/notifications.js';
export type { StoredNotificationSettings } from './store/notifications.js';

/**
 * Re-exported on the same terms as the block above. The five domains Wave 7.3 lifted took their
 * own constants and record shapes with them, and `@athanor/data` publishes this file wholesale, so
 * these lines are what keeps the package exporting the names it has always exported. They can go
 * once every importer names the new modules directly.
 */
export {
  LIVE_TASK_STATUSES,
  MAX_TASK_EVENT_PAGE,
  SETTLED_TASK_STATUSES,
  TASK_MAX_ATTEMPTS
} from './store/tasks.js';
export type { TaskEventPage, TaskListFilter, TaskNameHit, TaskPage } from './store/tasks.js';
export type {
  CreateMemoryItemInput,
  MemoryCandidateRecord,
  MemoryCapabilities,
  MemoryConsolidationReport,
  MemoryFactCandidateRecord,
  MemoryFactPromotion,
  MemoryItemRecord,
  MemoryLinkRecord,
  MemoryLinkRelation,
  MemoryPackRecord,
  MemoryProcedureReviewRecord,
  MemorySourceChannel,
  MemorySourceHit,
  MemorySourceRecord,
  MemoryUseOutcome,
  PreparedMemoryFact,
  RecallMemoryInput,
  SearchMemorySourcesInput
} from './store/memory.js';

export class DataStore {
  /**
   * The domains, lifted to `store/*.ts` across Waves 6.3 and 7.3. Constructed in the constructor
   * body rather than in field initialisers: with `useDefineForClassFields` on under ES2022 a field
   * initialiser runs before the constructor body, so a field would have captured `undefined` and
   * every forwarded call would have queried nothing.
   */
  readonly #identity: IdentityStore;
  readonly #billing: BillingStore;
  readonly #connectors: ConnectorStore;
  readonly #notifications: NotificationStore;
  readonly #memory: MemoryStore;
  readonly #workspaces: WorkspaceStore;
  readonly #taskSignals: TaskSignals;
  readonly #tasks: TaskStore;
  readonly #schedules: ScheduleStore;
  readonly #maintenance: MaintenanceStore;

  constructor(database: Database) {
    this.#identity = new IdentityStore(database);
    this.#billing = new BillingStore(database);
    this.#connectors = new ConnectorStore(database);
    this.#notifications = new NotificationStore(database);
    this.#memory = new MemoryStore(database);
    this.#workspaces = new WorkspaceStore(database);
    // One emitter and one LISTEN connection per process, shared by the two domains that write rows
    // worth waking somebody for. Two of these would mean two connections and two deliveries.
    this.#taskSignals = new TaskSignals(database);
    this.#tasks = new TaskStore(database, this.#taskSignals);
    // The billing store itself, not a copy of its statements: `materializeTaskSchedule` runs the
    // spend guard on the same transaction handle that inserts the task it authorises.
    this.#schedules = new ScheduleStore(database, this.#billing, this.#taskSignals);
    this.#maintenance = new MaintenanceStore(database);
  }

  onTaskEvent(...args: Parameters<TaskSignals['onTaskEvent']>) {
    return this.#taskSignals.onTaskEvent(...args);
  }

  waitForQueuedTask(...args: Parameters<TaskSignals['waitForQueuedTask']>) {
    return this.#taskSignals.waitForQueuedTask(...args);
  }

  waitForAnsweredTask(...args: Parameters<TaskSignals['waitForAnsweredTask']>) {
    return this.#taskSignals.waitForAnsweredTask(...args);
  }

  // ---------------------------------------------------------------------------------------------
  // The domains, lifted to `store/*.ts` in Waves 6.3 and 7.3. Nothing below this line is a
  // statement; every one of them is one hop to the file that owns the table.
  //
  // Each name below still resolves on `DataStore`, because every caller in this repository and
  // every consumer of the `@athanor/data` barrel reaches the store through this one object. What
  // moved is the SQL, not the surface.
  //
  // The signatures are deliberately not restated. Forwarding `Parameters<IdentityStore['...']>`
  // means the facade cannot drift from the implementation it forwards to; a hand-copied signature
  // is the exact shape this codebase has already produced twice - two envelope validators that
  // disagreed, two `textValue` helpers with different semantics - and a store method's argument
  // object is far wider than either.
  //
  // A forward earns its line by having a caller outside this package. Fifteen did not: fourteen
  // were reached only by `store.test.ts`, which is inside the package and can name the domain
  // store directly, and `deleteMemoryPack` was reached by nothing at all. They are gone, and the
  // methods behind them - except `deleteMemoryPack`, which went with its forward - are unchanged
  // and still tested, now through the module that owns the table.
  //
  // That leaves 207, every one of which has a real caller in `apps/*`, `services/*` or `evals/`.
  // Those cannot be deleted from here alone: the caller has to name the domain module first, and
  // deleting the forward before it does is a silent barrel regression rather than a shrink. The
  // three re-export blocks above are the same rule in the other direction - they go together, and
  // only once every importer names `store/tasks.js`, `store/memory.js`, `store/connectors.js` and
  // `store/notifications.js` instead of the `@athanor/data` barrel.
  // ---------------------------------------------------------------------------------------------

  createUser(...args: Parameters<IdentityStore['createUser']>) {
    return this.#identity.createUser(...args);
  }

  countUsers(...args: Parameters<IdentityStore['countUsers']>) {
    return this.#identity.countUsers(...args);
  }

  soleUser(...args: Parameters<IdentityStore['soleUser']>) {
    return this.#identity.soleUser(...args);
  }

  getUserById(...args: Parameters<IdentityStore['getUserById']>) {
    return this.#identity.getUserById(...args);
  }

  getUserByUsername(...args: Parameters<IdentityStore['getUserByUsername']>) {
    return this.#identity.getUserByUsername(...args);
  }

  createChallenge(...args: Parameters<IdentityStore['createChallenge']>) {
    return this.#identity.createChallenge(...args);
  }

  consumeChallenge(...args: Parameters<IdentityStore['consumeChallenge']>) {
    return this.#identity.consumeChallenge(...args);
  }

  addPasskey(...args: Parameters<IdentityStore['addPasskey']>) {
    return this.#identity.addPasskey(...args);
  }

  setRecoveryHash(...args: Parameters<IdentityStore['setRecoveryHash']>) {
    return this.#identity.setRecoveryHash(...args);
  }

  replacePasskeysForRecovery(...args: Parameters<IdentityStore['replacePasskeysForRecovery']>) {
    return this.#identity.replacePasskeysForRecovery(...args);
  }

  listPasskeys(...args: Parameters<IdentityStore['listPasskeys']>) {
    return this.#identity.listPasskeys(...args);
  }

  getPasskeyByCredentialId(...args: Parameters<IdentityStore['getPasskeyByCredentialId']>) {
    return this.#identity.getPasskeyByCredentialId(...args);
  }

  deletePasskeyForUser(...args: Parameters<IdentityStore['deletePasskeyForUser']>) {
    return this.#identity.deletePasskeyForUser(...args);
  }

  updatePasskeyCounter(...args: Parameters<IdentityStore['updatePasskeyCounter']>) {
    return this.#identity.updatePasskeyCounter(...args);
  }

  createSession(...args: Parameters<IdentityStore['createSession']>) {
    return this.#identity.createSession(...args);
  }

  getSession(...args: Parameters<IdentityStore['getSession']>) {
    return this.#identity.getSession(...args);
  }

  createDeviceEnrollment(...args: Parameters<IdentityStore['createDeviceEnrollment']>) {
    return this.#identity.createDeviceEnrollment(...args);
  }

  findDeviceEnrollment(...args: Parameters<IdentityStore['findDeviceEnrollment']>) {
    return this.#identity.findDeviceEnrollment(...args);
  }

  consumeDeviceEnrollment(...args: Parameters<IdentityStore['consumeDeviceEnrollment']>) {
    return this.#identity.consumeDeviceEnrollment(...args);
  }

  listDeviceEnrollments(...args: Parameters<IdentityStore['listDeviceEnrollments']>) {
    return this.#identity.listDeviceEnrollments(...args);
  }

  revokeDeviceEnrollment(...args: Parameters<IdentityStore['revokeDeviceEnrollment']>) {
    return this.#identity.revokeDeviceEnrollment(...args);
  }

  deleteSession(...args: Parameters<IdentityStore['deleteSession']>) {
    return this.#identity.deleteSession(...args);
  }

  listSessions(...args: Parameters<IdentityStore['listSessions']>) {
    return this.#identity.listSessions(...args);
  }

  getSessionPublicId(...args: Parameters<IdentityStore['getSessionPublicId']>) {
    return this.#identity.getSessionPublicId(...args);
  }

  markSessionStepUp(...args: Parameters<IdentityStore['markSessionStepUp']>) {
    return this.#identity.markSessionStepUp(...args);
  }

  hasRecentSessionStepUp(...args: Parameters<IdentityStore['hasRecentSessionStepUp']>) {
    return this.#identity.hasRecentSessionStepUp(...args);
  }

  deleteSessionForUser(...args: Parameters<IdentityStore['deleteSessionForUser']>) {
    return this.#identity.deleteSessionForUser(...args);
  }

  createApiToken(...args: Parameters<IdentityStore['createApiToken']>) {
    return this.#identity.createApiToken(...args);
  }

  authenticateApiToken(...args: Parameters<IdentityStore['authenticateApiToken']>) {
    return this.#identity.authenticateApiToken(...args);
  }

  listApiTokens(...args: Parameters<IdentityStore['listApiTokens']>) {
    return this.#identity.listApiTokens(...args);
  }

  revokeApiToken(...args: Parameters<IdentityStore['revokeApiToken']>) {
    return this.#identity.revokeApiToken(...args);
  }

  beginOperation(...args: Parameters<IdentityStore['beginOperation']>) {
    return this.#identity.beginOperation(...args);
  }

  completeOperation(...args: Parameters<IdentityStore['completeOperation']>) {
    return this.#identity.completeOperation(...args);
  }

  failOperation(...args: Parameters<IdentityStore['failOperation']>) {
    return this.#identity.failOperation(...args);
  }

  recordSecurityEvent(...args: Parameters<IdentityStore['recordSecurityEvent']>) {
    return this.#identity.recordSecurityEvent(...args);
  }

  createWorkspace(...args: Parameters<WorkspaceStore['createWorkspace']>) {
    return this.#workspaces.createWorkspace(...args);
  }

  listWorkspaces(...args: Parameters<WorkspaceStore['listWorkspaces']>) {
    return this.#workspaces.listWorkspaces(...args);
  }

  getWorkspace(...args: Parameters<WorkspaceStore['getWorkspace']>) {
    return this.#workspaces.getWorkspace(...args);
  }

  getWorkspaceById(...args: Parameters<WorkspaceStore['getWorkspaceById']>) {
    return this.#workspaces.getWorkspaceById(...args);
  }

  workspaceBelongsToUser(...args: Parameters<WorkspaceStore['workspaceBelongsToUser']>) {
    return this.#workspaces.workspaceBelongsToUser(...args);
  }

  updateWorkspaceStatus(...args: Parameters<WorkspaceStore['updateWorkspaceStatus']>) {
    return this.#workspaces.updateWorkspaceStatus(...args);
  }

  listRunningWorkspaces(...args: Parameters<WorkspaceStore['listRunningWorkspaces']>) {
    return this.#workspaces.listRunningWorkspaces(...args);
  }

  touchWorkspace(...args: Parameters<WorkspaceStore['touchWorkspace']>) {
    return this.#workspaces.touchWorkspace(...args);
  }

  setWorkspaceStorage(...args: Parameters<WorkspaceStore['setWorkspaceStorage']>) {
    return this.#workspaces.setWorkspaceStorage(...args);
  }

  updateWorkspaceResources(...args: Parameters<WorkspaceStore['updateWorkspaceResources']>) {
    return this.#workspaces.updateWorkspaceResources(...args);
  }

  deleteWorkspace(...args: Parameters<WorkspaceStore['deleteWorkspace']>) {
    return this.#workspaces.deleteWorkspace(...args);
  }

  deleteUser(...args: Parameters<WorkspaceStore['deleteUser']>) {
    return this.#workspaces.deleteUser(...args);
  }

  createWorkspaceSnapshot(...args: Parameters<WorkspaceStore['createWorkspaceSnapshot']>) {
    return this.#workspaces.createWorkspaceSnapshot(...args);
  }

  listWorkspaceSnapshots(...args: Parameters<WorkspaceStore['listWorkspaceSnapshots']>) {
    return this.#workspaces.listWorkspaceSnapshots(...args);
  }

  getWorkspaceSnapshot(...args: Parameters<WorkspaceStore['getWorkspaceSnapshot']>) {
    return this.#workspaces.getWorkspaceSnapshot(...args);
  }

  setWorkspaceSnapshotStatus(...args: Parameters<WorkspaceStore['setWorkspaceSnapshotStatus']>) {
    return this.#workspaces.setWorkspaceSnapshotStatus(...args);
  }

  completeWorkspaceSnapshot(...args: Parameters<WorkspaceStore['completeWorkspaceSnapshot']>) {
    return this.#workspaces.completeWorkspaceSnapshot(...args);
  }

  deleteWorkspaceSnapshot(...args: Parameters<WorkspaceStore['deleteWorkspaceSnapshot']>) {
    return this.#workspaces.deleteWorkspaceSnapshot(...args);
  }

  recordWorkspaceCheckpoint(...args: Parameters<WorkspaceStore['recordWorkspaceCheckpoint']>) {
    return this.#workspaces.recordWorkspaceCheckpoint(...args);
  }

  getWorkspaceCheckpoint(...args: Parameters<WorkspaceStore['getWorkspaceCheckpoint']>) {
    return this.#workspaces.getWorkspaceCheckpoint(...args);
  }

  checkpointForTaskEvent(...args: Parameters<WorkspaceStore['checkpointForTaskEvent']>) {
    return this.#workspaces.checkpointForTaskEvent(...args);
  }

  deleteWorkspaceCheckpoints(...args: Parameters<WorkspaceStore['deleteWorkspaceCheckpoints']>) {
    return this.#workspaces.deleteWorkspaceCheckpoints(...args);
  }

  createTask(...args: Parameters<TaskStore['createTask']>) {
    return this.#tasks.createTask(...args);
  }

  createTaskBranch(...args: Parameters<TaskStore['createTaskBranch']>) {
    return this.#tasks.createTaskBranch(...args);
  }

  continueTask(...args: Parameters<TaskStore['continueTask']>) {
    return this.#tasks.continueTask(...args);
  }

  enqueueTaskMessage(...args: Parameters<TaskStore['enqueueTaskMessage']>) {
    return this.#tasks.enqueueTaskMessage(...args);
  }

  getNextQueuedTaskMessage(...args: Parameters<TaskStore['getNextQueuedTaskMessage']>) {
    return this.#tasks.getNextQueuedTaskMessage(...args);
  }

  requeueTaskForQueuedMessage(...args: Parameters<TaskStore['requeueTaskForQueuedMessage']>) {
    return this.#tasks.requeueTaskForQueuedMessage(...args);
  }

  strandQueuedTaskMessages(...args: Parameters<TaskStore['strandQueuedTaskMessages']>) {
    return this.#tasks.strandQueuedTaskMessages(...args);
  }

  consumeQueuedTaskMessageInTurn(...args: Parameters<TaskStore['consumeQueuedTaskMessageInTurn']>) {
    return this.#tasks.consumeQueuedTaskMessageInTurn(...args);
  }

  promoteQueuedTaskMessage(...args: Parameters<TaskStore['promoteQueuedTaskMessage']>) {
    return this.#tasks.promoteQueuedTaskMessage(...args);
  }

  completeTaskIfNoQueued(...args: Parameters<TaskStore['completeTaskIfNoQueued']>) {
    return this.#tasks.completeTaskIfNoQueued(...args);
  }

  listTasks(...args: Parameters<TaskStore['listTasks']>) {
    return this.#tasks.listTasks(...args);
  }

  listTaskPage(...args: Parameters<TaskStore['listTaskPage']>) {
    return this.#tasks.listTaskPage(...args);
  }

  updateTaskFiling(...args: Parameters<TaskStore['updateTaskFiling']>) {
    return this.#tasks.updateTaskFiling(...args);
  }

  getTask(...args: Parameters<TaskStore['getTask']>) {
    return this.#tasks.getTask(...args);
  }

  renameTask(...args: Parameters<TaskStore['renameTask']>) {
    return this.#tasks.renameTask(...args);
  }

  listTasksNeedingTitle(...args: Parameters<TaskStore['listTasksNeedingTitle']>) {
    return this.#tasks.listTasksNeedingTitle(...args);
  }

  setGeneratedTaskTitle(...args: Parameters<TaskStore['setGeneratedTaskTitle']>) {
    return this.#tasks.setGeneratedTaskTitle(...args);
  }

  deleteTask(...args: Parameters<TaskStore['deleteTask']>) {
    return this.#tasks.deleteTask(...args);
  }

  createTaskPlan(...args: Parameters<TaskStore['createTaskPlan']>) {
    return this.#tasks.createTaskPlan(...args);
  }

  getLatestTaskPlan(...args: Parameters<TaskStore['getLatestTaskPlan']>) {
    return this.#tasks.getLatestTaskPlan(...args);
  }

  listTaskPlans(...args: Parameters<TaskStore['listTaskPlans']>) {
    return this.#tasks.listTaskPlans(...args);
  }

  listWorkspaceMemories(...args: Parameters<WorkspaceStore['listWorkspaceMemories']>) {
    return this.#workspaces.listWorkspaceMemories(...args);
  }

  createWorkspaceMemory(...args: Parameters<WorkspaceStore['createWorkspaceMemory']>) {
    return this.#workspaces.createWorkspaceMemory(...args);
  }

  updateWorkspaceMemory(...args: Parameters<WorkspaceStore['updateWorkspaceMemory']>) {
    return this.#workspaces.updateWorkspaceMemory(...args);
  }

  deleteWorkspaceMemory(...args: Parameters<WorkspaceStore['deleteWorkspaceMemory']>) {
    return this.#workspaces.deleteWorkspaceMemory(...args);
  }

  syncMemoryPredicates(...args: Parameters<MemoryStore['syncMemoryPredicates']>) {
    return this.#memory.syncMemoryPredicates(...args);
  }

  createMemorySource(...args: Parameters<MemoryStore['createMemorySource']>) {
    return this.#memory.createMemorySource(...args);
  }

  createMemoryItem(...args: Parameters<MemoryStore['createMemoryItem']>) {
    return this.#memory.createMemoryItem(...args);
  }

  recordMemoryFact(...args: Parameters<MemoryStore['recordMemoryFact']>) {
    return this.#memory.recordMemoryFact(...args);
  }

  recordMemoryDeadEnds(...args: Parameters<MemoryStore['recordMemoryDeadEnds']>) {
    return this.#memory.recordMemoryDeadEnds(...args);
  }

  getMemoryItem(...args: Parameters<MemoryStore['getMemoryItem']>) {
    return this.#memory.getMemoryItem(...args);
  }

  listMemoryItems(...args: Parameters<MemoryStore['listMemoryItems']>) {
    return this.#memory.listMemoryItems(...args);
  }

  attachMemoryEvidence(...args: Parameters<MemoryStore['attachMemoryEvidence']>) {
    return this.#memory.attachMemoryEvidence(...args);
  }

  listMemoryEvidence(...args: Parameters<MemoryStore['listMemoryEvidence']>) {
    return this.#memory.listMemoryEvidence(...args);
  }

  observeMemoryFactCandidate(...args: Parameters<MemoryStore['observeMemoryFactCandidate']>) {
    return this.#memory.observeMemoryFactCandidate(...args);
  }

  listPromotableMemoryFactCandidates(
    ...args: Parameters<MemoryStore['listPromotableMemoryFactCandidates']>
  ) {
    return this.#memory.listPromotableMemoryFactCandidates(...args);
  }

  promoteMemoryFactCandidates(...args: Parameters<MemoryStore['promoteMemoryFactCandidates']>) {
    return this.#memory.promoteMemoryFactCandidates(...args);
  }

  markMemoryFactsDisputed(...args: Parameters<MemoryStore['markMemoryFactsDisputed']>) {
    return this.#memory.markMemoryFactsDisputed(...args);
  }

  retractMemoryItem(...args: Parameters<MemoryStore['retractMemoryItem']>) {
    return this.#memory.retractMemoryItem(...args);
  }

  recordMemoryUse(...args: Parameters<MemoryStore['recordMemoryUse']>) {
    return this.#memory.recordMemoryUse(...args);
  }

  verifyMemoryProcedure(...args: Parameters<MemoryStore['verifyMemoryProcedure']>) {
    return this.#memory.verifyMemoryProcedure(...args);
  }

  listStaleMemoryProcedures(...args: Parameters<MemoryStore['listStaleMemoryProcedures']>) {
    return this.#memory.listStaleMemoryProcedures(...args);
  }

  listDisputedMemoryItems(...args: Parameters<MemoryStore['listDisputedMemoryItems']>) {
    return this.#memory.listDisputedMemoryItems(...args);
  }

  recallMemoryCandidates(...args: Parameters<MemoryStore['recallMemoryCandidates']>) {
    return this.#memory.recallMemoryCandidates(...args);
  }

  searchMemorySources(...args: Parameters<MemoryStore['searchMemorySources']>) {
    return this.#memory.searchMemorySources(...args);
  }

  memorySourceCoverage(...args: Parameters<MemoryStore['memorySourceCoverage']>) {
    return this.#memory.memorySourceCoverage(...args);
  }

  listMemorySourceWindow(...args: Parameters<MemoryStore['listMemorySourceWindow']>) {
    return this.#memory.listMemorySourceWindow(...args);
  }

  getMemoryPack(...args: Parameters<MemoryStore['getMemoryPack']>) {
    return this.#memory.getMemoryPack(...args);
  }

  saveMemoryPack(...args: Parameters<MemoryStore['saveMemoryPack']>) {
    return this.#memory.saveMemoryPack(...args);
  }

  consolidateMemory(...args: Parameters<MemoryStore['consolidateMemory']>) {
    return this.#memory.consolidateMemory(...args);
  }

  rebuildMemoryCorpusStats(...args: Parameters<MemoryStore['rebuildMemoryCorpusStats']>) {
    return this.#memory.rebuildMemoryCorpusStats(...args);
  }

  forgetMemoryItem(...args: Parameters<MemoryStore['forgetMemoryItem']>) {
    return this.#memory.forgetMemoryItem(...args);
  }

  listWorkspaceSkills(...args: Parameters<WorkspaceStore['listWorkspaceSkills']>) {
    return this.#workspaces.listWorkspaceSkills(...args);
  }

  upsertWorkspaceSkill(...args: Parameters<WorkspaceStore['upsertWorkspaceSkill']>) {
    return this.#workspaces.upsertWorkspaceSkill(...args);
  }

  markWorkspaceSkillUsed(...args: Parameters<WorkspaceStore['markWorkspaceSkillUsed']>) {
    return this.#workspaces.markWorkspaceSkillUsed(...args);
  }

  curateWorkspaceSkills(...args: Parameters<WorkspaceStore['curateWorkspaceSkills']>) {
    return this.#workspaces.curateWorkspaceSkills(...args);
  }

  setWorkspaceSkillState(...args: Parameters<WorkspaceStore['setWorkspaceSkillState']>) {
    return this.#workspaces.setWorkspaceSkillState(...args);
  }

  deleteWorkspaceSkill(...args: Parameters<WorkspaceStore['deleteWorkspaceSkill']>) {
    return this.#workspaces.deleteWorkspaceSkill(...args);
  }

  createTaskSchedule(...args: Parameters<ScheduleStore['createTaskSchedule']>) {
    return this.#schedules.createTaskSchedule(...args);
  }

  countTaskSchedules(...args: Parameters<ScheduleStore['countTaskSchedules']>) {
    return this.#schedules.countTaskSchedules(...args);
  }

  listTaskSchedules(...args: Parameters<ScheduleStore['listTaskSchedules']>) {
    return this.#schedules.listTaskSchedules(...args);
  }

  getTaskSchedule(...args: Parameters<ScheduleStore['getTaskSchedule']>) {
    return this.#schedules.getTaskSchedule(...args);
  }

  setTaskScheduleEnabled(...args: Parameters<ScheduleStore['setTaskScheduleEnabled']>) {
    return this.#schedules.setTaskScheduleEnabled(...args);
  }

  updateTaskSchedule(...args: Parameters<ScheduleStore['updateTaskSchedule']>) {
    return this.#schedules.updateTaskSchedule(...args);
  }

  deleteTaskSchedule(...args: Parameters<ScheduleStore['deleteTaskSchedule']>) {
    return this.#schedules.deleteTaskSchedule(...args);
  }

  leaseDueTaskSchedule(...args: Parameters<ScheduleStore['leaseDueTaskSchedule']>) {
    return this.#schedules.leaseDueTaskSchedule(...args);
  }

  deferTaskSchedule(...args: Parameters<ScheduleStore['deferTaskSchedule']>) {
    return this.#schedules.deferTaskSchedule(...args);
  }

  materializeTaskSchedule(...args: Parameters<ScheduleStore['materializeTaskSchedule']>) {
    return this.#schedules.materializeTaskSchedule(...args);
  }

  failMaterializedTaskSchedule(...args: Parameters<ScheduleStore['failMaterializedTaskSchedule']>) {
    return this.#schedules.failMaterializedTaskSchedule(...args);
  }

  listLegacyTaskTitles(...args: Parameters<MaintenanceStore['listLegacyTaskTitles']>) {
    return this.#maintenance.listLegacyTaskTitles(...args);
  }

  setTaskTitleCiphertext(...args: Parameters<MaintenanceStore['setTaskTitleCiphertext']>) {
    return this.#maintenance.setTaskTitleCiphertext(...args);
  }

  listTasksMissingNameIndex(...args: Parameters<MaintenanceStore['listTasksMissingNameIndex']>) {
    return this.#maintenance.listTasksMissingNameIndex(...args);
  }

  setTaskNameIndex(...args: Parameters<MaintenanceStore['setTaskNameIndex']>) {
    return this.#maintenance.setTaskNameIndex(...args);
  }

  searchTaskNames(...args: Parameters<TaskStore['searchTaskNames']>) {
    return this.#tasks.searchTaskNames(...args);
  }

  scrubLegacyContentSummaries(
    ...args: Parameters<MaintenanceStore['scrubLegacyContentSummaries']>
  ) {
    return this.#maintenance.scrubLegacyContentSummaries(...args);
  }

  setTaskStatusForUser(...args: Parameters<TaskStore['setTaskStatusForUser']>) {
    return this.#tasks.setTaskStatusForUser(...args);
  }

  cancelTaskAndReleaseReservations(
    ...args: Parameters<TaskStore['cancelTaskAndReleaseReservations']>
  ) {
    return this.#tasks.cancelTaskAndReleaseReservations(...args);
  }

  updateTaskSecurityMode(...args: Parameters<TaskStore['updateTaskSecurityMode']>) {
    return this.#tasks.updateTaskSecurityMode(...args);
  }

  updateWorkspaceSecurityMode(...args: Parameters<WorkspaceStore['updateWorkspaceSecurityMode']>) {
    return this.#workspaces.updateWorkspaceSecurityMode(...args);
  }

  leaseNextTask(...args: Parameters<TaskStore['leaseNextTask']>) {
    return this.#tasks.leaseNextTask(...args);
  }

  failTasksAtAttemptLimit(...args: Parameters<TaskStore['failTasksAtAttemptLimit']>) {
    return this.#tasks.failTasksAtAttemptLimit(...args);
  }

  taskClaim(...args: Parameters<TaskStore['taskClaim']>) {
    return this.#tasks.taskClaim(...args);
  }

  renewTaskLease(...args: Parameters<TaskStore['renewTaskLease']>) {
    return this.#tasks.renewTaskLease(...args);
  }

  updateTask(...args: Parameters<TaskStore['updateTask']>) {
    return this.#tasks.updateTask(...args);
  }

  appendTaskEvent(...args: Parameters<TaskStore['appendTaskEvent']>) {
    return this.#tasks.appendTaskEvent(...args);
  }

  listTaskEvents(...args: Parameters<TaskStore['listTaskEvents']>) {
    return this.#tasks.listTaskEvents(...args);
  }

  listTaskEventPage(...args: Parameters<TaskStore['listTaskEventPage']>) {
    return this.#tasks.listTaskEventPage(...args);
  }

  listRecentTaskEvents(...args: Parameters<TaskStore['listRecentTaskEvents']>) {
    return this.#tasks.listRecentTaskEvents(...args);
  }

  createArtifact(...args: Parameters<WorkspaceStore['createArtifact']>) {
    return this.#workspaces.createArtifact(...args);
  }

  listArtifacts(...args: Parameters<WorkspaceStore['listArtifacts']>) {
    return this.#workspaces.listArtifacts(...args);
  }

  getArtifact(...args: Parameters<WorkspaceStore['getArtifact']>) {
    return this.#workspaces.getArtifact(...args);
  }

  deleteArtifact(...args: Parameters<WorkspaceStore['deleteArtifact']>) {
    return this.#workspaces.deleteArtifact(...args);
  }

  exportAccount(...args: Parameters<MaintenanceStore['exportAccount']>) {
    return this.#maintenance.exportAccount(...args);
  }

  /** Forwarded to `store/billing.ts`; see the note above the identity block. */

  upsertModels(...args: Parameters<BillingStore['upsertModels']>) {
    return this.#billing.upsertModels(...args);
  }

  replaceModelCatalog(...args: Parameters<BillingStore['replaceModelCatalog']>) {
    return this.#billing.replaceModelCatalog(...args);
  }

  listModels(...args: Parameters<BillingStore['listModels']>) {
    return this.#billing.listModels(...args);
  }

  recordUsage(...args: Parameters<BillingStore['recordUsage']>) {
    return this.#billing.recordUsage(...args);
  }

  transitionUsage(...args: Parameters<BillingStore['transitionUsage']>) {
    return this.#billing.transitionUsage(...args);
  }

  mediaSpendForTask(...args: Parameters<BillingStore['mediaSpendForTask']>) {
    return this.#billing.mediaSpendForTask(...args);
  }

  mergeUserPreferences(...args: Parameters<BillingStore['mergeUserPreferences']>) {
    return this.#billing.mergeUserPreferences(...args);
  }

  saveMessageDraft(...args: Parameters<BillingStore['saveMessageDraft']>) {
    return this.#billing.saveMessageDraft(...args);
  }

  listMessageDrafts(...args: Parameters<BillingStore['listMessageDrafts']>) {
    return this.#billing.listMessageDrafts(...args);
  }

  usageTotals(...args: Parameters<BillingStore['usageTotals']>) {
    return this.#billing.usageTotals(...args);
  }

  usageHistory(...args: Parameters<BillingStore['usageHistory']>) {
    return this.#billing.usageHistory(...args);
  }

  getSpendLimits(...args: Parameters<BillingStore['getSpendLimits']>) {
    return this.#billing.getSpendLimits(...args);
  }

  setSpendLimits(...args: Parameters<BillingStore['setSpendLimits']>) {
    return this.#billing.setSpendLimits(...args);
  }

  spendTotal(...args: Parameters<BillingStore['spendTotal']>) {
    return this.#billing.spendTotal(...args);
  }

  taskSpend(...args: Parameters<BillingStore['taskSpend']>) {
    return this.#billing.taskSpend(...args);
  }

  spendGuard(...args: Parameters<BillingStore['spendGuard']>) {
    return this.#billing.spendGuard(...args);
  }

  claimSpendAlert(...args: Parameters<BillingStore['claimSpendAlert']>) {
    return this.#billing.claimSpendAlert(...args);
  }

  spendByModel(...args: Parameters<BillingStore['spendByModel']>) {
    return this.#billing.spendByModel(...args);
  }

  effectiveSpendLimits(...args: Parameters<BillingStore['effectiveSpendLimits']>) {
    return this.#billing.effectiveSpendLimits(...args);
  }

  spendSummary(...args: Parameters<BillingStore['spendSummary']>) {
    return this.#billing.spendSummary(...args);
  }

  /** Forwarded to `store/connectors.ts`; see the note above the identity block. */

  createApproval(...args: Parameters<ConnectorStore['createApproval']>) {
    return this.#connectors.createApproval(...args);
  }

  listApprovals(...args: Parameters<ConnectorStore['listApprovals']>) {
    return this.#connectors.listApprovals(...args);
  }

  resolveApproval(...args: Parameters<ConnectorStore['resolveApproval']>) {
    return this.#connectors.resolveApproval(...args);
  }

  getApproval(...args: Parameters<ConnectorStore['getApproval']>) {
    return this.#connectors.getApproval(...args);
  }

  getManagedProviderCredential(
    ...args: Parameters<ConnectorStore['getManagedProviderCredential']>
  ) {
    return this.#connectors.getManagedProviderCredential(...args);
  }

  upsertManagedProviderCredential(
    ...args: Parameters<ConnectorStore['upsertManagedProviderCredential']>
  ) {
    return this.#connectors.upsertManagedProviderCredential(...args);
  }

  deleteManagedProviderCredential(
    ...args: Parameters<ConnectorStore['deleteManagedProviderCredential']>
  ) {
    return this.#connectors.deleteManagedProviderCredential(...args);
  }

  createConnector(...args: Parameters<ConnectorStore['createConnector']>) {
    return this.#connectors.createConnector(...args);
  }

  listConnectors(...args: Parameters<ConnectorStore['listConnectors']>) {
    return this.#connectors.listConnectors(...args);
  }

  getConnector(...args: Parameters<ConnectorStore['getConnector']>) {
    return this.#connectors.getConnector(...args);
  }

  revokeConnector(...args: Parameters<ConnectorStore['revokeConnector']>) {
    return this.#connectors.revokeConnector(...args);
  }

  updateConnectorSecret(...args: Parameters<ConnectorStore['updateConnectorSecret']>) {
    return this.#connectors.updateConnectorSecret(...args);
  }

  createConnectorOAuthAttempt(...args: Parameters<ConnectorStore['createConnectorOAuthAttempt']>) {
    return this.#connectors.createConnectorOAuthAttempt(...args);
  }

  consumeConnectorOAuthAttempt(
    ...args: Parameters<ConnectorStore['consumeConnectorOAuthAttempt']>
  ) {
    return this.#connectors.consumeConnectorOAuthAttempt(...args);
  }

  recordConnectorAudit(...args: Parameters<ConnectorStore['recordConnectorAudit']>) {
    return this.#connectors.recordConnectorAudit(...args);
  }

  listConnectorAudit(...args: Parameters<ConnectorStore['listConnectorAudit']>) {
    return this.#connectors.listConnectorAudit(...args);
  }

  createWorkspacePreview(...args: Parameters<WorkspaceStore['createWorkspacePreview']>) {
    return this.#workspaces.createWorkspacePreview(...args);
  }

  listWorkspacePreviews(...args: Parameters<WorkspaceStore['listWorkspacePreviews']>) {
    return this.#workspaces.listWorkspacePreviews(...args);
  }

  getWorkspacePreview(...args: Parameters<WorkspaceStore['getWorkspacePreview']>) {
    return this.#workspaces.getWorkspacePreview(...args);
  }

  getWorkspacePreviewBySlug(...args: Parameters<WorkspaceStore['getWorkspacePreviewBySlug']>) {
    return this.#workspaces.getWorkspacePreviewBySlug(...args);
  }

  rotateWorkspacePreviewAccess(
    ...args: Parameters<WorkspaceStore['rotateWorkspacePreviewAccess']>
  ) {
    return this.#workspaces.rotateWorkspacePreviewAccess(...args);
  }

  publishWorkspacePreview(...args: Parameters<WorkspaceStore['publishWorkspacePreview']>) {
    return this.#workspaces.publishWorkspacePreview(...args);
  }

  revokeWorkspacePreview(...args: Parameters<WorkspaceStore['revokeWorkspacePreview']>) {
    return this.#workspaces.revokeWorkspacePreview(...args);
  }

  touchWorkspacePreview(...args: Parameters<WorkspaceStore['touchWorkspacePreview']>) {
    return this.#workspaces.touchWorkspacePreview(...args);
  }

  /** Forwarded to `store/notifications.ts`; see the note above the identity block. */

  upsertPushSubscription(...args: Parameters<NotificationStore['upsertPushSubscription']>) {
    return this.#notifications.upsertPushSubscription(...args);
  }

  deletePushSubscription(...args: Parameters<NotificationStore['deletePushSubscription']>) {
    return this.#notifications.deletePushSubscription(...args);
  }

  deletePushSubscriptionById(...args: Parameters<NotificationStore['deletePushSubscriptionById']>) {
    return this.#notifications.deletePushSubscriptionById(...args);
  }

  createAgentNotification(...args: Parameters<NotificationStore['createAgentNotification']>) {
    return this.#notifications.createAgentNotification(...args);
  }

  listAgentNotifications(...args: Parameters<NotificationStore['listAgentNotifications']>) {
    return this.#notifications.listAgentNotifications(...args);
  }

  listPendingNotifications(...args: Parameters<NotificationStore['listPendingNotifications']>) {
    return this.#notifications.listPendingNotifications(...args);
  }

  notificationSettings(...args: Parameters<NotificationStore['notificationSettings']>) {
    return this.#notifications.notificationSettings(...args);
  }

  setNotificationSettings(...args: Parameters<NotificationStore['setNotificationSettings']>) {
    return this.#notifications.setNotificationSettings(...args);
  }

  recordNotificationDelivery(...args: Parameters<NotificationStore['recordNotificationDelivery']>) {
    return this.#notifications.recordNotificationDelivery(...args);
  }

  cleanupExpired(...args: Parameters<MaintenanceStore['cleanupExpired']>) {
    return this.#maintenance.cleanupExpired(...args);
  }
}
