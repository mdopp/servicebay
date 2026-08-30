/**
 * GitHub panel (#2681, epic #2674).
 *
 * Connects this container to GitHub with the OAuth device flow — a one-time
 * code the operator types into github.com on any device — and says, out loud,
 * whether the credential that is there right now actually works.
 *
 * The whole panel turns on ONE distinction, so it is stated before the code:
 *
 *   "not connected" and "I could not tell whether it is connected" are
 *   DIFFERENT ANSWERS.
 *
 * `connected` is three-valued (`true` / `false` / `null`) all the way from
 * `gh api user` in ../../server.mjs to the `data-github` attribute below.
 * Rendering the third as the second gets someone to redo a connection that
 * already works, or — worse — to trust one that does not. So:
 *
 *   • `data-github="connected"`    → GitHub answered, and named the account.
 *   • `data-github="disconnected"` → the check RAN and came back negative:
 *                                    either nothing is stored, or what is
 *                                    stored was rejected. The reason is shown.
 *   • `data-github="unknown"`      → the check did not complete (no `gh`, a
 *                                    timeout, no route to github.com). Connect
 *                                    stays available, but nothing here claims
 *                                    to know the state.
 *
 * The token itself never reaches this file. The browser sees the user code, the
 * verification URL, and afterwards an account name — never the credential.
 */

const STATE_LABELS = {
  connected: 'Connected',
  disconnected: 'Not connected',
  unknown: 'Unknown',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The three-way collapse, in one place so no branch can invent a fourth. */
function stateOf(status) {
  if (!status || status.connected === null || status.connected === undefined) return 'unknown';
  return status.connected ? 'connected' : 'disconnected';
}

/**
 * What the stored file looks like on disk. Shown because #2672 is recent
 * history: this credential was world-readable and world-writable on a container
 * with real user logins on it, and "we wrote it correctly" is a claim that
 * should be visible rather than assumed.
 */
function credentialLine(credential) {
  if (!credential) return null;
  const line = el('p', 'github-credential');
  line.dataset.credential = credential.exists === true ? (credential.private ? 'private' : 'open')
    : credential.exists === false ? 'absent' : 'unknown';
  if (credential.exists === false) {
    line.textContent = `No credential file at ${credential.path}.`;
    return line;
  }
  if (credential.exists === null) {
    line.textContent = `${credential.path} could not be inspected, so its owner and mode are unknown`
      + `${credential.error ? `: ${credential.error}` : '.'}`;
    return line;
  }
  const owner = credential.ownedByServer === true ? 'owned by this container’s dev user'
    : credential.ownedByServer === false ? 'owned by ANOTHER account'
      : 'owner unknown';
  line.textContent = `Stored at ${credential.path}, mode ${credential.mode}, ${owner}`
    + (credential.private === false ? ' — other logins on this container can read it.' : '.');
  return line;
}

function renderStatus(status) {
  const state = stateOf(status);
  const box = el('div', `github-status github-status-${state}`);
  box.dataset.github = state;

  const headline = el('p', 'github-status-headline');
  headline.append(el('span', 'github-status-label', STATE_LABELS[state]));
  if (state === 'connected') {
    headline.append(el('span', 'github-account', ` as ${status.account}`));
  }
  box.append(headline);

  if (state === 'unknown') {
    box.append(el('p', 'github-status-detail',
      'The connection could not be checked, so this is NOT a report that GitHub is disconnected'
      + `${status?.detail ? `: ${status.detail}` : '.'}`));
  } else if (status?.detail) {
    box.append(el('p', 'github-status-detail', status.detail));
  }

  const credential = credentialLine(status?.credential);
  if (credential) box.append(credential);
  return box;
}

/** The code the operator types into github.com, plus where to type it. */
function renderFlow(flow) {
  const box = el('div', 'github-flow');
  box.dataset.flow = 'started';
  box.setAttribute('role', 'status');
  box.append(el('h3', null, 'Finish the sign-in on github.com'));

  const step = el('p', 'github-flow-step');
  step.append(document.createTextNode('Open '));
  const link = el('a', 'github-flow-link', flow.verificationUri);
  link.href = flow.verificationUri;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  step.append(link, document.createTextNode(' and enter this one-time code:'));
  box.append(step);

  const code = el('p', 'github-flow-code', flow.userCode);
  code.dataset.userCode = flow.userCode;
  box.append(code);

  box.append(el('p', 'github-flow-note',
    `The code is valid for about ${Math.max(1, Math.round((flow.expiresAt - Date.now()) / 60000))} minutes. `
    + `This page keeps checking until you finish; it asks GitHub for the scopes ${flow.scopes}. `
    + 'Nothing is stored until you approve it there.'));

  const progress = el('p', 'github-flow-progress', 'Waiting for you to approve it on github.com…');
  progress.dataset.flowProgress = 'pending';
  box.append(progress);
  return { box, progress };
}

function renderError(message, detail) {
  const box = el('div', 'github-error');
  box.setAttribute('role', 'alert');
  box.append(el('p', null, message));
  if (detail) box.append(el('p', 'github-error-detail', detail));
  return box;
}

/**
 * What a finished connect actually achieved. Every warning the server returned
 * is shown as prominently as the headline — "connected, but the file is still
 * world-readable" must not be readable as a clean success.
 */
function renderResult(headline, warnings) {
  const box = el('div', warnings.length ? 'github-result github-result-partial' : 'github-result');
  box.setAttribute('role', 'status');
  box.append(el('p', 'github-result-headline', headline));
  if (warnings.length) {
    const list = el('ul', 'github-result-warnings');
    for (const warning of warnings) list.append(el('li', 'github-warning', warning));
    box.append(list);
  }
  return box;
}

async function callApi(pathname, init) {
  const res = await fetch(pathname, { ...init, headers: { Accept: 'application/json', ...(init?.headers ?? {}) } });
  const parsed = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(parsed?.error || `HTTP ${res.status}`);
    err.detail = parsed?.detail || '';
    throw err;
  }
  return parsed ?? {};
}

