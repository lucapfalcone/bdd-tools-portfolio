<?php
// ============================================================
//  BDD Command Center — Slack integration
//  Upload to: public_html/bdd-slack.php
//
//  Handles:
//   - /supply-request slash command (used in #supply-orders) — opens a
//     modal, creates a request, posts an Approve/Edit/Deny card to #leadership
//   - Button clicks + modal submissions from that card
//   - /stock (update an inventory item) and /inventory (private stock summary)
//   - /payout (owners only) — private list of every job NOT marked Paid Out in
//     the Payout Calculator, with per-person pay + tip shares
//   - /book — books a LatePoint appointment from Slack (lives in bdd-book.php,
//     which is only loaded for /book because it boots WordPress)
//
//  Reads + writes the SAME bdd-supply.json that bdd-supply-api.php (the
//  Command Center dashboard) uses. Deliberately self-contained rather than
//  sharing code with bdd-supply-api.php, matching how every BDD server file
//  here stands alone as a single upload.
// ============================================================

error_reporting(0);
ini_set('display_errors', 0);
define('BDD_SLACK_INCLUDE', true); // lets bdd-book.php know it was loaded from here, not hit directly

// ---- fill these in, see SETUP.md ----------------------------------
define('SLACK_SIGNING_SECRET', 'YOUR_SLACK_SIGNING_SECRET_HERE');
define('SLACK_BOT_TOKEN', 'xoxb-YOUR-SLACK-BOT-TOKEN-HERE'); // starts with xoxb-
define('SLACK_SUPPLY_ORDERS_CHANNEL', 'C0EXAMPLE002');
define('SLACK_LEADERSHIP_CHANNEL', 'C0EXAMPLE001');

// --- /stock (inventory) settings ---
// Where the low-stock ping is posted when /stock sets an item to a trigger status.
define('STOCK_ALERT_CHANNEL', 'C0EXAMPLE002'); // #supply-orders
// Post the ping only when an item is set to one of these. Add 'Good' if you
// want every /stock update echoed to the channel.
$STOCK_ALERT_STATUSES = ['Almost Out', 'Out'];

// --- /payout settings ---
// The Payout Calculator's job file (read-only here — /payout never writes to it).
define('PAYOUT_JOBS_FILE', __DIR__ . '/bdd-jobs.json');
// Only these person ids (from $BDD_SLACK_PEOPLE below) can run /payout.
$PAYOUT_ALLOWED = ['jordan', 'avery'];
// Display order for the per-person totals (matches the calculator's tracker).
$PAYOUT_ROSTER = ['Jordan', 'Avery', 'Harlan', 'Sawyer', 'Devon', 'Priya', 'Marco', 'Theo'];

// Slack member ID -> the same person id/label used in bdd-dashboard.js's PEOPLE list.
// Find a member ID: click their name in Slack -> "..." More -> Copy member ID.
$BDD_SLACK_PEOPLE = [
  'U0EXAMPLE001' => ['id' => 'jordan', 'label' => 'Jordan'],
  'U0EXAMPLE002'   => ['id' => 'avery',   'label' => 'Avery'],
  'U0EXAMPLE003'   => ['id' => 'harlan',   'label' => 'Harlan'],
  'U0EXAMPLE004'   => ['id' => 'sawyer',   'label' => 'Sawyer'],
];
// ---------------------------------------------------------------------

$SUPPLY_FILE = __DIR__ . '/bdd-supply.json';

// ---------------------------------------------------------------- data store
function bddLoad() {
  global $SUPPLY_FILE;
  if (!file_exists($SUPPLY_FILE)) return [];
  $data = json_decode(file_get_contents($SUPPLY_FILE), true);
  return is_array($data) ? $data : [];
}
function bddSave($records) {
  global $SUPPLY_FILE;
  file_put_contents($SUPPLY_FILE, json_encode(array_values($records), JSON_PRETTY_PRINT), LOCK_EX);
}
function bddFind($id) {
  foreach (bddLoad() as $r) { if ((string)$r['id'] === (string)$id) return $r; }
  return null;
}
function bddUpsert($record) {
  $records = bddLoad();
  $found = false;
  foreach ($records as &$r) {
    if ((string)$r['id'] === (string)$record['id']) { $r = $record; $found = true; break; }
  }
  unset($r);
  if (!$found) array_unshift($records, $record);
  bddSave($records);
}
function bddDelete($id) {
  $records = array_filter(bddLoad(), function($r) use ($id) { return (string)$r['id'] !== (string)$id; });
  bddSave(array_values($records));
}
function bddUid() { return str_replace('.', '', uniqid('', true)); }
function bddNow() { return gmdate('Y-m-d\TH:i:s') . '.000Z'; }

