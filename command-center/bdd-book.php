<?php
// ============================================================
//  BDD Command Center — /book  (Slack → LatePoint)
//  Upload to: public_html/bdd-book.php  (same folder as bdd-slack.php and
//  WordPress's wp-load.php)
//
//  NOT a web endpoint. bdd-slack.php loads it only after Slack's signature
//  check, for: the /book command, its live form refreshes, customer search,
//  and the form submission.
//
//  Boots WordPress so every booking goes through LatePoint's own models and
//  hooks — the same path as LatePoint's admin "New Order" form:
//    customer (found or created) → order → order item → booking
//    → latepoint_booking_created / latepoint_order_created
//  Those hooks are what send LatePoint's normal confirmation email/SMS, write
//  the activity log, and fire any webhooks — exactly like an online booking.
//
//  Required fields are read live from LatePoint Pro's Custom Fields settings,
//  so the Slack form stays in sync when fields are added or changed there.
// ============================================================

if (!defined('BDD_SLACK_INCLUDE')) { http_response_code(404); exit; }

// ---- settings ---------------------------------------------------------
// Slack channel name → LatePoint location (matched against the location's name,
// case-insensitive). /book typed anywhere else shows a Location picker instead.
$BOOK_CHANNEL_LOCATIONS = ['springfield-ops' => 'Springfield', 'riverside-ops' => 'Riverside'];
// Person ids (from $BDD_SLACK_PEOPLE in bdd-slack.php) allowed to book outside
// LatePoint's open time slots.
$BOOK_OVERRIDE_ALLOWED = ['jordan', 'avery'];
// -----------------------------------------------------------------------

// Boot WordPress. This must run at global scope (not inside a function) or
// WordPress's globals ($wpdb, etc.) break — bdd-slack.php includes this file at
// its top level for that reason.
if (!defined('WP_USE_THEMES')) define('WP_USE_THEMES', false);
require_once __DIR__ . '/wp-load.php';

// Act as a site administrator so any LatePoint code that looks at the current
// user behaves the way it does in LatePoint's own admin panel.
$bkAdmins = get_users(['role' => 'administrator', 'number' => 1, 'fields' => 'ID']);
if ($bkAdmins) wp_set_current_user((int)$bkAdmins[0]);

// ---------------------------------------------------------------- small helpers
function bkReady() { return class_exists('OsBookingModel') && class_exists('OsOrderModel'); }
function bkJson($data) { header('Content-Type: application/json'); echo json_encode($data); }
function bkPt($s) { return ['type' => 'plain_text', 'text' => (string)$s]; }
function bkTxt($s, $max = 75) {
  $s = trim(wp_strip_all_tags((string)$s));
  return mb_strlen($s) > $max ? mb_substr($s, 0, $max - 1) . '…' : $s;
}
function bkOpt($text, $value) {
  $t = bkTxt($text);
  return ['text' => bkPt($t !== '' ? $t : '—'), 'value' => mb_substr((string)$value, 0, 150)];
}
function bkEsc($s) { return str_replace(['&', '<', '>'], ['&amp;', '&lt;', '&gt;'], (string)$s); }
// LatePoint returns a single model (limit 1), an array, or false — normalise to an array.
function bkModels($m) { if (!$m) return []; return is_array($m) ? array_values($m) : [$m]; }
function bkByName($a, $b) { return strcasecmp((string)($a->name ?? ''), (string)($b->name ?? '')); }
function bkIsOwner($person) { global $BOOK_OVERRIDE_ALLOWED; return $person && in_array($person['id'], $BOOK_OVERRIDE_ALLOWED, true); }
function bkTimeLabel($min) {
  $min = (int)$min; $h = intdiv($min, 60); $m = $min % 60;
  return sprintf('%d:%02d %s', ($h % 12) ?: 12, $m, $h < 12 ? 'AM' : 'PM');
}
function bkDur($min) {
  $min = (int)$min; $h = intdiv($min, 60); $m = $min % 60;
  return trim(($h ? $h . 'h ' : '') . ($m ? $m . 'm' : ''));
}
function bkNiceDate($ymd) { return $ymd ? date_i18n('D, M j', strtotime($ymd . ' 12:00:00')) : ''; }

