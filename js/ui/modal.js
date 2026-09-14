// js/ui/modal.js — small shell services: toast feedback and the generic
// prompt modal used for confirm-password / rename / recovery flows.
// The shell is static (index.html); nodes are looked up lazily so this module
// also works for dynamically opened dialogs.

import { state } from '../domain/state.js';

// Transient toast in the top-right corner; auto-dismisses after 2.2 s.
export function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toast.classList.remove('show'), 2200);
}

// Open the shared prompt modal. Resolves with the entered value, or null when
// dismissed (Escape / outside click / Cancel); a second call resolves any
// pending one with null.
export function askInput({ eyebrow = 'Notely', title = 'Input needed', desc = '', label = 'Value', password = true, placeholder = '', okText = 'Confirm' } = {}) {
  if (state.askInputPending) {
    try { state.askInputPending(null); } catch (error) {}
    state.askInputPending = null;
  }
  return new Promise((resolve) => {
    const modal = document.getElementById('prompt-modal');
    const input = document.getElementById('prompt-input');
    const okBtn = document.getElementById('prompt-ok');
    const cancelBtn = document.getElementById('prompt-cancel');
    const cancelX = document.getElementById('prompt-cancel-x');
    if (!modal || !input || !okBtn) { resolve(null); return; }
    document.getElementById('prompt-eyebrow').textContent = eyebrow;
    document.getElementById('prompt-title').textContent = title;
    document.getElementById('prompt-desc').textContent = desc;
    document.getElementById('prompt-label').textContent = label;
    okBtn.textContent = okText;
    input.type = password ? 'password' : 'text';
    input.placeholder = placeholder;
    input.value = '';
    state.askInputPending = resolve;
    const settle = (value) => {
      okBtn.onclick = null;
      if (cancelBtn) cancelBtn.onclick = null;
      if (cancelX) cancelX.onclick = null;
      input.onkeydown = null;
      modal.onclick = null;
      modal.hidden = true;
      if (state.askInputPending === resolve) state.askInputPending = null;
      resolve(value);
    };
    okBtn.onclick = () => settle(input.value);
    if (cancelBtn) cancelBtn.onclick = () => settle(null);
    if (cancelX) cancelX.onclick = () => settle(null);
    input.onkeydown = (event) => {
      if (event.key === 'Enter') settle(input.value);
      else if (event.key === 'Escape') settle(null);
    };
    modal.onclick = (event) => { if (event.target === modal) settle(null); };
    modal.hidden = false;
    setTimeout(() => { try { input.focus(); } catch (error) {} }, 30);
  });
}
