/**
 * The two lists on "What it may do", kept out of the composer's graph.
 *
 * They are prose, they are read by exactly one lazily-loaded settings page, and they were riding
 * into the first paint because the composer imports the mode labels from the same module. Splitting
 * them is the difference between the first screen carrying five sentences it will never show and
 * the settings dialog fetching them when it opens.
 */
export interface AskingRule {
  /** The thing being done, named the way the owner would name it. */
  what: string;
  /** The concrete cases, because "high-impact" is not a fact anybody can check. */
  detail: string;
}

/**
 * What asks whatever the mode says.
 *
 * Every one of these is a branch in `approvalRequirement` (apps/worker/src/tools.ts) that returns
 * before any `securityMode` test is reached, so no setting on this page can switch them off. The
 * page that describes the modes was the one place in the product that never said so.
 *
 * Written by hand and kept to five lines deliberately. Generating it from the classifier was
 * considered and dropped: it is build machinery for five sentences that change about twice a year,
 * and what a generator can produce from that function is the enum again, which is what the
 * approval card already had to be rescued from.
 */
export const alwaysAsks: AskingRule[] = [
  {
    what: 'Spending your money',
    detail:
      'A buy, pay or subscribe control on a website, and generated images or video past about $0.25 in one conversation.'
  },
  {
    what: 'Passwords, card numbers and other private text',
    detail: 'It never types them. A page that asks for one hands the keyboard back to you.'
  },
  {
    what: 'Putting something on the public internet',
    detail: 'Publishing an app or a page at an address anyone with the link can open.'
  },
  {
    what: 'Removing or overwriting data',
    detail:
      'rm, shred, mkfs, git reset --hard, find -delete, rsync --delete, removing a package — including inside a script, an xargs, or a desktop window.'
  },
  {
    what: 'Pushing to a Git remote',
    detail: 'Every git push. Fetching, branching and committing locally do not ask.'
  }
];

/**
 * The whole of what changes between the two modes an owner actually chooses between.
 *
 * Two rules, both in `ordinaryRequirement`: the package-install card is skipped under Autonomous,
 * and a networked command is judged against the read-only allowlist rather than asked about every
 * time. Naming them is the only way the choice can be made on evidence — "works normally" and
 * "works independently on reversible steps" are the mode descriptions, and an adjective is not
 * something anyone can act on.
 */
export const balancedVsAutonomous: AskingRule[] = [
  {
    what: 'Installing software',
    detail:
      'Balanced asks before apt, npm, pip or brew add anything to this computer. Autonomous installs without asking; removing a package still asks.'
  },
  {
    what: 'Commands that reach the internet',
    detail:
      'Balanced asks every time. Autonomous runs the read-only ones — fetching a page, git fetch, a package install — and still asks for uploads, for anything else, and for any script it cannot read.'
  }
];