// Value of one input block from a view's state, whatever element type it is.
function bkVal($values, $blockId) {
  if (empty($values[$blockId]) || !is_array($values[$blockId])) return null;
  $el = reset($values[$blockId]);
  if (array_key_exists('selected_option', $el))  return $el['selected_option']['value'] ?? null;
  if (array_key_exists('selected_options', $el)) return array_map(function ($o) { return $o['value']; }, $el['selected_options'] ?: []);
  if (array_key_exists('selected_date', $el))    return $el['selected_date'];
  if (array_key_exists('selected_time', $el))    return $el['selected_time'];
  return $el['value'] ?? null;
}

// ---------------------------------------------------------------- LatePoint lookups
function bkLocations() {
  $rows = bkModels((new OsLocationModel())->should_be_active()->get_results_as_models());
  usort($rows, 'bkByName');
  return $rows;
}
function bkLocationIdForChannel($channelName) {
  global $BOOK_CHANNEL_LOCATIONS;
  $want = $BOOK_CHANNEL_LOCATIONS[strtolower((string)$channelName)] ?? '';
  if ($want === '') return 0;
  foreach (bkLocations() as $l) {
    if (stripos((string)$l->name, $want) !== false) return (int)$l->id;
  }
  return 0;
}
function bkLocationName($id) {
  if (!$id) return '';
  $l = new OsLocationModel($id);
  return $l->is_new_record() ? '' : (string)$l->name;
}
// Active services, limited to the ones connected to this location (if any are).
function bkServices($locationId) {
  $services = bkModels((new OsServiceModel())->should_be_active()->get_results_as_models());
  if ($locationId) {
    $conns = bkModels((new OsConnectorModel())->where(['location_id' => $locationId])->get_results_as_models());
    $ids = array_unique(array_map(function ($c) { return (int)$c->service_id; }, $conns));
    if ($ids) {
      $services = array_values(array_filter($services, function ($s) use ($ids) { return in_array((int)$s->id, $ids, true); }));
    }
  }
  usort($services, 'bkByName');
  return $services;
}
function bkAgentName($a) {
  $n = method_exists($a, 'get_full_name') ? trim((string)$a->get_full_name()) : '';
  return $n !== '' ? $n : trim(($a->first_name ?? '') . ' ' . ($a->last_name ?? ''));
}
function bkAgents($serviceId, $locationId) {
  $ids = OsAgentHelper::get_agent_ids_for_service_and_location($serviceId ?: false, $locationId ?: false);
  if (!$ids) return [];
  $m = new OsAgentModel();
  $m->where_in('id', $ids);
  $agents = bkModels($m->should_be_active()->get_results_as_models());
  usort($agents, function ($a, $b) { return strcasecmp(bkAgentName($a), bkAgentName($b)); });
  return $agents;
}

// LatePoint's real open start times (minutes after midnight) for a day —
// the same resource/slot engine the website's booking form uses.
function bkSlots($serviceId, $locationId, $agentId, $date) {
  if (!$serviceId || !$locationId || !$date) return [];
  try {
    $service = new OsServiceModel($serviceId);
    $req = new \LatePoint\Misc\BookingRequest([
      'start_date'      => $date,
      'end_date'        => $date,
      'service_id'      => (int)$serviceId,
      'location_id'     => (int)$locationId,
      'agent_id'        => (int)$agentId,
      'duration'        => (int)$service->duration,
      'buffer_before'   => (int)$service->buffer_before,
      'buffer_after'    => (int)$service->buffer_after,
      'total_attendees' => 1,
    ]);
    $day = new OsWpDateTime($date);
    $resources = OsResourceHelper::get_resources_grouped_by_day($req, $day, clone $day, ['accessed_from_backend' => true]);
    $slots = OsResourceHelper::get_ordered_booking_slots_from_resources($resources[$date] ?? []);
  } catch (\Throwable $e) {
    return [];
  }
  $nowMin = ($date === current_time('Y-m-d')) ? (int)current_time('G') * 60 + (int)current_time('i') : -1;
  $out = [];
  foreach ($slots as $s) {
    if ((int)$s->start_time <= $nowMin) continue;   // already past today
    if (!$s->can_accomodate(1)) continue;
    $out[(int)$s->start_time] = true;
  }
  ksort($out);
  return array_keys($out);
}

