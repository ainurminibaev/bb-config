// Pure helpers for snapshots: what to skip and what looks like a secret.

export const MAX_SNAPSHOT_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_SNAPSHOT_FILES = 20_000;
export const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', 'dist', 'build', '.next', '.nuxt', '.cache', '.turbo', 'target', '.gradle', 'Pods', 'DerivedData', '.DS_Store', '.Trash']);

const SECRET_NAMES = [/(^|\/)\.env(\.|$)(?!example|sample|template)/i, /(^|\/)id_(rsa|ed25519|ecdsa)$/, /\.(pem|p12|pfx|key)$/i, /(^|\/)credentials(\.json)?$/i, /(^|\/)\.netrc$/];
const SECRET_TEXT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{50,}\b/,
  /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{32,}\b/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b\d{8,10}:AA[0-9A-Za-z_-]{30,}\b/,
];

/** A file that should not leave the machine: by name, or by a known token shape inside. */
export function findSecrets(file: string, text: string): boolean {
  if (SECRET_NAMES.some(re => re.test(file))) return true;
  return SECRET_TEXT.some(re => re.test(text));
}

/** Service ref for one folder's snapshot; environment ids are stable and unique per folder. */
export function snapshotRef(environmentId: string): string {
  return `refs/wip/bb/${environmentId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

export function snapshotMessage(input: { reason: string; threadIds: string[]; branch: string | null; at: number }): string {
  return [`bb snapshot: ${input.reason}`, '', `threads: ${input.threadIds.join(', ') || '—'}`, `branch: ${input.branch ?? '—'}`, `at: ${new Date(input.at).toISOString()}`, ''].join('\n');
}
