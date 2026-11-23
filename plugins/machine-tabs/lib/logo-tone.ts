/**
 * Project logos come in any colours: black strokes, `currentColor` (black in
 * an <img>), navy or indigo plates, grey. Drawn as images they get a different
 * tone each, and dark ones vanish on the dark theme. Here every logo becomes
 * a one-colour silhouette (an alpha mask) painted with the theme's colour, so
 * all marks share one tone on any theme.
 *
 * The ink is the logo's dominant tone (the median of its visible pixels): a
 * stroke logo is all ink, a plate logo keeps its plate and cuts its contrasting
 * lines out of it.
 */
import { useEffect, useState } from "react";

/** The tone CSS grayscale(1) gives a pixel, 0..1. */
export function pixelTone(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Dominant tone of the visible pixels; null when nothing is visible. */
export function logoTone(rgba: ArrayLike<number>): number | null {
  const tones: number[] = [];
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3]! < 128) continue;
    tones.push(pixelTone(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!));
  }
  if (tones.length === 0) return null;
  tones.sort((a, b) => a - b);
  return tones[Math.floor(tones.length / 2)]!;
}

/** A tone this far from the dominant one is cut out completely. */
const CUT = 0.4;

/**
 * Ink alpha per pixel (0..255): visible pixels close to the dominant tone are
 * ink, contrasting ones fade out. null when the image has nothing visible.
 */
export function inkAlpha(rgba: ArrayLike<number>): Uint8ClampedArray | null {
  const tone = logoTone(rgba);
  if (tone === null) return null;
  const out = new Uint8ClampedArray(Math.floor(rgba.length / 4));
  for (let i = 0, p = 0; i + 3 < rgba.length; i += 4, p++) {
    const diff = Math.abs(pixelTone(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!) - tone);
    out[p] = Math.round(rgba[i + 3]! * Math.max(0, 1 - diff / CUT));
  }
  return out;
}

const SIZE = 64;
const masks = new Map<string, Promise<string | null>>();

/** The logo as a PNG mask (data URL); null when it cannot be read. */
function maskOf(url: string): Promise<string | null> {
  let found = masks.get(url);
  if (!found) {
    found = new Promise<string | null>((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = SIZE;
          canvas.height = SIZE;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) return resolve(null);
          const w = img.naturalWidth || SIZE;
          const h = img.naturalHeight || SIZE;
          const scale = Math.min(SIZE / w, SIZE / h);
          ctx.drawImage(img, (SIZE - w * scale) / 2, (SIZE - h * scale) / 2, w * scale, h * scale);
          const data = ctx.getImageData(0, 0, SIZE, SIZE);
          const alpha = inkAlpha(data.data);
          if (!alpha) return resolve(null);
          for (let p = 0; p < alpha.length; p++) {
            data.data[p * 4] = 0;
            data.data[p * 4 + 1] = 0;
            data.data[p * 4 + 2] = 0;
            data.data[p * 4 + 3] = alpha[p]!;
          }
          ctx.putImageData(data, 0, 0);
          resolve(canvas.toDataURL("image/png"));
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
    masks.set(url, found);
  }
  return found;
}

/** One-colour masks of the project logos by project id; a logo not yet (or never) masked is absent. */
export function useLogoMasks(icons: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const [result, setResult] = useState<Readonly<Record<string, string>>>({});
  useEffect(() => {
    let live = true;
    const entries = Object.entries(icons);
    Promise.all(entries.map(([id, url]) => maskOf(url).then((mask) => [id, mask] as const))).then((list) => {
      if (!live) return;
      const next: Record<string, string> = {};
      for (const [id, mask] of list) if (mask) next[id] = mask;
      setResult((now) => {
        const keys = Object.keys(next);
        return keys.length === Object.keys(now).length && keys.every((k) => now[k] === next[k]) ? now : next;
      });
    });
    return () => { live = false; };
  }, [icons]);
  return result;
}

/** The colour every logo is painted with. */
export const LOGO_INK = "var(--muted-foreground)";
