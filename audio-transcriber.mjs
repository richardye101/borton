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

export function createAudioTranscriber({ generate, maxBytes = 5 * 1024 * 1024 } = {}) {
  if (typeof generate !== 'function') throw new TypeError('generate must be a function');
  return {
    async transcribe(buffer, mime) {
      if (!AUDIO_TYPES.has(mime)) throw new Error('Unsupported audio type. Use WebM, Ogg, MP4, MP3, or WAV.');
      if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Audio recording is empty.');
      if (buffer.length > maxBytes) throw new Error('Audio exceeds the 5 MB limit.');
      const result = await generate([
        { text: 'Transcribe this spoken expense note verbatim. Return only the spoken text, retaining merchant names, people, and useful details.' },
        { inlineData: { mimeType: mime, data: buffer.toString('base64') } },
      ], TRANSCRIPT_SCHEMA);
      return { text: String(result.text || '').trim() };
    },
  };
}
