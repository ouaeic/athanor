import { useState } from 'react';
import type { Workspace } from '@athanor/contracts';
import { ProviderSettings } from './settings/Providers.js';
import { SpendingSettings } from './settings/Spending.js';
import { ComputerSettings } from './settings/Computer.js';
import { NotificationSettings } from './settings/Notifications.js';
import { AccessSettings } from './settings/Access.js';
import { InstanceSettings } from './settings/Instance.js';
import './settings.css';

export interface SettingsProps {
  workspace: Workspace | null;
  onChange: () => void;
}
const sections = ['Models', 'Spending', 'Computer', 'Notifications', 'Access', 'Instance'] as const;
export function Settings({ workspace, onChange }: SettingsProps) {
  const [section, setSection] = useState<(typeof sections)[number]>('Models');
  return (
    <div className="management-page">
      <header className="management-heading">
        <p className="eyebrow">Make it yours</p>
        <h1>Settings</h1>
        <p className="muted">Your models, your computer, your decisions.</p>
      </header>
      <nav className="management-tabs" aria-label="Settings sections">
        {sections.map((item) => (
          <button
            type="button"
            key={item}
            aria-current={section === item ? 'page' : undefined}
            onClick={() => setSection(item)}
          >
            {item}
          </button>
        ))}
      </nav>
      <div className="management-content" key={section}>
        {section === 'Models' && <ProviderSettings onChange={onChange} />}
        {section === 'Spending' && <SpendingSettings onChange={onChange} />}
        {section === 'Computer' && <ComputerSettings workspace={workspace} onChange={onChange} />}
        {section === 'Notifications' && <NotificationSettings />}
        {section === 'Access' && <AccessSettings onChange={onChange} />}
        {section === 'Instance' && <InstanceSettings />}
      </div>
    </div>
  );
}
export default Settings;
