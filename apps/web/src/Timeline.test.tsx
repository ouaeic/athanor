/**
 * The transcript, rendered.
 *
 * Everything else in this client is tested through the pure module behind the component, which is
 * the right shape for wording and for decisions — but the transcript's worst failure was neither.
 * It was two React branches disagreeing about which node the stream was building, and it put a
 * second copy of every streamed answer on screen. `renderToStaticMarkup` costs no dependency and no
 * DOM: effects do not run, so nothing is fetched, and what comes back is the markup a reader sees.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Timeline, ToolEvidence } from './Timeline.js';
import type { Task, TaskEvent } from './types.js';

const task: Task = {
  id: '00000000-0000-4000-8000-000000000010',
  workspaceId: '00000000-0000-4000-8000-000000000011',
  title: 'Quarterly report',
  status: 'completed',
  modelId: 'openrouter/z-ai/glm-5.2',
  privacyRoute: 'provider_zdr',
  maxComputeCredits: 5,
  actualComputeCredits: 1,
  spentUsd: 0.12,
  queuedMessageCount: 0,
  securityMode: 'balanced',
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-01T09:10:00.000Z'
} as Task;

const event = (sequence: number, kind: TaskEvent['kind'], summary: string, payload?: unknown) =>
  ({
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    taskId: task.id,
    sequence,
    kind,
    summary,
    ...(payload === undefined ? {} : { payload }),
    createdAt: '2026-08-01T09:05:00.000Z'
  }) as TaskEvent;

/** The picker's own words for a model, which is what the transcript has to agree with. */
const modelName = (id: string): string => (id.endsWith('glm-5.2') ? 'GLM-5.2' : id);

const render = (events: TaskEvent[], status: Task['status'] = 'completed'): string =>
  renderToStaticMarkup(
    <Timeline
      task={{ ...task, status }}
      tasks={[{ ...task, status }]}
      events={events}
      modelName={modelName}
    />
  );

const occurrences = (markup: string, needle: string): number => markup.split(needle).length - 1;

describe('a streamed turn on screen', () => {
  /*
   * The order every streaming turn arrives in: frames, the cost event that settles the turn, then
   * the normalised message that closes it. The answer appeared twice, with the work log wedged
   * between the two copies, in every conversation this product has ever had.
   */
  const streamedTurn = [
    event(1, 'user_message', 'Summarise the file', { markdown: 'Summarise the file' }),
    event(2, 'tool_started', 'Running file_read', { tool: 'file_read', toolCallId: 'c1' }),
    event(3, 'tool_result', 'file_read finished', { toolCallId: 'c1', result: { ok: true } }),
    event(4, 'assistant_delta', 'Agent response', { markdown: 'It is a ', append: true }),
    event(5, 'assistant_delta', 'Agent response', { markdown: 'sales export.', append: true }),
    event(6, 'cost', 'Step 1 completed', {
      costUsd: 0.021,
      usage: { inputTokens: 900, outputTokens: 120 },
      metadata: { provider: 'openrouter', model: 'z-ai/glm-5.2' }
    }),
    event(7, 'assistant_message', 'It is a sales export.', { markdown: 'It is a sales export.' })
  ];

  it('shows the answer once', () => {
    expect(occurrences(render(streamedTurn), 'It is a sales export.')).toBe(1);
  });

  /*
   * The model is recorded only on the `cost` event; it was read from the `plan` event, which has
   * never carried one, so every answer went unlabelled on a client that picks a model per turn.
   */
  it('labels it with the model that wrote it and what the turn cost', () => {
    expect(render(streamedTurn)).toContain('GLM-5.2 ·');
    expect(render(streamedTurn)).toContain('$0.02');
  });

  /*
   * The foot of the transcript read "$0.02 · 163k in · 1.6k out · 54% cached" under an answer that
   * was two lines of verse. Three of those four numbers are the provider's telemetry and none of
   * them can be acted on from a transcript; they are in the usage pane now.
   */
  it('closes the conversation with the money and nothing else', () => {
    const markup = render(streamedTurn);
    expect(markup).toContain('conversation-cost');
    expect(markup).not.toContain('900 in');
    expect(markup).not.toContain('cached');
  });

  it('keeps the tool traffic in one collapsed group and does not open one for the cost alone', () => {
    const markup = render(streamedTurn);
    expect(occurrences(markup, '<details class="task-activity')).toBe(1);
    expect(markup).not.toContain('Step 1 completed');
  });
});

