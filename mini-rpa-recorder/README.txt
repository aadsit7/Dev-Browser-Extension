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
      Press "Record". The extension switches on recording in every
      http/https tab you already have open - you do not need to reload them.
      A small red "REC" badge appears in the top right corner of each tab it is
      watching. Any tab it could not use (chrome:// pages, the Chrome Web Store,
      and anything that is not http or https) is listed in the panel with the
      reason, so you always know what is and is not being recorded.

  Do your actions
      Click things, type into fields, press Enter/Tab/Escape, scroll. Switch
      tabs as much as you like and open new ones - each switch is recorded as
      its own step. Steps appear in the panel as you go, as a flow of cards
      running down the page, one card per thing you did:

          1  [type]    Type "hello world"       into input 'query'
          2  [key]     Press Enter              in input 'query'
             on Invites
          3  [click]   Click 'Accept'           button

      Each card carries an icon for the kind of action, the action in plain
      English, and what it acted on underneath. The page a step happened on is
      marked on the line between cards only where it changes, so a long
      recording still reads as one flow. Click any card to see everything
      about it.

      Press "Take a picture" at any point during recording to capture the
      visible part of the current tab. It appears as a card with a thumbnail.
      Pictures are reference images only - they are skipped during playback.

  Change a step
      Click a card and a drawer slides up with everything about that step:
      the page, the element, how it was found, and what to do with it -
      re-record it, delete it, move it, group it, or make it repeat. Click the
      card again, press the x, or press Escape to close the drawer. Nothing
      about a step is edited on the card itself; the flow stays a flow.

  Fix one step without redoing the lot
      Click the card and press "Re-record this step". Go to the page, do that
      one action, and it replaces the step - recording stops by itself
      straight afterwards, so nothing else gets picked up. The step keeps its
      place, so a block it belongs to is left exactly as it was. "Cancel"
      backs out and leaves the step alone.

      If the step you re-recorded was repeating, the repeat stays on but its
      match pattern is worked out again from the new element, because the old
      pattern described the old one. The panel says so, and the match count on
      the block updates - worth a look before you play.

  Arrange the flow
      Cards can be dragged: up and down to reorder them, onto another card to
      put the two in a block that runs as one thing, into a block to add a
      step to it, or out of a block to take one away. A block is dragged by
      its header and moves as a whole. Every move can be undone with the
      "Undo" that appears. If you would rather not drag, the drawer has "Move
      up", "Move down", "Group with the step above" and "Group with the step
      below", and, inside a block, "Take out of the block".

  Tidy up
      Click a card and press "Delete this step"; an "Undo" appears in case
      that was not what you meant - it puts the step back where it was, along
      with any block that shrank around it. "Clear all", at the top of the
      flow, wipes the whole recording (it asks for a second click first).

  Stop
      Press "Stop recording". The recording is saved and survives closing the
      side panel, closing the tab, and restarting Chrome.

  Play
      Press "Play". The extension brings the right tab to the front before each
      step, finds the element, scrolls it into view, briefly outlines it in
      orange, then acts on it. The status line at the top shows which step is
      running, and the card that is running is lit up. "Stop" halts it -
      including part way through a repeat, not just between steps.

  Keep it
      Give the recording a name in "Saved recordings", under the flow, and
      press Save. It stays on that list however many other jobs you record
      after it, and Load brings it back. Section 3 has the details.


-------------------------------------------------------------------------------
3. SAVED RECORDINGS
-------------------------------------------------------------------------------

The flow holds one recording at a time. "Saved recordings", just under it,
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
      Puts a copy of that recording in the flow, ready to play. Whatever
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
steps are put in a REPEAT BLOCK for you - drawn on the canvas as a container
round its cards, with a header that says "Repeat for each match" and a live
count of how many elements match - and the panel says so:

    Set to repeat: those 2 steps are in a block that will run on every match
    found, scrolling down for more as it goes. Click the block to change that
    or turn it off.

So the whole job is: record Connect, confirm in the pop-out, stop, press Play.

The click that leads the loop is the first one that turns out to have company on
the page, not simply the first one you recorded. If you search, filter and then
work the results, the search and the filter stay outside the block and run
once, and the row click is what repeats - which is what you meant.

What counts as "other elements" is deliberately strict. One match on its own
proves nothing - it is as likely to be the button you just pressed, still
sitting there, as another row. What settles it is a match that is demonstrably a
DIFFERENT element, told apart by its aria-label, id, data-testid or name and
never by its wording (the wording is the thing your click changes). Where a page
gives its buttons nothing to tell them apart by, two or more matches is the best
evidence available and that is what gets used. A one-off control - a Search
button, a Save - is left exactly as recorded.

Nothing is run for you. Setting it up and running it stay separate, and the
Repeat switch in the block's drawer turns it back off.

BLOCKS BY HAND

You can also build a block yourself, which is what you want when the recording
covers more than one process, or when the click you started with is not the one
that should repeat.

