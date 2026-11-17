// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useRef, useState } from 'react'
import { getHostAdapter } from '../host/hostAdapter.js'

interface SpeechRecognitionResultLike {
  readonly length: number
  isFinal: boolean
  0: { transcript: string }
}
interface SpeechRecognitionEventLike {
  resultIndex: number
  results: ArrayLike<SpeechRecognitionResultLike>
}
interface SpeechRecognitionErrorEventLike {
  error: string
  message?: string
}
interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onstart: (() => void) | null
  onend: (() => void) | null
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

// [0, 250, 500, 1000, 2000]ms between restarts, capped at MAX_EMPTY_RESTARTS consecutive
// restarts that each produced no result - a bare `onend` -> `start()` loop can spin the CPU
// (or, worse, storm requests) if the recognizer fails immediately every time.
const RESTART_BACKOFF_MS = [0, 250, 500, 1000, 2000]
const MAX_EMPTY_RESTARTS = 8

// Dictation is disabled inside third-party iframe hosts (see the module docblock below for why),
// via `supported`, rather than left in with a broken button.
const MIC_BLOCKED_GENERIC = 'Microphone access is blocked — allow it in your browser or site settings to dictate.'

// Both are third-party, cross-origin iframes, which is the specific thing Chrome blocks
// the network-backed Web Speech API inside (see the module docblock below).
const BLOCKED_PLATFORMS = new Set(['teams', 'tableau'])

// Fire-and-forget, same rationale as useAgentStream's telemetry call - never awaited, never
// throws, and a host without `telemetry` just gets no signal instead of a crash.
function reportDictationError(code: string): void {
  getHostAdapter().telemetry?.(undefined, 'dictation_error', { code, platform: getHostAdapter().platform })
}

export interface VoiceDictationResult {
  /** Browser API presence only - see the module docblock for what it does NOT confirm. */
  supported: boolean
  listening: boolean
  /** Live, not-yet-final text for the segment in progress. '' when there is none. */
  interim: string
  error: string | null
  /** True while the one-time getUserMedia permission probe (see `start`) is in flight. */
  probing: boolean
  start: () => void
  stop: () => void
}

/**
 * Web Speech API dictation, disabled on iframe hosts. `useVoiceDictation` is shared code, but
 * `supported` is forced `false` on Teams (`HostAdapter.platform === 'teams'`) regardless of
 * browser API presence: verified by direct testing (getUserMedia + Teams' own "App permissions"
 * grant both succeeding, but `SpeechRecognition` still failing `not-allowed`, versus the exact
 * same page working standalone with zero iframes) that Chrome blocks the network-backed Web
 * Speech API inside third-party cross-origin iframes - which is what every Teams tab is - with
 * no available override via headers, manifest, or Teams settings. Any other third-party iframe host is excluded for the same reason. A host whose iframe
 * grants `allow="microphone"` itself is not affected, and dictation works there.
 *
 * `continuous`/`interimResults` are both on: a single utterance-then-stop session (the original
 * behaviour) is what "stops early" looks like from the user's side. Staying continuous means the
 * session now only ends on an explicit `stop()`, a disarming error, or the recognizer's own
 * `onend` - which is auto-restarted (bounded, see RESTART_BACKOFF_MS) rather than treated as
 * "done", since some engines emit `onend` periodically even while the user keeps talking.
 */
