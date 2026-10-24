// Sketch-to-photo server for Cloudflare Workers AI (free daily allowance: 10,000 neurons).
// Setup steps in Hebrew: CLOUDFLARE.md next to this file.
// The Worker needs a Workers AI binding named AI (Settings → Bindings → Workers AI).
//
// The app POSTs multipart form data: image (the sketch, under 512x512), description (optional, any language)
// and mode ('follow' or 'free').
// 1. A vision model looks at the sketch and writes an English description of the real scene it shows.
// 2. FLUX.2 [klein] makes a photo from that description. In 'follow' mode it also gets the sketch as a layout
//    guide; in 'free' mode it gets only the description, which looks more real but keeps less of the layout.
// Reply: { image: <base64>, prompt } or { error: { message } }.

// Optional: set a password here and type the same one in the app's settings,
// so nobody else who finds the Worker's address can use up your daily allowance.
const PASSWORD = '';

// '@cf/black-forest-labs/flux-2-klein-9b' looks better but uses about 10x more of the allowance.
const IMAGE_MODEL = '@cf/black-forest-labs/flux-2-klein-4b';
const VISION_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
const TEXT_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const SIZE = 1024;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-App-Password',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const fail = (status, message) => json({ error: { message } }, status);

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!env.AI) return fail(500, 'Workers AI binding "AI" is missing: add it under Settings → Bindings.');
    // Opening the address in a browser shows this, to check the setup.
    if (request.method === 'GET') return json({ ok: true, message: 'The sketch-to-photo server is running.' });
    if (request.method !== 'POST') return fail(405, 'Use POST.');
    if (PASSWORD && request.headers.get('X-App-Password') !== PASSWORD) return fail(401, 'Wrong password.');

    let form;
    try { form = await request.formData(); } catch { return fail(400, 'Expected multipart form data.'); }
    const image = form.get('image');
    if (!image || typeof image === 'string') return fail(400, 'Missing image.');
    const desc = String(form.get('description') || '').slice(0, 500);
    const bytes = new Uint8Array(await image.arrayBuffer());
    const type = image.type || 'image/png';

    const started = Date.now();
    // The user's own words come first: translate them once, then both models get the English.
    const wish = await toEnglish(env, desc);
    const translated = Date.now();
    const scene = (await describe(env, bytes, type, wish)).replace(/[.\s]*$/, '.');
    const described = Date.now();
    // Without a description there is nothing to draw from but the sketch itself.
    const free = form.get('mode') === 'free' && scene.length > 1;
    const photo =
      (wish ? 'It must contain everything the person asked for: ' + wish.replace(/[.\s]*$/, '.') + ' ' : '') +
      'Real people have natural human anatomy, skin, hair and real clothes; animals, plants, water, sky and objects ' +
      'have real-world materials and textures. The sun is real sunlight: a bright glow or lens flare in a natural ' +
      'sky, never a yellow disc with drawn rays. Natural lighting, realistic proportions, depth of field and shadows, ' +
      'shot on a professional camera. No drawing, no outlines, no cartoon, no illustration, no clip art, no toy, ' +
      'no puppet, no text.';
    const prompt = free
      ? 'A photorealistic photograph: ' + scene + ' ' + photo
      : 'Create a photorealistic photograph of the scene this rough sketch represents' +
        (scene.length > 1 ? ': ' + scene : '.') + ' ' +
        'Use the sketch only as a rough guide for what is where and how big; do not copy the shapes of its lines ' +
        'or any drawn element as it is. Stick figures become real people with real bodies; scribbled lines become ' +
        'the real thing they stand for (sea waves, grass, clouds, flying birds), never ropes, wires, sticks or objects ' +
        'shaped like the lines. ' + photo;

    const fd = new FormData();
    fd.append('prompt', prompt);
    if (!free) fd.append('input_image_0', new Blob([bytes], { type }), 'sketch');
    // The app asks for its board's shape; sizes are kept to multiples of 16 up to SIZE.
    const side = name => Math.min(SIZE, Math.max(256, Math.round(Number(form.get(name)) / 16) * 16 || SIZE));
    fd.append('width', String(side('width')));
    fd.append('height', String(side('height')));
    const body = new Response(fd);

    let out;
    try {
      out = await env.AI.run(IMAGE_MODEL, { multipart: { body: body.body, contentType: body.headers.get('content-type') } });
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/neuron|daily|quota|limit|4006/i.test(msg)) return fail(429, msg);
      return fail(502, msg);
    }
    const b64 = await imageBase64(out);
    if (!b64) return fail(502, 'The model returned no image.');
    // Seconds per step, shown in the app, to see which step is slow.
    const secs = (a, b) => Math.round((b - a) / 100) / 10;
    const timing = { translate: secs(started, translated), describe: secs(translated, described), image: secs(described, Date.now()) };
    return json({ image: b64, prompt, mode: free ? 'free' : 'follow', timing });
  },
};

// FLUX only understands English, so a Hebrew description is translated first.
async function toEnglish(env, text) {
  if (!text || !/[֐-׿]/.test(text)) return text;
  try {
    const r = await withTimeout(env.AI.run(TEXT_MODEL, {
      messages: [
        { role: 'system', content: 'Translate the user text from Hebrew to English. Keep every detail, including ' +
          'gender (e.g. דייג = a fisherman, a man) and numbers. Reply with the translation only.' },
        { role: 'user', content: text },
      ],
      max_tokens: 150,
    }), 15000);
    if (typeof r?.response === 'string' && r.response.trim()) return r.response.trim();
  } catch {}
  return text;
}

// English description of the scene in the sketch, or the user's own words if the vision model fails.
async function describe(env, bytes, type, wish) {
  const ask =
    'This is a rough hand-drawn sketch, maybe drawn by a child. In two or three English sentences, describe the ' +
    'real-world photo this sketch stands for. Name EVERY element with how many there are, their colors, size, and ' +
    'where each one is placed (left, right, top, bottom, center). Read the drawing\'s symbols as the real things ' +
    'they stand for: a stick figure is a real person, blue squiggles are sea waves, a yellow circle with lines is ' +
    'the sun shining, small "v" or "m" marks in the sky are flying birds, fish shapes in the water are real fish. ' +
    'Describe only the real scene, never the drawing, its lines or its style.' +
    (wish
      ? ' The person who drew it says: "' + wish + '". This is the truth about who and what is in the picture ' +
        '(for example whether a person is a man or a woman): follow it exactly and include everything it mentions.'
      : '') +
    ' Reply with the description only.';
  try {
    const r = await withTimeout(env.AI.run(VISION_MODEL, {
      messages: [{ role: 'user', content: [
        { type: 'text', text: ask },
        { type: 'image_url', image_url: { url: 'data:' + type + ';base64,' + toBase64(bytes) } },
      ] }],
      max_tokens: 220,
    }), 30000);
    const text = typeof r?.response === 'string' ? r.response.trim() : '';
    if (text) return text;
  } catch {}
  return wish;
}

// Gives up on a slow model call so one stuck step can't hold the whole request for minutes.
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

async function imageBase64(out) {
  if (!out) return '';
  if (typeof out.image === 'string') return out.image;
  const stream = out instanceof ReadableStream ? out : out.image instanceof ReadableStream ? out.image : null;
  if (stream) return toBase64(new Uint8Array(await new Response(stream).arrayBuffer()));
  if (out instanceof Uint8Array || out instanceof ArrayBuffer) return toBase64(new Uint8Array(out));
  return '';
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
