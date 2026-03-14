// Lightweight port of badminton logic to JS (client-side)

let COURTS = 3;
// ---------------- players ----------------
// Level Giỏi = 10
// Level Khá = 7-9
// Level Trung bình = 4-6
// Level Yếu = 1-3

let players = [
 {name:"Học",level:7,prefer:"challenge",gender:"male"},
 {name:"Huy",level:7,prefer:"challenge",gender:"male"},
 {name:"Nguyên",level:6,prefer:"normal",gender:"male"},
 {name:"Bằng",level:6,prefer:"challenge",gender:"male"},
 {name:"Sang",level:5,prefer:"normal",gender:"male"},
 {name:"Dũng",level:4,prefer:"challenge",gender:"male"},
 {name:"Phước",level:4,prefer:"normal",gender:"male"},
 {name:"Đạt",level:4,prefer:"normal",gender:"male"},
 {name:"Hiếu",level:4,prefer:"normal",gender:"male"},
 {name:"Sơn",level:2,prefer:"normal",gender:"male"},
 {name:"Châu",level:5,prefer:"normal",gender:"female"},
 {name:"Phương",level:4,prefer:"normal",gender:"female"},
 {name:"Thư",level:3,prefer:"normal",gender:"female"},
 {name:"Bình",level:4,prefer:"normal",gender:"male"},
 {name:"Nam",level:4,prefer:"normal",gender:"male"},
 {name:"Thiện",level:4,prefer:"normal",gender:"male"},
 {name:"Cơ",level:3,prefer:"normal",gender:"male"},
 {name:"Quỳnh",level:5,prefer:"normal",gender:"female"},
 {name:"Thảo",level:4,prefer:"normal",gender:"female"},
 {name:"Uyên",level:4,prefer:"normal",gender:"female"}
];

let partner_history = {};
let match_history = [];
let debug_log = [];
let wishTempPrefer = null;
let waiting_for_partner = []; // list of player names to hold until their partner is free

players.forEach(p=>{
  p.rating = p.level*100;
  p.matches = 0; p.wait = 0;
  p.points_for = 0; p.points_against = 0;
  p.ready = (p.ready === undefined) ? true : p.ready;
  p.couple = (p.couple === undefined) ? null : p.couple;
  p.partnerSlot = (p.partnerSlot === undefined) ? null : p.partnerSlot;
});

let active_matches = [];
let queue_matches = [];
let idle_players = [];
const MAX_COUPLE = 5;

// utilities
function team_rating(team){ return team[0].rating + team[1].rating; }
function partner_penalty(team){
  let a = [team[0].name, team[1].name].sort();
  let key = a.join('|');
  return (partner_history[key]||0) * 200;
}

function renderPlayerSpan(p){
  const cls = (p && p.gender === 'female') ? 'female' : 'male';
  return `<span class="player-name ${cls}">${p.name}</span>`;
}
function prefer_penalty(team){
  let penalty = 0;
  team.forEach(p=>{
    if(p && p.prefer === 'challenge') penalty -= 50;
    if(p && p.prefer === 'chill') penalty += 50;
  });
  return penalty;
}

function team_type(team){
  const males = team.filter(p=>p && p.gender === 'male').length;
  const females = team.filter(p=>p && p.gender === 'female').length;
  if(males === 2) return 'MM';
  if(females === 2) return 'FF';
  return 'MF';
}

function best_match(group, allowCrossType=false){
  // group: array of 4 players
  const pairings = [
    [[group[0],group[1]],[group[2],group[3]]],
    [[group[0],group[2]],[group[1],group[3]]],
    [[group[0],group[3]],[group[1],group[2]]]
  ];
  let best = null; let bestScore = 1e12;
  for(const m of pairings){
    const t1 = m[0], t2 = m[1];
    // reject any pairing where two players in the 4-player group share the same uncouple number
    const allPlayers = [t1[0], t1[1], t2[0], t2[1]];
    let conflictUncouple = false;
    for(let i=0;i<allPlayers.length;i++){
      for(let j=i+1;j<allPlayers.length;j++){
        const a = allPlayers[i], b = allPlayers[j];
        if(!a || !b) continue;
        if(a.uncouple && b.uncouple && a.uncouple === b.uncouple){ conflictUncouple = true; break; }
      }
      if(conflictUncouple) break;
    }
    if(conflictUncouple) continue;
    if(!t1[0] || !t1[1] || !t2[0] || !t2[1]) continue;
    const tt1 = team_type(t1), tt2 = team_type(t2);
    // reject any female-only teams: only MM or MF (mixed) are allowed
    if(tt1 === 'FF' || tt2 === 'FF') continue;
    if(tt1 !== tt2){
      if(!allowCrossType) continue; // not allowed to mix types unless pool permits
      // allow cross-type only for MM vs MF (others shouldn't happen)
      const okMix = ( (tt1==='MM' && tt2==='MF') || (tt1==='MF' && tt2==='MM') );
      if(!okMix) continue;
    }
    // additional rule: if both are mixed teams (MF vs MF), ensure the two male players' levels differ by at most 1
    if(tt1 === 'MF' && tt2 === 'MF'){
      const male1 = t1.find(p=>p && p.gender === 'male');
      const male2 = t2.find(p=>p && p.gender === 'male');
      if(!male1 || !male2) continue;
      if(Math.abs((male1.level||0) - (male2.level||0)) > 1) continue;
    }
    let score = Math.abs(team_rating(t1) - team_rating(t2));
    score += partner_penalty(t1) + partner_penalty(t2);
    score += prefer_penalty(t1) + prefer_penalty(t2);
    // couple bonus (prefer keeping assigned couples)
    if(t1[0].couple && t1[0].couple === t1[1].couple) score -= 150;
    if(t2[0].couple && t2[0].couple === t2[1].couple) score -= 150;
    if(score < bestScore){ bestScore = score; best = m; }
  }
  return best;
}

function create_matches(){
  // only consider players who are marked ready and not waiting for a partner
  let readyPlayers = players.filter(p=>{
    if(!p.ready) return false;
    if(p.wait_for_partner) return false;
    if(p.couple){
      const partner = players.find(x=> x.couple === p.couple && x.name !== p.name);
      if(partner && partner.wait_for_partner) return false;
    }
    return true;
  });
  let players_sorted = [...readyPlayers].sort((a,b)=> (a.matches-b.matches)|| (b.wait-a.wait));
  let pool = players_sorted.slice();
  for(let i=pool.length-1;i>0;i--){ let j=Math.floor(Math.random()*(i+1)); [pool[i],pool[j]]=[pool[j],pool[i]]; }
  let matches=[];

  // whether to allow MM vs MF mixing: only when number of females in pool is odd
  const femaleCount = pool.filter(p=>p.gender === 'female').length;
  const allowCrossType = (femaleCount % 2 === 1);

  // Priority: try to form matches that keep couple pairs together first
  // Find couple ids that have at least two players in pool
  const coupleMap = {};
  pool.forEach(p=>{ if(p.couple){ coupleMap[p.couple] = coupleMap[p.couple] || []; coupleMap[p.couple].push(p); } });
  for(const cid in coupleMap){
    const arr = coupleMap[cid];
    if(arr.length >= 2){
      // attempt to form as many matches as possible using these pairs
      while(arr.length >= 2){
        const couplePair = [arr.shift(), arr.shift()];
        // ensure both still in pool
        if(!pool.includes(couplePair[0]) || !pool.includes(couplePair[1])) continue;
        // try to pick two other players and validate via best_match (enforces team rules)
        let formed = false;
        for(let attempt=0; attempt<200 && !formed; attempt++){
          const others = pool.filter(p=> p!==couplePair[0] && p!==couplePair[1]);
          if(others.length < 2) break;
          // pick two random others
          let copy = others.slice();
          let j1 = Math.floor(Math.random()*copy.length); const o1 = copy.splice(j1,1)[0];
          let j2 = Math.floor(Math.random()*copy.length); const o2 = copy.splice(j2,1)[0];
          // use best_match to validate the 4-player grouping and respect MF male-level rule
          const candidate = best_match([couplePair[0], couplePair[1], o1, o2], allowCrossType);
          if(!candidate) continue;
          // ensure the couplePair are kept together as one team in the returned pairing
          const teamContainsCouple = (team)=> (team[0] && team[1] && ((team[0].name===couplePair[0].name && team[1].name===couplePair[1].name) || (team[0].name===couplePair[1].name && team[1].name===couplePair[0].name)));
          if(!teamContainsCouple(candidate[0]) && !teamContainsCouple(candidate[1])) continue;
          // accept this match
          matches.push(candidate);
          // remove used players from pool
          candidate[0].forEach(p=>{ const idx = pool.indexOf(p); if(idx!==-1) pool.splice(idx,1); });
          candidate[1].forEach(p=>{ const idx = pool.indexOf(p); if(idx!==-1) pool.splice(idx,1); });
          // also remove from arr any players no longer in pool
          for(let ii=arr.length-1; ii>=0; ii--){ if(!pool.includes(arr[ii])) arr.splice(ii,1); }
          formed = true;
        }
      }
    }
  }

  // Try to form groups of 4 that yield same-type match (MM vs MM or MF vs MF)
  while(pool.length >=4){
    let found = false;
      for(let k=0;k<200;k++){
      let group = [];
      let copy = pool.slice();
      for(let i=0;i<4;i++){ let j=Math.floor(Math.random()*copy.length); group.push(copy.splice(j,1)[0]); }
      let m = best_match(group, allowCrossType);
      if(m){
        matches.push(m);
        // remove used players from pool
        m[0].forEach(p=>{ let idx = pool.indexOf(p); if(idx!=-1) pool.splice(idx,1); });
        m[1].forEach(p=>{ let idx = pool.indexOf(p); if(idx!=-1) pool.splice(idx,1); });
        found = true; break;
      }
    }
    if(!found) break; // cannot form more constrained matches
  }
  return matches;
}