// ---------------------------------------------------------------- inventory store
// Same bdd-inventory.json the Command Center dashboard + digest use. Read/modify/
// write the whole file, matching how bddSave works above.
$INVENTORY_FILE = __DIR__ . '/bdd-inventory.json';
function invLoad() {
  global $INVENTORY_FILE;
  if (!file_exists($INVENTORY_FILE)) return [];
  $d = json_decode(file_get_contents($INVENTORY_FILE), true);
  return is_array($d) ? $d : [];
}
function invSave($records) {
  global $INVENTORY_FILE;
  file_put_contents($INVENTORY_FILE, json_encode(array_values($records), JSON_PRETTY_PRINT), LOCK_EX);
}
function invFind($id) {
  foreach (invLoad() as $r) { if ((string)$r['id'] === (string)$id) return $r; }
  return null;
}
function invUpsert($record) {
  $records = invLoad();
  foreach ($records as &$r) {
    if ((string)$r['id'] === (string)$record['id']) { $r = $record; break; }
  }
  unset($r);
  invSave($records);
}
// Inventory is kept per location — every item has 'location' => Springfield | Riverside.
// /stock and /inventory take the location from the text after the command
// (/stock riv, /inventory spr) or from the channel name (#springfield-ops / #riverside-ops).
$INV_LOCATIONS = ['Springfield' => ['spr', 'springfield'], 'Riverside' => ['riv', 'riverside']];
function invLocOf($r) { return $r['location'] ?? 'Springfield'; }
function invCode($loc) { return $loc === 'Riverside' ? 'RIV' : 'SPR'; }
function invLocationFrom($text, $channelName) {
  global $INV_LOCATIONS;
  $t = strtolower(trim((string)$text));
  $c = strtolower((string)$channelName);
  foreach ($INV_LOCATIONS as $loc => $keys) { if (in_array($t, $keys, true)) return $loc; }
  foreach ($INV_LOCATIONS as $loc => $keys) { if (strpos($c, $keys[1]) !== false) return $loc; }
  return '';
}
function invForLocation($loc) {
  return array_values(array_filter(invLoad(), function ($it) use ($loc) { return invLocOf($it) === $loc; }));
}
function invSummaryText($loc) {
  $items = invForLocation($loc);
  $head  = '*' . $loc . ' (' . invCode($loc) . ') inventory*';
  if (!$items) return $head . ' — no items yet.';
  $out = []; $low = []; $good = 0;
  foreach ($items as $it) {
    $s = $it['status'] ?? 'Good';
    if ($s === 'Out')            $out[] = $it;
    elseif ($s === 'Almost Out') $low[] = $it;
    else                         $good++;
  }
  $list = function ($rows) {
    $s = '';
    foreach (array_slice($rows, 0, 40) as $it) $s .= "\n• " . $it['name'] . '  _(' . ($it['category'] ?? '?') . ')_';
    if (count($rows) > 40) $s .= "\n_…and " . (count($rows) - 40) . ' more_';
    return $s;
  };
  $txt = $head . ' — ' . count($items) . ' items · ' . count($out) . ' out · ' . count($low) . ' almost out · ' . $good . ' good';
  if ($out) $txt .= "\n\n🚨 *Out:*" . $list($out);
  if ($low) $txt .= "\n\n⚠️ *Almost out:*" . $list($low);
  if (!$out && !$low) $txt .= "\n\nEverything's stocked. ✅";
  return $txt;
}

function personFor($slackUserId) {
  global $BDD_SLACK_PEOPLE;
  return isset($BDD_SLACK_PEOPLE[$slackUserId]) ? $BDD_SLACK_PEOPLE[$slackUserId] : null;
}

// ---------------------------------------------------------------- Slack Web API
function slackApi($method, $params) {
  $ctx = stream_context_create(['http' => [
    'method'  => 'POST',
    'header'  => "Content-Type: application/json\r\nAuthorization: Bearer " . SLACK_BOT_TOKEN . "\r\n",
    'content' => json_encode($params),
    'timeout' => 5,
    'ignore_errors' => true,
  ]]);
  $res = @file_get_contents('https://slack.com/api/' . $method, false, $ctx);
  return $res ? json_decode($res, true) : null;
}

