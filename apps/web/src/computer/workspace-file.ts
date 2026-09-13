import { apiUrl, request, responseError } from '../client';
import { decodeEditableText } from './format';

export interface WorkspaceTextFile {
  path: string;
  text: string;
  original: string;
  sha: string | null;
  truncated: boolean;
  next: number | null;
  start: number;
  end: number | null;
  binary: boolean;
}

export async function readWorkspaceFile(
  workspaceId: string,
  path: string,
  options: { start?: number; windowed?: boolean; signal?: AbortSignal } = {}
): Promise<WorkspaceTextFile> {
  const start = options.start ?? 1;
  const query = new URLSearchParams({
    path,
    ...(options.windowed ? { startLine: String(start), maxBytes: '262144' } : {})
  });
  const response = await fetch(apiUrl(`/v1/workspaces/${workspaceId}/file?${query}`), {
    credentials: 'include',
    signal: AbortSignal.any([
      AbortSignal.timeout(20_000),
      ...(options.signal ? [options.signal] : [])
    ])
  });
  if (!response.ok) throw await responseError(response);
  const decoded = decodeEditableText(new Uint8Array(await response.arrayBuffer()));
  const line = (header: string): number | null => {
    const value = response.headers.get(header);
    const number = value === null ? NaN : Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  };
  return {
    path,
    text: decoded ?? '',
    original: decoded ?? '',
    sha: response.headers.get('x-content-sha256'),
    truncated: response.headers.get('x-truncated') === 'true' || start > 1,
    next: line('x-next-start-line'),
    start,
    end: line('x-end-line'),
    binary: decoded === null
  };
}

export async function saveWorkspaceFile(
  workspaceId: string,
  file: WorkspaceTextFile
): Promise<void> {
  if (!file.sha || file.truncated || file.binary)
    throw new Error('Only a complete text file can be edited. Download this file to work with it.');
  await request(
    `/v1/workspaces/${workspaceId}/file?${new URLSearchParams({ path: file.path, expectSha256: file.sha })}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new TextEncoder().encode(file.text)
    }
  );
}
