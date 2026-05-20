import sys
import json
import time
import os
import subprocess
import threading
import select

# Configuration
WATCH_DIR = os.path.expanduser("~/.config/containers/systemd")
POLL_INTERVAL = 2.0

def log(msg):
    sys.stderr.write(f"[Agent] {msg}\n")
    sys.stderr.flush()

# stdout is the SSH channel back to ServiceBay. Once handle_command runs
# in worker threads (so a long exec doesn't block other commands on the
# same channel), multiple threads will race on print() — which can
# interleave bytes mid-message and break the framing the JS client
# expects ("\n"-delimited JSON). Serialize every emit through a lock.
_emit_lock = threading.Lock()

def emit(event_type, payload):
    msg = json.dumps({"type": event_type, "payload": payload})
    with _emit_lock:
        print(msg, flush=True)

class FileWatcher(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.files_state = {}

    def get_dir_state(self):
        state = {}
        if not os.path.exists(WATCH_DIR):
            return state
        try:
            for f in os.listdir(WATCH_DIR):
                full_path = os.path.join(WATCH_DIR, f)
                if os.path.isfile(full_path):
                    state[f] = os.stat(full_path).st_mtime
        except OSError:
            pass
        return state

    def run(self):
        self.files_state = self.get_dir_state()
        while True:
            time.sleep(POLL_INTERVAL)
            new_state = self.get_dir_state()
            
            # Check for changes
            changed = False
            
            # Any new or modified files?
            for f, mtime in new_state.items():
                if f not in self.files_state or self.files_state[f] != mtime:
                    emit("file:change", {"operation": "update", "path": f})
                    changed = True
            
            # Any deleted files?
            for f in self.files_state:
                if f not in new_state:
                    emit("file:change", {"operation": "delete", "path": f})
                    changed = True
            
            if changed:
                self.files_state = new_state

class ServicePoller(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.last_status = {}

    def run(self):
        while True:
            # We only really care about active services changing state
            # Getting full list is expensive, maybe we just wait for explicit 'list' command?
            # But the requirement is "Simple poller for systemctl is-active"
            # Let's poll services that we know about (from the file watcher?)
            # For now, just a placeholder / heartbeat
            # Real implementation would run `systemctl --user show --property...`
            time.sleep(5)
            # emit("heartbeat", {"time": time.time()})

def handle_command(cmd_line):
    try:
        cmd = json.loads(cmd_line)
        action = cmd.get("action")
        req_id = cmd.get("id")
        
        result = None
        error = None
        
        if action == "ping":
            result = "pong"
        
        elif action == "exec":
            # Execute a shell command
            command = cmd.get("command")
            try:
                proc = subprocess.run(command, shell=True, capture_output=True, text=True)
                result = {
                    "code": proc.returncode,
                    "stdout": proc.stdout,
                    "stderr": proc.stderr
                }
            except Exception as e:
                error = str(e)

        elif action == "exec_stream":
            # Execute a shell command, streaming stdout line-by-line as
            # `exec:chunk` events while the process runs. Final response
            # carries the exit code and the joined stdout/stderr (so
            # callers that don't subscribe to chunks still get the
            # legacy result shape). Used for post-deploy scripts so the
            # operator sees the script's heartbeat instead of staring
            # at "Running auth post-deploy script..." for ten minutes
            # while the command buffers in subprocess.PIPE.
            command = cmd.get("command")
            try:
                proc = subprocess.Popen(
                    command,
                    shell=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,  # line-buffered
                )
                stdout_lines = []
                # Stream every line back as it arrives. Carries the
                # request id so the client can correlate chunks with
                # the in-flight request — same id will appear on the
                # final `response` event.
                assert proc.stdout is not None
                for line in proc.stdout:
                    line = line.rstrip("\n")
                    stdout_lines.append(line)
                    emit("exec:chunk", {"id": req_id, "line": line})
                proc.wait()
                result = {
                    "code": proc.returncode,
                    "stdout": "\n".join(stdout_lines),
                    "stderr": "",  # merged into stdout via stderr=STDOUT above
                }
            except Exception as e:
                error = str(e)

        elif action == "list_files":
             if os.path.exists(WATCH_DIR):
                 result = os.listdir(WATCH_DIR)
             else:
                 result = []

        elif action == "read_file":
            path = cmd.get("path")
            # Security check: only allow files in WATCH_DIR for now, or generally user readable?
            # Assuming agent runs as user, so OS permissions apply. But to be safe, maybe restrict?
            # ServiceBay needs to access ~/.ssh too (for key management potentially?). 
            # Let's allow arbitrary paths for now (user permissions).
            full_path = os.path.expanduser(path)
            if os.path.exists(full_path):
                with open(full_path, 'r', encoding='utf-8') as f:
                    result = f.read()
            else:
                error = "File not found"

        elif action == "write_file":
            path = cmd.get("path")
            content = cmd.get("content")
            full_path = os.path.expanduser(path)
            # Ensure dir exists
            os.makedirs(os.path.dirname(full_path), exist_ok=True)
            with open(full_path, 'w', encoding='utf-8') as f:
                f.write(content)
            result = "ok"

        # Send response
        emit("response", {"id": req_id, "result": result, "error": error})
        
    except json.JSONDecodeError:
        log("Invalid JSON received")

def main():
    log("Starting ServiceBay Agent...")
    
    # Ensure config dir exists
    if not os.path.exists(WATCH_DIR):
       try:
           os.makedirs(WATCH_DIR, exist_ok=True)
       except:
           pass

    # Start Watch Threads
    watcher = FileWatcher()
    watcher.start()
    
    poller = ServicePoller()
    poller.start()

    # Main Loop: Read stdin
    emit("agent:ready", {"version": "1.0"})
    
    while True:
        try:
            # Blocking read line
            line = sys.stdin.readline()
            if not line:
                break # EOF
            # Spawn each command in a worker thread so a long-running
            # exec (e.g. a 10-minute post-deploy waiting on LLDAP)
            # doesn't block the read loop. Without this, every
            # subsequent write_file / exec the wizard sent for the
            # next service queued behind the in-flight exec on the
            # SSH channel and timed out client-side at 30s — a
            # single slow service used to fail the entire install.
            threading.Thread(
                target=handle_command,
                args=(line.strip(),),
                daemon=True,
            ).start()
        except KeyboardInterrupt:
            break
        except Exception as e:
            log(f"Error in main loop: {e}")

if __name__ == "__main__":
    main()
