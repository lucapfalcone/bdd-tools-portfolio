<?php
// ============================================================
//  BDD Command Center API — Supply Orders + To-Dos + Inventory
//  Upload to: public_html/bdd-supply-api.php
//  Data stored in: public_html/bdd-supply.json, bdd-todos.json,
//  bdd-inventory.json (all auto-created)
// ============================================================

error_reporting(0);
ini_set('display_errors', 0);

define('BDD_SUPPLY_SECRET', 'YOUR_SUPPLY_API_SECRET_HERE');

// Paste the "Webhook URL" from a Slack Incoming Webhook app here (#supply-orders channel).
// Leave blank to disable Slack notifications without breaking the API.
define('BDD_SLACK_WEBHOOK_URL', 'https://hooks.slack.com/services/YOUR/WEBHOOK/URL');

// Same Bot Token + #leadership channel ID as bdd-slack.php — lets a dashboard-filed
// request also get an Approve/Edit/Deny card, and keeps that card in sync when its
// status changes here on the dashboard. Leave BDD_SLACK_BOT_TOKEN blank to skip this
// (the plain #supply-orders webhook notification above still works either way).
define('BDD_SLACK_BOT_TOKEN', 'xoxb-YOUR-SLACK-BOT-TOKEN-HERE');
define('BDD_SLACK_LEADERSHIP_CHANNEL', 'C0EXAMPLE001');

// id -> display name, for building the Slack card's "Requested by" line.
$BDD_PEOPLE_LABELS = ['jordan' => 'Jordan', 'avery' => 'Avery', 'harlan' => 'Harlan', 'sawyer' => 'Sawyer'];

header('Content-Type: application/json');

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$allowed = ['https://example.com', 'https://www.example.com'];
header('Access-Control-Allow-Origin: ' . (in_array($origin, $allowed) ? $origin : 'https://example.com'));
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-BDD-Token');
header('Access-Control-Allow-Credentials: true');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }

$token = $_SERVER['HTTP_X_BDD_TOKEN'] ?? '';
if ($token !== BDD_SUPPLY_SECRET) { http_response_code(401); echo json_encode(['error' => 'Unauthorized']); exit; }

$resource = $_GET['resource'] ?? '';
if (!in_array($resource, ['supply', 'todo', 'inventory'], true)) {
    http_response_code(400);
    echo json_encode(['error' => 'Missing or invalid resource — use ?resource=supply, ?resource=todo, or ?resource=inventory']);
    exit;
}
$RESOURCE_FILES = ['supply' => 'bdd-supply.json', 'todo' => 'bdd-todos.json', 'inventory' => 'bdd-inventory.json'];
$file = __DIR__ . '/' . $RESOURCE_FILES[$resource];

function loadRecords($file) {
    if (!file_exists($file)) return [];
    $data = json_decode(file_get_contents($file), true);
    return is_array($data) ? $data : [];
}

function saveRecords($file, $records) {
    $result = file_put_contents($file, json_encode(array_values($records), JSON_PRETTY_PRINT), LOCK_EX);
    if ($result === false) {
        http_response_code(500);
        echo json_encode(['error' => 'Failed to write data — check file permissions']);
        exit;
    }
}

// Best-effort Slack post — never let a Slack outage break the API response.
function postToSlack($text) {
    if (BDD_SLACK_WEBHOOK_URL === '') return;
    $payload = json_encode(['text' => $text]);
    $ctx = stream_context_create([
        'http' => [
            'method'  => 'POST',
            'header'  => "Content-Type: application/json\r\n",
            'content' => $payload,
            'timeout' => 3,
            'ignore_errors' => true,
        ],
    ]);
    @file_get_contents(BDD_SLACK_WEBHOOK_URL, false, $ctx);
}

// ---- Bot-token Slack API calls (posting/updating the #leadership card) ----
// Mirrors bdd-slack.php's slackApi()/leadershipBlocks()/resolvedBlocks() — kept as
// its own copy here since every BDD server file stands alone as a single upload.
function slackApi($method, $params) {
    if (BDD_SLACK_BOT_TOKEN === '' || BDD_SLACK_BOT_TOKEN === 'PASTE_BOT_TOKEN_HERE') return null;
    $ctx = stream_context_create(['http' => [
        'method'  => 'POST',
        'header'  => "Content-Type: application/json\r\nAuthorization: Bearer " . BDD_SLACK_BOT_TOKEN . "\r\n",
        'content' => json_encode($params),
        'timeout' => 5,
        'ignore_errors' => true,
    ]]);
    $res = @file_get_contents('https://slack.com/api/' . $method, false, $ctx);
    return $res ? json_decode($res, true) : null;
}