To make one, drag a card and drop it onto the card it belongs with; the two
become a block, drawn as a container round its cards with a header saying what
it does and how many steps it covers. Drag more cards into the block to grow
it, or out of it to shrink it. The header's triangle folds the block away, so a
long recording stays readable, and the header can be dragged to move the whole
block.

Everything a block can be told is in its drawer - click the header. "Add the
step below" and "Take the last step out" adjust it in place, "Split into
single steps" puts the steps back as they were, and "Delete these N steps"
removes the lot (with an Undo).

THE REPEAT SWITCH

Every block's drawer has a switch, "Repeat for each match", and so does the
drawer of any single click step that is not in a block. Switch it on and the
step or block stops being "do this once" and becomes "do this once for every
matching element on the page". A block can only repeat if it starts with a
click - the thing that is on every row - and the drawer says so otherwise.

With it on, the drawer shows the everyday controls and nothing else:

    Repeat up to [25] times          [Show me on the page]
    At the end of the page:  it stops.   [Go to the next page instead]
    If a step is missing:    [stop and tell me]

That is the whole common case. The match pattern and the wait between turns
sit behind "Advanced settings", closed by default. On the canvas, a repeating
block shows a live count of how many elements match on the page in the active
tab.

Steps inside a block run only inside it - they are not replayed again
afterwards - and a block cannot contain another repeating step: drag a
repeating card into a block and its repeat is switched off, which the panel
says as it does it.

WHEN THIS PAGE RUNS OUT

The drawer of a repeating block carries one more line, under the repeat count:

    When this page runs out    stop    [+ Go to the next page]

Left alone, the loop stops when the page has nothing left - which is what it
has always done. Press "+ Go to the next page" and the panel waits while you go
to the page and click the control that brings up the next one: Next, a chevron,
"Load more", whatever the site calls it. The next thing you click is saved as
that control.

Nothing else changes. It is not added as a step, the steps you recorded are
untouched, and a loop that was already set up keeps its pattern, its count and
its timing. The line then reads:

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

WHEN A DIFFERENT POP-UP COMES UP

A pass is recorded against one way the page behaves: click Connect, and the
"send without a note?" box appears. Some rows behave differently. Every so
often the same click brings up a box that insists on a note, or a notice that a
limit has been reached, and the button the next step wants is not there. Left
to itself the loop stops, because a pass that did not finish usually means the
action did not happen either. On a long list that is the wrong answer: what you
want is to close whatever came up, give up on that one row, and carry on.

The "If a step is missing" line in the block's drawer is where that is decided:

    If a step is missing    [close the pop-up and move on to the next one]

With that chosen, a step that cannot be found within five seconds is taken as a
sign that something else is in the way. The loop closes it, gives up the rest of
the pass for that row, and moves on to the next match. Closing is done in a
fixed order, and each attempt is checked before the next is tried:

  1. a close button you recorded for it, if you have (see below);
  2. Escape;
  3. a control of the pop-up's own that only closes it: an x marked Close or
     Dismiss, then Cancel, Not now, No thanks, Skip, Maybe later, and only
     after those Got it or OK;
  4. a native dialog's own close.

Buttons that would do something - Send, Connect, Submit, Delete - are never
pressed. A pop-up that offers nothing but those is left alone, and the loop
stops and names it rather than guess. A confirm that comes up in the wake of a
close ("discard?") is closed the same way. If, after all that, something is
still in the way, the loop stops and says which pop-up it could not close.

A pop-up that was already open when the pass started - a chat window, a cookie
notice, a help panel - is part of the page. It is never closed, it is never
mistaken for the box the next step is looking for, and it cannot make a pop-up
that is still up look closed. Only what the click itself brought up is the
pass's own.

If the pop-up has a close button the list above does not find - an icon with no
label, an unusual wording - press "Record the button to press", bring the pop-up
up on the page, and click that button. The next click is saved as the control,
exactly as a next-page control is, and it is what gets tried first from then
on. "Remove" goes back to Escape and the pop-up's own buttons.

Each row given up on is counted, and the run summary says how many rows were
passed over and which pop-ups came up:

    3 row(s) were passed over because a different pop-up came up and was
    closed: "Add a note to your invitation" x2 (pressed Escape), "You've
    reached the weekly invitation limit" (clicked 'Got it').

Passing over a row counts as progress, not as a click that did nothing, so the
stall guard does not trip on a run of them. Two things do stop the loop:

  - the same pop-up on five rows in a row. A box that comes up for every row
    is about the account or the page, not any one row - a limit that has been
    reached, say - and closing it seventy more times would achieve nothing;
  - a row given up on in a list whose rows cannot be told apart. Where the
    matches have no aria-label, id or name, the loop takes the first match
    each round; after a close that would be the very same row, and the same
    pop-up, for ever. The loop says so and stops instead.

Where the rows can be told apart - the usual case on a list of people - the
passed-over row is simply left behind and the next one is taken.

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