// ---------------------------------------------------------------- request verification
// Confirms this request genuinely came from Slack. See Slack's "Verifying
// requests from Slack" docs — this is their documented algorithm.
$raw       = file_get_contents('php://input');
$timestamp = $_SERVER['HTTP_X_SLACK_REQUEST_TIMESTAMP'] ?? '';
$slackSig  = $_SERVER['HTTP_X_SLACK_SIGNATURE'] ?? '';

if (!$timestamp || abs(time() - (int)$timestamp) > 300) { http_response_code(400); exit; }
$base  = 'v0:' . $timestamp . ':' . $raw;
$mySig = 'v0=' . hash_hmac('sha256', $base, SLACK_SIGNING_SECRET);
if (!$slackSig || !hash_equals($mySig, $slackSig)) { http_response_code(401); exit; }

parse_str($raw, $post);

// ---------------------------------------------------------------- Block Kit builders
function itemModal($title, $initial = [], $privateMetadata = '') {
  $isEdit = ($title === 'Edit Supply Request');
  return [
    'type'             => 'modal',
    'callback_id'      => $isEdit ? 'bdd_edit_request' : 'bdd_new_request',
    'private_metadata' => $privateMetadata,
    'title'            => ['type' => 'plain_text', 'text' => $title],
    'submit'           => ['type' => 'plain_text', 'text' => $isEdit ? 'Save' : 'Send'],
    'close'            => ['type' => 'plain_text', 'text' => 'Cancel'],
    'blocks' => [
      [
        'type' => 'input', 'block_id' => 'location',
        'label' => ['type' => 'plain_text', 'text' => 'Location'],
        'element' => [
          'type' => 'static_select', 'action_id' => 'value',
          'initial_option' => [
            'text'  => ['type' => 'plain_text', 'text' => ($initial['location'] ?? 'Springfield')],
            'value' => ($initial['location'] ?? 'Springfield'),
          ],
          'options' => [
            ['text' => ['type' => 'plain_text', 'text' => 'Springfield'],   'value' => 'Springfield'],
            ['text' => ['type' => 'plain_text', 'text' => 'Riverside'], 'value' => 'Riverside'],
          ],
        ],
      ],
      [
        'type' => 'input', 'block_id' => 'item',
        'label' => ['type' => 'plain_text', 'text' => 'Item'],
        'element' => [
          'type' => 'plain_text_input', 'action_id' => 'value',
          'placeholder' => ['type' => 'plain_text', 'text' => 'e.g. VRP, Interior Brushes'],
          'initial_value' => $initial['item'] ?? '',
        ],
      ],
      [
        'type' => 'input', 'block_id' => 'qty',
        'label' => ['type' => 'plain_text', 'text' => 'Quantity'],
        'element' => [
          'type' => 'number_input', 'action_id' => 'value', 'is_decimal_allowed' => false,
          'initial_value' => (string)($initial['qty'] ?? 1),
        ],
      ],
      [
        'type' => 'input', 'block_id' => 'notes', 'optional' => true,
        'label' => ['type' => 'plain_text', 'text' => 'Notes'],
        'element' => [
          'type' => 'plain_text_input', 'action_id' => 'value', 'multiline' => true,
          'initial_value' => $initial['notes'] ?? '',
        ],
      ],
    ],
  ];
}

