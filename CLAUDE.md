# CLAUDE.md — Instructions for Claude Code Agent

This file auto-loads when Claude Code starts a session in this repo. Read this first.

## Project Context

**Ops Hub** — Internal operations dashboard for Showroom LA (luxury resale).
- Production: https://srlaopshub.netlify.app
- Firebase: `ops-hub-1122d`
- See `README.md` for full handoff context, architecture, Firebase schema, build history.

## Master Ruleset — Apply to ALL changes

Recall phrase: `show me my master ruleset` returns the full block.

**Critical rules to enforce on every task:**

1. **Never rewrite files without permission** — always ask first
2. **Audit before presenting** — no diffs/files until checked
3. **Explain changes in plain terms before editing** — what's changing, what it'll look like, what isn't changing
4. **Confirm no saved data alteration** — explicit approval before deploy/code/Firebase change
5. **Show exactly where fixes were made**
6. **Ask "what could cause this to NOT work?"** — flag risks
7. **Ask "what new problems could this introduce?"** — flag side effects
8. **Verify every insertion point** — no partial files
9. **Syntax check + scope check** after every edit
10. **Edge case awareness** — list edge cases, how each would fail, how to handle
11. **Success definition first** — what does "done" mean to Nelson, explicitly
12. **Guardrails review** — what guardrails exist, what need adding
13. **Netlify function timeout check** — estimate execution time, ensure config matches plan
14. **Error-first debugging** — surface raw errors before guessing causes

## Workflow

### Starting a task

1. Read `README.md` if not already in context
2. Check pending queue (in README)
3. Ask Nelson which item to tackle
4. Lock spec via Q&A before any code

### Building

1. Audit existing code at insertion point (`view`/`grep`)
2. Plan the change in plain English (Rule 5)
3. Get explicit approval
4. Make edits with `str_replace` (verify unique anchors first)
5. Run syntax checks after each edit
6. Run full file syntax check + grep verification before declaring done

### Syntax checking

```bash
# index.html JS syntax
python3 -c "
import re
with open('index.html','r') as f: html = f.read()
scripts = re.findall(r'<script[^>]*>(.*?)</script>', html, re.DOTALL)
biggest = max(scripts, key=len)
with open('/tmp/check.js','w') as f: f.write(biggest)
" && node --check /tmp/check.js

# Function syntax
node --check netlify/functions/shopify-sync.js
node --check netlify/functions/shopify-sync-scheduled.js
node --check netlify/functions/todays-queue.js
```

### Shipping

1. Stage changes: `git status` and `git diff` to verify
2. Commit with descriptive message: `git commit -m "feat: <what changed>"`
3. Push: `git push origin main`
4. Netlify auto-deploys via GitHub integration
5. Monitor Netlify build log for issues
6. Report deploy status to Nelson

## Repo Structure

```
.
├── _redirects                    # Netlify SPA fallback
├── netlify.toml                  # Function config + cron schedules
├── index.html                    # Single-file React app (~7,200 lines)
├── netlify/functions/
│   ├── shopify-sync.js           # Manual Shopify sync
│   ├── shopify-sync-scheduled.js # 7am PT Mon-Sat cron
│   └── todays-queue.js           # Today's Queue live data
├── README.md                     # Full handoff document
└── CLAUDE.md                     # This file
```

## Key Files to Know

| File | Purpose | Notes |
|---|---|---|
| `index.html` | Entire React app + CSS | Search by `const ComponentName` to find sections |
| `netlify/functions/shopify-sync.js` | Manual sync triggered by user | Has writeFirebase helper |
| `netlify/functions/shopify-sync-scheduled.js` | Cron-triggered sync | Has writeFirebase helper |
| `netlify/functions/todays-queue.js` | Live queue endpoint | 5-min cache |
| `netlify.toml` | Function timeouts + cron config | Only `[functions."name"]` blocks per function |

## Environment Variables (set in Netlify dashboard)

- `SHOPIFY_CLIENT_ID` — Shopify OAuth ID
- `SHOPIFY_CLIENT_SECRET` — Shopify OAuth secret
- `SHOPIFY_SHOP` — defaults to `showroomla.myshopify.com`
- `CONSIGNR_API_KEY` — (Phase 1A.2, not yet active)

## Firebase Schema Quick Reference

**`ops_data/*`** — operational data
**`auth/*`** — auth + sync state

See `README.md` for full path inventory.

## Permission System

- `FEATURE_REGISTRY` in `index.html` (around line ~5335)
- `userHasPerm(userProfile, flag_id)` — admin bypass built-in
- `isAdminEmail(email)` — hardcoded admin check (Nelson, Matts)

25 flags currently registered. See README for full list.

## Common Pitfalls

1. **Lowercase folders** — Netlify Linux is case-sensitive
2. **Don't edit compiled JSX in `<script>` directly without backup** — the file ships precompiled
3. **`netlify.toml` `[functions]` global timeout block won't work on Pro** — must request 26s per-site via support
4. **Background functions need `-background` suffix in filename**
5. **Firebase Realtime Database key is hardcoded** — public API key, security via DB rules
6. **Always pass `closedDays` to wgmSumKey/wgmYnKey** — closed days excluded from week math
7. **Tier fields** — `inv_unsorted` stores tier label strings, math uses `TIER_MIDPOINTS` lookup
8. **Sunday exclusions** — `SUNDAY_SKIP_KEYS` for sums, `SUNDAY_AUTOPASS_YN_KEYS` for streaks

## When Stuck

1. Read `README.md` again — most context is there
2. Search the codebase: `grep -n "thing" index.html`
3. Ask Nelson — don't guess specs or assume answers
4. Check Firebase console for live data structure if confused about schema

## Output Conventions

- Be specific about what changed
- Show diffs as plain text in chat (not just describe)
- Always offer to revert if Nelson disapproves
- After deploy, report Netlify build status
- Update README.md when shipping new phases (especially the "Pending Work Queue" and "Build History" sections)

## Project Commands
- **"project device refresh"** — Nelson works across multiple devices, each pushing to GitHub. On this cue: `git fetch origin`; if the local branch is behind and the working tree is clean, `git pull --ff-only`, then summarize the new commits and what changed. If there are uncommitted local changes or the branch has diverged, STOP and flag it — never clobber local work.

---

*This file should be the first thing read in any Claude Code session for this repo. Keep concise — full details in README.md.*
