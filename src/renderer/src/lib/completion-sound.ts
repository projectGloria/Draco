import soundUrl from '../../../../resources/sounds/download-complete.wav'

let audio: HTMLAudioElement | undefined
let lastPlayed = 0

/** Coalesce downloads finishing together into one quiet, short chime. */
export function playCompletionSound(): void {
  const now = Date.now()
  if (now - lastPlayed < 1000) return
  lastPlayed = now
  audio ??= new Audio(soundUrl)
  audio.volume = 0.55
  audio.currentTime = 0
  void audio.play().catch((error) => console.warn('Completion sound could not play', error))
}
