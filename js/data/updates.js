// js/data/updates.js — "update available" check + bottom-right popup.
//
// The served build tag lives in index.html (`<meta name="notive-build">`),
// mirrored by EXPECTED_BUILD in app.js. The *latest published* build comes
// from NOTIVE_UPDATE_INFO_URL — a CORS-enabled JSON marker you own (raw URL
// of a public gist, or any endpoint serving { "build": "dev90" }). Self-host:
// drop the same build.json next to your server and print the URL here; unset
// (default) keeps the app fully silent online or off.
import { showToast } from '../ui/modal.js';

export const NOTIVE_UPDATE_INFO_URL = '';

const POPUP_KEY = 'notive-update-dismissed';

function servedBuild() {
  const tag = document.querySelector('meta[name="notive-build"]');
  return tag ? String(tag.getAttribute('content') || '') : '';
}

// True when `a` (candidate) is strictly newer than `b` (what runs now) —
// numeric for devNNN-style tags; unknown shapes fall back to string inequality
// (only equality suppresses the nag).
function newer(a, b) {
  const ma = /^dev(\d+)$/.exec(a || '');
  const mb = /^dev(\d+)$/.exec(b || '');
  if (ma && mb) return Number(ma[1]) > Number(mb[1]);
  return Boolean(a) && Boolean(b) && a !== b;
}

export async function fetchLatestBuild() {
  if (!NOTIVE_UPDATE_INFO_URL) return null;
  try {
    const res = await fetch(NOTIVE_UPDATE_INFO_URL, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return data && typeof data.build === 'string' ? data.build : null;
  } catch (error) {
    return null; // offline or unreachable: never nag
  }
}

export function shouldShowUpdate(latest) {
  const mine = servedBuild();
  if (!latest || !newer(latest, mine)) return false;
  // A build already dismissed stays dismissed — only a NEWER published
  // build reopens the popup.
  const seen = localStorage.getItem(POPUP_KEY);
  if (!seen) return true;
  return newer(latest, seen);
}

export function dismissUpdate(latest) {
  if (latest) localStorage.setItem(POPUP_KEY, latest);
}

// Paint the popup. Returns the overlay element (tests only).
export function showUpdatePopup(latest) {
  const box = document.getElementById('update-popup');
  if (!box) return null;
  box.dataset.build = latest || '';
  box.hidden = false;
  return box;
}

export function hideUpdatePopup() {
  const box = document.getElementById('update-popup');
  if (box) box.hidden = true;
}

export async function checkForUpdates({ silent = true } = {}) {
  const latest = await fetchLatestBuild();
  if (!shouldShowUpdate(latest)) {
    if (!silent) showToast('You are up to date');
    return false;
  }
  showUpdatePopup(latest);
  return true;
}

// Boot wiring: check once now, then every 30 minutes; dismiss buttons.
export function initUpdateCheck() {
  const box = document.getElementById('update-popup');
  if (!box || box.dataset.wired === '1') return;
  box.dataset.wired = '1';
  const updateBtn = document.getElementById('update-popup-button');
  const laterBtn = document.getElementById('update-popup-later');
  if (updateBtn) updateBtn.addEventListener('click', () => {
    dismissUpdate(box.dataset.build);
    window.location.reload();
  });
  if (laterBtn) laterBtn.addEventListener('click', () => {
    dismissUpdate(box.dataset.build);
    hideUpdatePopup();
  });
  const run = () => { checkForUpdates(); };
  run();
  setInterval(run, 30 * 60 * 1000);
}