/** The panel's static furniture, kept out of `mount` for the same reason the
 *  projects panel does it: the body stays a wiring function. */
function renderFrame() {
  const section = el('section', 'panel panel-github');
  section.append(el('h2', null, 'GitHub'));
  section.append(el('p', 'panel-lede',
    'The GitHub account this container pushes and clones with. Connecting runs the '
    + 'device flow — a code you enter on github.com — so no shell and no pasted token '
    + 'is involved, and the stored credential is readable only by this container.'));

  const connect = el('button', 'github-connect', 'Connect GitHub');
  connect.type = 'button';
  const refresh = el('button', 'github-refresh', 'Refresh');
  refresh.type = 'button';
  const buttons = el('div', 'github-actions');
  buttons.append(connect, refresh);
  section.append(buttons);

  const statusOut = el('div', 'github-status-output');
  statusOut.setAttribute('aria-live', 'polite');
  const flowOut = el('div', 'github-flow-output');
  flowOut.setAttribute('aria-live', 'polite');
  section.append(statusOut, flowOut);

  return { section, connect, refresh, statusOut, flowOut };
}

/**
 * The three actions, each a plain function over the panel's `ui` context
 * (`{ connect, refresh, statusOut, flowOut, isDisposed, schedule }`) rather
 * than a closure, so `mount` stays a wiring function.
 *
 * `isDisposed` is checked after every await: a late answer must never repaint a
 * panel the shell already swapped out, and a poll must never outlive the page
 * that started it.
 */
async function loadStatus(ui) {
  ui.statusOut.replaceChildren(el('p', 'github-loading', 'Checking the GitHub connection…'));
  ui.refresh.disabled = true;
  try {
    const status = await callApi('/api/github');
    if (ui.isDisposed()) return;
    ui.statusOut.replaceChildren(renderStatus(status));
  } catch (err) {
    if (ui.isDisposed()) return;
    // The status ROUTE failing is itself an unknown, not a "no" — render it
    // through the same three-state path rather than as a bare error.
    ui.statusOut.replaceChildren(renderStatus({ connected: null, detail: err.message }));
  } finally {
    if (!ui.isDisposed()) ui.refresh.disabled = false;
  }
}

/** Every way the flow can end, each said in its own words. */
function finishFlow(ui, result) {
  ui.connect.disabled = false;
  if (result.state === 'connected') {
    ui.flowOut.replaceChildren(renderResult(
      `Connected to GitHub as ${result.status.account || 'an account GitHub did not name'}.`,
      result.warnings ?? [],
    ));
  } else {
    ui.flowOut.replaceChildren(renderError(
      result.state === 'expired' ? 'That one-time code expired — start the sign-in again.'
        : result.state === 'denied' ? 'The sign-in was cancelled on github.com.'
          : `The sign-in ended in an unexpected state: ${result.state}.`,
      result.detail || '',
    ));
  }
  void loadStatus(ui);
}

async function pollFlow(ui, flowId, progress) {
  if (ui.isDisposed()) return;
  let result;
  try {
    result = await callApi('/api/github/device/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flowId }),
    });
  } catch (err) {
    if (ui.isDisposed()) return;
    ui.connect.disabled = false;
    ui.flowOut.replaceChildren(renderError(`The sign-in could not be completed: ${err.message}`, err.detail));
    void loadStatus(ui);
    return;
  }
  if (ui.isDisposed()) return;
  if (result.state !== 'pending') return finishFlow(ui, result);
  progress.dataset.flowProgress = 'pending';
  ui.schedule(() => pollFlow(ui, flowId, progress), result.interval);
}

async function startConnect(ui) {
  ui.connect.disabled = true;
  ui.flowOut.replaceChildren(el('p', 'github-working', 'Asking GitHub for a one-time code…'));
  let flow;
  try {
    flow = await callApi('/api/github/device', { method: 'POST' });
  } catch (err) {
    if (ui.isDisposed()) return;
    ui.connect.disabled = false;
    ui.flowOut.replaceChildren(renderError(`Could not start the GitHub sign-in: ${err.message}`, err.detail));
    return;
  }
  if (ui.isDisposed()) return;
  const { box, progress } = renderFlow(flow);
  ui.flowOut.replaceChildren(box);
  ui.schedule(() => pollFlow(ui, flow.flowId, progress), flow.interval);
}

const panel = {
  id: 'github',
  title: 'GitHub',

  mount(root, _ctx) {
    let disposed = false;
    let timer = null;

    const frame = renderFrame();
    root.append(frame.section);

    const ui = {
      ...frame,
      isDisposed: () => disposed,
      // GitHub tells us how often it will answer; polling faster earns a
      // `slow_down` and then a refusal, so its interval is honoured, floored.
      schedule: (fn, seconds) => { timer = setTimeout(fn, Math.max(1000, (seconds || 5) * 1000)); },
    };

    frame.connect.addEventListener('click', () => { void startConnect(ui); });
    frame.refresh.addEventListener('click', () => { void loadStatus(ui); });
    void loadStatus(ui);

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  },
};

export default panel;
