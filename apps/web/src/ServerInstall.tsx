import { useState } from 'react';
import { Check, Clipboard, Server, X } from 'lucide-react';
import { Dialog } from './Dialog.js';

const installCommand =
  'curl -fsSL https://raw.githubusercontent.com/ouaeic/athanor/v0.1.0/install.sh | sudo env ATHANOR_REF=v0.1.0 sh';

export function ServerInstall({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  return (
    <Dialog
      backdropClassName="modal-backdrop server-install-backdrop"
      className="modal server-install-modal"
      labelledBy="server-install-title"
      onClose={onClose}
    >
      <button className="modal-close" onClick={onClose} aria-label="Close server installation">
        <X />
      </button>
      <div className="server-install-heading">
        <span className="server-install-icon">
          <Server />
        </span>
        <div>
          <p className="eyebrow">New private computer</p>
          <h2 id="server-install-title">Install on a cloud server</h2>
        </div>
      </div>
      <p className="subtle">
        The installed Athanor app can connect over SSH without storing or relaying your SSH
        credentials. A browser cannot securely open a raw SSH connection, so run this fixed command
        in your server provider’s terminal:
      </p>
      <div className="install-command">
        <code>{installCommand}</code>
        <button
          className="icon-button"
          aria-label="Copy installation command"
          onClick={() => {
            void navigator.clipboard.writeText(installCommand);
            setCopied(true);
          }}
        >
          {copied ? <Check /> : <Clipboard />}
        </button>
      </div>
      <p className="server-install-footnote">
        Use a fresh supported Ubuntu or Debian server. The installer prints a QR code and one-time
        connection ticket for your client.
      </p>
    </Dialog>
  );
}
