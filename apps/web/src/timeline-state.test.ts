import { describe, expect, it } from 'vitest';
import type { Task, TaskEvent } from './types.js';
import {
  activeBotWall,
  activityOverview,
  agentNotice,
  asBotWall,
  botWallClearance,
  botWallFromEvent,
  buildConversation,
  compactResultSummary,
  conversationCost,
  conversationMarkdown,
  formatBytes,
  forkFamily,
  formatTokens,
  liveActivityId,
  mergeTaskEvent,
  previewLifetime,
  reasoningEffortLabel,
  settledToolStarts,
  spendPause,
  taskStateAnnouncement,
  withPendingMessage
} from './timeline-state.js';

const event = (sequence: number, kind: TaskEvent['kind'], payload?: unknown): TaskEvent =>
  ({
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    taskId: '00000000-0000-4000-8000-000000000099',
    sequence,
    kind,
    summary: kind === 'tool_started' ? 'Running file_write' : `${kind} completed`,
    ...(payload === undefined ? {} : { payload }),
    createdAt: '2026-07-23T00:00:00.000Z'
  }) as TaskEvent;

describe('the model\u2019s own working', () => {
  // A high-effort step on a full window thinks for the better part of a minute before the first
  // word of the answer. The route produced this all along and the stream parser already read it -
  // it was accumulated and attached to the finished response, arriving after it was of any use,
  // while the owner watched a spinner.
  const reasoning = (id: string, markdown: string): TaskEvent =>
    ({
      id,
      taskId: 't',
      sequence: Number(id.replace(/\D/g, '')),
      kind: 'assistant_reasoning',
      summary: 'Agent thinking',
      payload: { markdown, append: true },
      createdAt: '2026-08-05T00:00:00.000Z'
    }) as unknown as TaskEvent;

  const answer = (id: string, markdown: string): TaskEvent =>
    ({
      id,
      taskId: 't',
      sequence: Number(id.replace(/\D/g, '')),
      kind: 'assistant_message',
      summary: 'Agent response',
      payload: { markdown },
      createdAt: '2026-08-05T00:00:00.000Z'
    }) as unknown as TaskEvent;

  it('joins the frames into one foldable node while it streams', () => {
    const nodes = buildConversation(
      [reasoning('1', 'Let me '), reasoning('2', 'check the file.')],
      'running'
    );
    const thinking = nodes.filter((node) => node.kind === 'thinking');
    expect(thinking).toHaveLength(1);
    expect(thinking[0]).toMatchObject({ markdown: 'Let me check the file.', streaming: true });
  });

  it('joins them the same way once the task is finished and the log is replayed', () => {
    // Merging was for live turns only, so reloading a finished conversation broke the one block its
    // author had watched arrive into a row per frame, each headed the same three words. A turn that
    // streamed as one paragraph came back as forty of them.
    const nodes = buildConversation(
      [reasoning('1', 'Let me '), reasoning('2', 'check the file.')],
      'completed'
    );
    const thinking = nodes.filter((node) => node.kind === 'thinking');
    expect(thinking).toHaveLength(1);
    expect(thinking[0]).toMatchObject({ markdown: 'Let me check the file.', streaming: false });
  });

  it('supersedes the frames with the row that carries the whole of the thinking', () => {
    // That row exists so the frames can be dropped from the log; a client that watched them arrive
    // still has them, and appending it would show the same thinking a second time.
    const whole = (id: string, markdown: string): TaskEvent =>
      ({ ...reasoning(id, markdown), payload: { markdown, replace: true } }) as TaskEvent;
    const nodes = buildConversation(
      [
        reasoning('1', 'Let me '),
        reasoning('2', 'check the file.'),
        whole('3', 'Let me check the file.')
      ],
      'running'
    );
    const thinking = nodes.filter((node) => node.kind === 'thinking');
    expect(thinking).toHaveLength(1);
    expect(thinking[0]).toMatchObject({ markdown: 'Let me check the file.' });
  });

  it('closes the thinking when the answer it produced arrives', () => {
    const nodes = buildConversation([reasoning('1', 'Working.'), answer('2', 'Done.')], 'running');
    const thinking = nodes.find((node) => node.kind === 'thinking');
    expect(thinking).toMatchObject({ streaming: false });
    // And it stays its own node rather than being glued to the top of what was asked for.
    expect(nodes.find((node) => node.kind === 'assistant')).toMatchObject({ markdown: 'Done.' });
  });
});

