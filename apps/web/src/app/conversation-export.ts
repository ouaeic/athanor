import { api } from '../api.js';
import { nativeBridge } from '../native.js';
import { conversationMarkdown } from '../timeline-state.js';
import type { Task, TaskEvent } from '../types.js';

/**
 * The whole conversation as text, which is the last mile of most sessions: the agent produced the
 * answer and getting it out used to mean clicking copy on every bubble in turn.
 */
export const exportConversation = (input: {
  task: Task | undefined;
  events: TaskEvent[];
  /** Whether the box holds more of this conversation than the transcript on screen. */
  windowed: boolean;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  mode: 'copy' | 'download';
}) => {
  const { task, events, windowed, onNotice, onError, mode } = input;
  if (!task) return;
  const id = task.id;
  const title = task.title;
  /*
   * The transcript on screen is a window onto the conversation now, and an export that quietly
   * stopped at the newest page would be the wrong document - this is the one place that promises
   * the whole of it. The route with no window is the whole trajectory; only a conversation that
   * is genuinely longer than what is loaded pays for the request, and if the box cannot be
   * reached the window is still better than nothing.
   */
  const wholeMarkdown = (
    windowed ? api.events(id, {}).catch(() => events) : Promise.resolve(events)
  ).then((all) => conversationMarkdown(title, all));
  if (mode === 'copy') {
    /*
     * A promise handed to the clipboard rather than awaited before writing to it. Safari ends the
     * user gesture at the first await and refuses the write, which would have turned "copy a long
     * conversation" into a permissions error; `ClipboardItem` exists to carry exactly this.
     */
    const written =
      typeof ClipboardItem === 'function'
        ? navigator.clipboard.write([new ClipboardItem({ 'text/plain': wholeMarkdown })])
        : wholeMarkdown.then((markdown) => navigator.clipboard.writeText(markdown));
    void written
      .then(() => onNotice('Conversation copied as Markdown.'))
      .catch(() => onError('This browser would not let athanor write to the clipboard.'));
    return;
  }
  void wholeMarkdown.then((markdown) => {
    const name = `${title.replace(/[^a-zA-Z0-9 _-]+/g, ' ').trim() || 'conversation'}.md`;
    // Through the bridge rather than straight onto an anchor. Six flows in the product are an
    // `<a download>` on a blob, and on a packaged shell that reports no download support - wry
    // registers none on Android, and iOS has no Downloads directory to write into - the click
    // does nothing at all and says nothing. There is a way out of this one, and it is two
    // millimetres away on the same menu.
    if (!nativeBridge.save(name, new Blob([markdown], { type: 'text/markdown' })))
      onError('This app cannot save files on this device. Copy the conversation instead.');
  });
};
