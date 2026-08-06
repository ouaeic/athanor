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
      {/*
        Named here rather than discovered afterwards. Most servers arrive with a usable name and
        need nothing, but the ones that do not used to finish installing, refuse to make a passkey
        because the standard binds one to a domain and not to an address, and send the owner back
        for a second SSH session — which is the one thing this command exists to avoid.
      */}
      <p className="server-install-footnote">
        Use a fresh supported Ubuntu or Debian server. The installer prints a QR code and one-time
        connection ticket for your client.
      </p>
      <p className="server-install-footnote">
        Most servers already have a usable hostname. If yours does not, point a domain at its
        address first and add <code>ATHANOR_HOSTNAME=your.domain</code> to the command — signing in
        from a browser needs a domain name, because a passkey cannot be bound to an address.
      </p>
    </Dialog>
  );
}
