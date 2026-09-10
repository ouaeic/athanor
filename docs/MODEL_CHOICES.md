# Model choices

The prompt, project and settings editors use the connected catalogue and preserve concrete model
identities. Search includes the provider, display name and model ID. Unavailable saved choices stay
visible so an editor cannot silently replace them.

A new prompt carries optional `modelChoices` in its encrypted draft and create request. Task
creation stores these in the existing encrypted project preferences within the task transaction,
before execution starts. A failed preference write rolls back task creation. Existing callers can
omit the field. Global text preferences include summarising and naming alongside specialist and
coding work; older preference records remain valid.

Project editors save explicitly against the revision they loaded. A conflict retains the draft
and offers a reload, without overwriting a newer revision. Settings show success only when their
writes finish, including provider routing. Credentials remain in the existing provider store;
catalogue discovery, provider terms, privacy routes and the approval floor are unchanged.

API checks cover encrypted draft and project round trips, creation rollback and owner isolation.
Browser checks cover reload persistence, failed saves, keyboard model search, unavailable selections
and spacing around prompt and result controls.
