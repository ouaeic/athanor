import { createHmac, timingSafeEqual } from 'node:crypto';

export interface CapabilityTokenClaims {
  sub: string;
  workspaceId: string;
  role: 'control' | 'agent' | 'user';
  scopes: string[];
  /**
   * The one request this token was minted for, as `METHOD /path`. It answers replay - a token
   * observed on a file read cannot be turned against `exec` - which is a different question from
   * forgery, since anyone holding the signing secret can mint whatever they like regardless.
   * Optional because not every signer sets it yet; a token that carries one is refused against any
   * other request, and a token that carries none is exactly as powerful as its scopes say.
   */
  aud?: string;
  iat: number;
  exp: number;
  nonce: string;
}

/**
 * No legitimate holder needs a capability for longer than a stream setup takes, and the longest any
 * signer in this repository asks for is two minutes. Capping the lifetime in the verifier - rather
 * than trusting each signer to pass a small number - is what keeps a leaked signing secret from
 * minting a token that outlives the leak.
 */
export const MAX_CAPABILITY_TTL_SECONDS = 900;

/** A token stamped in the future would otherwise buy itself extra life against the cap above. */
const MAX_CLOCK_SKEW_SECONDS = 60;

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

const signature = (input: string, secret: string): Buffer =>
  createHmac('sha256', secret).update(input).digest();

/**
 * The audience is the method and the path without its query string. The query carries the
 * arguments of a call, not its identity - `?path=a` and `?path=b` are the same capability - and
 * including it would only make every token unreusable in ways the scope set already covers.
 */
export const capabilityAudience = (method: string, path: string): string =>
  `${method.toUpperCase()} ${path.split('?')[0]}`;

export const signCapabilityToken = (
  claims: Omit<CapabilityTokenClaims, 'iat' | 'exp'>,
  secret: string,
  ttlSeconds = 60
): string => {
  if (secret.length < 32) throw new Error('Runner shared secret must be at least 32 characters');
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_CAPABILITY_TTL_SECONDS)
    throw new Error(`Capability lifetime must be 1-${MAX_CAPABILITY_TTL_SECONDS} seconds`);
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'HS256', typ: 'OCAP', v: 1 });
  const payload = encode({ ...claims, iat: now, exp: now + ttlSeconds });
  const input = `${header}.${payload}`;
  return `${input}.${signature(input, secret).toString('base64url')}`;
};

export interface CapabilityExpectation {
  method: string;
  path: string;
}

export const verifyCapabilityToken = (
  token: string,
  secret: string,
  expected?: CapabilityExpectation
): CapabilityTokenClaims => {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed capability token');
  const [header, payload, encodedSignature] = parts as [string, string, string];
  const expectedSignature = signature(`${header}.${payload}`, secret);
  const actual = Buffer.from(encodedSignature, 'base64url');
  if (actual.length !== expectedSignature.length || !timingSafeEqual(actual, expectedSignature)) {
    throw new Error('Invalid capability token signature');
  }
  const claims = JSON.parse(
    Buffer.from(payload, 'base64url').toString('utf8')
  ) as CapabilityTokenClaims;
  if (!claims.workspaceId || !claims.sub || !Array.isArray(claims.scopes)) {
    throw new Error('Invalid capability claims');
  }
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(claims.iat) || !Number.isFinite(claims.exp))
    throw new Error('Invalid capability lifetime');
  if (claims.iat > now + MAX_CLOCK_SKEW_SECONDS)
    throw new Error('Capability token is not yet valid');
  if (claims.exp - claims.iat > MAX_CAPABILITY_TTL_SECONDS)
    throw new Error('Capability lifetime exceeds the maximum');
  if (claims.exp <= now) throw new Error('Capability token expired');
  if (expected && claims.aud !== undefined) {
    if (claims.aud !== capabilityAudience(expected.method, expected.path))
      throw new Error('Capability token was minted for a different request');
  }
  return claims;
};

export const requireCapability = (claims: CapabilityTokenClaims, scope: string): void => {
  if (!claims.scopes.includes(scope)) {
    throw new Error(`Capability ${scope} is required`);
  }
};

export const deriveCapabilityNonce = (parentNonce: string, secret: string): string => {
  if (!parentNonce) throw new Error('Parent capability nonce is required');
  if (secret.length < 32) throw new Error('Runner shared secret must be at least 32 characters');
  return createHmac('sha256', secret)
    .update(`athanor-derived-capability:${parentNonce}`)
    .digest('base64url');
};