// ---------------------------------------------------------------- custom fields (LatePoint Pro)
function bkCustomFields($for) {
  if (!class_exists('OsCustomFieldsHelper')) return [];
  $fields = OsCustomFieldsHelper::get_custom_fields_arr($for, 'agent') ?: [];
  return array_filter($fields, function ($cf) { return ($cf['type'] ?? '') !== 'hidden'; });
}
function bkCfRequired($cf) { return ($cf['required'] ?? 'off') === 'on' && ($cf['conditional'] ?? 'off') !== 'on'; }
function bkCfOptions($cf) {
  $opts = [];
  if (!empty($cf['options']) && is_string($cf['options'])) {
    foreach (preg_split('/\r\n|\r|\n/', $cf['options']) as $o) { $o = trim($o); if ($o !== '') $opts[] = $o; }
  } elseif (!empty($cf['value'])) {
    $decoded = is_string($cf['value']) ? json_decode($cf['value'], true) : $cf['value'];
    if (is_array($decoded)) {
      foreach ($decoded as $o) {
        $o = is_array($o) ? ($o['value'] ?? ($o['label'] ?? '')) : $o;
        if ((string)$o !== '') $opts[] = (string)$o;
      }
    }
  }
  return array_slice(array_values(array_unique($opts)), 0, 100);
}
// One LatePoint custom field → one Slack input block (null = can't be done in Slack).
function bkCfBlock($cf, $prefix, $forceOptional, $labelSuffix = '') {
  $type = $cf['type'] ?? 'text';
  switch ($type) {
    case 'textarea':
      $el = ['type' => 'plain_text_input', 'action_id' => 'value', 'multiline' => true];
      break;
    case 'number':
      $el = ['type' => 'number_input', 'action_id' => 'value', 'is_decimal_allowed' => true];
      break;
    case 'select':
    case 'multiselect':
      $o = bkCfOptions($cf);
      if (!$o) return null;
      $el = ['type' => $type === 'select' ? 'static_select' : 'multi_static_select', 'action_id' => 'value',
             'options' => array_map(function ($x) { return bkOpt($x, $x); }, $o)];
      break;
    case 'checkbox':
      $el = ['type' => 'checkboxes', 'action_id' => 'value', 'options' => [bkOpt($cf['label'] ?? 'Yes', 'on')]];
      break;
    case 'file_upload':
      return null;
    default: // text, phone_number, google_address_autocomplete, anything new
      $el = ['type' => 'plain_text_input', 'action_id' => 'value'];
  }
  if (!empty($cf['placeholder']) && $type !== 'checkbox') $el['placeholder'] = bkPt(bkTxt($cf['placeholder'], 150));
  return [
    'type'     => 'input',
    'block_id' => $prefix . $cf['id'],
    'optional' => $forceOptional || !bkCfRequired($cf),
    'label'    => bkPt(bkTxt(($cf['label'] ?? 'Field') . $labelSuffix, 150)),
    'element'  => $el,
  ];
}
function bkCfValues($values, $fields, $prefix) {
  $out = [];
  foreach ($fields as $cf) {
    $bid = $prefix . $cf['id'];
    if (!isset($values[$bid])) continue;
    $v = bkVal($values, $bid);
    if (($cf['type'] ?? '') === 'checkbox') {
      $out[$cf['id']] = (is_array($v) && in_array('on', $v, true)) ? 'on' : 'off';
    } elseif (is_array($v)) {
      if ($v) $out[$cf['id']] = $v;
    } elseif ($v !== null && trim((string)$v) !== '') {
      $out[$cf['id']] = trim((string)$v);
    }
  }
  return $out;
}

