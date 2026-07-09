// Virtual Sales Assistant — service worker (Manifest V3)
//
// The toolbar icon has no popup. Clicking it opens the side panel instead, so
// the assistant can keep listening while the user clicks around during a call
// (a popup would close the moment it lost focus). We set that behavior on
// install and again on every service-worker startup so it survives the worker
// being reloaded/recycled.

function enableOpenOnClick() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => {
  enableOpenOnClick();
});

// Runs whenever the service worker spins back up.
enableOpenOnClick();
