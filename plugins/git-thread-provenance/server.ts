import type { BbPluginApi } from "@get-bb/plugin-sdk";

const threadIdPattern = /^thr_[a-z0-9]{10}$/u;

/** Провайдеры с git в оболочке агента. Тред «Каскада подписок» идёт нативным Claude Code или Codex. */
const PROVIDERS = new Set(["codex", "claude-code", "subscriptions-cascade"]);
export const appliesTo = (providerId: string): boolean => PROVIDERS.has(providerId);

export default function gitThreadProvenance(bb: BbPluginApi) {
  bb.agents.configure(({ provider, thread }) => {
    if (!appliesTo(provider.id)) {
      return { tools: [], skills: [] };
    }

    const validThread = threadIdPattern.test(thread.id);
    const trailerRule = validThread
      ? `Read BB_THREAD_ID from your execution shell. Use the single line BB-Thread: ${thread.id} only if BB_THREAD_ID exactly equals ${thread.id}.`
      : "Skip BB-Thread metadata for this session.";

    return {
      tools: [],
      skills: ["git-thread-provenance"],
      instructions: [
        "Git Thread Provenance. Follow the repository's rules and the user's restrictions on publishing identifiers.",
        trailerRule,
        "For your own new commit, add that line once as a Git trailer in the final trailer block. For a new PR you create, add it once as a separate paragraph after the human-readable reason. Skip the line if the ID is missing, invalid or mismatched, or the destination does not allow it. Use only the ID in that line. Keep private BB URLs, names, logs and personal data out of Git metadata.",
        "Apply this when creating the object. Do not amend commits, rewrite history or edit existing PRs solely to add or fix a marker. Preserve repository-required trailers and avoid copying another thread's marker into a newly authored message.",
        "After a successful push you perform, record the destination repository, branch or ref, and actual full SHA accepted for each updated branch in this working BB thread. Confirm the result from the push or remote; for a ref deletion say it was deleted. Leave commits unchanged.",
        "Resolve a marker with bb thread show <id> and a standard BB thread link, subject to the reader's BB access. The same ID can be looked up after archive.",
      ].join("\n"),
    };
  });
}