function initialize(){
  let matches = create_matches();
  let playing = Math.min(COURTS, matches.length);
  active_matches = matches.slice(0,playing);
  queue_matches = matches.slice(playing);
  // ensure active_matches has fixed length equal to COURTS
  while(active_matches.length < COURTS) active_matches.push(null);
  // Process partner slots for any newly assigned active matches
  active_matches.forEach(m=> processMatchPartners(m));
  let used = [].concat(...matches.map(m=>[].concat(...m)));
  // idle players are those not used and marked ready
  idle_players = players.filter(p=> p.ready && !used.includes(p));
}

// rendering
function render(){
  // full render used on init or major state changes
  for(let i=0;i<COURTS;i++) renderCourt(i);
  renderQueue();
  renderIdle();
  renderHistory();
  populateWishLists();
  // attach handlers
  document.querySelectorAll('button[data-court]').forEach(btn=>{ btn.onclick = ()=>{ let idx = parseInt(btn.getAttribute('data-court')); openScoreModal(idx); }; });
}

function populateWishLists(){
  const sel = document.getElementById('wishPlayerSelect');
  const partner = document.getElementById('wishPartnerSelect');
  if(!sel || !partner) return;
  sel.innerHTML = '';
  partner.innerHTML = '';
  // add placeholder options
  const ph1 = document.createElement('option'); ph1.value = ''; ph1.textContent = 'Chọn tên của bạn'; ph1.disabled = true; ph1.selected = true; sel.appendChild(ph1);
  const ph2 = document.createElement('option'); ph2.value = ''; ph2.textContent = 'Chọn tên Partner bạn mong muốn'; ph2.disabled = true; ph2.selected = true; partner.appendChild(ph2);
  players.forEach((p,idx)=>{
    const o = document.createElement('option'); o.value = String(idx); o.textContent = p.name; sel.appendChild(o);
    const o2 = document.createElement('option'); o2.value = String(idx); o2.textContent = p.name; partner.appendChild(o2);
  });
  // reset temporary prefer selection
  wishTempPrefer = null; updateWishBtnVisual();
}

function updateWishBtnVisual(){
  const chill = document.getElementById('wishChill');
  const normal = document.getElementById('wishNormal');
  const challenge = document.getElementById('wishChallenge');
  if(!chill || !normal || !challenge) return;
  const buttons = {chill, normal, challenge};
  for(const key of ['chill','normal','challenge']){
    const btn = buttons[key];
    // use specific selected classes so each preference can have its own color
    btn.classList.remove('wish-selected-chill','wish-selected-normal','wish-selected-challenge');
    if(wishTempPrefer === key){
      btn.classList.add('wish-selected-'+key);
      btn.classList.remove('btn-outline-secondary');
    } else {
      btn.classList.remove('wish-selected-chill','wish-selected-normal','wish-selected-challenge');
      btn.classList.add('btn-outline-secondary');
    }
  }
}

function setPlayerPrefer(idx, prefer){
  if(idx<0 || idx>=players.length) return;
  players[idx].prefer = prefer;
  // make player ready if they choose to play
  if(prefer !== 'chill') players[idx].ready = true;
  saveState(); updateIdlePlayers(); render(); renderAdminPlayers();
}

function setPartnerFor(playerIdx, partnerIdx){
  if(playerIdx===partnerIdx) return alert('Cannot set oneself as partner');
  const p = players[playerIdx]; const q = players[partnerIdx];
  if(!p || !q) return;
  if(q.couple){ p.couple = q.couple; }
  else {
    // assign next available couple id within 1..MAX_COUPLE, reuse if all used
    const existing = players.map(x=>x.couple).filter(x=>x!=null);
    let next = null;
    for(let i=1;i<=MAX_COUPLE;i++){ if(!existing.includes(i)){ next = i; break; } }
    if(next === null) next = 1;
    p.couple = next; q.couple = next;
  }
  // If either is currently assigned to a match/queue, mark BOTH to wait until both are free
  const isAssigned = (pl)=>{
    const name = pl.name;
    for(const m of active_matches){ if(m){ if(m.flat().some(x=>x.name===name)) return true; } }
    for(const m of queue_matches){ if(m){ if(m.flat().some(x=>x.name===name)) return true; } }
    return false;
  };
  if(isAssigned(p) || isAssigned(q)){
    // mark both as waiting for partner so neither will be queued with others
    p.wait_for_partner = true; q.wait_for_partner = true;
    if(!waiting_for_partner.includes(p.name)) waiting_for_partner.push(p.name);
    if(!waiting_for_partner.includes(q.name)) waiting_for_partner.push(q.name);
  } else {
    // clear any previous waiting flag
    p.wait_for_partner = false; q.wait_for_partner = false;
    waiting_for_partner = waiting_for_partner.filter(n=> n!==p.name && n!==q.name);
  }
  saveState(); updateIdlePlayers(); render(); renderAdminPlayers();
}

// Set a shared partnerSlot (P1..P5) between two players and handle waiting flags
function setPartnerSlotBetween(playerIdx, partnerIdx){
  if(playerIdx===partnerIdx) return alert('Cannot set oneself as partner');
  const p = players[playerIdx]; const q = players[partnerIdx];
  if(!p || !q) return;
  // assign next available partner token P1..P5
  const opts = ['P1','P2','P3','P4','P5'];
  const existing = players.map(x=> x.partnerSlot).filter(x=> x!=null);
  let next = null;
  for(const o of opts){ if(!existing.includes(o)){ next = o; break; } }
  if(next === null) next = 'P1';
  p.partnerSlot = next; q.partnerSlot = next;
  // If either is currently assigned to a match/queue, mark BOTH to wait until both are free
  const isAssigned = (pl)=>{
    const name = pl.name;
    for(const m of active_matches){ if(m){ if(m.flat().some(x=>x && x.name===name)) return true; } }
    for(const m of queue_matches){ if(m){ if(m.flat().some(x=>x && x.name===name)) return true; } }
    return false;
  };
  if(isAssigned(p) || isAssigned(q)){
    p.wait_for_partner = true; q.wait_for_partner = true;
    if(!waiting_for_partner.includes(p.name)) waiting_for_partner.push(p.name);
    if(!waiting_for_partner.includes(q.name)) waiting_for_partner.push(q.name);
  } else {
    p.wait_for_partner = false; q.wait_for_partner = false;
    waiting_for_partner = waiting_for_partner.filter(n=> n!==p.name && n!==q.name);
  }
  saveState(); updateIdlePlayers(); render(); renderAdminPlayers();
}

