// Мастер «Настроить»: по очереди проходит машины — папка общего пути, Mutagen,
// проверка. Каждый шаг: сначала проверка, применение только если проверка не
// прошла, поэтому повторный запуск безопасен и продолжает с места остановки.
import type { Machine, Platform, WizardMachineState, WizardPlanStep, WizardStepId } from './contract.ts';
import { setupPlan } from './sync/setup.ts';
import {
  anchorAlias, authorizeCommand, consentText, ensureKeyCommand, isSafeSshHost, parseKeyOutput, removeLocalCommand, revokeCommand, sshCheckCommand, writeConfigCommand,
} from './sync/ssh-setup.ts';

/** Закреплённая версия Mutagen для Linux; на macOS — Homebrew-тап проекта. */
export const MUTAGEN_VERSION = '0.18.1';
export const WIZARD_STEPS: readonly WizardStepId[] = ['probe', 'folder', 'mutagen', 'ssh', 'verify'];

export interface ProbeResult {
  platform: Platform;
  isRoot: boolean;
  user: string | null;
  sharedPathExists: boolean;
  sharedPathWritable: boolean;
  mutagenVersion: string | null;
}

/** Строка в одинарных кавычках для sh. */
export function shQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
export function isSafeUnixPath(path: string): boolean {
  return /^\/[A-Za-z0-9_./-]*$/.test(path) && !path.split('/').includes('..');
}
function psQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

export function wizardPlan(machine: Pick<Machine, 'sharedPath'> & Partial<Pick<Machine, 'anchor'>>, probe: Pick<ProbeResult, 'platform' | 'isRoot'>): WizardPlanStep[] {
  // macOS, Linux, WSL — шаги синхронизации (sync/setup.ts): Mutagen из архива с SHA-256, bind mount на опоре.
  const synced = setupPlan({ sharedPath: machine.sharedPath, anchor: machine.anchor ?? false }, probe);
  if (synced) return synced;
  const path = machine.sharedPath;
  const probeStep: WizardPlanStep = { id: 'probe', title: 'Определить машину', check: null, apply: null, privilege: 'none', note: 'Платформа, пользователь, путь и Mutagen — через хост-RPC плагина, только чтение.' };
  const p = shQuote(path);
  // Путь подставляется в команды с правами администратора: только простые символы.
  if (probe.platform !== 'windows' && !isSafeUnixPath(path)) {
    return [probeStep, { id: 'folder', title: `Создать ${path}`, check: null, apply: null, privilege: 'manual', note: 'Путь с особыми символами: создайте папку вручную или выберите путь из букв, цифр, «/», «.», «-», «_».' }];
  }
  switch (probe.platform) {
    case 'macos':
      return [
        probeStep,
        {
          id: 'folder', title: `Создать ${path}`, check: `test -d ${p} -a -w ${p}`,
          // Системное окно пароля macOS: права запрашиваются штатно, пароль не проходит через BB.
          // $u раскрывает внешняя оболочка — владельцем папки становится пользователь, а не root.
          apply: `u="$(id -un)"; osascript -e "do shell script \\"mkdir -p '${path}' && chown $u '${path}'\\" with administrator privileges"`,
          privilege: 'macos-dialog', note: 'macOS покажет системное окно с паролем администратора.',
        },
        { id: 'mutagen', title: 'Установить Mutagen', check: 'command -v mutagen >/dev/null 2>&1 && mutagen version', apply: 'brew install mutagen-io/mutagen/mutagen', privilege: 'none', note: 'Нужен Homebrew.' },
        { id: 'verify', title: 'Проверить путь и Mutagen', check: `test -w ${p} && mutagen version`, apply: null, privilege: 'none', note: 'Плюс пробная запись файла через bb file.' },
      ];
    case 'linux':
    case 'wsl': {
      const sudo = probe.isRoot ? '' : 'sudo -n ';
      return [
        probeStep,
        {
          id: 'folder', title: `Создать ${path}`, check: `test -d ${p} -a -w ${p}`,
          apply: probe.isRoot ? `mkdir -p ${p}` : `${sudo}mkdir -p ${p} && ${sudo}chown "$(id -un)" ${p}`,
          privilege: probe.isRoot ? 'root' : 'manual',
          note: probe.isRoot ? 'Под root, без запроса.' : 'Не root: нужен sudo без пароля, иначе выполните команду вручную.',
        },
        {
          id: 'mutagen', title: `Установить Mutagen ${MUTAGEN_VERSION}`, check: 'command -v mutagen >/dev/null 2>&1 && mutagen version',
          apply: [
            'set -e', 'case "$(uname -m)" in x86_64) a=amd64;; aarch64|arm64) a=arm64;; *) echo "arch $(uname -m)"; exit 1;; esac',
            `v=${MUTAGEN_VERSION}`, 't=$(mktemp -d)',
            'curl -fsSL "https://github.com/mutagen-io/mutagen/releases/download/v$v/mutagen_linux_${a}_v$v.tar.gz" | tar -xz -C "$t"',
            `${sudo}install -m 0755 "$t/mutagen" /usr/local/bin/mutagen`, `${sudo}install -m 0644 "$t/mutagen-agents.tar.gz" /usr/local/bin/mutagen-agents.tar.gz`, 'rm -rf "$t"',
          ].join('; '),
          privilege: probe.isRoot ? 'root' : 'manual', note: null,
        },
        { id: 'verify', title: 'Проверить путь и Mutagen', check: `test -w ${p} && mutagen version`, apply: null, privilege: 'none', note: 'Плюс пробная запись файла через bb file.' },
      ];
    }
    case 'windows':
      return [
        probeStep,
        { id: 'folder', title: `Создать ${path}`, check: `if (Test-Path -PathType Container ${psQuote(path)}) { exit 0 } else { exit 1 }`, apply: `New-Item -ItemType Directory -Force -Path ${psQuote(path)} | Out-Null`, privilege: 'none', note: 'Нативный Windows: пути переводятся (перевод — позже).' },
        { id: 'mutagen', title: 'Установить Mutagen', check: 'if (Get-Command mutagen -ErrorAction SilentlyContinue) { mutagen version } else { exit 1 }', apply: null, privilege: 'manual', note: 'Скачайте mutagen_windows_amd64 с GitHub Releases и добавьте в PATH; затем запустите мастер снова.' },
        { id: 'verify', title: 'Проверить путь и Mutagen', check: `if ((Test-Path ${psQuote(path)}) -and (Get-Command mutagen -ErrorAction SilentlyContinue)) { exit 0 } else { exit 1 }`, apply: null, privilege: 'none', note: null },
      ];
    default:
      return [probeStep];
  }
}

