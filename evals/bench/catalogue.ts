/**
 * What the catalogue actually weighs on the box this shim describes - measured, not argued.
 *
 * THE COUNTER-ARGUMENT THIS FILE ANSWERS WITH A NUMBER. athanor is not a benchmark scaffold. It
 * ships a tool catalogue where a purpose-built coding scaffold ships one tool or none, and the
 * charge is that it pays a tax per model call for connectors, media, desktop and memory that a
 * coding task will never touch. The research put that tax at 12,508 tokens per call and 39.9% of
 * every prompt token `evals/baseline.json` bills, which is a real measurement of the WRONG BOX:
 * `evals/harness.ts` answers `/surfaces` with both surfaces available, and
 * `apps/worker/src/turn/claim.ts:212` withdraws `connector_action` outright on a box with no
 * connections. A Terminal-Bench container has no browser, no screen and no connections.
 *
 * So the honest charge is measured here, through the production function, against the four boxes
 * that matter. It is a real charge either way - the residue is still tens of kilobytes against a
 * bare-bones harness's zero - and it does not need the overstatement.
 *
 * ZERO COST. `agentToolsFor` is a pure function; nothing here calls a provider.
 */
import { COMPACT_CONTEXT_TOOL } from '../../apps/worker/src/context.js';
// The production function, not a copy of it: a second spelling of the catalogue would measure
// itself. @see apps/worker/src/tool-catalogue.test.ts:89, which weighs the wire the same way.
import { agentToolsFor } from '../../apps/worker/src/tool-catalogue.js';
import type { ConnectorKind } from '../../packages/contracts/src/index.js';

/** The wire form, byte for byte the way `tool-catalogue.test.ts:89-90` measures it. */
const bytesOf = (
  surfaces: 'available' | 'absent',
  connectors: readonly ConnectorKind[]
): number => {
  const tools = [
    ...agentToolsFor('lead', { browser: surfaces, desktop: surfaces }, connectors),
    COMPACT_CONTEXT_TOOL
  ]
    // The one withdrawal that is not `agentToolsFor`'s to make. `claim.ts:212` removes
    // `connector_action` entirely from a box with nothing connected, and leaving it in would make
    // the bare figure 6.6 kB too heavy - which is most of the gap the counter-argument turns on.
    .filter((tool) => connectors.length > 0 || tool.name !== 'connector_action');
  return Buffer.byteLength(JSON.stringify(tools), 'utf8');
};

export interface CatalogueWeight {
  readonly box: string;
  readonly bytes: number;
  /** Tokens at this repository's own measured bytes-per-token; see BYTES_PER_TOKEN. */
  readonly approxTokens: number;
}

/**
 * Bytes per catalogue token, taken from this repository's own wire rather than from the usual
 * four-bytes-a-token rule of thumb.
 *
 * `evals/baseline.json` measured 12,508 catalogue tokens at the maximum, and the fully provisioned
 * catalogue this file weighs at that configuration is 55,673 bytes. Say what does and does not
 * commit to that figure, because the two nearby assertions are about different boxes:
 * `apps/worker/src/tool-catalogue.test.ts:402` holds the DEFAULT catalogue under an upper bound of
 * 55,700, which 55,673 sits 27 bytes inside, and the 44,000 assertion further down that file is
 * over a BARE box and is the anchor used lower in this rig. No test commits to 55,673 exactly; it
 * is measured here through the production `agentToolsFor`. 55,673 / 12,508 = 4.451. Using 4 would
 * overstate every token figure below by about 11%, which is the direction that flatters the
 * counter-argument rather than athanor, and it would still be wrong.
 *
 * It is an approximation. The exact number depends on the tokeniser the route uses, which is a
 * property of the provider and not of this repository. What would change it: a different model
 * family, or a catalogue whose character mix moves.
 */
export const BYTES_PER_TOKEN = 55_673 / 12_508;

/** The four boxes, in the order that makes the argument. */
export const catalogueWeights = (): CatalogueWeight[] => {
  const rows: Array<[string, 'available' | 'absent', ConnectorKind[]]> = [
    // The five kinds a connection can be, in the enum's own spelling. `agentToolsFor`'s third
    // argument narrows `connector_action`'s action list to what the connected kinds can accept,
    // so an empty array here is not "no connectors" - it is "unknown", which describes all
    // twenty-four actions. A box with nothing connected is the last row, where `claim.ts:212`
    // takes the whole tool away.
    [
      'fully provisioned, all five connector kinds (what the eval suite measures)',
      'available',
      ['github', 'webdav', 'mcp_http', 'imap', 'caldav'] as ConnectorKind[]
    ],
    ['a browser and a screen, nothing connected', 'available', []],
    ['no browser, no screen, one connection', 'absent', ['github'] as ConnectorKind[]],
    ['no browser, no screen, nothing connected (THE BENCHMARK BOX)', 'absent', []]
  ];
  return rows.map(([box, surfaces, connectors]) => {
    const bytes = bytesOf(surfaces, connectors);
    return { box, bytes, approxTokens: Math.round(bytes / BYTES_PER_TOKEN) };
  });
};

/** The benchmark box's own figure, which is what a parity row's `catalogue_bytes` column carries. */
export const benchmarkBoxCatalogueBytes = (): number => bytesOf('absent', []);

/**
 * The tools a box with neither surface loses, DERIVED rather than listed.
 *
 * `BROWSER_SURFACE_TOOLS` and `DESKTOP_SURFACE_TOOLS` are file-local sets in
 * `apps/worker/src/tool-catalogue.ts` and nothing exports them, so a rig that wanted the seven
 * names had two choices: copy them, or take the difference the production function itself makes.
 * Copying is how a list rots - a tool added to either set would leave the copy quietly short, and
 * the check below would go on passing while describing six of seven.
 *
 * `score.ts` uses this to ask a live run whether the gate actually held, which is the one thing
 * `routes.ts` says out loud it had never observed: it read the gate's own test and the single line
 * that applies it, and never watched a turn under `absent, absent` and found the tools gone.
 */
export const surfaceGatedToolNames = (): string[] => {
  const withSurfaces = new Set(
    agentToolsFor('lead', { browser: 'available', desktop: 'available' }, []).map(
      (tool) => tool.name
    )
  );
  for (const tool of agentToolsFor('lead', { browser: 'absent', desktop: 'absent' }, []))
    withSurfaces.delete(tool.name);
  return [...withSurfaces].sort();
};
