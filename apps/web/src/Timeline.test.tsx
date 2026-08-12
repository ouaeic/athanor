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

  /*
   * The caret blinked at exactly the same rate whether tokens were arriving or the turn had been
   * dead for eleven minutes. What is on the answer instead is a class the heat hangs off and a line
   * only a screen reader gets - and both drop the instant the turn settles, which is the whole
   * claim: heat is recency, so it must be impossible for it to outlive the thing it is about.
   */
  it('marks an answer that is still arriving, and unmarks it the moment it is not', () => {
    const arriving = render(streamedTurn.slice(0, 5), 'running');
    expect(arriving).toContain('assistant-message cooling');
    expect(arriving).toContain('aria-busy="true"');
    expect(arriving).toContain('Still writing');
    expect(arriving).not.toContain('streaming-caret');

    const settled = render(streamedTurn);
    expect(settled).toContain('class="assistant-message"');
    expect(settled).not.toContain('cooling');
    expect(settled).not.toContain('aria-busy');
    expect(settled).not.toContain('Still writing');
  });

  it('keeps the tool traffic in one ledger and does not open one for the cost alone', () => {
    const markup = render(streamedTurn);
    expect(occurrences(markup, '<ol class="ledger" role="list"')).toBe(1);
    expect(markup).not.toContain('Step 1 completed');
  });

  /*
   * The fold is gone and the count that labelled it went with it. `Work log · 47 steps` was the
   * software describing its own volume; what is on the page now is the steps.
   */
  it('shows the work instead of counting it', () => {
    const markup = render(streamedTurn);
    expect(markup).not.toContain('Work log');
    expect(markup).not.toContain('task-activity');
    expect(markup).toContain('<span class="ledger-verb">read</span>');
    expect(markup).toContain('<b>a file</b>');
  });
});

/*
 * Fourteen minutes of one live task published 1,015 streamed frames and five consolidated replies,
 * and the reading column filled with the model talking itself through the job. The frames it never
 * consolidated are machinery, and this product already has a place for machinery.
 */
