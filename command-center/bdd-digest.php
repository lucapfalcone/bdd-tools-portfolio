<?php
// ============================================================
//  BDD Command Center — Daily Digest
//  Upload to: public_html/bdd-digest.php
//
//  Run once each morning via a Hostinger cron job (PHP type):
//     /home/USER/domains/example.com/public_html/bdd-digest.php
//  Manual test from a browser: bdd-digest.php?key=THE_KEY_BELOW
//
//  Reads bdd-supply.json / bdd-todos.json / bdd-inventory.json /
//  bdd-jobs.json (all in public_html) and posts a summary to #leadership.
// ============================================================

error_reporting(0);
ini_set('display_errors', 0);
date_default_timezone_set('America/New_York'); // "today" / "this week" = Eastern

define('BDD_SLACK_BOT_TOKEN', 'xoxb-YOUR-SLACK-BOT-TOKEN-HERE'); // same as bdd-slack.php
define('BDD_DIGEST_CHANNEL', 'C0EXAMPLE001'); // #leadership channel ID
define('BDD_DIGEST_KEY', 'YOUR_DIGEST_CRON_KEY_HERE'); // only used to allow manual browser testing

// Cron runs this from the command line (always allowed). A direct web hit needs the key.
if (php_sapi_name() !== 'cli' && (($_GET['key'] ?? '') !== BDD_DIGEST_KEY)) {
    http_response_code(403);
    exit('Forbidden');
}

function jload($name) {
    $f = __DIR__ . '/' . $name;
    if (!file_exists($f)) return [];
    $d = json_decode(file_get_contents($f), true);
    return is_array($d) ? $d : [];
}

function slackApi($method, $params) {
    $ctx = stream_context_create(['http' => [
        'method'  => 'POST',
        'header'  => "Content-Type: application/json\r\nAuthorization: Bearer " . BDD_SLACK_BOT_TOKEN . "\r\n",
        'content' => json_encode($params),
        'timeout' => 8,
        'ignore_errors' => true,
    ]]);
    $res = @file_get_contents('https://slack.com/api/' . $method, false, $ctx);
    return $res ? json_decode($res, true) : null;
}

// Join list lines, capping the count so a Slack section can't blow past its size limit.
function capList($lines, $cap = 25) {
    if (count($lines) <= $cap) return implode("\n", $lines);
    $extra = count($lines) - $cap;
    return implode("\n", array_slice($lines, 0, $cap)) . "\n_…and {$extra} more_";
}

$today = date('Y-m-d');
$fmt   = function ($n) { return '$' . number_format((float)$n, 0); };

// ---- Supply requests not yet Received ----
$supply = array_values(array_filter(jload('bdd-supply.json'), function ($r) {
    return ($r['status'] ?? '') !== 'Received';
}));

// ---- Open to-dos, and which are overdue ----
$todos = array_values(array_filter(jload('bdd-todos.json'), function ($r) {
    return ($r['status'] ?? '') === 'Open';
}));
$overdue = array_values(array_filter($todos, function ($r) use ($today) {
    return !empty($r['due']) && $r['due'] < $today;
}));

// ---- Inventory items not "Good" ----
$lowstock = array_values(array_filter(jload('bdd-inventory.json'), function ($r) {
    return ($r['status'] ?? 'Good') !== 'Good';
}));

// ---- This week's payout numbers (Mon–Sun, matching the Payout Calculator) ----
$jobs = jload('bdd-jobs.json');
$monday = strtotime('monday this week');
$weekProfit = 0; $weekJobs = 0;
foreach ($jobs as $j) {
    $d = strtotime(($j['date'] ?? '') . ' 12:00:00');
    if ($d && $d >= $monday) {
        $weekProfit += (float)($j['profit'] ?? 0);
        $weekJobs++;
    }
}

// ---- Build the message ----
$blocks = [];
$blocks[] = ['type' => 'header', 'text' => ['type' => 'plain_text', 'text' => '📋 BDD Daily Digest — ' . date('D, M j')]];

$blocks[] = ['type' => 'section', 'text' => ['type' => 'mrkdwn',
    'text' => "*💰 This week so far:* " . $fmt($weekProfit) . " net profit · {$weekJobs} job" . ($weekJobs === 1 ? '' : 's')]];

if (count($supply)) {
    $lines = [];
    foreach ($supply as $r) {
        $lines[] = "• *" . ($r['location'] ?? '?') . "* — " . ($r['qty'] ?? '?') . "x " . ($r['item'] ?? '?') . "  _(" . ($r['status'] ?? '?') . ")_";
    }
    $blocks[] = ['type' => 'section', 'text' => ['type' => 'mrkdwn',
        'text' => "*📦 Open supply requests (" . count($supply) . "):*\n" . capList($lines)]];
} else {
    $blocks[] = ['type' => 'section', 'text' => ['type' => 'mrkdwn', 'text' => "*📦 Supply requests:* none open ✅"]];
}

$todoText = "*✅ To-dos:* " . count($todos) . " open";
if (count($overdue)) {
    $olines = [];
    foreach ($overdue as $r) {
        $olines[] = "• " . ($r['task'] ?? '?') . "  _(due " . $r['due'] . ", " . ($r['group'] ?? '?') . ")_";
    }
    $todoText .= "  ·  *" . count($overdue) . " overdue:*\n" . capList($olines);
}
$blocks[] = ['type' => 'section', 'text' => ['type' => 'mrkdwn', 'text' => $todoText]];

if (count($lowstock)) {
    $llines = [];
    foreach ($lowstock as $r) {
        $llines[] = "• *" . ((($r['location'] ?? 'Springfield') === 'Riverside') ? 'RIV' : 'SPR') . "* " . ($r['name'] ?? '?') . "  _(" . ($r['status'] ?? '?') . ", " . ($r['category'] ?? '?') . ")_";
    }
    $blocks[] = ['type' => 'section', 'text' => ['type' => 'mrkdwn',
        'text' => "*📉 Low stock (" . count($lowstock) . "):*\n" . capList($llines)]];
} else {
    $blocks[] = ['type' => 'section', 'text' => ['type' => 'mrkdwn', 'text' => "*📉 Inventory:* all good ✅"]];
}

$res = slackApi('chat.postMessage', [
    'channel' => BDD_DIGEST_CHANNEL,
    'text'    => 'BDD Daily Digest',
    'blocks'  => $blocks,
]);

if (php_sapi_name() !== 'cli') {
    echo ($res && !empty($res['ok'])) ? 'Digest sent.' : 'Digest failed — check bot token / channel ID.';
}
