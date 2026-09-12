import { useState } from 'react';
import { keepsDeviceDrafts, setKeepsDeviceDrafts } from '../draft-storage';
import { Section, ConfirmButton, useAction, ActionFeedback } from '../management';
import { Button } from '../ui';
export function DeviceDraftSettings() {
  const [enabled, setEnabled] = useState(keepsDeviceDrafts);
  const action = useAction();
  async function change(value: boolean) {
    await setKeepsDeviceDrafts(value);
    setEnabled(value);
  }
  return (
    <Section title="Draft recovery on this device">
      <p>
        Drafts sync to your server. Encrypted device recovery also keeps unsynced edits through a
        closed tab or interrupted connection.
      </p>
      <p className="muted">
        Recovery requires this signed-in session to reconnect. Signing out or revoking the session
        ends access to its unsynced drafts. Drafts are never sent as tasks automatically.
      </p>
      {enabled ? (
        <ConfirmButton
          label="Turn off device recovery"
          description="Remove unsynced drafts stored on this device and stop keeping offline copies. Synced server drafts remain available."
          action={() => change(false)}
        />
      ) : (
        <Button
          disabled={action.busy}
          onClick={() => void action.run(() => change(true), 'Device recovery enabled')}
        >
          Keep encrypted drafts on this device
        </Button>
      )}
      <ActionFeedback action={action} />
    </Section>
  );
}
