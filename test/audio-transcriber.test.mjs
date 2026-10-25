import assert from 'node:assert/strict';
import test from 'node:test';
import { createAudioTranscriber } from '../audio-transcriber.mjs';

test('transcribes browser-recorded WebM audio through the configured generator', async () => {
  let parts;
  const transcriber = createAudioTranscriber({ generate: async (value) => { parts = value; return { text: 'Bought coffee with Sam' }; } });
  assert.deepEqual(await transcriber.transcribe(Buffer.from('audio'), 'audio/webm'), { text: 'Bought coffee with Sam' });
  assert.equal(parts[1].inlineData.mimeType, 'audio/webm');
});

test('rejects unsupported and oversized audio before calling Gemini', async () => {
  const transcriber = createAudioTranscriber({ generate: async () => { throw new Error('should not run'); }, maxBytes: 3 });
  await assert.rejects(() => transcriber.transcribe(Buffer.from('a'), 'text/plain'), /Unsupported audio/);
  await assert.rejects(() => transcriber.transcribe(Buffer.from('four'), 'audio/webm'), /5 MB/);
});
