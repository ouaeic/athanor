import { expect, it, vi } from 'vitest';
import { subscribeWorkerNavigation } from './worker-navigation.js';

it('opens notification destinations through app state and detaches its listener', () => {
  const target = new EventTarget();
  const open = vi.fn();
  const refresh = vi.fn();
  const stop = subscribeWorkerNavigation(target, 'https://owner.test', open, refresh);
  const id = '11111111-2222-4333-8444-555555555555';
  target.dispatchEvent(
    new MessageEvent('message', { data: { type: 'navigate-task', url: `/?task=${id}` } })
  );
  expect(open).toHaveBeenLastCalledWith(id);
  target.dispatchEvent(new MessageEvent('message', { data: { type: 'navigate-task', url: '/' } }));
  expect(open).toHaveBeenLastCalledWith(null);
  target.dispatchEvent(
    new MessageEvent('message', { data: { type: 'approval-resolved', approvalId: id } })
  );
  expect(refresh).toHaveBeenCalledTimes(3);
  stop();
  target.dispatchEvent(new MessageEvent('message', { data: { type: 'navigate-task', url: '/' } }));
  expect(open).toHaveBeenCalledTimes(2);
});

it('rejects foreign, malformed and unrelated notification messages', () => {
  const target = new EventTarget();
  const open = vi.fn();
  const refresh = vi.fn();
  const stop = subscribeWorkerNavigation(target, 'https://owner.test', open, refresh);
  const messages = [
    null,
    { type: 'unknown', url: '/' },
    { type: 'approval-resolved', approvalId: 'bad' },
    ...[
      'https://other.test/',
      '/v1/tasks',
      '/?view=settings',
      '/?task=bad',
      '/#secret',
      'javascript:alert(1)',
      '/?task=11111111-2222-4333-8444-555555555555&task=11111111-2222-4333-8444-555555555555'
    ].map((url) => ({ type: 'navigate-task', url }))
  ];
  expect(messages.length).toBeGreaterThan(0);
  for (const data of messages) target.dispatchEvent(new MessageEvent('message', { data }));
  expect(open).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  stop();
});