describe('a turn the harness stopped at its step limit', () => {
  const markup = render(
    [
      event(1, 'user_message', 'Build the deck', { markdown: 'Build the deck' }),
      event(2, 'warning', 'This turn used its whole step budget before the work was finished', {
        owner: true,
        steps: 120,
        maxSteps: 120
      }),
      event(3, 'completed', 'Stopped at the step limit with work outstanding', {
        summary: 'Slides one to nine are in workspace/deck.md.',
        interrupted: true,
        outstanding: ['Write the closing section', 'Export to PDF'],
        verification: {
          status: 'not_applicable',
          evidence: [],
          remainingRisks: ['Write the closing section', 'Export to PDF']
        }
      })
    ],
    'completed'
  );

  it('keeps the box’s own label instead of calling it a result', () => {
    expect(markup).toContain('Stopped at the step limit with work outstanding');
    expect(markup).not.toContain('>Result<');
  });

  it('hands over what it did not reach, in the open', () => {
    expect(markup).toContain('Write the closing section');
    expect(markup).toContain('Export to PDF');
    expect(markup).toContain('reply to carry on from here');
  });

  /* The turn asserts `not_applicable` verification: claiming the opposite over it is a false claim. */
  it('never calls it verified', () => {
    expect(markup).not.toContain('Verified result');
  });
});

describe('a run stopped by a spending cap', () => {
  const markup = render(
    [
      event(1, 'user_message', 'Research this', { markdown: 'Research this' }),
      event(
        2,
        'status',
        'Paused at $4.02 of the $5.00 limit for today. Raise the limit to carry on, or leave it here.',
        { blockedBy: 'daily', windows: [{ name: 'daily' }], estimateUsd: 1.2 }
      )
    ],
    'paused'
  );

  it('says so where the owner is reading, not inside a collapsed log', () => {
    expect(markup).toContain('Paused by your spending cap');
    expect(markup).toContain('$4.02 of the $5.00 limit for today');
    expect(markup).not.toContain('task-activity');
  });
});

describe('the computer put back under a conversation that carried on', () => {
  /*
   * The rewind dialog promises this exact line: taking only the computer back leaves the
   * conversation "with a line in it recording what happened to the files". The server writes it as
   * a `status` event, which the transcript folds into the collapsed activity strip — so the one
   * thing an owner must be able to find afterwards was the one thing they could not see.
   */
  const markup = render([
    event(1, 'user_message', 'Undo the refactor', { markdown: 'Undo the refactor' }),
    event(2, 'status', 'Computer rewound', {
      filesystemRestored: true,
      restoredCheckpointId: '00000000-0000-4000-8000-000000000003',
      rewoundToEventId: '00000000-0000-4000-8000-000000000001'
    })
  ]);

  it('draws it in the transcript rather than inside a collapsed log', () => {
    expect(markup).toContain('The computer was put back');
    expect(markup).not.toContain('task-activity');
  });

  it('repeats the one thing a rewind does not do', () => {
    expect(markup).toContain('Nothing installed since then was removed');
  });

  /* An ordinary status event is still a status event; only a restore gets its own line. */
  it('leaves every other status event where it was', () => {
    expect(
      render([
        event(1, 'user_message', 'Carry on', { markdown: 'Carry on' }),
        event(2, 'status', 'Reconnected to the computer', {})
      ])
    ).not.toContain('The computer was put back');
  });
});

describe('a page the agent cannot get past', () => {
  it('says whether waiting is worth anything, from the evidence the runner recorded', () => {
    const wall = (evidence: 'page' | 'response') =>
      render([
        event(1, 'error', 'web_search was refused', {
          code: 'browser_bot_wall',
          botWall: {
            vendor: 'Cloudflare',
            url: 'https://shop.example.com/cart',
            reason: 'Turnstile',
            evidence
          }
        })
      ]);
    expect(wall('page')).toContain('clear by themselves');
    expect(wall('response')).toContain('waiting will not clear it');
    expect(wall('page')).toContain('shop.example.com');
  });
});

/*
 * The one piece of evidence in the product that the agent did not write. It is published while the
 * turn is still going, three events before the completion that reports it, and it used to reach
 * nothing at all.
 */
