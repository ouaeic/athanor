/**
 * The whole of what a model would have to be told, and the number this lane is arguing about.
 *
 * A new dialect is a tax paid on every request that carries it, and paid again in every turn where
 * the model gets the spelling wrong. `EDIT_FORMAT_SPEC` is the tax bill: it is the smallest text
 * that makes the format in `parse.ts` unambiguous, written to athanor's own rule that prompt length
 * should track what the model does NOT already know. Line numbers, ranges and `+` bodies are
 * familiar shapes; the tag, the seen-lines refusal and the original-numbering rule are not, and
 * those are what the words are spent on.
 *
 * Nothing imports this into a system prompt or a tool description. It exists so the cost of
 * shipping the format can be measured against the saving, in `evals/edit/`, before anybody decides.
 * If the ruling is to ship, this is the text that ships and `EDIT_FORMAT_SPEC.length` is what it
 * adds to the resident block.
 */
export const EDIT_FORMAT_SPEC = `Edit files by line number, using the numbers from your last read of that file.

A read answers with a header and numbered lines:

  [src/queue.ts#3f9a]
  40:  const job = queue.shift();
  41:  if (!job) return null;
  42:  return job.payload;

A patch is one section per file, headed by that same path and tag, then operations:

  [src/queue.ts#3f9a]
  PUT 41.=42:
  +  if (!job) return undefined;
  +  return job.payload ?? undefined;

Operations, where N and M are line numbers from the read:

  PUT N:            replace line N
  PUT N.=M:         replace lines N to M inclusive
  PUT N*:           replace the block that opens at line N, to its closing brace or its indent
  PUT <N:           insert before line N
  PUT >N:           insert after line N
  CUT N.=M          delete lines N to M inclusive
  CUT N.=M @name    delete them and keep them under @name
  PUT >N @name      paste @name after line N
  REM               delete the file
  MV path           rename the file

Body rows begin with + and are the final text of the line, without its number. Do not write the
old text and do not write unchanged context: the range says what goes, the body says what arrives.
A PUT with no body rows deletes the range.

Ranges name the line numbers in the read you took the tag from, never the numbers after your own
earlier operations in the same patch. Ranges within a section must not overlap.

The tag is the file's version. An edit is refused, and nothing is written, when the tag was never
issued for that file, when the file changed underneath it in a way that cannot be relocated, or
when you address lines that read has not shown you. Every refusal comes back with the file as it
reads now, so a retry needs no extra read.

After an edit lands, the line numbers and the tag have both changed. Take the new tag from the
response and re-read before addressing lines you have not seen since.`;