// /stock modal — pick a product, set its status, optionally set the amount.
// The product dropdown is built live from bdd-inventory.json, grouped by category.
function stockModal($loc = '', $withPicker = false) {
  $byCat = [];
  foreach (($loc !== '' ? invForLocation($loc) : []) as $it) {
    $cat = $it['category'] ?? 'Other';
    $byCat[$cat][] = $it;
  }
  $groups = [];
  foreach ($byCat as $cat => $items) {
    $opts = [];
    foreach ($items as $it) {
      $label = (string)$it['name'];
      if (strlen($label) > 75) $label = substr($label, 0, 72) . '...';
      $opts[] = ['text' => ['type' => 'plain_text', 'text' => $label], 'value' => (string)$it['id']];
    }
    if ($opts) $groups[] = ['label' => ['type' => 'plain_text', 'text' => substr($cat, 0, 75)], 'options' => $opts];
  }
  // Location: a picker when it couldn't be worked out from the channel/text, else a label.
  $top = [];
  if ($withPicker) {
    $locOpts = [];
    foreach (['Springfield', 'Riverside'] as $l) {
      $locOpts[] = ['text' => ['type' => 'plain_text', 'text' => $l . ' (' . invCode($l) . ')'], 'value' => $l];
    }
    $picker = ['type' => 'static_select', 'action_id' => 'stock_loc',
               'placeholder' => ['type' => 'plain_text', 'text' => 'Pick a location'], 'options' => $locOpts];
    foreach ($locOpts as $o) { if ($o['value'] === $loc) $picker['initial_option'] = $o; }
    $top[] = ['type' => 'input', 'block_id' => 'loc', 'dispatch_action' => true,
              'label' => ['type' => 'plain_text', 'text' => 'Location'], 'element' => $picker];
  } else {
    $top[] = ['type' => 'context', 'elements' => [['type' => 'mrkdwn', 'text' => '📍 *' . $loc . ' (' . invCode($loc) . ')* inventory']]];
  }
  if ($groups) {
    $top[] = [
      'type' => 'input', 'block_id' => 'product',
      'label' => ['type' => 'plain_text', 'text' => 'Product'],
      'element' => [
        'type' => 'static_select', 'action_id' => 'value',
        'placeholder' => ['type' => 'plain_text', 'text' => 'Pick an item'],
        'option_groups' => $groups,
      ],
    ];
  } else {
    $top[] = ['type' => 'context', 'elements' => [['type' => 'mrkdwn',
      'text' => $loc !== '' ? "No inventory items for {$loc} yet." : 'Pick a location to see its items.']]];
  }
  return [
    'type'             => 'modal',
    'callback_id'      => 'bdd_stock',
    'private_metadata' => json_encode(['loc' => $loc, 'picker' => $withPicker]),
    'title'            => ['type' => 'plain_text', 'text' => $loc !== '' ? 'Update Stock · ' . invCode($loc) : 'Update Stock'],
    'submit'           => ['type' => 'plain_text', 'text' => 'Save'],
    'close'            => ['type' => 'plain_text', 'text' => 'Cancel'],
    'blocks' => array_merge($top, [
      [
        'type' => 'input', 'block_id' => 'status',
        'label' => ['type' => 'plain_text', 'text' => 'Status'],
        'element' => [
          'type' => 'static_select', 'action_id' => 'value',
          'options' => [
            ['text' => ['type' => 'plain_text', 'text' => 'Good'],       'value' => 'Good'],
            ['text' => ['type' => 'plain_text', 'text' => 'Almost Out'], 'value' => 'Almost Out'],
            ['text' => ['type' => 'plain_text', 'text' => 'Out'],        'value' => 'Out'],
          ],
        ],
      ],
      [
        'type' => 'input', 'block_id' => 'amount', 'optional' => true,
        'label' => ['type' => 'plain_text', 'text' => 'Amount on hand'],
        'element' => [
          'type' => 'number_input', 'action_id' => 'value', 'is_decimal_allowed' => true,
        ],
      ],
    ]),
  ];
}

function leadershipBlocks($record) {
  $text = "*New Supply Request*\n*Location:* {$record['location']}\n*Item:* {$record['qty']}x {$record['item']}\n*Requested by:* {$record['requestedByLabel']}";
  if (!empty($record['notes'])) $text .= "\n*Notes:* {$record['notes']}";
  return [
    ['type' => 'section', 'text' => ['type' => 'mrkdwn', 'text' => $text]],
    ['type' => 'actions', 'block_id' => 'bdd_actions', 'elements' => [
      ['type' => 'button', 'text' => ['type' => 'plain_text', 'text' => '✅ Approve'], 'style' => 'primary', 'action_id' => 'bdd_approve', 'value' => (string)$record['id']],
      ['type' => 'button', 'text' => ['type' => 'plain_text', 'text' => '✏️ Edit'],    'action_id' => 'bdd_edit',    'value' => (string)$record['id']],
      ['type' => 'button', 'text' => ['type' => 'plain_text', 'text' => '❌ Deny'],    'style' => 'danger',  'action_id' => 'bdd_deny',    'value' => (string)$record['id']],
    ]],
  ];
}

function resolvedBlocks($record, $verb, $byLabel) {
  $icon = ($verb === 'Approved') ? '✅' : '❌';
  $text = "{$icon} *{$verb}*\n*Location:* {$record['location']}\n*Item:* {$record['qty']}x {$record['item']}\n*Requested by:* {$record['requestedByLabel']}\n*{$verb} by:* {$byLabel}";
  return [['type' => 'section', 'text' => ['type' => 'mrkdwn', 'text' => $text]]];
}