describe('a turn the harness checked', () => {
  const checkedTurn = [
    event(1, 'user_message', 'Fix the failing test', { markdown: 'Fix the failing test' }),
    event(2, 'status', 'Acceptance baseline: 0 of 2 already pass before the work', {
      baseline: true,
      acceptance: [
        { id: 'check-1', label: 'The suite passes', passed: false, detail: 'exit 1: 1 failed' },
        { id: 'check-2', label: 'The report exists', passed: false, detail: 'no such file' }
      ]
    }),
    event(3, 'tool_started', 'Running file_patch', { tool: 'file_patch', toolCallId: 'c1' }),
    event(4, 'status', 'Acceptance checks: 2 of 2 passed', {
      acceptance: [
        { id: 'check-1', label: 'The suite passes', passed: true, detail: 'exit 0' },
        { id: 'check-2', label: 'The report exists', passed: true, detail: '4213 bytes' }
      ]
    }),
    event(5, 'completed', 'Task completed', {
      summary: 'The suite is green.',
      acceptance: ['check-1: The suite passes — exit 0', 'check-2: The report exists — 4213 bytes'],
      verification: { status: 'verified', evidence: [], remainingRisks: [] }
    })
  ];

  it('says the harness ran, and what it saw, on the card that ends the turn', () => {
    const markup = render(checkedTurn);
    expect(markup).toContain('The harness ran 2 checks · all passed');
    expect(markup).toContain('The suite passes');
    expect(markup).toContain('exit 0');
  });

  it('reports the run that let the turn end, not the baseline taken before the work', () => {
    expect(render(checkedTurn)).not.toContain('exit 1: 1 failed');
  });

  it('shows a caveat about the tick beside the tick, not folded into the disclosure', () => {
    const caveat =
      'The acceptance checks were declared after this turn had already changed things.';
    const markup = render([
      event(1, 'status', 'Acceptance checks: 1 of 1 passed', {
        acceptance: [{ id: 'check-1', label: 'It builds', passed: true, detail: 'exit 0' }]
      }),
      event(2, 'completed', 'Task completed', {
        summary: 'Built it.',
        acceptance: [caveat, 'check-1: It builds — exit 0'],
        verification: { status: 'verified', evidence: [], remainingRisks: [caveat] }
      })
    ]);
    expect(markup).toContain('completion-harness-caveat');
    expect(occurrences(markup, caveat)).toBe(1);
  });

  it('leaves a completion with no acceptance record exactly as it was', () => {
    const markup = render([
      event(1, 'completed', 'Task completed', {
        summary: 'Answered the question.',
        verification: {
          status: 'verified',
          evidence: [{ claim: 'Read the file', source: 'tool_result' }],
          remainingRisks: []
        }
      })
    ]);
    expect(markup).toContain('Verified result');
    expect(markup).not.toContain('harness-checks');
  });
});

/*
 * The workbench header used to label a fork and offer its original as well, so a forked
 * conversation said the same thing three times on one screen. This bar is the only place now, so it
 * has to cover the one case the header covered and it did not: a parent too old to be in the page
 * of conversations this device loaded.
 */
describe('a conversation that is a fork of another', () => {
  const fork = {
    ...task,
    id: '00000000-0000-4000-8000-000000000030',
    parentTaskId: '00000000-0000-4000-8000-000000000031',
    branchedFromEventId: '00000000-0000-4000-8000-000000000032',
    forkKind: 'edit'
  } as Task;

  const renderFork = (tasks: Task[]): string =>
    renderToStaticMarkup(
      <Timeline task={fork} tasks={tasks} events={[]} modelName={modelName} onOpenTask={() => {}} />
    );

  it('offers the original even when the original is not on this device', () => {
    const markup = renderFork([fork]);
    expect(markup).toContain('Open original');
    expect(markup).toContain('Edited message');
  });

  it('counts the versions when the family is loaded', () => {
    const parent = { ...task, id: fork.parentTaskId! } as Task;
    const markup = renderFork([parent, fork]);
    expect(markup).toContain('version 2 of 2');
    expect(markup).toContain('Open original');
  });

  it('draws nothing at all for a conversation that is nobody’s fork', () => {
    expect(
      renderToStaticMarkup(
        <Timeline task={task} tasks={[task]} events={[]} onOpenTask={() => {}} />
      )
    ).not.toContain('fork-bar');
  });
});