// ---------------------------------------------------------------- the modal
// $ctx travels in private_metadata: ['ch' => channel id, 'loc' => location id (0 = pick in form)]
// $values = current form state, so a refresh keeps the times in sync with the
// chosen service / date / detailer.
function bkModal($ctx, $person, $values = []) {
  $owner     = bkIsOwner($person);
  $locId     = (int)($ctx['loc'] ?: (bkVal($values, 'bk_loc') ?? 0));
  $serviceId = (int)(bkVal($values, 'bk_service') ?? 0);
  $date      = (string)(bkVal($values, 'bk_date') ?: current_time('Y-m-d'));
  $agentSel  = (string)(bkVal($values, 'bk_agent') ?: 'any');
  $agentId   = $agentSel === 'any' ? 0 : (int)$agentSel;

  $b = [];

  // ── where + what
  if ($ctx['loc']) {
    $b[] = ['type' => 'context', 'elements' => [['type' => 'mrkdwn', 'text' => '📍 *' . bkEsc(bkLocationName($ctx['loc'])) . '* — set by this channel']]];
  } else {
    $locs = bkLocations();
    if ($locs) {
      $b[] = ['type' => 'input', 'block_id' => 'bk_loc', 'dispatch_action' => true, 'label' => bkPt('Location'),
        'element' => ['type' => 'static_select', 'action_id' => 'bk_refresh', 'placeholder' => bkPt('Pick a location'),
          'options' => array_map(function ($l) { return bkOpt($l->name, $l->id); }, array_slice($locs, 0, 100))]];
    }
  }

  $services = bkServices($locId);
  if ($services) {
    $b[] = ['type' => 'input', 'block_id' => 'bk_service', 'dispatch_action' => true, 'label' => bkPt('Service'),
      'element' => ['type' => 'static_select', 'action_id' => 'bk_refresh', 'placeholder' => bkPt('Pick a service'),
        'options' => array_map(function ($s) {
          $d = bkDur($s->duration);
          return bkOpt($s->name . ($d !== '' ? ' · ' . $d : ''), $s->id);
        }, array_slice($services, 0, 100))]];
  } else {
    $b[] = ['type' => 'section', 'text' => ['type' => 'mrkdwn', 'text' => '⚠️ No active services found' . ($locId ? ' for this location' : '') . ' in LatePoint.']];
  }

  $b[] = ['type' => 'input', 'block_id' => 'bk_date', 'dispatch_action' => true, 'label' => bkPt('Date'),
    'element' => ['type' => 'datepicker', 'action_id' => 'bk_refresh', 'initial_date' => current_time('Y-m-d')]];

  $agentOpts = [bkOpt('Any available detailer', 'any')];
  foreach (array_slice(bkAgents($serviceId, $locId), 0, 99) as $a) $agentOpts[] = bkOpt(bkAgentName($a), $a->id);
  $b[] = ['type' => 'input', 'block_id' => 'bk_agent', 'dispatch_action' => true, 'optional' => true, 'label' => bkPt('Detailer'),
    'element' => ['type' => 'static_select', 'action_id' => 'bk_refresh', 'initial_option' => $agentOpts[0], 'options' => $agentOpts]];

  // ── time: LatePoint's open slots for exactly this service/location/detailer/day
  if (!$serviceId || !$locId) {
    $b[] = ['type' => 'context', 'elements' => [['type' => 'mrkdwn', 'text' => '🕒 Open times appear here once you pick a ' . (!$locId ? 'location and ' : '') . 'service.']]];
  } else {
    $slots = bkSlots($serviceId, $locId, $agentId, $date);
    if (!$slots) {
      $b[] = ['type' => 'section', 'block_id' => 'bk_time_none', 'text' => ['type' => 'mrkdwn',
        'text' => '⚠️ No open times on *' . bkNiceDate($date) . '*' . ($agentId ? ' for that detailer' : '') . '. Try another date' . ($owner ? ', or use the owner override below.' : '.')]];
    } else {
      // Block id changes with the inputs, so a stale selection never survives a refresh.
      $key = substr(md5($serviceId . '|' . $locId . '|' . $agentId . '|' . $date), 0, 10);
      $b[] = ['type' => 'input', 'block_id' => 'bk_time_' . $key, 'optional' => $owner,
        'label' => bkPt('Time — ' . count($slots) . ' open on ' . bkNiceDate($date)),
        'element' => ['type' => 'static_select', 'action_id' => 'value', 'placeholder' => bkPt('Pick a time'),
          'options' => array_map(function ($m) { return bkOpt(bkTimeLabel($m), $m); }, array_slice($slots, 0, 100))]];
    }
  }

  if ($owner) {
    $b[] = ['type' => 'input', 'block_id' => 'bk_override', 'optional' => true, 'label' => bkPt('Owner override'),
      'element' => ['type' => 'checkboxes', 'action_id' => 'value', 'options' => [[
        'text' => ['type' => 'mrkdwn', 'text' => '*Book outside the schedule*'],
        'description' => bkPt('Ignores open slots and uses the custom time below'),
        'value' => 'on',
      ]]]];
    $b[] = ['type' => 'input', 'block_id' => 'bk_custom_time', 'optional' => true, 'label' => bkPt('Custom time (override only)'),
      'element' => ['type' => 'timepicker', 'action_id' => 'value', 'placeholder' => bkPt('Pick a time')]];
  }

  // ── customer: pick an existing one, or fill in a new one
  $b[] = ['type' => 'divider'];
  $b[] = ['type' => 'header', 'text' => bkPt('Customer')];
  $b[] = ['type' => 'input', 'block_id' => 'bk_cust', 'optional' => true, 'label' => bkPt('Existing customer'),
    'element' => ['type' => 'external_select', 'action_id' => 'value', 'placeholder' => bkPt('Search name, email or phone'), 'min_query_length' => 2]];
  $b[] = ['type' => 'context', 'elements' => [['type' => 'mrkdwn', 'text' => 'Not in the list? Leave that empty and fill in a *new customer* — LatePoint creates their account automatically.']]];
  $b[] = ['type' => 'input', 'block_id' => 'nc_first', 'optional' => true, 'label' => bkPt('New customer — first name'), 'element' => ['type' => 'plain_text_input', 'action_id' => 'value']];
  $b[] = ['type' => 'input', 'block_id' => 'nc_last',  'optional' => true, 'label' => bkPt('Last name'),  'element' => ['type' => 'plain_text_input', 'action_id' => 'value']];
  $b[] = ['type' => 'input', 'block_id' => 'nc_email', 'optional' => true, 'label' => bkPt('Email'),      'element' => ['type' => 'email_text_input', 'action_id' => 'value']];
  $b[] = ['type' => 'input', 'block_id' => 'nc_phone', 'optional' => true, 'label' => bkPt('Phone'),      'element' => ['type' => 'plain_text_input', 'action_id' => 'value', 'placeholder' => bkPt('716-555-0123')]];

  $skipped = [];
  foreach (bkCustomFields('customer') as $cf) {
    $blk = bkCfBlock($cf, 'ccf_', true, bkCfRequired($cf) ? ' (required for new customers)' : '');
    if ($blk) $b[] = $blk; else $skipped[] = $cf['label'] ?? 'field';
  }

  // ── booking details: LatePoint's booking custom fields
  $bookingFields = bkCustomFields('booking');
  if ($bookingFields) {
    $b[] = ['type' => 'divider'];
    $b[] = ['type' => 'header', 'text' => bkPt('Booking details')];
    foreach ($bookingFields as $cf) {
      $blk = bkCfBlock($cf, 'bcf_', false);
      if ($blk) $b[] = $blk; else $skipped[] = $cf['label'] ?? 'field';
    }
  }
  if ($skipped) {
    $b[] = ['type' => 'context', 'elements' => [['type' => 'mrkdwn', 'text' => '📎 File uploads can’t be done from Slack (' . bkEsc(implode(', ', $skipped)) . ') — add them on the booking in LatePoint.']]];
  }

  return [
    'type'             => 'modal',
    'callback_id'      => 'bdd_book',
    'private_metadata' => json_encode(['ch' => $ctx['ch'] ?? '', 'loc' => (int)($ctx['loc'] ?? 0)]),
    'title'            => bkPt('Book a detail'),
    'submit'           => bkPt('Book it'),
    'close'            => bkPt('Cancel'),
    'blocks'           => $b,
  ];
}

