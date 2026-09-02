# The external-benchmark instrument

```
pnpm eval:bench                  self-test, THE END-TO-END JOIN, catalogue weights, coverage  (~2.5 s, offline)
pnpm eval:bench --score          drive a real AgentWorker against the shim and score it       (~2 s, offline)
pnpm eval:bench --observe        re-sweep all 73 fixtures, rewrite routes.json                (~10 s, offline)
pnpm eval:bench --routes         print the committed observation and coverage
```

Offline, no key, no network, no provider, no Docker. Nothing in this directory can spend money.
Not part of `pnpm check`, like every other rig in `evals/`.

**This is an instrument, not a result.** There is no athanor benchmark score in this repository and
there is not one in this directory. What is here is the thing that has to exist and be trusted
before a score means anything, plus the exact command that would produce the first one and what it
costs. `parity.csv` is committed with its 44 columns and **zero rows**, on purpose.

`parity-wire.csv` is the one file here with a row in it, and it is **not a score**: see section 2.5.
It is one task, solved by a scripted model, verified by a command in a real directory. Its `model`
column says `scripted-no-provider` in every row it will ever have.

---

## 1. The route-fidelity instrument, which is the point

### The failure it exists to prevent

athanor's loop reaches its workspace through one client, constructed once from one global
`WORKSPACE_RUNNER_URL` (`apps/worker/src/agent.ts:291`). Point that URL at a shim over a benchmark
container and the whole loop - catalogue, approval floor, compaction, tools - runs against the task
with no change to `apps/` or `packages/`. That seam is not new; `evals/harness.ts` already
intercepts it for all 73 fixtures.

The trap in that design is that **a shim missing a route athanor needs does not throw.** Three
production sites swallow the miss deliberately:

| site                                                 | what it does                     | what it costs a benchmark row                                                        |
| ---------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| `apps/worker/src/agent.ts:1301` `#toolchainSummary`  | `.catch(() => null)`             | the runtime block loses the line saying what the box can do with documents           |
| `apps/worker/src/agent.ts:1327` `#machineSummary`    | `.catch(() => null)`             | the block loses the three numbers that decide how a job is sized                     |
| `apps/worker/src/agent.ts:1354` `#workspaceSurfaces` | falls back to `UNKNOWN_SURFACES` | **the full catalogue**, about 11.7 kB per request, on a box that has neither surface |

Each is the right decision for a product: a task that will not start is worse than a task missing a
line. Each is fatal to a benchmark row, and the third is worst - it silently changes which
configuration was measured. The run completes, the score is real, and the row's declared arm is a
different box than the one that ran.

That is the same failure shape the design research rejected `BaseInstalledAgent` for. It is just as
available inside the design that replaced it, which is why this instrument was built first.

### What it does

`evals/harness.ts` grew one field - `RunOutcome.observedRoutes` - recording every runner route a
fixture reaches, modelled or not. That is a four-line additive change: a `string[]` on the stub's
state, one `push` at the top of `runnerResponse`, the field on the outcome, and the empty default.
Nothing in `evals/report.ts` reads it and no committed baseline row can move because of it.

(That is the first of two changes to `evals/harness.ts` this directory has needed. The second is
`Fixture.workspaceUrl`, and it is in section 2.5.)

**Why the harness had to be touched at all.** `RunnerState.unstubbed` already existed, but it is the
_complement_ of this list: it records only routes the stub does not model, and a shim built from it
would implement nothing, because that stub answers everything these fixtures reach. `runnerResponse`
is module-private, and `runFixture` installs its own `globalThis.fetch` for the duration of a run,
so an outer wrapper never sees runner traffic. There is no exported seam. The change is the
smallest one that reaches it.

### What it found, on the first run

**15 distinct routes across 73 fixtures.** The full artefact is `routes.json`.

```
  71  GET  /file          71  GET  /machine       71  GET  /surfaces     71  GET  /toolchain
  32  POST /checkpoints   27  POST /exec          25  GET  /usage        20  PUT  /file
  12  GET  /files          5  POST /browser/read-many                     4  GET  /image
   4  POST /toolchain/probe    2 POST /browser/search
   1  POST /browser/snapshot   1 POST /desktop/snapshot
```

Three findings, none of which a route list read off the runner's source would have produced:

