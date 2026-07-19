// AI Projects Assistant — service worker (Manifest V3)
//
// The toolbar icon has no popup. Clicking it opens the side panel instead.
// We set that behavior on install and again on every service-worker startup
// so it keeps working after the worker is reloaded/recycled.

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
