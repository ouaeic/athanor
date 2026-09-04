import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ShareViewer } from './ShareViewer.js';
import { parseShareFragment, parseShareToken } from './share-crypto.js';
import './share.css';

/**
 * The share viewer's entry. The first thing it does is take the key out of the address bar.
 *
 * The fragment is never sent to a server, but it is written into history and into a bookmark, and
 * it is what a screenshot of the address bar would show. Read once, then replaced with the bare
 * path, so the key lives in this page's memory and nowhere the browser keeps.
 */
const fragment = window.location.hash;
if (fragment) window.history.replaceState(null, '', window.location.pathname);

const token = parseShareToken(window.location.pathname);
const fragmentKey = parseShareFragment(fragment);
const localhost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(window.location.hostname);
const insecure = window.location.protocol === 'http:' && !localhost;

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ShareViewer token={token} fragmentKey={fragmentKey} insecure={insecure} />
    </StrictMode>
  );
}
