import { useState } from 'react';
import type { SettingsPage } from '../SelfHostedSettings.js';

/**
 * What is open over the workbench.
 *
 * Five independent cells, and the only rule between them is that none of them is on screen when the
 * app opens — which is why the first paint carries none of the code behind them. They are gathered
 * here because "is anything open?" is a question three other parts of this screen ask: the first
 * focus declines to steal the cursor from a dialog, the notification policy is re-read whenever
 * Settings has been open, and the palette lists the two of these that have entry points.
 */
export const useOverlays = () => {
  const [settingsPage, setSettingsPage] = useState<SettingsPage>();
  const [schedules, setSchedules] = useState(false);
  const [noticeLog, setNoticeLog] = useState(false);
  const [shortcutSheet, setShortcutSheet] = useState(false);
  const [palette, setPalette] = useState(false);
  const openSettings = (page: SettingsPage = 'ai') => setSettingsPage(page);
  return {
    settingsPage,
    setSettingsPage,
    openSettings,
    schedules,
    setSchedules,
    noticeLog,
    setNoticeLog,
    shortcutSheet,
    setShortcutSheet,
    palette,
    setPalette
  };
};