function clearPartnerFor(playerIdx){
  if(playerIdx<0 || playerIdx>=players.length) return;
  const name = players[playerIdx].name;
  const cid = players[playerIdx].couple;
  players[playerIdx].couple = null;
  // clear waiting flags for this player and their partner (if any)
  players[playerIdx].wait_for_partner = false;
  if(cid){
    const partner = players.find(p=> p.couple === cid && p.name !== name);
    if(partner){ partner.wait_for_partner = false; waiting_for_partner = waiting_for_partner.filter(n=> n!==partner.name); }
  }
  waiting_for_partner = waiting_for_partner.filter(n=> n!==name);
  saveState(); updateIdlePlayers(); render(); renderAdminPlayers();
}

function renderCourt(i){
  const courtsRow = document.getElementById('courtsRow');
  // ensure enough children
  while(courtsRow.children.length <= i){ const wrapper = document.createElement('div'); wrapper.className='col-12 court-card'; courtsRow.appendChild(wrapper); }
  const card = courtsRow.children[i];
  let html='';
  if(active_matches[i]){
    let [t1,t2]=active_matches[i];
    html = `<div class="card">
      <div class="card-header position-relative">
        <div class="w-100 text-center fs-5 fw-bold">Sân ${10 + i}</div>
        <div style="position:absolute; right:0.5rem; top:50%; transform:translateY(-50%);"><button class="btn btn-sm btn-edit-match" data-edit-court="${i}">Edit</button></div>
      </div>
      <div class="card-body d-flex align-items-center">
        <div class="team-col text-center flex-fill"><div class="team-row">${renderPlayerSpan(t1[0])}<span class="sep">-</span>${renderPlayerSpan(t1[1])}</div></div>
        <div class="vs-col text-center px-2"><strong>VS</strong></div>
        <div class="team-col text-center flex-fill"><div class="team-row">${renderPlayerSpan(t2[0])}<span class="sep">-</span>${renderPlayerSpan(t2[1])}</div></div>
        <div class="enter-col ms-2"><button class="btn btn-sm btn-enter-score" data-court="${i}">Enter score</button></div>
      </div>
    </div>`;
  } else {
    html = `<div class="card">
        <div class="card-header position-relative"><div class="w-100 text-center fs-5 fw-bold">Sân ${10 + i}</div><div style="position:absolute; right:0.5rem; top:50%; transform:translateY(-50%);"><button class="btn btn-sm btn-edit-match" data-edit-court="${i}">Edit</button></div></div>
        <div class="card-body">
          <div class="empty-slot">Empty</div>
        </div>
      </div>`;
  }
  card.innerHTML = html;
  const btn = card.querySelector('button[data-court]'); if(btn) btn.onclick = ()=> openScoreModal(i);
  const editBtn = card.querySelector('button[data-edit-court]'); if(editBtn) editBtn.onclick = ()=> openEditModal(i);
}

function renderQueue(){
  const queueList = document.getElementById('queueList'); queueList.innerHTML='';
  queue_matches.forEach(m=>{
    let [t1,t2]=m;
    let li=document.createElement('li'); li.className='list-group-item';
    li.innerHTML = `${renderPlayerSpan(t1[0])} - ${renderPlayerSpan(t1[1])} &nbsp;&nbsp; vs &nbsp;&nbsp; ${renderPlayerSpan(t2[0])} - ${renderPlayerSpan(t2[1])}`;
    queueList.appendChild(li);
  });
}

function renderIdle(){
  const idleBox = document.getElementById('idlePlayers'); idleBox.innerHTML='';
  // Render as a list-group (like queue) and join names with ' - '
  const ul = document.createElement('ul'); ul.className = 'list-group';
  const li = document.createElement('li'); li.className = 'list-group-item';
  li.innerHTML = idle_players.map(p=>`<span class="player-name ${p.gender==='female'?'female':'male'}">${p.name}</span>`).join(' - ');
  ul.appendChild(li);
  idleBox.appendChild(ul);
}

function renderHistory(){
  const hb = document.getElementById('adminHistoryBox'); if(!hb) return; hb.innerHTML='';
  match_history.slice().reverse().forEach(m=>{
    let d=document.createElement('div');
    if(m.note){
      d.textContent = `${m.note}`;
    } else {
      d.textContent = `${m.team1.join(' - ')} ${m.score?m.score[0]+"-"+m.score[1]:"(no score)"} ${m.team2.join(' - ')}  delta=${m.rating_delta}`;
    }
    hb.appendChild(d);
  });
}

function openScoreModal(courtIdx){
  document.getElementById('modalCourtIdx').value=courtIdx;
  const modal = new bootstrap.Modal(document.getElementById('scoreModal'));
  modal.show();
}

// Admin: open edit modal for a given court
function openEditModal(courtIdx){
  const match = active_matches[courtIdx];
  if(!match){ return alert('No match on this court to edit'); }
  document.getElementById('modalEditCourtIdx').value = courtIdx;
  const selIds = ['editT1P0','editT1P1','editT2P0','editT2P1'];
  const current = match.flat().map(p=> p ? p.name : '');
  // build candidate list: current players + idle players
  const candidates = [];
  // include current players first to allow keeping
  current.forEach(n=>{ if(n) candidates.push(n); });
  // include idle players
  idle_players.forEach(p=>{ if(!candidates.includes(p.name)) candidates.push(p.name); });
  // include players currently in queue so admin can pick from queue when no idle available
  queue_matches.forEach(m=>{ if(!m) return; m.flat().forEach(p=>{ if(p && !candidates.includes(p.name)) candidates.push(p.name); }); });
  // populate selects
  selIds.forEach((id,idx)=>{
    const sel = document.getElementById(id);
    if(!sel) return;
    sel.innerHTML = '';
    candidates.forEach(name=>{
      const o = document.createElement('option'); o.value = name; o.textContent = name; if(name === current[idx]) o.selected = true; sel.appendChild(o);
    });
  });
  const m = new bootstrap.Modal(document.getElementById('editMatchModal'));
  m.show();
}

