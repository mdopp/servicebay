/**
 * Projects panel (#2679 list, #2680 add/remove, #2682 repair/restart; epic #2674).
 *
 * Shows what is checked out under /workspace, whether each checkout has a live
 * Claude session, and whether an MCP server entry is wired for it. Until this
 * panel existed none of that was visible anywhere: you had to SSH in and run
 * `tmux list-windows` and `claude mcp list` by hand.
 *
 * It now also ADDs, REMOVEs and RESTARTs, and offers the one-tap repair for a
 * lapsed Claude sign-in — the failure that makes every row above read "Not
 * running" at once, and the one nobody could fix without an SSH session.
 *
 * Three rules the mutating half must keep:
 *
 *   • Remove is offered on a row this page added (`managed === true`) and, since
 *     #2713, on one it did not (`managed === false`) — the latter behind a
 *     confirmation that names what this page does not know about it. But
 *     `managed === null` is a failed READ, so that button stays DISABLED and
 *     says Unknown rather than offering an action nobody verified is safe.
 *   • The result of an action is reported from what the server MEASURED
 *     afterwards (it re-asks tmux), and every warning it returns is shown —
 *     "added" with no session is not allowed to read as a clean success.
 *   • Restart names the OTHER sessions that stayed up. "It restarted only
 *     mine" is then something the operator can read off the screen instead of
 *     something this page asserts about itself.
 *
 * The three states this panel MUST keep apart, because they look identical if
 * you are careless (and that confusion is exactly the bug this repo keeps
 * shipping — a screen that reports success while nothing happened):
 *
 *   • a real EMPTY workspace  → the explicit `.projects-empty` block;
 *   • a FAILED read           → `.projects-error`, never an empty table;
 *   • a partially failed read → the rows still render, but the column whose
 *     source failed says "Unknown" (`data-session="unknown"`) and a
 *     `.projects-source-warning` names what could not be read.
 *
 * Everything comes from `GET /api/projects` (SEAM 3 in ../../server.mjs). The
 * browser never reads the container's disk or ServiceBay itself.
 */

const SESSION_LABELS = {
  running: 'Running',
  stopped: 'Not running',
  unknown: 'Unknown',
};

