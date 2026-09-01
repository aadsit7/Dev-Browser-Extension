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

      The list stays deliberately tight: one line per step, and the page name
      appears only where it changes rather than on every row, so a long
      recording is still something you can read down. The full wording of any
      step is on the row itself if it had to be trimmed.

      Press "Screenshot" at any point during recording to capture the visible
      part of the current tab. It appears in the list as a thumbnail. Screenshots
      are reference images only - they are skipped during playback.

  Fix one step without redoing the lot
      The ↻ on any step re-records just that step. Press it, go to the page, do
      that one action, and it replaces the step - recording stops by itself
      straight afterwards, so nothing else gets picked up. The step keeps its
      place, so an action set it belongs to is left exactly as it was. "Cancel"
      backs out and leaves the step alone.

      If the step you re-recorded had a loop on it, the loop stays on but its
      match pattern is worked out again from the new element, because the old
      pattern described the old one. The panel says so, and the "currently
      matches N" read-out updates - worth a look before you play.

  Tidy up
      The small x on any step deletes just that step, and an "Undo" appears in
      case that was not what you meant - it puts the step back where it was,
      along with any action set that shrank around it. "Clear" wipes the whole
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

ACTION SETS

On a lot of pages the real unit of work is more than one click: press the button
on a row, confirm in the dialog that pops up, then scroll. Those steps are
already in your recording, so you bundle them into an ACTION SET and the set
becomes the thing that repeats.

To make one, tick two or more steps that sit next to each other and press
"Group into an action set". They collapse into a single card showing what the
set does and how many steps it covers. The card opens and closes with the
triangle on its left, so a long recording stays readable.

A set can be adjusted in place - "+ Add step N to this set" and "- Drop step N"
on the card - so you do not have to ungroup and start over if you bundled one
step too few. "Ungroup" puts the steps back as they were.

THE LOOP BUTTON

Every set has a Loop button, and so does any single click step that is not in a
set. Press it and the step or set stops being "do this once" and becomes "do
this once for every matching element on the page".

Turning Loop on shows two things and nothing else:

    Repeat up to [25] times          [Show me on the page]

That is the whole common case. Everything else - the match pattern, the wait
between turns, what to do if a step is missing - sits behind "Match pattern and
timing", closed by default.

Steps inside a set run only inside it - they are not replayed again afterwards
- and a set cannot contain another looping step.

SHOW ME ON THE PAGE

Press it and every element the loop would act on is outlined on the page in
blue for a couple of seconds, and the panel reports how many there were and
names a few. Nothing is clicked. This is the fastest way to be sure a pattern
is picking up the rows you meant and not, say, the ones you have already done.

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

     (:text("...") is understood by this extension; it is not standard CSS.
     There is also :text^("leading words") for wording that starts the same
     way but ends differently on every row.)

PINNING THE WORDING - WHY THE PATTERN OFTEN GAINS A :text() PART

A list you are part-way through holds rows in more than one state: some still to
do, some already actioned. Plenty of pages leave the underlying attribute
untouched between the two and change only the wording on the button - the label
still says "Invite Person 4 to connect" long after the button itself has become
"Pending". An attribute pattern alone cannot tell those apart, and clicking one
that has already been actioned usually does something quite different: undo it,
withdraw it, open a menu you did not want.

So when Repeat is switched on, the pattern is checked against the page in front
of you and pinned to the wording that marks an actionable row:

    button[aria-label^="Invite"]              becomes
    button[aria-label^="Invite"]:text("Connect")

The panel says when it has done this and how many elements it excluded. Two or
more elements have to be showing that wording before it will pin - one alone
means the wording belongs to that row rather than to a state, and pinning it
would leave the loop with a single element and nothing to move on to. Where the
wording carries the row's own name ("Connect with Dana Ellis"), the leading
words are pinned instead, with :text^("Connect").

This is also why the "currently matches N elements" read-out is worth a look:
after pinning it counts the rows that still need doing, not every row on the
page.

Randomised or hashed class names are ignored on purpose - many sites regenerate
them on every deploy, so a pattern built on them would stop working without
warning.

