/**
 * The name the model picker uses, from whatever id the box happens to have recorded.
 *
 * Three ids exist for one model and they are not the same string: the catalogue's own id
 * (`openrouter/z-ai/glm-5.2`), the id sent to the provider (`z-ai/glm-5.2`), and whatever the
 * provider echoed back on the response. A transcript that prints the third and a picker that shows
 * a display name are two names for one thing, which is exactly the confusion this resolves — the
 * first question about a wrong answer is which model wrote it.
 */
export interface NamedModel {
  id: string;
  providerModelId?: string;
  displayName: string;
}

/** The part of a provider-qualified id a person recognises, when nothing in the catalogue matches. */
export const modelTail = (id: string): string => id.split('/').pop() || id;

export const modelDisplayName = (models: readonly NamedModel[], id: string): string => {
  const wanted = id.trim();
  if (!wanted) return '';
  const tail = modelTail(wanted);
  const match =
    models.find((model) => model.id === wanted || model.providerModelId === wanted) ??
    // A provider that answers with a revision suffix, or a catalogue prefix on one side only,
    // still names the same model; the tail is what the two ids have in common.
    models.find(
      (model) => model.id.endsWith(`/${tail}`) || model.providerModelId?.endsWith(`/${tail}`)
    );
  return match?.displayName ?? tail;
};