const MCP_LABELS = {
  configured: 'Configured',
  none: 'None',
  unknown: 'Unknown',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** `{ state, label, detail }` for the session column of one project row. */
function sessionCell(project) {
  if (!project.session) return { state: 'unknown', label: SESSION_LABELS.unknown, detail: '' };
  if (project.session.running) return { state: 'running', label: SESSION_LABELS.running, detail: '' };
  return {
    state: 'stopped',
    label: SESSION_LABELS.stopped,
    // A checkout without a CLAUDE.md is never auto-started, so "not running"
    // is expected there rather than a symptom.
    detail: project.developmentTarget ? '' : 'no CLAUDE.md — not auto-started',
  };
}

/** `{ state, label, detail }` for the MCP column of one project row. */
function mcpCell(project) {
  if (!project.mcp) return { state: 'unknown', label: MCP_LABELS.unknown, detail: '' };
  if (!project.mcp.configured) return { state: 'none', label: MCP_LABELS.none, detail: '' };
  return {
    state: 'configured',
    label: MCP_LABELS.configured,
    detail: `${project.mcp.servers.join(', ')} (${project.mcp.scopes.join(' + ')} scope)`,
  };
}

/**
 * The Remove button for one row — or the reason it is not usable.
 *
 * `managed` is a three-state field on purpose: `true` (this page added it),
 * `false` (someone cloned it by hand), `null` (the MCP read failed, so we do
 * not know). #2713 changed what `false` earns: a live button behind an
 * explicit confirmation, instead of no button at all. Every checkout on the
 * real box is hand-cloned, so the old rule made a shipped feature invisible to
 * the one person who asked for it.
 *
 * `null` is unchanged and stays DISABLED. A failed read is not "unmanaged" —
 * offering an action on a guess is the one thing the three-state rule exists
 * to stop.
 */
function actionCell(project, actions) {
  const td = el('td', 'projects-action');
  td.dataset.managed = project.managed === null ? 'unknown' : String(project.managed);

  // Restart is offered on EVERY row, including the hand-cloned ones and the
  // ones reading "Not running" — a dead session is precisely the one you want
  // to restart, and restarting touches only that project's own tmux window.
  const restart = el('button', 'projects-restart', 'Restart session');
  restart.type = 'button';
  restart.dataset.projectRestart = project.name;
  restart.addEventListener('click', () => actions.onRestart(project, restart));
  td.append(restart);

  const button = el('button', 'projects-remove', 'Remove');
  button.type = 'button';

  if (project.managed === null) {
    button.disabled = true;
    td.append(button);
    td.append(el('span', 'projects-state-detail',
      'Unknown — the MCP entries could not be read, so it is not known whether this page added it.'));
    return td;
  }

  button.dataset.projectRemove = project.name;
  button.addEventListener('click', () => actions.onRemove(project, button));
  td.append(button);

  if (!project.managed) {
    // The fact the old rule was built on is kept; only the dead end is gone.
    td.append(el('span', 'projects-state-detail',
      'Added outside this page — removing it here asks first, and says what it does and does not touch.'));
  }
  return td;
}

function renderTable(payload, actions) {
  const table = el('table', 'projects-table');
  const head = el('thead');
  const headRow = el('tr');
  for (const title of ['Project', 'Claude session', 'ServiceBay MCP entry', '']) {
    const th = el('th', null, title);
    th.scope = 'col';
    headRow.append(th);
  }
  head.append(headRow);

  const body = el('tbody');
  for (const project of payload.projects) {
    const row = el('tr');
    row.dataset.project = project.name;

    const name = el('th', 'projects-name');
    name.scope = 'row';
    name.append(el('span', 'projects-name-text', project.name));
    name.append(el('span', 'projects-path', project.path));
    row.append(name);

    for (const [key, cell] of [['session', sessionCell(project)], ['mcp', mcpCell(project)]]) {
      const td = el('td', `projects-state projects-state-${cell.state}`);
      td.dataset[key] = cell.state;
      td.append(el('span', 'projects-state-label', cell.label));
      if (cell.detail) td.append(el('span', 'projects-state-detail', cell.detail));
      row.append(td);
    }
    row.append(actionCell(project, actions));
    body.append(row);
  }

  table.append(head, body);
  return table;
}

/** The add form. Deliberately two fields: a URL, and an optional name for the
 *  case where the directory should not be called after the remote. */
function renderAddForm(onAdd) {
  const form = el('form', 'projects-add');
  form.noValidate = true;
  form.append(el('h3', null, 'Add a project'));
  form.append(el('p', 'projects-add-lede',
    'Clones the repository into the shared workspace, gives it its own read-only '
    + 'ServiceBay token, wires that token as its MCP server and starts a Claude session. '
    + 'A checkout that is already there is adopted instead of cloned.'));

  const urlLabel = el('label', 'projects-field');
  urlLabel.append(el('span', null, 'Git URL'));
  const url = document.createElement('input');
  url.type = 'text';
  url.name = 'url';
  url.className = 'projects-url';
  url.placeholder = 'https://github.com/owner/repo.git';
  url.autocomplete = 'off';
  urlLabel.append(url);

  const nameLabel = el('label', 'projects-field');
  nameLabel.append(el('span', null, 'Directory name (optional)'));
  const name = document.createElement('input');
  name.type = 'text';
  name.name = 'name';
  name.className = 'projects-name-input';
  name.placeholder = 'defaults to the repository name';
  name.autocomplete = 'off';
  nameLabel.append(name);

  const submit = el('button', 'projects-add-submit', 'Add project');
  submit.type = 'submit';

  form.append(urlLabel, nameLabel, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    onAdd({ url: url.value.trim(), name: name.value.trim() }, { form, submit, url, name });
  });
  return form;
}

/**
 * The one-tap Claude sign-in repair (#2682).
 *
 * A plain `<a href>` at ServiceBay's own whitelisted terminal deep-link
 * (`?run=claude-login`, shipped in e3c261ac). No route of this server's is
 * involved and no command travels in the URL — `run` names a preset key that
 * ServiceBay looks up in its own whitelist.
 *
 * The link's origin comes from `GET /api/session`, and it is `null` on a box
 * with no public domain. That is rendered as the REASON it cannot be offered,
 * plus the command to run by hand — never as a dead button.
 */