1. **`GET /machine` is unstubbed in `evals/harness.ts` at `8d701a0`.** The route was added to the
   loop in `89185c6` and the fixture stub never grew an answer, so 71 of 73 fixtures currently
   measure a 404 on it. `evals/report.ts:165` catches it only because that rig has an explicit
   never-declarable assertion on `unstubbedRoutes`. **This is not this lane's to fix** - the fix
   moves committed baseline rows - but it is exactly the defect this instrument was built to find,
   and it was live in the tree before the instrument existed.
2. **`GET /image` is reachable on a box with no browser and no screen.** `image_read` is not one of
   the seven tools the catalogue gate withdraws (`apps/worker/src/tool-catalogue.test.ts:688-700`),
   so a benchmark container can still be asked to look at a PNG the task shipped. A shim built from
   the research's fourteen-route list would have been missing it.
3. **`web_search` and `parallel_web_read` survive a bare box too.** The comment at
   `tool-catalogue.test.ts:700` says so outright. So `POST /browser/search` and
   `POST /browser/read-many` are reachable on a container with no Chromium.

### The three categories, and why a shim needs all three

|                            | what it means                                                             | what the shim does                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **implemented** (21)       | the loop asks and the box can answer                                      | answers for real, over the backend                                                                                                                |
| **declared absent** (3)    | the loop can legitimately ask and this box genuinely lacks the capability | HTTP 503 with a message the _model_ reads: "This computer has no browser". Counted, and the count reaches the artefact as `absent_route_requests` |
| **miss** (everything else) | the loop asked for something nobody modelled                              | recorded in `shim.misses`, **and `parity.ts` refuses to emit a row for the run**                                                                  |

The middle category needs its own defence, because "answer it with an error" is the shape of every
bad shim. The difference is that a declared absence is a _statement the model can act on_, and a
miss is _silence it works around_. The seven surface-gated routes stay misses on purpose: on a box
answering `absent, absent` the catalogue gate withdraws their tools, so reaching one means the gate
did not hold, and that is a finding worth voiding a run for.

**The 501 status is not the guard.** `agent.ts` catches three of those into a shrug. `shim.misses`
is the guard, and `selftest.ts` proves it by driving an unimplemented route and then watching
`rowFrom` refuse.

### The honest limits of the observed set

- **It is a floor.** It is what these 73 scripted fixtures happened to drive. `routes.json` also
  carries `declaredButUnobserved` - paths `apps/worker/src` can build that no fixture reached
  (`/audio/prepare`, `/processes/stop-owner`) - and that scan is a text scan, advisory in both
  directions, because several call sites build their suffix from a variable.
- **It was taken on the wrong box, and the artefact says so.** `evals/harness.ts:1123` answers
  `/surfaces` with **both surfaces available**. A Terminal-Bench container has neither, so the
  observed set contains two routes a benchmark box cannot reach. `routes.json` records the sweep's
  surfaces and `coverageOf` subtracts the gated seven only when the sweep's box differed.
- **The subtraction is read, not measured.** This rig has not observed a run under
  `absent, absent` and watched those routes fail to appear. It reads the gate's own test and the
  single production line that applies it (`apps/worker/src/turn/claim.ts:245`). Doing better means
  changing the `/surfaces` answer every row in `evals/baseline.json` was measured under.

---

## 2. The shim

`shim.ts` speaks athanor's runner protocol; `backend.ts` turns it into commands in a box.

**Two backends behind one three-method interface** (`ensure`, `exec`, `dispose`):

- **`local`** - a `mktemp` directory on this machine. No daemon, no image, no privilege. This is
  what makes the shim testable here and in CI. It is **not a sandbox**: commands run as this user
  with this user's network.
- **`docker`** - `docker exec` into a container the benchmark's own task definition created. Not
  exercised anywhere in this repository, because there is no container runtime on the machine it
  was written on. What _is_ proved is `dockerExecArgv`, a pure function holding every decision the
  backend makes that does not need a daemon: flag order, `--workdir`, `--env`, `sudo -n` (never a
  prompt), and that stdin is attached only when there is stdin.

### The join is driven, not assumed

`wiring.ts` constructs **`AgentRunnerClient` from `apps/worker/src/runner-client.ts`** - the
production class `apps/worker/src/agent.ts:291` builds and every tool call goes through - points it
at the shim's listening port and calls its real methods. `selftest.ts`'s route table sends requests
_this rig composed_ to answers _this rig parses_; if the shim's answers were shaped for the rig
rather than for athanor, every check in that table would still pass. That is the
computed-and-unwired shape, and it is the one this programme keeps finding.