// Save changes from edit modal: only allow replacements from idle players or keep current
function saveEditMatch(){
  const idx = parseInt(document.getElementById('modalEditCourtIdx').value);
  const selIds = ['editT1P0','editT1P1','editT2P0','editT2P1'];
  const selNames = selIds.map(id=> document.getElementById(id) ? document.getElementById(id).value : '');
  const match = active_matches[idx];
  if(!match){ return alert('No active match on this court'); }
  const currentPlayers = match.flat().map(p=> p ? p.name : '');
  // validation: ensure selected names are unique
  const unique = new Set(selNames);
  if(unique.size !== selNames.length){ return alert('Please ensure each slot has a distinct player'); }
  // ensure replacements are either the same as current or present in idle_players or present in queue_matches
  const queueNames = [];
  queue_matches.forEach(m=>{ if(!m) return; m.flat().forEach(p=>{ if(p) queueNames.push(p.name); }); });
  for(let i=0;i<selNames.length;i++){
    const name = selNames[i];
    if(currentPlayers.includes(name)) continue; // allowed (keeping or swapping within same match)
    if(idle_players.some(p=>p.name === name)) continue;
    if(queueNames.includes(name)) continue;
    return alert('Replacement "'+name+'" is not available. Only Idle or Queue players (or current players) are allowed.');
  }

  // If a selected replacement comes from a queued match, remove that queued match
  // and return its remaining players to Idle with boosted wait (priority)
  const queueIndicesToRemove = new Set();
  for(let qi=0; qi<queue_matches.length; qi++){
    const m = queue_matches[qi]; if(!m) continue;
    const names = m.flat().map(p=> p ? p.name : '');
    for(const selName of selNames){ if(selName && names.includes(selName)){ queueIndicesToRemove.add(qi); } }
  }
  if(queueIndicesToRemove.size > 0){
    // compute current max wait to boost priority
    const maxWait = Math.max(0, ...players.map(p=> p.wait || 0));
    const indices = Array.from(queueIndicesToRemove).sort((a,b)=> b-a); // remove in descending order
    indices.forEach(qi=>{
      const m = queue_matches[qi]; if(!m) return;
      const names = m.flat().map(p=> p ? p.name : '');
      // remaining players are those not chosen as replacements
      const remaining = names.filter(n=> !selNames.includes(n));
      // add remaining players to front of idle preserving the relative order
      for(let r=remaining.length-1; r>=0; r--){
        const pname = remaining[r]; const pobj = players.find(p=> p.name === pname);
        if(!pobj) continue;
        // boost wait to ensure priority when re-building matches
        pobj.wait = (maxWait + 100);
        if(!idle_players.some(x=> x.name === pobj.name)) idle_players.unshift(pobj);
      }
      // remove this queued match
      queue_matches.splice(qi,1);
    });
  }
  // perform replacements: for any name different from current, find player object and swap into this match
  for(let i=0;i<selNames.length;i++){
    const newName = selNames[i]; const oldName = currentPlayers[i];
    if(newName === oldName) continue;
    const newPlayer = players.find(p=> p.name === newName);
    const oldPlayer = players.find(p=> p.name === oldName);
    if(!newPlayer) continue;
    // place newPlayer into match slot
    const teamIdx = (i < 2) ? 0 : 1; const pos = (i % 2 === 0) ? 0 : 1;
    active_matches[idx][teamIdx][pos] = newPlayer;
    // remove newPlayer from idle and add oldPlayer to idle (if exists)
    const nid = idle_players.findIndex(p=> p.name === newName); if(nid !== -1) idle_players.splice(nid,1);
    if(oldPlayer){ if(!idle_players.some(p=>p.name === oldPlayer.name)) idle_players.push(oldPlayer); }
  }
  // After replacements, rebuild the queue so queued matches are re-computed using updated pool
  saveState(); updateIdlePlayers();
  rebuildQueueAfterEdit();
  // clear partnerSlot if the edited match now contains two players who had set the same partner
  processMatchPartners(active_matches[idx]);
  renderCourt(idx); renderQueue(); renderIdle(); renderAdminPlayers();
  const modalEl = document.getElementById('editMatchModal'); const modal = bootstrap.Modal.getInstance(modalEl); if(modal) modal.hide();
}

// Rebuild queue_matches after an admin edit: generate candidate matches and exclude players assigned to active courts
function rebuildQueueAfterEdit(){
  // ensure idle list up-to-date
  updateIdlePlayers();
  const assignedNames = new Set();
  active_matches.forEach(m=>{ if(m) m.flat().forEach(p=>{ if(p) assignedNames.add(p.name); }); });
  // create fresh matches from available pool
  const matchesAll = create_matches();
  // filter out any match that uses players already assigned to active courts
  const queues = matchesAll.filter(m=>{
    if(!m) return false;
    return !m.flat().some(p=> assignedNames.has(p.name));
  });
  queue_matches = queues.slice();
  // ensure queue_matches contains no nulls
  queue_matches = queue_matches.filter(x=>x);
  saveState();
}