// ---------------------------------------------------------------- /payout
// Unpaid jobs from the Payout Calculator's bdd-jobs.json. A job counts as unpaid
// unless it's marked "Paid Out" in the calculator. Tip shares follow the
// calculator's own rule (tipShareFor in bdd-calc-v7.js): tips split evenly across
// everyone present on the job — not the Business cut, not an absent owner.
function payMoney($n) { return '$' . number_format((float)$n, 2); }
function payEsc($s) { return str_replace(['&', '<', '>'], ['&amp;', '&lt;', '&gt;'], (string)$s); }
function payAdd(&$totals, $name, $key, $amt) {
  if (!isset($totals[$name])) $totals[$name] = ['pay' => 0, 'tips' => 0, 'ref' => 0];
  $totals[$name][$key] += $amt;
}

function payoutResponse() {
  global $PAYOUT_ROSTER;
  $jobs = file_exists(PAYOUT_JOBS_FILE) ? json_decode(file_get_contents(PAYOUT_JOBS_FILE), true) : [];
  if (!is_array($jobs)) $jobs = [];
  $unpaid = array_values(array_filter($jobs, function ($j) { return empty($j['paidOut']); }));
  if (!$unpaid) {
    return ['response_type' => 'ephemeral', 'text' => "No unpaid jobs — everything in the Payout Calculator is marked Paid Out. ✅"];
  }
  // Oldest first — the longest-waiting payouts are at the top.
  usort($unpaid, function ($a, $b) { return strcmp((string)($a['date'] ?? ''), (string)($b['date'] ?? '')); });

  $totals    = [];
  $jobBlocks = [];
  foreach ($unpaid as $j) {
    $splits  = is_array($j['splits'] ?? null) ? $j['splits'] : [];
    $tips    = (float)($j['tips'] ?? 0);
    $working = array_filter($splits, function ($s) { $t = $s['tag'] ?? ''; return $t !== 'biz' && $t !== 'absent'; });
    $share   = ($tips > 0 && count($working) > 0) ? round($tips / count($working), 2) : 0;

    $when = !empty($j['date']) ? date('M j', strtotime($j['date'] . ' 12:00:00')) : 'No date';
    $head = '*' . $when . ' · ' . ((($j['location'] ?? 'Springfield') === 'Riverside') ? 'RIV' : 'SPR') . ' · ' . payEsc($j['desc'] ?? ($j['type'] ?? 'Job')) . ' — ' . payMoney($j['price'] ?? ($j['revenue'] ?? 0)) . '*';
    if ($tips > 0) $head .= '  (tips ' . payMoney($tips) . ')';
    $lines = [$head];

    foreach ($splits as $s) {
      $tag = $s['tag'] ?? '';
      if ($tag === 'biz') continue;
      $name = (string)($s['name'] ?? '?');
      $amt  = (float)($s['amount'] ?? 0);
      $line = '• ' . payEsc($name) . ': ' . payMoney($amt);
      if ($tag === 'absent') {
        $line .= '  _(absent)_';
      } elseif ($share > 0) {
        $line .= ' (+' . payMoney($share) . ' tips)';
        payAdd($totals, $name, 'tips', $share);
      }
      payAdd($totals, $name, 'pay', $amt);
      $lines[] = $line;
    }

    $refAmt = (float)($j['referralAmt'] ?? 0);
    if (!empty($j['referral']) && !empty($j['referralBy']) && $refAmt > 0) {
      $lines[] = '• ' . payEsc($j['referralBy']) . ': +' . payMoney($refAmt) . ' referral bonus';
      payAdd($totals, (string)$j['referralBy'], 'ref', $refAmt);
    }
    $jobBlocks[] = ['type' => 'section', 'text' => ['type' => 'mrkdwn', 'text' => implode("\n", $lines)]];
  }

  // Per-person totals across every unpaid job, roster order first.
  $order  = array_merge($PAYOUT_ROSTER, array_diff(array_keys($totals), $PAYOUT_ROSTER));
  $tLines = [];
  $grand  = 0;
  foreach ($order as $name) {
    if (!isset($totals[$name])) continue;
    $t   = $totals[$name];
    $sum = $t['pay'] + $t['tips'] + $t['ref'];
    if ($sum <= 0) continue;
    $grand += $sum;
    if ($t['tips'] > 0 || $t['ref'] > 0) {
      $line = '• ' . payEsc($name) . ': ' . payMoney($t['pay']);
      if ($t['tips'] > 0) $line .= ' (+' . payMoney($t['tips']) . ' tips)';
      if ($t['ref'] > 0)  $line .= ' + ' . payMoney($t['ref']) . ' referral';
      $line .= ' = *' . payMoney($sum) . '*';
    } else {
      $line = '• ' . payEsc($name) . ': *' . payMoney($sum) . '*';
    }
    $tLines[] = $line;
  }

  $n = count($unpaid);
  $blocks = [];
  $blocks[] = ['type' => 'header', 'text' => ['type' => 'plain_text', 'text' => '💰 Unpaid Payouts — ' . $n . ' job' . ($n === 1 ? '' : 's')]];
  $blocks[] = ['type' => 'section', 'text' => ['type' => 'mrkdwn',
    'text' => "*Owed per person:*\n" . ($tLines ? implode("\n", $tLines) : '_nothing owed_') . "\n\n*Total owed:* " . payMoney($grand)]];
  $blocks[] = ['type' => 'divider'];

  // Slack allows 50 blocks per message — list up to 44 jobs; totals above always cover all of them.
  $MAX_JOBS = 44;
  foreach (array_slice($jobBlocks, 0, $MAX_JOBS) as $b) $blocks[] = $b;
  if (count($jobBlocks) > $MAX_JOBS) {
    $blocks[] = ['type' => 'context', 'elements' => [['type' => 'mrkdwn',
      'text' => '_…and ' . (count($jobBlocks) - $MAX_JOBS) . ' more unpaid jobs (newer) — included in the totals above._']]];
  }
  $blocks[] = ['type' => 'context', 'elements' => [['type' => 'mrkdwn',
    'text' => 'Mark jobs *Paid Out* in the Payout Calculator to clear them from this list. Tip shares are split evenly across everyone present.']]];

  return ['response_type' => 'ephemeral', 'text' => "Unpaid payouts: {$n} job" . ($n === 1 ? '' : 's') . ', ' . payMoney($grand) . ' owed', 'blocks' => $blocks];
}