It earned its place on the first run: it was written expecting a five-line file to report five
lines, and athanor's client said six. `services/workspace-runner/src/files.ts:376` counts
`1 + newlines`, so a file ending in a newline has an empty last line. `file_read` prints that
number to the model and `file_patch` addresses lines by it. A route table could not have found
that, because the rig would have been agreeing with itself.

It does not prove a whole turn on its own. That is section 2.5, which does.

**Every file operation is built on `exec`** rather than on `node:fs`. That is the load-bearing
choice: the file code proved by the local backend on a laptop is byte-identical to the code the
container backend runs. The alternative would have given the tested implementation and the shipped
one nothing in common but a type.

### What this shim necessarily drops

These belong in the artefact beside any score, and `parity.csv` has a `declared_drops` column for
them:

- **The capability token.** The real runner verifies a signed token per request
  (`services/workspace-runner/src/auth.ts:36`). This one binds loopback and verifies nothing.
- **The Landlock sandbox and the rlimits.** `execute()` applies both; this shim applies neither.
- **Per-call egress gating, on the local backend.** A child process here shares the host's network
  namespace and nothing in this rig can take that away. `isolates_network` is a column, and it is
  `false` for every local-backend row. On the docker backend it is a property of how the caller
  started the container, so it is a **parameter**, not an assumption: a shim that assumed `--network
none` would print "egress gated" on the strength of nothing.
- **Binary file writes.** `ExecCall.stdin` is a string in the runner's own schema, so the shim
  refuses a non-UTF-8 write by name rather than writing mangled bytes the verifier would read as
  wrong work.
- **Stopping background work.** `processes/stop-owner` answers honestly that it stopped nothing.
- **The EXIF strip on `/image`.** The real runner re-encodes; this one passes through a type the
  gateway already accepts and refuses anything else by name.

---

## 2.5 The join, whole: `--score`

Everything above this line was proved in isolation. `wiring.ts` drove athanor's own client over the
socket, which is the wire; **no `AgentWorker` had ever run against this shim**, so the loop, the
tool dispatch, the approval floor, the acceptance hold and the score were each argued for and never
joined. That is the computed-and-unwired shape this programme has now shipped three times.
`score.ts` is the line that was never written.

```
pnpm eval:bench --score
```

builds the real `AgentWorker` the way `evals/harness.ts` builds it, points `WORKSPACE_RUNNER_URL` at
this shim's listening port, runs one task to completion against a real temporary directory, and
lets **a command in that directory** decide whether it was solved. It is also part of
`pnpm eval:bench` itself, as a self-test check rather than behind a flag: the join is the thing this
directory was three times found not to have, and a check that runs only when somebody remembers a
flag is a check that is not running when it breaks. It costs about 0.4 s.

**Real:** `AgentWorker.run`, the catalogue, the tool dispatch, the plan and acceptance holds, the
approval floor, compaction, the runner protocol, the shim, the box, the files, the verifier.
**Not real:** the model. It is a script, so no provider is called and nothing is billed. A benchmark
task whose solution is a fixed sequence of shell commands is exactly the shape a script can drive.

**So the row is not a score.** It goes to `parity-wire.csv`, never to `parity.csv`, through the same
`rowFrom` and the same 44 columns and the same refusals. `model` reads `scripted-no-provider`. The
file is rewritten by every `--score`, and `run_started_at` and `wall_seconds_mean` move each time -
it is a record of the last run, like `routes.json` is of the last sweep, not a tracked baseline.

### The one harness seam it needed

`Fixture.workspaceUrl` in `evals/harness.ts`. `runFixture` installs its own `globalThis.fetch` for
the duration of a run, so an outer wrapper never sees a runner request, and `WORKSPACE_RUNNER_URL`
was a module constant - there was no way to ask for the loop's runner traffic to leave the process.
The field is one config value and one branch, forwarding only URLs that start with it. Every fixture
in `evals/fixtures.ts` leaves it absent and is byte-for-byte unaffected: measured by running
`--observe --filter files-helper-script-then-run` against `HEAD`'s harness and against this one, and
diffing the output. Identical. `pnpm eval:gate --filter files-helper-script-then-run` passes.
`RunOutcome.approvalsRaised` was published beside it, because `askedOwner` is a boolean and
`approval_cards_fired_mean` is a column.

