---
name: obsidian-cli
description: Use the obsidian_cli tool to interact with an Obsidian vault from the terminal. TRIGGER when user wants to open daily notes, append tasks, search vault, read notes, manage tags, create notes from templates, or use Obsidian dev tools.
---

<overview>
`obsidian` is a CLI tool for interacting with an Obsidian vault and the Obsidian app directly from the terminal. It covers daily notes, vault search, note creation, tag management, dev/debug tools, and automation.
</overview>

<daily_notes>
# Open today's daily note
obsidian daily

# Append content to today's daily note
obsidian daily:append content="- [ ] Buy groceries"

# List all tasks from today's daily note
obsidian tasks daily
</daily_notes>

<vault_operations>
# Search vault (full-text)
obsidian search query="meeting notes"

# Search in a specific vault and export as JSON
obsidian search query="status::active" vault="Notes" format=json

# Read the currently open file
obsidian read

# List files sorted by modification date
obsidian files sort=modified limit=5

# Copy result to clipboard
obsidian files sort=modified limit=5 --copy

# Check for unresolved links across the vault
obsidian unresolved

# View all tags with usage frequency
obsidian tags counts

# Create a new note from a template
obsidian create name="Trip to Paris" template=Travel

# Compare two versions of a file
obsidian diff file=README from=1 to=3
</vault_operations>

<dev_tools>
# Open Obsidian DevTools
obsidian devtools

# Reload a plugin under development
obsidian plugin:reload my-plugin

# Capture a screenshot of the app
obsidian dev:screenshot file=shot.png

# Execute JavaScript inside Obsidian
obsidian eval "app.vault.getFiles().length"

# Review JavaScript errors logged by the app
obsidian dev:errors

# Inspect CSS properties of a selector
obsidian dev:css selector=".workspace"

# Query DOM elements by selector
obsidian dev:dom selector=".nav"
</dev_tools>

<automation_example>
#!/bin/bash
# Morning routine automation

obsidian daily

obsidian daily:append content="- [ ] Review inbox"
obsidian daily:append content="- [ ] Check calendar"

obsidian files sort=modified limit=5 --copy

obsidian unresolved
</automation_example>

<usage_guidelines>
- Always use `obsidian daily` as the entry point for daily note workflows.
- Prefer `format=json` when results need to be processed programmatically.
- Use `--copy` flag to pipe results to clipboard for quick use elsewhere.
- Use `obsidian eval` sparingly — it executes arbitrary JS inside the app.
- Dev tools (`devtools`, `dev:css`, `dev:dom`, `dev:errors`) are for plugin/theme development only.
</usage_guidelines>
