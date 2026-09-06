# Live voice

Live voice connects the signed-in browser microphone to garden and then to the owner's native OpenAI API account. garden retains the provider credential on the server. The browser never receives a provider key or a connection that can send arbitrary provider commands.

Choose the advertised model, voice, reasoning effort, privacy route, session lifetime and spending allowance before enabling the microphone. Availability comes from that account's model discovery and garden's documented protocol catalogue. An audio-capable model is not automatically a supported live voice route. OpenRouter dictation requires explicit external retention consent. Dictation and generated audio use their own routes; the live voice transport requires the native OpenAI connection.

The live voice models and price snapshot are defined in [the realtime catalogue](../packages/model-gateway/src/realtime.ts). Session and audio limits are defined in [the public voice contract](../packages/contracts/src/voice.ts). Preflight advertises the maximum continuous input segment. Natural pauses reset it; uninterrupted input reaching it ends the session with an explanation. The server limits response output and browser playback queues independently.

## Spending and privacy

The minimum reservation is held capacity, not an immediate charge. Before each response garden reserves a full model input context at the maximum supported modality price, plus bounded output, without guessing tokens from audio duration. Exact provider usage settles the reservation. Voice spending shares the owner and task family limits. Session allowance does not increase the task's allowance.

Before microphone permission is requested, garden checks whether the current task family and account can afford the first bounded response after existing charges and commitments. It checks again when the browser claims its connection ticket, before opening the provider socket. An unavailable budget reports the required capacity and the limiting allowance; it never raises a cap. These admission checks do not reserve money or promise future availability. Each response still makes its own atomic reservation, so other work or changed limits can stop a session later.

The configured zero data retention route requires the owner to have configured that retention policy for the native provider account. garden cannot infer account approval from endpoint eligibility. Otherwise the owner must explicitly choose the advertised external retention route. There is no automatic privacy or provider fallback. Provider tracing and separately billed input transcription are disabled. garden does not persist raw live audio. Provider connection material and work proposals are sealed in the database.

A lost or malformed provider receipt remains a visible held charge. Closing the audio connection does not fabricate a refund. Settings audio recovery lists held voice sessions, including those whose original task was deleted. Reconcile a held response using its exact local receipt, actual invoice charge and provider receipt reference. Invoice references are sealed; reconciliation makes no provider or model call.

## Task work and ending a session

The voice model can read the selected task's cached status or propose work. A proposal appears for owner review and cannot enqueue itself. Confirmation binds the exact prompt and task settings and uses the ordinary task continuation path without granting more budget. Existing approval cards remain independent; voice tools cannot decide them.

The browser stops microphone capture and playback when the owner ends voice, closes the panel or hides the page. garden closes the provider transport and preserves any unresolved charge. A deadline, revoked browser session, disconnected credential, deleted task or lost controller lease also ends the connection. Starting again is an explicit owner action. Retrying the same start request recovers its sealed connection record; it does not create another paid provider session or bypass the one-use ticket.

## API surfaces

| Route                                                              | Result or action                                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `GET /v1/voice/models`                                             | Reviewed model availability, retention routes, prices and bounds        |
| `POST /v1/tasks/:taskId/voice-sessions`                            | Idempotent sealed connection, session and one-use browser ticket        |
| `GET /v1/tasks/:taskId/voice-sessions`                             | Task session history                                                    |
| `GET /v1/voice-sessions`                                           | Owner recovery list, including held charges outside recent task history |
| `GET /v1/voice-sessions/:sessionId/socket`                         | Authenticated, origin-checked garden WebSocket                          |
| `POST /v1/tasks/:taskId/voice-sessions/:sessionId/stop`            | End local capture and provider transport; retain uncertain charges      |
| `GET /v1/voice-sessions/:sessionId/proposals`                      | Sealed proposals opened for the owner                                   |
| `POST /v1/voice-sessions/:sessionId/proposals/:proposalId/confirm` | Confirm the reviewed digest and queue exactly that work                 |
| `POST /v1/voice-sessions/:sessionId/proposals/:proposalId/reject`  | Reject the reviewed digest                                              |
| `GET /v1/voice-sessions/:sessionId/receipts`                       | Unresolved response reservations                                        |
| `POST /v1/voice-sessions/:sessionId/reconcile`                     | Record the exact owner invoice receipt                                  |

The current automated tests exercise database transactions and the provider WebSocket protocol with controlled provider responses. They do not prove a paid provider call. A deployment canary must verify the actual account's model availability, acknowledged session settings, audible output, interruption and invoice usage before live provider behavior is described as verified.

The provider protocol and retention assumptions follow the official [Realtime client events](https://developers.openai.com/api/reference/resources/realtime/client-events), [Realtime costs](https://developers.openai.com/api/docs/guides/realtime-costs), [API pricing](https://developers.openai.com/api/docs/pricing) and [data controls](https://developers.openai.com/api/docs/guides/your-data).
