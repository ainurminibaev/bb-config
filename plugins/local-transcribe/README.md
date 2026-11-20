**English** · [Русский](README.ru.md)

# Local Transcribe

Transcribes audio and video recordings with speakers and timestamps on your own
machines through BB executors: a Mac with a GPU first, then ready fallback
machines by the call's policy. The project's agent then prepares summaries,
decisions, tasks and a PDF. Nothing goes to a cloud speech service unless you
choose one.

- **Updates**: the Python engine ships inside the plugin's host package; after
  one plugin update in BB, executors receive the versioned code on first use and
  their environments are prepared automatically. Running jobs keep their
  directory; model weights and results are kept.
- **Notifications**: a job submitted with a thread id wakes that thread once
  with the result or error.
- **Requirements**: connected macOS/Linux machines with Python 3.10+ and ffmpeg;
  new environments and models need access to public package and weight
  repositories. Speaker numbers are not identities — naming people needs review.

Settings: `workerHosts` (machine ids of executors, kept private), `autoSetup`.
Check: `bb plugin rpc call local-transcribe services --json`.

Part of the [bb-config](../../README.md) set: `python3 scripts/updates.py apply` from the repository root installs it with everything else. A working installation may use its own Git source of the plugin; the
set keeps it. Alone: `npm ci --ignore-scripts`, `bb plugin build .`,
`bb plugin install . --yes`. Overview for the catalog: `PLUGIN_OVERVIEW.md`.
