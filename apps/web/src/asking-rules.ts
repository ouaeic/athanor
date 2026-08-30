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
 *
 * It was six for one wave. "Running a repository's own build" was added when `code_diagnostics`
 * gained a branch above every `securityMode` test, and removed with that branch: the same build
 * recipes run through `shell` without asking, so the line promised the owner a floor that a
 * rephrasing walked around, and it charged their own Rust project for their own code. What replaced
 * it is not a line on this page - it is an undo point the turn takes before the build runs, in
 * `apps/worker/src/turn-bounds.ts`, and a page listing what always asks is the wrong place to
 * describe something that never does.
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
    what: 'Publishing a package anyone can install',
    detail:
      'npm, pnpm, yarn, cargo, twine, gem, poetry, mvn, gradle, dotnet nuget, docker and helm — publishing a version, withdrawing one, or re-pointing a tag. A version that has reached a registry cannot be taken back from here: npm allows an unpublish for 72 hours and crates.io allows none at all.'
  },
  {
    what: 'Removing or overwriting data',
    detail:
      'rm, shred, mkfs, git reset --hard, find -delete, rsync --delete, removing a package — including inside a script, an xargs, or a desktop window.'
  },
  {
    what: 'Pushing to a Git remote',
    detail: 'Every git push. Fetching, branching and committing locally do not ask.'
  },
  {
    what: 'Leaving something behind to run later',
    detail:
      'A shell startup file, a git hook, git config that carries a command, a coding tool’s own configuration, a service that restarts itself, scheduled work, a saved skill, or a memory entry with no expiry. Each of these runs after the conversation is over, when no card can be raised.'
  }
];

/**
 * What each mode stops for, in one sentence each.
 *
 * A COPY. These three strings are held character for character against `SECURITY_MODE_FLOOR` in
 * `apps/worker/src/approval-policy.ts` by `scripts/check-repository.mjs`, because that record is
 * what the floor actually reads: the three sites that decide a mode's behaviour read its fields, so
 * a mode whose behaviour changes and whose sentence here does not fails the build. The page cannot
 * import from the worker, and the alternative to a checked copy is the drift this replaced - the
 * page describing Autonomous as Balanced minus two rules while the two produced the same number of
 * cards on the owner's own work, and the always-resident contract promising in a third wording that
 * public publishing always stopped while `npm publish` ran unasked in every mode.
 *
 * Layered rather than repeated: Review names what it adds to Balanced, Balanced what it adds to
 * Autonomous, and Autonomous is the floor all three share.
 */
export const modeFloors: Record<'review' | 'balanced' | 'autonomous', string> = {
  review:
    'Every command, every file written, and every browser or desktop action, on top of everything Balanced asks about.',
  balanced:
    'Reaching an address out on the internet, and installing software onto it, on top of everything Autonomous asks about.',
  autonomous:
    'Only what this computer cannot take back for you — publishing, sending, spending, destroying data, agreeing to something on your behalf, a startup file, hook or tool configuration it would run on its own afterwards, and a control on a screen that nothing could identify.'
};

/**
 * The whole of what changes between the two modes an owner actually chooses between.
 *
 * Two rules, both in `ordinaryRequirement` and both now reading a named field of
 * `SECURITY_MODE_FLOOR` rather than comparing a mode inline: `asksBeforeInstallingSoftware` and
 * `asksBeforeReachingTheInternet`. Naming them is the only way the choice can be made on evidence —
 * "works normally" and "works independently on reversible steps" are the mode descriptions, and an
 * adjective is not something anyone can act on.
 *
 * The second line used to say "Balanced asks every time" about a `network: true` the model wrote
 * itself, which the runner ignores - so a command that omitted the flag reached the same internet
 * with no card, and the difference between the modes was a self-declaration. Both rules now open on
 * an address the harness read out of the command, so what is described here is what the command
 * does rather than what it says about itself.
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
      'Balanced asks whenever a command reaches an address outside this computer — read from the command itself, not from anything the agent claims about it. Autonomous runs the read-only ones — fetching a page, git fetch, a package install — and still asks for uploads, for publishing, for anything else that opens a socket, and for any script it cannot read.'
  }
];