WORKED EXAMPLE

  1. On a page with a list of repeating buttons (invitations, notifications,
     "Dismiss" rows - whatever), press Start Recording.
  2. Click ONE of those buttons. Press Stop Recording.
  3. In the step list, press "Loop" on that step (or tick it together with the
     steps that follow it and group them into an action set first, then press
     Loop on the set).
  4. Look at the read-out:

         Currently matches 5 elements on the active tab (Invites).

     This counts the pattern against the page in the active tab right now, and
     it re-counts whenever you edit the pattern or switch to a different page.
     Check the number looks right BEFORE you play anything, and check it against
     the rows that still need doing rather than every row you can see. If it
     says 0, the pattern is too narrow. If it is higher than the number of rows
     still to do, it is too broad and is probably picking up rows you have
     already actioned - widen or narrow it by hand in the "Match pattern" box.
  5. Set "Repeat up to N times" (default 25), then press "Show me on the page"
     and look at what gets outlined - those are exactly the elements the loop
     will act on. If the outlines are on the right rows, the pattern is right.
     Timing and the missing-step setting live under "Match pattern and timing";
     leave "If a step is missing" on "Stop and tell me" unless one of the steps
     is genuinely optional.
  6. Press Play. The status line shows a live counter:

         Repeat 12 of up to 25

HOW THE LOOP ACTUALLY RUNS

Each pass re-queries the live page from scratch. It never holds on to an element
it found last time, because after a click the list has usually re-rendered and
any saved reference is stale. It picks the next matching element, scrolls it
into view, outlines it, clicks it, runs the rest of the steps in the pass, waits
your delay, and goes round again.

Picking "the next" element depends on whether the matches can be told apart. If
every match has its own aria-label, id, data-testid or name, the loop remembers
which ones it has already handled and moves on to the next. That matters because
plenty of pages leave the button exactly where it was and only change its
wording - "Connect" becomes "Pending" - so a loop that just took the first match
every time would sit on row one forever. Where the matches are indistinguishable
(five identical "Dismiss" buttons, say), it takes the first match each round and
relies on the pool shrinking instead.

While a dialog is open it owns the interaction: steps are matched inside it
first, and anything the page has marked hidden or inert behind it is not treated
as clickable. That stops a pass clicking a background button that happens to
share its wording with the one in the dialog.

Whatever the dialog contains is always reachable, wherever the page happens to
put it in the tree. That matters because sites build these very differently: as
a panel beside the page, as a native <dialog>, dropped in at a different depth
every time it opens, or - the awkward one - rendered inside the very container
the page then marks aria-hidden. Only the dialog's surroundings are treated as
out of reach, never the dialog itself.

Where a button in a dialog has nothing stable to identify it - no id, no test
attribute, no label - what gets recorded is a path counted through the tree, and
that is the weakest thing this tool stores. Dialog markup is usually rebuilt
each time it opens, so at playback the wording is tried first and the counted
path is only the fallback. A dialog that grows an extra button between recording
and playback will still have the right one clicked.

A pass finishes before the next one starts. That matters most when a dialog is
involved: the loop waits for it to close again before looking for the next
element, because starting the next pass while the page is still covered means
the click lands on nothing and, by the time the dialog does appear, it belongs
to the wrong row. If a dialog is still up eight seconds after a pass ends, the
loop stops and says so rather than clicking blind.

"If a step in the pass is missing" decides what happens when a step cannot be
found - a dialog that never opened, a button that moved:

  Stop and tell me (the default)
      The pass waits ten seconds for the step, then stops the whole loop and
      names the step, what it was looking for, and how long it waited. This is
      usually what you want: a pass that did not finish means the action did not
      happen either - the invitation was never sent, the dialog is still open -
      and carrying on from there quietly does the wrong thing to every row after
      it.

  Skip it and carry on
      The pass waits five seconds, skips that step, and moves on, reporting how
      many steps it skipped at the end. Choose this only when a step really is
      optional on some rows.

The loop stops when any of these happens:

  - no elements match any more;
  - the max-repeats limit is reached;
  - you press Stop Playback;
  - STALL GUARD: the clicks are having no effect. Where matches are
    indistinguishable that shows up as the number of matching elements failing
    to go down for three rounds; where they can be told apart it shows up as the
    element clicked last round being completely unchanged three rounds running.
    Either way it reports "Clicks are not having an effect - stopped after N
    rounds." This is what stops it spinning forever on a page that quietly
    ignores simulated clicks.
  - a step in the pass cannot be found and "If a step is missing" is set to stop;
  - a dialog is still open eight seconds after a pass finished;
  - the follow-on steps in a pass stop being found altogether, which means the
    page is no longer behaving the way it did when you recorded.

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

  - Only the main page is recorded and replayed. Anything inside an embedded
    frame - some sites put sign-in boxes, payment forms and the occasional
    dialog in one - cannot be seen or clicked. When a step cannot be found and
    the page has frames on it, the message says so, so you are not left
    guessing why a control that is plainly on screen could not be reached.

  - Passwords are never saved. Typing in a password box is recorded as a step so
    the field still gets focused at playback, but the value itself is deliberately
    not stored - a recording is plain JSON sitting in browser storage, and that is
    no place for one. At playback the box is focused and left alone, and the run
    summary tells you which step needs you to type it. A recorded login will
    therefore always need you at the keyboard for that one field.

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
