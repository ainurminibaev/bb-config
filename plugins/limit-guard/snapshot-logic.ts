// Pure helpers for snapshots: what to skip and what looks like a secret.

export const MAX_SNAPSHOT_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_SNAPSHOT_FILES = 20_000;
/** A shadow snapshot is for a project folder, not a disk: above this the folder is skipped. */
export const MAX_SHADOW_BYTES = 200 * 1024 * 1024;
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

/** No thread or machine ids here: the plugin keeps those in its own storage. */
export function snapshotMessage(input: { reason: string; branch: string | null; at: number }): string {
  return [`bb snapshot: ${input.reason}`, '', `branch: ${input.branch ?? '—'}`, `at: ${new Date(input.at).toISOString()}`, ''].join('\n');
}

/** Ref of a repository nested in a plain folder; a sibling of the folder's ref, never its child. */
export function nestedRef(ref: string, rel: string): string {
  const slug = rel.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60);
  return `${ref}--${slug}`;
}

/** Home folders and disk roots are never shadow-snapshotted: they hold other projects, app data and keys. */
export function unsafeShadowRoot(path: string, home: string): string | null {
  const norm = path.replace(/\/+$/, '') || '/';
  const h = home.replace(/\/+$/, '');
  const depth = norm.split('/').filter(Boolean).length;
  if (norm === '/' || norm === h || depth < 2 || ['/root', '/home', '/Users', '/srv', '/srv/projects', '/opt', '/var', '/tmp'].includes(norm)) {
    return 'это домашняя папка или корень диска — теневой снимок не делается';
  }
  if (/(^|\/)\.bb-machines(\/|$)|(^|\/)\.bb\.before-move/.test(norm)) return 'это служебная папка BB — теневой снимок не делается';
  return null;
}
