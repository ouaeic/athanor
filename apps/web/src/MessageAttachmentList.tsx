export default function MessageAttachmentList({
  workspaceId,
  paths
}: {
  workspaceId: string;
  paths: unknown;
}) {
  const files = Array.isArray(paths)
    ? paths
        .filter((path): path is string => typeof path === 'string' && path.length > 0)
        .slice(0, 20)
    : [];
  if (!files.length) return null;
  return (
    <ul className="message-attachment-list" aria-label="Attached files">
      {files.map((path, index) => (
        <li key={`${index}:${path}`}>
          <a
            href={`/v1/workspaces/${workspaceId}/download?path=${encodeURIComponent(path)}`}
            download={path.split('/').at(-1)}
            title={path}
          >
            <span>{path.split('/').at(-1)}</span>
            <small>Download attachment</small>
          </a>
        </li>
      ))}
    </ul>
  );
}
