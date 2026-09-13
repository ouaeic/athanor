export interface DirectoryEntry {
  name: string;
  path: string;
  type: 'directory' | 'file' | 'symlink' | 'special';
  sizeBytes: number;
  modifiedAt: string;
}

export interface DirectoryPage {
  path: string;
  entries: DirectoryEntry[];
  nextCursor: string | null;
}

export interface ProjectDirectory {
  workspaceId: string;
  name: string;
  path: string;
  current: boolean;
}