export function useVoiceDictation(
  onFinalTranscript: (text: string) => void,
  onInterim?: (text: string) => void,
): VoiceDictationResult {
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [probing, setProbing] = useState(false)

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  // Armed = "the user wants dictation running". Distinct from `listening`/recognitionRef:
  // during a backoff wait between an `onend` and the next `start()`, recognitionRef is null
  // and there is no live session, but armed stays true so the scheduled restart still fires.
  const armedRef = useRef(false)
  // How far into the *current session's* results array finals have already been delivered.
  // Reset per session (recognizers renumber `results` from 0 on each `start()`), and only
  // ever consulted from `e.resultIndex` forward - rescanning from 0 every event is exactly
  // what re-delivers old finals and duplicates text.
  const deliveredUpToRef = useRef(0)
  const restartAttemptRef = useRef(0)
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The getUserMedia probe runs once per hook lifetime, on the first start() - not on mount,
  // which would prompt for mic access before the user asked for dictation at all.
  const probedRef = useRef(false)
  const onFinalRef = useRef(onFinalTranscript)
  onFinalRef.current = onFinalTranscript
  const onInterimRef = useRef(onInterim)
  onInterimRef.current = onInterim

  const Ctor: SpeechRecognitionCtor | undefined = typeof window !== 'undefined'
    ? ((window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor })
        .SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionCtor }).webkitSpeechRecognition)
    : undefined
  const supported = !!Ctor && !BLOCKED_PLATFORMS.has(getHostAdapter().platform ?? '')

  const clearRestartTimer = useCallback(() => {
    if (restartTimerRef.current !== null) {
      clearTimeout(restartTimerRef.current)
      restartTimerRef.current = null
    }
  }, [])

  const setInterimText = useCallback((text: string) => {
    setInterim(text)
    onInterimRef.current?.(text)
  }, [])

  const runRecognition = useCallback(() => {
    if (!Ctor) return
    const recognition = new Ctor()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US'
    deliveredUpToRef.current = 0

    recognition.onresult = (e) => {
      // Any result at all means the recognizer is working - forgive whatever restart
      // attempts got us here.
      restartAttemptRef.current = 0
      let interimText = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]
        if (result.isFinal) {
          if (i >= deliveredUpToRef.current) {
            deliveredUpToRef.current = i + 1
            const transcript = result[0].transcript
            if (transcript) onFinalRef.current(transcript)
          }
        } else {
          interimText = interimText ? `${interimText} ${result[0].transcript}` : result[0].transcript
        }
      }
      setInterimText(interimText)
    }

    recognition.onend = () => {
      recognitionRef.current = null
      setInterimText('')
      if (!armedRef.current) { setListening(false); return }
      if (restartAttemptRef.current >= MAX_EMPTY_RESTARTS) {
        armedRef.current = false
        setListening(false)
        setError('Dictation stopped — no speech detected.')
        return
      }
      const delay = RESTART_BACKOFF_MS[Math.min(restartAttemptRef.current, RESTART_BACKOFF_MS.length - 1)]
      restartAttemptRef.current += 1
      restartTimerRef.current = setTimeout(() => {
        restartTimerRef.current = null
        if (armedRef.current) runRecognition()
      }, delay)
    }

    recognition.onerror = (e) => {
      const code = e?.error
      // 'no-speech' is not a failure worth stopping over - a pause mid-thought is normal, and
      // the onend that follows will restart on the same bounded backoff as any other empty
      // session. Everything else here is a reason dictation genuinely cannot continue.
      if (code === 'no-speech') return
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        armedRef.current = false
        setListening(false)
        setError(MIC_BLOCKED_GENERIC)
        reportDictationError(code)
      } else if (code === 'network') {
        // The likely Teams desktop signature: webkitSpeechRecognition present but backed by
        // no working speech service in a non-Chrome Chromium embedder.
        armedRef.current = false
        setListening(false)
        setError('Speech recognition is unavailable in this client.')
        reportDictationError(code)
      } else if (code === 'audio-capture') {
        armedRef.current = false
        setListening(false)
        setError('No microphone found.')
        reportDictationError(code)
      } else {
        armedRef.current = false
        setListening(false)
        setError(e?.message || code || 'Dictation error.')
        reportDictationError(code)
      }
    }

    recognitionRef.current = recognition
    recognition.start()
  }, [Ctor, setInterimText])

  const start = useCallback(() => {
    if (!supported || armedRef.current) return
    setError(null)
    armedRef.current = true
    restartAttemptRef.current = 0
    setListening(true)

    const mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
    if (probedRef.current || !mediaDevices?.getUserMedia) {
      runRecognition()
      return
    }
    probedRef.current = true
    setProbing(true)
    mediaDevices.getUserMedia({ audio: true }).then(
      (stream) => {
        stream.getTracks().forEach((t) => t.stop())
        setProbing(false)
        if (armedRef.current) runRecognition()
      },
      (err: unknown) => {
        setProbing(false)
        armedRef.current = false
        setListening(false)
        const name = err instanceof DOMException ? err.name : undefined
        setError(
          name === 'NotAllowedError'
            ? MIC_BLOCKED_GENERIC
            : name === 'NotFoundError'
              ? 'No microphone found.'
              : 'Could not access the microphone.',
        )
        reportDictationError(name ?? 'unknown')
      },
    )
  }, [supported, runRecognition])

  const stop = useCallback(() => {
    armedRef.current = false
    clearRestartTimer()
    setInterimText('')
    recognitionRef.current?.stop()
  }, [clearRestartTimer, setInterimText])

  return { supported, listening, interim, error, probing, start, stop }
}
