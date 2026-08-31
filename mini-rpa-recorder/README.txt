MINI RPA RECORDER
=================

A small record-and-replay tool for web pages. Press Start, do a handful of
things across one or more tabs, press Stop, then press Play to have those same
things done again. One click step can be switched to "Repeat" so it runs against
every matching element on the page instead of just the one you clicked.

Manifest V3. No frameworks, no libraries, no network calls - it works offline.


-------------------------------------------------------------------------------
1. LOADING THE EXTENSION
-------------------------------------------------------------------------------

1. Open Chrome and go to  chrome://extensions
2. Switch on "Developer mode" (top right).
3. Click "Load unpacked".
4. Select this "mini-rpa-recorder" folder (the one holding manifest.json).
5. The extension appears in the list. Pin it to the toolbar if you like.

Click the toolbar icon to open the side panel. The panel is global, not
per-tab, so it stays open and keeps showing the same recording while you move
between tabs.


-------------------------------------------------------------------------------
2. USING IT
-------------------------------------------------------------------------------

  Open the side panel
      Click the Mini RPA Recorder icon in the toolbar.

  Start
      Press "Start Recording". The extension switches on recording in every
      http/https tab you already have open - you do not need to reload them.
      A small red "REC" badge appears in the top right corner of each tab it is
      watching. Any tab it could not use (chrome:// pages, the Chrome Web Store,
      and anything that is not http or https) is listed in the panel with the
      reason, so you always know what is and is not being recorded.

  Do your actions
      Click things, type into fields, press Enter/Tab/Escape, scroll. Switch
      tabs as much as you like and open new ones - each switch is recorded as
      its own step. Steps appear in the panel list as you go, numbered and in
      plain English, each tagged with the page it happened on:

          1. [Page One] Clicked button 'Go'
          2. [Page One] Typed "hello world" into input 'query'
          3. [Page One] Pressed Enter
          4. Switched to tab: Invites
          5. [Invites] Clicked button 'Accept'

      Press "Screenshot" at any point during recording to capture the visible
      part of the current tab. It appears in the list as a thumbnail. Screenshots
      are reference images only - they are skipped during playback.

  Tidy up
      The small x on any step deletes just that step. "Clear" wipes the whole
      recording (it asks for a second click first).

  Stop
      Press "Stop Recording". The recording is saved and survives closing the
      side panel, closing the tab, and restarting Chrome.

  Play
      Press "Play". The extension brings the right tab to the front before each
      step, finds the element, scrolls it into view, briefly outlines it in
      orange, then acts on it. The status line at the top shows which step is
      running. "Stop Playback" halts it - including part way through a repeat
      loop, not just between steps.


-------------------------------------------------------------------------------
3. REPEAT MODE
-------------------------------------------------------------------------------

Every click step in the list has a "Repeat on every matching element" toggle.
Switch it on and the step stops being "click that one button" and becomes "keep
clicking every button that matches this pattern".

The pattern is deliberately NOT the selector used for the single click. Selectors
that count positions (nth-of-type, nth-child) break the moment the first click
removes a row and everything below it shifts up, so they are not allowed in a
repeat pattern at all. Instead the extension builds a generic pattern from
whatever stable handle the element has, preferring, in order:

  a. A stable prefix of the element's aria-label. Sites often label buttons
     "Accept Jane Smith's invitation", where only the first word or two stay the
     same from row to row, so that becomes:

         button[aria-label^="Accept"]

  b. A stable, non-generated attribute such as data-testid or name:

         button[data-testid="accept-invite"]

  c. Every element of the same tag whose visible text is exactly the text you
     clicked:

         button:text("Dismiss")

     (:text("...") is understood by this extension; it is not standard CSS.)

Randomised or hashed class names are ignored on purpose - many sites regenerate
them on every deploy, so a pattern built on them would stop working without
warning.

WORKED EXAMPLE

  1. On a page with a list of repeating buttons (invitations, notifications,
     "Dismiss" rows - whatever), press Start Recording.
  2. Click ONE of those buttons. Press Stop Recording.
  3. In the step list, find that click step and switch "Repeat on every matching
     element" on. The row expands to show three fields and a read-out.
  4. Look at the read-out:

         Currently matches 5 elements on the active tab (Invites).

     This counts the pattern against the page in the active tab right now, and
     it re-counts whenever you edit the pattern or switch to a different page.
     Check the number looks right BEFORE you play anything. If it says 0, the
     pattern is too narrow. If it says 200, it is too broad - widen or narrow
     the pattern by hand in the "Match pattern" box.
  5. Set "Max repeats" (default 25) and "Delay between repeats" in seconds
     (default 2.0).
  6. Press Play. The status line shows a live counter:

         Repeat 12 of up to 25

HOW THE LOOP ACTUALLY RUNS

Each round it re-queries the live page from scratch. It never holds on to an
element it found last time, because after a click the list has usually
re-rendered and any saved reference is stale. It then takes the first match,
scrolls it into view, outlines it, clicks it, waits your delay, and goes round
again.

