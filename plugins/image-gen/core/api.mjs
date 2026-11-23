// Tier-1 backend for people without Codex: OpenAI Images API with a user-supplied key.
// Paid per image, therefore used only when the owner sets the key AND maxTier >= 1.
// Runs inside the BB server process; fetch is injectable for tests.

export const API_ENDPOINT = 'https://api.openai.com/v1/images';

/** Returns {status, images:[{bytes:Buffer, mime}], error?, resetHint?}. Never retries itself. */
export async function openaiImages({ apiKey, model = 'gpt-image-1', prompt, count = 1, size, transparent, references = [], mode,
  fetchImpl = fetch, readFile, signal }) {
  if (!apiKey) return { status: 'not_started', error: 'OpenAI API key is not configured' };
  const headers = { Authorization: `Bearer ${apiKey}` };
  let response;
  try {
    if (references.length) {
      const form = new FormData();
      form.set('model', model); form.set('prompt', mode === 'edit' ? prompt : `Use the attached images as references. ${prompt}`);
      form.set('n', String(count)); if (size) form.set('size', size); if (transparent) form.set('background', 'transparent');
      for (const ref of references) {
        const { bytes, name, mime } = await readFile(ref);
        form.append('image[]', new Blob([bytes], { type: mime }), name);
      }
      response = await fetchImpl(`${API_ENDPOINT}/edits`, { method: 'POST', headers, body: form, signal });
    } else {
      response = await fetchImpl(`${API_ENDPOINT}/generations`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({ model, prompt, n: count, ...(size ? { size } : {}), ...(transparent ? { background: 'transparent' } : {}) }),
      });
    }
  } catch (error) {
    // The request may have reached the provider: the outcome (and the charge) is unknown.
    return { status: 'unknown', error: 'OpenAI request outcome unknown: ' + String(error) };
  }
  let body = null;
  try { body = await response.json(); } catch {}
  if (response.ok && Array.isArray(body?.data)) {
    const images = body.data.filter(d => d.b64_json).map(d => ({ bytes: Buffer.from(d.b64_json, 'base64'), mime: 'image/png' }));
    return images.length ? { status: 'completed', images, model } : { status: 'failed', error: 'OpenAI returned no images' };
  }
  const message = body?.error?.message ?? `HTTP ${response.status}`;
  if (response.status === 401 || response.status === 403) return { status: 'auth', error: message };
  if (response.status === 429 || body?.error?.code === 'insufficient_quota')
    return { status: 'limited', error: message, resetHint: response.headers?.get?.('retry-after') ?? null };
  return { status: 'failed', error: message };
}