This is also why the "Found N matches" read-out is worth a look: after pinning
it counts the rows that still need doing, not every row on the page.

Randomised or hashed class names are ignored on purpose - many sites regenerate
them on every deploy, so a pattern built on them would stop working without
warning. Ids a framework hands out at render time (ember782, mat-input-4) are
treated the same way: they are the same on the next visit only by luck, so a
step never leans on one. A step recorded before this was known has its wording
tried first and its id only as a fallback - and even then only when what the id
lands on looks like what was recorded, so a stale id can never click a
different button.

WHEN THE COUNT IS ZERO, THE PANEL SAYS WHY

A bare "0 matches" explains nothing, so a repeat block whose count is zero gets
a line under its header on the canvas (and the drawer's read-out says the same)
naming which of these it is:

  - Nothing on the page fits the pattern at all: you are on the wrong page, or
    the site has changed and the first step of the block wants re-recording.
  - Elements fit the pattern but none show the wording it is pinned to - they
    say "Pending" instead of "Connect", say. Every row here is already done, so
    it is time for the next page.
  - Matches are there but none can be clicked: they are behind a pop-up (which
    is named), hidden, or disabled. Close the pop-up and the count comes back.
  - Nothing matches as written, but the same identity on another kind of
    element does - see the next section.

SELF-HEALING PATTERNS - WHEN THE SITE CHANGES THE KIND OF ELEMENT

Sites serve the same button as <a> one week and <button> the next. A pattern
records the tag it saw, and taken literally it would find nothing after such a
change while the rows are plainly still there. So when a pattern finds nothing
as written, the loop tries it one notch looser - the same attributes and the
same pinned wording, on any kind of control:

    a[aria-label^="Invite"]:text("Connect")               finds nothing, so
    :is(button, a, [role="button"], ...)[aria-label^="Invite"]:text("Connect")

is used instead. Only the tag is ever loosened; an attribute or a pinned wording
is never dropped, so the wider pattern cannot pick up a row the original would
have refused. The count chip says "(widened)", the read-out says so, and the run
summary notes it once - because the right fix is to re-record the first step of
the block and have an exact pattern again.

WORKED EXAMPLE

  1. On a page with a list of repeating buttons (invitations, notifications,
     "Dismiss" rows - whatever), press Record.
  2. Click ONE of those buttons. Press "Stop recording".
  3. Click that step's card and switch "Repeat for each match" on (or first
     drag the steps that follow it onto it to make a block, then click the
     block's header and switch it on there).
  4. Look at the read-out in the drawer, and the count on the block:

         Found 5 matches on this page (Invites).

     This counts the pattern against the page in the active tab right now, and
     it re-counts whenever you edit the pattern or switch to a different page.
     Check the number looks right BEFORE you play anything, and check it against
     the rows that still need doing rather than every row you can see. If it
     says 0, the line under the block says why (see WHEN THE COUNT IS ZERO
     above) - the pattern may be too narrow, or you may simply be on the wrong
     page. If it is higher than the number of rows
     still to do, it is too broad and is probably picking up rows you have
     already actioned - widen or narrow it by hand in the "Which things to
     repeat on" box under Advanced settings.
  5. Set "Repeat up to N times" (default 25), then press "Show me on the page"
     and look at what gets outlined - those are exactly the elements the loop
     will act on. If the outlines are on the right rows, the pattern is right.
     Timing lives under "Advanced settings". Leave "If a step is missing" on
     "stop and tell me" unless the click sometimes brings up a different
     pop-up - see WHEN A DIFFERENT POP-UP COMES UP above.
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

  Close the pop-up and move on to the next one
      The pass waits five seconds, closes whatever is in the way, gives up the
      rest of the pass for that row, and takes the next match. The row is
      counted and the pop-up named in the summary. This is the one to choose
      when the click sometimes brings up something other than the box you
      recorded against - see WHEN A DIFFERENT POP-UP COMES UP above.

  Skip it and carry on
      The pass waits five seconds, skips that step, and moves on to the rest of
      the pass, reporting how many steps it skipped at the end. Choose this
      only when a step really is optional on some rows.

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
  - with "If a step is missing" set to close the pop-up: the same pop-up has
    come up on five rows in a row, a pop-up could not be closed, or a row was
    given up on in a list whose rows cannot be told apart;
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
  sidepanel.js     Panel logic: the flow canvas of cards and blocks, the
                   drawer, drag and drop, live counts, saved recordings and
                   their files
  background.js    Service worker: injection, tab matching, playback sequencing,
                   the saved-recordings store and import checking
  content.js       Injected into pages: records actions, replays them, runs the
                   repeat loop
  icons/           16, 48 and 128 pixel toolbar icons

Permissions requested: storage, scripting, sidePanel, and host access to all
URLs (needed to read tab addresses and titles and to run on the pages you
record). The "tabs" permission is deliberately not requested - host access
already covers it.
