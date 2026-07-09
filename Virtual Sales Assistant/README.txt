Virtual Sales Assistant — Chrome Extension (Manifest V3)
=========================================================

The Virtual Sales Assistant listens to your live sales call and maintains a
VISUAL CHECKLIST of the things you want to cover. As each item is genuinely
discussed or completed in the conversation, the assistant automatically checks
it off on screen. It is deliberately conservative: an item is only ticked when
the AI is highly confident it was actually covered — a passing mention is
never enough — and nothing is ever automatically UNchecked. You can always
tap any item to check or uncheck it yourself; the human override wins.

It runs as a SIDE PANEL docked beside your web pages — NOT a popup — so it
stays open and keeps listening even when you click away to another tab or
window. (A popup would close the moment it lost focus, which would cut the
listening off mid-call.)


HOW TO LOAD (Developer mode -> Load unpacked)
---------------------------------------------
1. Open Chrome and go to:  chrome://extensions
2. Turn on "Developer mode" (toggle in the top-right corner).
3. Click "Load unpacked".
4. Select this "Virtual Sales Assistant" folder (the one containing
   manifest.json).
5. The extension appears in your list and its icon is added to the toolbar.


OPENING THE PANEL
-----------------
Click the toolbar icon. There is NO popup — clicking the icon opens the side
panel docked to the side of the current page. (If you don't see the icon,
click the puzzle-piece "Extensions" button and pin the Virtual Sales
Assistant.)


THE CHECKLIST (the main feature)
--------------------------------
The main panel shows your call checklist:

  - Each item is a row with a checkbox and its text. Unchecked items look
    plain; a covered item gets a checkmark with struck-through, greyed text —
    and, when it was checked automatically, a one-line note of what was said
    that covered it.
  - Manage the list right on the panel, before and during a call: add an item
    (box at the bottom), edit its text (pencil), reorder (up/down arrows), and
    remove (trash).
  - Tap any item (or its checkbox) to check or uncheck it manually. Manual
    control always wins: an item you manually uncheck will not be re-checked
    automatically for the rest of the call.
  - "Reset" (top of the list, also in the side menu) unchecks everything for
    the next call, keeping the items themselves.

The checklist and its checked/unchecked state persist in chrome.storage.local,
so closing the panel mid-call loses nothing.

DEFAULT CHECKLIST: in Settings you can save a reusable default list (one item
per line). New installs / fresh state start from it, and "Use this list now"
replaces the current checklist with the default at any time (all unchecked).

HOW AUTO-CHECKING WORKS: while listening, finalized speech is grouped into a
rolling window of recent conversation. Each new utterance sends that window,
plus your still-unchecked items, to an AI classifier (via the existing
already-deployed proxy — see below). Only when the classifier reports, with
HIGH confidence, that one item has genuinely been discussed or completed does
the panel tick it. Anything uncertain does nothing, and the classifier can
never uncheck an item.


FIRST-RUN PERMISSIONS (MICROPHONE)
----------------------------------
The assistant listens with your microphone. The FIRST time it starts
listening, Chrome asks for microphone access — click "Allow". This is normal
and expected: Manifest V3 has no "microphone" permission string to declare up
front; Chrome prompts for the mic at runtime instead. You can stop listening
any time from inside the panel; it resumes on the next open.


FIRST-RUN NAME + ANONYMOUS ID (one time only)
---------------------------------------------
The very first time the panel opens on a fresh install, it shows a single
onboarding screen that asks for your First name and Last name (both required)
and a Save button. After you save, this screen never shows again on that
install.

Behind the scenes, on first run the extension also mints a random anonymous id
with the browser's built-in crypto.randomUUID(). Storage (all via
chrome.storage.local):
  - "anon_user_id"          : the random id; the same install keeps it forever.
  - "user_name"             : { firstName, lastName } from onboarding.
  - "vsa_checklist"         : the current checklist and its checked state.
  - "vsa_default_checklist" : the reusable default list edited in Settings.
Only the opaque random id is ever attached to AI calls (metadata.user_id);
the name is never sent to the model.


