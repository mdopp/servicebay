// Self-contained disk-import app frontend (#1953, slice of #1949).
//
// Served as ONE HTML string by the worker's in-container server (server.ts) —
// no build step, no bundler, no framework. The whole app (device picker → scan →
// LAZY review tree → apply) is vanilla JS so the worker image stays a thin
// Node-only container and a UI change rebuilds ONLY the worker image, never
// servicebay (the issue's acceptance).
//
// The review tree is LAZY by construction: it renders one directory level at a
// time, fetching a node's children from /api/tree only when the user expands it,
// so a 269k-file disk never renders whole (the review-UX fix in #1949). Each
// collapsed node already shows its subtree rollup (files/size/categories) from
// the level fetch, so the user sees "what's in here" without expanding.

export const APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Import data from a disk</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; padding: 1.5rem; max-width: 60rem; }
  h1 { font-size: 1.25rem; }
  button { font: inherit; padding: .4rem .8rem; border-radius: .5rem; border: 1px solid #888;
           background: #2563eb; color: #fff; cursor: pointer; }
  button.secondary { background: transparent; color: inherit; }
  button:disabled { opacity: .5; cursor: default; }
  .muted { color: #888; font-size: .85rem; }
  .row { display: flex; align-items: center; gap: .5rem; padding: .25rem 0; }
  #tree { margin-top: 1rem; }
  .node { display: flex; align-items: center; gap: .5rem; padding: .25rem 0; }
  .twisty { width: 1rem; display: inline-block; text-align: center; cursor: pointer; user-select: none; }
  .leaf .twisty { cursor: default; color: #bbb; }
  .name { font-weight: 600; }
  .tally { color: #888; font-size: .8rem; }
  .cats { color: #2563eb; font-size: .75rem; }
  .err { color: #dc2626; }
</style>
</head>
<body>
<h1>Import data from a disk</h1>
<p class="muted">Pick a USB disk, scan it, review where everything will land, then import.
The scan runs in its own resource-capped container — it can't slow down the box.</p>

<section id="pick">
  <div class="row"><strong>Disk:</strong>
    <select id="device"></select>
    <button id="refresh" class="secondary">Refresh</button>
    <button id="scan">Scan disk</button>
  </div>
</section>

<section id="progress" hidden>
  <div class="row"><span id="phase">Starting…</span></div>
  <div class="muted" id="counts"></div>
</section>

<section id="review" hidden>
  <h2 id="summary"></h2>
  <p class="muted">Each folder shows its whole contents. Expand to drill in — only the
  level you open is loaded, so even a huge disk stays responsive.</p>
  <div id="tree"></div>
  <p class="muted" style="margin-top:1rem">Reviewed everything? Go back to the
  <strong>Import data from a disk</strong> page in ServiceBay and press
  <strong>Import now</strong> to copy the files into your library.</p>
  <div class="row" style="margin-top:.5rem">
    <button id="cancel" class="secondary">Start over</button>
  </div>
</section>

<p id="error" class="err" hidden></p>

<script>
const $ = (id) => document.getElementById(id);
let lastDevice = '';

function fmtBytes(n) {
  const u = ['B','KB','MB','GB','TB']; let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(i ? 1 : 0) + ' ' + u[i];
}
function showError(msg) { $('error').hidden = !msg; $('error').textContent = msg || ''; }

async function loadDevices() {
  showError('');
  try {
    const r = await fetch('api/devices'); const { devices } = await r.json();
    const sel = $('device'); sel.innerHTML = '';
    for (const d of devices) {
      const o = document.createElement('option'); o.value = d.path; o.textContent = d.display; sel.appendChild(o);
    }
    $('scan').disabled = devices.length === 0;
    if (devices.length === 0) { const o = document.createElement('option'); o.textContent = 'No USB disk detected'; sel.appendChild(o); }
  } catch (e) { showError('Could not list disks: ' + e.message); }
}

async function startScan() {
  showError('');
  lastDevice = $('device').value;
  const r = await fetch('api/scan', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device: lastDevice }) });
  if (!r.ok) { showError('Scan failed to start'); return; }
  $('pick').hidden = true; $('progress').hidden = false; poll();
}

async function poll() {
  try {
    const r = await fetch('api/status');
    if (r.status === 204) { setTimeout(poll, 1000); return; }
    const s = await r.json();
    $('phase').textContent = s.step || s.phase;
    $('counts').textContent = 'scanned ' + s.scanned + (s.planned ? ' · planned ' + s.planned : '');
    if (s.phase === 'error') { showError(s.error || 'Scan failed'); return; }
    if (s.phase === 'done' || (s.phase !== 'scanning' && s.planSidecar)) { showReview(s); return; }
    setTimeout(poll, 1000);
  } catch (e) { showError('Lost contact with the worker: ' + e.message); }
}

function showReview(s) {
  $('progress').hidden = true; $('review').hidden = false;
  $('summary').textContent = s.planned + ' files · ' + fmtBytes(s.totalBytes) +
    (s.conflicts ? ' · ' + s.conflicts + ' to double-check' : '');
  $('tree').innerHTML = '';
  renderLevel('', $('tree'), 0);
}

// LAZY: fetch one level of children and render them; expanding a node fetches
// the NEXT level on demand (never the whole tree).
async function renderLevel(dir, container, depth) {
  const r = await fetch('api/tree?dir=' + encodeURIComponent(dir));
  if (!r.ok) { showError('Could not load folder'); return; }
  const { children } = await r.json();
  for (const node of children) container.appendChild(nodeRow(node, depth));
}

function nodeRow(node, depth) {
  const wrap = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'node' + (node.hasChildren ? '' : ' leaf');
  row.style.paddingLeft = (depth * 1.2) + 'rem';
  const twisty = document.createElement('span'); twisty.className = 'twisty';
  twisty.textContent = node.hasChildren ? '▶' : '·';
  const kids = document.createElement('div'); kids.hidden = true; let loaded = false;
  if (node.hasChildren) {
    twisty.onclick = async () => {
      kids.hidden = !kids.hidden; twisty.textContent = kids.hidden ? '▶' : '▼';
      if (!loaded && !kids.hidden) { loaded = true; await renderLevel(node.dir, kids, depth + 1); }
    };
  }
  const name = document.createElement('span'); name.className = 'name'; name.textContent = node.name || '(root)';
  const tally = document.createElement('span'); tally.className = 'tally';
  tally.textContent = node.totalFiles + ' files · ' + fmtBytes(node.totalBytes);
  const cats = document.createElement('span'); cats.className = 'cats'; cats.textContent = node.categories.join(', ');
  row.append(twisty, name, tally, cats);
  wrap.append(row, kids);
  return wrap;
}

// APPLY runs in ServiceBay over the host mount (#1972), NOT in this sandboxed
// worker — so there is no apply button here; the review tree is the confirm
// surface and "Import now" lives on the control-plane tile.

$('refresh').onclick = loadDevices;
$('scan').onclick = startScan;
$('cancel').onclick = () => location.reload();
loadDevices();
</script>
</body>
</html>`;
