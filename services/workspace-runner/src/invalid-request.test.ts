import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { sayWhatIsWrong } from './server.js';

const failureOf = (schema: z.ZodType, value: unknown): z.ZodError => {
  const result = schema.safeParse(value);
  if (result.success) throw new Error('expected this to fail');
  return result.error;
};

describe('what the owner is told when a request does not fit its schema', () => {
  /**
   * The real one. A model called `shell` with `args` as a string, and what reached the conversation
   * was Zod's own message - the issue array pretty-printed as JSON, brackets and all - rendered as
   * chat text. `ZodError.message` is a getter that does exactly that, and it was being forwarded
   * verbatim from the runner to the worker to the task event to the screen.
   */
  it('says which field and what was wrong, without the JSON', () => {
    const schema = z.object({ executable: z.string(), args: z.array(z.string()).max(256) });
    const message = sayWhatIsWrong(failureOf(schema, { executable: 'df', args: '-h /home' }));

    expect(message).toBe('Invalid request - args: invalid input: expected array, received string');
    // The shape of the old failure, in the two ways it showed itself on screen.
    expect(message).not.toContain('[');
    expect(message).not.toContain('"code"');
    expect(message.split('\n')).toHaveLength(1);
  });

  it('names the field even when it is nested', () => {
    const schema = z.object({ guards: z.object({ timeoutSeconds: z.number() }) });
    expect(sayWhatIsWrong(failureOf(schema, { guards: { timeoutSeconds: 'soon' } }))).toContain(
      'guards.timeoutSeconds:'
    );
  });

  it('calls it the body when the failure is not about a field', () => {
    expect(sayWhatIsWrong(failureOf(z.object({ a: z.string() }), 'not an object'))).toContain(
      'body:'
    );
  });

  it('keeps a badly wrong request to a few issues and counts the rest', () => {
    const schema = z.object({
      a: z.string(),
      b: z.string(),
      c: z.string(),
      d: z.string(),
      e: z.string()
    });
    const message = sayWhatIsWrong(failureOf(schema, {}));
    expect(message).toContain('(and 2 more)');
    // Three named, not five, so one malformed body cannot fill the conversation.
    expect(message.split(';')).toHaveLength(3);
  });
});
