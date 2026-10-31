<script>
  import { request } from './api.js';

  export let value = '';
  export let csrf = '';
  let listening = false;
  let recording = false;
  let error = '';
  let recorder;
  let recognition;
  let starting = false;
  let transcribing = false;
  let chunks = [];
  const Recognition = typeof window === 'undefined' ? null : window.SpeechRecognition || window.webkitSpeechRecognition;
  const canRecord = typeof window === 'undefined' ? false : !!navigator.mediaDevices?.getUserMedia && !!window.MediaRecorder;

  function append(text) { value = [value.trim(), text.trim()].filter(Boolean).join(value.trim() && text.trim() ? ' ' : ''); }

  function nativeDictation() {
    if (recognition) return recognition.stop();
    error = '';
    const initial = value.trim(); let transcript = '';
    recognition = new Recognition();
    recognition.lang = navigator.language || 'en-CA'; recognition.interimResults = true; recognition.continuous = true;
    recognition.onstart = () => { starting = false; listening = true; };
    recognition.onresult = (event) => { transcript = [...event.results].map((result) => result[0].transcript).join(''); value = [initial, transcript.trim()].filter(Boolean).join(initial && transcript ? ' ' : ''); };
    recognition.onerror = (event) => { if (event.error !== 'aborted') error = `Dictation ${event.error || 'failed'}.`; };
    recognition.onend = () => { starting = false; listening = false; recognition = null; };
    try { starting = true; recognition.start(); }
    catch (cause) { starting = false; recognition = null; error = cause.message || 'Could not start dictation.'; }
  }

  async function recordForGemini() {
    error = '';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop()); recording = false; transcribing = true;
        try {
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
          const form = new FormData(); form.append('audio', blob, 'note.webm');
          const { text } = await request('/api/transcribe', { csrf, method: 'POST', form });
          if (text) append(text); else error = 'No speech was found in that recording.';
        } catch (cause) { error = cause.message || 'Could not transcribe the recording.'; }
        finally { transcribing = false; recorder = null; }
      };
      recording = true; recorder.start();
    } catch (cause) { error = cause.message || 'Microphone access was not available.'; }
  }

  function dictate() {
    if (starting || listening) return recognition?.stop();
    if (recording) return recorder?.stop();
    if (transcribing) return;
    if (Recognition) return nativeDictation();
    if (canRecord) return recordForGemini();
  }
</script>

<button type="button" class:active={starting || listening || recording || transcribing} disabled={(!Recognition && !canRecord) || transcribing} title={Recognition ? 'Speak a note' : canRecord ? 'Record a note for transcription' : 'Use device keyboard dictation in this browser.'} on:click={dictate}>{starting ? 'Starting…' : listening || recording ? 'Stop recording' : transcribing ? 'Transcribing…' : 'Dictate'}</button>
{#if starting || listening || recording}<small class="dictation-status recording">● Recording — tap Stop recording when you are done.</small>{:else if transcribing}<small class="dictation-status">Transcribing your note…</small>{:else}<small class="dictation-status">Your words appear in Notes; Add expense saves them.</small>{/if}
{#if error}<output class="error dictation-error">{error}</output>{/if}
