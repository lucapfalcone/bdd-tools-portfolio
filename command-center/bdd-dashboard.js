(function(){
var API   = 'https://example.com/bdd-supply-api.php';
var TOKEN = 'YOUR_SUPPLY_API_SECRET_HERE'; // must match BDD_SUPPLY_SECRET in bdd-supply-api.php

// Payout Calculator's own API — used here READ-ONLY to pull the hero stats.
// Keep this in sync with the `API`/`TOKEN` vars at the top of bdd-calc-v7.js.
var PAYOUT_API   = 'https://example.com/bdd-api.php';
var PAYOUT_TOKEN = 'YOUR_PAYOUT_API_SECRET_HERE';

var PEOPLE = [
  {id:'jordan', label:'Jordan', role:'owner'},
  {id:'avery',   label:'Avery',   role:'owner'},
  {id:'harlan',   label:'Harlan',   role:'manager'},
  {id:'sawyer',   label:'Sawyer',   role:'manager'}
];

var LOCATIONS = ['Springfield', 'Riverside'];
var SUPPLY_STATUSES = ['Requested', 'Ordered', 'Received'];
var TODO_GROUPS = ['Springfield', 'Riverside', 'Leadership'];
var INVENTORY_STATUSES = ['Good', 'Almost Out', 'Out'];
var INVENTORY_CATEGORIES = ['Blue Trunk', 'Tool Bag', 'Solutions', 'Machinery', 'Microfiber Materials'];

// Item catalog mirrors Inventory/Inventory.csv — used only to populate the dropdown,
// not read live. Update here when the master inventory list changes materially.
var ITEM_CATALOG = {
  'Blue Trunk': ['Interior Brushes','Orange Q Tips','Carpet Liner','Quick Connects','Steering Wheel Covers','Tire Shine Pads','Tire Brushes','Thread Tape','Dog Hair Scraper','Drill Brush Heads','Drills + Batteries','Tiny Stiff Brushes','Exterior Brushes','Extension Cords','Air Compressor Hose','Pressure Washer Gun'],
  'Tool Bag': ['Spray Bottles w/ Labels','VRP','Iron Remover','Leather Detailer','Chrome Wheel Cleaner','Mini Trees','Tire Shine','Bug Remover','Pre Wash'],
  'Solutions': ['Carpet Bomber','Bead Maker','Interior Cleaner','Brake Buster','Enzyme Spot & Stain','Mcguires Wash','Glass Cleaner'],
  'Machinery': ['Steamer','Pressure Foam Cannons','Handheld Foam Cannon','Shop Vac','Pressure Washer','Buckets','Tire Pressure Checker'],
  'Microfiber Materials': ['Broom Scrubber','Broom Pads','VRP Pads','Interior Cloths','Paint Drying Rags','Tire Drying Rags','Drying Mitts','Seat Rags']
};

var supplyRecords = [];
var todoRecords   = [];
var inventoryRecords = [];
var supplyLocFilter = 'all';
var supplyStatusFilter = 'all';
var todoGroupFilter = 'Springfield';
var inventoryCatFilter = 'all';
var inventorySort = { key: 'status', dir: 1 }; // default: problems first

// Inventory is kept per location (Springfield = SPR, Riverside = RIV). The SPR | RIV
// toggle picks which one the Restock Board + Inventory table show; remembered per browser.
var INV_LOC_CODES = {Springfield: 'SPR', Riverside: 'RIV'};
var invLoc = 'Springfield';
// Stored as 'bdd-location' — shared with the Payout Calculator, so both open on the same location.
try { var savedInvLoc = localStorage.getItem('bdd-location') || localStorage.getItem('bddcc-invloc'); if (INV_LOC_CODES[savedInvLoc]) invLoc = savedInvLoc; } catch (e) {}
function invLocOf(r){ return r.location || 'Springfield'; } // records from before the split count as Springfield
function locInventory(){ return inventoryRecords.filter(function(r){ return invLocOf(r) === invLoc; }); }

var payoutStats = {profit: null, jobs: null};
var payoutJobs; // raw jobs from the Payout Calculator (read-only); filtered per location in renderStats

function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function hdr(){ return {'Content-Type':'application/json','X-BDD-Token':TOKEN}; }
function fmtMoney(n){ return '$' + Number(n||0).toFixed(0); }
function personLabel(id){ var p = PEOPLE.filter(function(p){ return p.id === id; })[0]; return p ? p.label : id; }
function personRole(id){ var p = PEOPLE.filter(function(p){ return p.id === id; })[0]; return p ? p.role : ''; }
function locClass(loc){ return loc === 'Riverside' ? 'riv' : 'spr'; }
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,8); }
function todayStr(){ var d=new Date(),p=function(n){return String(n).padStart(2,'0');}; return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()); }

// toast(msg) — or toast(msg, {label:'Undo', fn:...}) to add an action button.
var toastTimer;
function toast(msg, action){
  var t = document.getElementById('bdd-cc-toast'); if(!t) return;
  t.innerHTML = '';
  var span = document.createElement('span'); span.textContent = msg; t.appendChild(span);
  if (action) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'bdd-cc-toast-btn'; b.textContent = action.label;
    b.onclick = function(){ t.classList.remove('show'); action.fn(); };
    t.appendChild(b);
  }
  t.classList.toggle('has-action', !!action);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ t.classList.remove('show'); }, action ? 5000 : 2400);
}

// ---------------------------------------------------------------- fetch helpers
async function apiGet(resource){
  var res = await fetch(API + '?resource=' + resource, {headers: hdr()});
  if (!res.ok) throw new Error('GET ' + resource + ' failed');
  return res.json();
}
async function apiPost(resource, record){
  var res = await fetch(API + '?resource=' + resource, {method:'POST', headers:hdr(), body:JSON.stringify(record)});
  if (!res.ok) throw new Error('POST ' + resource + ' failed');
  return res.json();
}
async function apiPut(resource, record){
  var res = await fetch(API + '?resource=' + resource, {method:'PUT', headers:hdr(), body:JSON.stringify(record)});
  if (!res.ok) throw new Error('PUT ' + resource + ' failed');
  return res.json();
}
async function apiDelete(resource, id){
  var res = await fetch(API + '?resource=' + resource + '&id=' + encodeURIComponent(id), {method:'DELETE', headers:hdr()});
  if (!res.ok) throw new Error('DELETE ' + resource + ' failed');
  return res.json();
}

async function loadAll(){
  try {
    var results = await Promise.all([apiGet('supply'), apiGet('todo'), apiGet('inventory')]);
    supplyRecords    = results[0] || [];
    todoRecords      = results[1] || [];
    inventoryRecords = results[2] || [];
  } catch (e) {
    toast('Could not reach the dashboard API — check the token/URL in bdd-dashboard.js');
  }
  renderSupply();
  renderTodos();
  renderInventory();
  fetchPayoutStats(); // fires its own render when it resolves — never blocks the above
}

// ---------------------------------------------------------------- Hero stats
// Mirrors the "week" boundary used by bdd-calc-v7.js's own filtered() (Mon–Sun)
// so "This Week" means the same thing in both tools.
async function fetchPayoutStats(){
  try {
    var res = await fetch(PAYOUT_API, {headers: {'X-BDD-Token': PAYOUT_TOKEN}});
    if (!res.ok) throw new Error('payout fetch failed');
    payoutJobs = await res.json();
    if (!Array.isArray(payoutJobs)) payoutJobs = [];
  } catch (e) {
    payoutJobs = null;
  }
  // Say so on the hero when the Payout Calculator can't be reached, instead of a silent dash.
  var sub = document.getElementById('bdd-cc-hero-sub');
  if (sub) sub.textContent = payoutJobs === null
    ? 'Couldn’t reach the Payout Calculator — reload the page'
    : 'Pulled from the Payout Calculator (read-only)';
  renderStats();
}

