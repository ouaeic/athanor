export const deliveryFilePath = (value: unknown): string | null => {
  const given = typeof value === 'string' ? value.trim() : '';
  if (
    !given ||
    given.length > 1_024 ||
    // eslint-disable-next-line no-control-regex -- Reject ASCII controls in a workspace delivery path.
    /[\u0000-\u001f\\?#]/.test(given) ||
    given.startsWith('/') ||
    /^[a-z][a-z0-9+.-]*:/i.test(given) ||
    given.split('/').some((part) => !part || part === '.' || part === '..')
  )
    return null;
  return given.startsWith('workspace/') ? given : `workspace/${given}`;
};
