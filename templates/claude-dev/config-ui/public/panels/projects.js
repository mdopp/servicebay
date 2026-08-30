/**
 * Projects panel (#2679, epic #2674) — READ ONLY.
 *
 * Shows what is checked out under /workspace, whether each checkout has a live
 * Claude session, and whether an MCP server entry is wired for it. Until this
 * panel existed none of that was visible anywhere: you had to SSH in and run
 * `tmux list-windows` and `claude mcp list` by hand.
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

function renderTable(payload) {
  const table = el('table', 'projects-table');
  const head = el('thead');
  const headRow = el('tr');
  for (const title of ['Project', 'Claude session', 'ServiceBay MCP entry']) {
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
    body.append(row);
  }

  table.append(head, body);
  return table;
}

function renderEmpty(payload) {
  const box = el('div', 'projects-empty');
  box.append(el('h3', null, 'No checkouts yet'));
  box.append(el('p', null,
    `Nothing under ${payload.workspace} is a git checkout, so there is no project to run a `
    + 'Claude session against. Clone one into the shared workspace and it appears here.'));
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

const panel = {
  id: 'projects',
  title: 'Projects',

  mount(root, _ctx) {
    let disposed = false;

    const section = el('section', 'panel panel-projects');
    section.append(el('h2', null, 'Projects'));
    section.append(el('p', 'panel-lede',
      'Every git checkout in the shared workspace, the Claude session running against it, '
      + 'and whether it can reach ServiceBay through an MCP server entry.'));

    const refresh = el('button', 'projects-refresh', 'Refresh');
    refresh.type = 'button';
    section.append(refresh);

    const output = el('div', 'projects-output');
    output.setAttribute('aria-live', 'polite');
    section.append(output);
    root.append(section);

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
        payload.projects.length === 0 ? renderEmpty(payload) : renderTable(payload),
      );
    }

    refresh.addEventListener('click', () => { void load(); });
    void load();

    return () => { disposed = true; };
  },
};

export default panel;