// ---------------------------------------------------------------- dispatch

// ── slash commands: /supply-request and /stock ─────────────────────
if (isset($post['command'])) {
  $cmd    = $post['command'];
  $person = personFor($post['user_id']);
  if (!$person) {
    header('Content-Type: application/json');
    echo json_encode(['response_type' => 'ephemeral', 'text' => "You're not set up for this yet — ask Avery to add your Slack ID to bdd-slack.php."]);
    exit;
  }

  if ($cmd === '/inventory') {
    header('Content-Type: application/json');
    if (!invLoad()) { echo json_encode(['response_type' => 'ephemeral', 'text' => 'No inventory items yet.']); exit; }
    $loc   = invLocationFrom($post['text'] ?? '', $post['channel_name'] ?? '');
    $parts = [];
    foreach (($loc !== '' ? [$loc] : ['Springfield', 'Riverside']) as $l) $parts[] = invSummaryText($l);
    $tip = $loc === '' ? "\n\n_Tip: `/inventory spr` or `/inventory riv` shows just one location._" : '';
    echo json_encode(['response_type' => 'ephemeral', 'text' => implode("\n\n———\n\n", $parts) . $tip]);
    exit;
  }

  if ($cmd === '/book') {
    $bkSlack = $post; // WordPress has its own global $post — keep Slack's data separate before booting it
    require __DIR__ . '/bdd-book.php';
    bkOpen($bkSlack, $person);
    exit;
  }

  if ($cmd === '/payout') {
    header('Content-Type: application/json');
    if (!in_array($person['id'], $PAYOUT_ALLOWED, true)) {
      echo json_encode(['response_type' => 'ephemeral', 'text' => 'Payout info is owners-only.']);
      exit;
    }
    echo json_encode(payoutResponse());
    exit;
  }

  if ($cmd === '/stock') {
    if (!invLoad()) {
      header('Content-Type: application/json');
      echo json_encode(['response_type' => 'ephemeral', 'text' => 'No inventory items yet — upload bdd-inventory.json to the server first.']);
      exit;
    }
    $loc = invLocationFrom($post['text'] ?? '', $post['channel_name'] ?? '');
    slackApi('views.open', ['trigger_id' => $post['trigger_id'], 'view' => stockModal($loc, $loc === '')]);
    http_response_code(200);
    exit;
  }

  // default: /supply-request (must be used in #supply-orders)
  if ($post['channel_id'] !== SLACK_SUPPLY_ORDERS_CHANNEL) {
    header('Content-Type: application/json');
    echo json_encode(['response_type' => 'ephemeral', 'text' => 'Use /supply-request in #supply-orders.']);
    exit;
  }
  slackApi('views.open', ['trigger_id' => $post['trigger_id'], 'view' => itemModal('Supply Request')]);
  http_response_code(200);
  exit;
}