function applyResult(courtIdx, scoreStr){
  let match = active_matches[courtIdx];
  if(!match) return;
  let [t1,t2]=match;
  logLine(`applyResult court=${courtIdx+1} t1=${t1[0].name}+${t1[1].name} t2=${t2[0].name}+${t2[1].name} score=${scoreStr||''}`);
  // snapshot pre-state (names only) to help diagnose reshuffle
  try{
    logLine(`pre_apply active=${JSON.stringify(active_matches.map(m=> m? m.flat().map(p=>p.name): null))}`);
    logLine(`pre_apply queue=${JSON.stringify(queue_matches.map(m=> m? m.flat().map(p=>p.name): null))}`);
    logLine(`pre_apply idle=${JSON.stringify(idle_players.map(p=>p.name))}`);
  }catch(e){ console.error('pre-snapshot failed', e); }
  let s1=null,s2=null;
  if(scoreStr){
    // Extract any numeric groups (handles "21-18", "21 18", "21/18")
    const partsNum = (scoreStr.match(/\d+/g) || []).map(x=>parseInt(x,10));
    if(partsNum.length === 2){ s1 = partsNum[0]; s2 = partsNum[1]; }
    else if(partsNum.length === 1){
      // allow compact input like "2118" -> split in the middle if even digits
      const digits = String(partsNum[0]);
      if(digits.length % 2 === 0){
        const half = digits.length/2; s1 = parseInt(digits.slice(0,half),10); s2 = parseInt(digits.slice(half),10);
      }
    }
  }
  let winners, losers, margin=null;
  if(s1==null || s2==null){ let pick = confirm('Mark team1 as winner? OK=team1, Cancel=team2'); if(pick){ winners=t1; losers=t2; } else { winners=t2; losers=t1; } }
  else { if(s1> s2){ winners=t1; losers=t2; } else { winners=t2; losers=t1; } margin = Math.abs(s1-s2); }

  let tr1 = team_rating(t1), tr2 = team_rating(t2);
  if(s1!=null && s2!=null){ t1.forEach(p=>{ p.points_for+=s1; p.points_against+=s2; }); t2.forEach(p=>{ p.points_for+=s2; p.points_against+=s1; }); }
  let delta_base = 10; let delta = delta_base + (margin?margin:0);
  winners.forEach(p=>p.rating += delta); losers.forEach(p=>p.rating -= delta);
  let key = [winners[0].name, winners[1].name].sort().join('|'); partner_history[key] = (partner_history[key]||0)+1;
  match_history.push({ts: new Date().toISOString(), team1:[t1[0].name,t1[1].name], team2:[t2[0].name,t2[1].name], score: s1!=null?[s1,s2]:null, margin: margin, team_rating_before:[tr1,tr2], rating_delta:delta});

  // Keep couple flags intact so players who set partners are not cleared
  // This allows waiting/priority-pairing to work when partners finish at different times.

  // update free players
  let free_players = [...t1, ...t2];
  // Do not overwrite player's `prefer` here — preserve their preference chosen in Admin/Wish.
  free_players.forEach(p=>{ p.matches +=1; p.wait=0; });

  // Handle waiting-for-partner logic: if a freed player has a partner who is still assigned, hold them in waiting list
  const isAssignedByName = (name)=>{
    for(const m of active_matches){ if(m){ if(m.flat().some(x=>x && x.name===name)) return true; } }
    for(const m of queue_matches){ if(m){ if(m.flat().some(x=>x && x.name===name)) return true; } }
    return false;
  };

  // helper to try to form a queued match for a couple when both free
  function tryQueueMatchForCouple(a,b){
    // a and b are player objects
    // need at least two other idle players
    const pool = idle_players.filter(p=> p.ready && p.name !== a.name && p.name !== b.name);
    if(pool.length < 2) return false;
    const femaleCount = pool.filter(p=>p.gender === 'female').length + ([a,b].filter(x=>x.gender==='female').length);
    const allowCrossType = (femaleCount % 2 === 1);
    for(let attempt=0; attempt<200; attempt++){
      let copy = pool.slice();
      let j1 = Math.floor(Math.random()*copy.length); const o1 = copy.splice(j1,1)[0];
      let j2 = Math.floor(Math.random()*copy.length); const o2 = copy.splice(j2,1)[0];
      const team1 = [a,b]; const team2 = [o1,o2];
      if(team_type(team1) !== team_type(team2) && !allowCrossType) continue;
      const m = best_match([team1[0],team1[1],team2[0],team2[1]], allowCrossType);
      if(m){
        queue_matches.push(m);
        // remove chosen opponents from idle_players
        m[0].forEach(p=>{ let idx=idle_players.indexOf(p); if(idx!==-1) idle_players.splice(idx,1); });
        m[1].forEach(p=>{ let idx=idle_players.indexOf(p); if(idx!==-1) idle_players.splice(idx,1); });
        logLine(`queued couple-priority match ${m[0][0].name}+${m[0][1].name} vs ${m[1][0].name}+${m[1][1].name}`);
        return true;
      }
    }
    return false;
  }

  // process each freed player
  free_players.forEach(p=>{
    const partner = players.find(x=> x.couple && x.couple === p.couple && x.name !== p.name);
    if(partner){
      // if partner still assigned, hold p in waiting list
      if(isAssignedByName(partner.name)){
        p.wait_for_partner = true;
        if(!waiting_for_partner.includes(p.name)) waiting_for_partner.push(p.name);
      } else {
        // partner not assigned; check if partner is already waiting for p
        if(waiting_for_partner.includes(partner.name)){
          // both free now, try to queue match prioritizing this couple
          // remove partner from waiting list
          waiting_for_partner = waiting_for_partner.filter(n=> n!==partner.name);
          partner.wait_for_partner = false; p.wait_for_partner = false;
          const queued = tryQueueMatchForCouple(partner, p);
          if(!queued){
            // fallback: add both back to idle if cannot queue now
            if(!idle_players.some(x=>x.name===p.name)) idle_players.push(p);
            if(!idle_players.some(x=>x.name===partner.name)) idle_players.push(partner);
          }
        } else {
          // no special waiting, add to idle
          if(!idle_players.some(x=>x.name===p.name)) idle_players.push(p);
          p.wait_for_partner = false;
        }
      }
    } else {
      // not a couple case
      if(!idle_players.some(x=>x.name===p.name)) idle_players.push(p);
    }
  });

  // replace only the finished court with next in queue if any, keep other courts unchanged
  if(queue_matches.length>0){
    active_matches[courtIdx] = queue_matches.shift();
    processMatchPartners(active_matches[courtIdx]);
  } else {
    active_matches[courtIdx] = null;
  }
  logLine(`after shift active=${JSON.stringify(active_matches.map(m=> m? m.flat().map(p=>p.name): null))}`);

  let newMatch = create_new_match(free_players);
  if(newMatch){
    // defensive: ensure newMatch players are not already assigned to other active courts
    const assigned = new Set();
    active_matches.forEach((m,idx)=>{ if(m && idx!==courtIdx) m.flat().forEach(p=>assigned.add(p.name)); });
    const conflict = newMatch[0].concat(newMatch[1]).some(p=>assigned.has(p.name));
    if(!conflict){
      // if the court that just freed is still empty, assign the new match there immediately
      if(!active_matches[courtIdx]){
        active_matches[courtIdx] = newMatch;
        processMatchPartners(active_matches[courtIdx]);
        logLine(`assigned new match to freed court ${courtIdx+1} ${newMatch[0][0].name}+${newMatch[0][1].name} vs ${newMatch[1][0].name}+${newMatch[1][1].name}`);
      } else {
        queue_matches.push(newMatch);
        logLine(`queued new match ${newMatch[0][0].name}+${newMatch[0][1].name} vs ${newMatch[1][0].name}+${newMatch[1][1].name}`);
      }
    } else {
      logLine('skipped new match due to conflict with active courts');
    }
  }
  idle_players.forEach(p=>p.wait++);
  saveState();
  try{ localStorage.setItem('badminton_log', JSON.stringify(debug_log)); }catch(e){ console.error('failed to flush log after saveState', e); }
  // snapshot post-state for comparison
  try{
    logLine(`post_apply active=${JSON.stringify(active_matches.map(m=> m? m.flat().map(p=>p.name): null))}`);
    logLine(`post_apply queue=${JSON.stringify(queue_matches.map(m=> m? m.flat().map(p=>p.name): null))}`);
    logLine(`post_apply idle=${JSON.stringify(idle_players.map(p=>p.name))}`);
    localStorage.setItem('badminton_log', JSON.stringify(debug_log));
  }catch(e){ console.error('post-snapshot failed', e); }
  // only update the affected parts to avoid reshuffling other courts
  renderCourt(courtIdx);
  renderQueue();
  renderIdle();
  renderHistory();
}

function create_new_match(free_players){
  // Exclude any players currently assigned to active matches or queue
  const assignedNames = new Set();
  active_matches.forEach(m=>{ if(m){ m.flat().forEach(p=>assignedNames.add(p.name)); }});
  queue_matches.forEach(m=>{ if(m){ m.flat().forEach(p=>assignedNames.add(p.name)); }});

  const available_idle = idle_players.filter(p=> p.ready && !assignedNames.has(p.name));
  const available_free = (free_players||[]).filter(p=> p.ready && !assignedNames.has(p.name));
  // Build combined available list and exclude any player whose chosen partner (couple) is not currently available.
  let allAvailable = available_idle.concat(available_free);
  // deduplicate combined list by player name to avoid same player appearing twice
  const byName = {};
  allAvailable.forEach(p=>{ if(p && p.name) byName[p.name] = p; });
  allAvailable = Object.values(byName);
  const availNames = new Set(allAvailable.map(p=>p.name));
  let pool = allAvailable.filter(p=>{
    if(p.wait_for_partner) return false;
    if(!p.couple) return true;
    const partner = players.find(x=> x.couple === p.couple && x.name !== p.name);
    if(!partner) return true; // partner not found -> allow
    if(partner.wait_for_partner) return false;
    return availNames.has(partner.name); // only include if partner is also available
  });
  // For any free_players that were excluded because their partner wasn't available, ensure they stay idle (wait)
  (available_free||[]).forEach(p=>{ if(!pool.some(x=>x.name===p.name) && !idle_players.some(x=>x.name===p.name)) idle_players.push(p); });
  const femaleCount = pool.filter(p=>p.gender === 'female').length;
  const allowCrossType = (femaleCount % 2 === 1);
    if(pool.length <4){
    // only add ready free players back to idle (avoid duplicates by name)
    (free_players||[]).filter(p=>p.ready).forEach(p=>{ if(!idle_players.some(x=>x.name===p.name)) idle_players.push(p); });
    return null;
  }
  // Try to prioritize forming a match that keeps a set couple together if both partners are available
  // Find couple ids present twice in pool
  const coupleCounts = {};
  pool.forEach(p=>{ if(p.couple) coupleCounts[p.couple] = (coupleCounts[p.couple]||0) + 1; });
  for(const cid in coupleCounts){
    if(coupleCounts[cid] >= 2){
      // attempt to form a match using this couple as one team
      const partners = pool.filter(p=> p.couple === parseInt(cid));
      if(partners.length < 2) continue;
      const team1 = [partners[0], partners[1]];
      // try up to 200 attempts to pick two other players to form opposing team
      for(let attempt=0; attempt<200; attempt++){
        const others = pool.filter(p=> p!==team1[0] && p!==team1[1]);
        if(others.length < 2) break;
        let copy = others.slice();
        let j1 = Math.floor(Math.random()*copy.length); const o1 = copy.splice(j1,1)[0];
        let j2 = Math.floor(Math.random()*copy.length); const o2 = copy.splice(j2,1)[0];
        const team2 = [o1,o2];
        // check team type compatibility
        if(team_type(team1) !== team_type(team2) && !allowCrossType) continue;
        const m = best_match([team1[0],team1[1],team2[0],team2[1]], allowCrossType);
        if(m){
          // remove used players from idle_players
          m[0].forEach(p=>{ let idx=idle_players.findIndex(x=>x.name===p.name); if(idx!=-1) idle_players.splice(idx,1); });
          m[1].forEach(p=>{ let idx=idle_players.findIndex(x=>x.name===p.name); if(idx!=-1) idle_players.splice(idx,1); });
          return m;
        }
      }
    }
  }

  let best=null, best_score=1e9;
  for(let k=0;k<200;k++){
    let group = [];
    let copy = pool.slice();
    for(let i=0;i<4;i++){ let j=Math.floor(Math.random()*copy.length); group.push(copy.splice(j,1)[0]); }
    let m = best_match(group, allowCrossType);
    if(!m) continue;
    let t1=m[0], t2=m[1];
    let score = Math.abs(team_rating(t1)-team_rating(t2));
    if(score<best_score){ best_score=score; best=[t1,t2]; }
  }
  if(!best) return null;
  best[0].forEach(p=>{ let idx=idle_players.findIndex(x=>x.name===p.name); if(idx!=-1) idle_players.splice(idx,1); });
  best[1].forEach(p=>{ let idx=idle_players.findIndex(x=>x.name===p.name); if(idx!=-1) idle_players.splice(idx,1); });
  return best;
}

