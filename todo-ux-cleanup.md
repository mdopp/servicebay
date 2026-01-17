ux / ui

[x] **Settings · Log Level card**
	- Match the visual style (card chrome, padding, typography) used by other Settings cards (e.g., Template Settings).
	- Remove the redundant "Current level: INFO" copy and rely on the segmented control state to show the active level.

[x] **Settings · Autosave form controls**
	- Remove the global "Save All" and "Save Log Level" buttons.
	- Persist each field as soon as it blurs (or when toggles change) using the existing settings mutation endpoints.
	- Show inline error or success toasts, and disable inputs while a write is pending.

[x] **Settings · Card descriptions**
	- Add sentence-length helper text under "Template Settings" and "Template Registries" describing their purpose, mirroring other cards on the page.

[x] **Settings · Template variables layout**
	- Move the "+ Add Variable" row above the existing variable list.
	- Ensure new variables use the same inline-edit component as existing entries.

[x] **Settings · System Connections inline edit**
	- Reuse the inline-edit pattern from Template Settings for node rows (edit in place, confirm/cancel inline) instead of modal popovers.

[x] **System Info & Terminal · Node selector**
	- Replace the pills with a shared dropdown (use our `Select` component) listing all nodes, with avatar/icon support.
	- Store the selected node in the URL (`?node=atHome`) and default to the URL value on page load so browser navigation works.

[x] **Plugins · Tab deep-linking**
	- For every plugin with tabs, reflect the active tab in the URL (e.g., `?tab=logs`).
	- Read this parameter on mount to restore the previously viewed tab and update it via `router.replace` when switching tabs.

[x] **Network Map · Loading notification**
	- When the graph reloads, show a toast or inline banner (“Reloading network graph…”) and dismiss it immediately after the render settles.

[x] **Monitoring · Logs toolbar alignment**
	- Make the date, level, tags, limit, refresh, and download controls share the same height and spacing.

[x] **Monitoring · Logs theme**
	- Update the log list to use the global slate/emerald color palette (no custom colors) and ensure dark-mode tokens are present.

[x] **Monitoring · History/Edit overlays**
	- Convert the modals into right-aligned drawer overlays (full width on mobile) and add a spinner placeholder while history loads.

[x] **Containers + Volumes consolidation**
	- Replace the separate plugins with a single “Container Engine” surface.
	- Implement two tabs (“Containers”, “Volumes”) within that surface; reuse the existing container list layout for volumes to keep visual parity.

[x] **Container list · Reduce noise**
	- Hide infrastructure containers (system services we tag as infra) by default, with an optional filter to reveal them.
	- Remove raw container IDs from the list rows and tighten padding/line height so more rows fit per viewport.

[x] **Container list · Port scoping**
	- Only display ports that belong to the specific container rather than the pod-wide list, and apply the same scoping in the log/info overlays.

[x] **Overlays · ESC to close**
	- All overlay modals/drawers should listen for `Escape` and close without persisting changes.

[x] **Services plugin · Tab split**
	- Introduce two tabs: “Managed Services” (current view) and “Discover Services” (unmanaged). Trigger discovery only when the second tab mounts.

[x] **Services plugin · Streamlined unmanaged cards**
	- For unmanaged entries, collapse the current detail buttons into a single “Migrate” action (old “Review →”).
	- Move the most important detail fields into step one of the migration wizard so the pre-review modal is unnecessary.

[x] **Services plugin · Delete unmanaged**
	- Add a delete action to unmanaged services with a confirmation modal so admins can drop bad detections.

[x] **Merge wizard · Visual alignment**
	- Apply the shared card and color tokens to the wizard.
	- Represent “Assets → Stack → Backup Plan” as a horizontal process (e.g., progress tracker) instead of isolated rectangles to emphasize flow.

[x] container engine . volumes
    - the volumes tab should also show the global search in the header as it does witht he container tab
    - currently there are two help ? on the volume tab. one belongs to the container, the other to volumes. pls make sure only the ? from the volumes is shown (right beside the caption in the header)
    - "+ add volume" should be changed to show only "+" as all add buttons.

[x] container engine . containers
    - "show infrastructure containers" doesnt have any affect