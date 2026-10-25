<script>
  export let value = '';
  let listening = false;
  const Recognition = typeof window === 'undefined' ? null : window.SpeechRecognition || window.webkitSpeechRecognition;

  function dictate() {
    if (!Recognition) return;
    const initial = value.trim(); let transcript = '';
    const recognition = new Recognition();
    recognition.lang = navigator.language || 'en-CA'; recognition.interimResults = true; recognition.continuous = true;
    recognition.onstart = () => listening = true;
    recognition.onresult = (event) => { transcript = [...event.results].map((result) => result[0].transcript).join(''); value = [initial, transcript.trim()].filter(Boolean).join(initial && transcript ? ' ' : ''); };
    recognition.onend = () => listening = false;
    recognition.onerror = () => recognition.stop();
    recognition.start();
  }
</script>

<button type="button" class:active={listening} disabled={!Recognition} title={Recognition ? 'Speak a note' : 'Use device keyboard dictation in this browser.'} on:click={dictate}>{listening ? 'Listening…' : 'Dictate'}</button>
