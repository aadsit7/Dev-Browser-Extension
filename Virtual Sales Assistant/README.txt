Randy — Recast SE Assistant — Chrome Extension (Manifest V3)
===========================================================

Randy is a voice assistant that listens during your calls and answers Recast
product questions both on screen and aloud. It runs as a SIDE PANEL docked
beside your web pages — NOT a popup — so it stays open and keeps listening even
when you click away to another tab or window. (A popup would close the moment
it lost focus, which would cut Randy off mid-call.)


HOW TO LOAD (Developer mode -> Load unpacked)
---------------------------------------------
1. Open Chrome and go to:  chrome://extensions
2. Turn on "Developer mode" (toggle in the top-right corner).
3. Click "Load unpacked".
4. Select this "randy-recast-se-assistant" folder (the one containing
   manifest.json).
5. The extension appears in your list and its icon is added to the toolbar.


OPENING THE PANEL
-----------------
Click the Randy toolbar icon. There is NO popup — clicking the icon opens the
side panel docked to the side of the current page. (If you don't see the icon,
click the puzzle-piece "Extensions" button and pin Randy.)


FIRST-RUN PERMISSIONS (MICROPHONE)
----------------------------------
Randy listens with your microphone. The FIRST time it starts listening, Chrome
asks for microphone access — click "Allow". This is normal and expected:
Manifest V3 has no "microphone" permission string to declare up front; Chrome
prompts for the mic at runtime instead, which is the correct behavior. You can
stop listening any time from inside the panel; it resumes on the next open.


FIRST-RUN NAME + ANONYMOUS ID (one time only)
---------------------------------------------
The very first time the panel opens on a fresh install, Randy shows a single
onboarding screen that asks for your First name and Last name (both required)
and a Save button. The normal tool does not appear until you save. After you
save, this screen NEVER shows again on that install — every later open goes
straight to the normal tool.

Behind the scenes, on first run Randy also mints a random anonymous id with the
browser's built-in crypto.randomUUID(). Storage (all via chrome.storage.local,
which is why the manifest now requests the "storage" permission, and only that):
  - "anon_user_id" : the random id. Created once, then read back on every later
                     open — the same install keeps the same id forever.
  - "user_name"    : { firstName, lastName } from the onboarding screen.
