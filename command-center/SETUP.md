# BDD Command Center — Setup

Phase 1 of the dashboard roadmap: Supply Orders + To-Dos, built the same way as the Payout Calculator (WP Custom HTML block + external JS + a small PHP API on the server).

## Files in this folder
- `bdd-supply-api.php` — backend. Handles both Supply Orders and To-Dos (`?resource=supply` / `?resource=todo`), stores data as JSON files, posts to Slack on new/updated supply requests.
- `bdd-dashboard.js` — frontend logic. Upload alongside the PHP file.
- `bdd-command-center-block.html.txt` — paste the contents into a WordPress Custom HTML block on a new page.

## Steps

1. **Pick a secret token.** Open `bdd-supply-api.php` and replace `CHANGE_ME_NEW_SECRET_2026` (in `define('BDD_SUPPLY_SECRET', ...)`) with a new random string — don't reuse the Payout Calculator's token. Then open `bdd-dashboard.js` and set the same string in `var TOKEN = ...` near the top.

2. **Upload to the server** (same place `bdd-api.php` lives, e.g. `public_html/`):
   - `bdd-supply-api.php`
   - `bdd-dashboard.js`
   The PHP file will auto-create `bdd-supply.json` and `bdd-todos.json` next to itself the first time each is used.

3. **Create the WordPress page.**
   - New page, e.g. "Command Center."
   - **Restrict it to logged-in owners/managers** — either set the page visibility to "Private" (built-in WP option, visible to logged-in users with edit rights) or use a membership/role-restriction plugin if you want it visible-but-gated for specific roles. Don't leave it public — unlike the Payout Calculator, this page has an entry form that posts data.
   - **Page template:** use **Tool / Dashboard (Full Width)** (`template-tool-dashboard.php`, in the theme folder) — it's what gives the page the full-width layout instead of the narrow 760px reading column. Don't leave the template as Default, and you don't need to keep "Payout Calculator (Full Width)" selected either — the new one is a properly-named copy of the same thing. Upload `template-tool-dashboard.php` to the theme alongside the others first, then pick it from Page Attributes → Template.
   - Add a Custom HTML block, paste in the full contents of `bdd-command-center-block.html.txt`.
   - Fill in the real Payout Calculator page URL — search that pasted block for `PASTE-PAYOUT-CALCULATOR-URL-HERE` and replace it with the actual link (e.g. `/payout-calculator/`).
   - Confirm the `<script src="...bdd-dashboard.js?v=2">` URL matches where you uploaded the JS file. Bump `?v=` any time you re-upload an edited `bdd-dashboard.js` so browsers don't serve a cached copy.

4. **Set up Slack.**
   - Create a free Slack workspace (or use an existing one) with channels: `#springfield-ops`, `#riverside-ops`, `#leadership`, `#supply-orders`.
   - In Slack, add an **Incoming Webhook** app pointed at `#supply-orders` (Slack → search "Incoming Webhooks" → Add to Slack → pick the channel → copy the Webhook URL).
   - Paste that URL into `bdd-supply-api.php`'s `define('BDD_SLACK_WEBHOOK_URL', '')`. Leave it blank if you want to skip Slack notifications for now — the API works fine without it.