if (isset($post['payload'])) {
  $payload = json_decode($post['payload'], true);

  // ── /book (LatePoint): its form submission, live time-slot refreshes, and the
  //    type-ahead customer search all go to bdd-book.php.
  $bkType = $payload['type'] ?? '';
  if (($bkType === 'view_submission' && ($payload['view']['callback_id'] ?? '') === 'bdd_book')
      || ($bkType === 'block_actions' && strpos((string)($payload['actions'][0]['action_id'] ?? ''), 'bk_') === 0)
      || $bkType === 'block_suggestion') {
    require __DIR__ . '/bdd-book.php';
    bkHandlePayload($payload);
    exit;
  }

  // ── "New Request" or "Edit Request" modal submitted ──────────────
  if ($payload['type'] === 'view_submission') {
    $view = $payload['view'];
    $vals = $view['state']['values'];

    $location = $vals['location']['value']['selected_option']['value'] ?? 'Springfield';
    $item     = trim($vals['item']['value']['value'] ?? '');
    $qty      = (int)($vals['qty']['value']['value'] ?? 1);
    $notes    = trim($vals['notes']['value']['value'] ?? '');
    $person   = personFor($payload['user']['id']);
    $byLabel  = $person ? $person['label'] : ($payload['user']['username'] ?? 'Slack user');

    // ── /stock: update an inventory item's status (and amount) ───────
    if ($view['callback_id'] === 'bdd_stock') {
      global $STOCK_ALERT_STATUSES;
      $productId = $vals['product']['value']['selected_option']['value'] ?? '';
      $newStatus = $vals['status']['value']['selected_option']['value'] ?? '';
      $amountRaw = trim($vals['amount']['value']['value'] ?? '');
      $inv       = invFind($productId);

      if ($productId === '') {
        $meta = json_decode($view['private_metadata'] ?? '', true) ?: [];
        header('Content-Type: application/json');
        echo json_encode(!empty($meta['picker'])
          ? ['response_action' => 'errors', 'errors' => ['loc' => 'Pick a location, then a product.']]
          : ['response_action' => 'clear']);
        exit;
      }

      if ($inv && in_array($newStatus, ['Good', 'Almost Out', 'Out'], true)) {
        $inv['status'] = $newStatus;
        $inv['updatedAt'] = bddNow();                  // shown on the dashboard's Restock Board
        $inv['updatedBy'] = $byLabel . ' (Slack)';
        $qtyNote = '';
        if ($amountRaw !== '' && is_numeric($amountRaw)) {
          $n = (float)$amountRaw;
          $inv['qty'] = ($n == (int)$n) ? (int)$n : $n;
          $qtyNote = " · qty now {$inv['qty']}";
        }
        invUpsert($inv);

        if (in_array($newStatus, $STOCK_ALERT_STATUSES, true)) {
          $icon = ($newStatus === 'Out') ? '🚨' : '⚠️';
          $code = invCode(invLocOf($inv));
          $line = "{$icon} *{$code}* · *{$inv['name']}* is now *{$newStatus}*{$qtyNote}\n_Category: " . ($inv['category'] ?? '?') . " · updated by {$byLabel}_";
          if ($newStatus === 'Out') {
            $line .= "\nFile a restock: `/supply-request` in <#" . SLACK_SUPPLY_ORDERS_CHANNEL . ">";
          }
          slackApi('chat.postMessage', [
            'channel' => STOCK_ALERT_CHANNEL,
            'text'    => "[{$code}] {$inv['name']} is now {$newStatus}",
            'blocks'  => [['type' => 'section', 'text' => ['type' => 'mrkdwn', 'text' => $line]]],
          ]);
        }
      }

      header('Content-Type: application/json');
      echo json_encode(['response_action' => 'clear']);
      exit;
    }

    if ($view['callback_id'] === 'bdd_new_request') {
      $record = [
        'id' => bddUid(), 'location' => $location, 'item' => $item, 'qty' => $qty,
        'requestedBy' => $person ? $person['id'] : '', 'requestedByLabel' => $byLabel,
        'notes' => $notes, 'status' => 'Requested', 'createdAt' => bddNow(),
        'history' => [['status' => 'Requested', 'by' => $byLabel, 'at' => bddNow()]],
      ];
      bddUpsert($record);

      slackApi('chat.postMessage', [
        'channel' => SLACK_SUPPLY_ORDERS_CHANNEL,
        'text' => "📦 {$byLabel} requested {$qty}x {$item} for {$location} — sent to #leadership for approval.",
      ]);
      $posted = slackApi('chat.postMessage', [
        'channel' => SLACK_LEADERSHIP_CHANNEL,
        'text' => "New supply request from {$byLabel}",
        'blocks' => leadershipBlocks($record),
      ]);
      if ($posted && !empty($posted['ok'])) {
        $record['slackChannel'] = $posted['channel'];
        $record['slackTs']      = $posted['ts'];
        bddUpsert($record);
      }

    } elseif ($view['callback_id'] === 'bdd_edit_request') {
      $meta   = json_decode($view['private_metadata'], true);
      $record = bddFind($meta['id']);
      if ($record) {
        $record['location'] = $location; $record['item'] = $item; $record['qty'] = $qty; $record['notes'] = $notes;
        $record['history'][] = ['status' => $record['status'], 'by' => $byLabel . ' (edited)', 'at' => bddNow()];
        bddUpsert($record);
        if (!empty($record['slackChannel']) && !empty($record['slackTs'])) {
          slackApi('chat.update', [
            'channel' => $record['slackChannel'], 'ts' => $record['slackTs'],
            'text' => "Supply request from {$record['requestedByLabel']} (edited by {$byLabel})",
            'blocks' => leadershipBlocks($record),
          ]);
        }
      }
    }

    header('Content-Type: application/json');
    echo json_encode(['response_action' => 'clear']);
    exit;
  }

  // ── Button click on the leadership card ───────────────────────────
  if ($payload['type'] === 'block_actions') {
    $action  = $payload['actions'][0];

    // /stock: location picked in the modal → reload it with that location's items.
    if (($action['action_id'] ?? '') === 'stock_loc') {
      $loc = $action['selected_option']['value'] ?? '';
      if (in_array($loc, ['Springfield', 'Riverside'], true)) {
        slackApi('views.update', ['view_id' => $payload['view']['id'], 'view' => stockModal($loc, true)]);
      }
      http_response_code(200);
      exit;
    }
    $id      = $action['value'];
    $record  = bddFind($id);
    $person  = personFor($payload['user']['id']);
    $byLabel = $person ? $person['label'] : ($payload['user']['username'] ?? 'Someone');

    if ($record && $action['action_id'] === 'bdd_approve') {
      $record['status'] = 'Ordered';
      $record['history'][] = ['status' => 'Ordered', 'by' => $byLabel, 'at' => bddNow()];
      bddUpsert($record);
      if (!empty($record['slackChannel']) && !empty($record['slackTs'])) {
        slackApi('chat.update', ['channel' => $record['slackChannel'], 'ts' => $record['slackTs'],
          'text' => "Approved by {$byLabel}", 'blocks' => resolvedBlocks($record, 'Approved', $byLabel)]);
      }
      slackApi('chat.postMessage', ['channel' => SLACK_SUPPLY_ORDERS_CHANNEL,
        'text' => "✅ {$record['qty']}x {$record['item']} ({$record['location']}) approved by {$byLabel} — now Ordered."]);

    } elseif ($record && $action['action_id'] === 'bdd_deny') {
      bddDelete($id);
      if (!empty($record['slackChannel']) && !empty($record['slackTs'])) {
        slackApi('chat.update', ['channel' => $record['slackChannel'], 'ts' => $record['slackTs'],
          'text' => "Denied by {$byLabel}", 'blocks' => resolvedBlocks($record, 'Denied', $byLabel)]);
      }
      slackApi('chat.postMessage', ['channel' => SLACK_SUPPLY_ORDERS_CHANNEL,
        'text' => "❌ {$record['qty']}x {$record['item']} ({$record['location']}) was denied by {$byLabel}."]);

    } elseif ($record && $action['action_id'] === 'bdd_edit') {
      $meta = json_encode(['id' => $record['id']]);
      slackApi('views.open', ['trigger_id' => $payload['trigger_id'], 'view' => itemModal('Edit Supply Request', $record, $meta)]);
    }

    http_response_code(200);
    exit;
  }
}

http_response_code(404);
