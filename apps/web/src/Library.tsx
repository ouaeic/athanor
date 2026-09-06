import { useState } from 'react';
import type { Workspace } from '@athanor/contracts';
import { ResultsLibrary } from './library/Results.js';
import { MemoryLibrary } from './library/Memory.js';
import { SkillsLibrary } from './library/Skills.js';
import { ConnectionsLibrary } from './library/Connections.js';
import { WatchesLibrary } from './library/Watches.js';
import './settings.css';
import './library.css';

export interface LibraryProps {
  workspace: Workspace | null;
  onOpenTask: (id: string) => void;
  onChange: () => void;
  onTaskDeleted: (id: string) => void;
}
const sections = ['Results', 'Memory', 'Skills', 'Connections', 'Watches'] as const;
export function Library({ workspace, onOpenTask, onChange, onTaskDeleted }: LibraryProps) {
  const [section, setSection] = useState<(typeof sections)[number]>('Results');
  return (
    <div className="management-page library-page">
      <header className="management-heading">
        <p className="eyebrow">A place for what lasts</p>
        <h1>Library</h1>
        <p className="muted">Useful work, remembered context and things set in motion.</p>
      </header>
      <nav className="management-tabs" aria-label="Library sections">
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
      <div className="management-content" key={`${section}:${workspace?.id ?? ''}`}>
        {section === 'Results' && (
          <ResultsLibrary
            workspace={workspace}
            onOpenTask={onOpenTask}
            onChange={onChange}
            onTaskDeleted={onTaskDeleted}
          />
        )}
        {section === 'Memory' && <MemoryLibrary workspace={workspace} onOpenTask={onOpenTask} />}
        {section === 'Skills' && <SkillsLibrary workspace={workspace} />}
        {section === 'Connections' && <ConnectionsLibrary onChange={onChange} />}
        {section === 'Watches' && (
          <WatchesLibrary workspace={workspace} onOpenTask={onOpenTask} onChange={onChange} />
        )}
      </div>
    </div>
  );
}
export default Library;