### What the join taught us, which is the point of building it

1. **Neither `status` nor `verification` separates a solved task from a knowingly unsolved one.**
   Break the solution so it writes the LINE COUNT (7) instead of the sum (1260) and the run reports
   `status=completed verification=verified`, **identically to the correct run**. The turn's own
   acceptance check ran in the box and failed, four times
   (`MAX_ACCEPTANCE_FAILURES`, `apps/worker/src/turn-bounds.ts:360`); past the ceiling
   `apps/worker/src/turn/finish.ts:320` appends the failures to `remainingRisks` and leaves the
   status the model declared. That is a defensible product decision - the owner reads the risks -
   and it means **a benchmark adapter that scored on either field would have scored that run 1**.
   The verifier in the box was the only thing that told them apart. It is the whole argument for
   taking the verdict from the box, and it is now measured rather than asserted.
2. **The surface gate is observed at last, not read.** `routes.ts` stated as its honest limit that
   nothing here had ever watched a run under `absent, absent` and seen the seven surface tools gone.
   The scored turn is that run, and `selftest.ts` asserts the catalogue it was offered - names
   derived through `agentToolsFor`, never listed. Point the runner back at the fixture stub, whose
   `/surfaces` says both available, and all seven reappear.
3. **The holds cost three steps on a wrong answer and one on a right one.** Right answer: 5 model
   calls, **65,569 prompt tokens**, one `acceptance_hold`. Wrong answer: 8 calls, **107,419 prompt
   tokens**, one `acceptance_hold` and three `acceptance_failed`. Both measured, both in
   `parity-wire.csv`'s own `input_tokens_mean` column. So discovering the work was wrong cost
   **41,850 tokens, 64% again on top of the whole task** - which on a paid run is real money, and
   which no other harness in this field pays or reports. It is also, on a benchmark, entirely
   wasted: the task scores 0 either way. That is the `shipped`-arm tax made concrete.
4. **The catalogue is 64% of what a short task's prompt weighs.** 65,569 prompt tokens over 5 calls,
   of which 8,389 per call is catalogue: 41,945 of 65,569. On the _benchmark_ box, after the
   withdrawals - the provisioned box would be worse.
5. **The stationary watch caught this rig's own bug.** The first script read the whole window for a
   hold marker rather than the last message, so it answered the acceptance hold four times with
   byte-identical arguments. `NOTHING HAS CHANGED FOR 3 STEPS. Every one of them made the same call
   - set_acceptance - with byte-identical arguments.` The mechanism worked; the script was wrong.
6. **A missing route is a refused run, driven live.** Remove `POST /exec` from `IMPLEMENTED_ROUTES`
   and the real turn burns all 12 steps, hits `STEP BUDGET EXHAUSTED`, reports its acceptance check
   as "could not run" - and `rowFrom` refuses the row. `parity-wire.csv` is left with its header and
   nothing else, so a voided run cannot leave a stale row behind. Exit 1.

### What `--score` still cannot do

- **Only the `shipped` arm.** `evals/harness.ts`'s `taskFor` mints the task `balanced`. `autonomous`
  needs that field settable and `unattended` needs an auto-approver as well. `--arm` refuses
  anything else rather than printing a row that names a configuration it was not measured under.
- **One task, and its solution is written here.** It measures the wire, not the agent.
- **`local` backend only.** The docker backend is still unexercised on this machine, and `score.ts`
  refuses a task whose `origin` is not `builtin` on the local backend without `--trust-local` -
  which is a guard `backend.ts` had promised in prose since it was written and which existed nowhere
  in the repository until now.

---

## 3. The counter-argument, and what athanor should report

**The case against benchmarking athanor at all.** Every design commitment it has is a cost on a
leaderboard, and the costs are athanor's own and measurable:

- **The catalogue.** 37,340 bytes on every request of every turn on a benchmark box, measured
  below. A scaffold built only to solve coding tasks sends a fraction of that.
- **The approval floor.** athanor stops for what the computer cannot take back even in
  `autonomous` (`apps/worker/src/approval-policy.ts:692`), and a card that fires with nobody at
  the keyboard parks the task in `awaiting_user`, which scores 0.
- **Compaction and the sandbox.** Both cost tokens and steps that a benchmark rewards nobody for.