export function emptyWizardState(hostId: string): WizardMachineState {
  return { hostId, steps: Object.fromEntries(WIZARD_STEPS.map(id => [id, { status: 'pending' as const, message: null, at: null }])) };
}

/** Первый невыполненный шаг машины (null — машина готова). */
export function nextStep(state: WizardMachineState): WizardStepId | null {
  return WIZARD_STEPS.find(id => state.steps[id]?.status !== 'done' && state.steps[id]?.status !== 'skipped') ?? null;
}

export interface ExecResult { exitCode: number | null; output: string }
export interface WizardDeps {
  probe(machine: Machine): Promise<ProbeResult>;
  /** Команда на машине через bb terminal (sh -lc или powershell). */
  exec(machine: Machine, platform: Platform, command: string, timeoutMs: number): Promise<ExecResult>;
  /** Пробная запись и удаление файла в общем пути через bb file. */
  writeProbe(machine: Machine): Promise<boolean>;
  save(state: WizardMachineState): Promise<void>;
  now(): string;
  /** Опора каскада (для шага ssh); null — опоры нет. */
  anchor?: Machine | null;
  /** Записать «SSH к опоре» машины (алиас) в настройки каскада. */
  setAnchorSsh?(hostId: string, target: string): Promise<void>;
}

export interface WizardOptions {
  dryRun: boolean;
  /** Повторить проверки всех шагов (ничего не удаляет). */
  recheck?: boolean;
  /** Машины, которым владелец разрешил вход на опору по ключу каскада. */
  allowSsh?: ReadonlySet<string>;
}

/**
 * Проходит машины по очереди. dryRun — ничего не выполняет на машинах,
 * только отмечает шаги, которые были бы выполнены. Ошибка шага останавливает
 * эту машину (остальные идут дальше); следующий запуск продолжит с неё.
 */