// This week's (Mon–Sun) net profit + job count for the location on screen.
// Jobs saved before locations existed count as Springfield.
function computePayoutStats(){
  if (!Array.isArray(payoutJobs)) { payoutStats.profit = null; payoutStats.jobs = null; return; }
  var now = new Date(), weekStart = new Date(now);
  weekStart.setDate(now.getDate() - (now.getDay() === 0 ? 6 : now.getDay() - 1));
  weekStart.setHours(0,0,0,0);
  var weekJobs = payoutJobs.filter(function(j){
    return (j.location || 'Springfield') === invLoc && new Date((j.date || '') + 'T12:00:00') >= weekStart;
  });
  payoutStats.profit = weekJobs.reduce(function(sum, j){ return sum + (j.profit || 0); }, 0);
  payoutStats.jobs   = weekJobs.length;
}

function renderStats(){
  computePayoutStats();
  var profitEl   = document.getElementById('bdd-cc-stat-profit');
  var jobsEl     = document.getElementById('bdd-cc-stat-jobs');
  var supplyEl   = document.getElementById('bdd-cc-stat-supply');
  var todoEl     = document.getElementById('bdd-cc-stat-todo');
  var lowstockEl = document.getElementById('bdd-cc-stat-lowstock');

  if (profitEl) profitEl.textContent = payoutStats.profit === null ? '—' : fmtMoney(payoutStats.profit);
  if (jobsEl)   jobsEl.textContent   = payoutStats.jobs === null ? '—' : payoutStats.jobs;
  if (supplyEl) supplyEl.textContent = supplyRecords.filter(function(r){ return (r.location || 'Springfield') === invLoc && r.status !== 'Received'; }).length;
  if (todoEl)   todoEl.textContent   = todoRecords.filter(function(r){ return r.status === 'Open' && (r.group === invLoc || r.group === 'Leadership'); }).length;
  if (lowstockEl) lowstockEl.textContent = inventoryRecords.filter(function(r){ return invLocOf(r) === invLoc && r.status && r.status !== 'Good'; }).length;
}

// ---------------------------------------------------------------- Supply Orders
function buildItemOptions(){
  var html = '<option value="">Select item…</option>';
  Object.keys(ITEM_CATALOG).forEach(function(cat){
    html += '<optgroup label="' + esc(cat) + '">';
    ITEM_CATALOG[cat].forEach(function(item){
      html += '<option value="' + esc(item) + '">' + esc(item) + '</option>';
    });
    html += '</optgroup>';
  });
  html += '<option value="__other__">Other (type below)</option>';
  return html;
}

function onItemSelectChange(sel){
  var otherInput = document.getElementById('bdd-cc-item-other');
  if (!otherInput) return;
  otherInput.style.display = sel.value === '__other__' ? 'block' : 'none';
}

async function submitSupplyRequest(ev){
  ev.preventDefault();
  var loc      = document.getElementById('bdd-cc-supply-loc').value;
  var itemSel  = document.getElementById('bdd-cc-item-select').value;
  var itemOther= document.getElementById('bdd-cc-item-other').value.trim();
  var item     = itemSel === '__other__' ? itemOther : itemSel;
  var qty      = document.getElementById('bdd-cc-supply-qty').value;
  var by       = document.getElementById('bdd-cc-supply-by').value;
  var notes    = document.getElementById('bdd-cc-supply-notes').value.trim();

  if (!item) { toast('Pick an item, or type one under "Other".'); return; }
  if (!qty || Number(qty) <= 0) { toast('Enter a quantity.'); return; }

  var record = {
    id: uid(), location: loc, item: item, qty: Number(qty), requestedBy: by,
    notes: notes, status: 'Requested', createdAt: new Date().toISOString(),
    history: [{status:'Requested', by: by, at: new Date().toISOString()}]
  };

  try {
    await apiPost('supply', record);
    supplyRecords.unshift(record);
    renderSupply();
    toast('Supply request sent.');
    document.getElementById('bdd-cc-supply-form').reset();
    syncLocToggles();
    onItemSelectChange(document.getElementById('bdd-cc-item-select'));
  } catch (e) {
    toast('Could not save the request — try again.');
  }
}

async function advanceSupplyStatus(id){
  var record = supplyRecords.filter(function(r){ return r.id === id; })[0];
  if (!record) return;
  var idx = SUPPLY_STATUSES.indexOf(record.status);
  if (idx === -1 || idx >= SUPPLY_STATUSES.length - 1) return;
  var nextStatus = SUPPLY_STATUSES[idx + 1];
  var actor = prompt('Mark as "' + nextStatus + '" — who is updating this? (name)', '');
  if (actor === null) return;

  var updated = Object.assign({}, record, {status: nextStatus});
  updated.history = (record.history || []).concat([{status: nextStatus, by: actor || '?', at: new Date().toISOString()}]);

  try {
    await apiPut('supply', updated);
    supplyRecords = supplyRecords.map(function(r){ return r.id === id ? updated : r; });
    renderSupply();
    toast('Marked ' + nextStatus + '.');
  } catch (e) {
    toast('Could not update status — try again.');
  }
}

async function deleteSupply(id){
  if (!confirm('Delete this supply request?')) return;
  try {
    await apiDelete('supply', id);
    supplyRecords = supplyRecords.filter(function(r){ return r.id !== id; });
    renderSupply();
    toast('Deleted.');
  } catch (e) {
    toast('Could not delete — try again.');
  }
}

function setSupplyFilter(kind, val){
  if (kind === 'loc') supplyLocFilter = val; else supplyStatusFilter = val;
  renderSupply();
}

function renderSupply(){
  var wrap = document.getElementById('bdd-cc-supply-list');
  if (!wrap) return;

  document.querySelectorAll('.bdd-cc-pill[data-supply-loc]').forEach(function(p){
    p.classList.toggle('active', p.getAttribute('data-supply-loc') === supplyLocFilter);
  });
  document.querySelectorAll('.bdd-cc-pill[data-supply-status]').forEach(function(p){
    p.classList.toggle('active', p.getAttribute('data-supply-status') === supplyStatusFilter);
  });

  var rows = supplyRecords.filter(function(r){
    if ((r.location || 'Springfield') !== invLoc) return false; // the whole page is per location
    if (supplyStatusFilter !== 'all' && r.status !== supplyStatusFilter) return false;
    return true;
  });

  renderStats();
  if (rs.built) rsRenderDynamic(); // keeps the Restock Board's "requested" badges current

  if (!rows.length) {
    wrap.innerHTML = '<div class="bdd-cc-empty">No supply requests match this filter.</div>';
    return;
  }

  wrap.innerHTML = rows.map(function(r){
    var nextStatus = SUPPLY_STATUSES[SUPPLY_STATUSES.indexOf(r.status) + 1];
    return '' +
      '<div class="bdd-cc-row">' +
        '<div class="bdd-cc-row-main">' +
          '<span class="bdd-cc-loc-dot ' + locClass(r.location) + '"></span>' +
          '<div class="bdd-cc-row-text">' +
            '<div class="bdd-cc-row-title">' + esc(r.qty) + 'x ' + esc(r.item) + '</div>' +
            '<div class="bdd-cc-row-sub">' + esc(r.location) + ' &middot; requested by ' + esc(personLabel(r.requestedBy)) + (r.notes ? ' &middot; ' + esc(r.notes) : '') + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="bdd-cc-row-actions">' +
          '<span class="bdd-cc-status-badge st-' + r.status.toLowerCase() + '">' + esc(r.status) + '</span>' +
          (nextStatus ? '<button class="bdd-cc-btn-sm" onclick="BDDCC.advanceSupply(\'' + r.id + '\')">Mark ' + esc(nextStatus) + '</button>' : '') +
          '<button class="bdd-cc-btn-icon" onclick="BDDCC.deleteSupply(\'' + r.id + '\')" title="Delete">&times;</button>' +
        '</div>' +
      '</div>';
  }).join('');
}