The reference figures the design research quotes for other harnesses -
`docs/design/research-2026-08-25/benchmarks.md` - are **recorded there and not verified here**, and
this rig fetched nothing from the network. Two of them carry the argument if they hold: that the
published harness adapters run unsupervised by default, so **every leaderboard number in this field
is an unsupervised number**, and that the highest published scores came from a configuration with
no sandbox, no approval and no compaction. That configuration is a model under near-ideal harness
conditions. It is not a product anyone installs.

So: does athanor benchmark the product, or a stripped configuration that is not the product?

**Both, and the resolution is to refuse to publish one number.** `parity.csv` carries an `arm`
column and the run refuses to emit a row whose arm is unset:

- **`shipped`** - `balanced`, nobody answering. A card that fires ends that task at 0. **This is
  what the owner installs.**
- **`autonomous`** - `autonomous`, still nobody answering. The irreducible floor still fires.
- **`unattended`** - autonomous plus an auto-approver. **This is what every other number in the
  field already is**, and the only arm comparable to a leaderboard.

**The gap between `shipped` and `unattended` is the price of the approval floor in benchmark points,
and nobody in this field publishes it.** That number is more interesting than athanor's rank.
Publishing `unattended` alone would be dishonest; publishing `shipped` alone would be a number
nobody can compare to anything. A row with `approvals_auto_answered > 0` under any arm but
`unattended` is refused as fabricated.

### The catalogue charge, measured rather than repeated

The design research put the tax at 12,508 tokens per call and 39.9% of every prompt token the eval
suite bills. That is a real measurement of the **wrong box**: the eval harness answers `/surfaces`
with both surfaces available, and `claim.ts:212` withdraws `connector_action` outright on a box with
no connections. `catalogue.ts` measures the real thing through the production function, printed on
every run of this rig:

|      bytes |    tokens | box                                                                                   |
| ---------: | --------: | ------------------------------------------------------------------------------------- |
|     55,673 |    12,508 | fully provisioned, all five connector kinds - **what `evals/baseline.json` measures** |
|     49,032 |    11,016 | a browser and a screen, nothing connected                                             |
|     39,586 |     8,894 | no browser, no screen, one connection                                                 |
| **37,340** | **8,389** | no browser, no screen, nothing connected - **the benchmark box**                      |

The top row reproduces, to the byte and to the token, the two figures this repository already
commits to elsewhere: 55,673 bytes at `apps/worker/src/tool-catalogue.test.ts:749` and 12,508
catalogue tokens per call in `evals/baseline.json`. That agreement is what makes the bottom row
worth reading, and `selftest.ts` fails if the anchor drifts by more than 2%.

So athanor already withdraws about **18 kB, roughly a third of the catalogue**, before a benchmark
run starts - and it does it without being asked, because connectors and surfaces are gated per box.
The honest residual charge is **37,340 bytes, about 8,400 tokens per call, of non-withdrawable core
tooling**, which a purpose-built coding scaffold does not carry. Still a real charge. It does not
need the overstatement, and the arm ladder does not need a fourth `lean` rung - see the comment on
`Arm` in `parity.ts` for why that rung would have measured nothing.

**What athanor should report: all three arms, with the knobs as columns.** An instrument that hides
its own configuration is the thing the research criticises the whole field for, and the columns
`security_mode`, `task_max_steps`, `self_continuations`, `max_compute_credits`, `surfaces_*`,
`catalogue_bytes`, `isolates_network`, `verifier_env` and `declared_drops` exist so that a reader
never has to go and find a default in a Python file.

---

## 4. The parity CSV

44 columns, zero rows. Four disciplines are **enforced in code**, not documented:

1. **The aggregator is `mean` and it is a column.** `Max` over n attempts silently turns pass^1 into
   pass@k. `aggregate()` has no other mode.
2. **A missing result scores 0, never dropped.** `scoreOf` divides by the _declared_ `n_tasks`, not
   by what the run produced.
3. **Infra-failure classification is advisory and never moves the denominator.** It is its own
   column so a reader can discount the row themselves.
4. **A task that starts solved is not a task.** `scoreTask` runs the verifier _before_ the turn and
   refuses the run if it passes. Measured 2026-09-02 without it: a `seed` carrying the answer and a
   solution replaced by `true` scored 1, exited 0, and the self-test said "clean" - every other
   signal, `commandsRun` included, read exactly as on the honest run. This is the guard the
   Terminal-Bench loader will need on its first day, because a leaked answer arrives as a free
   point and looks like a score.