5. **Test it** (see the plan's Verification section):
   - Submit a test supply request for each location — confirm it shows up in the list and (if configured) posts to `#supply-orders`.
   - Walk one request through Requested → Ordered → Received using the "Mark ___" button, confirm the status badge and Slack update both look right.
   - Add a to-do in each of the three groups, mark one done, delete one.
   - Log out (or open an incognito window) and confirm the WordPress page itself isn't reachable without logging in.

## Phase 2 — File & approve supply requests without leaving Slack
`bdd-slack.php` adds: typing `/supply-request` in **#supply-orders** opens a form in Slack; submitting it posts an Approve / Edit / Deny card into **#leadership**. It reads and writes the exact same `bdd-supply.json` the dashboard uses — both stay in sync either way something gets created or changed.

**Note on scope:** this only covers requests *filed through Slack*. A request filed through the web dashboard still posts the plain notification to #supply-orders like before (Phase 1), but does **not** get a leadership approval card — only Slack-filed ones do. Say the word if you want those unified later.

**Note on "Deny":** a denied request is deleted outright (not kept anywhere with a "Denied" status) — simplest option, but it does mean there's no record of it afterward. Ask if you'd rather it stay visible with a "Denied" badge instead; that's a bigger change since the dashboard would need to know about a status beyond Requested/Ordered/Received.

### Setup
1. **Upload `bdd-slack.php`** to `public_html/` (same place as the other two PHP files).
2. In your Slack app (api.slack.com/apps → the BDD app from Phase 1):
   - **Slash Commands** → Create New Command:
     - Command: `/supply-request`
     - Request URL: `https://example.com/bdd-slack.php`
     - Short description: "File a supply request"
   - **Interactivity & Shortcuts** → toggle on → Request URL: same URL, `https://example.com/bdd-slack.php`
   - **OAuth & Permissions** → under **Bot Token Scopes**, add: `commands`, `chat:write`, `chat:write.public`
   - Still on OAuth & Permissions, click **(Re)install to Workspace**, approve it, then copy the **Bot User OAuth Token** (starts `xoxb-...`)
   - **Basic Information** → **App Credentials** → copy the **Signing Secret**
3. **Get the two channel IDs:** in Slack, right-click **#supply-orders** → View channel details → the ID is at the bottom (or in "Copy link" — it's the last part of that URL). Do the same for **#leadership**.
4. **Get each person's Slack member ID:** click their name/profile in Slack → "..." More → Copy member ID. You need this for Jordan, Avery, Harlan, and Sawyer.
5. Open `bdd-slack.php` and fill in the placeholders near the top: `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_SUPPLY_ORDERS_CHANNEL`, `SLACK_LEADERSHIP_CHANNEL`, and the four `PASTE_..._SLACK_ID` keys in `$BDD_SLACK_PEOPLE`. Re-upload the file.
6. **Test:** in #supply-orders, type `/supply-request`, fill out the form, submit. You should see a confirmation in #supply-orders and a card with three buttons in #leadership. Click **Approve** — the card should update to show who approved it, and a follow-up should post in #supply-orders. Try **Edit** and **Deny** too. Confirm the request (or its removal, for Deny) shows correctly on the dashboard as well.

## Phase 3 — Unify: dashboard-filed requests also go to #leadership
Now a request filed through the **web dashboard** (not just Slack) also posts the Approve/Edit/Deny card to #leadership, and if someone advances its status on the dashboard, that Slack card updates to match — so it never sits there showing stale buttons.

No new Slack app setup needed — this reuses the same Bot Token and #leadership channel ID from Phase 2.

1. Open `bdd-supply-api.php` and fill in near the top:
   - `BDD_SLACK_BOT_TOKEN` — same `xoxb-...` token you got from Phase 2
   - `BDD_SLACK_LEADERSHIP_CHANNEL` — same #leadership channel ID from Phase 2
2. Re-upload `bdd-supply-api.php` to `public_html/`.
3. **Test:** file a request from the dashboard itself (not Slack) — confirm a card shows up in #leadership with buttons, same as a Slack-filed one. Click Approve on it, or advance its status on the dashboard, and confirm the card updates to show it's resolved either way.

## Phase 4 — Inventory module + daily digest + weekly payout summary

Three additions:
- **Inventory module** — a third section in the Command Center (Supply Orders / To-Dos / Inventory), same pattern as the other two. Live item list with per-item quantity + status (Good / Almost Out / Out), grouped by category. Adds a "Low Stock" count to the hero stats. Replaces the standalone `Operations/Inventory/Inventory.csv`.
- **`bdd-digest.php`** — cron script, posts a morning summary to #leadership: this-week net profit, open supply requests, open to-dos (overdue called out), low-stock items.
- **`bdd-weekly-payout.php`** — cron script, posts *last full week's* net profit / revenue / tips / per-person payouts to an owners-only channel.

### 4a. Inventory module
1. Re-upload **`bdd-supply-api.php`** (now also handles `?resource=inventory`), **`bdd-dashboard.js`**, and upload **`bdd-inventory.json`** — all to `public_html/`. `bdd-inventory.json` is pre-seeded from your current CSV; the server only creates an empty one if it's missing, so uploading the seeded file is what gets your real list in.
2. In WordPress, re-paste the updated **`bdd-command-center-block.html.txt`** into the Command Center page's Custom HTML block (the script tag is now `?v=3`).
3. **Test:** the Inventory section should show your items grouped by category; change a qty and a status inline and confirm they stick on reload; confirm the "Low Stock" hero number matches the count of non-Good items.
4. From here, manage stock in the dashboard — `Operations/Inventory/Inventory.csv` on your Mac is now just a historical copy.

### 4b. Slack channel for the weekly payout
1. In Slack, create a **private** channel `#owners`, invite only Jordan and Avery.
2. Invite the bot to it: in `#owners`, type `/invite @BDD Command Center` (or whatever your app is named).
3. Get the channel ID (channel name at top → scroll down → Channel ID).
4. Open `bdd-weekly-payout.php`, paste that ID into `BDD_PAYOUT_CHANNEL`, and change `BDD_PAYOUT_KEY` to any random string. Upload it to `public_html/`.

### 4c. Cron script keys
Open `bdd-digest.php`, change `BDD_DIGEST_KEY` to any random string (only used if you ever test it from a browser). Upload it to `public_html/`.

### 4d. Set up the two Hostinger cron jobs
hPanel → **Cron Jobs** → Add new. Use the **PHP** type and point each at the file's full server path (something like `/home/uXXXXXXXXX/domains/example.com/public_html/bdd-digest.php` — the File Manager shows the full path).

- **Daily digest** — runs every day. Cron times are **UTC**, so for a 7:00 AM Eastern post use `0 11 * * *` (11:00 UTC ≈ 7 AM EDT / 6 AM EST — adjust the hour by 1 in winter if you care). Script: `bdd-digest.php`
- **Weekly payout** — runs once a week. For Monday 8:00 AM Eastern use `0 12 * * 1` (12:00 UTC Monday). Script: `bdd-weekly-payout.php`

**(Tell me your preferred times and I'll give you the exact cron expressions.)**

### 4e. Test the cron scripts without waiting
Each script can be run once from a browser using its key:
- `https://example.com/bdd-digest.php?key=YOUR_DIGEST_KEY` → should post the digest to #leadership immediately
- `https://example.com/bdd-weekly-payout.php?key=YOUR_PAYOUT_KEY` → should post the summary to #owners
If either says "failed", it's almost always the bot not being a member of that channel, or a wrong channel ID.

## Phase 5 — `/stock` + `/inventory` slash commands, low-stock ping, spreadsheet view

Adds a second slash command to `bdd-slack.php`: **`/stock`** opens a small form —
**Product** (dropdown of your inventory items, grouped by category), **Status**
(Good / Almost Out / Out), **Amount on hand** (optional) — and updates that item
in `bdd-inventory.json` (the same file the dashboard and digest use).

When an update sets an item to **Almost Out** or **Out**, a ping is posted to
**#supply-orders**. Setting an item back to **Good** just closes the form, no ping.
Trigger statuses are the `$STOCK_ALERT_STATUSES` array near the top of
`bdd-slack.php` — add `'Good'` there to echo every update.

Also adds **`/inventory`** — a read-only command that prints the current picture
privately (only you see it): item count, how many are out / almost out, and the
names of every Out and Almost-Out item. Works in any channel or DM.

And the Command Center's **Inventory section is now a spreadsheet** — one
full-width table, every row colour-coded by status (green = Good, amber = Almost
Out, red = Out), click any column heading to sort (defaults to problems-first),
Qty / Status / Notes all edit inline. Same `bdd-inventory.json` behind it.

No AI / API key involved — the commands are plain forms/reads like `/supply-request`.

### Setup
1. **Re-upload three files** to `public_html/`:
   - `bdd-slack.php`  (adds `/stock` + `/inventory`)
   - `bdd-dashboard.js`  (spreadsheet Inventory view — script tag is now `?v=4`)
   - make sure `bdd-inventory.json` is already up there (Phase 4a) — the `/stock`
     dropdown and `/inventory` list read from it
2. In WordPress, re-paste **`bdd-command-center-block.html.txt`** into the Command
   Center page's Custom HTML block (updated Inventory CSS + `?v=4` script tag).
3. In the Slack app (api.slack.com/apps → the BDD app) → **Slash Commands** →
   **Create New Command**, once for each:
   - `/stock` — Request URL `https://example.com/bdd-slack.php`,
     description "Update an inventory stock level", hint `pick a product and its status`
   - `/inventory` — same Request URL, description "Show current stock levels"
   - Save. No new scopes, no re-install needed.
4. `STOCK_ALERT_CHANNEL` near the top of `bdd-slack.php` defaults to #supply-orders
   (`C0EXAMPLE002`). Change it if you want the ping somewhere else.
5. **Test:**
   - `/stock` in any channel → pick an item → set **Out** → Save. Confirm it flips
     to Out on the dashboard spreadsheet (row turns red) and a 🚨 ping lands in
     #supply-orders. Set it back to **Good** and confirm no ping.
   - `/inventory` → confirm you get the private summary with that item listed.
   - On the Command Center, click the **Status** and **Qty** column headers to
     re-sort; edit a qty inline and reload to confirm it stuck.

**Who can use it:** anyone whose Slack ID is in `$BDD_SLACK_PEOPLE` (the 4
owners + managers). Trim that map if you want it narrower.

**Note:** the dropdown holds up to 100 items. If the inventory list ever grows
past that, the Product picker would need to switch to a search-as-you-type field.

## Phase 6 — `/book`: book LatePoint appointments from Slack

Type **`/book`** in **#springfield-ops** or **#riverside-ops** → a form opens with the
location already set by the channel (anywhere else, it asks for the location).

- **Service → Date → Detailer → Time.** The Time list is LatePoint's real open
  slots for that exact service/location/detailer/day, and refreshes when you
  change any of them. "Any available detailer" uses LatePoint's own assignment rule.
- **Owners (Jordan, Avery)** also get *Owner override* + a custom time picker to
  book outside the schedule. Change who in `$BOOK_OVERRIDE_ALLOWED` in `bdd-book.php`.
- **Customer:** type 2+ letters of a name, email or phone to pick an existing
  customer — or leave it empty and fill in a new one (first name + email or
  phone). New customers get a LatePoint account. If the email already exists,
  it books that customer instead of making a duplicate.
- **Required fields** come straight from LatePoint → Settings → Custom Fields
  (customer + booking). File-upload fields can't be done from Slack and are
  listed as "add in LatePoint".
- On **Book it**, the booking is created exactly like LatePoint's admin "New
  Order" form — so the customer gets LatePoint's normal confirmation — and a
  summary posts in the channel. If anything fails you get a DM and nothing is booked.

Who can use it: anyone in `$BDD_SLACK_PEOPLE` (bdd-slack.php).

### Setup
1. **Upload to `public_html/`** (same folder as WordPress's `wp-load.php`):
   - `bdd-book.php` (new)
   - `bdd-slack.php` (routes /book)
2. Slack app (api.slack.com/apps → BDD app):
   - **Slash Commands → Create New Command:** `/book` — Request URL
     `https://example.com/bdd-slack.php`, description "Book a LatePoint appointment".
   - **Interactivity & Shortcuts → Select Menus → Options Load URL:**
     `https://example.com/bdd-slack.php` → **Save Changes**.
     (This powers the customer search box. Interactivity itself is already on.)
   - No new scopes needed.
3. If `#springfield-ops` / `#riverside-ops` are **private**, `/invite @BDD Command Center`
   in each so the booking summary can post there (otherwise it DMs you instead).
4. **Test** in #springfield-ops: `/book` → pick a service → confirm times appear →
   change the date and watch them refresh → search an existing customer →
   **Book it**. Check the booking in LatePoint and that the customer got the
   confirmation email. Then test a **new customer**, and (as an owner) an
   **override** outside open hours.

## Phase 7 — Separate Springfield (SPR) and Riverside (RIV) inventory

Every inventory item now belongs to a location. `bdd-inventory.json` holds each
item twice — once per location (ids `spr-…` / `riv-…`) — and was reset to
**Out, qty 0** for everything so both locations can be counted from scratch.

- **Command Center:** the **SPR | RIV** switch (Restock Board header + Inventory
  header) picks which location's stock you see; the browser remembers your pick.
  Adding an item asks for Springfield, Riverside, or Both. "Request" / bulk requests
  file the supply request for that location. Hero "Low Stock" shows both: `SPR x · RIV y`.
- **Slack:** `/stock` and `/inventory` use the channel (#springfield-ops / #riverside-ops)
  or what you type after them — `/stock riv`, `/inventory spr`. Elsewhere, `/stock`
  asks for the location first and `/inventory` shows both. Low-stock pings and the
  daily digest are tagged SPR / RIV.

### Setup
1. Upload to `public_html/`, replacing the old ones — **`bdd-dashboard.js` first**:
   `bdd-dashboard.js`, `bdd-slack.php`, `bdd-digest.php`.
   ⚠️ **Do NOT upload `bdd-inventory.json`** — the live inventory is managed from the dashboard
   and Slack now. (2026-09-11: the Riverside items were added straight onto the live list via the
   API; Springfield kept its real counts. Uploading the local file would overwrite live stock.)
2. Re-paste `bdd-command-center-block.html.txt` into the Command Center page (script is now `?v=8`).
3. Count stock: switch to SPR, walk the Restock Board setting each item's status + qty; repeat for RIV.

## Phase 8 — Springfield / Riverside everywhere (colors + separate data)

Brand board: **Springfield = Diamond Ice `#7FD8E8`** (default) · **Riverside = Forge Copper `#E8B27F`** ·
Steel `#9CA3AC` · Onyx `#0B0D10` · Diamond White `#F7F8FA`. Warnings are now yellow `#F2CC4B`
so they never blend with copper.

- **Command Center:** location bar at the top (Springfield, IL | Riverside, CA) switches the WHOLE
  page — colors, supply requests (new ones are filed for that location), to-dos (that location +
  Leadership), inventory/restock board and the top stats.
- **Payout Calculator:** Springfield, IL | Riverside, CA | **Both** (combined stats, steel accent).
  Every job is saved with a location (existing jobs = Springfield); New Job + Edit have a Location
  picker to move a job. In Both view each job card shows a SPR/RIV tag.
- The choice is shared: switching in one tool opens the other on the same location.
- `/payout` in Slack tags each job SPR / RIV.

### Setup (upload the JS files FIRST, then paste the blocks)
1. Upload to `public_html/`, replacing: `bdd-dashboard.js`, `bdd-slack.php`, and the calculator's
   `Tools/Payout Calculator/bdd-calc.js` (same name on the server).
2. Re-paste `bdd-command-center-block.html.txt` (script `?v=9`) into the Command Center page, and
   `Tools/Payout Calculator/bdd-wordpress-block.html.txt` (script `?v=8`) into the Payout Calculator page.

## The hero stats (Net Profit / Jobs This Week)
These are pulled **read-only** straight from the Payout Calculator's own API (`bdd-api.php`) — nothing here ever writes back to it. `bdd-dashboard.js` has its own copy of the Payout Calculator's API URL + token near the top (`PAYOUT_API` / `PAYOUT_TOKEN`) so it can make that read. **If you ever rotate the Payout Calculator's token in `bdd-calc-v7.js`, update it here too** or the hero stats will silently show "—".

## What's intentionally not built yet
Per the roadmap (`~/.claude/plans/okay-snoopy-conway.md`), the Command Center aggregation page (today's jobs from LatePoint + a combined snapshot view) is Phase 3, after this Supply Orders + To-Do module is live and in use. The item dropdown in the Supply Orders form is a hand-copied snapshot of `Operations/Inventory/Inventory.csv` — it doesn't read the spreadsheet live, so update `ITEM_CATALOG` in `bdd-dashboard.js` if the real inventory list changes materially. A few near-duplicate rows (e.g. the three "Paint Drying Rag" sizes, the two rag types at the bottom) were merged into single entries to keep the dropdown short — use "Other" to name a specific variant if that matters for a given request.