// When two players who set the same `partnerSlot` are placed into the same team,
// clear their partnerSlot back to null (default = No Partner)
function processMatchPartners(match){
  if(!match) return;
  const teams = [match[0], match[1]];
  let changed = false;
  teams.forEach(team=>{
    if(team && team[0] && team[1]){
      const a = team[0], b = team[1];
      if(a.partnerSlot && b.partnerSlot && a.partnerSlot === b.partnerSlot){
        a.partnerSlot = null; b.partnerSlot = null; changed = true;
      }
    }
  });
  if(changed){ saveState(); renderAdminPlayers(); }
}

function updateIdlePlayers(){
  const assigned = new Set();
  active_matches.forEach(m=>{ if(m) m.flat().forEach(p=>assigned.add(p.name)); });
  queue_matches.forEach(m=>{ if(m) m.flat().forEach(p=>assigned.add(p.name)); });
  idle_players = players.filter(p=> p.ready && !assigned.has(p.name) && !p.wait_for_partner);
}

// persistence
function saveState(){ localStorage.setItem('badminton_players', JSON.stringify(players)); localStorage.setItem('badminton_history', JSON.stringify(match_history)); }
function loadState(){
  let p = localStorage.getItem('badminton_players');
  if(p){
    try{
      const parsed = JSON.parse(p);
      players = parsed.map(p0=>({
        name: p0.name,
        level: p0.level || 4,
        prefer: p0.prefer || 'normal',
        gender: p0.gender || 'male',
        rating: (p0.rating !== undefined) ? p0.rating : ((p0.level||4)*100),
        matches: p0.matches || 0,
        wait: p0.wait || 0,
        points_for: p0.points_for || 0,
        points_against: p0.points_against || 0,
        ready: (p0.ready === undefined) ? true : p0.ready,
        couple: (p0.couple === undefined) ? null : p0.couple,
        uncouple: (p0.uncouple === undefined) ? null : p0.uncouple,
        partnerSlot: (p0.partnerSlot === undefined) ? null : p0.partnerSlot
      }));
    }catch(e){ console.error('failed to parse badminton_players', e); }
  }
  let h=localStorage.getItem('badminton_history'); if(h){ try{ match_history = JSON.parse(h); }catch(e){ console.error('failed to parse badminton_history', e); } }
}

// debug logging helpers
function logLine(msg){
  const ts = new Date().toISOString();
  debug_log.push(`[${ts}] ${msg}`);
  if(debug_log.length > 500) debug_log = debug_log.slice(-500);
  try{
    localStorage.setItem('badminton_log', JSON.stringify(debug_log));
  }catch(e){
    console.error('failed to save log to localStorage', e);
  }
  // expose for quick debugging in console
  try{ window._badminton_last_log = debug_log.slice(-50); }catch(e){}
  const preview = document.getElementById('logPreview');
  if(preview){ preview.textContent = debug_log.slice(-50).join('\n'); }
}

function loadLog(){
  const l = localStorage.getItem('badminton_log');
  if(l){ debug_log = JSON.parse(l); }
  const preview = document.getElementById('logPreview');
  if(preview){ preview.textContent = debug_log.slice(-50).join('\n'); }
  if(debug_log.length === 0){
    logLine('log started');
  }
}

