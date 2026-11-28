// Кадры между запускателем (машина треда) и агентом на машине ступени.
// Канал — терминал BB: байты идут через PTY, поэтому каждый кадр — одна
// ASCII-строка `@@CX <тип> <поля…>`, полезная нагрузка в base64. PTY может
// превратить \n в \r\n и подмешать постороннее (баннер оболочки) — такие
// строки разборщик пропускает.
//
// Агент → запускатель:
//   R <версия>             агент готов, ввод принимается
//   O <seq> <b64>           кусок stdout CLI (seq — непрерывный счётчик кадров O)
//   E <b64>                 кусок stderr CLI
//   S <b64>                 кусок файла сессии (gzip), после выхода CLI
//   SE <sha256|none>        конец файла сессии
//   X <код> <сигнал|->      CLI завершился; после X кадров нет
//   F <b64 сообщения>       авария агента
//   H                       сердцебиение
// Запускатель → агент:
//   B <b64 json>            начало: аргументы, папка, env, сведения о сессии
//   P <b64>                 кусок файла сессии для --resume (gzip)
//   G                       старт CLI
//   I <b64>                 stdin CLI
//   C                       закрыть stdin CLI
//   K <сигнал>              послать сигнал CLI
//   H                       сердцебиение

export const FRAME_PREFIX = '@@CX ';
export const AGENT_PROTOCOL_VERSION = 1;
/** Сырые байты в одном кадре: base64 4 КиБ строки, PTY-буфер не переполняется. */
export const FRAME_CHUNK_BYTES = 3000;

export type AgentFrame =
  | { type: 'R'; version: number }
  | { type: 'O'; seq: number; data: Buffer }
  | { type: 'E'; data: Buffer }
  | { type: 'S'; data: Buffer }
  | { type: 'SE'; sha256: string | null }
  | { type: 'X'; code: number | null; signal: string | null }
  | { type: 'F'; message: string }
  | { type: 'H' };

export interface BeginHeader {
  args: string[];
  cwd: string;
  /** Переменные для CLI поверх окружения машины ступени (только разрешённые). */
  env: Record<string, string>;
  /** Какой CLI запускать: имя в PATH машины ступени. */
  command: string;
  /** ID сессии для --resume/--session-id; null — сессию не переносим. */
  sessionId: string | null;
  /** Будет ли кадр P (файл сессии для продолжения). */
  sessionPut: { bytes: number; sha256: string } | null;
  /** Вернуть ли файл сессии после выхода (нет при --no-session-persistence). */
  sessionGet: boolean;
  /** Сторожевой таймер агента: столько мс без сердцебиения — CLI останавливается. */
  watchdogMs: number;
}

const B64 = /^[A-Za-z0-9+/=]*$/;

export function encodeClientFrame(type: 'B' | 'P' | 'G' | 'I' | 'C' | 'K' | 'H', payload?: Buffer | string): string {
  if (payload === undefined) return `${FRAME_PREFIX}${type}\n`;
  const text = typeof payload === 'string' ? payload : payload.toString('base64');
  return `${FRAME_PREFIX}${type} ${text}\n`;
}

export function beginFrame(header: BeginHeader): string {
  return encodeClientFrame('B', Buffer.from(JSON.stringify(header), 'utf8'));
}

/** Режет буфер на кадры заданного типа (I или P). */
export function chunkFrames(type: 'I' | 'P', data: Buffer, size = FRAME_CHUNK_BYTES): string[] {
  const frames: string[] = [];
  for (let offset = 0; offset < data.length; offset += size) frames.push(encodeClientFrame(type, data.subarray(offset, offset + size)));
  return frames;
}

/** Разбор одной строки агента. Чужие и битые строки → null. */
export function parseAgentLine(raw: string): AgentFrame | null {
  const line = raw.replace(/\r+$/u, '');
  const start = line.indexOf(FRAME_PREFIX);
  if (start === -1) return null;
  const parts = line.slice(start + FRAME_PREFIX.length).split(' ');
  const [type, a, b] = parts;
  const b64 = (value: string | undefined): Buffer | null => value !== undefined && B64.test(value) ? Buffer.from(value, 'base64') : null;
  switch (type) {
    case 'R': return { type: 'R', version: Number(a) || 0 };
    case 'H': return { type: 'H' };
    case 'O': {
      const seq = Number(a);
      const data = b64(b);
      return Number.isInteger(seq) && seq >= 0 && data ? { type: 'O', seq, data } : null;
    }
    case 'E': case 'S': {
      const data = b64(a);
      return data ? { type, data } : null;
    }
    case 'SE': return { type: 'SE', sha256: a && /^[0-9a-f]{64}$/u.test(a) ? a : null };
    case 'X': {
      const code = a === undefined || a === '-' ? null : Number(a);
      return { type: 'X', code: code === null || Number.isInteger(code) ? code : null, signal: b && b !== '-' ? b : null };
    }
    case 'F': {
      const data = b64(a);
      return { type: 'F', message: data ? data.toString('utf8') : 'агент сообщил об аварии' };
    }
    default: return null;
  }
}

/** Собирает строки из потока байтов PTY. */
export class LineSplitter {
  private rest = '';
  push(chunk: Buffer | string): string[] {
    this.rest += typeof chunk === 'string' ? chunk : chunk.toString('latin1');
    const lines = this.rest.split('\n');
    this.rest = lines.pop() ?? '';
    // Защита от мусора без перевода строки: не копим больше 1 МиБ.
    if (this.rest.length > 1 << 20) this.rest = '';
    return lines;
  }
}