function bddLabelFor($id) {
    global $BDD_PEOPLE_LABELS;
    return $BDD_PEOPLE_LABELS[$id] ?? ($id ?: 'Unknown');
}

function leadershipBlocks($record) {
    $text = "*New Supply Request*\n*Location:* {$record['location']}\n*Item:* {$record['qty']}x {$record['item']}\n*Requested by:* " . bddLabelFor($record['requestedBy'] ?? '');
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
    $icon = $verb === 'Denied' ? '❌' : ($verb === 'Received' ? '📦' : '✅');
    $text = "{$icon} *{$verb}*\n*Location:* {$record['location']}\n*Item:* {$record['qty']}x {$record['item']}\n*Requested by:* " . bddLabelFor($record['requestedBy'] ?? '') . "\n*{$verb} by:* {$byLabel}";
    return [['type' => 'section', 'text' => ['type' => 'mrkdwn', 'text' => $text]]];
}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    echo json_encode(loadRecords($file));

} elseif ($method === 'POST') {
    $record = json_decode(file_get_contents('php://input'), true);
    if (!$record || !isset($record['id'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid record data']);
        exit;
    }
    $records = loadRecords($file);
    array_unshift($records, $record);
    saveRecords($file, $records);

    if ($resource === 'supply') {
        $loc   = $record['location'] ?? '?';
        $item  = $record['item'] ?? '?';
        $qty   = $record['qty'] ?? '?';
        $who   = $record['requestedBy'] ?? '?';
        postToSlack(":package: New supply request — *{$loc}*: {$qty}x {$item} (requested by {$who})");

        // Also post the Approve/Edit/Deny card to #leadership, same as a Slack-filed
        // request gets from bdd-slack.php — so it doesn't matter where a request
        // came from, it always reaches leadership the same way.
        $posted = slackApi('chat.postMessage', [
            'channel' => BDD_SLACK_LEADERSHIP_CHANNEL,
            'text'    => 'New supply request from ' . bddLabelFor($who),
            'blocks'  => leadershipBlocks($record),
        ]);
        if ($posted && !empty($posted['ok'])) {
            $record['slackChannel'] = $posted['channel'];
            $record['slackTs']      = $posted['ts'];
            $records = array_map(function($r) use ($record) {
                return (string)$r['id'] === (string)$record['id'] ? $record : $r;
            }, $records);
            saveRecords($file, $records);
        }
    }

    echo json_encode(['success' => true]);

} elseif ($method === 'DELETE') {
    if (isset($_GET['clear'])) {
        saveRecords($file, []);
        echo json_encode(['success' => true]);
    } elseif (isset($_GET['id'])) {
        $id      = (string)$_GET['id'];
        $records = array_filter(loadRecords($file), fn($r) => (string)$r['id'] !== $id);
        saveRecords($file, array_values($records));
        echo json_encode(['success' => true]);
    } else {
        http_response_code(400);
        echo json_encode(['error' => 'Missing id or clear parameter']);
    }

} elseif ($method === 'PUT') {
    $updated = json_decode(file_get_contents('php://input'), true);
    if (!$updated || !isset($updated['id'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid record data']);
        exit;
    }
    $records = loadRecords($file);
    $found   = false;
    $prevStatus = null;
    foreach ($records as &$r) {
        if ((string)$r['id'] === (string)$updated['id']) {
            $prevStatus = $r['status'] ?? null;
            $r = $updated;
            $found = true;
            break;
        }
    }
    unset($r);
    if (!$found) { http_response_code(404); echo json_encode(['error' => 'Record not found']); exit; }
    saveRecords($file, $records);

    if ($resource === 'supply' && $prevStatus !== ($updated['status'] ?? null)) {
        $loc  = $updated['location'] ?? '?';
        $item = $updated['item'] ?? '?';
        $st   = $updated['status'] ?? '?';
        postToSlack(":arrows_counterclockwise: Supply request updated — *{$loc}*: {$item} → *{$st}*");

        // If this request has a #leadership card (filed via Slack, or via the dashboard
        // now that the block above posts one too), refresh it so it never sits there
        // showing stale buttons for something already resolved on the dashboard.
        if (!empty($updated['slackChannel']) && !empty($updated['slackTs'])) {
            $verb = $st === 'Received' ? 'Received' : 'Approved';
            $lastHistory = !empty($updated['history']) ? end($updated['history']) : null;
            $byLabel = $lastHistory['by'] ?? 'the dashboard';
            slackApi('chat.update', [
                'channel' => $updated['slackChannel'], 'ts' => $updated['slackTs'],
                'text'    => "{$verb} by {$byLabel}",
                'blocks'  => resolvedBlocks($updated, $verb, $byLabel),
            ]);
        }
    }

    echo json_encode(['success' => true]);

} else {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
}