// ---------------------------------------------------------------- To-Dos
async function submitTodo(ev){
  ev.preventDefault();
  var task     = document.getElementById('bdd-cc-todo-task').value.trim();
  var group    = document.getElementById('bdd-cc-todo-group').value;
  var assignee = document.getElementById('bdd-cc-todo-assignee').value;
  var due      = document.getElementById('bdd-cc-todo-due').value;
  var notes    = document.getElementById('bdd-cc-todo-notes').value.trim();

  if (!task) { toast('Enter a task.'); return; }

  var record = {
    id: uid(), task: task, group: group, assignee: assignee, due: due,
    notes: notes, status: 'Open', createdAt: new Date().toISOString()
  };

  try {
    await apiPost('todo', record);
    todoRecords.unshift(record);
    renderTodos();
    toast('Task added.');
    document.getElementById('bdd-cc-todo-form').reset();
    syncLocToggles();
  } catch (e) {
    toast('Could not save the task — try again.');
  }
}

async function toggleTodo(id){
  var record = todoRecords.filter(function(r){ return r.id === id; })[0];
  if (!record) return;
  var updated = Object.assign({}, record, {status: record.status === 'Open' ? 'Done' : 'Open'});
  try {
    await apiPut('todo', updated);
    todoRecords = todoRecords.map(function(r){ return r.id === id ? updated : r; });
    renderTodos();
  } catch (e) {
    toast('Could not update task — try again.');
  }
}

async function deleteTodo(id){
  if (!confirm('Delete this task?')) return;
  try {
    await apiDelete('todo', id);
    todoRecords = todoRecords.filter(function(r){ return r.id !== id; });
    renderTodos();
    toast('Deleted.');
  } catch (e) {
    toast('Could not delete — try again.');
  }
}

function setTodoFilter(group){
  todoGroupFilter = group;
  renderTodos();
}

function renderTodos(){
  var wrap = document.getElementById('bdd-cc-todo-list');
  if (!wrap) return;

  document.querySelectorAll('.bdd-cc-pill[data-todo-group]').forEach(function(p){
    p.classList.toggle('active', p.getAttribute('data-todo-group') === todoGroupFilter);
  });

  var today = todayStr();
  var rows = todoRecords
    .filter(function(r){ return r.group === todoGroupFilter; })
    .sort(function(a,b){
      if (a.status !== b.status) return a.status === 'Open' ? -1 : 1;
      return (a.due || '9999').localeCompare(b.due || '9999');
    });

  renderStats();

  if (!rows.length) {
    wrap.innerHTML = '<div class="bdd-cc-empty">No tasks for ' + esc(todoGroupFilter) + ' yet.</div>';
    return;
  }

  wrap.innerHTML = rows.map(function(r){
    var overdue = r.status === 'Open' && r.due && r.due < today;
    return '' +
      '<div class="bdd-cc-row ' + (r.status === 'Done' ? 'done' : '') + '">' +
        '<div class="bdd-cc-row-main">' +
          '<input type="checkbox" class="bdd-cc-check" ' + (r.status === 'Done' ? 'checked' : '') + ' onchange="BDDCC.toggleTodo(\'' + r.id + '\')">' +
          '<div class="bdd-cc-row-text">' +
            '<div class="bdd-cc-row-title">' + esc(r.task) + '</div>' +
            '<div class="bdd-cc-row-sub">' +
              (r.assignee ? esc(personLabel(r.assignee)) + ' &middot; ' : '') +
              (r.due ? '<span class="' + (overdue ? 'bdd-cc-overdue' : '') + '">due ' + esc(r.due) + '</span>' : 'no due date') +
              (r.notes ? ' &middot; ' + esc(r.notes) : '') +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="bdd-cc-row-actions">' +
          '<button class="bdd-cc-btn-icon" onclick="BDDCC.deleteTodo(\'' + r.id + '\')" title="Delete">&times;</button>' +
        '</div>' +
      '</div>';
  }).join('');
}

// ---------------------------------------------------------------- Inventory
function invStatusClass(s){
  return s === 'Out' ? 'out' : (s === 'Almost Out' ? 'low' : 'ok');
}

async function submitInventoryItem(ev){
  ev.preventDefault();
  var name   = document.getElementById('bdd-cc-inv-name').value.trim();
  var cat    = document.getElementById('bdd-cc-inv-cat').value;
  var qty    = document.getElementById('bdd-cc-inv-qty-new').value;
  var status = document.getElementById('bdd-cc-inv-status-new').value;
  var notes  = document.getElementById('bdd-cc-inv-notes').value.trim();
  var locSel = (document.getElementById('bdd-cc-inv-loc') || {}).value || invLoc;
  var locs   = locSel === 'both' ? Object.keys(INV_LOC_CODES) : [locSel];

  if (!name) { toast('Enter an item name.'); return; }

  try {
    for (var i = 0; i < locs.length; i++) {
      var record = {
        id: uid(), name: name, category: cat, qty: Number(qty) || 0,
        status: status, notes: notes, location: locs[i]
      };
      await apiPost('inventory', record);
      inventoryRecords.unshift(record);
    }
    renderInventory();
    toast(locs.length > 1 ? 'Item added to both locations.' : 'Item added to ' + locs[0] + '.');
    document.getElementById('bdd-cc-inv-form').reset();
    syncLocToggles();
  } catch (e) {
    toast('Could not save the item — try again.');
  }
}

// Returns true on success so callers (Undo, bulk) know whether it stuck.
async function saveInventoryField(id, field, value){
  var record = inventoryRecords.filter(function(r){ return String(r.id) === String(id); })[0];
  if (!record) return false;
  var updated = Object.assign({}, record);
  updated[field] = field === 'qty' ? (Number(value) || 0) : value;
  updated.updatedAt = new Date().toISOString();
  delete updated.updatedBy; // the dashboard can't tell who's signed in; Slack's /stock sets this
  try {
    await apiPut('inventory', updated);
    inventoryRecords = inventoryRecords.map(function(r){ return String(r.id) === String(id) ? updated : r; });
    renderInventory();
    return true;
  } catch (e) {
    toast('Could not update — try again.');
    return false;
  }
}

async function deleteInventoryItem(id){
  if (!confirm('Delete this inventory item?')) return;
  try {
    await apiDelete('inventory', id);
    inventoryRecords = inventoryRecords.filter(function(r){ return r.id !== id; });
    renderInventory();
    toast('Deleted.');
  } catch (e) {
    toast('Could not delete — try again.');
  }
}

