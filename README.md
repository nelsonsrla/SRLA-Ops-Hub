# Ops Hub — Master Handoff Document

**Last updated:** May 30, 2026
**Owner:** Nelson Johnson (Showroom LA, GM)
**Production URL:** https://srlaopshub.netlify.app
**Repo:** github.com/nelsonsrla/srlaopshub _(your repo path may differ — confirm)_
**Firebase project:** `ops-hub-1122d`

This document captures everything needed to onboard into the Ops Hub codebase, including history, current state, architecture, pending work, and conventions.

---

## TL;DR

Ops Hub is an internal React + Firebase + Netlify Functions application for Showroom LA. It runs daily operational logging (inventory, shipping), KPI tracking, sales attribution, weekly history, and a live shipping queue tied to Shopify orders.

- **Frontend:** Single-file React app (`index.html`) — ~7,200 lines, esbuild-compiled output checked in directly.
- **Backend:** Netlify Functions for Shopify sync (manual + scheduled cron) and Today's Queue.
- **Data:** Firebase Realtime Database (`ops_data/*` and `auth/*` namespaces).
- **Auth:** Firebase Auth with role-based feature flags stored in `auth/users/{uid}`.

---

## Master Ruleset (1-20) + Prompt Engineering Rules

**Apply to every code change. No exceptions.**

### Rules 1-20

1. **Never rewrite any file without explicit permission.** Always ask first.
2. **Audit all work before presenting.** No files or instructions until audit passes.
3. **Always provide the most recent updated file.**
4. **Always present downloadable file at bottom of every response.** Never describe without presenting.
5. **Before ANY edit to code or files, explain in plain simple terms:** (1) exactly what is being changed, (2) what it will look like after, (3) what is NOT changing. Wait for explicit approval before proceeding.
6. **Explicitly confirm with Nelson no saved data will be altered or deleted** before any deploy, code change, or Firebase change. Never proceed until Nelson approves.
7. **Always double-check code for errors before presenting.**
8. **Always show exactly where fixes were made.**
9. **Before presenting, ask: what would cause this to NOT work?** Confirm each possibility is handled or flag clearly.
10. **Before presenting any solution, ask: are there new problems this could introduce?** Flag all new risks before proceeding.
11. **Verify every insertion point, never present partial file.**
12. **Syntax check AND scope check** (every referenced variable must be defined in scope) after every edit.
13. **Never skip rules.**
14. **Scale across locations/managers/employees.**
15. **All failsafes:** try/catch on every fn, Firebase fallbacks, null/undefined guards, undefined reference checks, graceful API failure handling. Flag missing failsafes before presenting.
16. **Edge case awareness:** Before presenting any feature or build, explicitly identify all reasonable edge cases that could cause the feature to misbehave or produce incorrect results. For each: (1) what the edge case looks like, (2) how it would fail under current design, (3) how to resolve it quickly/efficiently without deviating from requested parameters.
17. **Success definition:** Before making any changes to code or completing any tasks, always ask what success looks like in Nelson's eyes. Get explicit success criteria confirmed before starting work.
18. **Guardrails check:** Before starting any task, (1) ask Nelson what guardrails should be in place, and (2) show Nelson what guardrails are already in place. Explicit guardrail review required before work begins.
19. **Netlify Function Timeout:** Before building/modifying any Netlify function: (1) estimate total execution time including all external API calls, (2) if function makes >1 sequential external API call, flag timeout risk before writing code, (3) always ensure netlify.toml has `[functions]` timeout=26 on Pro plan with support-ticket enablement, (4) never chain API calls without confirming combined latency fits within timeout limit.
20. **Error-First Debugging:** Before any other diagnostic step on any broken feature or build, always surface the raw error from the source system first. Add console logging, version checks, or debug endpoints immediately to expose the exact failure before attempting any fix. Never infer from symptoms alone.

### Prompt Engineering Rules (apply to EVERY input, run visibly before responding)

