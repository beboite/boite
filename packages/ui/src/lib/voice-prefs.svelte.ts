/** Capture belongs to this device, even when its conversation uses a remote core. */
interface VoicePrefs { enabled: boolean; microphoneId: string }
export const VOICE_STORAGE_KEY = 'boite.voice';

function read(): VoicePrefs {
  try {
    const value = JSON.parse(localStorage.getItem(VOICE_STORAGE_KEY) ?? 'null');
    return { enabled: value?.enabled !== false, microphoneId: typeof value?.microphoneId === 'string' ? value.microphoneId : '' };
  } catch { return { enabled: true, microphoneId: '' }; }
}

class Voice {
  current = $state<VoicePrefs>(read());

  load(): void { this.current = read(); }

  #save(patch: Partial<VoicePrefs>): void {
    this.current = { ...this.current, ...patch };
    try { localStorage.setItem(VOICE_STORAGE_KEY, JSON.stringify(this.current)); }
    catch { /* Keep the choice for this session when storage is unavailable. */ }
  }

  setEnabled(enabled: boolean): void { this.#save({ enabled }); }
  setMicrophone(microphoneId: string): void { this.#save({ microphoneId }); }
}

export const voice = new Voice();