export async function runWizard(machines: readonly Machine[], states: ReadonlyMap<string, WizardMachineState>, deps: WizardDeps, dryRunOrOptions: boolean | WizardOptions): Promise<WizardMachineState[]> {
  const options: WizardOptions = typeof dryRunOrOptions === 'boolean' ? { dryRun: dryRunOrOptions } : dryRunOrOptions;
  const dryRun = options.dryRun;
  const out: WizardMachineState[] = [];
  for (const machine of machines.filter(m => m.enabled)) {
    const state = structuredClone(states.get(machine.hostId) ?? emptyWizardState(machine.hostId));
    for (const id of WIZARD_STEPS) if (!state.steps[id]) state.steps[id] = { status: 'pending', message: null, at: null };
    const mark = async (id: WizardStepId, status: WizardMachineState['steps'][string]['status'], message: string | null) => {
      state.steps[id] = { status, message, at: deps.now() };
      if (!dryRun) await deps.save(state);
    };
    if (options.recheck && !dryRun) for (const id of WIZARD_STEPS) state.steps[id] = { status: 'pending', message: 'перепроверка', at: null };
    if (dryRun) {
      for (const id of WIZARD_STEPS) if (state.steps[id]?.status !== 'done') state.steps[id] = { status: 'pending', message: 'будет выполнено', at: null };
      out.push(state);
      continue;
    }
    let probe: ProbeResult;
    try {
      probe = await deps.probe(machine);
      await mark('probe', 'done', `${probe.platform}${probe.isRoot ? ', root' : ''}${probe.mutagenVersion ? `, mutagen ${probe.mutagenVersion}` : ''}`);
    } catch (error) {
      await mark('probe', 'failed', message(error));
      out.push(state);
      continue;
    }
    const plan = wizardPlan(machine, probe).filter(s => s.id !== 'probe');
    if (!plan.some(s => s.id === 'ssh')) await mark('ssh', 'skipped', machine.anchor ? 'опора — SSH не нужен' : 'SSH для этой платформы не настраивается');
    for (const step of plan) {
      const ok = step.id === 'ssh' ? await runSshStep(machine, probe, state, deps, options) : await runStep(machine, probe.platform, step, deps);
      if (step.id === 'verify' && ok.status === 'done' && !(await deps.writeProbe(machine).catch(() => false))) {
        await mark('verify', 'failed', 'Путь есть, но пробная запись через bb file не прошла');
        break;
      }
      await mark(step.id, ok.status, ok.message);
      if (ok.status !== 'done') break;
    }
    out.push(state);
  }
  return out;
}

/**
 * Шаг ssh: проверка входа на опору; нет — ключ каскада на исполнителе, согласие
 * владельца, ключ в authorized_keys опоры, алиас в ~/.ssh/config, проверка.
 */
