import { useState } from 'react';
import type { MediaSettings, ModelRelease, OwnerPreferences } from '@athanor/contracts';
import { del, put } from '../client.js';
import { Button, Field } from '../ui.js';
import {
  ActionFeedback,
  ConfirmButton,
  ResourceState,
  Section,
  fieldValue,
  sensitive,
  useAction,
  useResource
} from '../management.js';
import { money } from '../model.js';
import { mediaRouteIsRetired, mediaRetirementDate } from '../media-state.js';
import AudioReceipts from '../AudioReceipts';

interface Provider {
  configured: boolean;
  source: string;
  provider: string;
  baseUrl: string;
  modelId: string | null;
  hasApiKey: boolean;
  enforceZeroDataRetention: boolean;
  contextTokens?: number;
  capabilities?: string[];
  modalities?: string[];
}
export function ProviderSettings({ onChange }: { onChange: () => void }) {
  const provider = useResource<Provider>('/v1/providers');
  const models = useResource<ModelRelease[]>('/v1/models');
  const media = useResource<MediaSettings>('/v1/media/models');
  const preferences = useResource<{ preferences: OwnerPreferences }>('/v1/account/preferences');
  const action = useAction(() => {
    provider.refresh();
    models.refresh();
    media.refresh();
    preferences.refresh();
    onChange();
  });
  const [choice, setChoice] = useState('');
  const [query, setQuery] = useState('');
  const [mediaSelections, setMediaSelections] = useState<Record<string, string>>({});
  const selected = choice || provider.value?.provider || 'openrouter';
  return (
    <>
      <AudioReceipts />
      <Section
        title="Model connection"
        description="Bring your own provider. Your computer uses your credentials directly."
      >
        <ResourceState resource={provider} />
        {provider.value && (
          <form
            className="stack"
            key={provider.value.source + provider.value.provider}
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const apiKey = fieldValue(form, 'apiKey');
              void action.run(
                () =>
                  sensitive(() =>
                    put('/v1/providers', {
                      provider: selected,
                      ...(apiKey ? { apiKey } : {}),
                      ...(selected === 'openai-compatible'
                        ? {
                            baseUrl: fieldValue(form, 'baseUrl'),
                            modelId: fieldValue(form, 'modelId'),
                            contextTokens: Number(form.get('contextTokens')),
                            capabilities: [
                              'chat',
                              'tools',
                              ...(form.has('vision') ? ['vision'] : []),
                              ...(form.has('reasoning') ? ['reasoning'] : [])
                            ],
                            modalities: ['text', ...(form.has('vision') ? ['image'] : [])]
                          }
                        : {}),
                      enforceZeroDataRetention: form.has('zdr')
                    })
                  ),
                'Connection verified and saved'
              );
            }}
          >
            <div className="management-note">
              {provider.value.configured
                ? `Connected through ${provider.value.source === 'server_environment' ? 'server configuration' : 'your saved settings'}. ${provider.value.hasApiKey ? 'A key is securely stored.' : 'This endpoint uses no saved key.'}`
                : 'Connect a provider to begin work.'}
            </div>
            <div className="management-grid">
              <Field label="Provider">
                <select value={selected} onChange={(event) => setChoice(event.target.value)}>
                  <option value="openrouter">OpenRouter</option>
                  <option value="ollama-cloud">Ollama Cloud</option>
                  <option value="openai-compatible">Compatible endpoint</option>
                </select>
              </Field>
              <Field label="API key" hint="Leave empty to keep an existing key for this provider.">
                <input
                  name="apiKey"
                  type="password"
                  autoComplete="new-password"
                  placeholder={provider.value.hasApiKey ? 'Stored securely' : 'Paste your key'}
                />
              </Field>
              {selected === 'openai-compatible' && (
                <>
                  <Field label="Endpoint URL">
                    <input
                      required
                      name="baseUrl"
                      type="url"
                      defaultValue={provider.value.baseUrl}
                      placeholder="https://provider.example/v1"
                    />
                  </Field>
                  <Field label="Model ID">
                    <input required name="modelId" defaultValue={provider.value.modelId ?? ''} />
                  </Field>
                  <Field label="Context window in tokens">
                    <input
                      name="contextTokens"
                      type="number"
                      min={4096}
                      max={10000000}
                      defaultValue={provider.value.contextTokens ?? 128000}
                      required
                    />
                  </Field>
                  <div className="stack">
                    <label className="management-check">
                      <input
                        name="vision"
                        type="checkbox"
                        defaultChecked={provider.value.capabilities?.includes('vision')}
                      />
                      Accepts images
                    </label>
                    <label className="management-check">
                      <input
                        name="reasoning"
                        type="checkbox"
                        defaultChecked={provider.value.capabilities?.includes('reasoning') ?? true}
                      />
                      Supports reasoning
                    </label>
                  </div>
                </>
              )}
            </div>
            <label className="management-check">
              <input
                name="zdr"
                type="checkbox"
                defaultChecked={provider.value.enforceZeroDataRetention}
              />
              <span>
                Require zero data retention
                <small className="muted">
                  Use only the provider route approved for this privacy choice.
                </small>
              </span>
            </label>
            <div className="row">
              <Button type="submit" className="primary" busy={action.busy}>
                Verify and save
              </Button>
              {provider.value.source === 'encrypted_database' && (
                <ConfirmButton
                  label="Remove saved connection"
                  description="Remove the saved provider credential. Tasks that need it will wait until a provider is configured again. Server environment settings, if present, still apply."
                  action={async () => {
                    await sensitive(() => del('/v1/providers'));
                    provider.refresh();
                    models.refresh();
                    onChange();
                  }}
                />
              )}
            </div>
            <ActionFeedback action={action} />
          </form>
        )}
      </Section>
      <Section
        title="Your model preference"
        description="Keep automatic selection or choose a particular model for your work."
      >
        <ResourceState resource={preferences} />
        {preferences.value && (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void action.run(() => {
                if (fieldValue(form, 'selection') === 'manual' && !fieldValue(form, 'modelId'))
                  throw new Error('Choose a model before saving manual selection.');
                return put('/v1/account/preferences', {
                  model: {
                    automatic: fieldValue(form, 'selection') === 'automatic',
                    preference: fieldValue(form, 'preference'),
                    modelId: fieldValue(form, 'modelId')
                  }
                });
              });
            }}
          >
            <div className="management-grid">
              <Field label="Selection">
                <select
                  name="selection"
                  defaultValue={
                    preferences.value.preferences.model?.automatic === false
                      ? 'manual'
                      : 'automatic'
                  }
                >
                  <option value="automatic">Automatic for the work</option>
                  <option value="manual">My chosen model</option>
                </select>
              </Field>
              <Field label="Automatic preference">
                <select
                  name="preference"
                  defaultValue={preferences.value.preferences.model?.preference ?? 'balanced'}
                >
                  <option value="balanced">Balanced</option>
                  <option value="fast">Faster</option>
                  <option value="best">Higher quality</option>
                </select>
              </Field>
              <Field label="Chosen model">
                <select
                  name="modelId"
                  defaultValue={preferences.value.preferences.model?.modelId ?? ''}
                >
                  <option value="">Choose a model</option>
                  {models.value?.map((model) => (
                    <option
                      key={model.id}
                      value={model.id}
                      disabled={model.availability !== 'available'}
                    >
                      {model.displayName}
                      {model.availability !== 'available' ? ` · ${model.availability}` : ''}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Button type="submit" busy={action.busy}>
              Save preference
            </Button>
            <ActionFeedback action={action} />
          </form>
        )}
      </Section>
      <Section
        title="Images, video, voice and transcription"
        description="Choose from the generation routes your provider makes available."
      >
        <ResourceState resource={media} />
        {media.value && (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void action.run(async () => {
                const choices = Object.fromEntries(
                  media
                    .value!.modalities.filter((item) => item.available)
                    .flatMap((item) => {
                      const modelId =
                        mediaSelections[item.modality] ??
                        (item.choice.automatic ? '' : item.choice.modelId);
                      const option = item.options.find((candidate) => candidate.id === modelId);
                      if (mediaRouteIsRetired(option) || option?.unavailableReason) {
                        if (!item.choice.automatic && modelId === item.choice.modelId) return [];
                        throw new Error(
                          option?.unavailableReason ??
                            'This generation route has retired. Choose an available model.'
                        );
                      }
                      return [
                        [
                          item.modality,
                          {
                            automatic: modelId === '',
                            preference: fieldValue(form, `${item.modality}-preference`),
                            modelId
                          }
                        ]
                      ];
                    })
                );
                await put('/v1/media/models', choices);
                setMediaSelections({});
              }, 'Generation choices saved');
            }}
          >
            <div className="stack">
              {media.value.modalities.map((item) => {
                const modelId =
                  mediaSelections[item.modality] ??
                  (item.choice.automatic ? '' : item.choice.modelId);
                const selectedOption = modelId
                  ? item.options.find((option) => option.id === modelId)
                  : item.effective;
                return (
                  <div key={item.modality}>
                    <h4>{item.modality[0]!.toUpperCase() + item.modality.slice(1)}</h4>
                    {selectedOption?.retirementAt && (
                      <p className="muted span-all" role="status">
                        {mediaRouteIsRetired(selectedOption) ? 'Retired' : 'Scheduled to retire'} on{' '}
                        {mediaRetirementDate(selectedOption.retirementAt)} (UTC). Existing job
                        records and recovery controls remain available. No replacement is selected
                        automatically.
                      </p>
                    )}
                    {selectedOption?.unavailableReason && (
                      <p className="muted span-all">{selectedOption.unavailableReason}</p>
                    )}

                    {!item.available ? (
                      <p className="muted">{item.reason ?? 'No compatible route is available.'}</p>
                    ) : (
                      <div className="management-grid">
                        <Field label={`${item.modality} model`}>
                          <select
                            name={`${item.modality}-model`}
                            value={modelId}
                            onChange={(event) =>
                              setMediaSelections((values) => ({
                                ...values,
                                [item.modality]: event.target.value
                              }))
                            }
                          >
                            <option value="">
                              {item.modality === 'video' ? 'No video model selected' : 'Automatic'}
                            </option>
                            {item.options.map((option) => (
                              <option
                                value={option.id}
                                key={option.id}
                                disabled={
                                  Boolean(option.unavailableReason) || mediaRouteIsRetired(option)
                                }
                              >
                                {option.displayName}
                                {mediaRouteIsRetired(option) ? ' · retired' : ''}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label={`${item.modality} preference`}>
                          <select
                            name={`${item.modality}-preference`}
                            defaultValue={item.choice.preference}
                          >
                            <option value="balanced">Balanced</option>
                            <option value="fast">Faster</option>
                            <option value="best">Higher quality</option>
                          </select>
                        </Field>
                        <p className="muted span-all">
                          {selectedOption
                            ? `${selectedOption.displayName}. ${selectedOption.usdPerImage !== null ? `${money(selectedOption.usdPerImage)} per image.` : selectedOption.usdPerSecond != null ? `From ${money(selectedOption.usdPerSecond)} per second.` : selectedOption.usdPerMinute !== null ? `${money(selectedOption.usdPerMinute)} per minute.` : selectedOption.usdPerMillionCharacters !== null ? `${money(selectedOption.usdPerMillionCharacters)} per million characters.` : 'Pricing depends on the request.'}`
                            : 'No effective route selected.'}
                        </p>
                        {selectedOption?.requiresRetentionApproval && (
                          <p className="muted span-all">
                            Each video job asks before temporary retention at the provider, and
                            shows the quoted cost before generation.
                          </p>
                        )}
                        {selectedOption?.capabilities &&
                          Object.keys(selectedOption.capabilities.parameters).length > 0 && (
                            <details className="span-all">
                              <summary>Available controls for {selectedOption.displayName}</summary>
                              <dl className="garden-provider-controls">
                                {Object.entries(selectedOption.capabilities.parameters).map(
                                  ([name, parameter]) => (
                                    <div key={name}>
                                      <dt>{name.replaceAll('_', ' ')}</dt>
                                      <dd>
                                        {parameter.type === 'enum'
                                          ? parameter.values.join(' · ')
                                          : parameter.type === 'range'
                                            ? `${parameter.min}–${parameter.max}`
                                            : 'On / off'}
                                      </dd>
                                    </div>
                                  )
                                )}
                              </dl>
                            </details>
                          )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="muted">
              Further generation asks for approval after the conversation reaches{' '}
              {money(media.value.approvalThresholdUsd)} in generation costs.
            </p>
            <Button type="submit" busy={action.busy}>
              Save generation choices
            </Button>
            <ActionFeedback action={action} />
          </form>
        )}
      </Section>
      <Section
        title="Model catalog"
        description="Availability, context and pricing from the connected catalog."
      >
        <ResourceState resource={models} />
        <Field label="Find a model">
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
        </Field>
        <div className="management-scroll">
          <table className="management-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Availability</th>
                <th>Inputs</th>
                <th>Context</th>
                <th>Input / output per million</th>
              </tr>
            </thead>
            <tbody>
              {models.value
                ?.filter((model) =>
                  `${model.displayName} ${model.id}`.toLowerCase().includes(query.toLowerCase())
                )
                .map((model) => (
                  <tr key={model.id}>
                    <td>
                      <strong>{model.displayName}</strong>
                      <br />
                      <span className="muted">
                        {model.privacyRoute === 'provider_zdr'
                          ? 'Zero retention'
                          : 'External route'}{' '}
                        · {model.provider}
                      </span>
                    </td>
                    <td>{model.availability}</td>
                    <td>
                      {(model.modalities ?? ['text']).join(' · ')}
                      {(['audio', 'video'] as const)
                        .filter((kind) => model.modalities?.includes(kind))
                        .map((kind) => {
                          const price =
                            kind === 'audio'
                              ? model.nativeInputPricing?.audioUsdPerMillionTokens
                              : model.nativeInputPricing?.videoUsdPerMillionTokens;
                          return (
                            <small className="muted" key={kind} style={{ display: 'block' }}>
                              {kind === 'audio' ? 'Audio' : 'Video'}:{' '}
                              {price == null
                                ? 'native input price unavailable'
                                : `${money(price)} per million input tokens`}
                            </small>
                          );
                        })}
                    </td>
                    <td>{model.contextTokens.toLocaleString()}</td>
                    <td>
                      {model.inputUsdPerMillionTokens == null
                        ? 'Unknown'
                        : money(model.inputUsdPerMillionTokens)}{' '}
                      /{' '}
                      {model.outputUsdPerMillionTokens == null
                        ? 'Unknown'
                        : money(model.outputUsdPerMillionTokens)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {models.value?.length === 0 && (
          <p className="empty">No models are available from this connection.</p>
        )}
      </Section>
    </>
  );
}
