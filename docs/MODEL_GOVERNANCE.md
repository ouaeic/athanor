# Model access and routing

## Boundary

athanor runs no model weights. The owner supplies an OpenRouter or OpenAI-compatible provider account,
or uses Codex/Claude subscriptions for bounded coding missions.

## Catalog scope

`MODEL_CATALOG_SCOPE` decides how much of the provider's catalog the owner is offered.

| Scope                        | Selection                                                     | When no review confirms the declared licence            |
| ---------------------------- | ------------------------------------------------------------- | ------------------------------------------------------- |
| `provider_catalog` (default) | Every chat model the owner's own provider account can reach   | The model keeps working and loses its open-weight badge |
| `reviewed_open_weight`       | Only models carrying an independent commercial-licence review | The model is withdrawn from selection (fails closed)    |

The default is `provider_catalog` because Athanor never redistributes model weights. It calls a
hosted endpoint using the owner's own provider account, so a model's weight licence governs
redistribution of the weights rather than the owner's right to call the service. Treating that
review as a _badge_ rather than a _gate_ also means a model released after an Athanor build appears
without a code change, which is what keeps an unattended server working.

`reviewed_open_weight` preserves the stricter posture for owners who deliberately want to run only
permissively licensed open-weight models. In that scope a model the manifest cannot confirm still
fails closed, and the reviewed allowlist can never be expanded by live provider metadata.

A review does not expire. It records the licence a model was published under and the exact upstream
revision that reading was made against, which is a fact about a published artefact rather than a
subscription. What retires a review is the catalogue declaring a licence the review does not
confirm - which is what a relicensing upstream looks like from here - not the passage of time. An
expiry date would fail a checkout nobody had touched, on a machine installed from a tag and left to
run, and in this scope that turns a working catalogue into an unselectable one.

Neither scope changes what Athanor itself is licensed under, and neither implies the model's
output rights, acceptable-use terms, or jurisdictional rules. See **Licenses** below.

## Live catalog

For OpenRouter, the registry refreshes current model IDs, capabilities, modalities, context length,
pricing, provider routes, and zero-data-retention eligibility. Cached records retain source and
refresh time. A model disappears from selection when the required route is unavailable. Media-only
routes are excluded from the chat picker and reached through the media service instead.

A refresh failure preserves the previous catalog rather than emptying the model picker.

An OpenAI-compatible custom endpoint has no universal catalog. The owner explicitly supplies model
ID, context, vision capability, modalities, and retention setting; the UI labels this as
owner-declared metadata.

## Selection

The UI ranks eligible models from efficient to high-end and recommends a default based on tool use,
reasoning, context, modality, route privacy, and price. The owner can always select a specific
eligible model.

Capability routing is explicit:

- lead model plans and answers;
- vision specialist inspects images only when the lead lacks vision;
- read-only delegated specialists investigate independent questions and report back, on the
  strongest eligible model for the task's privacy route;
- the summarising model condenses superseded turns into the running brief when a long task fills its
  window. It is deliberately the cheapest eligible model rather than the lead, because compaction
  reads the same window the lead is about to overflow and faithful summarising does not need the
  lead's capability. It stays on the task's privacy route and on the one provider the run holds a
  credential for; if none qualifies, the lead is used, and if the call fails the brief falls back to
  a deterministic summary rather than the task failing;
- Codex, Claude Code or OpenCode handles a bounded repository mission only when selected by the lead
  and approved by the owner;
- media models run as asynchronous jobs and return artifacts.

Specialist observations return to the lead so the conversation does not silently switch identity.

## Privacy

`AI_REQUIRE_ZDR=true` restricts OpenRouter routing to eligible endpoints and requests data-collection
denial. If no eligible route exists, athanor fails closed. Custom compatible endpoints rely on owner
configuration and their actual service policy.

Video generation is disabled. The only provider route for it is asynchronous and keeps the output
for retrieval, which no privacy setting makes acceptable, so the media catalogue reports video as
unavailable and a job for one is refused rather than started.

## Cost

athanor adds no markup or allowance. The model provider reports usage/cost where available; athanor
stores content-free task cost metadata and can show an estimate before material media work.

Publisher subscription limits for Codex/Claude are enforced by those services and may change. athanor
does not pool or emulate them.

## Licenses

Provider availability does not make a model open source or open weight. Model code/weight licenses,
service terms, acceptable use, generated-output rights, and jurisdictional rules remain separate from
the athanor AGPL license.