describe('an empty conversation', () => {
  it('says what the computer is for and offers three concrete starts, and nothing else', () => {
    const markup = renderToStaticMarkup(<Timeline task={undefined} events={[]} />);
    expect(markup).toContain('A whole computer that keeps working while you are away.');
    expect(markup).not.toContain('What should we get done?');
    expect(occurrences(markup, '<button')).toBe(3);
  });

  it('says plainly when the conversation a link points at is gone', () => {
    const markup = renderToStaticMarkup(<Timeline task={undefined} events={[]} missing />);
    expect(markup).toContain('That conversation is gone');
  });
});

describe('a turn that read something nobody here wrote', () => {
  const readThenActed = [
    event(1, 'user_message', 'Research this and update the brief', {
      markdown: 'Research this and update the brief'
    }),
    event(2, 'tool_started', 'Running parallel_web_read', {
      tool: 'parallel_web_read',
      toolCallId: 'c1'
    }),
    event(3, 'warning', 'Untrusted content entered this turn from web page forum.example', {
      taint: { level: 'untrusted', sources: ['web page forum.example'], sinceStep: 2 },
      tool: 'parallel_web_read'
    }),
    event(4, 'tool_started', 'Running file_write', { tool: 'file_write', toolCallId: 'c2' }),
    event(5, 'assistant_message', 'Agent response', { markdown: 'Updated the brief.' })
  ];

  /*
   * Drawn as a change of character in the conversation rather than as a failure. A research task
   * crosses this line on purpose, and a row styled as an alert is a row that gets dismissed.
   */
  it('marks the point the outside content came in, and names where from', () => {
    const markup = render(readThenActed);
    expect(markup).toContain('external-content-mark');
    expect(markup).toContain('Read content from web page forum.example');
    expect(markup).not.toContain('system-event warning');
  });

  it('gathers what it read and what it changed afterwards', () => {
    const markup = render(readThenActed);
    expect(markup).toContain('Read from outside · web page forum.example');
    expect(markup).toContain('1 action after it');
    expect(markup).toContain('Wrote a file');
  });

  it('says nothing about a conversation that never left this computer', () => {
    const markup = render([
      event(1, 'user_message', 'Tidy the folder', { markdown: 'Tidy the folder' }),
      event(2, 'tool_started', 'Running file_write', { tool: 'file_write', toolCallId: 'c1' })
    ]);
    expect(markup).not.toContain('provenance-summary');
    expect(markup).not.toContain('external-content-mark');
  });

  it('draws a warning the owner has to act on as a warning, and files the rest', () => {
    const raised = render([
      event(2, 'warning', 'This turn used its whole step budget before the work was finished', {
        owner: true
      })
    ]);
    expect(raised).toContain('system-event warning');
    expect(raised).not.toContain('external-content-mark');

    // A page that would not load is a thing the turn went on to handle. It is still recorded - the
    // work log holds it - but it is not what the conversation is about.
    const filed = render([event(2, 'warning', 'A page would not load', { message: 'Timed out' })]);
    expect(filed).not.toContain('system-event warning');
    expect(filed).toContain('task-activity');
  });

  /**
   * Live reasoning was rendered open and in full, so every word a model thought sat in the
   * conversation above its answer - and `open` being a controlled prop meant a reader who collapsed
   * it had it reopened on the next frame.
   */
  it('leaves reasoning collapsed while it is still arriving, with the latest line on the summary', () => {
    const markup = render(
      [
        event(1, 'user_message', 'Look into it', { markdown: 'Look into it' }),
        event(2, 'assistant_reasoning', 'Agent reasoning', {
          markdown: 'First I will read the file.\nNow I am checking the second source.'
        })
      ],
      'running'
    );
    expect(markup).toContain('agent-thinking');
    // The whole point: not forced open.
    expect(markup).not.toContain('<details class="agent-thinking" open');
    // Proves the block really is mid-stream, so the assertion above is about the streaming case
    // rather than passing because the node had already settled.
    expect(markup).toContain('Thinking');
    expect(markup).not.toContain('How it got there');
    // Enough to show it is moving, without the body of it.
    expect(markup).toContain('Now I am checking the second source.');
  });

  /** A failure's detail is for the moment somebody goes looking, not for the conversation. */
  it('folds the detail of a failure behind a disclosure', () => {
    const markup = render([
      event(2, 'error', 'shell failed', {
        owner: true,
        message: 'Invalid request - args: invalid input: expected array, received string'
      })
    ]);
    expect(markup).toContain('event-detail');
    expect(markup).toContain('Details');
    expect(markup).toContain('shell failed');
  });
});

