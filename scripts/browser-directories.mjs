import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export function directoryFixture(workspaceId) {
  const fixture = { failRead: false, reads: [], branch: '10000000-0000-4000-8000-000000000088' };
  fixture.handle = async (route, pathname) => {
    const url = new URL(route.request().url());
    if (pathname.endsWith('/directories')) {
      await route.fulfill({
        json: {
          directories: [
            { workspaceId, name: 'Project computer', path: 'workspace', current: true },
            {
              workspaceId: fixture.branch,
              name: 'Assembly branch',
              path: 'workspace',
              current: false
            }
          ]
        }
      });
      return true;
    }
    if (!pathname.endsWith('/directory')) return false;
    const folder = url.searchParams.get('path'),
      cursor = url.searchParams.get('cursor');
    fixture.reads.push({ pathname, folder, cursor });
    if (fixture.failRead) {
      await route.fulfill({
        status: 503,
        json: { error: { message: 'Directory temporarily unavailable' } }
      });
      return true;
    }
    const entry = (name, type = 'file', sizeBytes = 8 * 1024 ** 3) => ({
      name,
      type,
      sizeBytes,
      path: `${folder}/${name}`,
      modifiedAt: '2026-09-13T00:00:00Z'
    });
    await route.fulfill({
      json: {
        path: folder,
        entries: cursor
          ? [entry('later-page-results.bam')]
          : folder === 'workspace'
            ? [
                entry('results', 'directory'),
                entry('empty', 'directory'),
                entry('cohort-with-a-long-name-'.repeat(6) + '.fastq.gz'),
                entry('.analysis-config', 'file', 220)
              ]
            : folder === 'workspace/empty'
              ? []
              : [entry('alignment.bam'), entry('summary.tsv', 'file', 512)],
        nextCursor: folder === 'workspace' && !cursor ? 'page-two' : null
      }
    });
    return true;
  };
  return fixture;
}

export async function checkProjectDirectories({
  context,
  origin,
  taskId,
  workspaceId,
  fixture,
  report,
  errors
}) {
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${origin}/?task=${taskId}`);
    const panel = page.getByRole('region', { name: 'Project files', exact: true });
    await panel.getByRole('button', { name: 'Browse files', exact: true }).click();
    await panel.getByRole('button', { name: 'results', exact: true }).waitFor();
    assert((await panel.innerText()).includes('8.0 GiB'));
    assert((await panel.innerText()).includes('.analysis-config'));
    await panel.getByRole('button', { name: 'Load more files', exact: true }).click();
    await panel.getByText('later-page-results.bam', { exact: true }).waitFor();
    assert(fixture.reads.some((read) => read.cursor === 'page-two'));
    for (const width of [1440, 768, 320]) {
      await page.setViewportSize({ width, height: 1100 });
      await panel.scrollIntoViewIfNeeded();
      assert(
        await panel.evaluate((element) => element.scrollWidth <= element.clientWidth),
        `Directory controls fit at ${width}px`
      );
      const bounds = await panel.boundingBox();
      assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      await panel.screenshot({ path: resolve(report, `project-directories-${width}.png`) });
    }
    await panel.getByRole('button', { name: 'results', exact: true }).click();
    await panel.getByText('alignment.bam', { exact: true }).waitFor();
    const file = panel.getByRole('link', { name: 'Download alignment.bam', exact: true });
    assert.equal(
      await file.getAttribute('href'),
      `/v1/workspaces/${workspaceId}/download?path=workspace%2Fresults%2Falignment.bam`
    );
    assert.equal(
      await panel
        .getByRole('link', { name: 'Download this folder ZIP', exact: true })
        .getAttribute('href'),
      `/v1/workspaces/${workspaceId}/directory.zip?path=workspace%2Fresults`
    );
    fixture.failRead = true;
    await panel.getByRole('button', { name: 'Refresh directory', exact: true }).click();
    await panel.getByText('Directory temporarily unavailable', { exact: true }).waitFor();
    assert(await file.isVisible());
    fixture.failRead = false;
    await panel.getByRole('button', { name: 'Try again', exact: true }).click();
    await panel
      .getByText('Directory temporarily unavailable', { exact: true })
      .waitFor({ state: 'detached' });
    await panel.getByRole('combobox', { name: 'Execution directory' }).selectOption(fixture.branch);
    await panel.getByRole('button', { name: 'empty', exact: true }).click();
    await panel.getByText('This directory is empty.', { exact: true }).waitFor();
    assert.equal(
      await panel
        .getByRole('link', { name: 'Download directory ZIP', exact: true })
        .getAttribute('href'),
      `/v1/workspaces/${fixture.branch}/directory.zip?path=workspace`
    );
    assert(
      fixture.reads.some(
        (read) => read.pathname.includes(fixture.branch) && read.folder === 'workspace/empty'
      )
    );
    await panel
      .getByRole('navigation', { name: 'Project directory path' })
      .getByRole('button', { name: 'workspace', exact: true })
      .click();
    await panel.getByRole('button', { name: 'results', exact: true }).waitFor();
    console.log(
      'Project directory browser checks passed: branch roots, breadcrumbs, paging, hidden files, large file links, folder ZIP links, empty folders, stale/error states and responsive controls.'
    );
  } finally {
    fixture.failRead = false;
    await page.close();
  }
}
