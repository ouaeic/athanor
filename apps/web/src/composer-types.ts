import type { ReactNode } from 'react';
import type { Task, Workspace } from '@athanor/contracts';
import type { Bootstrap, Draft } from './model';

export interface ComposerProps {
  workspace: Workspace;
  task?: Task | null;
  bootstrap: Bootstrap;
  initialDraft?: Draft;
  scope?: string;
  /** Extra trigger docked at the right of the attach/voice toolbar (shape selection lives there). */
  toolbarExtra?: ReactNode;
  onSent: (task: Task) => void;
  onDraft: (draft: Draft) => void;
}