The id (and name) are loaded at startup and are guaranteed to be in hand BEFORE
the first API call goes out (chrome.storage reads are async, so boot waits on
them and the mic/auto-listen only start once they've resolved).

WHERE THE NAME AND ID GO
  - To the model (Anthropic API, via the Apps Script / Worker proxy): ONLY the
    opaque random id is attached, as metadata.user_id. The name — and any other
    personal info — is NEVER sent to the API.
  - To the usage sheet (the existing Google Apps Script backend that already
    logs every Q&A): the name AND the id are sent together, so the name-to-id
    pairing is visible on the sheet side. The client now includes user_id,
    user_name, first_name and last_name in the background save payload.

ONE REMAINING SERVER-SIDE STEP FOR THE SHEET: two columns, "User_ID" and
"User_Name", have been added to the "Randy Tasks" tab of the "Recast SE" Google
Sheet so the data has somewhere to land. The extension already transmits those
values, but the row-append itself is performed by the Google Apps Script proxy
(which holds the Anthropic key and lives OUTSIDE this repository). That script
must be updated once to write the new user_id / user_name payload fields into
columns G and H; until then those two columns stay blank for new rows while
everything else keeps working exactly as before.


WHAT IT DOES
------------
- Listens to the call (Web Speech API), classifies overheard questions, and
  answers Recast product questions on screen and aloud (text-to-speech).
- One-way (just the mic) or two-way (mic + shared computer audio) listening.
- Typed chat, a searchable history sidebar, and a settings/config screen for
  the persona, research domains, and voice.
- Audio-component selection in Settings (Voice section): pick the microphone
  Randy opens, pick the speaking voice he answers with, and choose one-way vs
  two-way listening. Guidance adapts to Windows vs macOS.
- Answers are fetched and streamed from already-hosted backend services (see
  below); the extension does not change or replace those services.


CHOOSING YOUR AUDIO COMPONENTS (works on PC or Mac)
---------------------------------------------------
Open Settings (Voice section). Three choices let Randy work with any audio
setup:

  MICROPHONE — pick the input device, or leave it on the system default.
    IMPORTANT: Chrome's live speech recognizer always transcribes the
    OPERATING SYSTEM's DEFAULT microphone — a browser API can't point it at a
    specific device. Randy still opens the device you pick (to hold the mic
    permission and keep the background watchdog alive), but for the recognizer
    to hear a particular mic you must ALSO set that mic as your default input:
      - Windows: Settings -> System -> Sound -> Input
      - macOS:   System Settings -> Sound -> Input
    Settings shows a reminder (and warns you) when a non-default mic is pinned.
    A "Test microphone" button opens a live input-level meter so you can
    confirm the selected mic is actually being picked up before a call, and
    Settings also shows which device is your current OS default input (the one
    Chrome transcribes). The test uses its own short-lived capture and never
    touches Randy's listening.

  SPEAKING VOICE — choose which installed voice Randy answers in, or leave it
    on "Automatic" (Randy scores the installed voices and picks the most
    natural-sounding one — the original behavior). "Natural", "Neural", or
    Google voices sound the most human. Your pick is remembered; if that voice
    is ever uninstalled Randy silently falls back to the automatic pick so
    speech never breaks. Use "Preview Voice" to hear it.

  ONE-WAY vs TWO-WAY —
      One-way: microphone only, with echo cancellation / noise suppression on.
        Best on SPEAKERS when you only want your own voice picked up.
      Two-way: microphone PLUS your computer's own audio (captured via the
        screen-share picker), which is how Randy hears the OTHER side of the
        call when you're on HEADPHONES. When the share succeeds you'll see
        "Computer audio connected." Sharing differs by OS:
          - Windows: tick "Share system audio" (or share the call's tab).
          - macOS:   share the call's browser TAB and tick "Share tab audio"
                     (macOS Chrome can't share whole-system audio).
        The shared audio is transcribed locally by an in-browser Whisper model
        (see maintainer note 4 below). The FIRST time you use two-way, Randy
        downloads that model once (~77 MB) — you'll see "loading transcriber…"
        briefly; after that it's cached. The audio itself never leaves your
        machine. If the transcriber can't load, Randy simply stays on the mic.


EXTERNAL SERVICES IT TALKS TO
-----------------------------
Randy reaches its existing, already-deployed backends. The manifest grants the
host access these fetches need:
  - https://script.google.com/*             (Google Apps Script answer proxy)
  - https://script.googleusercontent.com/*  (where its response is served)
  - https://randy-stream.aadsit7.workers.dev/* (Cloudflare Worker answer stream)
These URLs are kept exactly as the original tool used them.


HOW IT WAS PACKAGED (notes for maintainers)
-------------------------------------------
The source was a single self-contained HTML file. Manifest V3 forbids a couple
of things that file relied on, so it was unpacked into ordinary local files
with behavior-preserving adjustments:

  1. Inline JavaScript is blocked by the MV3 content-security-policy. The one
     large inline <script> block is now shipped verbatim in panel.js and linked
     with <script src="panel.js">. The app logic is unchanged.

  2. The page loaded Tailwind and Lucide from the internet (cdn.tailwindcss.com
     and unpkg.com), which MV3 blocks. Both are now local:
       - tailwind.css is a static Tailwind v3 build (Preflight + exactly the
         utility classes this app uses) that reproduces the original styling.
       - lib/lucide.min.js is the Lucide icon library, vendored locally and
         initialized the same way the original did (window.lucide.createIcons).

  3. The DM Sans web font is still loaded from Google Fonts via a normal
     stylesheet <link>. MV3 allows remote stylesheets and fonts on extension
     pages, so this needs no extra permission and keeps the type identical.

The external backend calls (Apps Script proxy + Cloudflare Worker) were left
exactly as-is.

  4. TWO-WAY "Share computer audio" — in-browser Whisper, now working under MV3.
     The two-way path transcribes shared computer audio locally with a Whisper
     model (Transformers.js + ONNX Runtime), so Randy hears the OTHER side of a
     call even on headphones. Originally this loaded Transformers.js and the ONNX
     runtime from a CDN inside a Blob worker, which the MV3 content-security-
     policy (script-src 'self') blocks — so it silently fell back to mic-only.
     It now runs under MV3 because everything the worker needs is bundled and
     same-origin:
       - whisper-worker.js is a REAL module worker file (not a Blob and not a
         CDN import), loaded via chrome.runtime.getURL. Same-origin scripts are
         allowed by script-src 'self'; Blob/CDN workers are not.
       - lib/transformers/ vendors Transformers.js (self-contained ESM build)
         and the ONNX Runtime (WASM + WebGPU) — transformers.min.js, the ORT
         glue .mjs, and the ORT .wasm. The worker points wasmPaths at this
         folder, so no code is ever fetched from the network.
       - manifest.json adds a content_security_policy that appends
         'wasm-unsafe-eval' to the default script-src (needed to compile the
         ONNX WASM). This is a strict SUPERSET of the MV3 default — it only adds
         WASM permission and changes nothing else — so no existing behavior is
         affected.
     Only the model WEIGHTS (~77 MB for the quantized/CPU build) download once
     from the Hugging Face hub on first use, then the browser caches them; audio
     itself never leaves the machine. WebGPU is used when available (real-time),
     with a WASM/CPU fallback that works everywhere. If anything about the
     transcriber fails to load, the code still falls back to mic-only exactly as
     before, so this can never make Randy worse than one-way listening.


FILES
-----
  manifest.json          Manifest V3 configuration
  panel.html             The side-panel page (was the single-file HTML)
  panel.js               All app logic (was the inline <script> block)
  panel.css              The app's styles (was the inline <style> block)
  tailwind.css           Static local Tailwind build (replaces the CDN runtime)
  background.js          Service worker — makes the toolbar icon open the panel
  lib/lucide.min.js      Lucide icon library, bundled locally
  whisper-worker.js      Computer-audio transcription worker (two-way listening)
  lib/transformers/      Vendored Transformers.js + ONNX Runtime (local, for Whisper)
  icons/                 Toolbar/extension icons (16, 48, 128 px)
  README.txt             This file