function renderSignIn(session) {
  const url = session?.claudeSignInUrl ?? null;
  const box = el('div', 'projects-signin');
  box.dataset.signin = url ? 'available' : 'unavailable';
  box.append(el('h3', null, 'Claude sign-in'));

  if (!url) {
    box.append(el('p', 'projects-signin-detail',
      'The repair link cannot be built: this page does not know the address a browser reaches '
      + 'ServiceBay on, so it will not offer a link that leads nowhere. Sign in from a shell on '
      + 'the box instead, as the dev user: '
      + 'podman exec claude-dev-claude-dev runuser -u dev -- env HOME=/workspace claude auth login'));
    return box;
  }

  box.append(el('p', 'projects-signin-lede',
    'When this container’s Claude sign-in lapses, every session above goes quiet at once. '
    + 'This opens a ServiceBay terminal inside the container with the sign-in already running, '
    + 'so it can be repaired from a phone rather than over SSH.'));
  const link = el('a', 'projects-signin-link', 'Repair the Claude sign-in');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  box.append(link);
  return box;
}

function renderEmpty(payload) {
  const box = el('div', 'projects-empty');
  box.append(el('h3', null, 'No checkouts yet'));
  box.append(el('p', null,
    `Nothing under ${payload.workspace} is a git checkout, so there is no project to run a `
    + 'Claude session against. Add one below and it appears here.'));
  return box;
}

function renderError(message) {
  const box = el('div', 'projects-error');
  box.setAttribute('role', 'alert');
  box.append(el('h3', null, 'Could not read the project list'));
  box.append(el('p', null, message));
  box.append(el('p', 'projects-error-note',
    'This is a failed read, not an empty workspace — the list below is unknown, not empty.'));
  return box;
}

function renderSourceWarnings(payload) {
  const warnings = [];
  const labels = { sessions: 'Session state', mcp: 'MCP entries' };
  for (const [key, label] of Object.entries(labels)) {
    const source = payload.sources?.[key];
    if (!source || source.ok) continue;
    const note = el('p', 'projects-source-warning',
      `${label} could not be read, so that column reads "Unknown": ${source.error}`);
    note.setAttribute('role', 'alert');
    note.dataset.source = key;
    warnings.push(note);
  }
  return warnings;
}

/**
 * What an add/remove actually did. The warnings the server returns are shown
 * as prominently as the headline: "added, but no session is running" must not
 * be readable as "added".
 */
function renderActionResult(headline, warnings) {
  const box = el('div', warnings.length ? 'projects-result projects-result-partial' : 'projects-result');
  box.setAttribute('role', 'status');
  box.append(el('p', 'projects-result-headline', headline));
  if (warnings.length) {
    const list = el('ul', 'projects-result-warnings');
    for (const warning of warnings) list.append(el('li', 'projects-warning', warning));
    box.append(list);
  }
  return box;
}

/**
 * The confirmation for removing a checkout this page did NOT add (#2713).
 *
 * The old guard refused outright, and its worry was legitimate: this page never
 * created that checkout and knows nothing about what is in it. So the answer is
 * not "trust me" and not "not at all" — it is to say, in the operator's own
 * terms, exactly WHAT IS UNKNOWN, what the removal will do, and what it will
 * leave alone. Every one of the three unknowns is spelled out rather than
 * summarised as "this may be risky", because a vague warning is one you learn
 * to click through.
 */
