import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
const root = document.getElementById('root');
if (!root) throw new Error('The application root is missing');
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}
