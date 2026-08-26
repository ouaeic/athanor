import { randomInt, randomUUID } from 'node:crypto';
import { sha256, AthanorError } from '@athanor/core';
import { MediaClient, type ModelToolCall } from '@athanor/model-gateway';
import { spendHalt, textValue, transcriptionRouteAllowed, type ExecObservation } from '../agent.js';
import {
  managedMediaCatalog,
  mediaDimension,
  mediaEstimateUsd,
  resolvedMediaModel,
  resolvedTranscriptionRoute,
  transcriptionEstimateAtRate,
  transcriptionRate,
  transcriptionRateFromReading,
  transcriptionWindow
} from '../media.js';
import { type ToolContext } from '../tool-dispatch.js';
import { clampNumber, finiteNumber } from './numbers.js';

/**
 * The document tools: reading what the owner has stored, and making new media from it.
 *
 * `generate_media` and `audio_read` sit beside the readers because they are billed the same way -
 * they are the two arms in this file that put a line on the owner's provider bill, and both write
 * their own ledger row rather than leaving it to the turn.
 */
export async function executeDocumentTool(
  context: ToolContext,
  call: ModelToolCall
): Promise<unknown> {
  const { task, state } = context;
  const root = `/v1/workspaces/${task.workspaceId}`;
  switch (call.name) {
    case 'document_read': {
      const path = textValue(call.arguments.path);
      const startPage = clampNumber(call.arguments.startPage, { min: 1, max: 10_000, fallback: 1 });
      const endPage = clampNumber(call.arguments.endPage, {
        min: startPage,
        max: 10_000,
        fallback: startPage + 19
      });
      const maxCharacters = clampNumber(call.arguments.maxCharacters, {
        min: 1_000,
        max: 200_000,
        fallback: 80_000
      });
      const result = await context.runner.call<ExecObservation>(
        task.workspaceId,
        task.id,
        'exec',
        `${root}/exec`,
        {
          executable: '/usr/local/lib/athanor/athanor-document',
          args: [
            'read',
            '--path',
            path,
            '--start-page',
            String(startPage),
            '--end-page',
            String(endPage),
            '--max-chars',
            String(maxCharacters)
          ],
          cwd: '.',
          // Long enough to contain the reader's own OCR budget and the page still being
          // recognised when it runs out. A PDF whose pages are pictures is read a page at a time
          // and stops on a page boundary to name the pages it did not reach; killing the process
          // before it can get there turns that reading into a failed tool call, which is the one
          // outcome worse than a short answer. Every other format returns in milliseconds and
          // never comes near this.
          timeoutSeconds: 300,
          maxOutputBytes: 1024 * 1024
        }
      );
      if (result.exitCode !== 0)
        throw new AthanorError(
          'document_read_failed',
          result.stderr || 'Document extraction failed'
        );
      return JSON.parse(result.stdout) as unknown;
    }
    case 'audio_read': {
      // Resolved before anything else, so a computer with no provider connected says so rather
      // than encoding ninety minutes of audio first and then discovering it cannot send it.
      const secret = await context.inferenceCredential(task);
      const path = textValue(call.arguments.path);
      // One of the three clamps in the nine domain modules that already defended against `NaN`,
      // by way of a `|| 0` nobody outside this arm knew was load-bearing. It says the same thing
      // now in the words every other arm uses.
      const startSeconds = clampNumber(call.arguments.startSeconds, {
        min: 0,
        max: 86_400,
        fallback: 0,
        integer: true
      });
      const endValue = finiteNumber(call.arguments.endSeconds);
      const maxCharacters = clampNumber(call.arguments.maxCharacters, {
        min: 1_000,
        max: 200_000,
        fallback: 40_000
      });
      const client = new MediaClient({
        baseUrl: secret.baseUrl,
        ...(secret.apiKey ? { apiKey: secret.apiKey } : {}),
        appUrl: context.config.PUBLIC_APP_URL,
        openRouter: secret.provider === 'openrouter'
      });
      // The owner's own choice first. Asking the provider what it has is the fallback for an owner
      // who has never opened the media section, and it is one request rather than a compiled-in
      // model id: nothing in this repository has run a transcription route, so an id written here
      // would be a claim about a model nobody checked.
      const chosen = resolvedTranscriptionRoute(secret.mediaRoutes);
      const modelId =
        chosen?.modelId ??
        (await client.transcriptionModels().catch(() => [] as string[]))[0] ??
        '';
      if (!modelId)
        throw new AthanorError(
          'transcription_route_unavailable',
          'The connected provider offers no model that reads recordings, so this file cannot be transcribed. Choosing a transcription model in Settings, or connecting a provider that has one, is what opens this route.',
          503
        );
      // Asked before a second of the recording is cut, so a task that cannot send it never
      // encodes it either.
      if (!transcriptionRouteAllowed(secret.mediaRoutes?.transcription, task.privacyRoute))
        throw new AthanorError(
          'transcription_privacy_conflict',
          'This task requires zero-retention model routing, and the transcription route this computer would use does not offer a zero-retention endpoint, so Athanor will not send a private recording to it. Choosing a transcription model that offers one in Settings, or starting a standard-privacy task if you deliberately want this one, is what opens this route.'
        );
      // What a minute of this route costs, on the best evidence this task holds: the price the
      // owner's catalogue published, or failing that the one measured from a reading the provider
      // has already billed here. While it is neither, the window below is cut to a single billing
      // minute, so the guard is never asked to enforce a cap against an estimate of zero.
      const rate = transcriptionRate(chosen, state.transcriptionRates?.[modelId]);
      const readingWindow = transcriptionWindow({
        startSeconds,
        ...(endValue !== null && endValue > startSeconds ? { endSeconds: endValue } : {}),
        rate
      });
      const prepared = await context.runner.prepareAudio(task.workspaceId, task.id, {
        path,
        startSeconds,
        endSeconds: readingWindow.endSeconds
      });
      // Priced on what was actually cut rather than on what was asked for, and checked before the
      // recording leaves this computer. Duration billing means the money is spent the moment the
      // request is accepted, so a guard that ran afterwards would be a report rather than a brake.
      const decision = await context.store.spendGuard({
        userId: task.userId,
        taskId: task.id,
        estimateUsd: transcriptionEstimateAtRate(prepared.preparedSeconds, rate),
        includeOpenCommitments: true
      });
      if (decision.outcome === 'deny')
        throw new AthanorError(
          'spend_cap_reached',
          `${spendHalt(decision)} Nothing was transcribed and nothing was charged; say so and carry on with the work that costs nothing.`
        );
      const reading = await client
        .transcribe({
          model: modelId,
          audio: prepared.bytes,
          format: prepared.format,
          seconds: prepared.preparedSeconds,
          usdPerMinute: rate.usdPerMinute
        })
        .catch((error: unknown) => {
          throw new AthanorError(
            'audio_read_failed',
            error instanceof Error ? error.message : 'The recording could not be read'
          );
        });
      // What the provider charged for a minute of this route, now that it has charged for one.
      //
      // This is the whole point of the short first window. From here the next reading of the same
      // recording is priced on a figure that came from an invoice rather than from nothing, so the
      // daily cap applies to it exactly as it applies to a route whose price was published all
      // along. A provider that states no cost teaches nothing and is left unrecorded rather than
      // recorded as free.
      const measured = transcriptionRateFromReading(reading, prepared.preparedSeconds);
      if (measured !== null)
        state.transcriptionRates = { ...(state.transcriptionRates ?? {}), [modelId]: measured };
      // Recorded between the charge and everything that could still fail, exactly as a generation
      // is. The provider has billed by this line, and media spend was the least visible line on a
      // task's bill precisely because a path existed that spent money without writing one of these.
      await context.store.recordUsage({
        userId: task.userId,
        workspaceId: task.workspaceId,
        taskId: task.id,
        kind: 'model_inference',
        resourceClass: 'media:transcription',
        quantity: Math.max(1, Math.round(reading.billedSeconds ?? prepared.preparedSeconds)),
        unit: 'second',
        credits: 0,
        costUsd: reading.costUsd,
        state: 'settled',
        /*
         * The route is part of what makes two readings two charges.
         *
         * This key was the task, the path and the window, and nothing else, though the arm has
         * just resolved a model id and records it in `providerRef` on the line below. Change the
         * media route mid-task - the owner pins one in Settings, or the provider's list comes
         * back in a different order - and re-read the same window: the provider bills for the
         * second reading and `recordUsage` deduplicates the row away, so the money is spent and
         * the ledger every spend cap is measured against never hears about it. The
         * `generate_media` writer nineteen lines below keys on a per-generation id and cannot
         * collide; this is the same fix, put where the two charges actually differ.
         */
        idempotencyKey: `transcription:${task.id}:${sha256(`${modelId}:${path}:${prepared.startSeconds}:${prepared.preparedSeconds}`)}`,
        providerRef: `${secret.provider}:${modelId}`
      });
      // The whole transcript goes to a file before any of it is cut for the window. What was paid
      // for is not thrown away because the model asked for forty thousand characters, and reading
      // the rest of it is a free file_read rather than a second minute-billed request.
      const transcriptPath = `${path}${prepared.startSeconds > 0 ? `.from-${prepared.startSeconds}s` : ''}.transcript.txt`;
      await context.runner
        .writeFile(task.workspaceId, task.id, transcriptPath, reading.text)
        .catch(() => undefined);
      const text = reading.text.slice(0, maxCharacters);
      return {
        path,
        transcriptPath,
        startSeconds: prepared.startSeconds,
        secondsRead: Math.round(prepared.preparedSeconds),
        ...(prepared.durationSeconds === null
          ? {}
          : { durationSeconds: Math.round(prepared.durationSeconds) }),
        // Where the next reading starts, when the recording carries on past this window. Without
        // it a bounded read of a long recording is a dead end the model cannot get past.
        ...(prepared.more
          ? { nextStartSeconds: prepared.startSeconds + Math.round(prepared.preparedSeconds) }
          : {}),
        characters: reading.text.length,
        truncated: reading.text.length > text.length,
        modelId,
        // Null rather than zero when nobody has said what this cost. The provider stated no
        // figure and publishes no per-minute price, so `transcribe` had nothing to multiply and
        // returned zero - and a zero handed to the model here comes back to the owner as the
        // sentence "that reading was free", which is a claim this computer cannot make.
        ...(reading.costFromProvider || rate.usdPerMinute !== null
          ? {
              costUsd: reading.costUsd,
              billedBy: reading.costFromProvider
                ? 'connected provider'
                : `this route's ${rate.source} price per minute`
            }
          : {
              costUsd: null,
              billedBy:
                'not known here: the provider stated no cost for this reading and publishes no per-minute price for this route. It will appear on the provider account.'
            }),
        // Said when the window was cut short to find out what a minute costs, so the model reads
        // a deliberately short first reading as the start of a long one rather than as the end of
        // the recording. Not said when the recording ended inside that minute anyway: there is no
        // rest to go back for, and pointing at a `nextStartSeconds` that is not there would send
        // the model looking for audio that does not exist.
        ...(readingWindow.measuring && prepared.more
          ? {
              pricing: `No per-minute price is published for ${modelId}, so this first reading was limited to one billed minute to establish what it costs. Continue from nextStartSeconds to read the rest.`
            }
          : {}),
        text,
        ...(reading.text.length > text.length
          ? {
              instruction: `This is the first ${text.length} of ${reading.text.length} characters. The whole transcript of this stretch is at ${transcriptPath}; read the rest of it there rather than transcribing again.`
            }
          : {})
      };
    }
    case 'document_search': {
      const query = textValue(call.arguments.query).trim();
      if (!query) throw new AthanorError('document_query_empty', 'Document search needs a query');
      const path = textValue(call.arguments.path, 'workspace');
      const maxFiles = clampNumber(call.arguments.maxFiles, { min: 1, max: 2_000, fallback: 500 });
      const maxResults = clampNumber(call.arguments.maxResults, { min: 1, max: 50, fallback: 12 });
      const maxPages = clampNumber(call.arguments.maxPages, { min: 1, max: 10_000, fallback: 500 });
      const result = await context.runner.call<ExecObservation>(
        task.workspaceId,
        task.id,
        'exec',
        `${root}/exec`,
        {
          executable: '/usr/local/lib/athanor/athanor-document',
          args: [
            'search',
            '--path',
            path,
            '--query',
            query,
            '--max-files',
            String(maxFiles),
            '--max-results',
            String(maxResults),
            '--max-pages',
            String(maxPages)
          ],
          cwd: '.',
          timeoutSeconds: 300,
          maxOutputBytes: 1024 * 1024
        }
      );
      if (result.exitCode !== 0)
        throw new AthanorError('document_search_failed', result.stderr || 'Document search failed');
      return JSON.parse(result.stdout) as unknown;
    }
    case 'generate_media': {
      // Resolved first because it is the same lookup the old assertion made, and asking for it
      // up front means an unconfigured provider is reported as one rather than as a spend refusal.
      const secret = await context.inferenceCredential(task);
      const kind = textValue(call.arguments.kind);
      if (kind === 'video')
        throw new AthanorError('media_privacy_unavailable', managedMediaCatalog.video.reason);
      if (kind !== 'image' && kind !== 'audio')
        throw new AthanorError('media_kind_invalid', 'Choose image or audio');
      // The owner's choice, or the reviewed default when they have not made one. Read from the
      // credential rather than from a catalogue because this side has no catalogue: the API
      // resolved the route at the moment it was chosen, so an automatic mode settles then rather
      // than drifting between one generation and the next.
      const media = resolvedMediaModel(kind, secret.mediaRoutes);
      const modelId = media.modelId;
      const prompt = textValue(call.arguments.prompt).trim();
      if (!prompt) throw new AthanorError('media_prompt_empty', 'A media prompt is required');
      const width = mediaDimension(call.arguments.width);
      const height = mediaDimension(call.arguments.height);
      const estimateUsd = mediaEstimateUsd({
        kind,
        width,
        height,
        characterCount: prompt.length,
        model: media
      });
      const generation = randomUUID();
      // Where it will be written, decided before a penny is spent. The runner accepts writes only
      // under `workspace/` (and the artifact store), so a model that answers this parameter with
      // `logo.png` or `generated/logo.png` - which the schema's wording invites - would have had
      // its file refused after the provider had already billed for it. Resolving the destination
      // first turns that into a free refusal, and a bare name into the obvious thing.
      //
      // `assertUserDataPath` reads a bare name the same way, so this predicts the runner rather
      // than departing from it. It stays because prediction is the point: the check has to happen
      // on this side of the provider's invoice, not at the write.
      const extension = kind === 'image' ? 'png' : 'mp3';
      const requested = textValue(call.arguments.path).trim().replace(/^\.\//, '');
      if (requested.split('/').includes('..'))
        throw new AthanorError(
          'media_path_invalid',
          'A generated file goes in the workspace; the path may not climb out of it'
        );
      const base = !requested
        ? `workspace/generated/${generation}.${extension}`
        : requested.startsWith('workspace/') || requested.startsWith('.athanor/')
          ? requested
          : `workspace/${requested}`;
      // Checked before the request, and settled from the provider's own figure after it. A queued
      // generation used to need every other in-flight job added to this estimate, because none of
      // them had billed yet and so none of them appeared in the ledger the guard reads; a burst
      // would all pass the cap together and the owner found out from the invoice. Generating in
      // the call means the charge is recorded the moment it is incurred, so the ordinary guard is
      // the whole of it.
      const decision = await context.store.spendGuard({
        userId: task.userId,
        taskId: task.id,
        estimateUsd,
        includeOpenCommitments: true
      });
      if (decision.outcome === 'deny')
        throw new AthanorError(
          'spend_cap_reached',
          `${spendHalt(decision)} Nothing was generated and nothing was charged; say so and carry on with the work that costs nothing.`
        );
      const seed = Number.isSafeInteger(call.arguments.seed)
        ? Number(call.arguments.seed)
        : randomInt(0, 2 ** 31 - 1);
      const generated = await new MediaClient({
        baseUrl: secret.baseUrl,
        ...(secret.apiKey ? { apiKey: secret.apiKey } : {}),
        appUrl: context.config.PUBLIC_APP_URL,
        openRouter: secret.provider === 'openrouter'
      })
        .generate({
          id: generation,
          kind,
          model: modelId,
          prompt,
          width,
          height,
          seed,
          // Only when the resolved route names one: a voice belongs to a specific speech model's
          // own list, and sending one model's voice name to another is a request the provider
          // has no way to honour.
          ...(media.voice ? { voice: media.voice } : {}),
          usdPerImage: media.usdPerImage,
          usdPerMillionCharacters: media.usdPerMillionCharacters
        })
        .catch((error: unknown) => {
          throw new AthanorError(
            'media_generation_failed',
            error instanceof Error ? error.message : 'Media generation failed'
          );
        });

      // Recorded here, between the charge and everything that could still fail. The provider has
      // billed by this line, and the ledger is the only account of media spend there is now: it
      // feeds the caps, the cumulative approval card and the breakdown the owner reads. Writing it
      // after the file write meant a refused path, a cancelled turn or a restarted runner threw
      // the money away silently and left the model free to try again at the same price.
      await context.store.recordUsage({
        userId: task.userId,
        workspaceId: task.workspaceId,
        taskId: task.id,
        kind: 'model_inference',
        resourceClass: `media:${kind}`,
        quantity: 1,
        unit: 'generation',
        credits: 0,
        // The provider's own figure where it gave one, so the ledger settles on what was charged
        // rather than on what this side guessed beforehand.
        costUsd: generated.costUsd,
        state: 'settled',
        idempotencyKey: `media:${generation}`,
        providerRef: `${secret.provider}:${modelId}`
      });

      // One output is the ordinary case, so the resolved path is used as it stands; a provider
      // that returned several gets them numbered beside it rather than overwriting itself.
      const written = generated.outputs.map((output, index) => ({
        path: index === 0 ? base : base.replace(/(\.[^./]+)?$/, `-${index + 1}$1`),
        bytes: output.bytes
      }));
      for (const output of written)
        await context.runner.writeBytes(task.workspaceId, task.id, output.path, output.bytes);
      const paths = written.map((output) => output.path);
      const usage = await context.runner.call<{ storageBytes: number }>(
        task.workspaceId,
        task.id,
        'files.read',
        `${root}/usage`
      );
      await context.store.setWorkspaceStorage(task.userId, task.workspaceId, usage.storageBytes);
      return {
        kind,
        modelId,
        paths,
        costUsd: generated.costUsd,
        billedBy: 'connected provider',
        instruction:
          kind === 'image'
            ? 'The file exists now. Look at it with image_read before publishing it.'
            : 'The file exists now.'
      };
    }
    default:
      /*
       * Unreachable: the table in `tool-dispatch.ts` is what chooses this module, and it only
       * names the tools above. Kept so that a tool added to the table and forgotten here fails
       * loudly on the first call rather than returning `undefined` to the model.
       */
      throw new Error(`Unknown tool ${call.name}`);
  }
}