/*
 * What the agent changed in your files, reachable at last.
 *
 * Every diff this product produced was unreachable in every finished conversation: the diff was
 * rendered from the `tool_started` branch, and the transcript dropped every start that had a
 * result. What survived was `JSON.stringify(result)` at 9px - for a write, a hash and a byte count.
 */
describe('the evidence a call left behind', () => {
  const evidence = (props: Parameters<typeof ToolEvidence>[0]): string =>
    renderToStaticMarkup(<ToolEvidence {...props} />);

  it('shows a write as the change it made to the file', () => {
    const markup = evidence({
      tool: 'file_write',
      args: { path: 'notes.md', content: 'one\ntwo\nfour' },
      before: 'one\ntwo\nthree',
      result: { sha256: 'abc', sizeBytes: 12 },
      stage: 'result'
    });
    expect(markup).toContain('notes.md');
    expect(markup).toContain('diff-line add');
    expect(markup).toContain('diff-line remove');
    expect(markup).toContain('four');
    // Not "new file", which is what a write diffed against nothing claims to be.
    expect(markup).not.toContain('new file');
  });

  it('shows a command as the line that ran and the end of what it printed', () => {
    const markup = evidence({
      tool: 'shell',
      args: { executable: 'pnpm', args: ['--filter', '@athanor/web', 'test'] },
      result: { exitCode: 1, stdout: '3 failed', stderr: '' },
      stage: 'result'
    });
    expect(markup).toContain('pnpm --filter @athanor/web test');
    expect(markup).toContain('3 failed');
    expect(markup).toContain('exit 1');
  });

  /*
   * A start is drawn on its own only while the call is still in flight, and there is no result to
   * read yet. Saying "It printed nothing" over a build that is still building is the same class of
   * confident falsehood as "new file · +800" over a one-line edit — the thing this panel exists to
   * stop. The line that is running is still shown, because that is the part that is true.
   */
  it('does not tell you a running command printed nothing', () => {
    const markup = evidence({
      tool: 'shell',
      args: { executable: '/usr/bin/make', args: ['build'] },
      stage: 'started'
    });
    expect(markup).toContain('make build');
    expect(markup).not.toContain('printed nothing');
  });

  /*
   * `<details>` hides its children; it does not stop React building them. With one write the diff
   * opens and is drawn, with several it stays shut and costs nothing until it is asked for — which
   * is what keeps a turn that created three large files from putting a thousand rows in the
   * document the moment the work log is expanded.
   */
  it('builds the rows of a diff only for the one it opens', () => {
    const both = {
      tool: 'file_patch',
      stage: 'result',
      result: {}
    } as const;
    const one = evidence({
      ...both,
      args: { patches: [{ path: 'a.ts', oldText: 'one', newText: 'two' }] }
    });
    expect(one).toContain('diff-line');
    const many = evidence({
      ...both,
      args: {
        patches: [
          { path: 'a.ts', oldText: 'one', newText: 'two' },
          { path: 'b.ts', oldText: 'three', newText: 'four' }
        ]
      }
    });
    expect(many).toContain('b.ts');
    expect(many).not.toContain('diff-line');
  });

  it('shows a page read as the page and whose it was', () => {
    const markup = evidence({
      tool: 'browser_snapshot',
      args: { url: 'https://www.example.com/pricing' },
      result: { holder: 'agent', url: 'https://www.example.com/pricing', title: 'Pricing' },
      stage: 'result'
    });
    expect(markup).toContain('Pricing');
    expect(markup).toContain('example.com');
  });

  /* Promoted, not hidden: whatever the reader came for is still one disclosure further down. */
  it('keeps the raw payload behind one more disclosure', () => {
    const markup = evidence({
      tool: 'shell',
      args: { executable: 'ls' },
      result: { exitCode: 0, stdout: 'notes.md' },
      stage: 'result'
    });
    expect(markup).toContain('tool-raw');
    expect(markup).toContain('Raw result');
    expect(markup).toContain('&quot;exitCode&quot;: 0');
  });

  it('falls back to the payload for a tool with no shape worth promoting', () => {
    const markup = evidence({ tool: 'memory', args: {}, result: { saved: true }, stage: 'result' });
    expect(markup).not.toContain('tool-evidence');
    expect(markup).toContain('&quot;saved&quot;: true');
  });
});