1. Analyze input
2. Craft focused prompt for Claude Sonnet
3. Specific yet open-ended
4. Add context/role/instructions as needed
5. If vague, add clarifying question instructions
6. Output prompt in code block
7. Explain reasoning after prompt

### Recall phrase

`show me my master ruleset` → return full copy-paste block of Rules 1-20 + Prompt Engineering Rules. Saved as "Nelson Master Ruleset v1," last confirmed April 2026.

---

## Repository Layout

```
ops-hub-final/
├── _redirects                    # Netlify SPA fallback
├── netlify.toml                  # Function config + cron schedules
├── index.html                    # ENTIRE React app (~7,200 lines compiled JS inside <script>)
└── netlify/functions/
    ├── shopify-sync.js           # Manual on-demand Shopify sync
    ├── shopify-sync-scheduled.js # 7am PT Mon-Sat cron
    └── todays-queue.js           # Today's Shipping Queue live data
```

### index.html — what's inside

It's a single HTML file containing CSS in `<style>` tags + compiled React inside a giant `<script>` tag. Source pattern is JSX-style but the file commits the precompiled JS (uses `React.createElement` calls, no JSX in the deployed file).

When editing the React code:
- Search by component name (`const DailyLogPage = `, `const WeekGlanceModal = `, etc.)
- All components defined as top-level `const X = function(props) {...}` or `const X = ({ a, b }) => {...}`
- `useState` and `useEffect` accessed via `React.useState` / `React.useEffect`

---

## Architecture

### Frontend (index.html)

**Top-level components (by line approximation):**
- `KpiCard` — KPI display card with target + current value editor
- `TrackerPage` — KPI tab content per department
- `KPIsTab` — KPI tab parent wrapper
- `YNToggle`, `CountStepper`, `TierPicker`, `NoteField` — form input components
- `DailyLogPage` — main Daily Log surface (~lines 1289-2055)
- `WeekHistoryCard` — Past Weeks list with expandable rows
- `WeekGlanceModal` — Week-at-a-Glance interactive popup
- `DateRangePicker` — reusable date picker component (single + range modes)
- `QuickCounterPanel` — Quick Count tab
- `TodaysShippingQueueTab` — Today's Queue tab
- `SyncReviewSection` — manual Shopify sync UI inside Daily Log
- `PendingItemsPanel` — orders moved to pending
- `SkuNotesPanel` — log specific items panel (unified between QC + Daily Log)
- `ActivityPage` — admin activity log
- `AdminPanel` — admin user/role management
- `LoginScreen` — Firebase Auth login
- `App` — root component (state management + routing)

### Backend (netlify/functions/)

**`shopify-sync.js`** (manual, on-demand)
- Triggered by user clicking "Sync Shopify" in Daily Log
- Fetches orders for selected date + previous day
- Performs late-shipment classification, payment gate, Saturday $5k rule
- Writes to `auth/syncHistory/{date}`
- As of Phase 1A.1: also writes sales insights pool cache to `ops_data/salesInsights/orders/`

**`shopify-sync-scheduled.js`** (7am PT Mon-Sat cron)
- Same logic as manual but auto-runs for "yesterday"
- Same sales insights pool cache write
- Configured via `[functions."shopify-sync-scheduled"]` in netlify.toml

**`todays-queue.js`** (live data)
- Fetches unfulfilled orders for Today's Shipping Queue tab
- Uses 5-min cache at `auth/todaysQueueCache/{date}`
- Returns shipping queue with classification

### Environment Variables (Netlify dashboard → Site config → Environment variables)

| Variable | Required by | Purpose |
|---|---|---|
| `SHOPIFY_CLIENT_ID` | All 3 syncs | Shopify OAuth client ID |
| `SHOPIFY_CLIENT_SECRET` | All 3 syncs | Shopify OAuth client secret |
| `SHOPIFY_SHOP` | All 3 syncs | Shop domain. Defaults to `showroomla.myshopify.com` |

