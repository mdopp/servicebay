# Terminal

## Goal
Direct command-line access to the host.

## Key Functions
- **Shell Access**: Full bash terminal in the browser.
- **Multiple Sessions**: Switch between different terminal tabs.
- **Persistence**: Sessions remain active in the background.
- **Remote Access**: Connect to configured remote nodes via SSH.
- **Audit Trail**: Commands executed through the Terminal surface in the action history so you can correlate them with backups or deployments.

## Tips
- Use dedicated tabs for long-running tasks (e.g., log tails) so you can keep another tab free for quick triage commands.
- The Terminal shares the SSH connection pool with the backup engine, so avoid closing the browser mid-transfer to keep remote sessions healthy.
