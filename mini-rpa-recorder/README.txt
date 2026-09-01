MINI RPA RECORDER
=================

A small record-and-replay tool for web pages. Press Start, do a handful of
things across one or more tabs, press Stop, then press Play to have those same
things done again. One click step can be switched to "Repeat" so it runs against
every matching element on the page instead of just the one you clicked. A
recording can be saved under a name and brought back later, so you can keep
several jobs and pick the one you need, and exported to a file to back it up or
hand it on.

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

  Keep it
      Give the recording a name in "Saved recordings", under the step list, and
      press Save. It stays on that list however many other jobs you record
      after it, and Load brings it back. Section 3 has the details.


-------------------------------------------------------------------------------
3. SAVED RECORDINGS
-------------------------------------------------------------------------------

The step list holds one recording at a time. "Saved recordings", just under it,
is where you keep the ones you want to come back to, so setting up a second job
does not cost you the first. The section opens by itself once there is
something to save or something saved; the triangle on its header folds it away.

  Save
      Type a name in the box and press Save. A copy of the steps above - loops,
      groups, next-page controls and all - is kept under that name, and the
      list shows it with its step count, whether it loops, and when it was
      saved. The steps above are untouched, and the section header says which
      saved recording they belong to.

      Save with the same name again and it updates that entry (the button
      reads "Save changes"). Save under a name that belongs to a DIFFERENT
      saved recording and the button asks for a second press first, because
      that replaces it. A new name makes a new entry and leaves the old one as
      it was, which is how you keep a variation of a job alongside the
      original.

  Load
      Puts a copy of that recording in the step list, ready to play. Whatever
      was in the list is not thrown away: an Undo appears, and pressing it puts
      the previous steps back exactly as they were. Loading never changes the
      saved copy - edit the steps, loop them differently, delete one - and
      nothing reaches the saved copy until you press Save.

  Rename / Delete
      Rename edits the name in place (Enter keeps it, Escape backs out). Delete
      asks for a second press. Deleting a saved recording never touches the
      steps in the list above, even if they were loaded from it.

  Export / Import
      Export downloads a saved recording as a JSON file; "Export the steps
      above" does the same for the current list without saving it first.
      Import reads such a file into the saved recordings as a new entry - it
      never replaces the steps you have in front of you. That is how you back
      a recording up, move it to another computer, or hand it to someone else.

      A file is not trusted the way the extension's own storage is. On import
      only the fields the player understands are kept, every value is checked
      for shape and length, and a password value is dropped even if the file
      carried one - the same rule as recording.

  Room
      The current steps and every saved recording share the roughly 10 MB
      Chrome gives an extension, and the line at the foot of the section says
      how much of it is in use. Screenshots are what fills it. If a save fails
      for lack of room, delete a saved recording or some screenshot steps and
      try again.

  While recording or playing
      Save, Load, Rename, Delete and Import wait until you are back to idle;
      Export works at any time.


-------------------------------------------------------------------------------
4. REPEAT MODE
-------------------------------------------------------------------------------

IT SETS ITSELF UP

On a lot of pages the real unit of work is more than one click: press the button
on a row, confirm in the dialog that pops up, move to the next row. That is a
process meant to run down a whole list, not to happen once, so when you stop
recording the extension works that out for itself.

If the click you started with still matches other elements on the page, your
steps are grouped into an ACTION SET and switched to looping for you, and the
panel says so:

    This looks like a repeating process, so it is set up to loop: those 2
    steps run once for each match, and 8 elements match on this page right
    now. Press Play to run it down the list - it scrolls to load more as it
    goes. Press Looping to turn it off.

So the whole job is: record Connect, confirm in the pop-out, stop, press Play.

The click that leads the loop is the first one that turns out to have company on
the page, not simply the first one you recorded. If you search, filter and then
work the results, the search and the filter stay outside the set and run once,
and the row click is what repeats - which is what you meant.

What counts as "other elements" is deliberately strict. One match on its own
proves nothing - it is as likely to be the button you just pressed, still
sitting there, as another row. What settles it is a match that is demonstrably a
DIFFERENT element, told apart by its aria-label, id, data-testid or name and
never by its wording (the wording is the thing your click changes). Where a page
gives its buttons nothing to tell them apart by, two or more matches is the best
evidence available and that is what gets used. A one-off control - a Search
button, a Save - is left exactly as recorded.

Nothing is run for you. Setting it up and running it stay separate, and one
press of "Looping" turns it back off.

ACTION SETS BY HAND