function setInventoryFilter(cat){
  inventoryCatFilter = cat;
  renderInventory();
}

function setInventorySort(key){
  if (inventorySort.key === key) inventorySort.dir *= -1;
  else { inventorySort.key = key; inventorySort.dir = 1; }
  renderInventory();
}

// Out sorts before Almost Out before Good, so problems float to the top.
function invSeverity(s){ return s === 'Out' ? 0 : (s === 'Almost Out' ? 1 : 2); }

function inventoryRowHtml(r){
  var cls = invStatusClass(r.status); // ok / low / out
  var statusOpts = INVENTORY_STATUSES.map(function(s){
    return '<option value="' + esc(s) + '"' + (s === r.status ? ' selected' : '') + '>' + esc(s) + '</option>';
  }).join('');
  return '' +
    '<tr class="bdd-cc-inv-tr ' + cls + '">' +
      '<td class="bdd-cc-inv-name">' + esc(r.name) + '</td>' +
      '<td class="bdd-cc-inv-cat">' + esc(r.category || '') + '</td>' +
      '<td class="bdd-cc-inv-qtycell">' +
        '<input type="number" class="bdd-cc-inv-qty" min="0" step="1" value="' + esc(r.qty) + '" title="Quantity" onchange="BDDCC.saveInvField(\'' + r.id + '\',\'qty\',this.value)">' +
      '</td>' +
      '<td class="bdd-cc-inv-statuscell">' +
        '<select class="bdd-cc-inv-status ' + cls + '" onchange="BDDCC.saveInvField(\'' + r.id + '\',\'status\',this.value)">' + statusOpts + '</select>' +
      '</td>' +
      '<td class="bdd-cc-inv-notecell">' +
        '<input type="text" class="bdd-cc-inv-note" value="' + esc(r.notes || '') + '" placeholder="—" onchange="BDDCC.saveInvField(\'' + r.id + '\',\'notes\',this.value)">' +
      '</td>' +
      '<td class="bdd-cc-inv-delcell">' +
        '<button class="bdd-cc-btn-icon" onclick="BDDCC.deleteInvItem(\'' + r.id + '\')" title="Delete">&times;</button>' +
      '</td>' +
    '</tr>';
}

function renderInventory(){
  renderRestock(); // the big board at the top reads the same records
  var wrap = document.getElementById('bdd-cc-inv-list');
  if (!wrap) return;

  document.querySelectorAll('.bdd-cc-pill[data-inv-cat]').forEach(function(p){
    p.classList.toggle('active', p.getAttribute('data-inv-cat') === inventoryCatFilter);
  });

  renderStats();

  var rows = inventoryRecords.filter(function(r){
    return invLocOf(r) === invLoc && (inventoryCatFilter === 'all' || r.category === inventoryCatFilter);
  });

  if (!rows.length) {
    wrap.innerHTML = '<div class="bdd-cc-empty">No ' + esc(invLoc) + ' inventory items' + (inventoryCatFilter === 'all' ? ' yet.' : ' in ' + esc(inventoryCatFilter) + '.') + '</div>';
    return;
  }

  var k = inventorySort.key, d = inventorySort.dir;
  rows = rows.slice().sort(function(a, b){
    var av, bv;
    if (k === 'status')    { av = invSeverity(a.status); bv = invSeverity(b.status); }
    else if (k === 'qty')  { av = Number(a.qty) || 0;    bv = Number(b.qty) || 0; }
    else                   { av = String(a[k] || '').toLowerCase(); bv = String(b[k] || '').toLowerCase(); }
    if (av < bv) return -d;
    if (av > bv) return d;
    var ac = String(a.category || '').toLowerCase(), bc = String(b.category || '').toLowerCase();
    if (ac !== bc) return ac < bc ? -1 : 1;
    return String(a.name || '').toLowerCase() < String(b.name || '').toLowerCase() ? -1 : 1;
  });

  var outN = rows.filter(function(r){ return r.status === 'Out'; }).length;
  var lowN = rows.filter(function(r){ return r.status === 'Almost Out'; }).length;

  function arrow(key){ return inventorySort.key === key ? (inventorySort.dir === 1 ? ' ▲' : ' ▼') : ''; }

  var summary = '<div class="bdd-cc-inv-summary"><b>' + esc(invLoc) + ' (' + INV_LOC_CODES[invLoc] + ')</b> &middot; ' + rows.length + ' item' + (rows.length === 1 ? '' : 's') +
    ' &middot; <span class="sev-out">' + outN + ' Out</span>' +
    ' &middot; <span class="sev-low">' + lowN + ' Almost Out</span></div>';

  var table = '<div class="bdd-cc-inv-tablewrap"><table class="bdd-cc-inv-table"><thead><tr>' +
      '<th class="s" onclick="BDDCC.setInvSort(\'name\')">Item' + arrow('name') + '</th>' +
      '<th class="s" onclick="BDDCC.setInvSort(\'category\')">Category' + arrow('category') + '</th>' +
      '<th class="s" onclick="BDDCC.setInvSort(\'qty\')">Qty' + arrow('qty') + '</th>' +
      '<th class="s" onclick="BDDCC.setInvSort(\'status\')">Status' + arrow('status') + '</th>' +
      '<th>Notes</th>' +
      '<th></th>' +
    '</tr></thead><tbody>' +
    rows.map(inventoryRowHtml).join('') +
    '</tbody></table></div>';

  wrap.innerHTML = summary + table;
}

// ---------------------------------------------------------------- Restock Board
// The at-a-glance view at the top of the page — built for scanning and one-tap
// updates, with the detail one level down:
//   • KPI tiles (tap to filter) · stock-health bar · per-category heat map
//     (tap any square for a quick status menu, tap a category to filter)
//   • toolbar: live search ("/" jumps to it), view switch, category chips
//   • grouped list (Out → Almost Out): 3-way status switch, qty stepper,
//     "already requested?" badge pulled from Supply Orders, Request button
//   • multi-select → bulk "Request restock" / "Mark restocked"
// Same inventoryRecords as the full table below; status changes offer Undo.
var RS_VIEWS = [
  {id: 'problems',   label: 'Needs attention'},
  {id: 'need',       label: 'Not requested'},
  {id: 'Out',        label: 'Out'},
  {id: 'Almost Out', label: 'Almost Out'},
  {id: 'all',        label: 'All items'}
];
var RS_STATUSES = [['Out', 'Out', 'out'], ['Almost Out', 'Low', 'low'], ['Good', 'Good', 'ok']];
var rs = {q: '', view: 'problems', cat: 'all', sel: {}, built: false, qtyTimers: {}, bulkLoc: 'Springfield', bulkBy: ''};
try {
  var rsSaved = JSON.parse(localStorage.getItem('bddcc-restock') || '{}');
  if (rsSaved.view) rs.view = rsSaved.view;
  if (rsSaved.cat)  rs.cat  = rsSaved.cat;
} catch (e) {}
function rsPersist(){ try { localStorage.setItem('bddcc-restock', JSON.stringify({view: rs.view, cat: rs.cat})); } catch (e) {} }

