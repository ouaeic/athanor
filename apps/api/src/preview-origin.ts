import type { FastifyRequest } from 'fastify';

export const PREVIEW_OPAQUE_SANDBOX =
  'sandbox allow-scripts allow-forms allow-popups allow-downloads allow-modals';

/** The proxy must preserve the browser's Host, including its public TLS port. */
export const previewRequestOrigin = (request: FastifyRequest): string | null => {
  const forwardedProtocol = request.headers['x-forwarded-proto'];
  const protocol = forwardedProtocol ?? request.protocol;
  if ((protocol !== 'https' && protocol !== 'http') || !request.headers.host) return null;
  try {
    const url = new URL(`${protocol}://${request.headers.host}`);
    return !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
      ? url.origin
      : null;
  } catch {
    return null;
  }
};

export const previewOriginFor = (base: URL, slug: string | null): string => {
  if (base.pathname.replace(/\/+$/, '')) return base.origin;
  if (!slug) return base.origin;
  const url = new URL(base);
  url.hostname = `${slug}.${base.hostname}`;
  return url.origin;
};

export const previewScopeFor = (base: URL, slug: string): string => {
  const path = base.pathname.replace(/\/+$/, '');
  return path ? `${path}/${slug}/` : '/';
};