describe('the model working out loud', () => {
  const turn = [
    event(1, 'user_message', 'Cut the background out', { markdown: 'Cut the background out' }),
    event(2, 'assistant_delta', 'Agent response', {
      markdown: 'Let me think about what gives the cleanest true result.',
      append: true
    }),
    event(3, 'tool_started', 'Running shell', { tool: 'shell', toolCallId: 'c1' }),
    event(4, 'tool_result', 'shell finished', { toolCallId: 'c1', result: { exitCode: 0 } }),
    event(5, 'assistant_delta', 'Agent response', {
      markdown: 'Background cut, four sizes and a contact sheet.',
      append: true
    }),
    event(6, 'assistant_message', 'Background cut', {
      markdown: 'Background cut, four sizes and a contact sheet.'
    })
  ];

  it('promotes the reply and nothing else', () => {
    const markup = render(turn);
    expect(occurrences(markup, '<article class="assistant-message">')).toBe(1);
    expect(markup).toContain('Background cut, four sizes and a contact sheet.');
    // "Nothing else" includes the machine's initial. Every answer in this column is its own, so a
    // badge repeating that on each one said nothing and took 40px out of the 375 a phone has.
    expect(markup).not.toContain('ai-avatar');
    // Filed as a ledger row, which is one word and a disclosure that stays shut until it is opened.
    expect(markup).toContain('<span class="ledger-verb">thought</span>');
    expect(markup).not.toContain('<div class="markdown">Let me think about');
    expect(markup).toContain('<p class="tool-quiet">Let me think about');
  });

  /*
   * A block of the model's prose is not work, and a row that gave it a subject or a figure would be
   * claiming it was. The verb is the whole row: the machine thought here, and the prose is under it.
   */
  it('gives the narration a verb and nothing else to say', () => {
    const markup = render(turn);
    expect(markup).toContain(
      '<span class="ledger-verb">thought</span><span class="ledger-subject">' +
        '<b></b></span><span class="ledger-figure"></span>'
    );
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
    // Any caveat that arrives in both the acceptance record and the remaining risks, which is what
    // this rule is about. It used to be a specific one the worker emitted; that sentence was the
    // harness describing its own mechanics in the owner's completion and has been deleted, but the
    // render-it-once rule outlives it.
    const caveat = 'One check could not be run on this machine.';
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
  /*
   * Three concrete starts and nothing else. Not a headline: everything on screen is meant to be
   * evidence of the computer, and a tagline on the one screen where the machine has done nothing yet
   * is the software talking about itself. The examples teach what it can do and each one writes the
   * first message, which no sentence claiming the same thing does.
   */
  it('offers three concrete starts and says nothing about itself', () => {
    const markup = renderToStaticMarkup(<Timeline task={undefined} events={[]} />);
    expect(markup).not.toContain('<h1');
    expect(markup).not.toContain('What should we get done?');
    expect(occurrences(markup, '<button')).toBe(3);
  });

  it('says plainly when the conversation a link points at is gone', () => {
    const markup = renderToStaticMarkup(<Timeline task={undefined} events={[]} missing />);
    expect(markup).toContain('That conversation is gone');
  });
});

/*
 * The incident this card was measured against: the owner saw a turn going wrong, typed a correction
 * and sent it, and the provider stopped answering nine hundred seconds later. The turn died with
 * the correction still in the queue, and this card went on saying it ran after the current turn -
 * of a conversation that had no current turn and will not be leased again.
 *
 * The card is drawn from the event that recorded the message being accepted, and that event is
 * never taken back - so it outlives the queue row by design, and taking the message out of the
 * queue does not touch it. Whatever the box decides to do with the message, this has to agree with
 * what the conversation can still do.
 */
describe('a follow-up sent while the agent was working', () => {
  const correction = [
    event(1, 'user_message', 'Rewrite the billing page'),
    event(2, 'queued_message', 'Stop - the staging copy, not production', {
      markdown: 'Stop - the staging copy, not production',
      position: 1
    })
  ];

  const card = (status: Task['status']): string =>
    renderToStaticMarkup(
      <Timeline
        task={{ ...task, status }}
        events={correction}
        modelName={modelName}
        onCompose={() => undefined}
      />
    );

  it('says when it runs while there is still something to run it', () => {
    expect(card('running')).toContain('runs after the current turn');
    expect(card('running')).not.toContain('Never started');
  });

  it('keeps saying so for a conversation stopped part-way, because resuming does run it', () => {
    expect(card('paused')).toContain('runs after the current turn');
    expect(card('awaiting_resource')).toContain('runs after the current turn');
  });

  it('stops promising a turn that will never come, on every finished status', () => {
    for (const status of ['failed', 'cancelled', 'completed'] as const) {
      expect(card(status)).toContain('Never started');
      expect(card(status)).not.toContain('runs after the current turn');
    }
  });

  it('hands the words back rather than describing where they went', () => {
    expect(card('failed')).toContain('Put it back in the composer');
    // Still legible on the card itself: the offer is only useful next to what it would send.
    expect(card('failed')).toContain('Stop - the staging copy, not production');
    expect(card('running')).not.toContain('Put it back in the composer');
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

    expect(raised).not.toContain('class="ledger"');

    // A page that would not load is a thing the turn went on to handle. It is still recorded - the
    // ledger holds it - but it is not what the conversation is about, so it is filed among the
    // steps rather than raised into the reading column beside the answer.
    const filed = render([event(2, 'warning', 'A page would not load', { message: 'Timed out' })]);
    expect(filed).toContain('<ol class="ledger" role="list"');
    expect(filed.indexOf('class="ledger"')).toBeLessThan(filed.indexOf('system-event warning'));
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

describe('a question on the transcript', () => {
  /*
   * The tool it draws exists because a blocker used to come back as a finish with a not_applicable
   * verification, which lands as a completion card indistinguishable from finished work. So the
   * thing to hold this card to is that it does not read like either of the two cards it sits
   * between: not a completion, and not an approval.
   */
  const question = (extra: TaskEvent[] = []): string =>
    render(
      [
        event(1, 'user_message', 'Send the invoice', { markdown: 'Send the invoice' }),
        event(2, 'question_asked', 'Which mailbox should the invoice go from?', {
          question: 'Which mailbox should the invoice go from?',
          why: 'Two are connected and the reply address changes what the client sees.',
          options: ['work@', 'billing@']
        }),
        ...extra
      ],
      'awaiting_user'
    );

  it('shows the question, the reason for it, and the answers it would act on', () => {
    const markup = question();
    expect(markup).toContain('Which mailbox should the invoice go from?');
    expect(markup).toContain('the reply address changes what the client sees');
    expect(markup).toContain('billing@');
  });

  it('is not dressed as an approval', () => {
    // No risk language and no Approve/Deny: neither is an answer to "which of these", and the sand
    // and clay the approval card wears is this product's caution treatment. A question is the
    // owner's move, so the only warm thing on it is the small live dot the visual rule reserves.
    const markup = question();
    expect(markup).toContain('system-event question');
    expect(markup).not.toContain('system-event approval');
    expect(markup).not.toContain('Approve');
    expect(markup).not.toContain('Deny');
    expect(markup).toContain('question-live');
  });

  it('goes quiet once it has been answered', () => {
    const markup = question([event(3, 'user_message', 'billing@', { markdown: 'billing@' })]);
    expect(markup).toContain('You answered');
    // The dot means "your move", so it cannot still be burning over a question they have answered.
    expect(markup).not.toContain('question-live');
  });
});

/*
 * What the turn made, shown as the thing it is.
 *
 * A generated picture used to arrive as a 62x48 thumbnail beside its own file name, and a generated
 * track or clip as no preview at all, so the only way to find out what athanor had produced was to
 * leave for a browser tab. The element is chosen from the type the serving route will agree to
 * render inline rather than from the type the agent wrote down - `image/*` alone put an image frame
 * around a response the browser had already been told to download.
 */
describe('media the turn produced', () => {
  const artifact = (mimeType: string, name: string): string =>
    renderToStaticMarkup(
      <Timeline
        task={task}
        events={[
          event(1, 'artifact', `${name} · version 1`, {
            artifactId: '00000000-0000-4000-8000-0000000000a1',
            name,
            mimeType,
            sizeBytes: 4096,
            version: 1
          })
        ]}
        onOpenFile={() => {}}
      />
    );

  it('plays a picture, a track and a clip where they were made', () => {
    expect(artifact('image/png', 'chart.png')).toContain('<img src="/v1/artifacts/');
    expect(artifact('audio/mpeg', 'read.mp3')).toContain('<audio class="artifact-media"');
    expect(artifact('video/mp4', 'clip.mp4')).toContain('<video class="artifact-media"');
  });

  it('bounds the picture and makes the bound worth having', () => {
    const markup = artifact('image/png', 'chart.png');
    // The class the stylesheet caps, and the link out of the cap: full size is a tab, not a viewer
    // of our own.
    expect(markup).toContain('class="artifact-media"');
    expect(markup).toContain('Open chart.png at full size');
  });

  it('does not draw a player around bytes the route hands back as a download', () => {
    const markup = artifact('image/svg+xml', 'diagram.svg');
    expect(markup).not.toContain('artifact-media');
    // The card is still there, with the two things that do work on it.
    expect(markup).toContain('diagram.svg');
    expect(markup).toContain('Download</a>');
    expect(markup).not.toContain('Open</a>');
  });

  /*
   * "Files" opened the pane at whatever folder it happened to be showing, and "Open" downloaded
   * anything the route would not render - so two of three controls did the same thing and the first
   * did not do its job. The three verbs now match the file preview in the pane, in the same order.
   */
  it('offers the same three verbs the Files pane offers', () => {
    const markup = artifact('image/png', 'chart.png');
    expect(markup).toContain('Show chart.png in Files');
    expect(markup.indexOf('Show chart.png in Files')).toBeLessThan(markup.indexOf('Open</a>'));
    expect(markup.indexOf('Open</a>')).toBeLessThan(markup.indexOf('Download</a>'));
  });

  it('says nothing about the pane when there is no pane to point at', () => {
    const markup = renderToStaticMarkup(
      <Timeline
        task={task}
        events={[
          event(1, 'artifact', 'chart.png · version 1', {
            artifactId: '00000000-0000-4000-8000-0000000000a1',
            name: 'chart.png',
            mimeType: 'image/png',
            sizeBytes: 10
          })
        ]}
      />
    );
    expect(markup).not.toContain('in Files');
  });
});

/*
 * A diff says what changed; it does not say what the file now is, and for anything the agent
 * renders rather than writes the diff is the least useful view of it there is.
 */
describe('a file the agent wrote, reachable in the pane', () => {
  const written = (onOpenFile?: () => void): string =>
    renderToStaticMarkup(
      <ToolEvidence
        tool="file_write"
        args={{ path: 'workspace/report.md', content: 'one\ntwo' }}
        before="one"
        result={{ sha256: 'abc', sizeBytes: 7 }}
        stage="result"
        {...(onOpenFile ? { onOpenFile } : {})}
      />
    );

  it('offers the file itself beside the change to it', () => {
    const markup = written(() => {});
    expect(markup).toContain('Show workspace/report.md in Files');
    // Named by the file, not by the path, because the path is already the diff's own heading.
    expect(markup).toContain('report.md</button>');
  });

  it('offers nothing when there is nowhere to open it', () => {
    expect(written()).not.toContain('in Files');
  });
});

/*
 * The two things a finished turn now says out loud: what it left behind on the machine, and how it
 * actually ended.
 */
describe('a finished turn, on the record', () => {
  const turn = [
    event(1, 'user_message', 'Rebuild the site', { markdown: 'Rebuild the site' }),
    event(2, 'tool_started', 'Running file_write', { tool: 'file_write', toolCallId: 'c1' }),
    event(3, 'completed', 'Task completed', { summary: 'The site is rebuilt.' })
  ];
  const completion = turn[2]!.id;

  const withChanges = (
    turnChanges: { eventId: string; line: string } | undefined,
    status: Task['status'] = 'completed'
  ): string =>
    renderToStaticMarkup(
      <Timeline
        task={{ ...task, status }}
        tasks={[{ ...task, status }]}
        events={turn}
        modelName={modelName}
        {...(turnChanges ? { turnChanges } : {})}
      />
    );

  it('puts what changed on disk on the card, in one line', () => {
    const markup = withChanges({
      eventId: completion,
      line: 'On the computer — 2 files added, 1 changed'
    });
    expect(markup).toContain('On the computer — 2 files added, 1 changed');
    // One line, never a file tree: nothing here opens.
    expect(markup).toContain('completion-computer');
  });

  it('says nothing about the computer when there is nothing to say', () => {
    expect(withChanges(undefined)).not.toContain('completion-computer');
  });

  it('puts it on the completion it belongs to and nowhere else', () => {
    expect(
      withChanges({ eventId: turn[0]!.id, line: 'On the computer — 4 files added' })
    ).not.toContain('On the computer');
  });

  /*
   * The run used to be summed up twice — a glyph and a line reading "1 action · finished" — over a
   * completion card that says how it ended, in words, three rows below. One of the two was wrong
   * often enough to matter: "18 actions · 12 AI turns · finished" over a provider timeout, on a
   * conversation whose own row in the list said failed. The ledger sums nothing up; it shows the
   * steps, and how the turn ended is the completion card's one job.
   */
  it('does not sum the run up a second time above the card that says how it ended', () => {
    for (const status of ['failed', 'cancelled', 'completed'] as Array<Task['status']>) {
      const markup = withChanges(undefined, status);
      expect(markup).not.toContain('1 action');
      expect(markup).not.toContain('task-activity');
      expect(markup).toContain('<ol class="ledger" role="list"');
    }
  });

  /*
   * A start the task stopped on top of keeps the participle, because it never became a past tense:
   * it was begun and it did not end. What says so is the word in the figure column, not the mark,
   * which is exactly the case a reader who cannot see the mark must still be able to read.
   */
  it('says a call never came back in words, not only in the colour of a dot', () => {
    const markup = withChanges(undefined, 'failed');
    expect(markup).toContain('<span class="ledger-verb">writing</span>');
    expect(markup).toContain('<span class="ledger-figure">never finished</span>');
    expect(markup).toContain('tool-event unfinished');
  });
});

/*
 * The guarantee the whole promotion rests on: the ledger is what a turn with tool traffic gets, and
 * a conversation without any is untouched by it.
 */
describe('a conversation with nothing to show', () => {
  it('renders no ledger at all for a three-line exchange', () => {
    const markup = render([
      event(1, 'user_message', 'What is the capital of Peru?', {
        markdown: 'What is the capital of Peru?'
      }),
      event(2, 'assistant_message', 'Lima.', { markdown: 'Lima.' })
    ]);
    expect(markup).not.toContain('<ol');
    expect(markup).not.toContain('ledger');
  });
});

/*
 * A three-hundred-step turn is the case the fold was hiding from, and a list with no bound is the
 * same firehose with the tap left open. Newest at the bottom, next to the composer, because on a
 * live turn that is where the interesting rows are.
 */
describe('a turn with more steps than anybody reads at once', () => {
  const markup = render([
    event(1, 'user_message', 'Rebuild everything', { markdown: 'Rebuild everything' }),
    ...Array.from({ length: 26 }, (_, index) =>
      event(index + 2, 'tool_started', 'Running shell', {
        tool: 'shell',
        toolCallId: `c${index}`
      })
    )
  ]);

  it('opens with the last ten rows and says how many it is holding back', () => {
    expect(occurrences(markup, '<li>')).toBe(11);
    expect(markup).toContain('16 earlier steps');
  });

  it('counts one held-back step as one step', () => {
    const eleven = render([
      event(1, 'user_message', 'Go', { markdown: 'Go' }),
      ...Array.from({ length: 11 }, (_, index) =>
        event(index + 2, 'tool_started', 'Running shell', {
          tool: 'shell',
          toolCallId: `c${index}`
        })
      )
    ]);
    expect(eleven).toContain('1 earlier step<');
  });
});
