<script>
  import { request } from './api.js';

  export let value = '';
  export let csrf = '';
  let listening = false;
  let recording = false;
  let transcribing = false;
  let error = '';
  let recorder;
  let recognition;
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
    recognition.onstart = () => listening = true;
    recognition.onresult = (event) => { transcript = [...event.results].map((result) => result[0].transcript).join(''); value = [initial, transcript.trim()].filter(Boolean).join(initial && transcript ? ' ' : ''); };
    recognition.onerror = (event) => { if (event.error !== 'aborted') error = `Dictation ${event.error || 'failed'}.`; };
    recognition.onend = () => { listening = false; recognition = null; };
    try { recognition.start(); } catch (cause) { recognition = null; error = cause.message || 'Could not start dictation.'; }
  }

  async function recordForTranscription() {
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
    if (listening) return recognition?.stop();
    if (recording) return recorder?.stop();
    if (transcribing) return;
    if (Recognition) return nativeDictation();
    if (canRecord) return recordForTranscription();
  }
</script>

<button type="button" class="dictation-button" class:recording={listening || recording} class:transcribing disabled={(!Recognition && !canRecord) || transcribing} aria-label={listening || recording ? 'Stop dictation' : transcribing ? 'Transcribing' : 'Dictate'} title={listening || recording ? 'Stop dictation' : transcribing ? 'Transcribing…' : 'Dictate'} on:click={dictate}>
  {#if listening || recording}<span aria-hidden="true">■</span>{:else if transcribing}<span class="dictation-spinner" aria-hidden="true">↻</span>{:else}<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6.5 11a5.5 5.5 0 0 0 11 0M12 16.5v4M8.5 20.5h7"/></svg>{/if}
</button>
{#if error}<output class="error dictation-error">{error}</output>{/if}
