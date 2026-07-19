AI Projects Assistant — Chrome Extension (Manifest V3)
======================================================

Keep every AI project you're working on at your fingertips. AI Projects
Assistant runs as a SIDE PANEL docked beside your web pages: an iOS-style
springboard where each tile is one AI project. Tap a tile to open the
project's DETAIL VIEW — its description and, most importantly, your working
NOTES — and everything you type is written back to your Google Sheet.

(This app was converted from "Bookmarks Buddy". The springboard, folders,
jiggle-rearrange, search, voice control, themes, and Google Sheet sync layer
are all unchanged — only what a tile IS and what tapping it DOES changed.)


HOW TO LOAD (Developer mode -> Load unpacked)
---------------------------------------------
1. Open Chrome and go to:  chrome://extensions
2. Turn on "Developer mode" (toggle in the top-right corner).
3. Click "Load unpacked".
4. Select this "AI Project Assistant" folder (the one containing manifest.json).
5. The extension appears in your list and its icon is added to the toolbar.

OPENING THE PANEL
-----------------
Click the AI Projects Assistant toolbar icon. There is NO popup — clicking
the icon opens the side panel docked to the side of the current page. (If you
don't see the icon, click the puzzle-piece "Extensions" button and pin it.)

FIRST-RUN PERMISSIONS
---------------------
The first time the panel opens it starts the microphone listener, so Chrome
asks for microphone access. Allow it to use voice features. (You can stop
listening any time by tapping the mic; it starts again on the next open.)


WHAT IT DOES
------------
- Loads your AI projects from your Google Sheet on launch (see below) and
  keeps the springboard arrangement — pages, folders, and order — in sync.
- Each tile is one project: a name, an icon, a short description, an optional
  link, and multi-line working notes.
- TAP A TILE -> the project detail view opens (no browser tab). Edit the
  Description and Notes right there; closing the view auto-saves any change
  to the sheet (with the offline queue and "Saving…" -> "Saved" toasts).
  The pencil button opens the full editor (rename, link, icon, delete);
  the "Open" button appears only when the project has a link.
- Voice: say "open <project>" to jump straight to that project's detail
  view; "open <folder>" opens the folder. "add project <name>" creates a
  tile (no link needed). The recognizer reads several of the speech engine's
  hypotheses per phrase and fuzzy-matches against name + notes, so close
  calls show a quick chooser instead of guessing.
- Springboard home screen with named pages, folders, and a rearrange
  ("jiggle") edit mode. Press and hold a tile to lift it straight into a
  drag; neighbours flow out of the way in real time. Carry a tile onto the
  edge arrows to move it between pages; drop one tile onto another to make
  or join a folder — the same fluid feel as iOS.
- localStorage is kept as an instant, offline mirror.
- Icons: paste any image URL per project, or (when the project has a link)
  the site favicon is fetched automatically from Google's public favicon
  service; projects with neither show a colored monogram tile.


GOOGLE SHEET SYNC
-----------------
Your projects live in the "Projects" tab of your "AI Projects" Google Sheet,
reached through a deployed Apps Script web app. On launch the extension pulls
the list and rebuilds your pages/folders/order from the sheet's
Folder / Page / Position columns; every change you make (add, edit notes,
remove, rearrange) is written back, and changes made while offline are queued
and flushed once the sheet is reachable again. The sheet is authoritative.

Columns (tab "Projects", row 1):
  Bookmark ID | Name | URL | Folder | Page | Position | Owner (Profile ID) |
  Date Added | Last Opened | Times Opened | Notes | Icon | Description

The server side lives in apps-script/Code.gs IN THIS FOLDER. To (re)install:
  1. Open the Apps Script project behind your deployed web app URL
     (the constant near the top of the sheet section in
     lib/component-logic.js — search for "script.google.com/macros").
  2. Replace the contents of Code.gs with apps-script/Code.gs and save.
  3. Deploy -> Manage deployments -> edit the EXISTING deployment (pencil)
     -> Version: "New version" -> Deploy. Editing the existing deployment
     keeps the same /exec URL, so the extension needs no change.
     ("Execute as: Me", "Who has access: Anyone".)
The script creates the "Projects" tab (and any missing columns) by itself.

TOKEN (optional): no token is required by default. To require one, set an
APP_TOKEN Script Property in the Apps Script project, then in the panel's
DevTools console run:  bbSetToken('your-token')   (clear with bbSetToken('')).
A ?token=… on the panel URL works too.

This is why the manifest requests host access to:
  - https://script.google.com/*            (the Apps Script web app)
  - https://script.googleusercontent.com/* (where its GET response is served)


HOW IT WAS PACKAGED (notes for maintainers)
-------------------------------------------
The source was an exported, self-extracting single-file bundle built on a
small React-based template framework ("dc-runtime"). Manifest V3 forbids two
things the original relied on, so the bundle was unpacked into ordinary local
files and two minimal, behavior-preserving adjustments were made:

  1. dc-runtime evaluated the component logic with `new Function(...)`, which
     MV3's content-security-policy blocks. The component source is shipped
     verbatim in lib/component-logic.js, wrapped in a real function; dc-runtime
     was patched to call it instead of compiling a string.

  2. dc-runtime loaded React, ReactDOM and Babel from a CDN at runtime. Those
     are bundled locally (lib/react*.js) and the runtime's URLs point at the
     local copies. (Babel is only used for JSX, which this app does not use,
     so it is not bundled.)

Everything is local, so the default MV3 CSP is used (no custom CSP needed).
There is no build step: edit lib/component-logic.js / panel.html directly.


FILES
-----
  manifest.json              Manifest V3 configuration
  panel.html                 The side-panel page (the unpacked app template)
  background.js              Service worker — makes the toolbar icon open the panel
  apps-script/Code.gs        The Google Apps Script web app (server side of sync)
  lib/dc-runtime.js          The template framework (patched: no eval, local URLs)
  lib/component-logic.js     The app's component logic (springboard, detail view,
                             voice, and the Google Sheet sync layer)
  lib/lucide.min.js          Lucide icon library (bundled locally)
  lib/react.production.min.js
  lib/react-dom.production.min.js   React 18.3.1, bundled locally
  lib/font-latin.woff2
  lib/font-latin-ext.woff2   DM Sans web font, bundled locally
  icons/                     Toolbar/extension icons (16, 48, 128 px)
