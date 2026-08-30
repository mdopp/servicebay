/**
 * SEAM 1 — the panel manifest.
 *
 * This file is the ONE place a follow-up unit registers a page into the shell.
 * Add a module next to this one (`projects.js`, `github-auth.js`, …) that
 * default-exports a panel, import it here, and list it in `PANELS`:
 *
 *   import projects from './projects.js';
 *   export const PANELS = [projects];
 *
 * A panel is a plain object:
 *
 *   {
 *     id: 'projects',              // stable, used as the nav key + hash route
 *     title: 'Projects',           // nav label
 *     mount(root, ctx) { … }       // render INTO `root` (it is emptied first);
 *   }                              // `ctx` = { session } from GET /api/session.
 *
 * `mount` may return a cleanup function; the shell calls it when another panel
 * takes over. Panels talk to the container through the server's `API_ROUTES`
 * (SEAM 3 in ../../server.mjs) — never directly to ServiceBay from the browser,
 * because the ServiceBay token deliberately stays server-side.
 *
 * #2678 shipped the shell; #2679 filled the first slot; #2680-#2682 follow.
 */
import projects from './projects.js';
import github from './github.js';

export const PANELS = [projects, github];

export default PANELS;
