#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Local fixtures exercise browser interactions; API and runner suites own authorization and delivery.
const requireRunner = createRequire(
  new URL('../services/workspace-runner/package.json', import.meta.url)
);
const { chromium } = requireRunner('playwright-core');
const root = fileURLToPath(new URL('..', import.meta.url));
const dist = resolve(root, 'apps/web/dist');
await readFile(resolve(dist, 'index.html'));
const ownedReport = !process.env.GARDEN_UI_REPORT;
const report = process.env.GARDEN_UI_REPORT || (await mkdtemp(resolve(tmpdir(), 'garden-ui-')));
await mkdir(report, { recursive: true });
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json'
};
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname.endsWith('/download')) {
      response.setHeader('content-type', 'text/html');
      response.setHeader('content-disposition', 'attachment; filename="index.html"');
      response.end(previewHtml);
      return;
    }
    const path = resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname));
    assert(path.startsWith(dist + sep));
    response.setHeader('content-type', mime[extname(path)] || 'application/octet-stream');
    response.end(await readFile(path));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const previewServer = createServer((request, response) => {
  if (request.url.endsWith('/echo')) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ready: true }));
  } else {
    response.setHeader('content-type', 'text/html');
    response.end(
      previewHtml +
        `<script>
      try { localStorage.setItem('garden-app-check', 'stored'); document.body.dataset.storage = localStorage.getItem('garden-app-check'); }
      catch { document.body.dataset.storage = 'blocked'; }
      fetch('./echo').then(r => r.json()).then(r => document.body.dataset.request = String(r.ready)).catch(() => document.body.dataset.request = 'blocked');
    </script>`
    );
  }
});
await new Promise((done) => previewServer.listen(0, '127.0.0.1', done));
const isolatedPreviewOrigin = `http://127.0.0.1:${previewServer.address().port}`;
const browser = await chromium.launch({ headless: true });
const time = '2026-09-06T00:00:00Z';
const workspace = {
  id: '10000000-0000-4000-8000-000000000001',
  name: 'My computer',
  status: 'ready',
  region: 'local',
  storageBytes: 0,
  storageLimitBytes: 10000000000,
  createdAt: time,
  updatedAt: time
};
const task = {
  id: '20000000-0000-4000-8000-000000000002',
  workspaceId: workspace.id,
  title:
    'Build an interactive maze with keyboard controls, a playable preview, and portable source files',
  status: 'completed',
  modelId: 'fixture/model',
  privacyRoute: 'provider_zdr',
  securityMode: 'balanced',
  reasoningEffort: 'auto',
  spentUsd: 0.01,
  maxSpendUsd: null,
  queuedMessageCount: 0,
  archived: false,
  pinned: false,
  createdAt: time,
  updatedAt: time
};
const event = {
  id: '30000000-0000-4000-8000-000000000003',
  taskId: task.id,
  kind: 'completed',
  sequence: 3,
  summary: 'The maze is ready to open.',
  payload: {
    summary: 'The maze is ready to open. Use the arrow keys to play.',
    verification: { status: 'verified' }
  },
  createdAt: time
};
const milestones = [
  {
    id: 'change',
    sequence: 1,
    kind: 'change',
    title: 'Created maze/index.html',
    status: 'observed',
    createdAt: time
  },
  {
    id: 'check',
    sequence: 2,
    kind: 'check',
    title: 'Verified keyboard controls',
    status: 'passed',
    createdAt: time
  }
];
const presentation = {
  version: 1,
  taskId: task.id,
  eventCursor: 3,
  results: [
    {
      id: 'preview',
      kind: 'preview',
      title: 'Playable maze',
      status: 'ready',
      accessPath: '/v1/previews/fixture/access',
      url: origin + '/__athanor/preview/fixture/',
      downloadUrl: null,
      evidenceEventIds: [event.id]
    },
    {
      id: 'source',
      kind: 'file',
      title: 'index.html',
      path: 'workspace/maze/index.html',
      status: 'ready',
      url: null,
      accessPath: null,
      downloadUrl: `/v1/workspaces/${workspace.id}/download?path=workspace%2Fmaze%2Findex.html`,
      evidenceEventIds: [event.id]
    }
  ],
  progress: {
    kind: 'build',
    phases: [
      { id: 'build', title: 'Build the maze and keyboard controls', status: 'completed' },
      {
        id: 'verify',
        title: 'Verify the playable result and deliver its source',
        status: 'completed'
      }
    ],
    current: null,
    metrics: [{ key: 'checks', label: 'Checks passed', value: 1 }],
    milestones,
    updatedAt: time
  }
};
const bootstrap = {
  user: { id: '40000000-0000-4000-8000-000000000004', username: 'owner' },
  workspaces: [workspace],
  tasks: [task],
  tasksCursor: null,
  scheduleRunCounts: {},
  schedules: [],
  drafts: [],
  models: [
    {
      id: task.modelId,
      providerModelId: 'model',
      displayName: 'Fixture reasoning model',
      provider: 'fixture',
      availability: 'available',
      privacyRoute: 'provider_zdr',
      reasoning: { supportedEfforts: ['low', 'medium', 'high', 'max'], mandatory: true }
    }
  ],
  instance: {
    mode: 'native',
    providerConfigured: true,
    enforceZeroDataRetention: true,
    webSearch: {}
  },
  usage: {
    providerSpend: null,
    consumedCredits: 0,
    reservedCredits: 0,
    storageBytes: 0,
    storageLimitBytes: workspace.storageLimitBytes
  }
};
const previewHtml =
  '<!doctype html><title>Playable fixture</title><button onclick="this.textContent=Number(this.textContent)+1">0</button>';
const errors = [];
let draft;
let missions = [];
let mediaJobs = [];
let mediaAssets = [];
let reviewedSubmission;
let recoveredVideo;
let recordedReceipt;
let childQuestion = null,
  childAnswer = null;