async function runSshStep(machine: Machine, probe: ProbeResult, state: WizardMachineState, deps: WizardDeps, options: WizardOptions): Promise<{ status: 'done' | 'failed' | 'manual'; message: string | null }> {
  const anchor = deps.anchor;
  if (!anchor) return { status: 'manual', message: 'В каскаде не выбрана опорная машина' };
  const alias = anchorAlias(anchor.label);
  const exec = (m: Machine, command: string, ms = 60_000) => deps.exec(m, m === machine ? probe.platform : anchor.platform, command, ms).catch(error => ({ exitCode: null, output: message(error) }));
  // 1. Уже работает (свой алиас владельца или алиас каскада)?
  for (const target of [machine.anchorSsh, alias].filter((t, i, a): t is string => !!t && a.indexOf(t) === i)) {
    const checked = await exec(machine, sshCheckCommand(target), 30_000);
    if (checked.exitCode === 0 && /ssh-ok/u.test(checked.output)) {
      state.pendingConsent = null;
      if (machine.anchorSsh !== target) await deps.setAnchorSsh?.(machine.hostId, target);
      return { status: 'done', message: `вход ${machine.label} → ${anchor.label} по «${target}»` };
    }
  }
  const host = anchor.sshAddress?.trim() ?? '';
  if (!host || !isSafeSshHost(host)) {
    return { status: 'manual', message: `Укажите адрес опоры для SSH: Машины → ${anchor.label} → «Адрес для SSH» (IP или имя, доступное с ${machine.label})` };
  }
  // 2. Ключ каскада на исполнителе (без согласия: остаётся на этой машине).
  const keyOut = await exec(machine, ensureKeyCommand(machine.hostId));
  const key = keyOut.exitCode === 0 ? parseKeyOutput(keyOut.output) : null;
  if (!key) return { status: 'failed', message: `Ключ на ${machine.label} не создан: ${tail(keyOut.output)}` };
  // 3. Согласие владельца на вход по ключу.
  const anchorUser = (await deps.probe(anchor).catch(() => null))?.user ?? null;
  if (!options.allowSsh?.has(machine.hostId)) {
    state.pendingConsent = { text: consentText(machine.label, anchor.label, anchorUser, key), fingerprint: key.fingerprint, publicKey: key.publicKey };
    return { status: 'manual', message: `Нужно разрешение: машине ${machine.label} входить на ${anchor.label} по ключу ${key.fingerprint}` };
  }
  // 4. Ключ на опору, алиас на исполнитель, проверка.
  const authorized = await exec(anchor, authorizeCommand(key, machine.hostId));
  if (authorized.exitCode !== 0) return { status: 'failed', message: `Ключ на ${anchor.label} не добавлен: ${tail(authorized.output)}` };
  let configCmd: string;
  try { configCmd = writeConfigCommand(alias, host, anchorUser); } catch (error) { return { status: 'manual', message: message(error) }; }
  const configured = await exec(machine, configCmd);
  if (configured.exitCode !== 0) return { status: 'failed', message: `~/.ssh/config на ${machine.label}: ${tail(configured.output)}` };
  const verified = await exec(machine, sshCheckCommand(alias), 30_000);
  if (verified.exitCode !== 0 || !/ssh-ok/u.test(verified.output)) return { status: 'failed', message: `Вход ${machine.label} → ${anchor.label} не прошёл: ${tail(verified.output)}` };
  state.pendingConsent = null;
  await deps.setAnchorSsh?.(machine.hostId, alias);
  return { status: 'done', message: `ключ ${key.fingerprint} добавлен на ${anchor.label}, алиас «${alias}»` };
}

/** Снять SSH каскада машины: ключ на опоре, алиас и ключ на исполнителе. Без ошибок наружу. */
export async function revokeSsh(machine: Machine, deps: Pick<WizardDeps, 'exec' | 'anchor'>): Promise<string[]> {
  const anchor = deps.anchor;
  if (!anchor || anchor.hostId === machine.hostId) return [];
  const notes: string[] = [];
  const a = await deps.exec(anchor, anchor.platform, revokeCommand(machine.hostId), 60_000).catch(error => ({ exitCode: null, output: message(error) }));
  notes.push(a.exitCode === 0 ? `ключ ${machine.label} снят с ${anchor.label}` : `${anchor.label}: ключ не снят — ${tail(a.output)}`);
  const b = await deps.exec(machine, machine.platform, removeLocalCommand(anchorAlias(anchor.label)), 60_000).catch(error => ({ exitCode: null, output: message(error) }));
  notes.push(b.exitCode === 0 ? `алиас и ключ каскада на ${machine.label} убраны` : `${machine.label}: ${tail(b.output)}`);
  return notes;
}

async function runStep(machine: Machine, platform: Platform, step: WizardPlanStep, deps: WizardDeps): Promise<{ status: 'done' | 'failed' | 'manual'; message: string | null }> {
  if (step.check) {
    const checked = await deps.exec(machine, platform, step.check, 30_000).catch(() => null);
    if (checked?.exitCode === 0) return { status: 'done', message: tail(checked.output) || 'уже готово' };
  }
  if (!step.apply) return { status: step.privilege === 'manual' ? 'manual' : 'failed', message: step.note ?? 'Проверка не прошла' };
  // Окно пароля macOS ждёт человека — даём до 5 минут.
  const applied = await deps.exec(machine, platform, step.apply, step.privilege === 'macos-dialog' ? 300_000 : 180_000).catch(error => ({ exitCode: null, output: message(error) }));
  if (applied.exitCode !== 0) return { status: step.privilege === 'manual' ? 'manual' : 'failed', message: `${step.note ? `${step.note} ` : ''}${tail(applied.output)}`.trim() };
  if (step.check) {
    const again = await deps.exec(machine, platform, step.check, 30_000).catch(() => null);
    if (again?.exitCode !== 0) return { status: 'failed', message: `После установки проверка не прошла: ${tail(again?.output ?? '')}` };
  }
  return { status: 'done', message: tail(applied.output) || null };
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function tail(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim().split('\n').slice(-2).join(' ').slice(0, 200);
}