describe('timeline presentation', () => {
  it('formats artifact sizes without exposing raw byte counts', () => {
    expect(formatBytes(975)).toBe('975 B');
    expect(formatBytes(1_250_000)).toBe('1.3 MB');
    expect(formatBytes(2_000_000_000)).toBe('2.0 GB');
  });
  it('settles completed tool starts instead of leaving stale loading states', () => {
    const events = [
      event(1, 'tool_started', { tool: 'file_write', toolCallId: 'call-1' }),
      event(2, 'tool_result', { toolCallId: 'call-1', result: { ok: true } })
    ];
    expect(settledToolStarts(events, 'running')(events[0]!)).toBe(true);
    expect(settledToolStarts(events, 'completed')(events[0]!)).toBe(true);
  });

  it('leaves a tool start unsettled until its own result arrives', () => {
    const events = [
      event(1, 'tool_started', { tool: 'shell', toolCallId: 'call-1' }),
      event(2, 'tool_started', { tool: 'file_read', toolCallId: 'call-2' }),
      event(3, 'tool_result', { toolCallId: 'call-2' })
    ];
    const settled = settledToolStarts(events, 'running');
    expect(settled(events[0]!)).toBe(false);
    expect(settled(events[1]!)).toBe(true);
  });

  it('settles every earlier tool start once the turn produced an artifact', () => {
    const events = [
      event(1, 'tool_started', { tool: 'shell', toolCallId: 'call-1' }),
      event(2, 'artifact', { artifactId: 'a1' }),
      event(3, 'tool_started', { tool: 'shell', toolCallId: 'call-3' })
    ];
    const settled = settledToolStarts(events, 'running');
    expect(settled(events[0]!)).toBe(true);
    expect(settled(events[2]!)).toBe(false);
  });

  it('describes only the current action while work is active', () => {
    const events = [
      event(1, 'tool_started', { tool: 'file_read', toolCallId: 'call-1' }),
      event(2, 'tool_result', { toolCallId: 'call-1' }),
      event(3, 'tool_started', { tool: 'file_write', toolCallId: 'call-2' })
    ];
    expect(activityOverview('running', events)).toBe('Writing a file');
  });

  it('names the action rather than the tool that performs it', () => {
    for (const [tool, phrase] of [
      ['web_search', 'Searching the web'],
      ['browser_snapshot', 'Reading a page'],
      ['parallel_web_read', 'Reading several pages'],
      ['desktop_observe', 'Looking at the screen']
    ] as Array<[string, string]>)
      expect(
        activityOverview('running', [event(1, 'tool_started', { tool, toolCallId: 'call-1' })])
      ).toBe(phrase);
  });

  it('replaces running language with compact final counts', () => {
    const events = [
      event(1, 'tool_started', { tool: 'file_write', toolCallId: 'call-1' }),
      event(2, 'cost'),
      event(3, 'cost')
    ];
    expect(activityOverview('completed', events)).toBe('1 action · 2 AI turns · finished');
  });

  it('creates a short plain-language result while preserving the full source separately', () => {
    const source = `Created **three deliverables** in \`workspace/results\`. ${'More detail. '.repeat(60)}`;
    const summary = compactResultSummary(source);
    expect(summary).toContain('Created three deliverables in workspace/results.');
    expect(summary.length).toBeLessThanOrEqual(321);
    expect(summary).not.toContain('**');
  });

  it('preserves underscores in filenames', () => {
    expect(compactResultSummary('Published `experiment_results.csv`.')).toBe(
      'Published experiment_results.csv.'
    );
  });
});