const childWorkspace = {
  ...workspace,
  id: '10000000-0000-4000-8000-000000000009',
  name: 'Isolated controls workspace'
};
const childTask = {
  ...task,
  id: '20000000-0000-4000-8000-000000000009',
  title: 'Implement keyboard controls',
  workspaceId: childWorkspace.id,
  parentTaskId: task.id,
  parentMissionId: '50000000-0000-4000-8000-000000000005'
};
const mission = {
  id: childTask.parentMissionId,
  parentTaskId: task.id,
  taskId: childTask.id,
  workspaceId: childWorkspace.id,
  name: 'Keyboard controls',
  state: 'ready',
  sourceRoot: 'workspace/maze',
  outputPaths: ['workspace/controls.ts'],
  allocatedCredits: 1,
  usedCredits: 0.01,
  reservedCredits: 0,
  pendingApprovals: 0,
  changedFiles: 1,
  conflicts: 0,
  generation: 3,
  createdAt: time,
  updatedAt: time,
  detail: null
};
const missionReview = {
  mission,
  digest: 'fixture-reviewed-content',
  canIntegrate: true,
  detail: 'One file is ready to apply.',
  changes: [
    {
      path: 'workspace/controls.ts',
      kind: 'modified',
      bytes: 20,
      baseHash: 'before',
      resultHash: 'after',
      conflict: false,
      permitted: true,
      binary: false,
      diffOmitted: false,
      diff: '@@ -1 +1 @@\n-oldControl()\n+newControl()'
    }
  ]
};
const computation = {
  sessionId: 'kernel-60000000-0000-4000-8000-000000000006',
  taskId: task.id,
  workspaceId: workspace.id,
  name: 'Sequence analysis',
  language: 'python',
  cwd: 'workspace',
  state: 'busy',
  createdAt: time,
  deadlineAt: '2026-09-07T00:00:00Z',
  stateRetained: true,
  variables: [{ name: 'samples', type: 'DataFrame', preview: '20 rows, 4 columns' }]
};
const debugSession = {
  sessionId: 'debug-80000000-0000-4000-8000-000000000008',
  taskId: task.id,
  workspaceId: workspace.id,
  language: 'python',
  program: 'workspace/main.py',
  cwd: 'workspace',
  state: 'stopped',
  createdAt: time,
  updatedAt: time,
  deadlineAt: '2026-09-07T00:00:00Z',
  stopEpoch: 3,
  reason: 'breakpoint',
  frames: [
    { id: 1, name: 'main', path: 'workspace/main.py', line: 2, column: 1, sourceHash: 'hash' }
  ],
  variables: [{ name: 'answer', value: '40', type: 'int', variablesReference: 0 }],
  excludedFrames: 0,
  output: 'ready',
  note: null
};
const debugControls = [];
let computationControls = [];
let mediaBatches = [];
const nativeAuthorization = {
  id: '70000000-0000-4000-8000-000000000007',
  purpose: 'sign_in',
  status: 'pending',
  serverOrigin: origin,
  userCode: 'ABCD-2345',
  deviceLabel: 'garden app on Android',
  expiresAt: new Date(Date.now() + 600000).toISOString()
};
let nativeStepUp, nativeDecision;
let approvals = [];
const approvalRequests = [];
let approvalFailures = [];
let transcriptions = [];
const dictationOptions = {
  available: true,
  reason: null,
  routeId: 'dictation-route',
  routeProof: 'reviewed-route-proof',
  modelId: 'dictation-model',
  displayName: 'Reviewed transcriber',
  provider: 'Native provider',
  privacyRoutes: ['external'],
  defaultPrivacyRoute: 'external',
  requiresExternalConsent: true,
  requiresMaxCostUsd: true,
  pricing: [],
  usdPerMinute: null,
  reservationUsd: 0.03,
  maxDurationSeconds: 300,
  maxBytes: 14000000
};
const voiceSession = {
  id: '80000000-0000-4000-8000-000000000008',
  taskId: task.id,
  workspaceId: workspace.id,
  provider: 'openai',
  providerModelId: 'voice-fixture',
  privacyRoute: 'external',
  retention: 'Provider terms',
  voice: 'marin',
  reasoningEffort: 'low',
  status: 'usage_uncertain',
  createdAt: time,
  connectedAt: time,
  deadlineAt: time,
  endedAt: time,
  maxSpendUsd: 0.5,
  settledUsd: 0.01,
  pendingUsd: 0.03,
  inputSeconds: 2,
  outputSeconds: 3,
  currentResponseId: null,
  cleanupPending: false,
  errorCode: null,
  note: 'Final usage pending'
};
const voiceProposal = {
  id: '90000000-0000-4000-8000-000000000009',
  digest: 'exact-voice-proposal-digest',
  sessionId: voiceSession.id,
  taskId: task.id,
  prompt: 'Add a quiet mode to the maze.',
  modelId: task.modelId,
  privacyRoute: task.privacyRoute,
  maxSpendUsd: task.maxSpendUsd,
  status: 'pending',
  createdAt: time,
  expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  messageId: null
};
let voiceConfirm, voiceReceipt;
const autonomyChanges = [];
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce'
  });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === isolatedPreviewOrigin) return route.continue();
    if (url.origin !== origin) return route.abort();
    const path = url.pathname;
    const json = (body) => route.fulfill({ json: body });
    if (path === '/sw.js') return route.fulfill({ contentType: 'text/javascript', body: '' });
    if (path.startsWith('/__athanor/preview/'))
      return route.fulfill({ contentType: 'text/html', body: previewHtml });
    if (!path.startsWith('/v1/')) return route.continue();
    if (path === '/v1/bootstrap') return json(bootstrap);
    if (path === '/v1/audio/transcriptions/options') return json(dictationOptions);
    if (path === '/v1/voice/models')
      return json({
        options: [
          {
            id: 'native-voice-route',
            provider: 'openai',
            providerModelId: 'voice-fixture',
            displayName: 'Native live voice',
            available: true,
            reason: null,
            routeProof: 'voice-reviewed-route',
            privacyRoutes: ['external'],
            requiresExternalConsent: true,
            supportedEfforts: ['minimal', 'low', 'medium'],
            defaultEffort: 'low',
            voices: ['marin', 'cedar'],
            defaultVoice: 'marin',
            pricing: [{ billable: 'audio_input', unit: 'token', costUsd: 0.00001 }],
            priceUpdatedAt: time,
            minimumReservationUsd: 0.02,
            maxDurationSeconds: 1800,
            maxInputSegmentSeconds: 10
          }
        ],
        reason: null
      });
    if (path === `/v1/tasks/${task.id}/voice-sessions`) {
      assert.equal(
        route.request().method(),
        'GET',
        'Opening voice or reviewing a proposal must not start a paid session'
      );
      return json([voiceSession]);
    }
    if (path === '/v1/voice-sessions') return json([voiceSession]);
    if (path === '/v1/audio/transcriptions/receipts') return json([]);
    if (path === `/v1/voice-sessions/${voiceSession.id}/proposals`) return json([voiceProposal]);
    if (path === `/v1/voice-sessions/${voiceSession.id}/proposals/${voiceProposal.id}/confirm`) {
      voiceConfirm = route.request().postDataJSON();
      voiceProposal.status = 'confirmed';
      return json(voiceProposal);
    }
    if (path === `/v1/voice-sessions/${voiceSession.id}/receipts`)
      return json(
        voiceSession.pendingUsd
          ? [
              {
                id: 'voice-receipt',
                providerResponseId: 'provider-response',
                reservedUsd: 0.03,
                createdAt: time
              }
            ]
          : []
      );
    if (path === `/v1/voice-sessions/${voiceSession.id}/reconcile`) {
      voiceReceipt = route.request().postDataJSON();
      voiceSession.pendingUsd = 0;
      voiceSession.settledUsd = 0.025;
      voiceSession.status = 'ended';
      return json(voiceSession);
    }
    if (path === '/v1/audio/transcriptions') {
      transcriptions.push(route.request().postDataJSON());
      assert.match(route.request().headers()['idempotency-key'], /^[0-9a-f-]{36}$/i);
      return json({ text: 'Keep the controls easy to reach.' });
    }
    if (path.endsWith('/heartbeat')) return json({ ok: true });
    if (path === `/v1/tasks/${task.id}/security-mode`) {
      assert.equal(route.request().method(), 'PATCH');
      const { securityMode } = route.request().postDataJSON();
      autonomyChanges.push(securityMode);
      await new Promise((resolve) => setTimeout(resolve, 100));
      task.securityMode = securityMode;
      return json(task);
    }
    if (path === '/v1/approvals') return json(approvals);
    const approvalAction = path.match(/^\/v1\/approvals\/([^/]+)\/(approve|deny)$/);
    if (approvalAction) {
      const request = route.request();
      assert.equal(request.method(), 'POST');
      assert.match(request.headers()['idempotency-key'], /^[0-9a-f-]{36}$/i);
      approvalRequests.push({
        id: approvalAction[1],
        action: approvalAction[2],
        body: request.postDataJSON()
      });
      const failure = approvalFailures.shift();
      if (failure) return route.fulfill({ status: failure.status, json: { error: failure } });
      approvals = approvals.filter((approval) => approval.id !== approvalAction[1]);
      return json({ ok: true });
    }
    if (path.endsWith('/artifacts')) return json([]);
    if (path.endsWith('/media-jobs')) return json(path.includes(childTask.id) ? [] : mediaJobs);
    if (path.endsWith('/media-assets')) return json(path.includes(childTask.id) ? [] : mediaAssets);
    if (path.endsWith('/media-batches'))
      return json(path.includes(childTask.id) ? [] : mediaBatches);
    if (path === '/v1/media/batches/batch-fixture/cancel') {
      assert.deepEqual(route.request().postDataJSON(), {});
      mediaBatches[0].cancelRequested = true;
      mediaBatches[0].providerStatus = 'cancelling';
      return json(mediaBatches[0]);
    }
    if (path === `/v1/auth/native/${nativeAuthorization.id}`) return json(nativeAuthorization);
    if (path === '/v1/auth/step-up/options') {
      nativeStepUp = route.request().postDataJSON();
      return json({ verified: true });
    }
    if (path === `/v1/auth/native/${nativeAuthorization.id}/decision`) {
      nativeDecision = route.request().postDataJSON();
      nativeAuthorization.status = 'approved';
      return json(nativeAuthorization);
    }
    if (path.endsWith('/coding-missions'))
      return json({ missions: path.includes(childTask.id) ? [] : missions });
    if (path === `/v1/workspaces/${childWorkspace.id}`) return json(childWorkspace);
    if (path === `/v1/coding-missions/${mission.id}/review`) return json(missionReview);
    if (path === `/v1/coding-missions/${mission.id}/integrate`) {
      reviewedSubmission = route.request().postDataJSON();
      mission.state = 'integrated';
      return json(mission);
    }
    if (path === '/v1/media/jobs/video-fixture/reconcile') {
      recoveredVideo = route.request().postDataJSON();
      mediaJobs[0].status = 'in_progress';
      return json(mediaJobs[0]);
    }
    if (path === '/v1/media/assets/character-fixture/reconcile') {
      recordedReceipt = route.request().postDataJSON();
      mediaAssets[0].costUsd = recordedReceipt.costUsd;
      mediaAssets[0].status = 'completed';
      return json(mediaAssets[0]);
    }
    if (path.endsWith('/files')) return json({ entries: [] });
    if (path.endsWith('/processes')) return json({ processes: [] });
    if (path.endsWith('/computation')) return json({ sessions: [computation] });
    if (path.endsWith('/debugger'))
      return json({ sessions: [debugSession], available: { python: true, javascript: true } });
    if (path.endsWith(`/debugger/${debugSession.sessionId}/control`)) {
      const control = JSON.parse(route.request().postData() ?? '{}');
      debugControls.push(control);
      debugSession.state = 'terminated';
      return json(debugSession);
    }
    if (path.endsWith(`/computation/${computation.sessionId}/control`)) {
      const control = route.request().postDataJSON();
      computationControls.push(control);
      computation.state = control.action === 'interrupt' ? 'interrupted' : 'stopped';
      if (control.action === 'stop') computation.stateRetained = false;
      return json(computation);
    }
    if (path.endsWith('/download')) return route.continue();
    if (path === '/v1/previews/fixture/access') return json({ url: presentation.results[0].url });
    if (path === '/v1/drafts') {
      draft = route.request().postDataJSON();
      return json({ saved: true });
    }
    if (path.endsWith('/presentation'))
      return json(
        path.includes(childTask.id)
          ? { ...presentation, taskId: childTask.id, results: [] }
          : presentation
      );
    if (path.endsWith('/plan'))
      return json({ id: 'plan', taskId: task.id, version: 1, steps: presentation.progress.phases });
    if (path.endsWith('/events'))
      return json({
        events: path.includes(childTask.id) ? (childQuestion ? [childQuestion] : []) : [event],
        hasMore: false,
        oldestSequence: 3,
        nextCursor: 3
      });
    if (path === `/v1/tasks/${childTask.id}/messages`) {
      childAnswer = route.request().postDataJSON();
      assert.match(route.request().headers()['idempotency-key'], /^[0-9a-f-]{36}$/i);
      childTask.status = 'queued';
      return json(childTask);
    }
    if (path.endsWith('/events/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
    if (path === `/v1/tasks/${task.id}`) return json(task);
    if (path === `/v1/tasks/${childTask.id}`) return json(childTask);
    errors.push(`Unspecified UI fixture: ${route.request().method()} ${path}`);
    return route.fulfill({ status: 501, json: { error: { message: 'Unspecified UI fixture' } } });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/?task=${task.id}`);
  assert.equal(
    await page.locator('link[rel="manifest"]').count(),
    1,
    'Browser installation requires a linked web manifest'
  );
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
  assert(manifestHref, 'Browser installation requires a linked web manifest');
  const manifestResponse = await context.request.get(new URL(manifestHref, origin).href);
  assert(manifestResponse.ok(), 'The installation manifest must be served');
  const manifest = await manifestResponse.json();
  assert.equal(manifest.name, 'garden');
  assert(manifest.icons.length > 0, 'Installation icons must exist');
  for (const icon of manifest.icons) {
    const response = await context.request.get(new URL(icon.src, origin).href);
    assert(response.ok(), 'An installation icon must be served');
    assert.equal((await response.body()).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  }
  await page.getByRole('button', { name: 'Open app', exact: true }).waitFor();
  await page.locator('.garden-preview-frame').waitFor();
  assert.equal(await page.locator('.garden-result-map').count(), 0);
  assert(
    await page.evaluate(
      () =>
        document.querySelector('.garden-top-tools').getBoundingClientRect().top <
        document.querySelector('.run-summary').getBoundingClientRect().top
    ),
    'Project tools must precede the running work'
  );
  const autonomy = page.getByRole('combobox', { name: 'Approvals for this prompt', exact: true });
  await autonomy.selectOption('autonomous');
  assert.equal(autonomyChanges.length, 0, 'A completed task selection must not mutate the project');
  assert.equal(await page.locator('.garden-top-tools select').count(), 0);
  for (const [width, height] of [
    [1440, 1000],
    [1024, 900],
    [768, 900],
    [720, 500],
    [390, 844],
    [375, 812],
    [320, 600]
  ]) {
    await page.setViewportSize({ width, height });
    if (width <= 760)
      await page.waitForFunction(() =>
        document.querySelector('.garden-shell').classList.contains('sidebar-closed')
      );
    const layout = await page.evaluate(() => {
      const box = (selector) => {
        const b = document.querySelector(selector).getBoundingClientRect();
        return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, height: b.height };
      };
      return {
        viewport: innerWidth,
        document: document.documentElement.scrollWidth,
        main: box('.garden-main'),
        scroll: box('.garden-task-scroll'),
        composer: box('.garden-task-composer'),
        viewportHeight: innerHeight
      };
    });
    assert.equal(layout.document, width, 'The page must not scroll sideways');
    assert(
      layout.scroll.bottom <= layout.composer.top + 1,
      'The composer must not overlap the work'
    );
    assert(
      layout.composer.bottom <= layout.viewportHeight + 1,
      'The composer must stay inside the viewport'
    );
    assert(
      layout.scroll.height > 0 && layout.composer.height > 0,
      'The scroll areas must remain usable'
    );
    await page.screenshot({ path: resolve(report, `task-${width}.png`) });
  }
  await page.getByRole('button', { name: 'Show projects', exact: true }).click();
  const projectLink = page
    .getByRole('navigation', { name: 'Project work', exact: true })
    .getByRole('button')
    .filter({ hasText: task.title });
  assert.equal(await projectLink.count(), 1);
  const titleBox = projectLink.locator('.garden-project-title');
  assert(
    await titleBox.evaluate(
      (element) => element.clientHeight <= parseFloat(getComputedStyle(element).lineHeight) + 1
    ),
    'Project titles must occupy one line'
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await projectLink.hover();
  await page.waitForFunction(() => {
    const title = document.querySelector('.garden-project-title[data-overflow="true"] strong');
    return (
      title &&
      getComputedStyle(title).transform !== 'none' &&
      getComputedStyle(title).transform !== 'matrix(1, 0, 0, 1, 0, 0)'
    );
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(
    await titleBox.locator('strong').evaluate((element) => getComputedStyle(element).animationName),
    'none'
  );
  assert(
    (await projectLink.getAttribute('aria-label')).includes(task.title),
    'The full title must remain available without animation'
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page
    .getByRole('button', { name: 'Close projects', exact: true })
    .filter({ has: page.locator('svg') })
    .focus();
  await page.waitForFunction(() =>
    document.activeElement.classList.contains('garden-sidebar-close')
  );
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    assert(
      await page.evaluate(() => Boolean(document.activeElement.closest('#garden-sidebar'))),
      'Phone project navigation must contain keyboard focus'
    );
  }
  await page.keyboard.press('Escape');
  assert.equal(
    await page
      .getByRole('button', { name: 'Show projects', exact: true })
      .getAttribute('aria-expanded'),
    'false'
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(
    await page.locator('.garden-status-footer').count(),
    0,
    'Routine work must not reserve a footer for repeated slogans'
  );
  assert.equal(
    await page.getByRole('button', { name: /^Switch to .* theme$/, includeHidden: true }).count(),
    1,
    'Appearance has one control'
  );
  const alignment = await page.evaluate(() => {
    const header = document.querySelector('.garden-masthead').getBoundingClientRect();
    const brand = document.querySelector('.garden-masthead .brand').getBoundingClientRect();
    return Math.abs((header.top + header.bottom) / 2 - (brand.top + brand.bottom) / 2);
  });
  assert(alignment < 3, 'The wordmark must align vertically with its toolbar');
  const directionInput = page.getByRole('textbox', {
    name: 'Add direction to this work',
    exact: true
  });
  await directionInput.fill('');
  const initialHeight = await directionInput.evaluate((element) => element.clientHeight);
  await directionInput.fill(Array.from({ length: 7 }, (_, i) => `Direction line ${i}`).join('\n'));
  assert(
    (await directionInput.evaluate((element) => element.clientHeight)) > initialHeight,
    'The direction grows automatically with its text'
  );
  await directionInput.fill('A longer direction.\n'.repeat(80));
  assert(
    await directionInput.evaluate(
      (element) => element.clientHeight <= 180 && element.scrollHeight > element.clientHeight
    ),
    'Long directions stop growing and scroll inside their bound'
  );
  assert.equal(
    await directionInput.evaluate((element) => getComputedStyle(element).resize),
    'none'
  );
  await directionInput.fill('Keep this direction while adjusting options.');
  assert.equal(
    await directionInput.evaluate((element) => element.clientHeight),
    initialHeight,
    'Removing text shrinks the direction editor'
  );
  await page.setViewportSize({ width: 320, height: 600 });
  const limit = page.getByRole('spinbutton', {
    name: 'Additional spend limit in USD',
    exact: true
  });
  await limit.fill('0.2');
  await limit.press('Enter');
  assert.equal(
    await directionInput.inputValue(),
    'Keep this direction while adjusting options.',
    'Editing an option must not submit or clear the direction'
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  const effort = page.getByRole('slider', { name: 'Model reasoning effort' });
  await effort.focus();
  await page.keyboard.press('End');
  const savedChoice = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/v1/drafts' &&
      response.request().postDataJSON()?.body === 'Keep this draft and its effort choice.' &&
      response.request().postDataJSON()?.controls?.reasoningEffort === 'max'
  );
  await page.locator(`#intent-${task.id}`).fill('Keep this draft and its effort choice.');
  assert((await savedChoice).ok());
  assert.equal(
    draft.controls.reasoningEffort,
    'max',
    'The effort choice must travel with the saved draft'
  );
  assert.equal(draft.controls.securityMode, 'autonomous');
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value) => {
          window.copiedResultLink = value;
        }
      }
    })
  );
  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Link copied.' }).waitFor();
  assert.equal(await page.evaluate(() => window.copiedResultLink), presentation.results[0].url);
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('Clipboard unavailable');
        }
      }
    })
  );
  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  const manualResultLink = page.getByRole('textbox', { name: 'Copy this link', exact: true });
  await manualResultLink.waitFor();
  assert.equal(await manualResultLink.inputValue(), presentation.results[0].url);
  await manualResultLink.focus();
  assert(
    await manualResultLink.evaluate(
      (input) => input.selectionStart === 0 && input.selectionEnd === input.value.length
    ),
    'Clipboard refusal must retain a selectable result link'
  );
  const nativePageCount = page.context().pages().length;
  await page.evaluate(() => {
    window.nativePreviewCalls = [];
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        window.nativePreviewCalls.push({ command, args });
      }
    };
  });
  await page.getByRole('button', { name: 'Open app', exact: true }).click();
  await page.waitForFunction(() => window.nativePreviewCalls.length > 0);
  assert.deepEqual(await page.evaluate(() => window.nativePreviewCalls), [
    { command: 'open_preview_browser', args: { url: presentation.results[0].url } }
  ]);
  assert.equal(
    page.context().pages().length,
    nativePageCount,
    'The native action must use the system browser command without a webview popup'
  );
  await page.evaluate(() => delete window.__TAURI_INTERNALS__);
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Open app', exact: true }).click();
  const popup = await popupPromise;
  await popup.getByRole('button', { name: '0', exact: true }).click();
  assert.equal(await popup.getByRole('button').textContent(), '1');
  await popup.close();
  await page.getByRole('button', { name: 'Close embedded preview' }).click();
  await page.getByRole('button', { name: 'View here', exact: true }).click();
  assert.equal(
    (await page.locator('.garden-preview-frame').getAttribute('sandbox')).includes(
      'allow-same-origin'
    ),
    false,
    'A shared owner-origin preview must stay opaque'
  );
  await page
    .frameLocator('.garden-preview-frame')
    .getByRole('button', { name: '0', exact: true })
    .click();
  await page.getByRole('button', { name: 'Expand', exact: true }).click();
  assert.equal(
    await page.frameLocator('.garden-preview-frame').getByRole('button').textContent(),
    '1',
    'Expanding must preserve the running preview'
  );
  await page.getByRole('button', { name: 'Exit full screen', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download source', exact: true }).click();
  const download = await downloadPromise;
  assert.equal(await readFile(await download.path(), 'utf8'), previewHtml);
  await page.evaluate(() =>
    Object.defineProperty(Element.prototype, 'requestFullscreen', {
      configurable: true,
      value: undefined
    })
  );
  await page.getByRole('button', { name: 'Expand', exact: true }).click();
  assert.equal(
    await page.frameLocator('.garden-preview-frame').getByRole('button').textContent(),
    '1',
    'Fallback expansion must preserve the running preview'
  );
  assert.equal(await page.locator('.garden-output-primary.expanded').count(), 1);
  await page.getByRole('button', { name: 'Exit full screen', exact: true }).focus();
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Tab');
    assert(
      await page.evaluate(() =>
        Boolean(document.activeElement.closest('.garden-output-primary.expanded'))
      ),
      'Expanded previews must contain keyboard focus'
    );
  }
  await page.getByRole('button', { name: 'Close embedded preview' }).click();
  assert.equal(
    await page.locator('.garden-output-primary.expanded').count(),
    0,
    'Closing the preview must leave expanded mode'
  );
  presentation.results[0].url =
    isolatedPreviewOrigin + '/__athanor/preview/' + 'a'.repeat(32) + '/';
  await page.getByRole('button', { name: 'View here', exact: true }).click();
  assert.equal(
    (await page.locator('.garden-preview-frame').getAttribute('sandbox')).includes(
      'allow-same-origin'
    ),
    true,
    'A separate preview origin must support ordinary app storage and requests'
  );
  const isolatedFrame = page.frameLocator('.garden-preview-frame');
  await isolatedFrame.locator('body[data-storage="stored"][data-request="true"]').waitFor();
  await isolatedFrame.getByRole('button', { name: '0', exact: true }).click();
  assert.equal(await isolatedFrame.getByRole('button').textContent(), '1');
  await page.getByRole('button', { name: 'Close embedded preview' }).click();
  await page.getByRole('button', { name: 'Show projects', exact: true }).click();
  await page.getByRole('button', { name: /Switch to light/ }).click();
  await page.screenshot({ path: resolve(report, 'task-light.png') });
  await page.getByRole('button', { name: /Switch to dark/ }).click();
  await page.getByRole('button', { name: 'Hide projects', exact: true }).click();
  presentation.results = [];
  await page.reload();
  await page.getByText('Recorded activity · latest 2 actions', { exact: true }).click();
  assert.equal(await page.locator('.garden-recorded-actions strong').count(), 2);
  assert.equal(
    await page.locator('.garden-recorded-actions strong').first().textContent(),
    'Created maze/index.html'
  );
  await page.screenshot({ path: resolve(report, 'recorded-trace.png') });
  task.deliveryStatus = 'pending';
  task.pendingDeliveryCount = 1;
  presentation.delivery = { status: 'pending', pendingJobs: 1, failedJobs: 0, completedJobs: 0 };
  await page.reload();
  await page.waitForFunction(() =>
    document.querySelector('.run-summary')?.textContent.includes('Generating media')
  );
  assert.match(
    await page.locator('.garden-project-list button').first().getAttribute('aria-label'),
    /Generating media/,
    'The project list must not announce pending output as complete'
  );
  missions = [mission];
  mediaJobs = [
    {
      id: 'video-fixture',
      taskId: task.id,
      workspaceId: workspace.id,
      operation: 'generate',
      status: 'submission_uncertain',
      modelId: 'Video fixture',
      progress: null,
      watching: true,
      reservationUsd: 0.1,
      costUsd: null,
      costSource: 'unresolved',
      artifactId: null,
      error: 'The provider response was interrupted.',
      createdAt: time,
      updatedAt: time
    }
  ];
  mediaAssets = [
    {
      id: 'character-fixture',
      taskId: task.id,
      workspaceId: workspace.id,
      name: 'Reference character',
      providerAssetId: 'char_recorded',
      status: 'submission_uncertain',
      reservationUsd: 0.02,
      costUsd: null,
      createdAt: time,
      updatedAt: time
    }
  ];
  mediaBatches = [
    {
      id: 'batch-fixture',
      taskId: task.id,
      workspaceId: workspace.id,
      status: 'pending',
      total: 3,
      completed: 1,
      failed: 0,
      reservationUsd: 0.6,
      watching: true,
      cancelRequested: false,
      providerStatus: 'in_progress',
      reconciliation: null,
      cancellationSupported: true,
      error: null,
      createdAt: time,
      updatedAt: time
    }
  ];
  await page.reload();
  const batchCard = page.getByRole('article', { name: 'Video batch', exact: true });
  await batchCard.getByRole('button', { name: 'Cancel batch', exact: true }).click();
  await batchCard.getByText('The provider is cancelling this batch.', { exact: false }).waitFor();
  assert.equal(await batchCard.locator('.badge').textContent(), 'Rendering');
  assert.equal(await batchCard.getByText('Cancelled', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  const reviewDialog = page.getByRole('dialog', { name: 'Review Keyboard controls', exact: true });
  await reviewDialog.locator('summary').click();
  assert.match(
    await reviewDialog.locator('.garden-mission-diff').textContent(),
    /\+newControl\(\)/
  );
  await reviewDialog.getByRole('button', { name: 'Apply reviewed changes' }).click();
  await page.getByText('Changes applied', { exact: true }).waitFor();
  assert.deepEqual(
    reviewedSubmission,
    { digest: missionReview.digest, generation: 3 },
    'Integration must carry the inspected digest and generation'
  );
  await page.getByRole('button', { name: 'Open work', exact: true }).click();
  await page.getByRole('button', { name: 'Return to parent work', exact: true }).waitFor();
  assert.match(
    await page.locator('.garden-work-heading').textContent(),
    /Isolated controls workspace/
  );
  assert(
    !(await page.locator('#garden-sidebar').textContent()).includes(childWorkspace.name),
    'Internal specialist workspaces must not become projects'
  );
  await page.getByRole('button', { name: 'Computer', exact: true }).click();
  await page.locator('.computer.panel').waitFor();
  assert.equal(
    await page.locator('.computer.panel').getAttribute('aria-label'),
    `${childWorkspace.name} computer`,
    'Computer controls must remain scoped to the selected specialist workspace'
  );
  await page.goBack();
  assert.equal(
    await page.getByRole('slider', { name: 'Model reasoning effort' }).count(),
    0,
    'An allocated specialist must not offer a new model allocation'
  );
  childTask.status = 'awaiting_user';
  mission.state = 'paused';
  childQuestion = {
    ...event,
    id: '30000000-0000-4000-8000-000000000009',
    taskId: childTask.id,
    kind: 'question_asked',
    sequence: 4,
    summary: 'Choose the movement keys',
    payload: { question: 'Which keys should move the player?', options: ['Arrow keys', 'WASD'] }
  };
  await page.reload();
  await page.getByRole('button', { name: 'Reply to the question', exact: true }).click();
  await page.getByLabel('Your answer').fill('Use both arrow keys and WASD.');
  await page.getByRole('button', { name: 'Send answer', exact: true }).click();
  await page
    .getByRole('button', { name: 'Reply to the question', exact: true })
    .waitFor({ state: 'detached' });
  assert.deepEqual(
    childAnswer,
    { prompt: 'Use both arrow keys and WASD.' },
    'A specialist answer must preserve its existing allocation and model'
  );
  await page.getByRole('button', { name: 'Return to parent work', exact: true }).click();
  await page.getByText('Recover an uncertain submission', { exact: true }).click();
  await page.getByLabel('Provider video ID', { exact: true }).fill('video_existing');
  await page.getByRole('button', { name: 'Recover video', exact: true }).click();
  await page.getByText('in progress', { exact: true }).waitFor();
  assert.deepEqual(recoveredVideo, { providerJobId: 'video_existing' });
  await page.getByText('Record provider receipt', { exact: true }).click();
  assert.equal(await page.getByLabel('Provider character ID').inputValue(), 'char_recorded');
  await page.getByLabel('Final provider charge (USD)').fill('0.0125');
  await page.getByRole('button', { name: 'Record receipt', exact: true }).click();
  await page.getByText('Provider charge $0.01', { exact: true }).waitFor();
  assert.deepEqual(recordedReceipt, { providerCharacterId: 'char_recorded', costUsd: 0.0125 });
  await page.getByRole('button', { name: 'Computer', exact: true }).click();
  await page.getByRole('button', { name: 'Processes', exact: true }).click();
  await page.getByRole('button', { name: 'Interrupt cell', exact: true }).click();
  await page.getByText('Python · interrupted', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'End session…', exact: true }).click();
  await page.getByRole('button', { name: 'Keep session', exact: true }).click();
  assert.deepEqual(
    computationControls,
    [{ action: 'interrupt' }],
    'Keeping a session must preserve its state'
  );
  await page.getByRole('button', { name: 'End session…', exact: true }).click();
  await page.getByRole('button', { name: 'End session', exact: true }).click();
  await page.getByText('Python · stopped', { exact: true }).waitFor();
  assert.deepEqual(computationControls, [{ action: 'interrupt' }, { action: 'stop' }]);
  await page.getByText('workspace/main.py:2', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'End debug session…', exact: true }).click();
  await page.getByRole('button', { name: 'Keep debugging', exact: true }).click();
  assert.deepEqual(debugControls, [], 'Keeping a debug session must preserve the paused program');
  await page.getByRole('button', { name: 'End debug session…', exact: true }).click();
  await page.getByRole('button', { name: 'End session', exact: true }).click();
  await page.getByText('Python · terminated', { exact: true }).waitFor();
  assert.deepEqual(debugControls, [{ action: 'stop' }]);
  const authorizationPage = await context.newPage();
  authorizationPage.on('pageerror', (error) => errors.push(error.message));
  await authorizationPage.goto(`${origin}/#native-auth=${nativeAuthorization.id}`);
  const authorizeDialog = authorizationPage.getByRole('dialog', {
    name: 'Authorize your garden app',
    exact: true
  });
  const authorizeButton = authorizeDialog.getByRole('button', {
    name: 'Verify passkey and authorize',
    exact: true
  });
  await authorizeButton.waitFor();
  assert.equal(
    await authorizeButton.isEnabled(),
    false,
    'Authorization requires explicit code confirmation'
  );
  assert.equal(nativeDecision, undefined);
  await authorizeDialog.getByRole('checkbox').check();
  await authorizeButton.click();
  await authorizationPage
    .getByText('Your garden app can now continue. Return to it on your device.')
    .waitFor();
  assert.deepEqual(
    nativeStepUp,
    { force: true },
    'Device approval must force fresh passkey verification'
  );
  assert.deepEqual(nativeDecision, { userCode: 'ABCD-2345', approve: true });
  await authorizationPage.screenshot({ path: resolve(report, 'device-authorization.png') });
  await authorizationPage.close();
  const dictationPage = await context.newPage();
  dictationPage.on('pageerror', (error) => errors.push(error.message));
  await dictationPage.addInitScript(() => {
    window.dictationFixture = { requests: 0, stops: 0, deferred: false, release: null };
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: () => {
          window.dictationFixture.requests++;
          const stream = { getTracks: () => [{ stop: () => window.dictationFixture.stops++ }] };
          return window.dictationFixture.deferred
            ? new Promise((resolve) => {
                window.dictationFixture.release = () => resolve(stream);
              })
            : Promise.resolve(stream);
        }
      }
    });
    window.MediaRecorder = class {
      state = 'inactive';
      mimeType = 'audio/webm';
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['fixture audio'], { type: this.mimeType }) });
        this.onstop?.();
      }
    };
  });
  await dictationPage.goto(`${origin}/?task=${task.id}`);
  await dictationPage.getByRole('button', { name: 'Dictate direction', exact: true }).click();
  let dictationDialog = dictationPage.getByRole('dialog', {
    name: 'Dictate a direction',
    exact: true
  });
  await dictationDialog.getByText('Reviewed transcriber', { exact: true }).waitFor();
  assert.equal(
    await dictationPage.evaluate(() => window.dictationFixture.requests),
    0,
    'Preflight must precede microphone permission'
  );
  const recordButton = dictationDialog.getByRole('button', {
    name: 'Start recording',
    exact: true
  });
  assert.equal(
    await recordButton.isEnabled(),
    false,
    'This retained route requires consent and an explicit limit'
  );
  await dictationDialog.getByRole('spinbutton').fill('0.04');
  assert.equal(
    await recordButton.isEnabled(),
    false,
    'A cost limit does not grant retention consent'
  );
  await dictationDialog.getByRole('checkbox').check();
  await recordButton.click();
  await dictationPage.getByRole('button', { name: 'Stop dictation', exact: true }).click();
  const dictatedBody = dictationPage.getByRole('textbox', {
    name: 'Add direction to this work',
    exact: true
  });
  await dictationPage.waitForFunction(() =>
    document
      .querySelector('.intent-editor textarea')
      ?.value.includes('Keep the controls easy to reach.')
  );
  assert((await dictatedBody.inputValue()).includes('Keep the controls easy to reach.'));
  assert.equal(transcriptions.length, 1);
  assert.deepEqual(transcriptions[0], {
    data: Buffer.from('fixture audio').toString('base64'),
    format: 'webm',
    expectedRouteId: 'dictation-route',
    expectedModelId: 'dictation-model',
    expectedRouteProof: 'reviewed-route-proof',
    privacyRoute: 'external',
    externalConsent: true,
    maxCostUsd: 0.04
  });
  assert.equal(
    await dictationPage.evaluate(() => window.dictationFixture.stops),
    1,
    'A completed recording must release its microphone'
  );
  await dictationPage.evaluate(() => {
    window.dictationFixture.deferred = true;
  });
  await dictationPage.getByRole('button', { name: 'Dictate direction', exact: true }).click();
  dictationDialog = dictationPage.getByRole('dialog', { name: 'Dictate a direction', exact: true });
  await dictationDialog.getByRole('spinbutton').fill('0.04');
  await dictationDialog.getByRole('checkbox').check();
  await dictationDialog.getByRole('button', { name: 'Start recording', exact: true }).click();
  await dictationPage.getByRole('button', { name: 'Cancel dictation', exact: true }).click();
  await dictationPage.evaluate(() => window.dictationFixture.release());
  await dictationPage.waitForFunction(() => window.dictationFixture.stops === 2);
  assert.equal(
    transcriptions.length,
    1,
    'Cancelled late microphone permission must not submit audio'
  );
  dictationOptions.usdPerMinute = 0.006;
  dictationOptions.reservationUsd = null;
  dictationOptions.requiresMaxCostUsd = false;
  await dictationPage.getByRole('button', { name: 'Dictate direction', exact: true }).click();
  dictationDialog = dictationPage.getByRole('dialog', { name: 'Dictate a direction', exact: true });
  await dictationDialog.getByText('Reviewed transcriber', { exact: true }).waitFor();
  const durationQuote = await dictationDialog.textContent();
  assert.match(durationQuote, /per minute is held before submission/);
  assert.match(durationQuote, /provider receipt determines the final charge/);
  assert.equal(await dictationPage.evaluate(() => window.dictationFixture.requests), 2);
  await dictationPage.close();
  const voicePage = await context.newPage();
  voicePage.on('pageerror', (error) => errors.push(error.message));
  await voicePage.addInitScript(() => {
    window.voiceMicrophoneRequests = 0;
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: () => {
          window.voiceMicrophoneRequests++;
          return new Promise(() => {});
        }
      }
    });
  });
  await voicePage.goto(`${origin}/?task=${task.id}`);
  await voicePage.getByRole('button', { name: 'Live voice', exact: true }).click();
  const voiceDialog = voicePage.getByRole('dialog', { name: 'Live voice', exact: true });
  await voiceDialog.getByRole('combobox', { name: 'Voice model', exact: true }).waitFor();
  assert.equal(await voicePage.evaluate(() => window.voiceMicrophoneRequests), 0);
  const liveStart = voiceDialog.getByRole('button', { name: 'Start live voice', exact: true });
  assert.equal(await liveStart.isEnabled(), false);
  await voiceDialog
    .getByRole('spinbutton', { name: 'Session limit (USD)', exact: true })
    .fill('0.5');
  assert.equal(
    await liveStart.isEnabled(),
    false,
    'Voice cost approval does not grant retention consent'
  );
  await voiceDialog.getByRole('checkbox').check();
  assert.equal(await liveStart.isEnabled(), true);
  await voiceDialog.getByRole('slider').fill('2');
  assert.equal(await voiceDialog.getByRole('slider').getAttribute('aria-valuetext'), 'medium');
  await voiceDialog.getByText('Add a quiet mode to the maze.', { exact: true }).waitFor();
  assert.equal(voiceConfirm, undefined, 'A model proposal is not an owner direction');
  await voiceDialog.getByRole('button', { name: 'Send this direction', exact: true }).click();
  await voiceDialog.getByText('Suggested direction · confirmed', { exact: true }).waitFor();
  assert.deepEqual(voiceConfirm, { digest: 'exact-voice-proposal-digest' });
  await voiceDialog.getByText('Voice response · $0.03 pending', { exact: true }).click();
  const settle = voiceDialog.getByRole('button', { name: 'Record provider receipt', exact: true });
  assert.equal(await settle.isEnabled(), false, 'Missing usage must never become zero by default');
  await voiceDialog
    .getByRole('spinbutton', { name: 'Final provider charge (USD)', exact: true })
    .fill('0.015');
  await voiceDialog
    .getByRole('textbox', { name: /^Provider receipt reference/ })
    .fill('invoice-audio-123');
  await settle.click();
  await voiceDialog
    .getByRole('heading', { name: 'Pending audio charges', exact: true })
    .waitFor({ state: 'hidden' });
  assert.deepEqual(voiceReceipt, {
    receiptId: 'voice-receipt',
    costUsd: 0.015,
    providerReceiptRef: 'invoice-audio-123'
  });
  await voicePage.setViewportSize({ width: 390, height: 844 });
  assert(
    await voiceDialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    'The voice panel must fit a phone'
  );
  await voiceDialog.evaluate((element) => {
    element.scrollTop = 0;
  });
  await voicePage.screenshot({ path: resolve(report, 'voice-preflight-phone.png') });
  await voiceDialog.getByRole('button', { name: 'Close Live voice', exact: true }).click();
  assert.equal(await voicePage.evaluate(() => window.voiceMicrophoneRequests), 0);
  await voicePage.close();
  const approvalPage = await context.newPage();
  approvalPage.on('pageerror', (error) => errors.push(error.message));
  await approvalPage.setViewportSize({ width: 390, height: 844 });
  const showApproval = async (index, expired = false, samePage = false) => {
    approvals = [
      {
        id: `a0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        taskId: task.id,
        status: 'pending',
        action: 'Run a command',
        sideEffect: 'workspace',
        origin: null,
        createdAt: time,
        expiresAt: new Date(Date.now() + (expired ? -60000 : 600000)).toISOString(),
        preview: {
          tool: 'shell',
          command: 'python3 check.py',
          reason: `Check the result. ${index}`
        }
      }
    ];
    if (samePage) {
      await approvalPage.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    } else await approvalPage.goto(`${origin}/?task=${task.id}`);
    await approvalPage
      .locator('.decision-card')
      .getByText(`Check the result. ${index}`, { exact: true })
      .waitFor();
    return approvals[0].id;
  };
  await showApproval(90);
  const card = approvalPage.locator('.decision-card');
  await card.getByText('Add a reason for denying', { exact: true }).click();
  const note = card.getByRole('textbox', { name: 'Reason for denying (optional)', exact: true });
  await note.fill('This belongs only to the first request.');
  const denialId = await showApproval(1, false, true);
  assert.equal(
    await note.isVisible(),
    false,
    'Replacing a mounted decision must reset its disclosure'
  );
  await card.getByText('Add a reason for denying', { exact: true }).click();
  assert.equal(
    await note.inputValue(),
    '',
    'A new decision must never inherit another decision’s reason'
  );
  await note.focus();
  await approvalPage.keyboard.insertText('n'.repeat(610));
  assert.equal((await note.inputValue()).length, 600, 'The reason must be bounded while typing');
  const reason = 'Keep the output in the task folder.\nThen check the saved file.';
  await note.fill(reason);
  for (const theme of ['dark', 'light']) {
    await approvalPage.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const colors = await card.evaluate((element) => {
      const styles = getComputedStyle(element);
      const luminance = (color) => {
        const channels = color
          .match(/[\d.]+/g)
          .slice(0, 3)
          .map(Number)
          .map((value) => {
            const component = value / 255;
            return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
          });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      const background = luminance(styles.backgroundColor);
      const foreground = luminance(styles.color);
      return {
        background,
        contrast:
          (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05),
        overflow: element.scrollWidth > element.clientWidth + 1
      };
    });
    assert(colors.contrast >= 4.5, 'Approval text must remain readable in each theme');
    if (theme === 'dark')
      assert(colors.background < 0.1, 'Dark approval cards must use a dark surface');
    assert.equal(colors.overflow, false, 'An expanded denial reason must fit a phone');
    assert.equal(
      await approvalPage.evaluate(() => document.documentElement.scrollWidth),
      390,
      'The approval must not widen the page'
    );
    await card.getByRole('button', { name: 'Deny', exact: true }).scrollIntoViewIfNeeded();
    const actionsFit = await card.locator('.decision-actions').evaluate((element) => {
      const scroll = document.querySelector('.garden-task-scroll').getBoundingClientRect();
      const buttons = [...element.querySelectorAll('button')];
      return (
        buttons.length === 2 &&
        buttons.every((button) => {
          const box = button.getBoundingClientRect();
          return (
            box.left >= 0 &&
            box.right <= innerWidth &&
            box.top >= scroll.top &&
            box.bottom <= scroll.bottom
          );
        })
      );
    });
    assert(actionsFit, 'Approval actions must remain in the visible work area above the composer');
    await card.screenshot({ path: resolve(report, `approval-reason-${theme}-phone.png`) });
  }
  approvalFailures = [
    { status: 503, code: 'temporarily_unavailable', message: 'Please retry this decision.' }
  ];
  await card.getByRole('button', { name: 'Deny', exact: true }).click();
  await card.getByRole('alert').filter({ hasText: 'Please retry this decision.' }).waitFor();
  assert.equal(await note.inputValue(), reason, 'A failed submission must retain the reason');
  approvalFailures = [{ status: 403, code: 'step_up_required', message: 'Authenticate again.' }];
  nativeStepUp = undefined;
  await card.getByRole('button', { name: 'Deny', exact: true }).click();
  await card.waitFor({ state: 'hidden' });
  assert.deepEqual(
    nativeStepUp,
    {},
    'An authentication refusal must actually run step-up before retrying'
  );
  assert.deepEqual(
    approvalRequests,
    Array.from({ length: 3 }, () => ({ id: denialId, action: 'deny', body: { note: reason } })),
    'Manual and authentication retries must preserve the exact denial reason'
  );
  const approveId = await showApproval(2);
  await card.getByText('Add a reason for denying', { exact: true }).click();
  await note.fill('This reason must never be sent with an approval.');
  await card.getByRole('button', { name: 'Approve once', exact: true }).click();
  await card.waitFor({ state: 'hidden' });
  assert.deepEqual(approvalRequests.at(-1), { id: approveId, action: 'approve', body: {} });
  const plainDenyId = await showApproval(3);
  await card.getByText('Add a reason for denying', { exact: true }).click();
  await note.fill('   ');
  await card.getByRole('button', { name: 'Deny', exact: true }).click();
  await card.waitFor({ state: 'hidden' });
  assert.deepEqual(
    approvalRequests.at(-1),
    { id: plainDenyId, action: 'deny', body: {} },
    'A blank reason must preserve plain denial'
  );
  await showApproval(4, true);
  await card.getByText('Add a reason for denying', { exact: true }).click();
  assert.equal(await note.isEnabled(), false);
  assert.equal(await card.getByRole('button', { name: 'Deny', exact: true }).isEnabled(), false);
  assert.equal(await card.getByRole('button', { name: 'Expired', exact: true }).isEnabled(), false);
  assert.equal(approvalRequests.length, 5, 'Expired decisions must not submit');
  await approvalPage.close();
  assert.deepEqual(errors, [], 'The browser must not report uncaught errors');
  console.log(
    'Browser checks passed: viewport layout, phone focus, effort drafts, playable links, downloads, state-preserving expansion, recorded evidence, mission review, media recovery, analysis sessions, device authorization, dictation consent, live voice recovery, and denial feedback with authentication retry.'
  );
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
  await new Promise((done) => previewServer.close(done));
  if (ownedReport) await rm(report, { recursive: true, force: true });
}