The loop stops when any of these happens:

  - no elements match any more;
  - the max-repeats limit is reached;
  - you press Stop Playback;
  - STALL GUARD: the number of matching elements fails to go down for three
    rounds in a row. It reports "Clicks are not having an effect - stopped
    after N rounds." This is what stops it spinning forever on a page that
    quietly ignores simulated clicks.

LAZY LOADING

If matches drop to zero, the loop does not give up immediately. It scrolls to
the bottom of the page, waits two seconds for more rows to load, and looks
again. If new matches appeared it carries on. It will try this rescue at most
three times per repeat step, then stop and tell you how many attempts it made.

THE TWO HARD LIMITS

  - The delay never goes below 0.5 seconds, however small a number you type.
  - Max repeats never goes above 100, however large a number you type.

These are not arbitrary. Many sites' terms of service restrict automated
activity, and rapid bulk actions are exactly the pattern that gets an account
rate-limited, temporarily blocked, or permanently restricted. The floor and the
ceiling keep you well short of that. They are enforced when the step runs, not
just in the boxes, so editing the saved recording by hand will not get round
them.


-------------------------------------------------------------------------------
4. HOW TABS ARE MATCHED AT PLAYBACK
-------------------------------------------------------------------------------

The recording never stores raw tab IDs - those change every time Chrome
restarts, so a saved recording that relied on them would break overnight. Each
step stores its tab as a web address plus a page title instead.

When a step is about to run, the extension looks through your open tabs and
takes the first match it can find, in this order:

  1. exact URL match
  2. same site and same path, ignoring the query string and the #fragment
  3. same site only
  4. no match at all - it opens a new tab at the recorded address, waits for it
     to load, and carries on there

Whenever a step is matched by anything looser than an exact URL, it is called
out in the summary when the run ends, for example:

    Step 4: tab matched by same site only - "Invites".

so a loose match is never something that quietly happened without you knowing.


-------------------------------------------------------------------------------
5. WHERE THINGS ARE SAVED
-------------------------------------------------------------------------------

The recording lives in chrome.storage.local, so it survives closing the panel
and restarting the browser. Playback position and the repeat counter live in
chrome.storage.session, so a page navigation or a sleeping background worker
part way through a run can pick up where it left off rather than starting over.

Screenshots are stored as data URLs and are by far the biggest thing in a
recording. Chrome caps extension storage at roughly 10 MB, so the panel warns
you once a recording passes about 8 MB - delete some screenshot steps at that
point, or the next save will fail.


-------------------------------------------------------------------------------
6. LIMITATIONS - PLEASE READ
-------------------------------------------------------------------------------

This is a browser extension, so it lives inside web pages. That sets some hard
boundaries:

  - It cannot control your real mouse or keyboard. Nothing outside a web page
    can be automated: not the Chrome menus, not the address bar, not other
    applications, not your operating system. It sends events to page elements,
    which is not the same thing as moving the pointer.

  - It does not work on chrome:// pages, the Chrome Web Store, the extensions
    page, or any other page that is not http or https. Chrome blocks extensions
    there. Tabs like these are listed as skipped when you start recording.

  - Screenshots only capture what is currently visible in the tab. They do not
    capture the whole page, and they do not scroll to stitch anything together.

  - Some secure sites reject simulated clicks. Banking, payment and checkout
    pages in particular often require a click that the browser itself marks as
    coming from a real person, and a scripted click will simply be ignored.
    Nothing here can get round that, and it is not supposed to. If clicks are
    being ignored, the stall guard will notice and stop.

  - Tabs are matched by web address at playback time, not by tab identity. If
    the page has changed since you recorded, if you have been logged out, if
    the content sits behind a different URL now, or if the buttons have moved,
    the replay may not find what it needs. When that happens it stops and tells
    you the step number, what it was looking for, and which tab it was on -
    it does not guess or carry on regardless.

  - Elements are found by selector first, then by tag plus visible text. A page
    that changes its wording between recording and playback can break a step.

  - Many sites' terms of service restrict automated activity. Rapid bulk actions
    can get an account rate-limited, temporarily blocked, or permanently
    restricted, and that risk sits with you. This is why repeat mode has a hard
    0.5 second floor on the delay and a hard ceiling of 100 repeats, and why
    neither can be turned off. Use conservative settings, watch the first run,
    and check the site's own rules before automating anything against it.


-------------------------------------------------------------------------------
7. FILES
-------------------------------------------------------------------------------

  manifest.json    Manifest V3 definition, permissions, side panel wiring
  sidepanel.html   Control panel markup (no inline script, as MV3 requires)
  sidepanel.css    All panel styling
  sidepanel.js     Panel logic: buttons, step list, repeat editor, live counts
  background.js    Service worker: injection, tab matching, playback sequencing
  content.js       Injected into pages: records actions, replays them, runs the
                   repeat loop
  icons/           16, 48 and 128 pixel toolbar icons

Permissions requested: storage, scripting, sidePanel, and host access to all
URLs (needed to read tab addresses and titles and to run on the pages you
record). The "tabs" permission is deliberately not requested - host access
already covers it.
