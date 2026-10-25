<script>
  import { request } from './api.js';

  export let value = '';
  export let csrf = '';
  let listening = false;
  let recording = false;
  let error = '';
  let recorder;
  let chunks = [];
  const Recognition = typeof window === 'undefined' ? null : window.SpeechRecognition || window.webkitSpeechRecognition;
  const canRecord = typeof window === 'undefined' ? false : !!navigator.mediaDevices?.getUserMedia && !!window.MediaRecorder;

  function append(text) { value = [value.trim(), text.trim()].filter(Boolean).join(value.trim() && text.trim() ? ' ' : ''); }

  function nativeDictation() {
    const initial = value.trim(); let transcript = '';
    const recognition = new Recognition();
    recognition.lang = navigator.language || 'en-CA'; recognition.interimResults = true; recognition.continuous = true;
    recognition.onstart = () => listening = true;
    recognition.onresult = (event) => { transcript = [...event.results].map((result) => result[0].transcript).join(''); value = [initial, transcript.trim()].filter(Boolean).join(initial && transcript ? ' ' : ''); };
    recognition.onend = () => listening = false;
    recognition.onerror = () => recognition.stop();
    recognition.start();
  }

  async function recordForGemini() {
    error = '';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop()); recording = false;
        try {
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
          const form = new FormData(); form.append('audio', blob, 'note.webm');
          const { text } = await request('/api/transcribe', { csrf, method: 'POST', form });
          if (text) append(text); else error = 'No speech was found in that recording.';
        } catch (cause) { error = cause.message || 'Could not transcribe the recording.'; }
      };
      recorder.start(); recording = true;
    } catch (cause) { error = cause.message || 'Microphone access was not available.'; }
  }

  function dictate() {
    if (Recognition) return nativeDictation();
    if (recording) return recorder.stop();
    if (canRecord) return recordForGemini();
  }
</script>

<button type="button" class:active={listening || recording} disabled={!Recognition && !canRecord} title={Recognition ? 'Speak a note' : canRecord ? 'Record a note for transcription' : 'Use device keyboard dictation in this browser.'} on:click={dictate}>{listening ? 'Listening…' : recording ? 'Stop recording' : 'Dictate'}</button>
{#if error}<output class="error dictation-error">{error}</output>{/if}