**To add post-Phase-1A.2:** `CONSIGNR_API_KEY` (consignr.app integration)

### Hardcoded constants (at top of function files — should be env vars eventually)

| Constant | Value |
|---|---|
| `FIREBASE_URL` | `https://ops-hub-1122d-default-rtdb.firebaseio.com` |
| `FIREBASE_KEY` | `AIzaSyClTXv6C_SDtwEzZ9DN4ZOTf8ocA4ni8hY` |

The Firebase key is a public Web API Key — security is at the database-rules layer, not key-secrecy. Still worth moving to env vars in a future cleanup.

---

## Firebase Schema

### Top-level namespaces

- `ops_data/*` — operational data (logs, KPIs, counters, sku notes, sales insights, closed days)
- `auth/*` — auth + sync state (users, roles, sync history, pending items, activity)

### Operational data paths

| Path | Purpose |
|---|---|
| `ops_data/opsHub_log` | Daily log entries by date |
| `ops_data/opsHub_kpi` | KPI values |
| `ops_data/opsHub_targets` | KPI + goal targets |
| `ops_data/opsHub_submitted` | Submit-state flags (locks days) |
| `ops_data/opsHub_roster` | Schedule roster |
| `ops_data/opsHub_shifts` | Schedule shifts |
| `ops_data/opsHub_counters_{YYYY-MM-DD}` | Per-day Quick Count counters |
| `ops_data/opsHub_skuNotes_{YYYY-MM-DD}` | Per-day SKU notes (unified Daily Log + Quick Count) |
| `ops_data/opsHub_closedDays/{YYYY-MM-DD}` | Admin-flagged closed dates (Phase: Bundle of 4) |
| `ops_data/salesInsights/orders/{order_id}` | Per-order cache for pool sales |
| `ops_data/salesInsights/repTotals/{rep}/{period_id}` | Pre-aggregated rep rollups |
| `ops_data/salesInsights/quarterly/{rep}/{quarter_id}` | Quarterly threshold progress |
| `ops_data/salesInsights/hours/{rep}/{period_id}` | Manual hours entry per pay period (Phase 1A.2 pending) |
| `ops_data/salesInsights/consignr/inventory/{sku}` | Consignr cost data (Phase 1A.2 pending) |
| `ops_data/salesInsights/syncMeta/lastShopifySync` | Cache freshness timestamp |
| `ops_data/salesInsights/syncMeta/lastConsignrSync` | Cache freshness (Phase 1A.2 pending) |
| `ops_data/salesInsights/syncMeta/lastHoursSync` | Cache freshness (Phase 1A.2 pending) |

### Auth paths

| Path | Purpose |
|---|---|
| `auth/users/{uid}` | User profile + role flags |
| `auth/roles/{roleName}` | Role definitions |
| `auth/syncHistory/{YYYY-MM-DD}` | Shopify sync output per date |
| `auth/pendingItems/{order_id}` | Orders moved to pending |
| `auth/todaysQueueCache/{YYYY-MM-DD}` | 5-min cache for Today's Queue |
| `auth/activity/{ts}` | Activity log entries |
| `auth/syncErrors/{ts}` | Sync failure log |

---

## Permission System (FEATURE_REGISTRY)

Found in `index.html` around line ~5335. Flat list of `{ id, label, section }` entries.

### Current 25 flags

**Navigation (5):**
- `tab_dailylog` — Daily Log tab
- `tab_todaysqueue` — Today's Shipping Queue tab
- `tab_quickcount` — Quick Count tab
- `tab_kpis` — KPIs tab
- `tab_sales_insights` — Sales Insights tab (Phase 1A.1)

**Daily Log (8):**
- `log_inv_mgr` — Inventory Morning section
- `log_inv_lead` — Inventory Closing section
- `log_shp_mgr` — Shipping Morning section
- `log_shp_lead` — Shipping Closing section
- `log_schedule` — Schedule section
- `log_sync_review` — Sync Review section (manual sync + late tools)
- `log_pending_panel` — Pending Orders panel
- `log_sku_notes` — Log Specific Items SKU notes panel