function downloadLog(){
  // re-load persisted log to avoid stale in-memory state
  try{
    const stored = localStorage.getItem('badminton_log');
    if(stored) debug_log = JSON.parse(stored);
  }catch(e){ console.error('failed to read log from localStorage', e); }
  if(debug_log.length === 0){
    logLine('downloadLog: log empty, snapshotting state');
    logLine(`snapshot active=${JSON.stringify(active_matches.map(m=> m? m.flat().map(p=>p.name): null))}`);
    logLine(`snapshot queue=${JSON.stringify(queue_matches.map(m=> m? m.flat().map(p=>p.name): null))}`);
    logLine(`snapshot idle=${JSON.stringify(idle_players.map(p=>p.name))}`);
  }
  const blob = new Blob([debug_log.join('\n')], {type:'text/plain'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'badminton_log.txt'; a.click(); URL.revokeObjectURL(url);
}

function clearLog(){
  debug_log = [];
  localStorage.removeItem('badminton_log');
  const preview = document.getElementById('logPreview');
  if(preview){ preview.textContent = ''; }
}

// Export full state as JSON
function exportJSON(){
  const state = {
    players: players,
    match_history: match_history,
    active_matches: active_matches.map(m => m ? [[m[0][0].name,m[0][1].name],[m[1][0].name,m[1][1].name]] : null),
    queue_matches: queue_matches.map(m => m ? [[m[0][0].name,m[0][1].name],[m[1][0].name,m[1][1].name]] : null),
    idle_players: idle_players.map(p=>p.name)
  };
  const blob = new Blob([JSON.stringify(state, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'badminton_player_list.json'; a.click(); URL.revokeObjectURL(url);
}

// Import state from JSON file content
function importJSON(text){
  try{
    const state = JSON.parse(text);
    if(state.players){
      players = state.players.map(p=>({
          name: p.name,
          level: p.level || 4,
          prefer: p.prefer || 'normal',
          gender: p.gender || 'male',
          rating: (p.rating !== undefined) ? p.rating : ((p.level||4)*100),
          matches: p.matches || 0,
          wait: p.wait || 0,
          points_for: p.points_for || 0,
          points_against: p.points_against || 0,
          ready: (p.ready === undefined) ? true : p.ready,
          couple: (p.couple === undefined) ? null : p.couple,
          uncouple: (p.uncouple === undefined) ? null : p.uncouple,
          partnerSlot: (p.partnerSlot === undefined) ? null : p.partnerSlot
        }));
    }

    // helper to find player object by name
    const byName = name => players.find(p=>p.name === name);

    if(state.active_matches){
      active_matches = state.active_matches.map(m => {
        if(!m) return null;
        const t1 = [byName(m[0][0]), byName(m[0][1])];
        const t2 = [byName(m[1][0]), byName(m[1][1])];
        return [t1,t2];
      });
      while(active_matches.length < COURTS) active_matches.push(null);
      // clear partner slots for any matches where partners are now paired
      active_matches.forEach(m=> processMatchPartners(m));
    }

    if(state.queue_matches){
      queue_matches = state.queue_matches.map(m => {
        if(!m) return null;
        const t1 = [byName(m[0][0]), byName(m[0][1])];
        const t2 = [byName(m[1][0]), byName(m[1][1])];
        return [t1,t2];
      }).filter(x=>x);
    }

    if(state.idle_players){
      idle_players = state.idle_players.map(n=>byName(n)).filter(x=>x);
    } else {
      idle_players = players.filter(p => !active_matches.flat().includes(p) && !queue_matches.flat().includes(p));
    }

    if(state.match_history) match_history = state.match_history;

    saveState();
    updateIdlePlayers();
    render();
    renderAdminPlayers();
    loadLog();
    alert('Import successful');
  }catch(e){ alert('Import failed: '+e.message); }
}

// export CSV
function exportCSV(){
  let rows = [['team1','team2','score','margin','rating_delta','tr_before1','tr_before2']];
  match_history.forEach(m=> rows.push([m.team1.join('+'), m.team2.join('+'), m.score?m.score[0]+'-'+m.score[1]:'', m.margin||'', m.rating_delta||'', m.team_rating_before?m.team_rating_before[0]:'', m.team_rating_before?m.team_rating_before[1]:'']));
  let csv = rows.map(r=>r.map(c=>`"${(''+c).replace(/"/g,'""')}"`).join(',')).join('\n');
  let blob = new Blob([csv], {type:'text/csv'});
  let url = URL.createObjectURL(blob);
  let a = document.createElement('a'); a.href=url; a.download='match_history.csv'; a.click(); URL.revokeObjectURL(url);
}

function downloadHistory(){
  // reload from storage to avoid stale in-memory state
  try{
    const stored = localStorage.getItem('badminton_history'); if(stored) match_history = JSON.parse(stored);
  }catch(e){ console.error('failed to read badminton_history from localStorage', e); }
  if(!match_history || match_history.length === 0){
    // create a quick snapshot entry
    const snap = {ts:new Date().toISOString(), note:'snapshot', active: active_matches.map(m=> m? m.flat().map(p=>p.name): null), queue: queue_matches.map(m=> m? m.flat().map(p=>p.name): null), idle: idle_players.map(p=>p.name)};
    match_history.push(snap);
    saveState();
  }
  const lines = match_history.map(m=>{
    if(m.note) return `[${m.ts}] ${m.note} active=${JSON.stringify(m.active)} queue=${JSON.stringify(m.queue)} idle=${JSON.stringify(m.idle)}`;
    return `[${m.ts}] ${m.team1.join('+')} ${m.score? (m.score[0]+'-'+m.score[1]) : '(no score)'} ${m.team2.join('+')}  delta=${m.rating_delta}`;
  });
  const blob = new Blob([lines.join('\n')], {type:'text/plain'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'match_history.txt'; a.click(); URL.revokeObjectURL(url);
}

function clearHistory(){
  if(!confirm('Clear match history? This cannot be undone.')) return;
  match_history = [];
  try{ localStorage.removeItem('badminton_history'); }catch(e){}
  saveState(); renderHistory();
}

// reset
function resetAll(){ if(confirm('Reset local data?')){ localStorage.clear(); location.reload(); } }

// init: load state and show players in Idle. Matches will be built when user clicks "Build Matches"
loadState(); loadLog();
// start with no active or queued matches so UI shows players in Idle
active_matches = []; queue_matches = [];
while(active_matches.length < COURTS) active_matches.push(null);
updateIdlePlayers(); render(); renderAdminPlayers();

// UI bindings
document.getElementById('submitScore').onclick = ()=>{
  let s = document.getElementById('scoreInput').value.trim(); let idx = parseInt(document.getElementById('modalCourtIdx').value);
  logLine(`submitScore court=${idx+1} score=${s||''}`);
  let modalEl = document.getElementById('scoreModal'); let modal = bootstrap.Modal.getInstance(modalEl);
  applyResult(idx, s); modal.hide(); document.getElementById('scoreInput').value='';
};

// Auto-format score input: insert '-' after two digits while typing
const scoreInputEl = document.getElementById('scoreInput');
if(scoreInputEl){
  scoreInputEl.setAttribute('inputmode','numeric');
  scoreInputEl.addEventListener('input', function(e){
    const cur = this.value || '';
    // keep only digits
    let digits = (cur.match(/\d+/g) || []).join('');
    if(digits.length > 4) digits = digits.slice(0,4);
    if(digits.length <= 2){
      this.value = digits;
    } else {
      this.value = digits.slice(0,2) + '-' + digits.slice(2);
    }
    // move caret to end for simplicity
    try{ this.selectionStart = this.selectionEnd = this.value.length; }catch(e){}
  });
}

document.getElementById('exportCsv').onclick = exportCSV; document.getElementById('resetData').onclick = resetAll;
document.getElementById('exportJson').onclick = exportJSON;
// admin import/export wiring (if elements exist)
if(document.getElementById('importJson')){
  document.getElementById('importJson').onclick = ()=> document.getElementById('importJsonFile').click();
}
if(document.getElementById('importJsonFile')){
  document.getElementById('importJsonFile').onchange = (e)=>{
    const f = e.target.files[0]; if(!f) return; const reader = new FileReader(); reader.onload = ()=> importJSON(reader.result); reader.readAsText(f);
  };
}

if(document.getElementById('rebuildMatches')){
  const btn = document.getElementById('rebuildMatches');
  // change label to Build Matches and wire to initialize (build) when clicked
  try{ btn.textContent = 'Build Matches'; }catch(e){}
  btn.onclick = ()=>{ initialize(); saveState(); render(); try{ const displayEl = document.getElementById('display-tab'); if(displayEl){ const t = new bootstrap.Tab(displayEl); t.show(); } }catch(e){ console.error('failed to switch tab', e); } };
}

// Wish controls wiring
if(document.getElementById('wishChill')) document.getElementById('wishChill').onclick = ()=>{ wishTempPrefer = (wishTempPrefer === 'chill') ? null : 'chill'; updateWishBtnVisual(); };
if(document.getElementById('wishNormal')) document.getElementById('wishNormal').onclick = ()=>{ wishTempPrefer = (wishTempPrefer === 'normal') ? null : 'normal'; updateWishBtnVisual(); };
if(document.getElementById('wishChallenge')) document.getElementById('wishChallenge').onclick = ()=>{ wishTempPrefer = (wishTempPrefer === 'challenge') ? null : 'challenge'; updateWishBtnVisual(); };
if(document.getElementById('wishSetPrefer')) document.getElementById('wishSetPrefer').onclick = ()=>{
  const v = document.getElementById('wishPlayerSelect').value; if(!v) return alert('Vui lòng chọn tên của bạn'); if(!wishTempPrefer) return alert('Vui lòng chọn chế độ Chill/Normal/Challenge trước khi Set');
  const idx = parseInt(v); setPlayerPrefer(idx, wishTempPrefer);
  wishTempPrefer = null; updateWishBtnVisual();
};
if(document.getElementById('wishSetPartner')) document.getElementById('wishSetPartner').onclick = ()=>{
  const v1 = document.getElementById('wishPlayerSelect').value; const v2 = document.getElementById('wishPartnerSelect').value;
  if(!v1) return alert('Vui lòng chọn tên của bạn'); if(!v2) return alert('Vui lòng chọn tên Partner');
  const idx = parseInt(v1); const pidx = parseInt(v2);
  // Set partner into the Partner button (partnerSlot) instead of assigning couple
  setPartnerSlotBetween(idx, pidx);
};

// player admin handlers
function renderAdminPlayers(){
  const box = document.getElementById('adminPlayerList'); if(!box) return; box.innerHTML='';
  players.forEach((p,idx)=>{
    const row = document.createElement('div'); row.className='d-flex justify-content-between align-items-center mb-0';
    const readyBtnClass = p.ready ? 'btn-ready' : 'btn-notready';
    const readySymbol = p.ready ? 'V' : 'X';
    const coupleLabel = p.couple ? ('C'+p.couple) : 'Single';
    const pref = p.prefer || 'normal';
    const prefClass = pref==='chill' ? 'prefer-chill' : (pref==='normal' ? 'prefer-normal' : 'prefer-challenge');
    const prefLabel = pref.charAt(0).toUpperCase() + pref.slice(1);
    // show name left, controls right for aligned columns
    const genderLabel = p.gender ? (p.gender.charAt(0).toUpperCase() + p.gender.slice(1)) : 'Male';
    const typeBtn = (coupleLabel === 'Single') ? `<button class="btn btn-sm uniform-btn btn-single ms-2" data-idx="${idx}" data-action="toggleType">${coupleLabel}</button>` : `<button class="btn btn-sm btn-info ms-2 text-white" data-idx="${idx}" data-action="toggleType">${coupleLabel}</button>`;
    const uncoupleLabel = p.uncouple ? ('No'+p.uncouple) : 'Normal';
    const uncoupleBtn = `<button class="btn btn-sm btn-uncouple ms-2" data-idx="${idx}" data-action="toggleUnpair">${uncoupleLabel}</button>`;
    const partnerLabel = p.partnerSlot || 'No Partner';
    const partnerBtn = `<button class="btn btn-sm partner-btn btn-single ms-2" data-idx="${idx}" data-action="partnerToggle">${partnerLabel}</button>`;
    row.innerHTML = `<div class="admin-row"><div class="admin-left"><strong>${p.name}</strong></div><div class="admin-edit"><button class="btn btn-sm btn-outline-secondary" data-idx="${idx}" data-action="edit">Edit</button></div><div class="admin-right"><button class="btn btn-sm gender-btn ${p.gender==='female' ? 'btn-female' : 'btn-male'}" data-idx="${idx}" data-action="toggleGender">${genderLabel}</button><button class="btn btn-sm btn-level" data-idx="${idx}" data-action="toggleLevel">L${p.level}</button><button class="btn btn-sm ${readyBtnClass}" data-idx="${idx}" data-action="toggleReady">${readySymbol}</button><button class="btn btn-sm ${prefClass} ms-1 prefer-btn" data-idx="${idx}" data-action="togglePrefer">${prefLabel}</button>${partnerBtn}${typeBtn}${uncoupleBtn}<button class="btn btn-sm uniform-btn btn-delete ms-2" data-idx="${idx}" data-action="delete">Del</button></div></div>`;
    box.appendChild(row);
  });

  // bind partner button click handlers (single click cycles option)
  box.querySelectorAll('button[data-action="partnerToggle"]').forEach(btn=>{
    btn.onclick = ()=>{
      const idx = parseInt(btn.getAttribute('data-idx'));
      const order = ['', 'P1','P2','P3','P4','P5'];
      const cur = players[idx].partnerSlot || '';
      let i = order.indexOf(cur);
      if(i < 0) i = 0;
      const next = order[(i+1) % order.length];
      players[idx].partnerSlot = next || null;
      saveState();
      updateIdlePlayers(); render(); renderAdminPlayers();
    };
  });

  box.querySelectorAll('button[data-action]').forEach(btn=>{
    btn.onclick = ()=>{
      const idx = parseInt(btn.getAttribute('data-idx'));
      const action = btn.getAttribute('data-action');
      if(action === 'partnerToggle'){
        const order = ['', 'P1','P2','P3','P4','P5'];
        const cur = players[idx].partnerSlot || '';
        let i = order.indexOf(cur); if(i<0) i=0;
        const next = order[(i+1) % order.length];
        players[idx].partnerSlot = next || null;
        saveState(); updateIdlePlayers(); render(); renderAdminPlayers();
        return;
      }
      if(action==='toggleReady'){
        players[idx].ready = !players[idx].ready;
        updateIdlePlayers(); saveState(); render(); renderAdminPlayers(); return;
      }
      if(action==='toggleType'){
        const cur = players[idx].couple;
        if(cur === null || cur === undefined){ players[idx].couple = 1; }
        else if(cur < MAX_COUPLE){ players[idx].couple = cur + 1; }
        else { players[idx].couple = null; }
        saveState(); updateIdlePlayers(); render(); renderAdminPlayers(); return;
      }
      if(action==='toggleUnpair'){
        // preserve current prefer value — toggling Un-couple must not change player's preference
        const prevPrefer = players[idx].prefer;
        const cur = players[idx].uncouple;
        if(cur === null || cur === undefined){ players[idx].uncouple = 1; }
        else if(cur < MAX_COUPLE){ players[idx].uncouple = cur + 1; }
        else { players[idx].uncouple = null; }
        players[idx].prefer = prevPrefer;
        saveState(); updateIdlePlayers(); render(); renderAdminPlayers(); return;
      }
      if(action==='toggleGender'){
        players[idx].gender = (players[idx].gender === 'male') ? 'female' : 'male';
        saveState(); render(); renderAdminPlayers(); return;
      }
      if(action==='toggleLevel'){
        let cur = players[idx].level || 4; cur = (cur % 10) + 1; players[idx].level = cur;
        // keep rating roughly synced if rating was default
        if(!players[idx].rating || players[idx].rating === ( (cur-1)*100 )) players[idx].rating = players[idx].level * 100;
        saveState(); render(); renderAdminPlayers(); return;
      }
      if(action==='setPrefer'){
        const pref = btn.getAttribute('data-prefer'); players[idx].prefer = pref; if(pref!=='chill') players[idx].ready = true; saveState(); updateIdlePlayers(); render(); renderAdminPlayers(); return;
      }
      if(action==='togglePrefer'){
        const cur = players[idx].prefer || 'normal';
        const order = ['chill','normal','challenge'];
        let i = order.indexOf(cur);
        i = (i+1) % order.length;
        players[idx].prefer = order[i];
        if(players[idx].prefer !== 'chill') players[idx].ready = true;
        saveState(); updateIdlePlayers(); render(); renderAdminPlayers(); return;
      }
      if(action==='delete'){
        if(confirm('Delete player '+players[idx].name+'?')){ players.splice(idx,1); saveState(); render(); renderAdminPlayers(); }
      }
      if(action==='edit'){
        const newName = prompt('Edit name for '+players[idx].name, players[idx].name);
        if(newName && newName.trim()){
          players[idx].name = newName.trim();
          saveState(); updateIdlePlayers(); render(); renderAdminPlayers();
        }
        return;
      }
    };
  });
}

if(document.getElementById('savePlayer')){
  document.getElementById('savePlayer').onclick = ()=>{
    const name = document.getElementById('pName').value.trim(); if(!name) return alert('Name required');
    const level = parseInt(document.getElementById('pLevel').value) || 4;
    const gender = document.getElementById('pGender').value || 'male';
    const prefer = document.getElementById('pPrefer').value;
    // Always add new player (Add-only form)
    players.push({name,level,prefer,gender,rating:level*100,matches:0,wait:0,points_for:0,points_against:0, ready:true, couple:null});
    document.getElementById('pName').value=''; document.getElementById('pLevel').value=''; document.getElementById('pPrefer').value='normal'; document.getElementById('pGender').value='male';
    saveState();
    updateIdlePlayers(); render(); renderAdminPlayers();
  };
}

// support Add Player button located at top of Players panel
if(document.getElementById('savePlayerTop')){
  document.getElementById('savePlayerTop').onclick = ()=>{
    const name = document.getElementById('pName').value.trim(); if(!name) return alert('Name required');
    const level = parseInt(document.getElementById('pLevel').value) || 4;
    const gender = document.getElementById('pGender').value || 'male';
    const prefer = document.getElementById('pPrefer').value;
    players.push({name,level,prefer,gender,rating:level*100,matches:0,wait:0,points_for:0,points_against:0, ready:true, couple:null});
    document.getElementById('pName').value=''; document.getElementById('pLevel').value=''; document.getElementById('pPrefer').value='normal'; document.getElementById('pGender').value='male';
    saveState();
    updateIdlePlayers(); render(); renderAdminPlayers();
  };
}


// remove obsolete cancel/edit bindings (Add-only form)

// initial admin render
renderAdminPlayers();
if(document.getElementById('saveEditMatch')) document.getElementById('saveEditMatch').onclick = saveEditMatch;

// log controls
if(document.getElementById('downloadLog')) document.getElementById('downloadLog').onclick = downloadLog;
if(document.getElementById('clearLog')) document.getElementById('clearLog').onclick = clearLog;
if(document.getElementById('downloadHistory')) document.getElementById('downloadHistory').onclick = downloadHistory;
if(document.getElementById('clearHistory')) document.getElementById('clearHistory').onclick = clearHistory;
