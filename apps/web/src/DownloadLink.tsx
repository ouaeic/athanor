/**
 * A Download control that cannot be pressed into nothing.
 *
 * Five places in this client built a raw `<a download>` and three of them are still the right thing
 * in a browser — which is why this stays an anchor rather than becoming a button. In a browser
 * nothing here runs at all: no handler is attached, the middle click and the context menu behave
 * exactly as they always did, and the file arrives.
 *
 * On a packaged client it is a different control. wry registers no download handler on Android and
 * iOS has no user-visible Downloads directory, so the shell answers `downloads: false` and an
 * anchor click is discarded by WKWebView and WebKitGTK with no file, no error and no message. The
 * press was silence. Here the press asks the shell, and where the shell says no the link is
 * replaced in place by the sentence saying so — replaced rather than annotated, because a control
 * that has just been proved inert should stop inviting a second press.
 *
 * Its own file, not a helper inside either caller: `Timeline.tsx` and `AttachmentTray.tsx` are both
 * on the eager graph, and one copy of this is cheaper than two — and the sentence the owner reads
 * when a download is impossible should not be able to differ between two screens showing the same
 * file.
 */
import { useState, type ReactNode } from 'react';
import { DOWNLOAD_UNAVAILABLE_FILE, nativeBridge } from './native.js';

export function DownloadLink({
  href,
  name,
  className,
  children
}: {
  href: string;
  name: string;
  className?: string;
  children: ReactNode;
}) {
  const [refused, setRefused] = useState(false);
  if (refused)
    return (
      <small className="download-refused" role="alert">
        {DOWNLOAD_UNAVAILABLE_FILE}
      </small>
    );
  return (
    <a
      href={href}
      download={name}
      {...(className === undefined ? {} : { className })}
      onClick={(event) => {
        // A browser is left entirely alone: this is the anchor it has always been, and the default
        // action is what downloads the file.
        if (!nativeBridge.available()) return;
        event.preventDefault();
        void nativeBridge.saveFromUrl(name, href).then((saved) => {
          if (!saved) setRefused(true);
        });
      }}
    >
      {children}
    </a>
  );
}
