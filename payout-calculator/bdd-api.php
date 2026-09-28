<?php
// ============================================================
//  BDD Job Tracker API
//  Upload to: public_html/bdd-api.php
//  Jobs stored in: public_html/bdd-jobs.json (auto-created)
// ============================================================

error_reporting(0);
ini_set('display_errors', 0);

define('BDD_SECRET', 'YOUR_PAYOUT_API_SECRET_HERE');

header('Content-Type: application/json');

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$allowed = ['https://example.com', 'https://www.example.com'];
header('Access-Control-Allow-Origin: ' . (in_array($origin, $allowed) ? $origin : 'https://example.com'));
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-BDD-Token');
header('Access-Control-Allow-Credentials: true');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }

$token = $_SERVER['HTTP_X_BDD_TOKEN'] ?? '';
if ($token !== BDD_SECRET) { http_response_code(401); echo json_encode(['error' => 'Unauthorized']); exit; }

$file = __DIR__ . '/bdd-jobs.json';

function loadJobs($file) {
    if (!file_exists($file)) return [];
    $data = json_decode(file_get_contents($file), true);
    return is_array($data) ? $data : [];
}

function saveJobs($file, $jobs) {
    $result = file_put_contents($file, json_encode(array_values($jobs), JSON_PRETTY_PRINT), LOCK_EX);
    if ($result === false) {
        http_response_code(500);
        echo json_encode(['error' => 'Failed to write data — check file permissions']);
        exit;
    }
}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    echo json_encode(loadJobs($file));

} elseif ($method === 'POST') {
    $job = json_decode(file_get_contents('php://input'), true);
    if (!$job || !isset($job['id'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid job data']);
        exit;
    }
    $jobs = loadJobs($file);
    array_unshift($jobs, $job);
    saveJobs($file, $jobs);
    echo json_encode(['success' => true]);

} elseif ($method === 'DELETE') {
    if (isset($_GET['clear'])) {
        saveJobs($file, []);
        echo json_encode(['success' => true]);
    } elseif (isset($_GET['id'])) {
        $id   = (string)$_GET['id'];
        $jobs = array_filter(loadJobs($file), fn($j) => (string)$j['id'] !== $id);
        saveJobs($file, array_values($jobs));
        echo json_encode(['success' => true]);
    } else {
        http_response_code(400);
        echo json_encode(['error' => 'Missing id or clear parameter']);
    }

} elseif ($method === 'PUT') {
    $updated = json_decode(file_get_contents('php://input'), true);
    if (!$updated || !isset($updated['id'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid job data']);
        exit;
    }
    $jobs  = loadJobs($file);
    $found = false;
    foreach ($jobs as &$job) {
        if ((string)$job['id'] === (string)$updated['id']) {
            $job   = $updated;
            $found = true;
            break;
        }
    }
    unset($job);
    if (!$found) { http_response_code(404); echo json_encode(['error' => 'Job not found']); exit; }
    saveJobs($file, $jobs);
    echo json_encode(['success' => true]);

} else {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
}
