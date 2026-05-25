---
name: oscar-dynamic-skills
description: Use when the user requests OSCAR to learn a new capability, write down a fact/note, configure an agent, or when OSCAR needs to self-enhance its knowledge, skills, or peer agent behaviors dynamically. Implements the Phase 4 self-improvement loop.
version: 1.0.0
author: OSCAR
license: MIT
---

# OSCAR — Dynamic Skills, Agents, and Knowledge Self-Enhancement

## Overview

This skill defines the operating procedures for **OSCAR Phase 4** (the Self-Enhancement Loop). It equips the Hermes Agent with instructions to perform:
1. **Dynamic Knowledge Writing**: Writing or updating structured facts and markdown notes in `/opt/data/notes/` so the hybrid-retrieval system picks them up.
2. **Dynamic Skill Compiler**: Authoring new skill specifications, sandboxing Python or JavaScript execution to verify them, writing `/opt/data/skills/oscar/<skill-name>/SKILL.md`, and reloading the Hermes service via ServiceBay-MCP.
3. **Dynamic Agent Configuration**: Direct conversational feedback rules that update Honcho peer templates and custom instructions.

---

## 1. Dynamic Knowledge Writing

When the user shares household facts, preferences, or notes (e.g., "Remember that the garden key is under the blue pot"), OSCAR must write them down so they are permanently indexed.

### Rules:
- **Global Notes File**: Write general household facts and memory states into `/opt/data/notes/SOUL.md`.
- **Domain-Specific Notes**: Write topic-specific notes into structured files under `/opt/data/notes/fact_<topic>.md` (e.g., `/opt/data/notes/fact_garden.md` or `/opt/data/notes/fact_server_network.md`).
- **Instant Retrieval**: The native `qmd` hybrid-retrieval engine automatically scans `/opt/data/notes/` and will retrieve these files for contextual prompt injection.

### Operating Sequence:
1. Formulate a clean Markdown block summarizing the new facts, including tags and date updated.
2. Read the existing note file using `view_file` if it exists.
3. Append or rewrite the file using `write_to_file` (or `replace_file_content` for edits) under `/opt/data/notes/`.
4. Inform the user: *"Ich habe mir das notiert in <filename>."*

---

## 2. Dynamic Skill Compiler

When a user requests a new automation or capability (e.g., "Learn how to parse local weather warnings from this specific API"), OSCAR can write a brand-new skill.

### Rules & Sandboxing:
- **Location**: Write the new skill file to `/opt/data/skills/oscar/<skill-name>/SKILL.md`.
- **Sandboxing & Testing**:
  - Before finalizing any custom shell script or python routine, write it to a temporary sandbox file inside `/opt/data/skills/oscar/<skill-name>/scratch/test_run.py`.
  - Run the test script using `run_command` in a non-interactive sandbox shell.
  - Verify that the API calls work, standard outputs are correct, and all dependencies are resolved.
- **Reloading Hermes**:
  - Once the skill `SKILL.md` is successfully written and verified, trigger a service reload.
  - Call the ServiceBay-MCP tool `restart_service` with the argument `{"service": "hermes"}`. This forces Hermes to reload all active skills on-the-fly without system downtime.

### Example SKILL.md Structure to Generate:
```markdown
---
name: oscar-custom-<name>
description: <detailed description for LLM router>
version: 1.0.0
author: OSCAR Dynamic Compiler
license: MIT
---

# OSCAR — Custom Skill <Name>

## When to use
- <Use-case triggers>

## Operating sequence
1. <Step-by-step instructions>
```

---

## 3. Dynamic Agent Configuration

OSCAR operates with peer agents and templates managed under Honcho. When performance gaps or stylistic desires are noted, OSCAR can modify the instructions of its peer agents.

### Rules:
- **Honcho Peer Templates**: Read and update agent prompt templates in `/opt/data/agents/` or via Honcho configuration tables in `oscar.db`.
- **Peer Coordination**: When a peer's prompt is modified, trigger a refresh of the Honcho agent cache.
- **Verification**: Always review peer instruction changes to ensure they remain safe, ethical, and do not introduce loops or rule conflicts.

---

## Failure Paths & Safety Guards

- **Strict Path Sandboxing**: Never write or edit files outside `/opt/data/` or the designated project workspaces.
- **Testing Before Merging**: Never write a complex `SKILL.md` without running a validation probe or test execution of the underlying command/API first.
- **Error Recovery**: If a service reload of `hermes` fails or causes a crash, check logs using `journalctl -u hermes` via ServiceBay-MCP, revert the changes in `SKILL.md`, and reload again.
