(function(){
var API   = 'https://example.com/bdd-api.php';
var TOKEN = 'YOUR_PAYOUT_API_SECRET_HERE';
var TAX   = 0.0875;

var jobs    = [];
var filter  = 'all';
var sortAsc = false;

// Location — Springfield (default) or Riverside; "Both" shows combined stats.
// Stored as 'bdd-location' (shared with the Command Center) + 'bdd-payout-both'.
// Jobs saved before locations existed count as Springfield.
var LOCS     = ['Springfield', 'Riverside'];
var LOC_CODE = {Springfield: 'SPR', Riverside: 'RIV'};
var loc = 'Springfield', showBoth = false;
try {
  var savedLoc = localStorage.getItem('bdd-location'); if (LOC_CODE[savedLoc]) loc = savedLoc;
  showBoth = localStorage.getItem('bdd-payout-both') === '1';
} catch (e) {}
var newJobLoc = loc;       // location for the New Job form
var editLoc   = 'Springfield'; // location in the open edit panel
function jobLoc(j){ return LOC_CODE[j.location] ? j.location : 'Springfield'; }
function locCode(l){ return LOC_CODE[l] || 'SPR'; }

// New-job form state
var jordan      = false;
var avery        = false;
var devon       = false;
var priya         = false;
var marco        = false;
var theo        = false;
var manager     = '';   // '', 'harlan', or 'sawyer' — on-site Regional Manager
var referralBy  = '';   // 'devon', 'priya', 'marco', or 'theo'

// Edit state
var editId      = null;
var editQ       = false;
var editL       = false;
var editDevon   = false;
var editPriya     = false;
var editMarco    = false;
var editTheo    = false;
var editManager = '';   // '', 'harlan', or 'sawyer'

// Set today's date
(function(){
  var el = document.getElementById('bdd-job-date');
  if (!el) return;
  var d = new Date(), p = function(n){ return String(n).padStart(2,'0'); };
  el.value = d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());
})();

function fmt(n){ return '$'+Number(n||0).toFixed(2); }
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function hdr(){ return {'Content-Type':'application/json','X-BDD-Token':TOKEN}; }

function toast(msg){
  var t = document.getElementById('bdd-toast-bdd'); if(!t) return;
  t.textContent = msg; t.classList.add('show');
  setTimeout(function(){ t.classList.remove('show'); }, 2400);
}

function animateTo(id, val){
  var el = document.getElementById(id); if(!el) return;
  var start = parseFloat(el.getAttribute('data-raw')||'0'), dur = 420, t0 = null;
  function step(ts){ if(!t0)t0=ts; var p=Math.min((ts-t0)/dur,1),e=1-Math.pow(1-p,3);
    el.textContent=fmt(start+(val-start)*e); if(p<1)requestAnimationFrame(step);
    else{ el.textContent=fmt(val); el.setAttribute('data-raw',val); } }
  requestAnimationFrame(step);
}

// ── Location switch + theme ─────────────────────────────────────
function syncJobLocBtns(){
  LOCS.forEach(function(l){
    var b = document.getElementById('bdd-nloc-' + locCode(l).toLowerCase());
    if (b) b.classList.toggle('active', newJobLoc === l);
  });
}
function applyLocation(){
  var root = document.getElementById('bdd-calc');
  if (root) {
    root.classList.toggle('loc-riv', !showBoth && loc === 'Riverside');
    root.classList.toggle('loc-both', showBoth);
  }
  document.querySelectorAll('#bdd-calc [data-loc-view]').forEach(function(b){
    var v = b.getAttribute('data-loc-view'), on = showBoth ? v === 'both' : v === loc;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  var name = document.getElementById('bdd-locbar-name');
  if (name) name.textContent = showBoth ? 'Springfield + Riverside' : (loc === 'Riverside' ? 'Riverside, CA' : 'Springfield, IL');
  var lbl = document.getElementById('bdd-s-loc');
  if (lbl) lbl.textContent = showBoth ? 'both locations' : loc;
  syncJobLocBtns();
}
window.bddSetLocView = function(v){
  if (v === 'both') {
    showBoth = true;
  } else if (LOC_CODE[v]) {
    showBoth = false; loc = v; newJobLoc = v;
    try { localStorage.setItem('bdd-location', v); } catch (e) {}
  } else return;
  try { localStorage.setItem('bdd-payout-both', showBoth ? '1' : '0'); } catch (e) {}
  bddCloseEdit(); applyLocation(); refresh();
};
window.bddSetJobLoc = function(l){ if (LOC_CODE[l]) { newJobLoc = l; syncJobLocBtns(); } };
window.bddEditLoc = function(jobId, l){
  if (editId !== jobId || !LOC_CODE[l]) return;
  editLoc = l;
  LOCS.forEach(function(x){
    var b = document.getElementById('bdd-eloc-' + locCode(x).toLowerCase() + '-' + jobId);
    if (b) b.classList.toggle('active', editLoc === x);
  });
};

// ── Roster ─────────────────────────────────────────────────────
// Employees: Devon, Priya, Marco, Theo. Regional Managers: Harlan, Sawyer (no employee profile).
function managerName(){ return manager==='harlan'?'Harlan':manager==='sawyer'?'Sawyer':''; }
function editManagerName(){ return editManager==='harlan'?'Harlan':editManager==='sawyer'?'Sawyer':''; }

function getEmpNames(){ return [devon?'Devon':'',priya?'Priya':'',marco?'Marco':'',theo?'Theo':''].filter(Boolean); }
function getEditEmpNames(){ return [editDevon?'Devon':'',editPriya?'Priya':'',editMarco?'Marco':'',editTheo?'Theo':''].filter(Boolean); }

// A split row counts as "present / working" (eligible for a tip share) when it is
// not the Business cut and not an absent owner. Managers (mgr) count as present.
function isWorking(s){ return s.tag!=='biz' && s.tag!=='absent'; }

// Even tip split across everyone present on the job. Display hint only —
// tips are never stored or distributed per-person.
function tipShareFor(splits, tips){
  var t = Number(tips)||0;
  if(t<=0) return 0;
  var n = (splits||[]).filter(isWorking).length;
  return n>0 ? +(t/n).toFixed(2) : 0;
}
function tipPill(share){ return '<span class="bdd-tip-cut">+'+fmt(share)+' tip</span>'; }
function roleTag(s){
  if(s.isFlatRate) return ' <span style="color:#3a7aba;font-size:9px;">flat</span>';
  if(s.tag==='mgr' || s.isManager) return ' <span style="color:#9d8bff;font-size:9px;">mgr</span>';
  return '';
}

// Read flat-rate amounts from the new-job form (employees + on-site manager)
function getFlatRateEmps(){
  var result=[];
  if(devon){var v=parseFloat((document.getElementById('bdd-devon-flat')||{}).value)||0;if(v>0)result.push({name:'Devon',amount:v});}
  if(priya){var v=parseFloat((document.getElementById('bdd-priya-flat')||{}).value)||0;if(v>0)result.push({name:'Priya',amount:v});}
  if(marco){var v=parseFloat((document.getElementById('bdd-marco-flat')||{}).value)||0;if(v>0)result.push({name:'Marco',amount:v});}
  if(theo){var v=parseFloat((document.getElementById('bdd-theo-flat')||{}).value)||0;if(v>0)result.push({name:'Theo',amount:v});}
  if(manager){var v=parseFloat((document.getElementById('bdd-mgr-flat')||{}).value)||0;if(v>0)result.push({name:managerName(),amount:v});}
  return result;
}
function isAnyFlatActive(){ return getFlatRateEmps().length>0; }

// Read flat-rate amounts from the edit panel (employees + on-site manager)
function getEditFlatRateEmps(){
  var result=[];
  if(!editId)return result;
  if(editDevon){var v=parseFloat((document.getElementById('bdd-fi-devon-'+editId)||{}).value)||0;if(v>0)result.push({name:'Devon',amount:v});}
  if(editPriya){var v=parseFloat((document.getElementById('bdd-fi-priya-'+editId)||{}).value)||0;if(v>0)result.push({name:'Priya',amount:v});}
  if(editMarco){var v=parseFloat((document.getElementById('bdd-fi-marco-'+editId)||{}).value)||0;if(v>0)result.push({name:'Marco',amount:v});}
  if(editTheo){var v=parseFloat((document.getElementById('bdd-fi-theo-'+editId)||{}).value)||0;if(v>0)result.push({name:'Theo',amount:v});}
  if(editManager){var v=parseFloat((document.getElementById('bdd-fi-mgr-'+editId)||{}).value)||0;if(v>0)result.push({name:editManagerName(),amount:v});}
  return result;
}

// ── Core split logic ─────────────────────────────────────────
// mgrName: '' | 'Harlan' | 'Sawyer'. If a manager is on-site with 0 owners they draw the
// manager rate (Job 8/9). With any owner present, the manager is folded into the
// employee list and billed at the regular-employee rate (Jobs 1-7).
function computeSplitsFor(price, q, l, empNames, mgrName){
  var owners = (q?1:0)+(l?1:0);
  mgrName = mgrName || '';
  var type, raw;

  if(mgrName && owners===0){
    var mEmp = empNames.length;
    if(mEmp===0){
      type='Job 8'; raw=[{name:'Jordan',pct:17.5,tag:'absent'},{name:'Avery',pct:17.5,tag:'absent'},{name:mgrName,pct:35,tag:'mgr'},{name:'Business',pct:30,tag:'biz'}];
    } else if(mEmp===1){
      type='Job 9'; raw=[{name:'Jordan',pct:15,tag:'absent'},{name:'Avery',pct:15,tag:'absent'},{name:mgrName,pct:25,tag:'mgr'},{name:empNames[0],pct:20,tag:'emp'},{name:'Business',pct:25,tag:'biz'}];
    } else {
      return {valid:false, error:'No type for manager + '+mEmp+' employees (max 1)'};
    }
    return {valid:true, type:type, splits:raw.map(function(s,i){ return Object.assign({},s,{index:i,amount:+(price*s.pct/100).toFixed(2)}); })};
  }

  // Manager with an owner present → billed as a regular employee
  var effEmp = empNames.slice();
  if(mgrName) effEmp.push(mgrName);
  var empCount = effEmp.length;

  if(owners===2 && empCount===0){
    type='Job 1'; raw=[{name:'Jordan',pct:30,tag:'q'},{name:'Avery',pct:30,tag:'l'},{name:'Business',pct:40,tag:'biz'}];
  } else if(owners===1 && empCount===1){
    var pr=q?'Jordan':'Avery', ab=q?'Avery':'Jordan';
    type='Job 2'; raw=[{name:pr,pct:30,tag:'present'},{name:ab,pct:15,tag:'absent'},{name:effEmp[0],pct:20,tag:'emp'},{name:'Business',pct:35,tag:'biz'}];
  } else if(owners===2 && empCount===1){
    type='Job 3'; raw=[{name:'Jordan',pct:30,tag:'q'},{name:'Avery',pct:30,tag:'l'},{name:effEmp[0],pct:20,tag:'emp'},{name:'Business',pct:20,tag:'biz'}];
  } else if(owners===0 && empCount===2){
    type='Job 4'; raw=[{name:'Jordan',pct:15,tag:'absent'},{name:'Avery',pct:15,tag:'absent'},{name:effEmp[0],pct:20,tag:'emp'},{name:effEmp[1],pct:20,tag:'emp'},{name:'Business',pct:30,tag:'biz'}];
  } else if(owners===1 && empCount===2){
    var pr=q?'Jordan':'Avery', ab=q?'Avery':'Jordan';
    type='Job 5'; raw=[{name:pr,pct:30,tag:'present'},{name:ab,pct:10,tag:'absent'},{name:effEmp[0],pct:20,tag:'emp'},{name:effEmp[1],pct:20,tag:'emp'},{name:'Business',pct:20,tag:'biz'}];
  } else if(owners===1 && empCount===0){
    var pr=q?'Jordan':'Avery', ab=q?'Avery':'Jordan';
    type='Job 6'; raw=[{name:pr,pct:55,tag:'present'},{name:ab,pct:15,tag:'absent'},{name:'Business',pct:30,tag:'biz'}];
  } else if(owners===0 && empCount===1){
    type='Job 7'; raw=[{name:'Jordan',pct:15,tag:'absent'},{name:'Avery',pct:15,tag:'absent'},{name:effEmp[0],pct:35,tag:'emp'},{name:'Business',pct:35,tag:'biz'}];
  } else {
    var hints={'0-0':'Select owners, employees, or a manager','2-2':'No valid type: 2 owners + 2 employees'};
    return {valid:false, error:hints[owners+'-'+empCount]||'No type for '+owners+' owner(s) + '+empCount+' employee(s)'};
  }

  var splits=raw.map(function(s,i){ return Object.assign({},s,{index:i,amount:+(price*s.pct/100).toFixed(2)}); });
  if(mgrName){
    for(var mi=splits.length-1;mi>=0;mi--){
      if(splits[mi].tag==='emp' && splits[mi].name===mgrName){ splits[mi]=Object.assign({},splits[mi],{isManager:true}); break; }
    }
  }
  return {valid:true, type:type, splits:splits};
}

// ── Flat-rate job logic ────────────────────────────────────────
// flatEmps: [{name:'Devon',amount:350}, ...]  (may include the on-site manager)
// Flat amounts are deducted first; remainder splits by pctQ/pctL/pctBiz
function computeFlatRateJob(price, taxable, q, l, flatEmps, pctQ, pctL, pctBiz){
  var taxAmt=taxable?+(price*TAX).toFixed(2):0;
  var totalFlat=+flatEmps.reduce(function(s,e){return +(s+e.amount).toFixed(2);},0).toFixed(2);
  var remainder=+(price-totalFlat).toFixed(2);
  if(remainder<0) return {valid:false,error:'Flat rates total '+fmt(totalFlat)+' — exceeds the job price'};
  var activePct=(q?pctQ:0)+(l?pctL:0)+pctBiz;
  if(Math.abs(activePct-100)>0.5) return {valid:false,error:'Split must total 100% (currently '+activePct+'%)'};
  var splits=[];
  if(q) splits.push({name:'Jordan',tag:'q',pct:pctQ,amount:+(remainder*pctQ/100).toFixed(2),isFlatRate:false});
  if(l) splits.push({name:'Avery',tag:'l',pct:pctL,amount:+(remainder*pctL/100).toFixed(2),isFlatRate:false});
  flatEmps.forEach(function(e){ splits.push({name:e.name,tag:'emp',pct:0,amount:e.amount,isFlatRate:true}); });
  splits.push({name:'Business',tag:'biz',pct:pctBiz,amount:+(remainder*pctBiz/100).toFixed(2),isFlatRate:false});
  return {valid:true,type:'Flat Rate',flatRate:true,taxAmt:taxAmt,totalFlat:totalFlat,remainder:remainder,splits:splits};
}

// ── Breakdown HTML builders ────────────────────────────────────
function buildBreakdownHtml(r, price, taxable, tips){
  if(!r.valid) return '<div class="bdd-type-badge invalid">'+esc(r.error)+'</div>';
  var taxAmt=taxable?+(price*TAX).toFixed(2):0;
  var share=tipShareFor(r.splits, tips);
  var html='<div class="bdd-type-badge">'+r.type+'</div>';
  r.splits.forEach(function(s){
    var dot=s.tag==='biz'?'':s.tag==='absent'?'<span class="bdd-split-dot off"></span>':s.tag==='emp'?'<span class="bdd-split-dot emp"></span>':'<span class="bdd-split-dot on"></span>';
    var tip=(share>0 && isWorking(s))?tipPill(share):'';
    html+='<div class="bdd-split-row'+(s.tag==='biz'?' biz':'')+'"><span class="bdd-split-name">'+dot+esc(s.name)+roleTag(s)+tip+'</span><span class="bdd-split-right"><span class="bdd-split-pct">'+s.pct+'%</span><span class="bdd-split-amt">'+fmt(s.amount)+'</span></span></div>';
  });
  if(taxable && price>0){
    html+='<div class="bdd-split-row tax-line" style="border-top:1px solid #252525;margin-top:4px;padding-top:10px;"><span class="bdd-split-name">Sales Tax Collected (8.75%)</span><span class="bdd-split-right"><span class="bdd-split-pct"></span><span class="bdd-split-amt">+'+fmt(taxAmt)+'</span></span></div>';
    html+='<div class="bdd-split-row" style="padding-top:4px;"><span class="bdd-split-name" style="color:#555;font-size:12px;">Customer Total</span><span class="bdd-split-right"><span class="bdd-split-pct"></span><span class="bdd-split-amt" style="color:#777;">'+fmt(+(price+taxAmt).toFixed(2))+'</span></span></div>';
  }
  return html;
}

function buildFlatRateBreakdownHtml(r, tips){
  if(!r.valid) return '<div class="bdd-type-badge invalid">'+esc(r.error)+'</div>';
  var share=tipShareFor(r.splits, tips);
  var html='<div class="bdd-type-badge flat-rate-badge">Flat Rate Job</div>';
  r.splits.filter(function(s){return s.isFlatRate;}).forEach(function(s){
    var tip=share>0?tipPill(share):'';
    html+='<div class="bdd-split-row"><span class="bdd-split-name"><span class="bdd-split-dot emp"></span>'+esc(s.name)+' <span style="font-size:10px;color:#3a7aba;">flat rate</span>'+tip+'</span><span class="bdd-split-right"><span class="bdd-split-pct" style="color:#3a7aba;">flat</span><span class="bdd-split-amt">&minus;'+fmt(s.amount)+'</span></span></div>';
  });
  html+='<div class="bdd-split-row" style="padding-bottom:10px;margin-bottom:4px;border-bottom:1px solid #1a3a5c;"><span class="bdd-split-name" style="color:#555;font-size:12px;">Remainder to Split</span><span class="bdd-split-right"><span class="bdd-split-pct"></span><span class="bdd-split-amt" style="color:#777;">'+fmt(r.remainder)+'</span></span></div>';
  r.splits.filter(function(s){return !s.isFlatRate;}).forEach(function(s){
    var dot=s.tag==='biz'?'':(s.tag==='q'||s.tag==='l')?'<span class="bdd-split-dot on"></span>':'<span class="bdd-split-dot emp"></span>';
    var tip=(share>0 && isWorking(s))?tipPill(share):'';
    html+='<div class="bdd-split-row'+(s.tag==='biz'?' biz':'')+'"><span class="bdd-split-name">'+dot+esc(s.name)+tip+'</span><span class="bdd-split-right"><span class="bdd-split-pct">'+s.pct+'%</span><span class="bdd-split-amt">'+fmt(s.amount)+'</span></span></div>';
  });
  if(r.taxAmt>0){
    var customerTotal=+(r.totalFlat+r.remainder+r.taxAmt).toFixed(2);
    html+='<div class="bdd-split-row tax-line" style="border-top:1px solid #1a3a5c;margin-top:4px;padding-top:10px;"><span class="bdd-split-name">Sales Tax Collected (8.75%)</span><span class="bdd-split-right"><span class="bdd-split-pct"></span><span class="bdd-split-amt">+'+fmt(r.taxAmt)+'</span></span></div>';
    html+='<div class="bdd-split-row" style="padding-top:4px;"><span class="bdd-split-name" style="color:#555;font-size:12px;">Customer Total</span><span class="bdd-split-right"><span class="bdd-split-pct"></span><span class="bdd-split-amt" style="color:#777;">'+fmt(customerTotal)+'</span></span></div>';
  }
  return html;
}

// ── Employee toggles — new-job form ───────────────────────────
function empSelected(){ return [devon,priya,marco,theo].filter(Boolean).length; }

function syncEmpButtons(){
  var maxed=empSelected()>=3;
  [{btn:'bdd-devon-btn',flat:'bdd-devon-flat',st:devon},
   {btn:'bdd-priya-btn',  flat:'bdd-priya-flat',  st:priya},
   {btn:'bdd-marco-btn', flat:'bdd-marco-flat', st:marco},
   {btn:'bdd-theo-btn', flat:'bdd-theo-flat', st:theo}].forEach(function(o){
    var b=document.getElementById(o.btn);
    if(b){b.classList.toggle('active',o.st);b.classList.toggle('emp-disabled',maxed&&!o.st);}
    var f=document.getElementById(o.flat);
    if(f){
      f.style.display=o.st?'flex':'none';
      if(!o.st)f.value='';
    }
  });
}

function syncManagerBtns(){
  ['harlan','sawyer'].forEach(function(m){
    var b=document.getElementById('bdd-mgr-'+m);
    if(b) b.classList.toggle('active',manager===m);
  });
  var f=document.getElementById('bdd-mgr-flat');
  if(f){ f.style.display=manager?'flex':'none'; if(!manager) f.value=''; }
}

function updateCustomSplitVisibility(){
  var anyFlat=isAnyFlatActive();
  var cs=document.getElementById('bdd-custom-split');
  if(cs)cs.style.display=anyFlat?'block':'none';
  var cq=document.getElementById('bdd-cpct-q');
  if(cq)cq.style.display=(anyFlat&&jordan)?'flex':'none';
  var cl=document.getElementById('bdd-cpct-l');
  if(cl)cl.style.display=(anyFlat&&avery)?'flex':'none';
}

window.bddToggleEmp = function(e){
  if(e==='devon'){ if(!devon && empSelected()>=3)return; devon=!devon; }
  else if(e==='priya'){  if(!priya   && empSelected()>=3)return; priya=!priya;   }
  else if(e==='marco'){ if(!marco  && empSelected()>=3)return; marco=!marco; }
  else if(e==='theo'){ if(!theo  && empSelected()>=3)return; theo=!theo; }
  syncEmpButtons(); updateCustomSplitVisibility(); bddCalc();
};

// ── Regional Manager toggle — new-job form ────────────────────
window.bddSetManager = function(m){
  manager=(manager===m)?'':m;
  syncManagerBtns(); updateCustomSplitVisibility(); bddCalc();
};

// ── Owner toggle — new-job form ───────────────────────────────
window.bddToggleOwner = function(o){
  if(o==='q'){jordan=!jordan; document.getElementById('bdd-q-btn').classList.toggle('active',jordan);}
  else       {avery=!avery;     document.getElementById('bdd-l-btn').classList.toggle('active',avery);}
  updateCustomSplitVisibility(); bddCalc();
};

// ── Referral — new-job form ───────────────────────────────────
window.bddToggleReferral = function(){
  var cb=document.getElementById('bdd-referral');
  var sec=document.getElementById('bdd-referral-section');
  if(sec) sec.style.display=(cb&&cb.checked)?'block':'none';
  if(!cb||!cb.checked){referralBy='';syncReferralBtns();}
};

function syncReferralBtns(){
  ['devon','priya','marco','theo'].forEach(function(e){
    var b=document.getElementById('bdd-ref-'+e);
    if(b) b.classList.toggle('active',referralBy===e);
  });
}

window.bddSetReferrer = function(e){
  referralBy=(referralBy===e)?'':e;
  syncReferralBtns();
};

// ── New-job calc ───────────────────────────────────────────────
window.bddCalc = function(){
  updateCustomSplitVisibility();
  var price=parseFloat(document.getElementById('bdd-price').value)||0;
  var taxable=document.getElementById('bdd-taxable').checked;
  var body=document.getElementById('bdd-breakdown-body'); if(!body)return;
  var tipsEl=document.getElementById('bdd-tips');
  var tips=tipsEl?parseFloat(tipsEl.value)||0:0;

  var flatEmps=getFlatRateEmps();
  var usingFlat=flatEmps.length>0;

  if(usingFlat){
    if(!jordan&&!avery){body.innerHTML='<div class="bdd-bkd-placeholder">Flat-rate needs at least one owner on-site for the remainder split</div>';return;}
    var pctQ=jordan?parseFloat((document.getElementById('bdd-pct-q')||{}).value)||0:0;
    var pctL=avery?parseFloat((document.getElementById('bdd-pct-l')||{}).value)||0:0;
    var pctBiz=parseFloat((document.getElementById('bdd-pct-biz')||{}).value)||0;
    body.innerHTML=buildFlatRateBreakdownHtml(computeFlatRateJob(price,taxable,jordan,avery,flatEmps,pctQ,pctL,pctBiz),tips);
    var rl=document.getElementById('bdd-remainder-lbl');
    if(rl&&price>0){
      var total=+flatEmps.reduce(function(s,e){return +(s+e.amount).toFixed(2);},0).toFixed(2);
      var rem=+(price-total).toFixed(2);
      rl.textContent='remainder: '+fmt(rem>0?rem:0);
    }
    return;
  }

  var empN=getEmpNames();
  var mgrN=managerName();
  if(!jordan&&!avery&&empN.length===0&&!mgrN){
    body.innerHTML='<div class="bdd-bkd-placeholder">Select owners, employees, or a manager to calculate</div>'; return;
  }
  body.innerHTML=buildBreakdownHtml(computeSplitsFor(price,jordan,avery,empN,mgrN),price,taxable,tips);
};

// ── New-job save ───────────────────────────────────────────────
window.bddSaveJob = async function(){
  var price=parseFloat(document.getElementById('bdd-price').value)||0;
  if(price<=0){toast('Enter a job price first');return;}
  var taxable=document.getElementById('bdd-taxable').checked;
  var tipsEl=document.getElementById('bdd-tips');
  var tips=tipsEl?+(parseFloat(tipsEl.value)||0).toFixed(2):0;
  var taxAmt=taxable?+(price*TAX).toFixed(2):0;
  var refCb=document.getElementById('bdd-referral');
  var isReferral=refCb?refCb.checked:false;
  var refName=isReferral&&referralBy?referralBy.charAt(0).toUpperCase()+referralBy.slice(1):'';
  var refAmt=isReferral?+(parseFloat((document.getElementById('bdd-referral-amt')||{}).value)||0).toFixed(2):0;
  var d=new Date(),p=function(n){return String(n).padStart(2,'0');};
  var today=d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());
  var mgrN=managerName();

  var flatEmps=getFlatRateEmps();
  var isFlatRate=flatEmps.length>0;
  var r, expenses, profit, empNames, jobExtra;

  if(isFlatRate){
    var pctQ=jordan?parseFloat((document.getElementById('bdd-pct-q')||{}).value)||0:0;
    var pctL=avery?parseFloat((document.getElementById('bdd-pct-l')||{}).value)||0:0;
    var pctBiz=parseFloat((document.getElementById('bdd-pct-biz')||{}).value)||0;
    r=computeFlatRateJob(price,taxable,jordan,avery,flatEmps,pctQ,pctL,pctBiz);
    if(!r.valid){toast(r.error);return;}
    var biz=r.splits.find(function(s){return s.tag==='biz';});
    expenses=+r.splits.filter(function(s){return s.tag!=='biz';}).reduce(function(s,x){return s+x.amount;},0).toFixed(2);
    profit=+(biz?biz.amount:0).toFixed(2);
    empNames=flatEmps.map(function(e){return e.name;}).filter(function(n){return n!==mgrN;});
    var empFlatAmts={devon:0,priya:0,marco:0,theo:0,harlan:0,sawyer:0};
    flatEmps.forEach(function(e){empFlatAmts[e.name.toLowerCase()]=e.amount;});
    jobExtra={flatRate:true,empFlatAmts:empFlatAmts,customSplitPcts:{q:pctQ,l:pctL,biz:pctBiz}};
  } else {
    var empN=getEmpNames();
    r=computeSplitsFor(price,jordan,avery,empN,mgrN);
    if(!r.valid){toast(r.error);return;}
    var biz=r.splits.find(function(s){return s.tag==='biz';});
    expenses=+r.splits.filter(function(s){return s.tag!=='biz';}).reduce(function(s,x){return s+x.amount;},0).toFixed(2);
    profit=+(biz?biz.amount:0).toFixed(2);
    empNames=empN;
    jobExtra={flatRate:false,empFlatAmts:null,customSplitPcts:null};
  }

  var job=Object.assign({
    id:Date.now(),
    date:document.getElementById('bdd-job-date').value||today,
    desc:document.getElementById('bdd-desc').value.trim()||r.type,
    type:r.type,price:price,revenue:price,taxable:taxable,tips:tips,
    jordanPresent:jordan,averyPresent:avery,empNames:empNames,managerName:mgrN,
    splits:r.splits,expenses:expenses,tax_withholding:taxAmt,profit:profit,
    referral:isReferral,referralBy:refName,referralAmt:refAmt,
    paidOut:!!(document.getElementById('bdd-paidout')||{}).checked,
    location:newJobLoc
  }, jobExtra);

  var btn=document.getElementById('bdd-save-btn');
  btn.disabled=true;btn.textContent='Saving...';
  try{
    var res=await fetch(API,{method:'POST',headers:hdr(),body:JSON.stringify(job)});
    if(!res.ok)throw new Error('HTTP '+res.status);
    jobs.unshift(job);refresh();
    toast((!showBoth && job.location!==loc) ? 'Saved to '+job.location+' — switch locations to see it' : 'Job saved!');
    resetForm();
  }catch(e){toast('Error saving. Try again.');console.error(e);}
  finally{btn.disabled=false;btn.textContent='Save Job to History';}
};

function resetForm(){
  ['bdd-desc','bdd-price','bdd-tips','bdd-pct-q','bdd-pct-l','bdd-pct-biz','bdd-mgr-flat'].forEach(function(id){
    var el=document.getElementById(id);if(el)el.value='';
  });
  var tx=document.getElementById('bdd-taxable');if(tx)tx.checked=false;
  var d=new Date(),p=function(n){return String(n).padStart(2,'0');};
  var dEl=document.getElementById('bdd-job-date');if(dEl)dEl.value=d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());
  jordan=false;avery=false;devon=false;priya=false;marco=false;theo=false;manager='';
  var qb=document.getElementById('bdd-q-btn');if(qb)qb.classList.remove('active');
  var lb=document.getElementById('bdd-l-btn');if(lb)lb.classList.remove('active');
  var cs=document.getElementById('bdd-custom-split');if(cs)cs.style.display='none';
  referralBy='';
  var refCb=document.getElementById('bdd-referral');if(refCb)refCb.checked=false;
  var refSec=document.getElementById('bdd-referral-section');if(refSec)refSec.style.display='none';
  var refAmtEl=document.getElementById('bdd-referral-amt');if(refAmtEl)refAmtEl.value='';
  syncReferralBtns();
  var poEl=document.getElementById('bdd-paidout');if(poEl)poEl.checked=false;
  if(!showBoth) newJobLoc=loc;
  syncJobLocBtns();
  syncEmpButtons();syncManagerBtns();bddCalc();
}

// ── Edit panel ─────────────────────────────────────────────────
function editEmpSelected(){ return [editDevon,editPriya,editMarco,editTheo].filter(Boolean).length; }

function syncEditEmpButtons(jobId){
  var maxed=editEmpSelected()>=3;
  [{btn:'bdd-ec-'+jobId,  flat:'bdd-fi-devon-'+jobId,st:editDevon},
   {btn:'bdd-ei-'+jobId,  flat:'bdd-fi-priya-'+jobId,  st:editPriya},
   {btn:'bdd-eryn-'+jobId,flat:'bdd-fi-marco-'+jobId, st:editMarco},
   {btn:'bdd-enat-'+jobId,flat:'bdd-fi-theo-'+jobId, st:editTheo}].forEach(function(o){
    var b=document.getElementById(o.btn);
    if(b){b.classList.toggle('active',o.st);b.classList.toggle('emp-disabled',maxed&&!o.st);}
    var f=document.getElementById(o.flat);
    if(f){
      f.style.display=o.st?'block':'none';
      if(!o.st)f.value='';
    }
  });
}

function syncEditManagerBtns(jobId){
  ['harlan','sawyer'].forEach(function(m){
    var b=document.getElementById('bdd-emgr-'+m+'-'+jobId);
    if(b) b.classList.toggle('active',editManager===m);
  });
  var f=document.getElementById('bdd-fi-mgr-'+jobId);
  if(f){ f.style.display=editManager?'block':'none'; if(!editManager) f.value=''; }
}

function updateEditBreakdown(){
  if(!editId)return;
  var bkd=document.getElementById('bdd-ed-bkd-'+editId);if(!bkd)return;
  var priceEl=document.getElementById('bdd-ed-price-'+editId);
  var taxEl=document.getElementById('bdd-ed-tax-'+editId);
  var tipsEl=document.getElementById('bdd-ed-tips-'+editId);
  var price=priceEl?parseFloat(priceEl.value)||0:0;
  var taxable=taxEl?taxEl.checked:false;
  var tips=tipsEl?parseFloat(tipsEl.value)||0:0;

  var editFlatEmps=getEditFlatRateEmps();
  var usingFlat=editFlatEmps.length>0;

  if(usingFlat){
    if(!editQ&&!editL){bkd.innerHTML='<div class="bdd-bkd-placeholder">Flat-rate needs at least one owner</div>';return;}
    var pqEl=document.getElementById('bdd-epq-'+editId);
    var plEl=document.getElementById('bdd-epl-'+editId);
    var pbEl=document.getElementById('bdd-epbiz-'+editId);
    var pctQ=editQ?parseFloat(pqEl?pqEl.value:0)||0:0;
    var pctL=editL?parseFloat(plEl?plEl.value:0)||0:0;
    var pctBiz=parseFloat(pbEl?pbEl.value:0)||0;
    bkd.innerHTML=buildFlatRateBreakdownHtml(computeFlatRateJob(price,taxable,editQ,editL,editFlatEmps,pctQ,pctL,pctBiz),tips);
    return;
  }
  var empN=getEditEmpNames();
  var mgrN=editManagerName();
  if(!editQ&&!editL&&empN.length===0&&!mgrN){bkd.innerHTML='<div class="bdd-bkd-placeholder">Select owners, employees, or a manager</div>';return;}
  bkd.innerHTML=buildBreakdownHtml(computeSplitsFor(price,editQ,editL,empN,mgrN),price,taxable,tips);
}

window.bddEditCalc = function(){ updateEditBreakdown(); };

window.bddOpenEdit = function(jobId){
  if(editId!==null) bddCloseEdit();
  var job=jobs.find(function(j){return j.id===jobId;});if(!job)return;
  editId=jobId;
  editLoc=jobLoc(job);
  editQ=job.jordanPresent||false;
  editL=job.averyPresent||false;
  var en=job.empNames||[];
  editDevon=en.indexOf('Devon')!==-1;
  editPriya=en.indexOf('Priya')!==-1;
  editMarco=en.indexOf('Marco')!==-1;
  editTheo=en.indexOf('Theo')!==-1;
  editManager=(job.managerName||'').toLowerCase();
  if(editManager!=='harlan'&&editManager!=='sawyer'){
    // Legacy jobs saved before the manager role — Harlan/Sawyer logged as an employee
    if(en.indexOf('Harlan')!==-1) editManager='harlan';
    else if(en.indexOf('Sawyer')!==-1) editManager='sawyer';
    else editManager='';
  }

  var qb=document.getElementById('bdd-eq-'+jobId);if(qb)qb.classList.toggle('active',editQ);
  var lb=document.getElementById('bdd-el-'+jobId);if(lb)lb.classList.toggle('active',editL);
  syncEditEmpButtons(jobId);
  syncEditManagerBtns(jobId);

  // Pre-fill flat rate inputs if this is a flat rate job
  if(job.flatRate && job.empFlatAmts){
    var fa=job.empFlatAmts;
    ['devon','priya','marco','theo'].forEach(function(e){
      var fi=document.getElementById('bdd-fi-'+e+'-'+jobId);
      if(fi&&fa[e]>0){fi.value=fa[e];fi.style.display='block';}
    });
    if(editManager && fa[editManager]>0){
      var mfi=document.getElementById('bdd-fi-mgr-'+jobId);
      if(mfi){mfi.value=fa[editManager];mfi.style.display='block';}
    }
  }

  updateEditBreakdown();
  var panel=document.getElementById('bdd-ep-'+jobId);if(panel)panel.classList.add('open');
  var ebtn=document.getElementById('bdd-eb-'+jobId);if(ebtn)ebtn.classList.add('active');
};

window.bddCloseEdit = function(){
  if(editId===null)return;
  var panel=document.getElementById('bdd-ep-'+editId);if(panel)panel.classList.remove('open');
  var ebtn=document.getElementById('bdd-eb-'+editId);if(ebtn)ebtn.classList.remove('active');
  editId=null;editQ=false;editL=false;editDevon=false;editPriya=false;editMarco=false;editTheo=false;editManager='';
};

window.bddEditOwner = function(o){
  if(!editId)return;
  if(o==='q'){editQ=!editQ;var qb=document.getElementById('bdd-eq-'+editId);if(qb)qb.classList.toggle('active',editQ);}
  else       {editL=!editL;var lb=document.getElementById('bdd-el-'+editId);if(lb)lb.classList.toggle('active',editL);}
  updateEditBreakdown();
};

window.bddEditEmp = function(e){
  if(!editId)return;
  if(e==='devon'){ if(!editDevon && editEmpSelected()>=3)return; editDevon=!editDevon; }
  else if(e==='priya'){  if(!editPriya   && editEmpSelected()>=3)return; editPriya=!editPriya;   }
  else if(e==='marco'){ if(!editMarco  && editEmpSelected()>=3)return; editMarco=!editMarco; }
  else if(e==='theo'){ if(!editTheo  && editEmpSelected()>=3)return; editTheo=!editTheo; }
  var empState={devon:editDevon,priya:editPriya,marco:editMarco,theo:editTheo};
  ['devon','priya','marco','theo'].forEach(function(emp){
    var fi=document.getElementById('bdd-fi-'+emp+'-'+editId);
    if(fi){fi.style.display=empState[emp]?'block':'none';if(!empState[emp])fi.value='';}
  });
  syncEditEmpButtons(editId);updateEditBreakdown();
};

window.bddEditManager = function(jobId,m){
  if(editId!==jobId)return;
  editManager=(editManager===m)?'':m;
  syncEditManagerBtns(jobId);
  updateEditBreakdown();
};

window.bddToggleEditReferral = function(jobId){
  var cb=document.getElementById('bdd-ed-ref-'+jobId);
  var sec=document.getElementById('bdd-ed-ref-sec-'+jobId);
  if(sec) sec.style.display=(cb&&cb.checked)?'block':'none';
};

window.bddSetEditReferrer = function(jobId,e){
  var btn=document.getElementById('bdd-er-'+e+'-'+jobId);
  var isActive=btn&&btn.classList.contains('active');
  ['devon','priya','marco','theo'].forEach(function(emp){
    var b=document.getElementById('bdd-er-'+emp+'-'+jobId);
    if(b) b.classList.remove('active');
  });
  if(!isActive&&btn) btn.classList.add('active');
};

window.bddSaveEdit = async function(jobId){
  if(editId!==jobId)return;
  var priceEl=document.getElementById('bdd-ed-price-'+jobId);
  var price=priceEl?parseFloat(priceEl.value)||0:0;
  if(price<=0){toast('Enter a job price');return;}
  var taxEl=document.getElementById('bdd-ed-tax-'+jobId);
  var taxable=taxEl?taxEl.checked:false;
  var tipsEl=document.getElementById('bdd-ed-tips-'+jobId);
  var tips=tipsEl?+(parseFloat(tipsEl.value)||0).toFixed(2):0;
  var taxAmt=taxable?+(price*TAX).toFixed(2):0;
  var mgrN=editManagerName();

  var editFlatEmps=getEditFlatRateEmps();
  var isFlatRate=editFlatEmps.length>0;
  var r, expenses, profit, empNames, jobExtra;

  if(isFlatRate){
    var pqEl=document.getElementById('bdd-epq-'+jobId);
    var plEl=document.getElementById('bdd-epl-'+jobId);
    var pbEl=document.getElementById('bdd-epbiz-'+jobId);
    var pctQ=editQ?parseFloat(pqEl?pqEl.value:0)||0:0;
    var pctL=editL?parseFloat(plEl?plEl.value:0)||0:0;
    var pctBiz=parseFloat(pbEl?pbEl.value:0)||0;
    r=computeFlatRateJob(price,taxable,editQ,editL,editFlatEmps,pctQ,pctL,pctBiz);
    if(!r.valid){toast(r.error);return;}
    var biz=r.splits.find(function(s){return s.tag==='biz';});
    expenses=+r.splits.filter(function(s){return s.tag!=='biz';}).reduce(function(s,x){return s+x.amount;},0).toFixed(2);
    profit=+(biz?biz.amount:0).toFixed(2);
    empNames=editFlatEmps.map(function(e){return e.name;}).filter(function(n){return n!==mgrN;});
    var empFlatAmts={devon:0,priya:0,marco:0,theo:0,harlan:0,sawyer:0};
    editFlatEmps.forEach(function(e){empFlatAmts[e.name.toLowerCase()]=e.amount;});
    jobExtra={flatRate:true,empFlatAmts:empFlatAmts,customSplitPcts:{q:pctQ,l:pctL,biz:pctBiz}};
  } else {
    var empN=getEditEmpNames();
    r=computeSplitsFor(price,editQ,editL,empN,mgrN);
    if(!r.valid){toast(r.error);return;}
    var biz=r.splits.find(function(s){return s.tag==='biz';});
    expenses=+r.splits.filter(function(s){return s.tag!=='biz';}).reduce(function(s,x){return s+x.amount;},0).toFixed(2);
    profit=+(biz?biz.amount:0).toFixed(2);
    empNames=empN;
    jobExtra={flatRate:false,empFlatAmts:null,customSplitPcts:null};
  }

  var refEditCb=document.getElementById('bdd-ed-ref-'+jobId);
  var isEditReferral=refEditCb?refEditCb.checked:false;
  var refEditBy='';
  if(isEditReferral){
    ['devon','priya','marco','theo'].forEach(function(e){
      var b=document.getElementById('bdd-er-'+e+'-'+jobId);
      if(b&&b.classList.contains('active')) refEditBy=e.charAt(0).toUpperCase()+e.slice(1);
    });
  }
  var refEditAmtEl=document.getElementById('bdd-er-amt-'+jobId);
  var refEditAmt=isEditReferral?+(parseFloat(refEditAmtEl?refEditAmtEl.value:0)||0).toFixed(2):0;

  var descEl=document.getElementById('bdd-ed-desc-'+jobId);
  var dateEl=document.getElementById('bdd-ed-date-'+jobId);
  var job=jobs.find(function(j){return j.id===jobId;});if(!job)return;
  var updated=Object.assign({},job,{
    desc:(descEl&&descEl.value.trim())||job.desc,
    date:(dateEl&&dateEl.value)||job.date,
    price:price,revenue:price,taxable:taxable,tips:tips,
    jordanPresent:editQ,averyPresent:editL,empNames:empNames,managerName:mgrN,
    splits:r.splits,type:r.type,
    expenses:expenses,tax_withholding:taxAmt,profit:profit,
    referral:isEditReferral,referralBy:refEditBy,referralAmt:refEditAmt,
    paidOut:!!((document.getElementById('bdd-ed-paid-'+jobId)||{}).checked),
    location:editLoc
  },jobExtra);

  var saveBtn=document.getElementById('bdd-es-'+jobId);
  if(saveBtn){saveBtn.disabled=true;saveBtn.textContent='Saving...';}
  try{
    var res=await fetch(API,{method:'PUT',headers:hdr(),body:JSON.stringify(updated)});
    if(!res.ok)throw new Error('HTTP '+res.status);
    for(var i=0;i<jobs.length;i++){if(jobs[i].id===jobId){jobs[i]=updated;break;}}
    bddCloseEdit();refresh();toast('Job updated!');
  }catch(e){
    toast('Error updating. Try again.');console.error(e);
    if(saveBtn){saveBtn.disabled=false;saveBtn.textContent='Save Changes';}
  }
};

// ── Delete ─────────────────────────────────────────────────────
window.bddDeleteJob = async function(id){
  if(!confirm('Delete this job?'))return;
  try{
    var res=await fetch(API+'?id='+id,{method:'DELETE',headers:hdr()});
    if(!res.ok)throw new Error('HTTP '+res.status);
    jobs=jobs.filter(function(j){return j.id!==id;});refresh();toast('Job deleted.');
  }catch(e){toast('Error deleting.');}
};

// ── Danger zone ────────────────────────────────────────────────
window.bddOpenDanger=function(){
  document.getElementById('bdd-danger-panel').classList.add('open');
  setTimeout(function(){var i=document.getElementById('bdd-danger-input');if(i){i.value='';i.focus();}},300);
  document.getElementById('bdd-danger-confirm').classList.remove('ready');
};
window.bddCloseDanger=function(){
  document.getElementById('bdd-danger-panel').classList.remove('open');
  var i=document.getElementById('bdd-danger-input');if(i)i.value='';
  document.getElementById('bdd-danger-confirm').classList.remove('ready');
};
window.bddCheckDanger=function(){
  var v=document.getElementById('bdd-danger-input').value;
  document.getElementById('bdd-danger-confirm').classList.toggle('ready',v==='DELETE HISTORY');
};
window.bddConfirmDanger=async function(){
  bddCloseDanger();
  try{await fetch(API+'?clear=1',{method:'DELETE',headers:hdr()});jobs=[];refresh();toast('History cleared.');}
  catch(e){toast('Error clearing.');}
};

// ── Filter / sort ──────────────────────────────────────────────
window.bddSetFilter=function(f,el){
  filter=f;
  document.querySelectorAll('#bdd-calc .bdd-pill').forEach(function(p){p.classList.remove('active');});
  el.classList.add('active');refresh();
};
window.bddToggleSort=function(){
  sortAsc=!sortAsc;
  var b=document.getElementById('bdd-sort-btn');
  if(b)b.textContent=sortAsc?'↑ Oldest First':'↓ Newest First';
  refresh();
};

function filtered(){
  var now=new Date();
  return jobs.filter(function(j){
    if(!showBoth && jobLoc(j)!==loc) return false;
    var d=new Date((j.date||'')+'T12:00:00');
    if(filter==='week'){var m=new Date(now);m.setDate(now.getDate()-(now.getDay()===0?6:now.getDay()-1));m.setHours(0,0,0,0);return d>=m;}
    if(filter==='month')return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();
    if(filter==='year')return d.getFullYear()===now.getFullYear();
    return true;
  }).sort(function(a,b){
    var da=new Date((a.date||'')+'T12:00:00'),db=new Date((b.date||'')+'T12:00:00');
    if(da.getTime()!==db.getTime()) return sortAsc?da-db:db-da;
    return sortAsc?a.id-b.id:b.id-a.id;
  });
}

// ── Chart ──────────────────────────────────────────────────────
function renderChart(list){
  var el=document.getElementById('bdd-chart');if(!el)return;
  var chunk=list.slice().reverse().slice(-14);
  if(!chunk.length){el.innerHTML='<div class="bdd-chart-empty">No jobs yet</div>';return;}
  var max=Math.max.apply(null,chunk.map(function(j){return j.revenue||j.price||0;}));
  el.innerHTML=chunk.map(function(j){
    var h=max>0?Math.max(6,Math.round(((j.revenue||j.price||0)/max)*60)):6;
    var d=new Date((j.date||'')+'T12:00:00');
    var lbl=d.toLocaleDateString('en-US',{month:'numeric',day:'numeric'});
    return '<div class="bdd-bar-col" title="'+esc(j.desc||'')+' - '+fmt(j.revenue||j.price||0)+'"><div class="bdd-bar" style="height:'+h+'px;"></div><div class="bdd-bar-lbl">'+lbl+'</div></div>';
  }).join('');
}

// ── Payout Tracker ─────────────────────────────────────────────
function renderPayoutTracker(list){
  var el=document.getElementById('bdd-payout-tracker');if(!el)return;
  var owners=['Jordan','Avery'];
  var emps=['Devon','Priya','Marco','Theo'];
  var mgrs=['Harlan','Sawyer'];
  var totals={};
  owners.concat(emps).concat(mgrs).forEach(function(p){totals[p]=0;});
  list.forEach(function(j){
    (j.splits||[]).forEach(function(s){
      if(s.tag!=='biz' && totals.hasOwnProperty(s.name)){
        totals[s.name]=+(totals[s.name]+(s.amount||0)).toFixed(2);
      }
    });
  });
  function card(p,cls){
    return '<div class="bdd-pt-card'+(cls?' '+cls:'')+'"><div class="bdd-pt-name">'+p+'</div><div class="bdd-pt-amt">'+fmt(totals[p])+'</div></div>';
  }
  el.innerHTML=
    '<div class="bdd-pt-row pt-owners">'+owners.map(function(p){return card(p,'pt-owner');}).join('')+'</div>'+
    '<div class="bdd-pt-row pt-emps">'+emps.map(function(p){return card(p,'');}).join('')+'</div>'+
    '<div class="bdd-pt-row pt-mgrs">'+mgrs.map(function(p){return card(p,'pt-mgr');}).join('')+'</div>';
}

// ── Summary ────────────────────────────────────────────────────
function renderSummary(list){
  var rev=0,exp=0,tax=0,prof=0,tips=0,ref=0;
  list.forEach(function(j){
    rev+=j.revenue||j.price||0;
    exp+=j.expenses||0;
    tax+=j.tax_withholding||0;
    prof+=j.profit||0;
    tips+=j.tips||0;
    if(j.referral) ref+=j.referralAmt||0;
  });
  animateTo('bdd-s-rev',rev);animateTo('bdd-s-exp',exp);animateTo('bdd-s-tax',tax);animateTo('bdd-s-prof',prof-ref);animateTo('bdd-s-tips',tips);
  var jEl=document.getElementById('bdd-s-jobs');if(jEl)jEl.textContent=list.length+' job'+(list.length!==1?'s':'');
  var rEl=document.getElementById('bdd-s-ref-note');if(rEl)rEl.textContent=ref>0?' · less '+fmt(ref)+' referrals':'';
}

// ── Timeline ───────────────────────────────────────────────────
function typeLabel(t){if(!t&&t!==0)return'';return(/^\d+$/.test(String(t))?'Job '+t:String(t));}

function renderTimeline(list){
  var el=document.getElementById('bdd-timeline');if(!el)return;
  if(!list.length){
    el.innerHTML='<div class="bdd-empty">'+(filter==='all'?'No '+(showBoth?'':loc+' ')+'jobs yet.<br>Calculate a payout above and hit Save.':'No '+(showBoth?'':loc+' ')+'jobs for this period.')+'</div>';
    return;
  }
  el.innerHTML=list.map(function(j){
    var dateStr=new Date((j.date||'')+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
    var splits=j.splits||[];
    var share=tipShareFor(splits, j.tips);
    var payoutsHtml=splits.map(function(s){
      var tipBox=(share>0 && isWorking(s))?'<div class="bdd-payout-tip">+'+fmt(share)+' tip</div>':'';
      return '<div class="bdd-payout-item'+(s.tag==='biz'?' biz':'')+'"><div class="bdd-payout-name">'+esc(s.name)+roleTag(s)+'</div><div class="bdd-payout-amt">'+fmt(s.amount)+'</div>'+tipBox+'</div>';
    }).join('');
    var taxChip=j.taxable?'<span class="bdd-chip tax">Tax &minus;'+fmt(j.tax_withholding||0)+'</span>':'';
    var tipsChip=(j.tips&&j.tips>0)?'<span class="bdd-chip tips">Tips +'+fmt(j.tips)+'</span>':'';
    var flatChip=j.flatRate?'<span class="bdd-chip flat-rate-chip">Flat Rate</span>':'';
    var refChip=(j.referral&&j.referralBy)?'<span class="bdd-chip ref">'+esc(j.referralBy)+' referral +'+fmt(j.referralAmt||0)+'</span>':'';
    var mgrChip=j.managerName?'<span class="bdd-chip mgr">Mgr: '+esc(j.managerName)+'</span>':'';
    var taxAttr=j.taxable?'checked':'';
    var refByVal=j.referral&&j.referralBy?j.referralBy.toLowerCase():'';
    var en=j.empNames||[];
    var eDevon=en.indexOf('Devon')!==-1;
    var ePriya=en.indexOf('Priya')!==-1;
    var eMarco=en.indexOf('Marco')!==-1;
    var eTheo=en.indexOf('Theo')!==-1;
    var mgrVal=(j.managerName||'').toLowerCase();
    if(mgrVal!=='harlan'&&mgrVal!=='sawyer'){
      if(en.indexOf('Harlan')!==-1) mgrVal='harlan';
      else if(en.indexOf('Sawyer')!==-1) mgrVal='sawyer';
      else mgrVal='';
    }
    var fa=j.empFlatAmts||{};
    var mgrFlatVal=(j.flatRate && mgrVal && fa[mgrVal]>0) ? fa[mgrVal] : '';
    var pcts=j.customSplitPcts||{};

    // Employee section for the edit panel
    var empEditHtml;
    if(j.flatRate){
      var editEmpIds={devon:'bdd-ec-',priya:'bdd-ei-',marco:'bdd-eryn-',theo:'bdd-enat-'};
      empEditHtml=(
        '<div class="bdd-field"><label>Employees</label>'+
        '<div class="bdd-emp-flat-grid">'+
        [['devon','Devon',eDevon],['priya','Priya',ePriya],['marco','Marco',eMarco],['theo','Theo',eTheo]].map(function(e){
          return '<div class="bdd-emp-flat-col">'+
            '<button class="bdd-owner-toggle'+(e[2]?' active':'')+'" id="'+editEmpIds[e[0]]+j.id+'" onclick="bddEditEmp(\''+e[0]+'\')">'+e[1]+'</button>'+
            '<input type="number" class="bdd-flat-input" id="bdd-fi-'+e[0]+'-'+j.id+'" placeholder="Flat $" min="0" step="1" value="'+(e[2]&&fa[e[0]]>0?fa[e[0]]:'')+'" style="display:'+(e[2]?'block':'none')+'" oninput="bddEditCalc()" />'+
          '</div>';
        }).join('')+
        '</div></div>'+
        '<div class="bdd-custom-split-wrap">'+
          '<div class="bdd-bkd-title" style="color:#4a9ede;margin-bottom:10px;">Owner / Business Split</div>'+
          '<div class="bdd-custom-pct-row">'+
          (j.jordanPresent?'<div class="bdd-custom-pct-item"><label>Jordan</label><div class="bdd-pct-input-wrap"><input type="number" id="bdd-epq-'+j.id+'" value="'+(pcts.q||0)+'" min="0" max="100" step="1" oninput="bddEditCalc()" /><span>%</span></div></div>':'')+
          (j.averyPresent?'<div class="bdd-custom-pct-item"><label>Avery</label><div class="bdd-pct-input-wrap"><input type="number" id="bdd-epl-'+j.id+'" value="'+(pcts.l||0)+'" min="0" max="100" step="1" oninput="bddEditCalc()" /><span>%</span></div></div>':'')+
          '<div class="bdd-custom-pct-item"><label>Business</label><div class="bdd-pct-input-wrap"><input type="number" id="bdd-epbiz-'+j.id+'" value="'+(pcts.biz||0)+'" min="0" max="100" step="1" oninput="bddEditCalc()" /><span>%</span></div></div>'+
          '</div>'+
        '</div>'
      );
    } else {
      empEditHtml=(
        '<div class="bdd-field"><label>Employees</label>'+
        '<div class="bdd-toggle-row">'+
          '<button class="bdd-owner-toggle'+(eDevon?' active':'')+'" id="bdd-ec-'+j.id+'" onclick="bddEditEmp(\'devon\')">Devon</button>'+
          '<button class="bdd-owner-toggle'+(ePriya?' active':'')+'" id="bdd-ei-'+j.id+'" onclick="bddEditEmp(\'priya\')">Priya</button>'+
          '<button class="bdd-owner-toggle'+(eMarco?' active':'')+'" id="bdd-eryn-'+j.id+'" onclick="bddEditEmp(\'marco\')">Marco</button>'+
          '<button class="bdd-owner-toggle'+(eTheo?' active':'')+'" id="bdd-enat-'+j.id+'" onclick="bddEditEmp(\'theo\')">Theo</button>'+
        '</div></div>'
      );
    }

    // Regional Manager section for the edit panel (always shown)
    var mgrEditHtml=(
      '<div class="bdd-field"><label>Regional Manager (on-site)</label>'+
      '<div class="bdd-toggle-row">'+
        '<button class="bdd-owner-toggle'+(mgrVal==='harlan'?' active':'')+'" id="bdd-emgr-harlan-'+j.id+'" onclick="bddEditManager('+j.id+',\'harlan\')">Harlan</button>'+
        '<button class="bdd-owner-toggle'+(mgrVal==='sawyer'?' active':'')+'" id="bdd-emgr-sawyer-'+j.id+'" onclick="bddEditManager('+j.id+',\'sawyer\')">Sawyer</button>'+
      '</div>'+
      '<div class="bdd-flat-row"><input type="number" class="bdd-flat-input" id="bdd-fi-mgr-'+j.id+'" placeholder="Manager flat $" min="0" step="1" value="'+(mgrFlatVal||'')+'" style="display:'+(mgrFlatVal?'block':'none')+'" oninput="bddEditCalc()" /></div>'+
      '</div>'
    );

    return (
      '<div class="bdd-job-card'+(j.flatRate?' flat-rate':'')+(j.paidOut?' paid-out':' not-paid')+'" id="bdd-jc-'+j.id+'">' +
        '<div class="bdd-job-body">' +
          '<div class="bdd-job-top">' +
            '<div class="bdd-job-meta"><div class="bdd-job-date">'+dateStr+'</div><div class="bdd-job-name">'+esc(j.desc||'')+'</div></div>' +
            '<div class="bdd-job-right">' +
              '<div class="bdd-job-price">'+fmt(j.price||j.revenue||0)+'</div>' +
              '<button class="bdd-job-btn edit" id="bdd-eb-'+j.id+'" onclick="bddOpenEdit('+j.id+')" title="Edit">&#9998;</button>' +
              '<button class="bdd-job-btn del" onclick="bddDeleteJob('+j.id+')" title="Delete">&times;</button>' +
            '</div>' +
          '</div>' +
          '<div class="bdd-job-chips">' +
            '<span class="bdd-chip type">'+esc(typeLabel(j.type))+'</span>' +
            (showBoth ? '<span class="bdd-chip loc loc-'+locCode(jobLoc(j)).toLowerCase()+'">'+locCode(jobLoc(j))+'</span>' : '') +
            flatChip + mgrChip +
            '<span class="bdd-chip exp">Expenses '+fmt(j.expenses||0)+'</span>' +
            '<span class="bdd-chip prof">Profit '+fmt(j.profit||0)+'</span>' +
            taxChip + tipsChip + refChip +
          '</div>' +
          '<div class="bdd-payout-grid">'+payoutsHtml+'</div>' +
        '</div>' +
        '<div class="bdd-edit-panel" id="bdd-ep-'+j.id+'">' +
          '<div class="bdd-edit-inner">' +
            '<div class="bdd-two-col" style="margin-bottom:10px;">' +
              '<div class="bdd-field" style="margin-bottom:0;"><label>Description</label><input type="text" id="bdd-ed-desc-'+j.id+'" value="'+esc(j.desc||'')+'" /></div>' +
              '<div class="bdd-field" style="margin-bottom:0;"><label>Date</label><input type="date" id="bdd-ed-date-'+j.id+'" value="'+(j.date||'')+'" /></div>' +
            '</div>' +
            '<div class="bdd-two-col" style="margin-bottom:10px;">' +
              '<div class="bdd-field" style="margin-bottom:0;"><label>Job Price</label><input type="number" id="bdd-ed-price-'+j.id+'" value="'+(j.price||j.revenue||'')+'" min="0" step="1" oninput="bddEditCalc()" /></div>' +
              '<div class="bdd-field" style="margin-bottom:0;"><label>Tips (tracking only)</label><input type="number" id="bdd-ed-tips-'+j.id+'" value="'+(j.tips||'')+'" min="0" step="1" placeholder="0.00" oninput="bddEditCalc()" /></div>' +
            '</div>' +
            '<label class="bdd-checkbox-row"><input type="checkbox" id="bdd-ed-tax-'+j.id+'" '+taxAttr+' onchange="bddEditCalc()" /><span>Taxable - withhold 8.75%</span></label>' +
            '<label class="bdd-checkbox-row"><input type="checkbox" id="bdd-ed-ref-'+j.id+'" '+(j.referral?'checked':'')+' onchange="bddToggleEditReferral('+j.id+')" /><span>Referral Job</span></label>' +
            '<div id="bdd-ed-ref-sec-'+j.id+'" style="display:'+(j.referral?'block':'none')+';">' +
              '<div class="bdd-two-col" style="margin-bottom:10px;">' +
                '<div class="bdd-field" style="margin-bottom:0;"><label>Referred By</label>' +
                  '<div class="bdd-toggle-row" style="margin-bottom:0;">' +
                    '<button class="bdd-owner-toggle'+(refByVal==='devon'?' active':'')+'" id="bdd-er-devon-'+j.id+'" onclick="bddSetEditReferrer('+j.id+',\'devon\')">Devon</button>' +
                    '<button class="bdd-owner-toggle'+(refByVal==='priya'?' active':'')+'" id="bdd-er-priya-'+j.id+'" onclick="bddSetEditReferrer('+j.id+',\'priya\')">Priya</button>' +
                    '<button class="bdd-owner-toggle'+(refByVal==='marco'?' active':'')+'" id="bdd-er-marco-'+j.id+'" onclick="bddSetEditReferrer('+j.id+',\'marco\')">Marco</button>' +
                    '<button class="bdd-owner-toggle'+(refByVal==='theo'?' active':'')+'" id="bdd-er-theo-'+j.id+'" onclick="bddSetEditReferrer('+j.id+',\'theo\')">Theo</button>' +
                  '</div>' +
                '</div>' +
                '<div class="bdd-field" style="margin-bottom:0;"><label>Referral Bonus</label><input type="number" id="bdd-er-amt-'+j.id+'" value="'+(j.referral&&j.referralAmt?j.referralAmt:'')+'" placeholder="0.00" min="0" step="1" /></div>' +
              '</div>' +
            '</div>' +
            '<div class="bdd-field"><label>Location</label>' +
              '<div class="bdd-toggle-row">' +
                LOCS.map(function(l){ return '<button class="bdd-owner-toggle bdd-loc-toggle loc-'+locCode(l).toLowerCase()+(jobLoc(j)===l?' active':'')+'" id="bdd-eloc-'+locCode(l).toLowerCase()+'-'+j.id+'" onclick="bddEditLoc('+j.id+',\''+l+'\')">'+l+'</button>'; }).join('') +
              '</div>' +
            '</div>' +
            '<div class="bdd-field"><label>Owners Present</label>' +
              '<div class="bdd-toggle-row">' +
                '<button class="bdd-owner-toggle'+(j.jordanPresent?' active':'')+'" id="bdd-eq-'+j.id+'" onclick="bddEditOwner(\'q\')">Jordan</button>' +
                '<button class="bdd-owner-toggle'+(j.averyPresent?' active':'')+'" id="bdd-el-'+j.id+'" onclick="bddEditOwner(\'l\')">Avery</button>' +
              '</div>' +
            '</div>' +
            empEditHtml +
            mgrEditHtml +
            '<div class="bdd-breakdown" style="margin-bottom:12px;"><div class="bdd-bkd-title">Updated Breakdown</div><div id="bdd-ed-bkd-'+j.id+'"><div class="bdd-bkd-placeholder">Click edit to preview</div></div></div>' +
            '<label class="bdd-checkbox-row" style="margin-bottom:14px;"><input type="checkbox" id="bdd-ed-paid-'+j.id+'" '+(j.paidOut?'checked':'')+' /><span>Paid Out</span></label>' +
            '<div class="bdd-edit-actions">' +
              '<button class="bdd-edit-cancel" onclick="bddCloseEdit()">Cancel</button>' +
              '<button class="bdd-edit-save" id="bdd-es-'+j.id+'" onclick="bddSaveEdit('+j.id+')">Save Changes</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }).join('');
}

function refresh(){
  var f=filtered();
  renderSummary(f);renderChart(f);renderPayoutTracker(f);renderTimeline(f);
}

// ── Fetch ──────────────────────────────────────────────────────
async function fetchJobs(){
  try{
    var res=await fetch(API,{headers:hdr()});
    if(!res.ok)throw new Error('HTTP '+res.status);
    var data=await res.json();
    jobs=Array.isArray(data)?data:[];refresh();
  }catch(e){
    var el=document.getElementById('bdd-timeline');
    if(el)el.innerHTML='<div class="bdd-empty">Could not load jobs. Check API connection.</div>';
    console.error('fetchJobs',e);
  }
}

applyLocation();
fetchJobs();
})();
