/**
 * The whole of what the model is told, and the only part of this vertical that is RESIDENT.
 *
 * athanor's rule is that the harness owns capability, bounds and evidence, and the model owns
 * method; method may exist in the harness but may not be resident. A dialect is the one kind of
 * method that has no choice - a format nobody has described cannot be emitted - so every byte here
 * is paid on every request of every turn, and the job is to spend as few as the format can be
 * unambiguous in. The reference dialect this was measured against spends 5,268 bytes on the same
 * job; this spends under a fifth of that, and the difference is not terseness. It is that three
 * whole paragraphs of the reference describe a version tag, what to do when it does not match, and
 * how to recover - and `snapshots.ts` does not need the model to carry a tag at all.
 *
 * What is deliberately NOT here, and this is the load-bearing omission: the parser forgives a dozen
 * spellings - `PUT 40-42:`, a `[path]` header, `-` rows, a whole unified-diff hunk - and none of
 * them are documented. Documenting a leniency spends resident bytes teaching a longer way to write
 * the same edit, and then the model writes it that way. The leniency is for the model that reaches
 * for a habit anyway; the spec is for the model reading it, and it describes only the cheapest
 * correct form. Forgiveness is a property of the harness, not a feature of the format.
 *
 * Two operations from the measured reference are also missing, and the reason is the rule about
 * gates wired to nothing rather than a byte count. `REM` deletes a file and `MV` renames one, and
 * the worker's runner client has no route for either - `apps/worker/src/runner-client.ts` offers
 * read, ranged read and write, and nothing else. Declaring them here would put two operations on
 * every request that the arm behind them cannot carry out, which is the exact shape of failure this
 * programme has shipped twice and caught twice. `shell` already deletes and renames files, it is
 * already on the catalogue, and it needs no dialect to do it.
 */
export const EDIT_FORMAT_SPEC = `Edit by line number. file_read numbers every line as N:TEXT; address those numbers.

  PUT 41.=42:
  +  if (!job) return undefined;
  +  return job.payload ?? undefined;

  PUT N:        replace line N
  PUT N.=M:     replace lines N to M
  PUT N*:       replace the whole block that opens at line N
  PUT <N:       insert before line N
  PUT >N:       insert after line N
  CUT N.=M      delete lines N to M
  CUT N.=M @x   delete them and hold them as @x
  PUT >N @x     paste @x after line N

Body rows start with + and carry the final text of the line. Do not write the old text and do not
repeat unchanged lines: the range says what goes, the body says what arrives. A PUT with no body
deletes its range.

Ranges name the numbers you read, never the numbers your own earlier operations would leave, and
they must not overlap. One patch per file, applied whole or not at all.

A refusal writes nothing and comes back with the file's real text at those lines, so fix the patch
and send it again without reading first.`;
