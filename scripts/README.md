# scripts/

FiveM resources built with the `fivem-script-dev` skill (`.claude/skills/fivem-script-dev/`)
live here — one folder per resource. Each folder is linked into the FiveM server's
`resources/` directory with a junction/symlink, so the repo copy **is** the live resource;
see the skill's `references/deploy-verify.md` for the link and deploy flow.

Nothing in here is required by fivem-mcp itself. Resources are tracked in git on purpose —
the repo is the source of truth for what runs on the server. If you'd rather not commit
yours, add `scripts/<name>/` to your local excludes (`.git/info/exclude`).
