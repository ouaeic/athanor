import { projectWorkSurface } from './work-surface-projection.js';
import { deliveryFilePath } from '@athanor/contracts';
export { deliveryFilePath } from '@athanor/contracts';
import type {
  Artifact,
  TaskEvent,
  TaskMilestone,
  TaskPlan,
  TaskPresentation,
  TaskResult,
  TaskOutputIntent,
  WorkspacePreview
} from '@athanor/contracts';

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const compact = (value: unknown, max = 160): string =>
  text(value)
    // eslint-disable-next-line no-control-regex -- Replace ASCII controls before showing evidence titles.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);

/** Only typed publication receipts establish that a preview belongs to this task. */
export const taskPreviewIds = (events: readonly TaskEvent[]): Map<string, string[]> => {
  const ids = new Map<string, string[]>();
  for (const event of events) {
    if (event.kind !== 'preview') continue;
    const id = text(record(event.payload).previewId);
    if (id) ids.set(id, [...(ids.get(id) ?? []), event.id]);
  }
  return ids;
};

export const taskDeliveryFiles = (events: readonly TaskEvent[]): Map<string, string[]> => {
  const paths = new Map<string, string[]>();
  const writes = new Map<string, string[]>();
  const calls = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    const payload = record(event.payload);
    if (event.kind === 'tool_started' && ['file_write', 'file_patch'].includes(text(payload.tool)))
      calls.set(text(payload.toolCallId), record(payload.arguments));
    else if (event.kind === 'tool_result') {
      const call = calls.get(text(payload.toolCallId));
      const result = record(payload.result);
      if (call && successful(result)) {
        const path = deliveryFilePath(result.path || call.path);
        if (path) writes.set(path, [event.id]);
      }
    } else if (event.kind === 'completed') {
      const values = payload.deliverables;
      if (Array.isArray(values) && values.length) {
        for (const value of values) {
          const path = deliveryFilePath(value);
          if (path) paths.set(path, [...(paths.get(path) ?? []), event.id]);
        }
      } else for (const [path, evidence] of writes) paths.set(path, evidence);
      writes.clear();
    }
  }
  return paths;
};

/** Source bundles also retain successful supporting file writes omitted from a short completion. */
export const taskSourceFiles = (events: readonly TaskEvent[]): Map<string, string[]> => {
  const paths = taskDeliveryFiles(events);
  const calls = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    const payload = record(event.payload);
    if (event.kind === 'tool_started' && ['file_write', 'file_patch'].includes(text(payload.tool)))
      calls.set(text(payload.toolCallId), record(payload.arguments));
    if (event.kind !== 'tool_result') continue;
    const call = calls.get(text(payload.toolCallId)),
      result = record(payload.result);
    if (!call || !successful(result)) continue;
    const path = deliveryFilePath(result.path || call.path);
    if (path) paths.set(path, [event.id]);
  }
  return paths;
};

export const plannedOutputPaths = (outputs: readonly TaskOutputIntent[] = []) => ({
  paths: [
    ...new Set(
      outputs
        .flatMap((output) => output.files ?? [])
        .map(deliveryFilePath)
        .filter((p): p is string => p !== null)
    )
  ],
  directories: [
    ...new Set(
      outputs
        .flatMap((output) => output.directories ?? [])
        .map(deliveryFilePath)
        .filter((p): p is string => p !== null)
    )
  ]
});

const actionLabel = (name: string, args: Record<string, unknown>): string => {
  const path = compact(args.path, 100);
  if (['file_write', 'file_patch'].includes(name))
    return path ? `Working on ${path}` : 'Editing files';
  if (['web_search', 'parallel_web_read'].includes(name)) return 'Reading sources';
  if (['document_read', 'document_search'].includes(name)) return 'Working with documents';
  if (name === 'generate_media')
    return args.kind === 'audio' ? 'Creating audio' : 'Creating an image';
  if (name === 'publish_preview') return 'Preparing the app to open';
  if (name === 'publish_artifact') return 'Preparing a download';
  if (name === 'shell') return args.background ? 'Starting background work' : 'Running a command';
  if (name === 'process') return 'Checking running work';
  if (name.startsWith('browser_')) return 'Working in the browser';
  if (name.startsWith('desktop_')) return 'Working on the computer';
  if (name === 'delegate') return 'Investigating in parallel';
  return name.replaceAll('_', ' ');
};

const successful = (result: Record<string, unknown>): boolean =>
  !result.error && !result.skipped && result.ok !== false && result.success !== false;

export interface PresentationInput {
  taskId: string;
  workspaceId: string;
  sourceWorkspaceId?: string;
  taskStatus: string;
  events: readonly TaskEvent[];
  plan: TaskPlan | null;
  artifacts: readonly Artifact[];
  previews: readonly WorkspacePreview[];
  previewAvailability: ReadonlyMap<string, 'ready' | 'unavailable' | 'unknown'>;
  files: ReadonlyMap<string, { status: 'ready' | 'unavailable' | 'unknown'; sizeBytes?: number }>;
}