function rsStatusOf(r){ return r.status === 'Out' || r.status === 'Almost Out' ? r.status : 'Good'; }
function rsIsProblem(r){ return rsStatusOf(r) !== 'Good'; }
function rsFind(id){ return inventoryRecords.filter(function(r){ return String(r.id) === String(id); })[0] || null; }
function rsJsId(id){ return esc(String(id)).replace(/'/g, "\\'"); }

function restockCats(){
  var cats = INVENTORY_CATEGORIES.slice();
  locInventory().forEach(function(r){
    var c = r.category || 'Other';
    if (cats.indexOf(c) === -1) cats.push(c);
  });
  return cats;
}

function relTime(iso){
  if (!iso) return '';
  var t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  var s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60)        return 'just now';
  if (s < 3600)      return Math.floor(s / 60) + 'm ago';
  if (s < 86400)     return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
  return new Date(t).toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
}

// Most recent supply request for this item that hasn't been Received yet.
function openRequestFor(name, loc){
  var key = String(name || '').trim().toLowerCase();
  var hits = supplyRecords.filter(function(r){
    return r.status !== 'Received' && String(r.item || '').trim().toLowerCase() === key &&
      (!loc || (r.location || '') === loc);
  });
  hits.sort(function(a, b){ return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
  return hits[0] || null;
}

// Filters: view (ignores search + category), search, category.
function rsInView(r, view){
  if (view === 'all')      return true;
  if (view === 'problems') return rsIsProblem(r);
  if (view === 'need')     return rsIsProblem(r) && !openRequestFor(r.name, invLocOf(r));
  return rsStatusOf(r) === view;
}
function rsMatchesSearch(r){
  if (!rs.q) return true;
  return (r.name + ' ' + (r.category || '') + ' ' + (r.notes || '')).toLowerCase().indexOf(rs.q) !== -1;
}
function rsInCat(r, cat){ return cat === 'all' || (r.category || 'Other') === cat; }
function rsVisible(r){ return invLocOf(r) === invLoc && rsInView(r, rs.view) && rsInCat(r, rs.cat) && rsMatchesSearch(r); }

function rsSegHtml(r){
  var cur = rsStatusOf(r), id = rsJsId(r.id);
  return RS_STATUSES.map(function(s){
    var on = cur === s[0];
    return '<button type="button" class="' + s[2] + (on ? ' on' : '') + '" aria-pressed="' + on + '" title="Set ' + esc(s[0]) + '" onclick="BDDCC.rsStatus(\'' + id + '\',\'' + s[0] + '\')">' + s[1] + '</button>';
  }).join('');
}

// Static skeleton — built once so the search box keeps focus while typing.
function rsBuild(wrap){
  wrap.innerHTML =
    '<div class="rs-dash"><div class="rs-kpis" id="rs-kpis"></div><div class="rs-health" id="rs-health"></div></div>' +
    '<div class="rs-toolbar">' +
      '<label class="rs-search">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' +
        '<input id="rs-q" type="search" placeholder="Search items, categories, notes…" autocomplete="off" aria-label="Search inventory">' +
        '<kbd title="Press / to search">/</kbd>' +
      '</label>' +
      '<div class="rs-seg" id="rs-views" role="group" aria-label="Show"></div>' +
    '</div>' +
    '<div class="rs-chips" id="rs-chips" role="group" aria-label="Category"></div>' +
    '<div class="rs-bulk" id="rs-bulk" hidden></div>' +
    '<div class="rs-list" id="rs-list"></div>';
  var q = document.getElementById('rs-q');
  q.value = rs.q;
  q.addEventListener('input', function(){ rs.q = q.value.trim().toLowerCase(); rsRenderDynamic(); });
  q.addEventListener('keydown', function(e){
    if (e.key === 'Escape') { q.value = ''; rs.q = ''; rsRenderDynamic(); q.blur(); }
  });
  rs.built = true;
}

function renderRestock(){
  var wrap = document.getElementById('bdd-cc-restock');
  if (!wrap) return;
  if (!locInventory().length) {
    wrap.innerHTML = '<div class="bdd-cc-empty">No ' + esc(invLoc) + ' inventory items yet — add some in the Inventory section below.</div>';
    rs.built = false;
    return;
  }
  if (!rs.built || !document.getElementById('rs-list')) rsBuild(wrap);
  rsRenderDynamic();
}

function rsRenderDynamic(){
  if (!document.getElementById('rs-list')) return;
  var all   = locInventory();
  var outN  = all.filter(function(r){ return rsStatusOf(r) === 'Out'; }).length;
  var lowN  = all.filter(function(r){ return rsStatusOf(r) === 'Almost Out'; }).length;
  var needN = all.filter(function(r){ return rsInView(r, 'need'); }).length;
  var okN   = all.length - outN - lowN;

  Object.keys(rs.sel).forEach(function(id){ if (!rsFind(id)) delete rs.sel[id]; });

  // ── KPI tiles (tap = filter the list)
  function kpi(cls, n, label, sub, view){
    var on = rs.view === view;
    return '<button type="button" class="rs-kpi ' + cls + (on ? ' on' : '') + '" aria-pressed="' + on + '" onclick="BDDCC.rsView(\'' + view + '\')">' +
      '<span class="rs-kpi-n">' + n + '</span><span class="rs-kpi-l">' + label + '</span><span class="rs-kpi-s">' + sub + '</span></button>';
  }
  document.getElementById('rs-kpis').innerHTML =
    kpi('out' + (outN ? ' hot' : ''), outN, 'Out', 'reorder now', 'Out') +
    kpi('low', lowN, 'Almost Out', 'order soon', 'Almost Out') +
    kpi('need', needN, 'Not requested', 'low or out, no supply request yet', 'need') +
    kpi('ok', okN, 'Stocked', 'of ' + all.length + ' items', 'all');

  // ── Health bar + heat map (one square per item)
  function pct(n){ return (n / all.length * 100).toFixed(2); }
  var heat = restockCats().map(function(c){
    var items = all
      .filter(function(r){ return (r.category || 'Other') === c; })
      .sort(function(a, b){ return invSeverity(rsStatusOf(a)) - invSeverity(rsStatusOf(b)) || String(a.name).localeCompare(String(b.name)); });
    if (!items.length) return '';
    var bad = items.filter(rsIsProblem).length;
    return '<div class="rs-heat-row' + (rs.cat === c ? ' on' : '') + '">' +
      '<button type="button" class="rs-heat-cat" onclick="BDDCC.rsCat(\'' + rsJsId(c) + '\')" title="Show only ' + esc(c) + '">' +
        '<span>' + esc(c) + '</span>' + (bad ? '<b>' + bad + '</b>' : '<i>✓</i>') +
      '</button>' +
      '<div class="rs-tiles">' + items.map(function(r){
        var dim = (rs.q && !rsMatchesSearch(r)) ? ' dim' : '';
        return '<button type="button" class="rs-tile ' + invStatusClass(rsStatusOf(r)) + dim + '" title="' + esc(r.name + ' — ' + rsStatusOf(r) + ' · qty ' + r.qty) + '" aria-label="' + esc(r.name + ', ' + rsStatusOf(r)) + '" onclick="BDDCC.rsTile(event,\'' + rsJsId(r.id) + '\')"></button>';
      }).join('') + '</div>' +
    '</div>';
  }).join('');
  document.getElementById('rs-health').innerHTML =
    '<div class="rs-health-top">' +
      '<span class="rs-health-pct"><b>' + Math.round(okN / all.length * 100) + '%</b> stocked</span>' +
      '<span class="rs-legend"><i class="out"></i>' + outN + ' out<i class="low"></i>' + lowN + ' low<i class="ok"></i>' + okN + ' good</span>' +
    '</div>' +
    '<div class="rs-bar" role="img" aria-label="' + outN + ' out, ' + lowN + ' almost out, ' + okN + ' stocked">' +
      (outN ? '<span class="out" style="width:' + pct(outN) + '%"></span>' : '') +
      (lowN ? '<span class="low" style="width:' + pct(lowN) + '%"></span>' : '') +
      (okN  ? '<span class="ok" style="width:'  + pct(okN)  + '%"></span>' : '') +
    '</div>' +
    '<div class="rs-heat">' + heat + '</div>' +
    '<div class="rs-hint">Tap a square to update it &middot; tap a category to filter</div>';

  // ── View switch (counts respect the current search + category)
  document.getElementById('rs-views').innerHTML = RS_VIEWS.map(function(v){
    var n = all.filter(function(r){ return rsInView(r, v.id) && rsInCat(r, rs.cat) && rsMatchesSearch(r); }).length;
    var on = rs.view === v.id;
    return '<button type="button" class="' + (on ? 'on' : '') + '" aria-pressed="' + on + '" onclick="BDDCC.rsView(\'' + v.id + '\')">' + v.label + ' <span class="c">' + n + '</span></button>';
  }).join('');

  // ── Category chips (counts respect the current view + search)
  function chipCount(c){ return all.filter(function(r){ return rsInView(r, rs.view) && rsInCat(r, c) && rsMatchesSearch(r); }).length; }
  document.getElementById('rs-chips').innerHTML =
    '<button type="button" class="rs-chip' + (rs.cat === 'all' ? ' on' : '') + '" onclick="BDDCC.rsCat(\'all\')">All categories <span>' + chipCount('all') + '</span></button>' +
    restockCats().map(function(c){
      if (!all.some(function(r){ return (r.category || 'Other') === c; })) return '';
      var n = chipCount(c);
      return '<button type="button" class="rs-chip' + (rs.cat === c ? ' on' : '') + (n ? '' : ' zero') + '" onclick="BDDCC.rsCat(\'' + rsJsId(c) + '\')">' + esc(c) + ' <span>' + n + '</span></button>';
    }).join('');

  // ── Bulk bar (only while something is selected)
  var selIds = Object.keys(rs.sel);
  var bulk = document.getElementById('rs-bulk');
  if (!selIds.length) {
    bulk.hidden = true;
    bulk.innerHTML = '';
  } else {
    if (!rs.bulkBy && PEOPLE.length) rs.bulkBy = PEOPLE[0].id;
    bulk.hidden = false;
    bulk.innerHTML =
      '<span class="rs-bulk-n"><b>' + selIds.length + '</b> selected</span>' +
      '<span class="rs-bulk-grp"><label>Location</label><b>' + esc(invLoc) + ' (' + INV_LOC_CODES[invLoc] + ')</b></span>' +
      '<span class="rs-bulk-grp"><label for="rs-bulk-by">Requested by</label><select id="rs-bulk-by" onchange="BDDCC.rsBulkSet(\'by\',this.value)">' +
        PEOPLE.map(function(p){ return '<option value="' + p.id + '"' + (p.id === rs.bulkBy ? ' selected' : '') + '>' + esc(p.label) + '</option>'; }).join('') +
      '</select></span>' +
      '<button type="button" class="rs-btn dark" onclick="BDDCC.rsBulkRequest()">Request restock</button>' +
      '<button type="button" class="rs-btn darkghost" onclick="BDDCC.rsBulkStatus(\'Good\')">✓ Mark restocked</button>' +
      '<button type="button" class="rs-bulk-x" onclick="BDDCC.rsClearSel()" aria-label="Clear selection" title="Clear selection">&times;</button>';
  }

  // ── The list, grouped Out → Almost Out (→ Stocked in "All items")
  var rows = all.filter(rsVisible);
  var list = document.getElementById('rs-list');
  if (!rows.length) {
    var msg;
    if (rs.q)                    msg = 'No items match “' + esc(rs.q) + '”. <button type="button" onclick="BDDCC.rsClearSearch()">Clear search</button>';
    else if (rs.view === 'need') msg = 'Every low or out item already has a supply request. ✅';
    else if (rs.view === 'all')  msg = 'No items in this category.';
    else                         msg = 'Nothing here — all stocked. ✅';
    list.innerHTML = '<div class="rs-empty">' + msg + '</div>';
    return;
  }
  var groups = [
    {key: 'Out',        title: 'Out',        sub: 'reorder now', cls: 'out'},
    {key: 'Almost Out', title: 'Almost Out', sub: 'order soon',  cls: 'low'},
    {key: 'Good',       title: 'Stocked',    sub: '',            cls: 'ok'}
  ];
  var html = '<div class="rs-colhead" aria-hidden="true"><span></span><span>Item</span><span>Supply request</span><span>On hand</span><span>Status</span><span></span></div>';
  groups.forEach(function(g){
    var items = rows
      .filter(function(r){ return rsStatusOf(r) === g.key; })
      .sort(function(a, b){
        var ar = openRequestFor(a.name, invLocOf(a)) ? 1 : 0, br = openRequestFor(b.name, invLocOf(b)) ? 1 : 0; // un-requested first
        return ar - br ||
          String(a.category || '').localeCompare(String(b.category || '')) ||
          String(a.name).localeCompare(String(b.name));
      });
    if (!items.length) return;
    var allSel = items.every(function(r){ return rs.sel[String(r.id)]; });
    html += '<div class="rs-group ' + g.cls + '">' +
        '<label class="rs-check" title="Select all ' + g.title + '"><input type="checkbox"' + (allSel ? ' checked' : '') + ' onchange="BDDCC.rsSelGroup(\'' + g.key + '\',this.checked)" aria-label="Select all ' + g.title + '"><span></span></label>' +
        '<span class="rs-group-t">' + g.title + '</span><span class="rs-group-n">' + items.length + '</span>' +
        (g.sub ? '<span class="rs-group-s">' + g.sub + '</span>' : '') +
      '</div>' +
      items.map(rsRow).join('');
  });
  list.innerHTML = html;
}

function rsRow(r){
  var id   = String(r.id), jsId = rsJsId(r.id);
  var cls  = invStatusClass(rsStatusOf(r));
  var req  = openRequestFor(r.name, invLocOf(r));
  var meta = [esc(r.category || 'Other')];
  if (r.notes)     meta.push(esc(r.notes));
  if (r.updatedAt) meta.push('updated ' + relTime(r.updatedAt) + (r.updatedBy ? ' by ' + esc(r.updatedBy) : ''));
  var reqHtml = req
    ? '<span class="rs-req st-' + esc(String(req.status).toLowerCase()) + '" title="' + esc(req.qty + 'x · ' + req.location + ' · requested by ' + personLabel(req.requestedBy)) + '"><i></i>' + esc(req.status) + (req.createdAt ? ' <em>' + relTime(req.createdAt) + '</em>' : '') + '</span>'
    : '<span class="rs-req none">Not requested</span>';
  return '<div class="rs-row ' + cls + (rs.sel[id] ? ' sel' : '') + '" data-id="' + esc(id) + '">' +
    '<label class="rs-check"><input type="checkbox"' + (rs.sel[id] ? ' checked' : '') + ' onchange="BDDCC.rsSel(\'' + jsId + '\',this.checked)" aria-label="Select ' + esc(r.name) + '"><span></span></label>' +
    '<div class="rs-main"><div class="rs-name">' + esc(r.name) + '</div><div class="rs-meta">' + meta.join('<b>·</b>') + '</div></div>' +
    '<div class="rs-reqcell">' + reqHtml + '</div>' +
    '<div class="rs-step">' +
      '<button type="button" onclick="BDDCC.rsQty(\'' + jsId + '\',-1)" aria-label="One less" title="One less">−</button>' +
      '<input type="number" min="0" step="1" value="' + esc(r.qty) + '" aria-label="Amount on hand for ' + esc(r.name) + '" onchange="BDDCC.saveInvField(\'' + jsId + '\',\'qty\',this.value)">' +
      '<button type="button" onclick="BDDCC.rsQty(\'' + jsId + '\',1)" aria-label="One more" title="One more">+</button>' +
    '</div>' +
    '<div class="rs-seg3" role="group" aria-label="Status for ' + esc(r.name) + '">' + rsSegHtml(r) + '</div>' +
    '<button type="button" class="rs-btn ' + (req ? 'ghost' : 'primary') + ' rs-order" onclick="BDDCC.requestRestock(\'' + jsId + '\')">' + (req ? 'Request more' : 'Request') + '</button>' +
  '</div>';
}

// ── actions
function rsView(v){ rs.view = v; rsPersist(); rsRenderDynamic(); }
function rsCat(c){ rs.cat = (rs.cat === c && c !== 'all') ? 'all' : c; rsPersist(); rsRenderDynamic(); }
function rsClearSearch(){
  rs.q = '';
  var q = document.getElementById('rs-q');
  if (q) q.value = '';
  rsRenderDynamic();
}
function rsSel(id, on){
  if (on) rs.sel[String(id)] = true; else delete rs.sel[String(id)];
  rsRenderDynamic();
}
function rsSelGroup(key, on){
  inventoryRecords.forEach(function(r){
    if (rsStatusOf(r) === key && rsVisible(r)) {
      if (on) rs.sel[String(r.id)] = true; else delete rs.sel[String(r.id)];
    }
  });
  rsRenderDynamic();
}
function rsClearSel(){ rs.sel = {}; rsRenderDynamic(); }
function rsBulkSet(k, v){ if (k === 'loc') rs.bulkLoc = v; else rs.bulkBy = v; }

async function rsStatus(id, status){
  rsCloseMenu();
  var r = rsFind(id);
  if (!r || rsStatusOf(r) === status) return;
  var prev = rsStatusOf(r), name = r.name;
  if (await saveInventoryField(id, 'status', status)) {
    toast(name + ' → ' + status, {label: 'Undo', fn: function(){ saveInventoryField(id, 'status', prev); }});
  }
}

// − / + : update the number instantly, save once the taps stop.
function rsQty(id, delta){
  var r = rsFind(id);
  if (!r) return;
  var n = Math.max(0, (Number(r.qty) || 0) + delta);
  r.qty = n;
  document.querySelectorAll('.rs-row').forEach(function(row){
    if (row.getAttribute('data-id') === String(id)) {
      var inp = row.querySelector('.rs-step input');
      if (inp) inp.value = n;
    }
  });
  clearTimeout(rs.qtyTimers[id]);
  rs.qtyTimers[id] = setTimeout(function(){ saveInventoryField(id, 'qty', n); }, 700);
}

async function rsBulkStatus(status){
  var ids = Object.keys(rs.sel), prev = {}, done = 0;
  for (var i = 0; i < ids.length; i++) {
    var r = rsFind(ids[i]);
    if (!r || rsStatusOf(r) === status) continue;
    prev[ids[i]] = rsStatusOf(r);
    if (await saveInventoryField(ids[i], 'status', status)) done++;
  }
  rs.sel = {};
  rsRenderDynamic();
  if (done) {
    toast(done + ' item' + (done === 1 ? '' : 's') + ' marked ' + (status === 'Good' ? 'restocked' : status), {label: 'Undo', fn: async function(){
      for (var id in prev) await saveInventoryField(id, 'status', prev[id]);
    }});
  }
}

async function rsBulkRequest(){
  var items = Object.keys(rs.sel).map(rsFind).filter(Boolean);
  if (!items.length) return;
  var n = items.length;
  if (!confirm('Send ' + n + ' restock request' + (n === 1 ? '' : 's') + ' for ' + invLoc + ' (qty 1 each)?\nEach one posts to #leadership for approval, where the quantity can be edited.')) return;
  var by = rs.bulkBy || (PEOPLE[0] && PEOPLE[0].id), sent = 0;
  for (var i = 0; i < items.length; i++) {
    var now = new Date().toISOString();
    var record = {
      id: uid(), location: invLoc, item: items[i].name, qty: 1, requestedBy: by,
      notes: 'Restock — ' + rsStatusOf(items[i]) + ' on the Restock Board', status: 'Requested', createdAt: now,
      history: [{status: 'Requested', by: by, at: now}]
    };
    try { await apiPost('supply', record); supplyRecords.unshift(record); sent++; } catch (e) {}
  }
  rs.sel = {};
  renderSupply(); // also refreshes the board's "requested" badges
  toast(sent === n ? 'Sent ' + sent + ' restock request' + (sent === 1 ? '' : 's') + '.' : 'Sent ' + sent + ' of ' + n + ' — try the rest again.');
}

// Heat-map square → small floating status menu.
function rsTile(ev, id){
  ev.stopPropagation();
  var r = rsFind(id);
  if (!r) return;
  var menu = document.getElementById('rs-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'rs-menu';
    menu.className = 'rs-menu';
    menu.setAttribute('role', 'dialog');
    document.getElementById('bdd-cc').appendChild(menu); // outside the clipped board
  }
  var req = openRequestFor(r.name, invLocOf(r));
  menu.innerHTML =
    '<div class="rs-menu-t">' + esc(r.name) + '</div>' +
    '<div class="rs-menu-s">' + esc(r.category || 'Other') + ' &middot; qty ' + esc(r.qty) + (req ? ' &middot; ' + esc(String(req.status).toLowerCase()) : '') + '</div>' +
    '<div class="rs-seg3">' + rsSegHtml(r) + '</div>' +
    '<button type="button" class="rs-menu-go" onclick="BDDCC.rsLocate(\'' + rsJsId(r.id) + '\')">Show in list →</button>';
  menu.hidden = false;
  var b = ev.currentTarget.getBoundingClientRect(), w = 240, h = menu.offsetHeight || 150;
  var left = Math.min(Math.max(8, b.left + b.width / 2 - w / 2), window.innerWidth - w - 8);
  var top  = b.bottom + 8;
  if (top + h > window.innerHeight - 8) top = Math.max(8, b.top - h - 8);
  menu.style.left = left + 'px';
  menu.style.top  = top + 'px';
}
function rsCloseMenu(){
  var m = document.getElementById('rs-menu');
  if (m) m.hidden = true;
}

function rsLocate(id){
  rsCloseMenu();
  var r = rsFind(id);
  if (!r) return;
  if (!rsInView(r, rs.view)) rs.view = rsIsProblem(r) ? 'problems' : 'all';
  if (!rsInCat(r, rs.cat))   rs.cat = 'all';
  if (!rsMatchesSearch(r))   rsClearSearch();
  rsPersist();
  rsRenderDynamic();
  var row = null;
  document.querySelectorAll('.rs-row').forEach(function(x){ if (x.getAttribute('data-id') === String(id)) row = x; });
  if (row) {
    row.scrollIntoView({behavior: 'smooth', block: 'center'});
    row.classList.remove('flash');
    void row.offsetWidth;
    row.classList.add('flash');
  }
}

// "Request" button: pre-fills the Supply Orders form with this item and scrolls to it.
function requestRestock(id){
  var r = rsFind(id);
  var sel = document.getElementById('bdd-cc-item-select');
  if (!r || !sel) return;
  var supLoc = document.getElementById('bdd-cc-supply-loc');
  if (supLoc) supLoc.value = invLocOf(r);
  var inCatalog = Array.prototype.some.call(sel.options, function(o){ return o.value === r.name; });
  sel.value = inCatalog ? r.name : '__other__';
  onItemSelectChange(sel);
  if (!inCatalog) document.getElementById('bdd-cc-item-other').value = r.name;
  var qty = document.getElementById('bdd-cc-supply-qty');
  if (qty && !qty.value) qty.value = 1;
  var notes = document.getElementById('bdd-cc-supply-notes');
  if (notes && !notes.value) notes.value = 'Restock — marked ' + rsStatusOf(r) + ' on the Restock Board';
  document.getElementById('bdd-cc-supply-form').scrollIntoView({behavior: 'smooth', block: 'center'});
  toast('Restock started — check location + quantity, then Send Request.');
}

// ---------------------------------------------------------------- location toggle (SPR / RIV)
function syncLocToggles(){
  document.querySelectorAll('[data-invloc]').forEach(function(b){
    var on = b.getAttribute('data-invloc') === invLoc;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  var addLoc = document.getElementById('bdd-cc-inv-loc');
  if (addLoc && addLoc.value !== 'both') addLoc.value = invLoc;
  var tag = document.getElementById('bdd-cc-inv-loc-tag');
  if (tag) tag.textContent = INV_LOC_CODES[invLoc];

  // Whole-page theme + labels (Springfield = Diamond Ice, Riverside = Forge Copper)
  var root = document.getElementById('bdd-cc');
  if (root) root.classList.toggle('loc-riv', invLoc === 'Riverside');
  var nm = document.getElementById('bdd-cc-locname');
  if (nm) nm.textContent = invLoc === 'Riverside' ? 'Riverside, CA' : 'Springfield, IL';
  var heroLoc = document.getElementById('bdd-cc-hero-loc');
  if (heroLoc) heroLoc.textContent = INV_LOC_CODES[invLoc];

  // Supply requests are filed for the location on screen
  var supLocSel = document.getElementById('bdd-cc-supply-loc');
  if (supLocSel) supLocSel.value = invLoc;

  // To-dos: this location's group + Leadership (shared by both); hide the other location
  var otherLoc = invLoc === 'Riverside' ? 'Springfield' : 'Riverside';
  if (todoGroupFilter !== 'Leadership') todoGroupFilter = invLoc;
  document.querySelectorAll('.bdd-cc-pill[data-todo-group]').forEach(function(p){
    p.hidden = p.getAttribute('data-todo-group') === otherLoc;
  });
  var tg = document.getElementById('bdd-cc-todo-group');
  if (tg) {
    Array.prototype.forEach.call(tg.options, function(o){ o.hidden = o.disabled = (o.value === otherLoc); });
    if (tg.value === otherLoc) tg.value = invLoc;
  }
}
function setInvLoc(loc){
  if (!INV_LOC_CODES[loc] || loc === invLoc) return;
  invLoc = loc;
  try { localStorage.setItem('bdd-location', loc); } catch (e) {}
  rs.sel = {};
  rsCloseMenu();
  syncLocToggles();
  renderInventory();
  renderSupply();
  renderTodos();
}

// ---------------------------------------------------------------- init
function buildPersonOptions(includeBlank){
  var html = includeBlank ? '<option value="">Assign to…</option>' : '';
  PEOPLE.forEach(function(p){
    html += '<option value="' + p.id + '">' + esc(p.label) + '</option>';
  });
  return html;
}

function init(){
  var itemSelect = document.getElementById('bdd-cc-item-select');
  if (itemSelect) itemSelect.innerHTML = buildItemOptions();

  var supplyBy = document.getElementById('bdd-cc-supply-by');
  if (supplyBy) supplyBy.innerHTML = buildPersonOptions(false);

  var todoAssignee = document.getElementById('bdd-cc-todo-assignee');
  if (todoAssignee) todoAssignee.innerHTML = buildPersonOptions(true);

  var dueEl = document.getElementById('bdd-cc-todo-due');
  if (dueEl) dueEl.value = todayStr();

  var supplyForm = document.getElementById('bdd-cc-supply-form');
  if (supplyForm) supplyForm.addEventListener('submit', submitSupplyRequest);

  var todoForm = document.getElementById('bdd-cc-todo-form');
  if (todoForm) todoForm.addEventListener('submit', submitTodo);

  var invCat = document.getElementById('bdd-cc-inv-cat');
  if (invCat) invCat.innerHTML = INVENTORY_CATEGORIES.map(function(c){ return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');

  var invStatusNew = document.getElementById('bdd-cc-inv-status-new');
  if (invStatusNew) invStatusNew.innerHTML = INVENTORY_STATUSES.map(function(s){ return '<option value="' + esc(s) + '">' + esc(s) + '</option>'; }).join('');

  var invForm = document.getElementById('bdd-cc-inv-form');
  if (invForm) invForm.addEventListener('submit', submitInventoryItem);

  // Restock Board: "/" jumps to search, Esc / outside click / scroll closes the square menu.
  document.addEventListener('keydown', function(e){
    var tag = (e.target && e.target.tagName) || '';
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(tag) && !(e.target && e.target.isContentEditable)) {
      var q = document.getElementById('rs-q');
      if (q) { e.preventDefault(); q.focus(); q.select(); }
    }
    if (e.key === 'Escape') rsCloseMenu();
  });
  document.addEventListener('click', function(e){
    var m = document.getElementById('rs-menu');
    if (m && !m.hidden && !m.contains(e.target)) rsCloseMenu();
  });
  window.addEventListener('scroll', rsCloseMenu, {passive: true});
  window.addEventListener('resize', rsCloseMenu);

  syncLocToggles();
  loadAll();
}

window.BDDCC = {
  setSupplyFilter: setSupplyFilter,
  setTodoFilter: setTodoFilter,
  setInventoryFilter: setInventoryFilter,
  setInvSort: setInventorySort,
  advanceSupply: advanceSupplyStatus,
  deleteSupply: deleteSupply,
  toggleTodo: toggleTodo,
  deleteTodo: deleteTodo,
  saveInvField: saveInventoryField,
  deleteInvItem: deleteInventoryItem,
  requestRestock: requestRestock,
  setInvLoc: setInvLoc,
  rsView: rsView, rsCat: rsCat, rsClearSearch: rsClearSearch,
  rsSel: rsSel, rsSelGroup: rsSelGroup, rsClearSel: rsClearSel,
  rsBulkSet: rsBulkSet, rsBulkRequest: rsBulkRequest, rsBulkStatus: rsBulkStatus,
  rsStatus: rsStatus, rsQty: rsQty, rsTile: rsTile, rsLocate: rsLocate,
  onItemSelectChange: onItemSelectChange
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
})();