// ---------------------------------------------------------------- entry points (called from bdd-slack.php)
function bkOpen($slack, $person) {
  if (!bkReady()) { bkJson(['response_type' => 'ephemeral', 'text' => '⚠️ LatePoint isn’t active on the site, so /book can’t run right now.']); return; }
  $ctx = ['ch' => $slack['channel_id'] ?? '', 'loc' => bkLocationIdForChannel($slack['channel_name'] ?? '')];
  $res = slackApi('views.open', ['trigger_id' => $slack['trigger_id'] ?? '', 'view' => bkModal($ctx, $person)]);
  if (!$res || empty($res['ok'])) {
    $why = $res['error'] ?? 'no response from Slack';
    if (!empty($res['response_metadata']['messages'])) $why .= ' — ' . implode(' ', $res['response_metadata']['messages']);
    bkJson(['response_type' => 'ephemeral', 'text' => '⚠️ Couldn’t open the booking form (' . $why . ').']);
    return;
  }
  http_response_code(200);
}

function bkHandlePayload($payload) {
  $type   = $payload['type'] ?? '';
  $person = personFor($payload['user']['id'] ?? '');

  // Type-ahead customer search for the "Existing customer" box.
  if ($type === 'block_suggestion') {
    bkJson(['options' => ($person && bkReady()) ? bkCustomerOptions($payload['value'] ?? '') : []]);
    return;
  }
  if (!$person || !bkReady()) { http_response_code(200); return; }

  $view   = $payload['view'] ?? [];
  $ctx    = json_decode($view['private_metadata'] ?? '', true) ?: ['ch' => '', 'loc' => 0];
  $values = $view['state']['values'] ?? [];

  // Service / date / detailer / location changed → rebuild with fresh open times.
  if ($type === 'block_actions') {
    $upd = ['view_id' => $view['id'] ?? '', 'view' => bkModal($ctx, $person, $values)];
    if (!empty($view['hash'])) $upd['hash'] = $view['hash'];
    slackApi('views.update', $upd);
    http_response_code(200);
    return;
  }

  if ($type === 'view_submission') bkSubmit($payload, $person, $ctx, $values);
}

