/**
 * claude-dev configuration shell — nav + panel host.
 *
 * SEAM 1: the nav and the mounted page both come from `PANELS`
 * (./panels/index.js). Nothing here knows any panel by name, so a follow-up
 * unit adds a page by adding a module + one array entry.
 */

import { PANELS } from './panels/index.js';

const nav = document.getElementById('shell-nav');
const root = document.getElementById('panel-root');
const identityLine = document.getElementById('shell-identity');

let activeId = null;
let disposeActive = null;

/** Show who Authelia says we are. The server refuses anonymous requests
 *  outright, so reaching this point already means a signed-in operator. */
async function showIdentity() {
  try {
    const res = await fetch('/api/session', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const session = await res.json();
    const who = session.name || session.user;
    identityLine.textContent =
      `Signed in as ${who}${session.groups?.length ? ` (${session.groups.join(', ')})` : ''}.`;
    return session;
  } catch (err) {
    identityLine.textContent = `Could not read your session: ${err.message}`;
    return null;
  }
}

function renderEmptyState() {
  root.replaceChildren();
  const box = document.createElement('div');
  box.className = 'shell-empty';
  const h = document.createElement('h2');
  h.textContent = 'Nothing to configure here yet';
  const p = document.createElement('p');
  p.textContent =
    'This is the configuration shell for the claude-dev container. '
    + 'Its pages — projects, GitHub sign-in, repair actions — arrive in the '
    + 'follow-up updates and appear in the sidebar as they land.';
  box.append(h, p);
  root.append(box);
}

function activate(panel, session) {
  if (disposeActive) { try { disposeActive(); } catch { /* a panel's cleanup must not wedge the shell */ } }
  disposeActive = null;
  activeId = panel.id;
  root.replaceChildren();
  disposeActive = panel.mount(root, { session }) || null;
  for (const button of nav.querySelectorAll('button')) {
    if (button.dataset.panelId === panel.id) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  if (location.hash.slice(1) !== panel.id) history.replaceState(null, '', `#${panel.id}`);
}

function renderNav(session) {
  nav.replaceChildren();
  if (PANELS.length === 0) {
    const note = document.createElement('p');
    note.className = 'shell-nav-empty';
    note.textContent = 'No sections yet';
    nav.append(note);
    renderEmptyState();
    return;
  }
  for (const panel of PANELS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.panelId = panel.id;
    button.textContent = panel.title;
    button.addEventListener('click', () => activate(panel, session));
    nav.append(button);
  }
  const wanted = PANELS.find(p => p.id === location.hash.slice(1)) || PANELS[0];
  activate(wanted, session);
}

async function boot() {
  const session = await showIdentity();
  renderNav(session);
}

boot();

// Exported for a panel that wants to drive navigation itself.
export { activeId, PANELS };
