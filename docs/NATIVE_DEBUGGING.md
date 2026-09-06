# Native debugging

garden includes curated Python and JavaScript debug adapters in its native runtime. Ask a task to
debug a program in its workspace, set breakpoints and inspect the paused program. The Computer view
shows the current session, source-linked stack, previously inspected values and program output.
Refreshing that view reads cached state; it does not evaluate expressions or expand objects.

A launch names a workspace program, argument vector and finite lifetime. Debug sessions use the
native filesystem, network and process-tree sandbox. They require the installed helper to report
those capabilities. The adapters are pinned by version and integrity hash in the native runtime
installation; the task cannot substitute an adapter or install an extension as part of debugging.

The task discovers the detailed schema through `process` with `action: "describe"`. Debug operations
use `action: "debug"` and the returned options schema. Start with `launch`, then read `status`.
When stopped, pass that status's `stopEpoch` as `epoch` to `stack`, `scopes`, `variables`, `evaluate`
or a resume operation. Stack frames include workspace paths and source hashes. References belong to
that stop; resuming invalidates them. `next`, `stepIn`, `stepOut` and `continue` advance execution.
`breakpoints` replaces the breakpoints for a named workspace file.

Launch, breakpoint configuration, live variable expansion, expression evaluation and execution
controls pass the approval floor. Object representations, getters, conditional breakpoints and
logpoints can run code. The approval identifies the stored program, directory, task and deadline;
call arguments cannot replace the stored session's identity. Cached `list` and `status` operations
do not need execution authority. The signed-in owner can end a session from the Computer view.

There is no arbitrary process attach, external debugger port, adapter replacement, terminal reverse
request or external source retrieval. The JavaScript adapter's internal child connection accepts
only its own pending target identifier and inherits the approved breakpoints before running.

Ending a session waits for debugger disconnect and native process-tree teardown. The UI reports
stopping while cleanup is pending. If teardown cannot be verified, the session remains visible and
the workspace stays busy for integration; the owner can retry ending it. A runner restart never
reattaches or replays the program. Explicit task stop, workspace teardown and the declared deadline
also stop debugging. Active debugging is included in retained-work health reporting so an update
can identify the runtime state it would interrupt.

Protocol behavior follows the [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/overview.html).
The curated adapters are [debugpy](https://github.com/microsoft/debugpy) and the
[standalone JavaScript debug adapter](https://github.com/microsoft/vscode-js-debug).