CHOOSING YOUR AUDIO COMPONENTS (works on PC or Mac)
---------------------------------------------------
Open Settings. The listening setup is unchanged from the original tool:

  MICROPHONE — pick the input device, or leave it on the system default.
    IMPORTANT: Chrome's live speech recognizer always transcribes the
    OPERATING SYSTEM's DEFAULT microphone — a browser API can't point it at a
    specific device. To have a particular mic transcribed, also set it as
    your default input:
      - Windows: Settings -> System -> Sound -> Input
      - macOS:   System Settings -> Sound -> Input
    A "Test microphone" button opens a live input-level meter so you can
    confirm the selected mic is actually being picked up before a call.

  ONE-WAY vs TWO-WAY —
      One-way: microphone only, with echo cancellation / noise suppression on.
        Best on SPEAKERS when you only want your own voice picked up.
      Two-way: microphone PLUS your computer's own audio (captured via the
        screen-share picker) — how the assistant hears the OTHER side of the
        call when you're on HEADPHONES. Sharing differs by OS:
          - Windows: tick "Share system audio" (or share the call's tab).
          - macOS:   share the call's browser TAB and tick "Share tab audio"
                     (macOS Chrome can't share whole-system audio).
        The shared audio is transcribed locally by an in-browser Whisper
        model. The FIRST time you use two-way, the model downloads once
        (~77 MB) — you'll see "loading transcriber…" briefly; after that it's
        cached. The audio itself never leaves your machine. If the
        transcriber can't load, listening simply stays on the mic.


EXTERNAL SERVICES IT TALKS TO
-----------------------------
The assistant reaches the same existing, already-deployed backends as the
original tool — unchanged:
  - https://script.google.com/*             (Google Apps Script AI proxy — the
                                             coverage classifier goes through
                                             it; the Anthropic key lives there)
  - https://script.googleusercontent.com/*  (where its response is served)
The manifest grants the host access these fetches need. No servers were
added, changed, or replaced, and no API keys live in this extension.


HOW IT WAS PACKAGED (notes for maintainers)
-------------------------------------------
This extension reuses the original side-panel listening stack unchanged:

  1. Inline JavaScript is blocked by the MV3 content-security-policy, so all
     app logic ships in panel.js, linked with <script src="panel.js">.

  2. Tailwind and Lucide are vendored locally (tailwind.css is a static
     build; lib/lucide.min.js exposes window.lucide) because MV3 blocks CDN
     scripts. The DM Sans/Poppins/Figtree web fonts still load from Google
     Fonts via a normal stylesheet <link>, which MV3 allows.

  3. TWO-WAY "Share computer audio" — in-browser Whisper under MV3:
       - whisper-worker.js is a REAL module worker file (not a Blob and not a
         CDN import), loaded via chrome.runtime.getURL — allowed by
         script-src 'self'.
       - lib/transformers/ vendors Transformers.js (self-contained ESM build)
         and the ONNX Runtime (WASM + WebGPU), so no code is fetched from the
         network at runtime.
       - manifest.json appends 'wasm-unsafe-eval' to the default script-src
         (needed to compile the ONNX WASM) — a strict superset of the MV3
         default.
     Only the model WEIGHTS (~77 MB quantized) download once from the Hugging
     Face hub on first use, then the browser caches them; audio never leaves
     the machine. If anything about the transcriber fails to load, the code
     falls back to mic-only listening.

  4. What changed for the checklist repurpose: the question-answering
     behavior (on-screen answers, read-aloud text-to-speech, typed chat) was
     removed, and the AI classifier was repurposed — same proxy, same call
     shape, new job. It now receives the recent conversation window plus the
     still-unchecked checklist items and returns structured JSON
     ({covered, item_id, confidence, evidence}); the panel ticks an item only
     at high confidence, and never unchecks one automatically.


FILES
-----
  manifest.json          Manifest V3 configuration
  panel.html             The side-panel page
  panel.js               All app logic (listening + checklist)
  panel.css              The app's styles (checklist styles at the bottom)
  tailwind.css           Static local Tailwind build (replaces the CDN runtime)
  background.js          Service worker — makes the toolbar icon open the panel
  lib/lucide.min.js      Lucide icon library, bundled locally
  whisper-worker.js      Computer-audio transcription worker (two-way listening)
  lib/transformers/      Vendored Transformers.js + ONNX Runtime (local, for Whisper)
  icons/                 Toolbar/extension icons (16, 48, 128 px)
  README.txt             This file
