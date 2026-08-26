import { describe, expect, it } from 'vitest';
import { MAX_PLAN_STEPS, planStepsFromArguments } from './values.js';

describe('plan steps reported by the model', () => {
  it('records the status the model reports instead of forcing every step to pending', () => {
    expect(
      planStepsFromArguments([
        { title: 'Read the failing test', status: 'completed' },
        { title: 'Fix the parser', status: 'in_progress' },
        { title: 'Re-run the suite' }
      ]).map((step) => step.status)
    ).toEqual(['completed', 'in_progress', 'pending']);
  });

  it('still accepts a plain list of titles', () => {
    expect(planStepsFromArguments(['One', 'Two'])).toMatchObject([
      { title: 'One', status: 'pending' },
      { title: 'Two', status: 'pending' }
    ]);
  });

  it('keeps step identity and progress when a later version re-sends the same title', () => {
    const first = planStepsFromArguments([{ title: 'Read the failing test', status: 'completed' }]);
    const second = planStepsFromArguments(['Read the failing test', 'Fix the parser'], first);
    expect(second[0]).toEqual(first[0]);
    expect(second[1]?.status).toBe('pending');
  });

  it('lets the model reopen a step explicitly', () => {
    const first = planStepsFromArguments([{ title: 'Fix the parser', status: 'completed' }]);
    expect(
      planStepsFromArguments([{ title: 'Fix the parser', status: 'pending' }], first)[0]?.status
    ).toBe('pending');
  });

  it('degrades an unrecognised status rather than failing the call', () => {
    expect(planStepsFromArguments([{ title: 'Ship it', status: 'done' }])[0]?.status).toBe(
      'pending'
    );
  });

  it('gives repeated titles distinct ids', () => {
    const steps = planStepsFromArguments(['Review', 'Review']);
    expect(steps[0]?.id).not.toBe(steps[1]?.id);
  });

  it('drops empty entries and caps the plan length', () => {
    expect(planStepsFromArguments(['', '   ', 'Real step'])).toHaveLength(1);
    expect(
      planStepsFromArguments(Array.from({ length: 40 }, (_, index) => `Step ${index}`))
    ).toHaveLength(MAX_PLAN_STEPS);
  });
});
