import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export async function checkProjectConversations({
  context,
  origin,
  bootstrap,
  task,
  workspace,
  presentation,
  models,
  modelSurface,
  report,
  errors
}) {
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const anchor = {
    ...workspace,
    id: randomUUID(),
    parentWorkspaceId: workspace.id,
    name: 'Genome project files'
  };
  const project = {
    id: randomUUID(),
    workspaceId: anchor.id,
    parentWorkspaceId: workspace.id,
    title: 'Genome study',
    brief: 'Use the verified assembly.',
    securityMode: 'autonomous',
    revision: 1,
    pinned: false,
    archivedAt: null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    conversationCount: 1,
    activeCount: 0,
    attentionCount: 0,
    spentUsd: 0.01,
    latestTaskId: null
  };
  const root = {
    ...task,
    id: randomUUID(),
    workspaceId: anchor.id,
    projectId: project.id,
    title: 'Assembly analysis'
  };
  const tasks = [root],
    notes = [],
    drafts = new Map(),
    requests = [];
  project.latestTaskId = root.id;
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname,
      method = route.request().method(),
      json = (body) => route.fulfill({ json: body });
    if (path === '/v1/bootstrap')
      return json({
        ...bootstrap,
        models,
        tasks: [...tasks],
        projects: [project],
        workspaces: [workspace, anchor],
        drafts: [...drafts.values()]
      });
    if (path === `/v1/projects/${project.id}`) {
      if (method === 'PATCH') {
        const input = route.request().postDataJSON();
        assert.equal(input.expectedRevision, project.revision);
        Object.assign(project, input, { revision: project.revision + 1 });
      }
      return json(project);
    }
    if (path === `/v1/projects/${project.id}/conversations`)
      return json({ tasks: [...tasks].reverse(), nextCursor: null });
    if (path === `/v1/projects/${project.id}/notes`) {
      if (method === 'POST') {
        const input = route.request().postDataJSON(),
          id = randomUUID();
        if (input.replacesId) notes.find((note) => note.id === input.replacesId).supersededBy = id;
        notes.unshift({
          id,
          projectId: project.id,
          source: null,
          replacesId: null,
          supersededBy: null,
          createdAt: new Date().toISOString(),
          ...input
        });
        return json({ id });
      }
      return json({
        notes: notes.filter(
          (note) => url.searchParams.get('history') === 'true' || !note.supersededBy
        ),
        nextCursor: null
      });
    }
    if (path === `/v1/projects/${project.id}/model-preferences`)
      return json({ ...modelSurface(), projectTaskId: project.id });
    if (
      path === `/v1/projects/${project.id}/processes` ||
      tasks.some((task) => path === `/v1/tasks/${task.id}/processes`)
    )
      return json({
        processes: [],
        resourcesAvailable: true,
        observedAt: new Date().toISOString()
      });
    if (
      path === `/v1/workspaces/${anchor.id}` ||
      tasks.some((task) => path === `/v1/workspaces/${task.workspaceId}`)
    )
      return json({ ...anchor, id: path.split('/').at(-1) });
    if (path === '/v1/drafts') {
      if (method === 'GET') {
        const key = url.searchParams.get('taskId') ?? `new:${url.searchParams.get('workspaceId')}`;
        return json(
          drafts.get(key) ?? {
            workspaceId: anchor.id,
            taskId: null,
            body: '',
            attachments: [],
            revision: 0
          }
        );
      }
      const input = route.request().postDataJSON(),
        key = input.taskId ?? `new:${input.workspaceId}`,
        revision = (drafts.get(key)?.revision ?? 0) + 1;
      drafts.set(key, { ...input, revision, updatedAt: new Date().toISOString() });
      return json({ revision, updatedAt: new Date().toISOString() });
    }
    if (path === '/v1/tasks' && method === 'POST') {
      const input = route.request().postDataJSON();
      requests.push(input);
      const child = {
        ...root,
        id: randomUUID(),
        workspaceId: randomUUID(),
        title: 'QC conversation',
        status: 'queued',
        securityMode: input.securityMode,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      tasks.push(child);
      project.conversationCount++;
      project.activeCount++;
      project.updatedAt = child.updatedAt;
      project.latestTaskId = child.id;
      return json(child);
    }
    const selected = tasks.find((task) => path === `/v1/tasks/${task.id}`);
    if (selected) return json(selected);
    if (tasks.some((task) => path === `/v1/tasks/${task.id}/presentation`))
      return json({ ...presentation, taskId: path.split('/')[3] });
    return route.fallback();
  });
  try {
    await page.goto(`${origin}/?project=${project.id}`);
    await page.getByRole('heading', { name: project.title, exact: true }).waitFor();
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'New conversation', exact: true });
    let input = dialog.getByPlaceholder('Describe what you want to do…');
    await input.fill('Review quality without changing the assembly.');
    assert.equal(
      await dialog.getByRole('combobox', { name: 'Approvals for this prompt' }).inputValue(),
      'autonomous'
    );
    await dialog.locator('summary').filter({ hasText: 'Working area' }).click();
    await dialog.getByRole('radio', { name: 'Shared project files' }).check();
    await page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/v1/drafts' &&
        response.request().method() === 'PUT' &&
        response.request().postDataJSON().controls?.conversation?.execution === 'shared'
    );
    await page.reload();
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'New conversation', exact: true });
    input = dialog.getByPlaceholder('Describe what you want to do…');
    assert.equal(await input.inputValue(), 'Review quality without changing the assembly.');
    await dialog.locator('summary').filter({ hasText: 'Working area' }).click();
    assert.equal(
      await dialog.getByRole('radio', { name: 'Shared project files' }).isChecked(),
      true
    );
    await dialog.getByRole('radio', { name: 'Independent area' }).check();
    await dialog.getByRole('button', { name: 'Begin', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.getByRole('heading', { name: 'QC conversation', exact: true }).waitFor();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].projectId, project.id);
    assert.equal(requests[0].execution, 'independent');
    assert.equal(requests[0].securityMode, 'autonomous');
    await page.reload();
    await page.getByRole('heading', { name: 'QC conversation', exact: true }).waitFor();
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const title = page.locator('.project-space-title h1');
      assert(
        (await title.boundingBox()).width > 40,
        'The project name must remain visible beside controls'
      );
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      await page.screenshot({ path: resolve(report, `conversations-${width}.png`) });
    }
    await page
      .getByRole('navigation', { name: 'Project conversations' })
      .getByRole('button', { name: 'Overview', exact: true })
      .click();
    const journal = page.getByRole('region', { name: 'Project notes' });
    await journal.getByRole('button', { name: 'Add note' }).click();
    const editor = page.getByRole('dialog', { name: 'Keep a project note' });
    await editor
      .getByRole('textbox', { name: 'Note', exact: true })
      .fill('The reference passed quality control.');
    await editor.getByRole('button', { name: 'Save note' }).click();
    await editor.waitFor({ state: 'detached' });
    await journal.getByText('The reference passed quality control.', { exact: true }).waitFor();
    await journal.getByRole('button', { name: 'Correct', exact: true }).click();
    const correction = page.getByRole('dialog', { name: 'Correct project note' });
    await correction
      .getByRole('textbox', { name: 'Note', exact: true })
      .fill('Use assembly version two; version one failed coverage.');
    await correction.getByRole('button', { name: 'Save note' }).click();
    await correction.waitFor({ state: 'detached' });
    await journal.getByRole('checkbox', { name: 'History' }).check();
    await journal.getByText('The reference passed quality control.', { exact: true }).waitFor();
    await journal
      .getByText('Use assembly version two; version one failed coverage.', { exact: true })
      .waitFor();
    await page.screenshot({ path: resolve(report, 'project-note-history.png') });
    await page.getByRole('button', { name: 'Discuss', exact: true }).first().click();
    const linked = page.getByRole('dialog', { name: 'New conversation', exact: true });
    await linked.getByPlaceholder('Describe what you want to do…').fill('Explain this result.');
    await page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/v1/drafts' &&
        response.request().method() === 'PUT' &&
        Boolean(response.request().postDataJSON().controls?.conversation?.source?.result)
    );
    assert(
      drafts.get(`new:${anchor.id}`).controls.conversation.source.result.id,
      'The selected result identity must survive draft recovery'
    );
    console.log(
      'Project conversation browser checks passed: persistent working-area drafts, inherited autonomy, independent creation, reloads, responsive names and controls, notes with correction history, and exact result references.'
    );
  } finally {
    await page.close();
  }
}
