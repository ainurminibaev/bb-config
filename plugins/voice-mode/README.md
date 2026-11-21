**English** · [Русский](README.ru.md)

# Voice Mode customizations

Reviewed source edits for upstream Voice Mode 0.1.15. This directory is a
reproducible patch, not a replacement plugin. The installed plugin stays on its
catalog Git source. Voice Mode Keeper automatically validates and restores the
edits after compatible updates. A changed API or failed validation leaves the
original release available and reports a compatibility warning.

Changes:

- Russian first-person speech, without describing a separate agent to the user.
  This also covers work-tool descriptions, acknowledgments, results and status
  reports: one conversational identity, accurate results, no delegation narration.
  Direct questions about architecture must still be answered truthfully.
- A compact waveform button beside the native microphone starts Voice Mode
  from the new-thread screen, including phone layouts. No full-width banner is
  shown. It creates a normal visible thread with the selected
  project, environment/machine, provider, model and permissions, sends a brief
  readiness-only setup message, then opens voice and navigates to that thread.
  It never replaces a nonempty draft; the button is disabled until the draft is
  sent or cleared. Navigating away while creation is pending prevents a delayed
  microphone activation. The setup uses the existing agent allowance.
  Its placement helper follows composer rerenders and releases its observer
  and portal on unmount; the fallback is also a compact button.
- A random short Russian greeting from 30 serious and playful phrases after
  the client microphone and audio player are ready. The previous phrase is
  excluded during the lifetime of the loaded plugin (a reload resets it).
  This includes stopping and starting again. No tools or thread context in
  that greeting; no greeting over a user who has already begun speaking.
- Preserve the native dictation button when BB puts it in the mobile submit
  group. During a live session the existing pill still owns the microphone;
  end the conversation before recording an ordinary audio message.
- Server speech detection with a higher threshold, noise reduction, Russian
  transcription, and a 900 ms pause before answering. Remove the local
  amplitude-only playback interruption, which could mistake noise for speech.
  Intentional interruptions still use the server's speech-start event.

Inspect/apply on the machine running the BB server:

```sh
python3 plugins/voice-mode/apply.py
python3 plugins/voice-mode/apply.py --apply
python3 scripts/snapshot.py --settings-only
python3 scripts/snapshot.py --check
```

Applying rebuilds/reloads the managed plugin and ends any current voice session.
Changed source and bundles are backed up under ignored `.local/plugin-patches/`;
build/reload failures restore that backup. No credentials or audio are copied.
The manual script refuses unknown versions/ambiguous edits. Catalog updates
are handled by the keeper, using `auto_update.py` in staging: any version is
attempted, anchors may move or be reformatted but must be unique, and staging
tests decide; no manual reapply is needed. Incompatible source contracts still require
adapting `changes.json`. To remove the customizations, disable the keeper, then reinstall the
original `voice-mode` catalog entry and keep the existing subscription settings.

New settings (next session): `vadThreshold` (default 0.7),
`silenceDurationMs` (900), `noiseReduction` (`far_field` for a phone/laptop;
`near_field` for a headset). Lower the threshold if quiet speech is missed.
Noise reduction cannot guarantee rejection of nearby voices or television.
The general restore skips these three keys until the patch is installed.
`apply.py --apply` restores their saved values from the private snapshot, even
when the source edits are already present.

The selected voice is saved in the private plugin settings (currently
`shimmer`, changed from `marin`). ChatGPT's Juniper is not among this Realtime
connection's supported voices; no exact mapping is claimed. Speech instructions
request natural, calm Russian conversation without announcer-like intonation.

`changes.json` also carries regression tests appended to the upstream backend
suite: readiness, repeated readiness, speaking before readiness, tool-free
greeting, and speech configuration. Verify in an isolated copy with upstream's
dev dependencies using `npm test` and `npm run typecheck` before applying.
`mobile-check.js` is a Browser Automation fixture at 390 px: dictation remains
visible while idle, is owned by the live voice pill during a session, and
returns when the session ends. This fixture is not a signed-in mobile device
test. The upstream suite plus added regressions passes 51 tests, including
30 unique greetings and exclusion of the last choice. A live
subscription check accepted the noise settings and returned the spoken phrase
«Я готов. Что сделать?» without provider errors.

The keeper preserves only allowlisted nonsecret preferences, waits for BB's
update job to finish, and validates upstream tests, types and build before
activation. It uses the pinned toolchain in `plugins/voice-mode-keeper`, so
ordinary updates do not download dependencies. Rollback and restart recovery
are tested by `test_auto_update.py`; the original source is not modified when
staging checks fail. After successful checks the private snapshot is refreshed.

Upstream code excerpts in the patch remain under the MIT license; see
[UPSTREAM_LICENSE](UPSTREAM_LICENSE).

The thread Voice Mode start action is available while the coding agent runs,
and while a text draft is present. The voice session starts separately; the
native send/stop replacement still requires the original empty-and-idle
condition, so starting voice never hides an active task's Stop control.

Waiting behavior: after a successful request the voice acknowledges briefly and
waits for the thread result; it must not equate a pending result with missing
project context. Presence questions stay local, status questions use the existing
status tool. Active/starting status no longer includes the previous task's output,
which could incorrectly sound like the answer to the current question. A pending
UI interaction is reported separately. Finished results still retain uncertainty.
This changes existing instructions/status replies, not routing or transcript storage.
Verify installation with `python3 plugins/voice-mode/apply.py --check`.
Backend tests cover stale output exclusion and finished result delivery; actual
spoken phrasing remains model-dependent and requires a live voice acceptance check.

## Fork releases and native updates

Source: https://github.com/ainurminibaev/bb-plugin-voice-mode, branch
`main`. Stable releases are installed with `@^0.2.0`; BB discovers
compatible 0.2.x tags through native plugin updates. Use the Plugins screen or
`bb plugin update voice-mode`. The shared fix is proposed in upstream PR #7.

`fork.json` records the repository/range and the old pin only for migration.
Keeper skips patching this release channel, including newer compatible versions;
it does not hash-lock fork files. The legacy patch remains for catalog recovery.
Source development and releases belong in the fork. bb-config records installation
and settings; a bb-config release is not needed for each Voice Mode release.

Migration from the original catalog or the old pin:
`python3 plugins/voice-mode/switch_to_fork.py --apply`, then `--check`.
BB's managed-source change needs remove/install. The script refuses configured
Voice Mode secrets before removal, preserves nonsecret settings and enabled state,
and leaves connection-plugin credentials alone. Recovery uses the private journal.
If an install fails before registration, it restores the prior source; failures
following registration require inspection of the current install and journal.
A reinstall ends the active voice session. Do not blindly remove configured secrets.
