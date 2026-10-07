"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * useDictation — browser speech recognition for the composer (the
 * Google-backed Web Speech API). One utterance per mic tap
 * (`continuous = false` — the robust mode: the engine finalizes and fires
 * `onend` on its own once the user pauses).
 *
 * State machine:
 *
 *   idle ──start()──▶ recording ──onend/onerror──▶ finals? transcribing : idle
 *
 * - `active` = a session is live (recording OR the brief transcribing
 *   settle). The composer swaps its textarea for the voice surface while
 *   it's true.
 * - `recording` = capturing audio (waveform ripples; false during the
 *   "Transcribing" settle — never stuck there, PRD §49: if nothing was
 *   captured we return straight to idle).
 * - Finals accumulate silently and land in the composer once, at the end of
 *   the settle, through `onFinalText` (kept in a ref, so callers may pass
 *   inline callbacks without re-arming the session).
 * - Permission failures (`not-allowed` / `service-not-allowed`) surface as
 *   `error` for ~4s — the UI renders an inline hint; no toasts from a hook.
 */

/** How long the "Transcribing" settle holds before finals land. */
const TRANSCRIBE_SETTLE_MS = 600;
/** How long the inline error hint stays visible. */
const ERROR_HINT_MS = 4000;

/** No-op subscription — Web Speech availability never changes at runtime. */
const subscribeNoop = () => () => {};
/** Client-only feature probe (the server snapshot below reports false). */
function getSupportedSnapshot(): boolean {
  return !!(window.SpeechRecognition ?? window.webkitSpeechRecognition);
}

export interface UseDictationResult {
  /** Web Speech API available in this browser. */
  supported: boolean;
  /** A session is live (recording or transcribing). */
  active: boolean;
  /** Capturing audio — false during the transcribing settle. */
  recording: boolean;
  /** Elapsed capture seconds. */
  seconds: number;
  /** Live partial transcript ("" until the engine produces one). */
  interim: string;
  /** Human-readable failure (permission denied); auto-clears. */
  error: string | null;
  /** Begin a session (single utterance). */
  start: () => void;
  /** End the session (stop capture / flush a pending transcription now). */
  stop: () => void;
}

export function useDictation({
  onFinalText,
}: {
  /** Receives the finalized transcript; the composer appends it as text. */
  onFinalText: (text: string) => void;
}): UseDictationResult {
  // Feature detection via useSyncExternalStore: the server snapshot is
  // false, the client snapshot probes the API once — SSR-safe (no
  // hydration mismatch on the mic button) with no cascading mount render.
  const supported = useSyncExternalStore(
    subscribeNoop,
    getSupportedSnapshot,
    () => false,
  );

  const [active, setActive] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Latest callback without re-creating the start/stop identities.
  const onFinalTextRef = useRef(onFinalText);
  useEffect(() => {
    onFinalTextRef.current = onFinalText;
  }, [onFinalText]);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const finalsRef = useRef("");
  const secondsTimerRef = useRef<number | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  const errorTimerRef = useRef<number | null>(null);

  const clearSecondsTimer = useCallback(() => {
    if (secondsTimerRef.current !== null) {
      window.clearInterval(secondsTimerRef.current);
      secondsTimerRef.current = null;
    }
  }, []);

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  /** Land the accumulated finals (if any) and return to idle. Idempotent. */
  const landFinals = useCallback(() => {
    clearSettleTimer();
    const text = finalsRef.current.trim();
    finalsRef.current = "";
    if (text) onFinalTextRef.current(text);
    setInterim("");
    setRecording(false);
    setActive(false);
  }, [clearSettleTimer]);

  /** onend / manual end: stop the clock, settle briefly only when finals
   *  are pending — otherwise go straight back to idle (PRD §49). */
  const handleEnd = useCallback(() => {
    recognitionRef.current = null;
    clearSecondsTimer();
    setRecording(false);
    if (finalsRef.current.trim()) {
      settleTimerRef.current = window.setTimeout(landFinals, TRANSCRIBE_SETTLE_MS);
    } else {
      landFinals();
    }
  }, [clearSecondsTimer, landFinals]);

  const start = useCallback(() => {
    // Guard: a session is already live — rapid taps must not stack
    // recognitions (a second engine would error `invalid-state` anyway).
    if (recognitionRef.current) return;
    const Ctor =
      typeof window !== "undefined"
        ? (window.SpeechRecognition ?? window.webkitSpeechRecognition)
        : undefined;
    if (!Ctor) return;

    const recognition = new Ctor();
    recognition.lang = navigator.language || "en-US";
    recognition.continuous = false; // single utterance per tap — simpler, robust
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) {
          finalsRef.current = `${finalsRef.current} ${transcript}`.trim();
        } else {
          interimText += transcript;
        }
      }
      setInterim(interimText.trim());
    };
    recognition.onerror = (event) => {
      // Only permission failures need a visible hint; everything else
      // (no-speech, aborted, network) is followed by onend, which resets.
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setError("Microphone permission denied");
        if (errorTimerRef.current !== null) window.clearTimeout(errorTimerRef.current);
        errorTimerRef.current = window.setTimeout(() => setError(null), ERROR_HINT_MS);
      }
    };
    recognition.onend = handleEnd;

    finalsRef.current = "";
    setSeconds(0);
    setInterim("");
    setError(null);
    try {
      recognition.start();
    } catch {
      // Invalid-state race — drop everything and stay idle.
      recognitionRef.current = null;
      return;
    }
    recognitionRef.current = recognition;
    setActive(true);
    setRecording(true);
    clearSecondsTimer();
    secondsTimerRef.current = window.setInterval(() => {
      setSeconds((s) => s + 1);
    }, 1000);
  }, [handleEnd, clearSecondsTimer]);

  const stop = useCallback(() => {
    const recognition = recognitionRef.current;
    if (recognition) {
      try {
        recognition.stop(); // triggers onend → settle → land
      } catch {
        handleEnd();
      }
      return;
    }
    // No live capture — we're mid-"Transcribing": flush now instead of
    // letting the settle timer hold the composer hostage.
    landFinals();
  }, [handleEnd, landFinals]);

  // Unmount: abort capture and clear every timer (calling onFinalText after
  // unmount would target a dead composer).
  useEffect(() => {
    return () => {
      const recognition = recognitionRef.current;
      if (recognition) {
        try {
          recognition.abort();
        } catch {
          /* already dead */
        }
        recognitionRef.current = null;
      }
      if (secondsTimerRef.current !== null) window.clearInterval(secondsTimerRef.current);
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
      if (errorTimerRef.current !== null) window.clearTimeout(errorTimerRef.current);
    };
  }, []);

  return { supported, active, recording, seconds, interim, error, start, stop };
}
