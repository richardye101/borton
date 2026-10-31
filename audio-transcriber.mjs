export const AUDIO_TYPES = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
]);

const TRANSCRIPT_SCHEMA = {
  type: 'OBJECT',
  properties: { text: { type: 'STRING', description: 'The complete spoken note, transcribed verbatim.' } },
  required: ['text'],
};

function validateAudio(buffer, mime, maxBytes) {
  if (!AUDIO_TYPES.has(mime)) throw new Error('Unsupported audio type. Use WebM, Ogg, MP4, MP3, or WAV.');
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Audio recording is empty.');
  if (buffer.length > maxBytes) throw new Error('Audio exceeds the 5 MB limit.');
}

export function createAudioTranscriber({ generate, maxBytes = 5 * 1024 * 1024 } = {}) {
  if (typeof generate !== 'function') throw new TypeError('generate must be a function');
  return {
    async transcribe(buffer, mime) {
      validateAudio(buffer, mime, maxBytes);
      const result = await generate([
        { text: 'Transcribe this spoken expense note verbatim. Return only the spoken text, retaining merchant names, people, and useful details.' },
        { inlineData: { mimeType: mime, data: buffer.toString('base64') } },
      ], TRANSCRIPT_SCHEMA);
      return { text: String(result.text || '').trim() };
    },
  };
}

export function createGroqAudioTranscriber({ apiKey, model = 'whisper-large-v3-turbo', fetchImpl = globalThis.fetch, maxBytes = 5 * 1024 * 1024 } = {}) {
  if (!apiKey) throw new TypeError('Groq API key is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  return {
    async transcribe(buffer, mime) {
      validateAudio(buffer, mime, maxBytes);
      const form = new FormData();
      form.append('model', model);
      form.append('file', new Blob([buffer], { type: mime }), 'note.webm');
      const response = await fetchImpl('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || `Groq HTTP ${response.status}.`);
      return { text: String(payload?.text || '').trim() };
    },
  };
}
