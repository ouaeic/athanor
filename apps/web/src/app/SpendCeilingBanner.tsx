import { CircleDollarSign } from 'lucide-react';
import { formatUsd, type SpendCeilingAsk } from '../usage-model.js';

/**
 * What fills the shelf above the composer when nothing more urgent has claimed it.
 *
 * Every kind `composerStrip` ranks is about the message being typed or the box being unable to
 * carry it, and each of them is more urgent than this by construction - so this cannot be given a
 * rank without being given one it would sometimes win. It takes the empty shelf instead, which
 * puts it strictly below all seven and leaves that ordering the single place it is decided.
 *
 * It is one line and it goes for good the moment it is answered, in either direction. The
 * loudness is the figure in it and nothing else: four dollars and four hundred are the same
 * sentence with a different number in it, and the number is the part worth reading. Anything more
 * would be the software making a case about the owner's own money, which is not its to make.
 */
export function SpendCeilingBanner({
  ask,
  draft,
  busy,
  onDraft,
  onAnswer
}: {
  ask: SpendCeilingAsk;
  draft: string;
  busy: boolean;
  onDraft: (value: string) => void;
  onAnswer: (value: string) => void;
}) {
  return (
    <form
      className="spend-ceiling-ask"
      aria-label="Monthly spending ceiling"
      onSubmit={(event) => {
        event.preventDefault();
        onAnswer(draft);
      }}
    >
      <CircleDollarSign />
      <span>{formatUsd(ask.monthlyUsd)} spent this month, with no ceiling set.</span>
      <label>
        Stop at
        <input
          inputMode="decimal"
          aria-label="Monthly spending ceiling in dollars"
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
        />
        {/* The day cap that lands with it, named before it is installed rather than reported after.
            One number is typed and two are enforced, and the one that is not typed is the one that
            can refuse work tomorrow morning - so it is said here, where the press happens. */}
        a month, a quarter of it in a day
      </label>
      <button className="primary" type="submit" disabled={busy}>
        Set
      </button>
      {/* Declining is an answer, not a dismissal, and it is recorded as one - which is what stops
          this coming back tomorrow with a bigger number in it. */}
      <button type="button" disabled={busy} onClick={() => onAnswer('')}>
        No ceiling
      </button>
    </form>
  );
}