You can also build a set yourself, which is what you want when the recording
covers more than one process, or when the click you started with is not the one
that should repeat.

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

WHEN THIS PAGE RUNS OUT

A looping card carries one more line, under the repeat count:

    When this page runs out    stop    [+ Go to the next page]

Left alone, the loop stops when the page has nothing left - which is what it
has always done. Press "+ Go to the next page" and the panel waits while you go
to the page and click the control that brings up the next one: Next, a chevron,
"Load more", whatever the site calls it. The next thing you click is saved as
that control.

Nothing else changes. It is not added as a step, the steps you recorded are
untouched, and a loop that was already set up keeps its pattern, its count and
its timing. The card then reads:

    When this page runs out    click 'Next'    [Change] [Remove]

From then on, when the page runs out the loop presses that control, waits for
the new rows to arrive, and carries straight on there. "Remove" puts it back to
stopping.

The safety limits still bound the whole run, not each page: "Repeat up to 25"
means twenty-five rows in total however many pages they are spread over, and
the delay between clicks applies across page turns too. On top of that it will
turn the page at most twenty times in one run, and it stops if a page turn
brings up nothing matching - a Next button that has stopped working, or the end
of the results.

One thing changes when a next-page control is set: the loop scrolls to look for
more only once before turning the page, instead of three times. A paged list is
not an endless one, and three fruitless scrolls would be six seconds of nothing
on every page. A scroll that does bring rows in still counts as progress, so an
endless list inside a paged one keeps working as before.

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

When a pass finds nothing left to click, it scrolls to the bottom of the page,
waits for whatever loads, and looks again - which is how an endless list keeps
going. A scroll that actually pulls in more rows counts as progress, not as an
attempt, so a long list can be loaded as many times as it takes. The limit of
three only applies to scrolls in a row that reveal nothing, which is what the
real end of a list looks like.

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
5. HOW TABS ARE MATCHED AT PLAYBACK
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
6. WHERE THINGS ARE SAVED
-------------------------------------------------------------------------------

The recording lives in chrome.storage.local, so it survives closing the panel
and restarting the browser. Saved recordings live there too: a small index of
names and sizes under one key, and each recording's steps under a key of its
own, so listing them never has to read every screenshot ever saved. Playback
position and the repeat counter live in chrome.storage.session, so a page
navigation or a sleeping background worker part way through a run can pick up
where it left off rather than starting over.

Screenshots are stored as data URLs and are by far the biggest thing in a
recording. Chrome caps extension storage at roughly 10 MB across everything -
the current steps and the saved recordings together - so the panel warns you
once the total passes about 8 MB. Delete a saved recording or some screenshot
steps at that point, or the next save will fail.


-------------------------------------------------------------------------------
7. LIMITATIONS - PLEASE READ
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

  - A recorded Enter replays as the key itself and, where nothing on the page
    took charge of it, what the browser would have done next: in a form with
    no submit button and a single text box, that is submitting the form. A
    form with a Search button needs no help - a real Enter in it clicks that
    button, and that click was recorded as a step of its own, so the step does
    the submitting. Tab and Escape are replayed as the keys alone; a page that
    handles them itself responds, one that relies on the browser does not.

  - Pop-outs built inside a shadow root are handled. A shadow root is a
    self-contained pocket of page that some sites build their dialogs in, and
    it takes a bit of care to see into: a click that happens inside one is
    reported against the container holding it rather than the button that was
    pressed. Both recording and playback look through them, however deeply they
    are nested, so a confirm button in a pop-out records as that button and
    replays as a click on it.

    The exception is a shadow root a site has explicitly marked private, which
    nothing outside the page itself can look inside. There is no way round that
    from an extension. It is uncommon, and when it happens the step reports that
    it could not find the button rather than clicking the wrong thing.

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
8. FILES
-------------------------------------------------------------------------------

  manifest.json    Manifest V3 definition, permissions, side panel wiring
  sidepanel.html   Control panel markup (no inline script, as MV3 requires)
  sidepanel.css    All panel styling
  sidepanel.js     Panel logic: buttons, step list, repeat editor, live counts,
                   saved recordings and their files
  background.js    Service worker: injection, tab matching, playback sequencing,
                   the saved-recordings store and import checking
  content.js       Injected into pages: records actions, replays them, runs the
                   repeat loop
  icons/           16, 48 and 128 pixel toolbar icons

Permissions requested: storage, scripting, sidePanel, and host access to all
URLs (needed to read tab addresses and titles and to run on the pages you
record). The "tabs" permission is deliberately not requested - host access
already covers it.
