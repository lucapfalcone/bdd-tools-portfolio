<?php
// ============================================================
//  BDD Command Center — Weekly Payout Summary (owners only)
//  Upload to: public_html/bdd-weekly-payout.php
//
//  Run once a week via a Hostinger cron job (PHP type):
//     /home/USER/domains/example.com/public_html/bdd-weekly-payout.php
//  Manual test from a browser: bdd-weekly-payout.php?key=THE_KEY_BELOW
//
//  Reads bdd-jobs.json (the Payout Calculator's data) READ-ONLY and posts
//  LAST FULL WEEK's numbers to an owners-only Slack channel.
// ============================================================

error_reporting(0);
ini_set('display_errors', 0);
date_default_timezone_set('America/New_York');

define('BDD_SLACK_BOT_TOKEN', 'xoxb-YOUR-SLACK-BOT-TOKEN-HERE'); // same as bdd-slack.php

// #leadership — owners only (Jordan + Avery). Managers file requests elsewhere and
// are NOT in this channel, so per-person payouts stay owner-only. If a manager is
// ever added to #leadership, move this to a separate private channel.
define('BDD_PAYOUT_CHANNEL', 'C0EXAMPLE001');

define('BDD_PAYOUT_KEY', 'YOUR_PAYOUT_CRON_KEY_HERE'); // only used to allow manual browser testing

if (php_sapi_name() !== 'cli' && (($_GET['key'] ?? '') !== BDD_PAYOUT_KEY)) {
    http_response_code(403);
    exit('Forbidden');
}

// Only names in this roster get a per-person payout line (matches the Payout
// Calculator's own tracker — the "biz" share and tax lines are excluded).
$ROSTER = ['Jordan', 'Avery', 'Harlan', 'Sawyer', 'Devon', 'Priya', 'Marco', 'Theo'];

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

if (BDD_PAYOUT_CHANNEL === 'PASTE_OWNERS_CHANNEL_ID') {
    if (php_sapi_name() !== 'cli') echo 'Set BDD_PAYOUT_CHANNEL first.';
    exit;
}

$fmt = function ($n) { return '$' . number_format((float)$n, 2); };

// ---- Last full week: previous Monday 00:00 through this Monday 00:00 ----
$lastMonday = strtotime('monday last week');
$thisMonday = strtotime('monday this week');
$rangeLabel = date('M j', $lastMonday) . ' – ' . date('M j', strtotime('-1 day', $thisMonday));

$jobs = jload('bdd-jobs.json');
$revenue = 0; $profit = 0; $tips = 0; $count = 0;
$perPerson = [];
foreach ($ROSTER as $p) { $perPerson[$p] = 0; }

foreach ($jobs as $j) {
    $d = strtotime(($j['date'] ?? '') . ' 12:00:00');
    if (!$d || $d < $lastMonday || $d >= $thisMonday) continue;

    $count++;
    $revenue += (float)($j['revenue'] ?? $j['price'] ?? 0);
    $profit  += (float)($j['profit'] ?? 0);
    $tips    += (float)($j['tips'] ?? 0);

    foreach (($j['splits'] ?? []) as $s) {
        if (($s['tag'] ?? '') === 'biz') continue;
        $name = $s['name'] ?? '';
        if (isset($perPerson[$name])) {
            $perPerson[$name] += (float)($s['amount'] ?? 0);
        }
    }
}

// ---- Build the message ----
$blocks = [];
$blocks[] = ['type' => 'header', 'text' => ['type' => 'plain_text', 'text' => '💰 Weekly Payout Summary — ' . $rangeLabel]];

if ($count === 0) {
    $blocks[] = ['type' => 'section', 'text' => ['type' => 'mrkdwn', 'text' => '_No jobs logged for last week._']];
} else {
    $blocks[] = ['type' => 'section', 'fields' => [
        ['type' => 'mrkdwn', 'text' => "*Jobs:*\n{$count}"],
        ['type' => 'mrkdwn', 'text' => "*Revenue:*\n" . $fmt($revenue)],
        ['type' => 'mrkdwn', 'text' => "*Net Profit:*\n" . $fmt($profit)],
        ['type' => 'mrkdwn', 'text' => "*Tips:*\n" . $fmt($tips)],
    ]];

    $lines = [];
    foreach ($perPerson as $name => $amt) {
        if ($amt > 0) $lines[] = "• {$name}: " . $fmt($amt);
    }
    if ($lines) {
        $blocks[] = ['type' => 'section', 'text' => ['type' => 'mrkdwn',
            'text' => "*Payouts:*\n" . implode("\n", $lines)]];
    }
}

$blocks[] = ['type' => 'context', 'elements' => [
    ['type' => 'mrkdwn', 'text' => 'Read-only from the Payout Calculator. Figures reflect jobs as they were saved.']
]];

$res = slackApi('chat.postMessage', [
    'channel' => BDD_PAYOUT_CHANNEL,
    'text'    => 'Weekly Payout Summary',
    'blocks'  => $blocks,
]);

if (php_sapi_name() !== 'cli') {
    echo ($res && !empty($res['ok'])) ? 'Summary sent.' : 'Failed — check bot token / channel ID / that the bot is in the channel.';
}
