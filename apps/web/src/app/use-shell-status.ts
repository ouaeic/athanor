import { useState } from 'react';

/**
 * What the window is saying, and whether it is waiting.
 *
 * Three cells, one shelf. Only one thing may sit above the composer — `composerStrip` holds the
 * order — so an error and a status that do not know about each other are two claims on the same
 * space. `busy` is the other half of the same subject: it is what the send button, Stop and every
 * dialog read to know that a request this window made has not come back yet.
 */
export const useShellStatus = () => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  return { busy, setBusy, error, setError, notice, setNotice };
};