export const buildTaskPresentation = (input: PresentationInput): TaskPresentation => {
  const events = [
    ...new Map(input.events.filter((e) => e.taskId === input.taskId).map((e) => [e.id, e])).values()
  ].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  const previews = taskPreviewIds(events);
  const results: TaskResult[] = [];
  for (const preview of input.previews) {
    const evidence = previews.get(preview.id);
    if (
      !evidence ||
      (preview.workspaceId !== input.workspaceId && preview.workspaceId !== input.sourceWorkspaceId)
    )
      continue;
    const expired = preview.expiresAt !== null && Date.parse(preview.expiresAt) <= Date.now();
    const status =
      preview.status === 'active' && !expired
        ? (input.previewAvailability.get(preview.id) ?? 'unknown')
        : 'unavailable';
    results.push({
      id: `preview:${preview.id}`,
      kind: 'preview',
      title: preview.label,
      status,
      url: status === 'ready' ? preview.url : null,
      downloadUrl: null,
      accessPath:
        status === 'ready' && preview.visibility === 'private'
          ? `/v1/previews/${encodeURIComponent(preview.id)}/access`
          : null,
      previewId: preview.id,
      evidenceEventIds: evidence,
      ...(status !== 'ready'
        ? {
            detail: expired
              ? 'This preview has expired.'
              : preview.status === 'active'
                ? status === 'unknown'
                  ? 'Availability could not be checked.'
                  : 'The app is not listening on its published port.'
                : `This preview is ${preview.status}.`
          }
        : {})
    });
  }
  for (const artifact of input.artifacts) {
    if (
      artifact.taskId !== input.taskId ||
      (artifact.workspaceId !== input.workspaceId &&
        artifact.workspaceId !== input.sourceWorkspaceId)
    )
      continue;
    const url = `/v1/artifacts/${encodeURIComponent(artifact.id)}/content`;
    results.push({
      id: `artifact:${artifact.id}`,
      kind: 'artifact',
      title: artifact.name,
      status: 'ready',
      url,
      downloadUrl: url,
      accessPath: null,
      artifactId: artifact.id,
      workspaceId: artifact.workspaceId,
      sha256: artifact.sha256,
      createdAt: artifact.createdAt,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
      version: artifact.version,
      evidenceEventIds: events
        .filter((e) => e.kind === 'artifact' && text(record(e.payload).artifactId) === artifact.id)
        .map((e) => e.id)
    });
  }
  const deliveryFiles = taskDeliveryFiles(events);
  const outputs = input.plan?.taskId === input.taskId ? input.plan.outputs : undefined;
  for (const path of plannedOutputPaths(outputs).paths)
    if (!deliveryFiles.has(path)) deliveryFiles.set(path, []);
  for (const [path, evidence] of deliveryFiles) {
    const observed = input.files.get(path) ?? { status: 'unknown' as const };
    const url = `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/download?path=${encodeURIComponent(path)}`;
    results.push({
      id: `file:${path}`,
      kind: 'file',
      title: path.split('/').at(-1) ?? path,
      status: observed.status,
      url: null,
      downloadUrl: observed.status === 'unavailable' ? null : url,
      accessPath: null,
      path,
      evidenceEventIds: evidence,
      ...(observed.sizeBytes === undefined ? {} : { sizeBytes: observed.sizeBytes }),
      ...(observed.status !== 'ready'
        ? {
            detail:
              observed.status === 'unknown'
                ? 'Availability has not been checked. Download opens the recorded file directly.'
                : 'This file is no longer available.'
          }
        : {})
    });
  }
  const started = new Map<
    string,
    { event: TaskEvent; tool: string; args: Record<string, unknown> }
  >();
  const pending = new Map<string, { title: string; eventId: string; startedAt: string }>();
  const paths = new Set<string>();
  const sources = new Set<string>();
  const milestones: TaskMilestone[] = [];
  let commands = 0,
    checksPassed = 0,
    checksFailed = 0,
    images = 0;
  const add = (
    event: TaskEvent,
    kind: TaskMilestone['kind'],
    title: string,
    status: TaskMilestone['status'] = 'observed',
    detail?: string
  ) => {
    milestones.push({
      id: event.id,
      sequence: event.sequence,
      kind,
      title: compact(title),
      status,
      createdAt: event.createdAt,
      ...(detail ? { detail: compact(detail, 240) } : {})
    });
  };
  for (const event of events) {
    const payload = record(event.payload);
    const id = text(payload.toolCallId);
    if (event.kind === 'tool_started') {
      const tool = text(payload.tool),
        args = record(payload.arguments);
      started.set(id, { event, tool, args });
      pending.set(id, {
        title: actionLabel(tool, args),
        eventId: event.id,
        startedAt: event.createdAt
      });
    } else if (event.kind === 'error') {
      pending.delete(id);
      if (started.has(id)) add(event, 'check', event.summary, 'failed');
    } else if (event.kind === 'tool_result') {
      pending.delete(id);
      const call = started.get(id);
      if (!call) continue;
      const result = record(payload.result);
      if (!successful(result)) continue;
      if (['file_write', 'file_patch'].includes(call.tool)) {
        const path = compact(result.path || call.args.path, 1_024);
        if (path) {
          paths.add(path);
          add(event, 'change', path);
        }
      } else if (call.tool === 'shell') {
        commands++;
        if (result.sessionId)
          add(event, 'process', 'Background work started', 'observed', compact(result.command));
        else if (typeof result.exitCode === 'number')
          add(
            event,
            'check',
            `Command ${result.exitCode === 0 ? 'finished' : 'failed'}`,
            result.exitCode === 0 ? 'passed' : 'failed',
            [
              text(call.args.executable),
              ...(Array.isArray(call.args.args)
                ? call.args.args.filter((a) => typeof a === 'string')
                : [])
            ].join(' ')
          );
      } else if (call.tool === 'generate_media') {
        images++;
        add(event, 'result', 'Media created');
      } else if (['web_search', 'parallel_web_read'].includes(call.tool)) {
        // Source counts come from returned addresses, never from how many a plan promised to read.
        const candidates = [result.sources, result.results, result.pages, result.items].find(
          Array.isArray
        );
        if (Array.isArray(candidates))
          for (const item of candidates) {
            const url = text(record(item).url);
            try {
              const parsed = new URL(url);
              if (['http:', 'https:'].includes(parsed.protocol)) sources.add(parsed.href);
            } catch {
              /* No address was observed. */
            }
          }
        add(event, 'source', call.tool === 'web_search' ? 'Sources found' : 'Sources read');
      }
    } else if (event.kind === 'preview' || event.kind === 'artifact')
      add(event, 'result', event.summary);
    else if (event.kind === 'approval_requested')
      add(event, 'approval', 'Decision needed', 'waiting');
    else if (event.kind === 'approval_resolved') add(event, 'approval', event.summary);
    else if (event.kind === 'status' && Array.isArray(payload.acceptance)) {
      for (const value of payload.acceptance) {
        const check = record(value);
        if (check.passed === true) checksPassed++;
        else if (check.passed === false) checksFailed++;
      }
      add(
        event,
        'check',
        event.summary,
        payload.acceptance.some((v) => record(v).passed === false) ? 'failed' : 'passed'
      );
    }
  }
  const surface = projectWorkSurface(events, input.plan, results);
  const phases =
    input.plan?.taskId === input.taskId &&
    (!surface.direction ||
      (input.plan.directionEventId
        ? input.plan.directionEventId === surface.direction.eventId
        : Date.parse(input.plan.createdAt) >=
          Date.parse(
            events.find((event) => event.id === surface.direction?.eventId)?.createdAt ?? ''
          )))
      ? input.plan.steps.map(({ id, title, status }) => ({ id, title, status }))
      : [];
  const intentKind = outputs?.[0]?.kind;
  const kind = intentKind
    ? (
        {
          app: 'build',
          document: 'research',
          dataset: 'analysis',
          media: 'design',
          answer: 'general'
        } as const
      )[intentKind]
    : results.some((r) => r.kind === 'preview')
      ? 'build'
      : images
        ? 'design'
        : sources.size
          ? 'research'
          : commands && paths.size
            ? 'analysis'
            : paths.size
              ? 'build'
              : 'general';
  const active = ['queued', 'planning', 'running'].includes(input.taskStatus);
  return {
    version: 1,
    taskId: input.taskId,
    eventCursor: events.at(-1)?.sequence ?? 0,
    results,
    surface,
    ...(outputs === undefined ? {} : { outputs }),
    progress: {
      kind,
      phases,
      current:
        active && !surface.direction?.queued
          ? ([...pending.values()]
              .filter(
                (item) =>
                  (events.find((event) => event.id === item.eventId)?.sequence ?? -1) >=
                  (surface.direction?.sequence ?? 0)
              )
              .at(-1) ?? null)
          : null,
      metrics: [
        { key: 'files', label: 'Files changed', value: paths.size },
        { key: 'sources', label: 'Sources found', value: sources.size },
        { key: 'commands', label: 'Commands run', value: commands },
        { key: 'checksPassed', label: 'Checks passed', value: checksPassed },
        { key: 'checksFailed', label: 'Checks failed', value: checksFailed },
        {
          key: 'results',
          label: 'Results ready',
          value: results.filter((r) => r.status === 'ready').length
        }
      ].filter((m) => m.value > 0),
      milestones: milestones
        .filter((milestone) => milestone.sequence >= (surface.direction?.sequence ?? 0))
        .slice(-24),
      updatedAt: events.at(-1)?.createdAt ?? null
    }
  };
};