**Quick Count (1):**
- `qc_all` — Quick Count counters

**KPI Trackers (3):**
- `kpi_view` — View KPI values
- `kpi_edit` — Edit KPI values and targets
- `kpi_people_process` — People & Process KPI section

**History (5):**
- `history_view` — Past Weeks history
- `week_glance` — Week at a Glance cards
- `week_glance_popup` — Week at a Glance interactive popup
- `glance_set_goals` — Goal-setter ⚙ icon in popup
- `activity_log` — Activity log tab

**Sales Insights (3, Phase 1A.1):**
- `sales_insights_view_own` — see own data only
- `sales_insights_view_all` — see all reps + Pool tab
- `sales_insights_admin` — refresh + hours upload + manual sync

### Permission helpers

- `isAdminEmail(email)` — checks if user is hardcoded admin (Nelson, Matts)
- `userHasPerm(profile, flagId)` — returns true if admin OR flag set on user
- All gated UI uses `userHasPerm(userProfile, "flag_id")` pattern

---

## Build History (Phases shipped to date)

### Earlier session items (21 items, multiple sessions before structured phasing)
- Tab swap (Daily Log → Quick Count → Today's Queue → KPIs → Admin → Activity)
- F3 Week-Glance modal with portal/scroll fix
- SkuNoteEntry collapse
- Payment gate strict
- Y/N sibling buttons in Sync Review
- Late Shipments live listener
- Pending Orders rebrand
- Saturday $5k order skip
- Evereye tag full cleanup
- "Not Late" button with `manuallyShipped` Firebase array
- Auto-flip `on_time` Y when late count = 0
- 5pm late cutoff (was 3pm)
- Sunday hide on_time + actually_shipped
- Sunday excluded from weekly sums + Y/N streak auto-pass
- Range switcher in popup (8 ranges + Custom)
- All-counter SKU notes in Quick Count
- Unified SKU notes storage (`log_<fieldKey>`)
- Order # field
- Cross-date SKU notes load in Daily Log
- Modal scroll fix (multiple iterations)

### Phase 1 — Percentages on cards
- Pair percentages on Overview cards
- Green/amber/red color coding
- Last Month pill in WGM_RANGES
- `wgmComputePairPct` helper
- Pair config on WGM_OVERVIEW_FIELDS

### Phase 2 — Goal-setter
- ⚙ Gear icon on 5 specific cards
- WGM_GOAL_KEYS config (Pkgs Received, Orders Eligible, Same-Day Recv Rate, Same-Day Ship Rate, Ship-Through Rate)
- Inline editor → writes to `opsHub_targets`
- Goals scale by non-Sunday day count
- Side-by-side display of % of goal AND pair %
- Renders rate cards in modal Overview

### Phase 3a — Custom date range picker
- New `DateRangePicker` component with `mode` prop (single/range)
- Native HTML date inputs, 365-day cap with warning, auto-swap, max=today
- `WGMRangeContext` for hybrid sharing (Mode 3: WAG popup + Past Weeks)
- Daily Log "Jump to date" button (single-date, independent)
- Past Weeks "Jump to date" button with auto-expand matching week
- Custom pill added to WGM_RANGES (10 total)

### Permissions Phase 1 — 5 new flags
- `log_sync_review`, `log_pending_panel`, `log_sku_notes`, `glance_set_goals`, `kpi_people_process`
- All default OFF for non-admins
- Admins always pass via `isAdminEmail`
- Threaded `userProfile` through SkuNotesPanel, WeekGlanceModal, TrackerPage, KPIsTab

### Sales Insights Phase 1A.1 — Backend foundation
- Extended `shopify-sync.js` + `shopify-sync-scheduled.js` with POOL SRLA detection + caching
- 14-day rolling re-aggregation window
- Pool distribution math: hours-weighted among Yoni/Leanna/Lillie only
- Per-rep aggregations: `personal_net`, `pool_share_net`, `threshold_progress`
- Quarterly threshold tracker ($250k / 90 calendar days)
- Reduced rate logic (4% → 3% if threshold missed)
- 4 new permission flags added
- Customer attribution: name match (first-word normalized)
- Brandon Love name mismatch concept applied
- Refunds subtract from pool total before distribution
- **No UI yet** — Phase 1B builds the tab

### Bundle of 4 (most recent build)

**Item 1 — Sunday-exclude inv_pkgs_received**
- Added to `SUNDAY_SKIP_KEYS` and `WGM_SUNDAY_SKIP_KEYS`
- Receiving count no longer drags down weekly averages with Sunday zeros

**Item 2 — Tiered Items Unsorted field**
- Tier picker with 6 options: `0`, `<5`, `<15`, `<25`, `<50`, `50+`
- Storage: tier label as string
- Math: midpoint values (0, 2.5, 10, 20, 37.5, 60)
- Mixed-format normalizer handles legacy raw numbers
- New `TierPicker` component
- `TIER_MIDPOINTS` / `TIER_LABELS` / `tierToNumber` / `tierToLabel` helpers
- Field type `"tier"` added to render branch

**Item 3 — Mark day as closed**
- Admin-only ⛔ "Mark closed" button (today + future dates only)
- Firebase path: `ops_data/opsHub_closedDays/{YYYY-MM-DD}` with `{marked_by, marked_at, reason}`
- Day picker shows "closed" indicator + "🚫 Store Closed" badge
- Closed days: fields locked, excluded from `wkSum`, `wkYnKey`, `wgmSumKey`, `wgmYnKey`
- Y/N streaks: closed days removed from denominator
- Confirmation dialog before mark/reopen
- "✅ Reopen day" button to undo
- Admin Panel "Closed Days" dedicated section — DEFERRED (not built, only Daily Log button)

**Item 4 — Sticky date footer**
- Fixed dark translucent bar at bottom of screen
- Appears after scrolling past day-picker (scroll listener + ref)
- Shows: date · section context · 🔒 Locked / 🔓 Editable / 🚫 Closed
- Admin lock toggle 🔓 Unlock / 🔒 Lock — same behavior as bottom Edit button
- Respects iOS `safe-area-inset-bottom`

---

## Pending Work Queue

### High-priority deferred items (with locked specs ready to build)

**Saturday $5k rule rewrite** — 5 questions outstanding
- Current rule: $5k+ orders on Saturday completely skipped from eligible list
- New rule: $5k+ orders on Saturday should be PACKED + LABELED but HELD until next business day (insurance policy requires next-day delivery)
- FedEx orders (>$5k via FedEx overnight) need visual separation
- Questions pending: where in queue, counter treatment, trigger days, FedEx flag scope, phasing

**Green Orders + On Time review dropdowns** — 5 questions outstanding
- Add clickable review UI showing which orders system classified as green/on-time
- Override buttons (similar pattern to existing "Not Late")
- Per-order override flags vs. just override Y/N

**Phase 1A.2 (Sales Insights — Consignr + Hours upload)** — 80% spec'd
- New: `consignr-sync-scheduled.js` (background function, 15-min cron)
- New: `consignr-sync.js` (manual trigger)
- New: `hours-upload.js` (manual hours entry endpoint)
- Hours format: per-pay-period total (rep, period_start, period_end, total_hours)
- Hours distribution: even split across all days in pay period
- Consignr API: `https://api.consignr.app/v1/api/`, `x-api-key` header, OpenAPI spec captured
- Statuses to sync: ACTIVE + HOLD + SOLD
- Env var needed: `CONSIGNR_API_KEY`
- Watch identification: Consignr item.product.category === "watch"

**Phase 1B (Sales Insights UI)** — after 1A.2 ships
- Sales Insights tab UI shell
- 7 must-have metrics for rep view
- Admin overview with rep selector
- Net/gross toggle
- Cache freshness indicator
- All permission gating

### Lower-priority deferred items

**Phase 3b — Quick Count + Activity date pickers**
- Add date picker to Quick Count and Activity log
- Same component reused from Phase 3a

**Domain permissions restructure**
- Add `domain` field to FEATURE_REGISTRY entries
- Group Admin Panel by domain (ops / analytics / sales / admin)
- Wait until Sales features land first

**Admin Panel "Closed Days" section**
- Dedicated bulk-edit view for closed dates
- Currently the in-Daily-Log button covers operational need

---

## Outstanding Action Items (Nelson)

### Netlify Support Ticket (drafted but not sent as of last session)

Email Netlify support requesting 26-second function timeout enable for 3 sites:
- `srlaopshub.netlify.app` (function timeouts on Sales Insights + Consignr syncs)
- `incomingtory.netlify.app` (file upload timeouts blocking the receiving workflow)
- `srlasales.netlify.app` (Shopify order detail + customer history lookups)

**Important:** Even on Netlify Pro plan, the 26s timeout requires manual support enablement per-site. The TOML config alone doesn't activate it.

Draft email template available — see chat history (turn ~"draft an email for me to send").

### Environment Variables to Set (when Phase 1A.2 ships)

- `CONSIGNR_API_KEY` — get from Consignr Settings → Integrations → API Keys

---

## Conventions & Patterns

### Code style

- All functions use try/catch with Firebase fallbacks (Rule 15)
- Permission checks always use `userHasPerm(userProfile, flag_id)` (admin bypass built-in)
- Field renders branch by `field.type` ("yn", "count", "tier", "note")
- Sunday handling: keys in `SUNDAY_SKIP_KEYS` excluded from sums; keys in `SUNDAY_AUTOPASS_YN_KEYS` auto-pass for streaks
- Closed-day handling: dates in `closedDays` Set excluded from all week math, fields locked, day-picker dimmed

### Naming conventions

- Components: PascalCase (`DailyLogPage`, `WeekGlanceModal`)
- Helper functions: camelCase (`wgmSumKey`, `wgmYnKey`, `tierToNumber`)
- Constants: SCREAMING_SNAKE_CASE (`SUNDAY_SKIP_KEYS`, `WGM_OVERVIEW_FIELDS`, `TIER_MIDPOINTS`)
- Firebase paths: snake_case (`opsHub_log`, `opsHub_skuNotes_2026-05-19`)
- Feature flags: snake_case (`log_sync_review`, `tab_sales_insights`)

### Folder lowercase requirement

All folder names in repo MUST be lowercase. Netlify Linux build is case-sensitive — uppercase folder names will fail builds.

### Working file workflow (Claude desktop chat era)

- Working file at `/home/claude/ops-hub-final/` per session
- Last shipped zip at `/mnt/user-data/outputs/ops-hub-final.zip`
- Always re-extract from last zip at session start (file system resets between sessions)
- Final deploy = drag-and-drop folder to Netlify

**Going forward in Claude Code:**
- Repo is the source of truth
- `git pull` at session start
- Edit files in place
- Run tests / syntax checks locally
- `git commit` + `git push` triggers Netlify auto-deploy via the linked GitHub integration

---

## Sales Insights Pool Policy (Locked Rules)

From the Showroom LA Pooled Commission Policy (v1.0, May 19, 2026):

### What goes INTO the pool
- Sale was closed by anyone (rep, manager, owner) AND
- First contact was through a store-owned channel (story swipe-up, store DM, walk-in, company work phone, store-driven inbound) AND
- Order is tagged `POOL SRLA` (exact uppercase, with space) in Shopify

### What does NOT go into the pool
- Online store orders with no employee involvement
- Personal-channel-first contacts (rep's personal phone/DM before any store touch)
- Untagged orders (forfeited — not added retroactively)

### Who gets paid OUT (Sales Insights app rule)
- ONLY 3 sales reps: **Yoni, Leanna, Lillie**
- Per Nelson's clarification: management hours don't enter the denominator, management never receives pool payouts
- Note: the written policy doc shows broader eligibility but the app implements 3-reps-only per Nelson's direction

### Pool distribution math
```
For each day in the 14-day window:
  totalPool = sum of POOL SRLA tagged net sales that day (refunds subtracted)
  totalHours = sum of (Yoni + Leanna + Lillie hours that day)
  if totalHours <= 0: skip (zero-division guard)
  for each rep:
    repShare = totalPool × (repHours / totalHours)
    quarterlyTotal[rep] += repShare
```

### Commission rates
- Standard: 4% (default)
- Reduced: 3% if rep misses $250k quarterly threshold (90 calendar days)
- First-time client bonus: 5% — applies ONLY to individual sales (NOT pool sales)
- Rate source: hierarchical fallback (Commission Calc → Sales Insights config → memory defaults)

### Net sales definition (Phase 1A)
- Subtotal after refunds + discounts
- Excludes tax/shipping

### Tag is the record
- Case-insensitive match for `POOL SRLA` (handles `POOL SRLA`, `pool srla`, `Pool SRLA`)
- Untagged = doesn't count, no retroactive additions per policy
- 14-day rolling re-aggregation window handles human delay in tagging

---

## Operational Rules Encoded in Sync Logic

### Saturday $5k rule (CURRENT — to be updated)

Orders ≥ $5,000 created on Saturday are currently excluded from eligible list entirely.

**Pending change** (queue item): Orders should appear in queue but flagged "Hold for Monday — FedEx" instead of being hidden.

### Late cutoff (5pm PT)

Orders not shipped by 5pm PT on the target date are classified as late.

### Eligibility cutoff (3pm PT)

Orders created after 3pm PT are eligible for next-day shipping, not same-day.

### Sunday exclusions (`SUNDAY_SKIP_KEYS`)

Current: `shp_actually_shipped`, `shp_on_time`, `inv_pkgs_received`

### Sunday auto-pass for Y/N streaks (`SUNDAY_AUTOPASS_YN_KEYS`)

Current: `inv_location_ok`, `inv_eod_sort`, `shp_green_packed`, `shp_on_time`

### Payment gate

Orders must have `financial_status === 'paid'` OR `'authorized'` to be eligible.

### Riskified handling

Riskified tags (e.g. `riskified::approved`) are processed but don't affect pool detection.

### Brandon Love name normalization

Rep names normalized to first word (e.g. "Brandon Love" → "Brandon", "Yoni Messay" → "Yoni"). Applied in Shopify rep identification.

---

## Testing & Verification

### Syntax check (run after every edit)

```bash
# Extract JS from index.html and validate
python3 -c "
import re
with open('index.html','r') as f: html = f.read()
scripts = re.findall(r'<script[^>]*>(.*?)</script>', html, re.DOTALL)
biggest = max(scripts, key=len)
with open('/tmp/check.js','w') as f: f.write(biggest)
"
node --check /tmp/check.js

# Function syntax
node --check netlify/functions/shopify-sync.js
node --check netlify/functions/shopify-sync-scheduled.js
node --check netlify/functions/todays-queue.js
```

### Manual smoke tests (post-deploy)

1. Open Daily Log → click any card → modal opens cleanly
2. Switch range pills → metrics recalculate
3. Quick Count → counter increment → check Daily Log autofill
4. Today's Shipping Queue → live data loads
5. Admin Panel → role editor displays all 25 flags
6. Mark a future date closed → reopen Daily Log → confirm field lock
7. Scroll past day picker → sticky footer appears at bottom

---

## Deploy Process

### Current (drag-and-drop)
1. Get zip from Claude
2. Unzip
3. Drag folder to Netlify dashboard for `srlaopshub` site
4. Re-add iPhone home screen icon if user changed

### Target (Claude Code + GitHub)
1. Claude Code edits files in repo
2. Run syntax checks
3. `git commit -m "describe change"`
4. `git push origin main`
5. Netlify auto-deploys via GitHub integration
6. Monitor build log for any issues

---

## Memory Triggers (existing in user memory)

Memory file already includes:
- Master Ruleset 1-20 + Prompt Engineering Rules
- Recall phrase `show me my master ruleset`
- SRLA Sales deploy command for separate Sales app
- SRLA logo variants
- Deferred items list

When starting fresh Claude Code sessions, those should auto-load.

---

## Other Apps Under the SRLA Umbrella

Mentioned in chat history for context (NOT part of Ops Hub repo):

| App | URL | Repo | Firebase Project | Purpose |
|---|---|---|---|---|
| Ops Hub | srlaopshub.netlify.app | this repo | ops-hub-1122d | This codebase |
| SRLA Sales Rotation | srlasales.netlify.app | nelsonsrla/srla-sales-rotation | sales-rotation-44d0d | Lead assignment + Shopify integration |
| Commission Calculator | srlacommission.netlify.app | (separate) | (separate) | Pool + individual commission math |
| Incoming Tory | incomingtory.netlify.app | nelsonsrla/incomingtory | (separate) | Inventory intake PWA |
| Nelly Finance | nelly-finance.netlify.app | (separate) | nelly-finance | Personal finance dashboard |
| NFL Popup Planner | (HTML tool, localStorage) | (separate) | n/a | Game day popup planning |

Each app is independently deployed. The "all apps under one roof" vision (mentioned in chat) is a future integration with shared permissions — not started yet.

---

## How to Pick Up Where We Left Off

### If you're me (Nelson), opening Claude Code

1. Clone the repo: `git clone <your-srlaopshub-repo>`
2. `cd srlaopshub` (or whatever the folder is called)
3. Open this README in Claude Code
4. Tell Claude: "Read README.md and the pending work queue. What's the next item?"
5. Pick one, lock the spec, build, test, commit, push.

### If you're a new Claude session

1. Read this README top to bottom
2. Read `index.html` structure (you can use grep for component definitions)
3. Read all 3 `netlify/functions/*.js` files
4. Check Firebase data via the URL in this doc if needed
5. Ask Nelson what he wants to tackle next from the pending queue

### Critical context to maintain

- Master Ruleset (Rules 1-20) governs all code changes — never skip
- Nelson approves spec BEFORE code, then BEFORE shipping
- No file commits without explicit approval
- No Firebase data changes without confirmation
- Everything in pending queue has specific outstanding questions — don't guess answers

---

## Quick Reference — Common Commands

### Search for things in the codebase

```bash
# Find a component
grep -n "const ComponentName = " index.html

# Find feature flag usage
grep -n "userHasPerm.*flag_id" index.html

# Find Firebase path usage
grep -n "ops_data/path_name" index.html

# Find all useState calls
grep -n "React.useState\|useState(" index.html

# Find permission flags
grep -A1 "FEATURE_REGISTRY = " index.html
```

### Test sync functions locally (with Netlify CLI)

```bash
netlify dev
# Then trigger via: curl http://localhost:8888/.netlify/functions/shopify-sync
```

### Deploy (when on GitHub auto-deploy)

```bash
git add -A
git commit -m "feat: short description of change"
git push origin main
# Netlify auto-deploys
```

---

## Closing Notes

**Owner:** Nelson Johnson — primary decision-maker, sets all specs
**Stakeholders:** Matts Benson (CEO), the 11 SRLA employees who use this daily
**Constraint:** This tool runs real ops for a luxury resale business. Reliability > speed > features.

When in doubt:
- Ask Nelson (don't assume)
- Lock spec before code (Rule 5)
- Show diffs before applying (Rule 8)
- Run syntax checks (Rule 7, 12)
- Verify no data loss (Rule 6)

---

*End of handoff document. Total context preserved: all phases shipped, all decisions locked, all pending items spec'd or flagged. Ready to resume in Claude Code with no missing context.*