function renderUnmanagedConfirm(project, { onConfirm, onCancel }) {
  const box = el('div', 'projects-confirm');
  box.setAttribute('role', 'alertdialog');
  box.dataset.projectConfirm = project.name;
  box.append(el('h3', null, `Remove ${project.name}, which this page did not add?`));

  box.append(el('p', 'projects-confirm-lede',
    `This page has no record of ${project.name} — it was cloned outside it. Three things it therefore `
    + 'does not know:'));

  const unknowns = el('ul', 'projects-confirm-unknowns');
  for (const line of [
    'It has no child token of its own for this checkout. Whatever credential the checkout uses was '
    + 'issued somewhere else, and this page cannot revoke it — it stays live.',
    'It has no ServiceBay MCP entry recorded for it. Whatever MCP wiring the checkout has came from '
    + 'elsewhere and is left exactly as it is.',
    'It cannot see inside the checkout. There may be uncommitted work in it, and a session is stopped '
    + 'without asking the process what it was in the middle of.',
  ]) unknowns.append(el('li', 'projects-confirm-unknown', line));
  box.append(unknowns);

  box.append(el('p', 'projects-confirm-will',
    `What this WILL do: stop its Claude session, and mark it so the container does not auto-start `
    + `${project.name} again a few minutes from now.`));
  box.append(el('p', 'projects-confirm-wont',
    `What it will NOT do: delete or change a single file — the checkout stays at ${project.path} with `
    + 'everything in it; revoke any token, because it issued none for this; touch any other project’s '
    + 'session, token or MCP entry.'));

  const confirm = el('button', 'projects-confirm-remove', `Remove ${project.name} anyway`);
  confirm.type = 'button';
  confirm.dataset.projectRemoveConfirm = project.name;
  confirm.addEventListener('click', () => onConfirm(confirm));

  const cancel = el('button', 'projects-confirm-cancel', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', () => onCancel());

  const buttons = el('div', 'projects-confirm-buttons');
  buttons.append(confirm, cancel);
  box.append(buttons);
  return box;
}

function renderActionError(message, detail) {
  const box = el('div', 'projects-action-error');
  box.setAttribute('role', 'alert');
  box.append(el('p', null, message));
  if (detail) box.append(el('p', 'projects-error-note', detail));
  return box;
}

/** `fetch` + "tell me what actually happened", shared by add and remove. */
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

/**
 * Restart ONE project's session (#2682). The headline is built from what the
 * server MEASURED afterwards — it re-asks tmux — and it names the sibling
 * sessions that stayed up, because taking one of those with it is the whole
 * risk of this button.
 *
 * A plain function over the panel context rather than a method, the way the
 * GitHub panel does it, so the action reads on its own.
 */
async function restartSession({ report, reload, isDisposed }, project, button) {
  button.disabled = true;
  report(el('p', 'projects-working', `Restarting the Claude session for ${project.name}…`));
  try {
    const result = await callApi('/api/projects/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: project.name }),
    });
    if (isDisposed()) return;
    const r = result.restarted;
    report(renderActionResult(
      `${r.wasRunning ? 'Restarted' : 'Started'} the Claude session for ${r.name}, confirmed running in tmux. `
      + (r.others.length
        ? `The other ${r.others.length} session(s) were left alone: ${r.others.join(', ')}.`
        : 'No other session was running at the time.'),
      result.warnings ?? [],
    ));
  } catch (err) {
    report(renderActionError(`Could not restart ${project.name}: ${err.message}`, err.detail));
  } finally {
    if (!isDisposed()) button.disabled = false;
    void reload();
  }
}

/**
 * Send the removal and report what the server says it did.
 *
 * `acknowledgeUnmanaged` travels in the query rather than being assumed on the
 * far side: the server refuses an unmanaged removal without it (#2713), so the
 * flag IS the operator's answer to the confirmation, carried through intact.
 *
 * The headline branches on what came BACK, never on what was asked for. An
 * unmanaged removal revoked nothing, and printing "Revoked token null" there
 * would be this repo's favourite bug — a screen reporting work nobody did.
 */
async function sendRemoval({ report, reload, isDisposed }, project, acknowledgeUnmanaged) {
  report(el('p', 'projects-working', `Removing ${project.name}\u2026`));
  try {
    const query = `name=${encodeURIComponent(project.name)}`
      + (acknowledgeUnmanaged ? '&acknowledgeUnmanaged=1' : '');
    const result = await callApi(`/api/projects?${query}`, { method: 'DELETE' });
    if (isDisposed()) return;
    const r = result.removed;
    report(renderActionResult(
      (r.tokenId
        ? `Revoked token ${r.tokenId}, dropped the MCP entry and stopped the session for ${r.name}.`
        : `Stopped the session for ${r.name} and marked it not to auto-start again. This page had no `
          + 'token of its own to revoke and no MCP entry of its own to drop, so it took neither.')
      + ` The checkout itself is still at ${r.path}.`,
      result.warnings ?? [],
    ));
  } catch (err) {
    report(renderActionError(`Could not remove ${project.name}: ${err.message}`, err.detail));
  } finally {
    void reload();
  }
}

/**
 * Remove ONE project (#2680), in one step or two (#2713).
 *
 * `managed === true`: straight through — this page added it and knows exactly
 * what it is taking back. `managed === false`: the confirmation first, because
 * everything about that checkout came from somewhere this page cannot see.
 * `managed === null` never arrives here at all — `actionCell` leaves that
 * button disabled, because a failed read is not a permission.
 */
