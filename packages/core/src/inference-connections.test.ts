import { describe, expect, it } from 'vitest';
import { encryptJson, inferenceCredentialAad } from './crypto.js';
import {
  environmentInferenceSecret,
  modelConnectionId,
  readInferenceConnections,
  type InferenceConnectionSecret
} from './inference-connections.js';

const masterKey = Buffer.alloc(32, 4),
  userId = 'owner';
const environment = {
  AI_PROVIDER: 'openrouter' as const,
  AI_BASE_URL: 'https://openrouter.example/v1',
  AI_REQUIRE_ZDR: true,
  OPENROUTER_BASE_URL: 'https://openrouter.example/v1',
  OPENROUTER_API_KEY: 'environment-key'
};
const secret = (provider: InferenceConnectionSecret['provider'], apiKey: string) => ({
  provider,
  apiKey,
  baseUrl: `https://${provider}.example/v1`,
  enforceZeroDataRetention: true
});
const row = (provider: string, value: object, owner = userId) => ({
  provider,
  status: 'active',
  secretCiphertext: encryptJson(
    value,
    masterKey,
    provider === 'openrouter' ? undefined : inferenceCredentialAad(owner)
  )
});
const read = (rows: ReturnType<typeof row>[]) =>
  readInferenceConnections({ rows, userId, masterKey, environment });

describe('inference connection identity', () => {
  it('keeps independent named endpoints and rejects a credential swapped between their rows', () => {
    const first = 'openai-compatible:10000000-0000-4000-8000-000000000001';
    const second = 'openai-compatible:10000000-0000-4000-8000-000000000002';
    const firstSecret = {
      ...secret('openai-compatible', 'first-key'),
      connectionId: first,
      label: 'Work'
    };
    const secondSecret = {
      ...secret('openai-compatible', 'second-key'),
      connectionId: second,
      label: 'Research'
    };
    const rows = [row(`inference:${first}`, firstSecret), row(`inference:${second}`, secondSecret)];
    const connections = read(rows);
    expect([...connections.keys()]).toEqual([first, second]);
    expect(connections.get(first)?.secret.apiKey).toBe('first-key');
    expect(connections.get(second)?.secret.apiKey).toBe('second-key');
    const swapped = read([{ ...rows[0]!, secretCiphertext: rows[1]!.secretCiphertext }, rows[1]!]);
    expect([...swapped.keys()]).toEqual([second]);
    expect(
      modelConnectionId(
        { provider: 'custom', connectionId: first, recommendationTags: [] },
        swapped.keys()
      )
    ).toBeNull();
  });

  it('keeps the newest vendor credential and independent vendors', () => {
    const connections = read([
      row('inference:openrouter', secret('openrouter', 'new-key')),
      row('inference:ollama-cloud', secret('ollama-cloud', 'ollama-key')),
      row('inference', secret('openrouter', 'old-key')),
      row('openrouter', { apiKey: 'oldest-key' })
    ]);
    expect([...connections.keys()]).toEqual(['openrouter', 'ollama-cloud']);
    expect(connections.get('openrouter')?.secret.apiKey).toBe('new-key');
  });

  it('never substitutes an old or environment key for an unreadable saved connection', () => {
    expect(
      read([
        row('inference:openrouter', secret('openrouter', 'foreign-key'), 'another-owner'),
        row('inference', secret('openrouter', 'stale-key'))
      ]).size
    ).toBe(0);
    expect(
      read([row('inference', secret('openrouter', 'foreign-key'), 'another-owner')]).size
    ).toBe(0);
  });

  it('keeps an independent connection when another cannot be opened', () => {
    const connections = read([
      row('inference:openrouter', secret('openrouter', 'foreign-key'), 'another-owner'),
      row('inference:ollama-cloud', secret('ollama-cloud', 'valid-key'))
    ]);
    expect([...connections.keys()]).toEqual(['ollama-cloud']);
  });

  it('refuses a credential whose vendor disagrees with its storage key', () => {
    expect(read([row('inference:ollama-cloud', secret('openrouter', 'misplaced-key'))]).size).toBe(
      0
    );
  });

  it('uses an environment credential only when there is no active saved connection', () => {
    expect(read([]).get('openrouter')).toMatchObject({
      source: 'server_environment',
      secret: { apiKey: 'environment-key' }
    });
    const configured = environmentInferenceSecret({
      ...environment,
      AI_PROVIDER: 'openai-compatible',
      AI_DEFAULT_MODEL: 'served'
    });
    expect(configured.apiKey).toBeUndefined();
  });

  it('routes explicit identities and source-tagged legacy models without guessing', () => {
    const ids = ['openrouter', 'ollama-cloud', 'openai-compatible'];
    const model = { provider: 'custom', recommendationTags: ['Configured endpoint'] };
    expect(modelConnectionId(model, ids)).toBe('openai-compatible');
    expect(modelConnectionId({ ...model, recommendationTags: ['Ollama Cloud'] }, ids)).toBe(
      'ollama-cloud'
    );
    expect(modelConnectionId({ ...model, connectionId: 'removed-account' }, ids)).toBeNull();
    expect(modelConnectionId({ ...model, connectionId: 'ollama-cloud' }, ids)).toBe('ollama-cloud');
    expect(modelConnectionId({ ...model, recommendationTags: [] }, ids)).toBeNull();
    expect(
      modelConnectionId({ ...model, recommendationTags: [] }, ['openrouter', 'ollama-cloud'])
    ).toBe('ollama-cloud');
    expect(modelConnectionId(model, ['ollama-cloud'])).toBeNull();
  });
});