function bkCustomerOptions($q) {
  $q = trim((string)$q);
  if (mb_strlen($q) < 2) return [];
  $like = '%' . $q . '%';
  $rows = bkModels((new OsCustomerModel())->where(['OR' => [
    'CONCAT (first_name, " ", last_name) LIKE ' => $like,
    'email LIKE' => $like,
    'phone LIKE' => $like,
  ]])->set_limit(25)->order_by('first_name asc, last_name asc')->get_results_as_models());
  $out = [];
  foreach ($rows as $c) {
    $name  = trim($c->first_name . ' ' . $c->last_name);
    $extra = $c->email ?: $c->phone;
    $out[] = bkOpt(($name !== '' ? $name : 'No name') . ($extra ? ' — ' . $extra : ''), $c->id);
  }
  return $out;
}

// ---------------------------------------------------------------- submit
function bkSubmit($payload, $person, $ctx, $values) {
  $owner     = bkIsOwner($person);
  $errors    = [];
  $locId     = (int)($ctx['loc'] ?: (bkVal($values, 'bk_loc') ?? 0));
  $serviceId = (int)(bkVal($values, 'bk_service') ?? 0);
  $date      = (string)(bkVal($values, 'bk_date') ?? '');
  $agentSel  = (string)(bkVal($values, 'bk_agent') ?: 'any');
  $agentId   = $agentSel === 'any' ? 0 : (int)$agentSel;
  $override  = $owner && in_array('on', (array)(bkVal($values, 'bk_override') ?? []), true);

  $timeBlock = null;
  foreach (array_keys($values) as $k) {
    if (strpos($k, 'bk_time_') === 0 && $k !== 'bk_time_none') $timeBlock = $k;
  }

  // when
  $start = null;
  if ($override) {
    $t = (string)(bkVal($values, 'bk_custom_time') ?? '');
    if (preg_match('/^(\d{1,2}):(\d{2})$/', $t, $mm)) $start = (int)$mm[1] * 60 + (int)$mm[2];
    else $errors['bk_custom_time'] = 'Pick the time to book (the override is on).';
  } else {
    $tv = $timeBlock ? bkVal($values, $timeBlock) : null;
    if ($tv !== null && $tv !== '') $start = (int)$tv;
    elseif ($timeBlock) $errors[$timeBlock] = 'Pick a time.';
    else $errors['bk_date'] = 'No open time picked — choose a date with open times' . ($owner ? ', or turn on the owner override.' : '.');
  }
  if (!$locId && isset($values['bk_loc'])) $errors['bk_loc'] = 'Pick a location.';
  if (!$serviceId && isset($values['bk_service'])) $errors['bk_service'] = 'Pick a service.';
  if ($date !== '' && $date < current_time('Y-m-d') && !$override) $errors['bk_date'] = 'That date is in the past.';

  // who
  $customerId = (int)(bkVal($values, 'bk_cust') ?? 0);
  $nc = [
    'first_name' => trim((string)(bkVal($values, 'nc_first') ?? '')),
    'last_name'  => trim((string)(bkVal($values, 'nc_last')  ?? '')),
    'email'      => trim((string)(bkVal($values, 'nc_email') ?? '')),
    'phone'      => trim((string)(bkVal($values, 'nc_phone') ?? '')),
  ];
  $customerFields = bkCustomFields('customer');
  $ccf = [];
  if (!$customerId) {
    if ($nc['first_name'] === '') $errors['nc_first'] = 'Pick an existing customer above, or enter a first name for a new one.';
    if ($nc['email'] === '' && $nc['phone'] === '') $errors['nc_email'] = 'Add an email or phone so LatePoint can send the confirmation.';
    $ccf = bkCfValues($values, $customerFields, 'ccf_');
    foreach ($customerFields as $cf) {
      $bid = 'ccf_' . $cf['id'];
      if (bkCfRequired($cf) && isset($values[$bid]) && (!isset($ccf[$cf['id']]) || $ccf[$cf['id']] === 'off')) {
        $errors[$bid] = 'Required for new customers.';
      }
    }
  }
  $bcf = bkCfValues($values, bkCustomFields('booking'), 'bcf_');

  // The slot may have been taken while the form was open.
  if (!$errors && !$override && !in_array($start, bkSlots($serviceId, $locId, $agentId, $date), true)) {
    $errors[$timeBlock ?: 'bk_date'] = 'That time was just taken — pick another.';
  }

  if ($errors) { bkJson(['response_action' => 'errors', 'errors' => $errors]); return; }

  // Close the form now; save afterwards so LatePoint's confirmation emails can't
  // push us past Slack's 3-second limit.
  bkJson(['response_action' => 'clear']);
  bkFinishResponse();

  $r = bkCreate([
    'location_id' => $locId, 'service_id' => $serviceId, 'agent_id' => $agentId,
    'date' => $date, 'start' => $start, 'override' => $override,
    'customer_id' => $customerId, 'nc' => $nc, 'ccf' => $ccf, 'bcf' => $bcf,
    'by' => $person['label'],
  ]);

  $userId = $payload['user']['id'] ?? '';
  if ($r['ok']) {
    $msg = ['text' => $r['plain'], 'blocks' => [['type' => 'section', 'text' => ['type' => 'mrkdwn', 'text' => $r['text']]]]];
    $posted = $ctx['ch'] ? slackApi('chat.postMessage', ['channel' => $ctx['ch']] + $msg) : null;
    if (!$posted || empty($posted['ok'])) slackApi('chat.postMessage', ['channel' => $userId] + $msg); // bot not in channel → DM
  } else {
    slackApi('chat.postMessage', ['channel' => $userId, 'text' => '⚠️ Booking NOT created — ' . $r['error'] . "\nNothing was booked; run /book again."]);
  }
}