function removeProjectAction(ctx, project, button) {
  button.disabled = true;
  if (project.managed !== false) return sendRemoval(ctx, project, false);

  ctx.report(renderUnmanagedConfirm(project, {
    onConfirm: (confirmButton) => {
      confirmButton.disabled = true;
      void sendRemoval(ctx, project, true);
    },
    onCancel: () => {
      button.disabled = false;
      // Nothing was sent, so there is nothing to re-read — and saying so beats
      // a dialog that just vanishes.
      ctx.report(el('p', 'projects-working', `Left ${project.name} alone — nothing was sent.`));
    },
  }));
  return Promise.resolve();
}

/**
 * The three mutating actions, kept out of `mount` so the panel body stays a
 * layout function. `isDisposed` is checked after every await: a late response
 * must never repaint a panel the shell already swapped out.
 */
function createActions({ report, reload, isDisposed }) {
  const actions = {
    async onAdd(input, controls) {
      controls.submit.disabled = true;
      report(el('p', 'projects-working', `Adding ${input.name || input.url || 'the project'}\u2026`));
      try {
        const result = await callApi('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (isDisposed()) return;
        const p = result.project;
        const session = p.session === null ? 'its session state is Unknown'
          : p.session.running ? 'its Claude session is running'
            : 'it has NO Claude session running';
        report(renderActionResult(
          `${p.cloned ? 'Cloned' : 'Adopted'} ${p.path}, delegated token ${p.token.id}, and ${session}.`,
          result.warnings ?? [],
        ));
        controls.url.value = '';
        controls.name.value = '';
      } catch (err) {
        report(renderActionError(`Could not add that project: ${err.message}`, err.detail));
      } finally {
        if (!isDisposed()) controls.submit.disabled = false;
        void reload();
      }
    },

    onRestart: (project, button) => restartSession({ report, reload, isDisposed }, project, button),

    onRemove: (project, button) => removeProjectAction({ report, reload, isDisposed }, project, button),
  };
  return actions;
}

/** The panel's static furniture: heading, Refresh, and the two live regions. */
function renderFrame(session) {
  const section = el('section', 'panel panel-projects');
  section.append(el('h2', null, 'Projects'));
  section.append(el('p', 'panel-lede',
    'Every git checkout in the shared workspace, the Claude session running against it, '
    + 'and whether it can reach ServiceBay through an MCP server entry.'));
  section.append(renderSignIn(session));

  const refresh = el('button', 'projects-refresh', 'Refresh');
  refresh.type = 'button';
  section.append(refresh);

  const actionOutput = el('div', 'projects-action-output');
  actionOutput.setAttribute('aria-live', 'polite');
  section.append(actionOutput);

  const output = el('div', 'projects-output');
  output.setAttribute('aria-live', 'polite');
  section.append(output);

  return { section, refresh, actionOutput, output };
}

const panel = {
  id: 'projects',
  title: 'Projects',

  mount(root, ctx) {
    let disposed = false;

    const { section, refresh, actionOutput, output } = renderFrame(ctx?.session);
    section.append(renderAddForm((input, controls) => actions.onAdd(input, controls)));
    root.append(section);

    const actions = createActions({ report, reload: () => load(), isDisposed: () => disposed });

    function report(node) {
      if (!disposed) actionOutput.replaceChildren(node);
    }

    async function load() {
      output.replaceChildren(el('p', 'projects-loading', 'Reading the workspace…'));
      refresh.disabled = true;
      let payload;
      try {
        const res = await fetch('/api/projects', { headers: { Accept: 'application/json' } });
        const parsed = await res.json().catch(() => null);
        if (!res.ok) throw new Error(parsed?.error || `HTTP ${res.status}`);
        if (!parsed || !Array.isArray(parsed.projects)) throw new Error('the server sent no project list');
        payload = parsed;
      } catch (err) {
        if (disposed) return;
        refresh.disabled = false;
        output.replaceChildren(renderError(err.message));
        return;
      }
      if (disposed) return;
      refresh.disabled = false;
      output.replaceChildren(
        ...renderSourceWarnings(payload),
        payload.projects.length === 0
          ? renderEmpty(payload)
          : renderTable(payload, actions),
      );
    }

    refresh.addEventListener('click', () => { void load(); });
    void load();

    return () => { disposed = true; };
  },
};

export default panel;
