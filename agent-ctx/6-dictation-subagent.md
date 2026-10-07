# Task 6 — dictation-subagent — Browser speech recognition (Google-backed) in the chat composer

See `/home/z/my-project/worklog.md` (Task ID: 6 section) for the full record. Summary:

## Files
- **NEW** `src/components/assistant-ui/elements/dictation.tsx` — `ComposerVoice` (waveform surface that replaces the textarea: pulsing `bg-destructive` dot, 14 sine-ripple bars driven by an internal ~30fps rAF loop writing DOM heights directly, `prefers-reduced-motion` → static mid bars, flat bars + `ShimmerLabel` "Transcribing…" settle, mono `m:ss` clock, truncated `aria-live="polite"` interim transcript, `role="status"` state label) and `ComposerVoiceButton` (ghost h-9 w-9 rounded-xl mic toggle; filled `Square` + soft `animate-ping` ring while active).
- **NEW** `src/hooks/use-dictation.ts` — `useDictation({ onFinalText })` → `{ supported, active, recording, seconds, interim, error, start, stop }`. Single-utterance Web Speech (`continuous=false`, `interimResults=true`, `navigator.language`), finals flushed once after a 600ms settle, never stuck in Transcribing (no finals → straight to idle, PRD §49), stop-during-settle flushes immediately, permission errors → inline `error` string self-clearing in 4s (no toasts from hooks), ref-guarded against double recognitions, abort+timers cleaned on unmount, `supported` via `useSyncExternalStore` (SSR-safe).
- `src/types/speech.d.ts` — added `SpeechRecognitionErrorEvent` (`error`/`message`), `onerror` now typed with it.
- `src/components/assistant-ui/elements/index.ts` — export `ComposerVoice`, `ComposerVoiceButton`.
- `src/hooks/index.ts` — export `useDictation`.
- `src/components/chat/chat-input.tsx` — mic in right cluster before Stop/Send (hidden when unsupported, PRD §24); `active ? <ComposerVoice/> : <textarea/>` swap in the center; finals appended to `message` (space-prefixed) + textarea refocused via rAF; auto-resize deps `[message, dictation.active]` so the remounted textarea re-measures (existing `if (!el) return` guard handles the unmounted span); inline `role="alert"` error hint under the input row; mic disabled only by `disabled` (NOT `isProcessing`). Attach/quote/attachments/slash palette untouched.

## Verification
- `bun run lint`: 0 errors (31 pre-existing warnings in unrelated files).
- `bunx tsc --noEmit`: no errors in touched files (remaining project errors pre-exist in knowledge-base/files-client/kb-store).
- `dev.log`: only ✓ compiles after the changes; no error entries in the whole log.

## Notable decisions / adjustments
- `react-hooks/set-state-in-effect` (error severity here) rejected a mount-effect `setSupported` → used the `useSyncExternalStore` client-probe pattern instead.
- Waveform mutates `style.height` imperatively (~30fps) — zero React re-renders for animation; loop killed when not recording.
- Bars `bg-primary/80`, dot/stop `bg-destructive` — theme tokens only; `motion-reduce:animate-none` on ping/pulse.