// Send the response to Slack immediately and keep running.
function bkFinishResponse() {
  ignore_user_abort(true);
  @set_time_limit(120);
  while (ob_get_level() > 0) @ob_end_flush();
  @flush();
  if (function_exists('litespeed_finish_request')) litespeed_finish_request();
  elseif (function_exists('fastcgi_finish_request')) fastcgi_finish_request();
}

// Mirrors LatePoint's admin "New Order" save (OsOrdersController::create_or_update).
function bkCreate($d) {
  try {
    $service = new OsServiceModel($d['service_id']);
    if ($service->is_new_record()) return ['ok' => false, 'error' => 'that service no longer exists.'];

    // 1) Build + validate the booking first, so a bad booking never leaves a stray new customer behind.
    $booking = new OsBookingModel();
    $booking->set_data([
      'service_id' => $d['service_id'], 'location_id' => $d['location_id'],
      'start_date' => $d['date'], 'start_time' => $d['start'], 'total_attendees' => 1,
      'custom_fields' => $d['bcf'],
    ], LATEPOINT_PARAMS_SCOPE_ADMIN);
    // set core fields directly too (set_data only copies params allowed for the scope)
    $booking->service_id      = (int)$d['service_id'];
    $booking->location_id     = (int)$d['location_id'];
    $booking->start_date      = $d['date'];
    $booking->start_time      = (int)$d['start'];
    $booking->duration        = (int)$service->duration;
    $booking->total_attendees = 1;
    if ($d['bcf'] && class_exists('OsFeatureCustomFieldsHelper')) {
      OsFeatureCustomFieldsHelper::set_custom_fields_data($booking, ['custom_fields' => $d['bcf']]);
    }
    $booking->set_buffers();
    $booking->end_time = 0;
    $booking->end_date = null;
    $booking->calculate_end_date_and_time();

    if ($d['agent_id']) {
      $booking->agent_id = (int)$d['agent_id'];
    } else {
      $booking->agent_id = LATEPOINT_ANY_AGENT;
      $aid = OsBookingHelper::get_any_agent_for_booking_by_rule($booking);
      if (!$aid && $d['override']) {
        $ids = OsAgentHelper::get_agent_ids_for_service_and_location($d['service_id'], $d['location_id']);
        $aid = $ids ? (int)reset($ids) : 0;
      }
      if (!$aid) return ['ok' => false, 'error' => 'no detailer is free for that service at that time.'];
      $booking->agent_id = (int)$aid;
    }
    $booking->set_utc_datetimes();
    if (!$booking->validate(false, ['order_item_id', 'customer_id'])) {
      return ['ok' => false, 'error' => implode(', ', $booking->get_error_messages())];
    }

    // 2) Customer — existing, matched by email, or brand new.
    $newCustomer = false;
    $matched     = false;
    if ($d['customer_id']) {
      $customer = new OsCustomerModel($d['customer_id']);
      if ($customer->is_new_record()) return ['ok' => false, 'error' => 'that customer no longer exists.'];
    } else {
      $customer = null;
      if ($d['nc']['email'] !== '') {
        $found = bkModels(OsCustomerHelper::get_by_contact($d['nc']['email'], 'email'));
        if ($found && !$found[0]->is_new_record()) { $customer = $found[0]; $matched = true; }
      }
      if (!$customer) {
        $customer = new OsCustomerModel();
        $customer->set_data($d['nc'] + ['custom_fields' => $d['ccf']], LATEPOINT_PARAMS_SCOPE_ADMIN);
        if ($d['ccf'] && class_exists('OsFeatureCustomFieldsHelper')) {
          OsFeatureCustomFieldsHelper::set_custom_fields_data($customer, ['custom_fields' => $d['ccf']]);
        }
        if (!$customer->save()) {
          return ['ok' => false, 'error' => 'couldn’t create the customer — ' . implode(', ', $customer->get_error_messages())];
        }
        do_action('latepoint_customer_created', $customer);
        $newCustomer = true;
      }
    }
    $booking->customer_id = (int)$customer->id;

    // 3) Order → order item → booking, same as LatePoint's admin form.
    $order = new OsOrderModel();
    $order->customer_id = (int)$customer->id;
    $order->set_initial_payment_data_value('time', LATEPOINT_PAYMENT_TIME_LATER);
    if (!$order->save()) return ['ok' => false, 'error' => 'couldn’t create the order — ' . implode(', ', $order->get_error_messages())];

    $item = new OsOrderItemModel();
    $item->variant  = LATEPOINT_ITEM_VARIANT_BOOKING;
    $item->order_id = $order->id;
    if (!$item->save()) return ['ok' => false, 'error' => 'couldn’t create the order item — ' . implode(', ', $item->get_error_messages())];

    $booking->order_item_id = $item->id;
    if (!$booking->save()) return ['ok' => false, 'error' => 'couldn’t save the booking — ' . implode(', ', $booking->get_error_messages())];

    $item->item_data = $booking->generate_item_data();
    $item->recalculate_prices();
    $item->save();
    do_action('latepoint_booking_created', $booking);

    try {
      $order->subtotal = $order->recalculate_subtotal();
      $order->total    = $order->recalculate_total();
      $order->save();
    } catch (\Throwable $e) { /* totals are cosmetic here; the booking already exists */ }
    if (class_exists('OsInvoicesHelper')) OsInvoicesHelper::create_invoices_for_new_order($order, null);
    do_action('latepoint_order_created', $order);

    // 4) Summary for the channel.
    $agent = new OsAgentModel($booking->agent_id);
    $cname = trim($customer->first_name . ' ' . $customer->last_name) ?: 'Customer';
    $when  = bkNiceDate($d['date']) . ' at ' . bkTimeLabel($d['start']);
    $notes = [];
    if ($d['override']) $notes[] = '⚠️ outside the schedule';
    if ($newCustomer)   $notes[] = 'new customer account created';
    if ($matched)       $notes[] = 'matched an existing customer by email';
    $text = '📅 *New booking* — *' . bkEsc($cname) . '* · ' . bkEsc($service->name) . "\n"
          . $when . ' · ' . bkEsc(bkLocationName($d['location_id'])) . ' · ' . bkEsc(bkAgentName($agent)) . "\n"
          . '_Booked by ' . bkEsc($d['by']) . ($notes ? ' · ' . implode(' · ', $notes) : '') . ' · code ' . bkEsc($booking->booking_code) . '_';
    return ['ok' => true, 'text' => $text, 'plain' => 'New booking: ' . $cname . ', ' . $service->name . ', ' . $when];
  } catch (\Throwable $e) {
    return ['ok' => false, 'error' => 'unexpected error — ' . $e->getMessage()];
  }
}
