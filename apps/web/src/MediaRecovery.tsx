import { useState } from 'react';
import { Button, Field } from './ui';

export default function MediaRecovery({
  asset = false,
  providerId = '',
  batchReceipt,
  busy,
  onReconcile
}: {
  asset?: boolean;
  batchReceipt?: 'input_file' | 'batch';
  providerId?: string;
  busy: boolean;
  onReconcile: (id: string, cost?: number) => Promise<void>;
}) {
  const [id, setId] = useState<string | null>(null);
  const [cost, setCost] = useState('');
  return (
    <details className="garden-media-recovery">
      <summary>
        {asset
          ? 'Record provider receipt'
          : batchReceipt
            ? 'Recover an uncertain batch'
            : 'Recover an uncertain submission'}
      </summary>
      <p className="muted">
        {batchReceipt === 'input_file'
          ? 'If the shot-list upload succeeded, enter its file ID. garden will use this existing upload to submit the already approved batch once.'
          : batchReceipt === 'batch'
            ? 'Enter the accepted provider batch ID to recover its existing results. This does not submit another batch.'
            : asset
              ? 'Use the character ID and final charge from your provider receipt to resolve the reserved amount.'
              : 'If the provider accepted this video, enter its job ID to resume delivery. This checks the existing job; it does not submit or charge for another video.'}
      </p>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void onReconcile((id ?? providerId).trim(), asset ? Number(cost) : undefined);
        }}
      >
        <Field
          label={
            asset
              ? 'Provider character ID'
              : batchReceipt === 'input_file'
                ? 'Provider input file ID'
                : batchReceipt === 'batch'
                  ? 'Provider batch ID'
                  : 'Provider video ID'
          }
        >
          <input
            required
            value={id ?? providerId}
            onChange={(event) => setId(event.target.value)}
            maxLength={256}
            pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*"
            autoComplete="off"
          />
        </Field>
        {asset && (
          <Field label="Final provider charge (USD)">
            <input
              required
              type="number"
              min={0}
              max={10000}
              step="any"
              value={cost}
              onChange={(event) => setCost(event.target.value)}
            />
          </Field>
        )}
        <Button type="submit" busy={busy}>
          {asset ? 'Record receipt' : batchReceipt ? 'Recover batch' : 'Recover video'}
        </Button>
      </form>
    </details>
  );
}