`score_std` is a **sample** standard deviation and is empty below two runs - a zero standard
deviation from one run is the most flattering lie available here. Three runs is the floor for a
credible row.

---

## 5. The paid command

Nothing above costs anything. Here is what does.

**Prerequisite, and it is not the blocker the research named.** The VPS is container-ready _today_.
Measured read-only on 2026-09-02: `sudo -n docker info` returns `29.1.3`, 16 CPU, 31.3 GiB,
`overlayfs`, and `/` has 746 G free. `administrator` holds `(ALL) NOPASSWD: ALL`. The empty `docker`
group is an ergonomic question (`usermod -aG docker administrator`, which the operator can do
themselves), not an owner action. There is no `uv` on the box; Terminal-Bench's own harness wants
one.

**Step A - the container proof, $0 in tokens, about an hour of wall clock.** Pull one Terminal-Bench
2.0 task image on the VPS, start it, and run this shim's docker backend against it with the task's
shipped oracle solution. This proves the container, the verifier and the exec/file plumbing. **It
does not prove route fidelity** - an oracle runs a solution script and never exercises `/surfaces`,
`/machine`, `/toolchain` or `/checkpoints`, which is precisely why the route instrument above is a
separate, already-completed step.

**Step B - the first athanor number.**

```
# on administrator@85.190.100.211, inside a scratch dir, with a provider key in the environment
OPENROUTER_API_KEY=…  pnpm eval:bench --score \
    --benchmark terminal-bench-2.0 --tasks <20-task subset> \
    --model <mini-class model id> --arm unattended --runs 1 \
    --backend docker --container-per-task --surfaces absent
```

- **needs**: a provider key, which this repository holds nowhere by design; the 20 task images
  pulled; `--trust-local` is not enough - a benchmark's own task commands belong in a container, so
  this is `--backend docker`. **`--score` now exists** and drives a real `AgentWorker` end to end
  (section 2.5). What it does not yet have is the four flags above it: `--benchmark` and `--tasks`
  need a Terminal-Bench task loader (prompt, seed files, verifier argv - the `WireTask` shape in
  `task.ts` is already that shape, so it is a loader and not a redesign); `--model`, `--runs` and
  `--backend docker` need the provider seam and the container backend that `dockerExecArgv` is
  already written for; `--arm unattended` needs a settable `securityMode` and an auto-approver,
  which is the one part `rowFrom` will refuse a row for until it exists.
- **costs**: about **$17** in tokens at a mini-class model, call it **$40** with retries. Derived
  from `evals/baseline.json`'s own measured numbers, adjusted for the 37,340-byte benchmark
  catalogue rather than the 50,404-byte provisioned one.
- **takes**: about half a day of wall clock. Terminal-Bench 2.0's own per-task agent timeouts
  average **at least 1,449 s** over the 78 of 89 tasks whose timeout is recorded (11 unrecorded, so
  that is a floor): at `WORKER_CONCURRENCY` 8 on 16 vCPU, a full 89-task run is **>= 4.5 h**.
- **it will be a bad number.** Publish it anyway.

**Step C - the arm ladder**, the artefact nobody else has: the same 20 tasks at `shipped`,
`autonomous` and `unattended`. Four times step B's cost per model.

**Step D - the parity row.** The same task set and the same model, run twice: once through athanor
and once through the reference harness the leaderboard names, 3 runs each. About **$360** at a mini-class model, **$3,600** at Sonnet-class (honest range $2,500-5,000).
Two days on the VPS. Do not start at SWE-bench Verified: 500 instances at 3 runs is about $12,500.

---

## Why this is not a gate

`pnpm eval:bench` exits non-zero on a self-test failure, on a route athanor asks for that the shim
does not implement, or on the end-to-end task failing its verifier; `--score` exits non-zero when a
task does not resolve or when `rowFrom` refuses the row. So it is usable in CI on its own schedule.

It is deliberately not in `pnpm check`. The default run is about 2.5 s and drives one real turn;
`--observe` sweeps all 73 fixtures through the real `AgentWorker` and takes minutes. A suite that
blocks every commit is a suite somebody deletes the first week it is wrong about something - and
this one is deliberately coupled to the loop's own holds, which move for good reasons.
