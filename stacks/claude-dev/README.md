# Claude Dev stack

A one-template stack that runs a containerised [Claude Code](https://claude.com/claude-code)
development environment on the homelab itself.

The motivation: driving a coding session against ServiceBay from the
Claude Code mobile app normally needs a powered-on laptop running the
CLI somewhere reachable over SSH. The moment that laptop sleeps, mobile
development stops. This stack moves the toolchain into a container the
homelab already runs 24/7, so the dev box is no longer a single point of
failure for development.

It contains a single template, [`claude-dev`](../../templates/claude-dev/README.md) —
see that README for the container contents and how to start a session.