describe('conversation transcript', () => {
  it('keeps every user and assistant turn in order, not just the first prompt', () => {
    const nodes = buildConversation(
      [
        event(1, 'user_message', { markdown: 'First request' }),
        event(2, 'assistant_message', { markdown: 'First answer' }),
        event(3, 'user_message', { markdown: 'Follow-up request' }),
        event(4, 'assistant_message', { markdown: 'Second answer' })
      ],
      'completed'
    );

    expect(nodes.map((node) => node.kind)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(nodes.map((node) => ('markdown' in node ? node.markdown : ''))).toEqual([
      'First request',
      'First answer',
      'Follow-up request',
      'Second answer'
    ]);
  });

  it('concatenates streamed fragments into one growing message', () => {
    const frames = [
      event(1, 'user_message', { markdown: 'Go' }),
      event(2, 'assistant_delta', { markdown: 'I will ', append: true }),
      event(3, 'assistant_delta', { markdown: 'check the ', append: true }),
      event(4, 'assistant_delta', { markdown: 'workspace.', append: true })
    ];

    const midStream = buildConversation(frames, 'running');
    expect(midStream.map((node) => node.kind)).toEqual(['user', 'assistant']);
    expect(midStream[1]).toMatchObject({
      markdown: 'I will check the workspace.',
      streaming: true
    });

    const settled = buildConversation(
      [...frames, event(5, 'assistant_message', { markdown: 'I will check the workspace.' })],
      'running'
    );
    expect(settled.map((node) => node.kind)).toEqual(['user', 'assistant']);
    expect(settled[1]).toMatchObject({ markdown: 'I will check the workspace.', streaming: false });
    // Retry and Branch have to reach the settled message, not the frame that happened to be last.
    expect(settled[1] && 'event' in settled[1] ? settled[1].event.sequence : 0).toBe(5);
  });

  it('renders one bubble for a long streamed reply instead of one per frame', () => {
    const paragraph = 'The quick brown fox jumps over the lazy dog. ';
    const answer = `${paragraph.repeat(46).slice(0, 1_999)}!`;
    const frames: TaskEvent[] = [event(1, 'user_message', { markdown: 'Go' })];
    for (let offset = 0; offset < answer.length; offset += 24)
      frames.push(
        event(frames.length + 1, 'assistant_delta', {
          markdown: answer.slice(offset, offset + 24),
          append: true
        })
      );
    frames.push(event(frames.length + 1, 'assistant_message', { markdown: answer }));

    const nodes = buildConversation(frames, 'completed');
    expect(frames).toHaveLength(86);
    expect(nodes.map((node) => node.kind)).toEqual(['user', 'assistant']);
    expect(nodes[1] && 'markdown' in nodes[1] ? nodes[1].markdown : '').toBe(answer);
  });

  it('still collapses cumulative snapshots from a log that predates fragment frames', () => {
    const nodes = buildConversation(
      [
        event(1, 'user_message', { markdown: 'Go' }),
        event(2, 'assistant_delta', { markdown: 'I will ', replace: true }),
        event(3, 'assistant_delta', { markdown: 'I will check the ', replace: true }),
        event(4, 'assistant_delta', { markdown: 'I will check the workspace.', replace: true }),
        event(5, 'assistant_message', { markdown: 'I will check the workspace.' })
      ],
      'running'
    );

    expect(nodes.map((node) => node.kind)).toEqual(['user', 'assistant']);
    expect(nodes[1]).toMatchObject({ markdown: 'I will check the workspace.', streaming: false });
  });

  it('starts a new bubble for the next turn rather than gluing it onto the settled answer', () => {
    const nodes = buildConversation(
      [
        event(1, 'assistant_delta', { markdown: 'Reading it now.', append: true }),
        event(2, 'assistant_message', { markdown: 'Reading it now.' }),
        event(3, 'tool_started', { tool: 'file_read', toolCallId: 'call-1' }),
        event(4, 'tool_result', { toolCallId: 'call-1' }),
        event(5, 'assistant_delta', { markdown: 'It is a CSV.', append: true }),
        event(6, 'assistant_message', { markdown: 'It is a CSV.' })
      ],
      'completed'
    );

    expect(nodes.map((node) => node.kind)).toEqual(['assistant', 'activity', 'assistant']);
    expect(nodes.map((node) => ('markdown' in node ? node.markdown : ''))).toEqual([
      'Reading it now.',
      '',
      'It is a CSV.'
    ]);
  });

  /*
   * The model is read from the `cost` event, which is the only event that records it. It was read
   * from the `plan` event, whose payload is the plan and has never carried a model at all — so
   * every answer in the product went unattributed on a client whose default is to choose the model
   * per turn.
   */
  it('labels each answer with the model that wrote it and what that turn cost', () => {
    const nodes = buildConversation(
      [
        event(1, 'user_message', { markdown: 'Go' }),
        event(2, 'assistant_message', { markdown: 'First answer' }),
        event(3, 'cost', {
          costUsd: 0.021,
          usage: { inputTokens: 10, outputTokens: 5 },
          metadata: { provider: 'openrouter', model: 'z-ai/glm-5.2' }
        }),
        event(4, 'user_message', { markdown: 'And again' }),
        event(5, 'assistant_message', { markdown: 'Second answer' }),
        event(6, 'cost', {
          costUsd: 0.14,
          metadata: { provider: 'openrouter', model: 'ai/claude' }
        })
      ],
      'completed'
    );
    const answers = nodes.filter((node) => node.kind === 'assistant');
    expect(answers).toHaveLength(2);
    expect(answers[0]).toMatchObject({ model: 'z-ai/glm-5.2', costUsd: 0.021 });
    // Turn two's model must not be attributed to turn one's answer.
    expect(answers[1]).toMatchObject({ model: 'ai/claude', costUsd: 0.14 });
  });

  /*
   * A non-streaming provider settles the cost before the message exists, so the model has to be
   * carried forward as well as backward. Both orders arrive from the same worker.
   */
  it('names the model when the cost lands before the answer it paid for', () => {
    const nodes = buildConversation(
      [
        event(1, 'user_message', { markdown: 'Go' }),
        event(2, 'cost', { costUsd: 0.05, metadata: { provider: 'openrouter', model: 'a/b' } }),
        event(3, 'assistant_message', { markdown: 'Answer' })
      ],
      'completed'
    );
    expect(nodes.filter((node) => node.kind === 'assistant')[0]).toMatchObject({ model: 'a/b' });
  });

  /*
   * The order every streaming turn actually arrives in: frames, then the cost event that settles
   * the turn, then the normalised message that closes it. Flushing the cost into an activity group
   * used to sever the stream, so the closing message became a second copy of the whole reply — with
   * the work log wedged between the two of them, on every answer of every conversation.
   */
  it('closes a streamed answer with its settled message even though the cost arrives between', () => {
    const nodes = buildConversation(
      [
        event(1, 'user_message', { markdown: 'Go' }),
        event(2, 'assistant_delta', { markdown: 'Hello ', append: true }),
        event(3, 'assistant_delta', { markdown: 'world', append: true }),
        event(4, 'cost', { costUsd: 0.03, metadata: { provider: 'openrouter', model: 'a/b' } }),
        event(5, 'assistant_message', { markdown: 'Hello world' })
      ],
      'completed'
    );
    const answers = nodes.filter((node) => node.kind === 'assistant');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({
      markdown: 'Hello world',
      streaming: false,
      model: 'a/b',
      costUsd: 0.03
    });
  });

  it('does not glue the next turn onto an answer an activity group separated it from', () => {
    const nodes = buildConversation(
      [
        event(1, 'assistant_delta', { markdown: 'First.', append: true }),
        event(2, 'cost', { costUsd: 0.01 }),
        event(3, 'assistant_message', { markdown: 'First.' }),
        event(4, 'tool_result', { toolCallId: 'c1' }),
        event(5, 'assistant_delta', { markdown: 'Second.', append: true }),
        event(6, 'assistant_message', { markdown: 'Second.' })
      ],
      'completed'
    );
    expect(nodes.map((node) => ('markdown' in node ? node.markdown : node.kind))).toEqual([
      'First.',
      'activity',
      'Second.'
    ]);
  });

  it('does not open a work log whose only content is a step counter', () => {
    const nodes = buildConversation(
      [
        event(1, 'user_message', { markdown: 'Go' }),
        event(2, 'assistant_message', { markdown: 'Answer' }),
        event(3, 'cost', { costUsd: 0.01 }),
        event(4, 'completed', { summary: 'Done' })
      ],
      'completed'
    );
    expect(nodes.map((node) => node.kind)).toEqual(['user', 'assistant', 'completion']);
  });

  it('collects the pages a turn actually visited, deduped, for the answer they fed', () => {
    const nodes = buildConversation(
      [
        event(1, 'user_message', { markdown: 'Research this' }),
        event(2, 'tool_result', {
          toolCallId: 'c1',
          result: {
            pages: [
              { url: 'https://www.example.com/a?x=1', title: 'Example A' },
              { url: 'https://example.com/a?x=1', title: 'Example A again' },
              { url: 'https://docs.example.org/guide', title: 'The guide' },
              { url: 'not-a-url', title: 'ignored' }
            ]
          }
        }),
        event(3, 'assistant_message', { markdown: 'Here is the briefing.' }),
        event(4, 'user_message', { markdown: 'Thanks' }),
        event(5, 'assistant_message', { markdown: 'Any time.' })
      ],
      'completed'
    );
    const answers = nodes.filter((node) => node.kind === 'assistant');
    expect(answers[0]?.kind === 'assistant' ? answers[0].sources : undefined).toEqual([
      { url: 'https://www.example.com/a?x=1', host: 'example.com', title: 'Example A' },
      { url: 'https://docs.example.org/guide', host: 'docs.example.org', title: 'The guide' }
    ]);
    // A later answer that read nothing carries no sources strip.
    expect(answers[1]?.kind === 'assistant' ? answers[1].sources : undefined).toBeUndefined();
  });

  it('cites the pages a turn read and not the ten a search offered it', () => {
    const nodes = buildConversation(
      [
        event(1, 'user_message', { markdown: 'Research this' }),
        event(2, 'tool_result', {
          toolCallId: 'c1',
          result: {
            query: 'rowing shell prices 2026',
            results: [
              {
                rank: 1,
                title: 'Ten best boats',
                url: 'https://listicle.example.com/best',
                site: 'listicle.example.com',
                snippet: 'A ranked list of…'
              },
              {
                rank: 2,
                title: 'Maker price list',
                url: 'https://maker.example.org/prices',
                site: 'maker.example.org',
                snippet: 'Current prices…'
              }
            ]
          }
        }),
        event(3, 'tool_result', {
          toolCallId: 'c2',
          result: { pages: [{ url: 'https://maker.example.org/prices', title: 'Maker prices' }] }
        }),
        event(4, 'assistant_message', { markdown: 'Here is the briefing.' })
      ],
      'completed'
    );
    const answer = nodes.find((node) => node.kind === 'assistant');
    expect(answer?.kind === 'assistant' ? answer.sources : undefined).toEqual([
      { url: 'https://maker.example.org/prices', host: 'maker.example.org', title: 'Maker prices' }
    ]);
  });

  it('renders a conversation as pasteable Markdown without the tool log', () => {
    const markdown = conversationMarkdown('Quarterly report', [
      event(1, 'user_message', { markdown: 'Summarise it' }),
      event(2, 'tool_started', { tool: 'file_read', toolCallId: 'c1' }),
      event(3, 'tool_result', { toolCallId: 'c1', result: { ok: true } }),
      event(4, 'assistant_message', { markdown: 'Revenue is up.' }),
      event(5, 'completed', { summary: 'Briefing written.' })
    ]);
    expect(markdown).toBe(
      '# Quarterly report\n\n## You\n\nSummarise it\n\n## athanor\n\nRevenue is up.\n\n## Result\n\nBriefing written.\n'
    );
  });

  it('does not concatenate a fragment onto an answer the stream did not build', () => {
    const nodes = buildConversation(
      [
        event(1, 'assistant_message', { markdown: 'Done.' }),
        event(2, 'assistant_delta', { markdown: 'Now the second part.', append: true })
      ],
      'running'
    );
    expect(nodes.map((node) => ('markdown' in node ? node.markdown : ''))).toEqual([
      'Done.',
      'Now the second part.'
    ]);
  });

  it('does not merge two genuinely different answers', () => {
    const nodes = buildConversation(
      [
        event(1, 'assistant_message', { markdown: 'Answer one' }),
        event(2, 'assistant_message', { markdown: 'Answer two' })
      ],
      'completed'
    );
    expect(nodes).toHaveLength(2);
  });

  it('groups tool traffic between messages and drops settled tool starts', () => {
    const nodes = buildConversation(
      [
        event(1, 'user_message', { markdown: 'Go' }),
        event(2, 'tool_started', { tool: 'file_write', toolCallId: 'call-1' }),
        event(3, 'tool_result', { toolCallId: 'call-1', result: { ok: true } }),
        event(4, 'assistant_message', { markdown: 'Done' })
      ],
      'completed'
    );

    expect(nodes.map((node) => node.kind)).toEqual(['user', 'activity', 'assistant']);
    const activity = nodes[1];
    if (activity?.kind !== 'activity') throw new Error('expected an activity group');
    expect(activity.events).toHaveLength(1);
    expect(activity.events[0]?.event.kind).toBe('tool_result');
  });

  it('retires a queued notice once the message has actually run', () => {
    const promoted = buildConversation(
      [
        event(1, 'queued_message', { markdown: 'Later work' }),
        event(2, 'user_message', { markdown: 'Later work' })
      ],
      'running'
    );
    expect(promoted.map((node) => node.kind)).toEqual(['user']);

    const stillWaiting = buildConversation(
      [event(1, 'queued_message', { markdown: 'Later work' })],
      'running'
    );
    expect(stillWaiting.map((node) => node.kind)).toEqual(['queued']);
  });

  it('keeps artifacts, notices and the completion card as transcript entries', () => {
    const nodes = buildConversation(
      [
        event(1, 'artifact', { artifactId: 'a1', name: 'report.pdf' }),
        event(2, 'error'),
        event(3, 'completed', { summary: 'All done' })
      ],
      'failed'
    );
    expect(nodes.map((node) => node.kind)).toEqual(['output', 'notice', 'completion']);
  });

  it('rolls up spend and cache savings across every turn', () => {
    const total = conversationCost([
      event(1, 'cost', {
        costUsd: 0.02,
        usage: { inputTokens: 1_000, outputTokens: 200, cachedInputTokens: 800 }
      }),
      event(2, 'cost', { costUsd: 0.03, usage: { inputTokens: 2_000, outputTokens: 100 } }),
      event(3, 'assistant_message', { markdown: 'ignored' })
    ]);
    expect(total).toEqual({
      costUsd: 0.05,
      inputTokens: 3_000,
      outputTokens: 300,
      cachedInputTokens: 800
    });
  });

  it('groups forks taken from the same point into ordered versions', () => {
    const task = (id: string, createdAt: string, extra: Partial<Task> = {}): Task =>
      ({
        id,
        workspaceId: 'w1',
        title: `task ${id}`,
        status: 'completed',
        modelId: 'openrouter/z-ai/glm-5.2',
        privacyRoute: 'provider_zdr',
        securityMode: 'balanced',
        maxComputeCredits: 5,
        actualComputeCredits: 1,
        queuedMessageCount: 0,
        createdAt,
        updatedAt: createdAt,
        ...extra
      }) as Task;

    const original = task('root', '2026-07-31T10:00:00.000Z');
    const firstEdit = task('edit-1', '2026-07-31T10:05:00.000Z', {
      parentTaskId: 'root',
      branchedFromEventId: 'evt-1',
      forkKind: 'edit'
    });
    const secondEdit = task('edit-2', '2026-07-31T10:09:00.000Z', {
      parentTaskId: 'root',
      branchedFromEventId: 'evt-1',
      forkKind: 'edit'
    });
    const elsewhere = task('branch-x', '2026-07-31T10:07:00.000Z', {
      parentTaskId: 'root',
      branchedFromEventId: 'evt-9',
      forkKind: 'branch'
    });
    const all = [original, firstEdit, secondEdit, elsewhere];

    const family = forkFamily(secondEdit, all);
    expect(family.versions.map((item) => item.id)).toEqual(['root', 'edit-1', 'edit-2']);
    expect(family.index).toBe(2);
    expect(family.parent?.id).toBe('root');

    // A fork from a different event is a separate version line, not a sibling.
    expect(forkFamily(elsewhere, all).versions.map((item) => item.id)).toEqual([
      'root',
      'branch-x'
    ]);

    // The original itself has no version line, but does know what came off it.
    const root = forkFamily(original, all);
    expect(root.versions).toEqual([]);
    expect(root.index).toBe(-1);
    expect(root.children.map((item) => item.id)).toEqual(['edit-1', 'branch-x', 'edit-2']);
  });

  it('formats token counts compactly', () => {
    expect(formatTokens(940)).toBe('940');
    expect(formatTokens(1_500)).toBe('1.5k');
    expect(formatTokens(24_000)).toBe('24k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
  });

  it('shows the message being sent before the server has echoed it', () => {
    const pending = {
      id: 'pending-1',
      taskId: '00000000-0000-4000-8000-000000000099',
      markdown: 'Summarise the quarterly report',
      createdAt: '2026-07-23T00:01:00.000Z'
    };
    const merged = withPendingMessage([event(1, 'task_created')], pending);
    expect(merged).toHaveLength(2);
    expect(merged[1]?.kind).toBe('user_message');
    expect(merged[1]?.sequence).toBe(2);

    const nodes = buildConversation(merged, 'queued');
    expect(nodes.filter((node) => node.kind === 'user')).toHaveLength(1);
  });

  it('drops the optimistic message as soon as the real one arrives', () => {
    const pending = {
      id: 'pending-1',
      taskId: '00000000-0000-4000-8000-000000000099',
      markdown: 'Summarise the quarterly report',
      createdAt: '2026-07-23T00:01:00.000Z'
    };
    const events = [
      event(1, 'task_created'),
      event(2, 'user_message', { markdown: 'Summarise the quarterly report' })
    ];
    expect(withPendingMessage(events, pending)).toBe(events);
    expect(
      buildConversation(withPendingMessage(events, pending), 'running').filter(
        (node) => node.kind === 'user'
      )
    ).toHaveLength(1);
  });

  it('leaves the transcript untouched when nothing is in flight', () => {
    const events = [event(1, 'task_created')];
    expect(withPendingMessage(events, undefined)).toBe(events);
  });

  it('appends an in-order stream frame without rebuilding or re-sorting the log', () => {
    const events = [event(1, 'task_created'), event(2, 'user_message', { markdown: 'Go' })];
    const merged = mergeTaskEvent(events, event(3, 'assistant_delta', { markdown: 'Working' }));
    expect(merged.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(merged.slice(0, 2)).toEqual(events);
  });

  it('places an out-of-order frame at its sequence rather than at the tail', () => {
    const events = [event(1, 'task_created'), event(4, 'cost')];
    expect(mergeTaskEvent(events, event(2, 'user_message')).map((item) => item.sequence)).toEqual([
      1, 2, 4
    ]);
  });

  it('ignores a replayed frame it already holds', () => {
    const events = [event(1, 'task_created'), event(2, 'cost'), event(3, 'completed')];
    expect(mergeTaskEvent(events, event(2, 'cost'))).toBe(events);
    expect(mergeTaskEvent(events, event(3, 'completed'))).toBe(events);
  });

  it('starts an empty log from the first frame', () => {
    expect(mergeTaskEvent([], event(7, 'task_created')).map((item) => item.sequence)).toEqual([7]);
  });

  it('names the reasoning effort of a step, and says nothing when the step carried none', () => {
    expect(reasoningEffortLabel('high')).toBe('high reasoning effort');
    expect(reasoningEffortLabel(undefined)).toBe('');
    expect(reasoningEffortLabel('turbo')).toBe('');
  });

  it('announces each task state in one plain sentence', () => {
    expect(taskStateAnnouncement('Quarterly report', 'awaiting_user')).toBe(
      'Quarterly report: The agent needs your approval.'
    );
    expect(taskStateAnnouncement('Quarterly report', 'completed')).toBe(
      'Quarterly report: Work finished.'
    );
  });
});

describe('whether waiting out a challenge is worth anything', () => {
  const wall = { vendor: 'Cloudflare', url: 'https://shop.example.com/cart', reason: 'Turnstile' };

  it('says a page check often clears itself, because most of them do', () => {
    expect(botWallClearance({ ...wall, evidence: 'page' })).toContain('clear by themselves');
  });

  /* Only a fresh request could re-test this, and that request is the retry that must not happen. */
  it('says a challenge from the site’s own answer will not clear by waiting', () => {
    expect(botWallClearance({ ...wall, evidence: 'response' })).toContain('waiting will not clear');
  });

  it('says nothing at all when the box never recorded where it saw the evidence', () => {
    expect(botWallClearance(wall)).toBe('');
  });
});

describe('a run stopped by a spending cap', () => {
  const halt = (payload: unknown): TaskEvent => ({
    ...event(9, 'status', payload),
    summary: 'Paused at $4.02 of the $5.00 limit for today. Raise the limit to carry on.'
  });

  it('recognises the halt the worker writes, and which ceiling stopped it', () => {
    expect(spendPause(halt({ blockedBy: 'daily', windows: [{ name: 'daily' }] }))).toEqual({
      message: 'Paused at $4.02 of the $5.00 limit for today. Raise the limit to carry on.',
      window: 'daily'
    });
  });

  it('still reports the stop when the decision named no window', () => {
    expect(spendPause(halt({ blockedBy: null, windows: [] }))?.window).toBe('');
  });

  it('leaves every other status event where it was', () => {
    expect(spendPause(event(3, 'status', { step: 90, maxSteps: 120 }))).toBeUndefined();
    expect(spendPause(event(3, 'status'))).toBeUndefined();
    expect(spendPause(event(3, 'warning', { blockedBy: 'daily', windows: [] }))).toBeUndefined();
  });

  /*
   * Buried in the collapsed work log under a tick, beside a Resume button that would halt against
   * the same ceiling again, this read as athanor stopping for no reason.
   */
  it('puts the stop in the conversation rather than inside the work log', () => {
    const nodes = buildConversation(
      [
        event(1, 'user_message', { markdown: 'Go' }),
        event(2, 'tool_result', { toolCallId: 'c1' }),
        halt({ blockedBy: 'monthly', windows: [{ name: 'monthly' }] })
      ],
      'paused'
    );
    expect(nodes.map((node) => node.kind)).toEqual(['user', 'activity', 'paused']);
    const stop = nodes[2];
    if (stop?.kind !== 'paused') throw new Error('expected the stop to be its own entry');
    expect(stop.pause.window).toBe('monthly');
  });
});

describe('liveActivityId', () => {
  it('picks the newest activity group, which is the only one the agent is working in', () => {
    const nodes = buildConversation(
      [
        event(1, 'user_message', { markdown: 'Build the deck' }),
        event(2, 'tool_started'),
        event(3, 'tool_result'),
        event(4, 'assistant_message', { markdown: 'Here is the outline.' }),
        event(5, 'tool_started'),
        event(6, 'tool_result')
      ],
      'running'
    );
    const groups = nodes.filter((node) => node.kind === 'activity');
    expect(groups).toHaveLength(2);
    expect(liveActivityId(nodes)).toBe(groups[1]?.id);
  });

  it('has nothing to mark live when nothing has run yet', () => {
    expect(liveActivityId([])).toBeUndefined();
    expect(
      liveActivityId(buildConversation([event(1, 'user_message', { markdown: 'Hello' })], 'queued'))
    ).toBeUndefined();
  });
});

describe('a challenge the agent cannot pass', () => {
  const snapshot = (botWall?: Record<string, unknown>) => ({
    url: 'https://jobs.example.com/apply',
    title: 'Just a moment…',
    holder: botWall ? 'user' : 'agent',
    elements: [],
    ...(botWall ? { botWall } : { botWall: null })
  });
  const wall = {
    vendor: 'Cloudflare Turnstile',
    url: 'https://jobs.example.com/apply',
    reason: 'challenge widget is embedded in the page'
  };

  it('reads the wall out of the browser result that hit it', () => {
    const hit = event(2, 'tool_result', { toolCallId: 'call-1', result: snapshot(wall) });
    expect(botWallFromEvent(hit)).toEqual(wall);
    expect(botWallFromEvent(event(3, 'tool_result', { result: snapshot() }))).toBeUndefined();
  });

  it('stands in the conversation instead of inside the collapsed activity log', () => {
    const nodes = buildConversation(
      [
        event(1, 'user_message', { markdown: 'Apply for this job' }),
        event(2, 'tool_started', { tool: 'browser_snapshot', toolCallId: 'call-1' }),
        event(3, 'tool_result', { toolCallId: 'call-1', result: snapshot(wall) })
      ],
      'failed'
    );
    const handoff = nodes.find((node) => node.kind === 'handoff');
    expect(handoff?.kind === 'handoff' && handoff.wall).toEqual(wall);
  });

  it('stays raised until a later browser result comes back without one', () => {
    const blocked = [event(1, 'tool_result', { toolCallId: 'a', result: snapshot(wall) })];
    expect(activeBotWall(blocked)).toEqual(wall);
    expect(
      activeBotWall([...blocked, event(2, 'tool_result', { toolCallId: 'b', result: snapshot() })])
    ).toBeUndefined();
  });

  it('is not cleared by a look at the desktop, which holds nothing to do with the browser', () => {
    const events = [
      event(1, 'tool_result', { toolCallId: 'a', result: snapshot(wall) }),
      event(2, 'tool_result', {
        toolCallId: 'b',
        result: { holder: 'agent', activeApplication: 'Chromium', nodes: [] }
      })
    ];
    expect(activeBotWall(events)).toEqual(wall);
  });

  it('reports nothing when the browser was never used', () => {
    expect(activeBotWall([event(1, 'assistant_message', { markdown: 'Done' })])).toBeUndefined();
  });

  /*
   * Only `browser_snapshot` returns a wall in its body. A search, a click and a PDF print each
   * refuse with 409, which the worker records as an `error` event carrying the same fields — and a
   * research pass starts with a search, so this is the likeliest way a challenge is ever met.
   */
  const refusal = (sequence: number, botWall: Record<string, unknown>, toolCallId = 'call-1') =>
    ({
      ...event(sequence, 'error', {
        toolCallId,
        message: 'Blocked by Cloudflare Turnstile: this page is showing an anti-bot challenge.',
        code: 'browser_bot_wall',
        botWall
      }),
      summary: 'web_search failed'
    }) as TaskEvent;

  it('reads the wall out of a refusal as well as out of a result', () => {
    expect(botWallFromEvent(refusal(2, { ...wall, tabId: 'tab-2' }))).toEqual({
      ...wall,
      tabId: 'tab-2'
    });
    // An ordinary tool failure is still an ordinary tool failure.
    expect(
      botWallFromEvent(event(3, 'error', { toolCallId: 'call-2', message: 'timed out' }))
    ).toBeUndefined();
    // A refusal that names the code but carries nothing readable is not a wall either.
    expect(botWallFromEvent(event(4, 'error', { code: 'browser_bot_wall' }))).toBeUndefined();
  });

  it('offers the way out when a search was refused, rather than a red line and nothing', () => {
    const nodes = buildConversation(
      [
        event(1, 'user_message', { markdown: 'Research this' }),
        event(2, 'tool_started', { tool: 'web_search', toolCallId: 'call-1' }),
        refusal(3, wall)
      ],
      'running'
    );
    const handoff = nodes.find((node) => node.kind === 'handoff');
    expect(handoff?.kind === 'handoff' && handoff.wall).toEqual(wall);
    // The refusal is the handoff, not also a system-event line repeating it.
    expect(nodes.some((node) => node.kind === 'notice')).toBe(false);
  });

  it('says the same site is stopped once, however many calls it refuses', () => {
    const nodes = buildConversation(
      [
        event(1, 'user_message', { markdown: 'Research this' }),
        refusal(2, wall, 'call-1'),
        refusal(3, wall, 'call-2'),
        refusal(4, wall, 'call-3')
      ],
      'running'
    );
    expect(nodes.filter((node) => node.kind === 'handoff')).toHaveLength(1);
    // The two it did not draw a card for are still in the record, in the work log.
    const activity = nodes.find((node) => node.kind === 'activity');
    expect(activity?.kind === 'activity' && activity.events).toHaveLength(2);
  });

  it('says a second site is stopped, and says a cleared site again if it stops again', () => {
    const elsewhere = { ...wall, url: 'https://html.duckduckgo.com/html/?q=a' };
    const nodes = buildConversation(
      [
        refusal(1, wall, 'call-1'),
        refusal(2, elsewhere, 'call-2'),
        event(3, 'tool_result', { toolCallId: 'call-3', result: snapshot() }),
        refusal(4, wall, 'call-4')
      ],
      'running'
    );
    expect(nodes.filter((node) => node.kind === 'handoff')).toHaveLength(3);
  });

  it('stays raised from a refusal until a browser result comes back clean', () => {
    const blocked = [refusal(1, wall)];
    expect(activeBotWall(blocked)).toEqual(wall);
    expect(
      activeBotWall([...blocked, event(2, 'tool_result', { toolCallId: 'b', result: snapshot() })])
    ).toBeUndefined();
    // And a refusal after a clean read raises it again.
    expect(
      activeBotWall([
        ...blocked,
        event(2, 'tool_result', { toolCallId: 'b', result: snapshot() }),
        refusal(3, wall, 'call-9')
      ])
    ).toEqual(wall);
  });

  it('carries which tab is stopped, so the owner can be shown that page and not another', () => {
    const stopped = { ...wall, evidence: 'response', tabId: 'tab-3' };
    expect(botWallFromEvent(event(2, 'tool_result', { result: snapshot(stopped) }))).toEqual({
      ...wall,
      evidence: 'response',
      tabId: 'tab-3'
    });
    // An older box sends neither, and a banner without them still names the site and clears.
    expect(asBotWall({ ...wall, evidence: 'guess', tabId: 7 })).toEqual(wall);
  });
});

describe('a note the agent decided to send', () => {
  const notice = (payload: unknown) =>
    ({
      id: '00000000-0000-4000-8000-000000000042',
      taskId: '00000000-0000-4000-8000-000000000099',
      sequence: 2,
      kind: 'notice',
      summary: 'The page changed.',
      payload,
      createdAt: '2026-07-23T00:00:00.000Z'
    }) as unknown as TaskEvent;

  it('is read as the message the owner was sent', () => {
    expect(agentNotice(notice({ headline: 'Price drop', detail: 'Now £84, from £119.' }))).toEqual({
      headline: 'Price drop',
      detail: 'Now £84, from £119.'
    });
    expect(agentNotice(notice({ headline: 'The page changed.' }))).toEqual({
      headline: 'The page changed.',
      detail: ''
    });
    // A box that published the event before it carried a payload still has something to say.
    expect(agentNotice(notice(undefined))?.headline).toBe('The page changed.');
    expect(agentNotice(event(1, 'assistant_message', { markdown: 'Done' }))).toBeUndefined();
  });

  it('stands in the conversation rather than inside the collapsed activity log', () => {
    const nodes = buildConversation(
      [
        event(1, 'user_message', { markdown: 'Watch this page' }),
        notice({ headline: 'The page changed.' })
      ],
      'completed'
    );
    const told = nodes.filter((node) => node.kind === 'told');
    expect(told).toHaveLength(1);
    expect(told[0]?.kind === 'told' && told[0].notice.headline).toBe('The page changed.');
    expect(nodes.some((node) => node.kind === 'activity')).toBe(false);
  });

  it('is exported with the conversation, because it is something athanor said', () => {
    const markdown = conversationMarkdown('Seat watch', [
      event(1, 'user_message', { markdown: 'Tell me when it drops' }),
      notice({ headline: 'Price drop', detail: 'The seat is now £84.' })
    ]);
    expect(markdown).toContain('Price drop');
    expect(markdown).toContain('The seat is now £84.');
  });
});

describe('how long a preview lasts', () => {
  it('says the deadline is an idle one rather than a countdown', () => {
    expect(previewLifetime('2026-09-03T10:00:00.000Z')).toBe(
      `closes if unused by ${new Date('2026-09-03T10:00:00.000Z').toLocaleDateString()}`
    );
  });

  it('says a link with no deadline has none', () => {
    expect(previewLifetime(null)).toBe('stays available');
    expect(previewLifetime(undefined)).toBe('stays available');
    expect(previewLifetime('not a date')).toBe('stays available');
  });
});

describe('an approval and the answer it got', () => {
  /*
   * The request was conversational and the decision was not, so the transcript kept the question in
   * plain sight and filed the answer inside a collapsed activity group. Scrolling back to check
   * whether you had said yes told you only that something was waiting for you.
   */
  it('keeps the decision in the transcript beside the request', () => {
    const nodes = buildConversation(
      [
        event(1, 'approval_requested', { approvalId: 'a1', sideEffect: 'writes a file' }),
        event(2, 'approval_resolved', { approvalId: 'a1', decision: 'approved' })
      ],
      'running'
    );
    // Nothing was filed away into a collapsed group, and both rows are in the transcript in order.
    expect(nodes.some((node) => node.kind === 'activity')).toBe(false);
    const shown = nodes.flatMap((node) => ('event' in node ? [node.event.kind] : []));
    expect(shown).toEqual(['approval_requested', 'approval_resolved']);
  });

  it('keeps a request nobody answered on its own', () => {
    const nodes = buildConversation([event(1, 'approval_requested', { approvalId: 'a1' })], 'running');
    const shown = nodes.flatMap((node) => ('event' in node ? [node.event.kind] : []));
    expect(shown).toEqual(['approval_requested']);
  });
});
