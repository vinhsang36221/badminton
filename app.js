// Badminton Matchmaking - Rule-based Algorithm (5 Rules)
// Rules:
// 1. Match type: MM-MM, MF-MF, or FF-FF only
// 2. No repeat teammate from each player's 2 most recent played matches
// 3. No repeat opponent from each player's 2 most recent played matches
// 4. Idle Index priority: prioritize players waiting longer in Idle
// 5. Equal Level Team: after selecting 4 players, swap pairings inside that group to make team levels as close as possible

const COURT_NUMBERS = [9, 10, 11, 12];
let COURTS = COURT_NUMBERS.length;
let players = [];
const RECENT_APPEARANCE_LIMIT = 2;
const RECENT_RULE_POLICIES = {
  strict2: { teammateDepth: 2, opponentDepth: 2 },
  strict1: { teammateDepth: 1, opponentDepth: 1 },
  skipRule3: { teammateDepth: 1, opponentDepth: 0 },
  skipRule2And3: { teammateDepth: 0, opponentDepth: 0 }
};

// Load players from external JSON file. Falls back to embedded defaults or localStorage.
function loadPlayersFromFile(callback) {
  const tryUrls = ['players.json', './players.json'];
  if (window && window.location && window.location.protocol && window.location.protocol.startsWith('http')) {
    tryUrls.push(window.location.origin + '/players.json');
  }

  function attemptFetch(urls, idx) {
    if (idx >= urls.length) return Promise.reject(new Error('all attempts failed'));
    const url = urls[idx];
    return fetch(url, {cache: 'no-store'})
      .then(resp => {
        if (!resp.ok) throw new Error(url + ' not found (status ' + resp.status + ')');
        return resp.json();
      })
      .catch(err => {
        return attemptFetch(urls, idx + 1);
      });
  }

  attemptFetch(tryUrls, 0)
    .then(data => {
      players = data.map(normalizePlayerRecord);
      finalizePlayerRecords(players);
      try { localStorage.setItem('badminton_players', JSON.stringify(players)); } catch (e) {}
      callback && callback();
    })
    .catch(err => {
      // If fetch entirely fails, inform user and rely on localStorage if present.
      console.warn('Failed to load players.json from tried paths; relying on localStorage if present', err);
      // Show brief visible warning so user knows why players may be missing
      try {
        const existing = document.getElementById('playersFetchWarning');
        if (!existing) {
          const div = document.createElement('div');
          div.id = 'playersFetchWarning';
          div.style.cssText = 'background:#ffdcdc;color:#700;padding:8px;margin:8px;border-radius:4px;font-weight:600;';
          div.textContent = 'Warning: could not load players.json — running from file:// or server blocked. Using localStorage if available.';
          const root = document.body || document.documentElement;
          if (root) root.insertBefore(div, root.firstChild);
        }
      } catch (e) {}
      callback && callback();
    });
}

// Initialize player properties
players.forEach(p => {
  p.rating = p.level * 100;
  p.matches = 0;
  p.ready = (p.ready === undefined) ? true : p.ready;
  p.idleIndex = Number.isFinite(Number(p.idleIndex)) ? Math.max(0, Math.floor(Number(p.idleIndex))) : 0;
});

let match_history = [];
let active_matches = [];
let queue_matches = [];
let idle_players = [];
let debug_log = [];
let wishPreferSelection = null;
let autoSyncLevelsFromRating = true;
let courtEnabledStates = Array(COURTS).fill(true);
const MAX_COUPLE = 5;
const MATCH_SELECTION_POOL_SIZE = 8;
const MAX_CANDIDATE_GROUPS = 18;
const MAX_SEED_ATTEMPTS = 2;
const CHALLENGE_RESERVE_WINDOW = 4;

function createPlayerId() {
  return `player_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function ensurePlayerId(player) {
  if (!player) return null;
  if (!player.id) player.id = createPlayerId();
  return player.id;
}

function getPlayerRef(value) {
  if (!value) return null;
  if (typeof value === 'object') return ensurePlayerId(value);
  return value;
}

function getCourtLabel(index) {
  return `Sân ${COURT_NUMBERS[index] ?? (index + 1)}`;
}

function ensureCourtEnabledStates() {
  if (!Array.isArray(courtEnabledStates)) courtEnabledStates = [];
  courtEnabledStates = COURT_NUMBERS.map((_, index) => courtEnabledStates[index] !== false);
}

function isCourtEnabled(index) {
  ensureCourtEnabledStates();
  return courtEnabledStates[index] !== false;
}

function getFirstAvailableEnabledCourtIndex() {
  ensureCourtEnabledStates();
  return (active_matches || []).findIndex((match, index) => isCourtEnabled(index) && !match);
}

function relocateDisabledCourtMatches(logPrefix = 'courtToggle') {
  ensureCourtEnabledStates();
  const displacedMatches = [];

  for (let index = 0; index < COURTS; index++) {
    if (isCourtEnabled(index) || !active_matches[index]) continue;
    displacedMatches.push({ index, match: active_matches[index] });
    active_matches[index] = null;
  }

  if (!displacedMatches.length) return;

  const queuedFirst = [];
  displacedMatches.forEach(({ index, match }) => {
    const emptyCourtIdx = getFirstAvailableEnabledCourtIndex();
    if (emptyCourtIdx !== -1) {
      active_matches[emptyCourtIdx] = match;
      logLine(`${logPrefix}:moveMatch from=${getCourtLabel(index)} to=${getCourtLabel(emptyCourtIdx)} match=${formatMatch(match)}`);
      return;
    }
    queuedFirst.push(match);
    logLine(`${logPrefix}:queueMatch from=${getCourtLabel(index)} match=${formatMatch(match)}`);
  });

  if (queuedFirst.length) queue_matches = [...queuedFirst, ...(queue_matches || [])];
}

function promoteQueueMatchesToEnabledCourts(logPrefix = 'queuePromote') {
  while ((queue_matches || []).length > 0) {
    const emptyCourtIdx = getFirstAvailableEnabledCourtIndex();
    if (emptyCourtIdx === -1) break;
    active_matches[emptyCourtIdx] = queue_matches.shift();
    logLine(`${logPrefix}:court=${getCourtLabel(emptyCourtIdx)} match=${formatMatch(active_matches[emptyCourtIdx])}`);
  }
}

function setCourtEnabledState(index, enabled) {
  ensureCourtEnabledStates();
  courtEnabledStates[index] = !!enabled;
  if (!courtEnabledStates[index]) relocateDisabledCourtMatches('court:disable');
}

function samePlayer(a, b) {
  const aRef = getPlayerRef(a);
  const bRef = getPlayerRef(b);
  return aRef !== null && bRef !== null && aRef === bRef;
}

function buildPlayerLookups(sourcePlayers = players) {
  const byId = new Map();
  const byName = new Map();
  (sourcePlayers || []).forEach(player => {
    if (!player) return;
    const id = ensurePlayerId(player);
    if (id) byId.set(id, player);
    if (player.name) byName.set(player.name, player);
  });
  return { byId, byName };
}

function findPlayerByRef(ref, sourcePlayers = players) {
  if (!ref) return null;
  const { byId, byName } = buildPlayerLookups(sourcePlayers);
  return byId.get(ref) || byName.get(ref) || null;
}

function normalizeRecentHistoryRefs(value, byName) {
  return normalizeRecentHistory(value).map(round => {
    const refs = round.map(ref => {
      if (!ref) return null;
      const player = byName && byName.get(ref);
      return player ? ensurePlayerId(player) : ref;
    }).filter(Boolean);
    return Array.from(new Set(refs));
  }).filter(round => round.length).slice(0, RECENT_APPEARANCE_LIMIT);
}

function normalizePlayerRecord(rawPlayer) {
  const player = {
    id: rawPlayer.id || createPlayerId(),
    name: rawPlayer.name,
    level: rawPlayer.level || 4,
    gender: rawPlayer.gender || 'male',
    prefer: rawPlayer.prefer || 'normal',
    rating: rawPlayer.rating !== undefined ? rawPlayer.rating : ((rawPlayer.level || 4) * 100),
    matches: rawPlayer.matches || 0,
    ready: rawPlayer.ready === undefined ? true : rawPlayer.ready,
    idleIndex: Number.isFinite(Number(rawPlayer.idleIndex)) ? Math.max(0, Math.floor(Number(rawPlayer.idleIndex))) : 0,
    couple: rawPlayer.couple === undefined ? null : rawPlayer.couple,
    unpair: rawPlayer.unpair === undefined ? (rawPlayer.uncouple === undefined ? null : rawPlayer.uncouple) : rawPlayer.unpair,
    unpairMain: rawPlayer.unpairMain === undefined ? false : !!rawPlayer.unpairMain,
    partnerSlot: rawPlayer.partnerSlot === undefined ? null : rawPlayer.partnerSlot,
    recentTeammates: normalizeRecentHistory(rawPlayer.recentTeammates),
    recentOpponents: normalizeRecentHistory(rawPlayer.recentOpponents)
  };
  return player;
}

function levelBaseRating(level) {
  const parsedLevel = Number.isFinite(Number(level)) ? Number(level) : 4;
  return parsedLevel * 100;
}

function getPlayerRating(player) {
  if (!player) return 0;
  return Number.isFinite(Number(player.rating)) ? Number(player.rating) : levelBaseRating(player.level || 4);
}

function getPlayerAccumulatedRating(player) {
  if (!player) return 0;
  return getPlayerRating(player) - levelBaseRating(player.level || 4);
}

function setPlayerLevelWithAccumulatedRating(player, nextLevel, options = {}) {
  if (!player) return;
  const { resetAccumulated = false } = options;
  const accumulated = resetAccumulated ? 0 : getPlayerAccumulatedRating(player);
  player.level = nextLevel;
  player.rating = levelBaseRating(nextLevel) + accumulated;
}

function resetPlayerAccumulatedRating(player) {
  if (!player) return;
  player.rating = levelBaseRating(player.level || 4);
}

function formatSignedRating(value) {
  const numericValue = Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0;
  if (numericValue > 0) return `+${numericValue}`;
  if (numericValue < 0) return `${numericValue}`;
  return '0';
}

function buildSelectOptions(options, currentValue) {
  return options.map(option => {
    const value = option.value === undefined || option.value === null ? '' : String(option.value);
    const selected = String(currentValue ?? '') === value ? ' selected' : '';
    return `<option value="${value}"${selected}>${option.label}</option>`;
  }).join('');
}

function getPartnerSlotOptions() {
  const usedSlots = new Set(
    (players || [])
      .map(player => player?.partnerSlot)
      .filter(Boolean)
  );
  const numericSlots = Array.from(usedSlots)
    .map(slot => /^P(\d+)$/.exec(String(slot)))
    .filter(Boolean)
    .map(match => parseInt(match[1], 10));
  const maxSlot = Math.max(MAX_COUPLE, numericSlots.length ? Math.max(...numericSlots) : 0);
  const options = [{ value: '', label: 'No Partner' }];
  for (let idx = 1; idx <= maxSlot; idx++) {
    options.push({ value: `P${idx}`, label: `P${idx}` });
  }
  return options;
}

function getCoupleOptions() {
  const options = [{ value: '', label: 'Single' }];
  for (let idx = 1; idx <= MAX_COUPLE; idx++) {
    options.push({ value: String(idx), label: `C${idx}` });
  }
  return options;
}

function getUnpairOptions() {
  const options = [{ value: '', label: 'Normal' }];
  for (let idx = 1; idx <= MAX_COUPLE; idx++) {
    options.push({ value: `${idx}:main`, label: `No${idx}.Main` });
    options.push({ value: `${idx}:member`, label: `No${idx}.Member` });
  }
  return options;
}

function getUnpairSelectValue(player) {
  const groupId = playerFlagValue(player, 'unpair');
  if (groupId === null) return '';
  return `${groupId}:${player.unpairMain ? 'main' : 'member'}`;
}

function setPlayerPartnerSlot(player, value) {
  if (!player) return;
  player.partnerSlot = value ? String(value) : null;
}

function setPlayerCoupleValue(player, value) {
  if (!player) return;
  const parsed = parseInt(value, 10);
  player.couple = Number.isFinite(parsed) ? parsed : null;
}

function setPlayerUnpairValue(player, value) {
  if (!player) return;
  if (!value) {
    player.unpair = null;
    player.unpairMain = false;
    return;
  }

  const [groupRaw, roleRaw] = String(value).split(':');
  const groupId = parseInt(groupRaw, 10);
  if (!Number.isFinite(groupId)) {
    player.unpair = null;
    player.unpairMain = false;
    return;
  }

  player.unpair = groupId;
  player.unpairMain = roleRaw === 'main';
  if (player.unpairMain) clearDuplicateUnpairMain(groupId, player);
}

function finalizePlayerRecords(sourcePlayers = players) {
  (sourcePlayers || []).forEach(ensurePlayerId);
  const { byName } = buildPlayerLookups(sourcePlayers);
  const unpairMainByGroup = new Set();
  (sourcePlayers || []).forEach(player => {
    if (!player) return;
    player.rating = getPlayerRating(player);
    player.recentTeammates = normalizeRecentHistoryRefs(player.recentTeammates, byName);
    player.recentOpponents = normalizeRecentHistoryRefs(player.recentOpponents, byName);
    normalizePlayerPrefer(player);
    if (playerFlagValue(player, 'unpair') === null) {
      player.unpairMain = false;
      return;
    }
    if (!player.unpairMain) return;
    if (unpairMainByGroup.has(player.unpair)) {
      player.unpairMain = false;
      return;
    }
    unpairMainByGroup.add(player.unpair);
  });
  return sourcePlayers;
}

function normalizeHistoryTeam(teamNames, teamIds, byId, byName) {
  const names = Array.isArray(teamNames) ? teamNames.slice() : [];
  const refsSource = Array.isArray(teamIds) && teamIds.length ? teamIds : names;
  const refs = refsSource.map((ref, idx) => {
    if (!ref && names[idx]) ref = names[idx];
    if (byId.has(ref)) return ref;
    const player = byName.get(ref);
    return player ? ensurePlayerId(player) : ref || null;
  });
  const displayNames = refs.map((ref, idx) => {
    const player = byId.get(ref);
    return player ? player.name : (names[idx] || ref || '');
  });
  return { refs, names: displayNames };
}

function normalizeHistoryEntry(entry, byId, byName) {
  if (!entry) return entry;
  if (entry.note) return { ...entry };
  const team1 = normalizeHistoryTeam(entry.team1, entry.team1Ids, byId, byName);
  const team2 = normalizeHistoryTeam(entry.team2, entry.team2Ids, byId, byName);
  return {
    ...entry,
    team1: team1.names,
    team2: team2.names,
    team1Ids: team1.refs,
    team2Ids: team2.refs
  };
}

function finalizeHistoryEntries(historyList = match_history, sourcePlayers = players) {
  const { byId, byName } = buildPlayerLookups(sourcePlayers);
  return (historyList || []).map(entry => normalizeHistoryEntry(entry, byId, byName));
}

function refreshHistoryNamesForPlayer(player) {
  if (!player) return;
  const playerId = ensurePlayerId(player);
  match_history = (match_history || []).map(entry => {
    if (!entry || entry.note) return entry;
    const next = { ...entry };
    ['team1', 'team2'].forEach(teamKey => {
      const idsKey = `${teamKey}Ids`;
      if (!Array.isArray(next[teamKey])) next[teamKey] = [];
      if (!Array.isArray(next[idsKey])) next[idsKey] = [];
      next[idsKey].forEach((ref, idx) => {
        if (ref === playerId) next[teamKey][idx] = player.name;
      });
    });
    return next;
  });
}

function getHistoryTeamRefs(entry, teamKey) {
  if (!entry) return [];
  const idsKey = `${teamKey}Ids`;
  return Array.isArray(entry[idsKey]) && entry[idsKey].length ? entry[idsKey] : (entry[teamKey] || []);
}

function getPlayerNameByRef(ref, fallback = '') {
  if (!ref) return fallback;
  const player = findPlayerByRef(ref);
  return player ? player.name : (fallback || ref);
}

// ============== CORE UTILITIES ==============

function pairKey(a, b) {
  const n1 = getPlayerRef(a);
  const n2 = getPlayerRef(b);
  return [n1, n2].sort().join('|');
}

function team_type(team) {
  const males = team.filter(p => p && p.gender === 'male').length;
  const females = team.filter(p => p && p.gender === 'female').length;
  if (males === 2) return 'MM';
  if (females === 2) return 'FF';
  return 'MF';
}

function team_rating(team) {
  return (team[0]?.rating || 0) + (team[1]?.rating || 0);
}

function team_level(team) {
  return (team[0]?.level || 0) + (team[1]?.level || 0);
}

function formatPlayer(player) {
  if (!player) return 'null';
  return `${player.name}(L${player.level},I${idleIndexOf(player)})`;
}

function formatTeam(team) {
  if (!team || team.length !== 2) return 'invalid-team';
  return `${formatPlayer(team[0])} - ${formatPlayer(team[1])}`;
}

function formatMatch(match) {
  if (!match || !match[0] || !match[1]) return 'invalid-match';
  return `${formatTeam(match[0])} vs ${formatTeam(match[1])}`;
}

function formatGroup(group) {
  return (group || []).map(formatPlayer).join(', ');
}

function getStateSnapshot() {
  return {
    active: (active_matches || []).map(m => m ? formatMatch(m) : null),
    queue: (queue_matches || []).map(m => m ? formatMatch(m) : null),
    idle: (idle_players || []).map(formatPlayer),
    courts: COURT_NUMBERS.map((courtNumber, index) => ({ court: courtNumber, enabled: isCourtEnabled(index) }))
  };
}

function levelDiffForMatch(match) {
  if (!match || !match[0] || !match[1]) return Infinity;
  return Math.abs(team_level(match[0]) - team_level(match[1]));
}

function hasEqualLevelTeams(match) {
  return levelDiffForMatch(match) < 2;
}

const RATING_CONFIG = {
  baseWin: 50,
  baseLoss: -50,
  teamDiffPerLevel: 10,
  teamDiffCap: 20,
  mvpLowerThanTeammate: 20,
  mvpLowerThanOppAvg: 30,
  minDelta: -100,
  maxDelta: 100,
  minLevel: 1,
  maxLevel: 10
};

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function averageTeamRating(team) {
  if (!Array.isArray(team) || !team.length) return 0;
  return team_rating(team) / team.length;
}

function getPlayerLevelFromRating(rating) {
  const normalizedRating = Number.isFinite(Number(rating)) ? Number(rating) : levelBaseRating(RATING_CONFIG.minLevel);
  const computedLevel = Math.floor(normalizedRating / 100);
  return clampNumber(computedLevel, RATING_CONFIG.minLevel, RATING_CONFIG.maxLevel);
}

function syncPlayerLevelToRating(player) {
  if (!player) return { previousLevel: RATING_CONFIG.minLevel, nextLevel: RATING_CONFIG.minLevel, changed: false };
  const previousLevel = Number.isFinite(Number(player.level)) ? Number(player.level) : RATING_CONFIG.minLevel;
  player.rating = getPlayerRating(player);
  const nextLevel = getPlayerLevelFromRating(player.rating);
  player.level = nextLevel;
  normalizePlayerPrefer(player);
  return { previousLevel, nextLevel, changed: previousLevel !== nextLevel };
}

function syncAllPlayersLevelsToRating() {
  const changes = [];
  (players || []).forEach(player => {
    const syncResult = syncPlayerLevelToRating(player);
    if (syncResult.changed) {
      changes.push({ name: player.name, previousLevel: syncResult.previousLevel, nextLevel: syncResult.nextLevel });
    }
  });
  return changes;
}

function renderLevelSyncControl() {
  const btn = document.getElementById('toggleLevelSync');
  const status = document.getElementById('levelSyncStatus');
  if (btn) {
    btn.textContent = `Auto Level Sync: ${autoSyncLevelsFromRating ? 'ON' : 'OFF'}`;
    btn.classList.toggle('level-sync-toggle-on', autoSyncLevelsFromRating);
    btn.classList.toggle('level-sync-toggle-off', !autoSyncLevelsFromRating);
  }
  if (status) {
    status.textContent = autoSyncLevelsFromRating
      ? 'Rating updates will change level immediately after each result.'
      : 'Rating still accumulates, but level stays frozen until you turn sync back ON.';
  }
}

function setAutoSyncLevelsFromRating(enabled, options = {}) {
  const { save = true, syncAll = false } = options;
  autoSyncLevelsFromRating = !!enabled;

  if (autoSyncLevelsFromRating && syncAll) {
    const changes = syncAllPlayersLevelsToRating();
    if (changes.length) {
      logLine(`levelSync:syncAll ${changes.map(change => `${change.name} L${change.previousLevel}->L${change.nextLevel}`).join(', ')}`);
    } else {
      logLine('levelSync:syncAll no_level_changes');
    }
  }

  renderLevelSyncControl();

  if (save) saveState();
}

function buildRatingUpdateForPlayer(player, ownTeam, opposingTeam, didWin) {
  const teammate = (ownTeam || []).find(candidate => !samePlayer(candidate, player)) || null;
  const ownTeamAvgRating = averageTeamRating(ownTeam);
  const opposingTeamAvgRating = averageTeamRating(opposingTeam);
  const ownPlayerRating = getPlayerRating(player);
  const teammateLevel = teammate?.level || 0;
  const playerLevel = player?.level || 0;
  const gapLevel = Math.round((opposingTeamAvgRating - ownTeamAvgRating) / 100);
  const teamDiffRaw = clampNumber(gapLevel * RATING_CONFIG.teamDiffPerLevel, -RATING_CONFIG.teamDiffCap, RATING_CONFIG.teamDiffCap);
  const teamDiff = didWin ? teamDiffRaw : -teamDiffRaw;
  const base = didWin ? RATING_CONFIG.baseWin : RATING_CONFIG.baseLoss;

  let mvpBonus = 0;
  if (didWin) {
    if ((teammateLevel - playerLevel) >= 1) mvpBonus += RATING_CONFIG.mvpLowerThanTeammate;
    if ((opposingTeamAvgRating - ownPlayerRating) >= 100) mvpBonus += RATING_CONFIG.mvpLowerThanOppAvg;
  }

  const delta = clampNumber(base + teamDiff + mvpBonus, RATING_CONFIG.minDelta, RATING_CONFIG.maxDelta);
  const beforeRating = ownPlayerRating;
  const afterRating = beforeRating + delta;
  const beforeLevel = playerLevel;
  const afterLevel = getPlayerLevelFromRating(afterRating);

  return {
    playerId: ensurePlayerId(player),
    name: player?.name || '',
    won: didWin,
    base,
    teamDiff,
    mvpBonus,
    delta,
    beforeRating,
    afterRating,
    beforeLevel,
    afterLevel,
    ownTeamAvgRating,
    opposingTeamAvgRating
  };
}

function applyRatingUpdatesForMatch(winners, losers) {
  const updates = [];
  (winners || []).forEach(player => {
    updates.push(buildRatingUpdateForPlayer(player, winners, losers, true));
  });
  (losers || []).forEach(player => {
    updates.push(buildRatingUpdateForPlayer(player, losers, winners, false));
  });

  updates.forEach(update => {
    const player = findPlayerByRef(update.playerId) || players.find(candidate => samePlayer(candidate, update.playerId));
    if (!player) return;
    player.rating = update.afterRating;
    if (autoSyncLevelsFromRating) {
      const syncResult = syncPlayerLevelToRating(player);
      update.afterLevel = syncResult.nextLevel;
    } else {
      update.afterLevel = player.level || update.beforeLevel;
    }
  });

  return updates;
}

function idleIndexOf(player) {
  if (!player) return 0;
  const value = Number(player.idleIndex);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function ensureIdleIndex(player) {
  if (!player) return;
  player.idleIndex = idleIndexOf(player);
}

function sortIdlePlayersByIndex() {
  idle_players = (idle_players || []).slice().sort((a, b) => {
    const diff = idleIndexOf(b) - idleIndexOf(a);
    if (diff !== 0) return diff;
    return (a.name || '').localeCompare(b.name || '');
  });
}

function applyIdleIndexOnAssignment(selectedPlayers) {
  const selectedRefs = new Set((selectedPlayers || []).map(getPlayerRef).filter(Boolean));
  if (!selectedRefs.size) return;
  (idle_players || []).forEach(p => {
    ensureIdleIndex(p);
    if (selectedRefs.has(getPlayerRef(p))) p.idleIndex = 0;
    else p.idleIndex += 1;
  });
  sortIdlePlayersByIndex();
  logLine(`idleIndex:update selected=${JSON.stringify(Array.from(selectedRefs))} idleOrder=${JSON.stringify(idle_players.map(p => ({ name: p.name, idleIndex: p.idleIndex })))}`);
}

function getTopIdleSeedIndex(excludedPlayers = []) {
  const excludedRefs = new Set((excludedPlayers || []).map(getPlayerRef).filter(Boolean));
  let maxIdleIndex = 0;

  (idle_players || []).forEach(player => {
    if (!player || excludedRefs.has(getPlayerRef(player))) return;
    maxIdleIndex = Math.max(maxIdleIndex, idleIndexOf(player));
  });

  return maxIdleIndex + 1;
}

function isMatchLocation(loc) {
  return typeof loc === 'string' && (loc.startsWith('court:') || loc.startsWith('queue:'));
}

function sanitizeRecentRound(list) {
  if (!Array.isArray(list)) return [];
  return Array.from(new Set(list.filter(Boolean)));
}

function normalizeRecentHistory(value) {
  if (!Array.isArray(value)) return [];
  if (value.every(item => Array.isArray(item))) {
    return value.map(sanitizeRecentRound).filter(round => round.length).slice(0, RECENT_APPEARANCE_LIMIT);
  }
  const legacyRound = sanitizeRecentRound(value);
  return legacyRound.length ? [legacyRound] : [];
}

function getRecentRounds(player, key) {
  if (!player) return [];
  return normalizeRecentHistory(player[key]);
}

function getRecentNames(player, key) {
  return Array.from(new Set(getRecentRounds(player, key).flat()));
}

function getRecentNamesWithinDepth(player, key, depth) {
  if (!player || !Number.isFinite(depth) || depth <= 0) return [];
  return Array.from(new Set(getRecentRounds(player, key).slice(0, depth).flat()));
}

function getEffectivePrefer(player) {
  if (!player) return 'normal';
  const prefer = player.prefer || 'normal';
  if ((player.level || 0) <= 1) return 'normal';
  return ['chill', 'normal', 'challenge'].includes(prefer) ? prefer : 'normal';
}

function normalizePlayerPrefer(player) {
  if (!player) return;
  player.prefer = getEffectivePrefer(player);
}

function groupMatchesSeedPrefer(seed, group) {
  const effectivePrefer = getEffectivePrefer(seed);
  if (!seed || effectivePrefer === 'normal') return true;

  const others = (group || []).filter(player => player && player !== seed);
  if (others.length !== 3) return false;

  if (effectivePrefer === 'challenge') {
    return others.every(player => player.level >= seed.level && player.level <= seed.level + 1);
  }

  if (effectivePrefer === 'chill') {
    return others.every(player => player.level < seed.level);
  }

  return true;
}

function pushRecentRound(player, key, round) {
  if (!player) return;
  const normalizedRound = sanitizeRecentRound(round);
  const nextHistory = normalizedRound.length
    ? [normalizedRound, ...getRecentRounds(player, key)]
    : getRecentRounds(player, key);
  player[key] = nextHistory.slice(0, RECENT_APPEARANCE_LIMIT);
}

function getPreviousMatchViolation(match, policyKey = 'strict2') {
  if (!match || !match[0] || !match[1]) return 'invalid_match';

  const policy = RECENT_RULE_POLICIES[policyKey] || RECENT_RULE_POLICIES.strict2;

  const [t1, t2] = match;
  const [a, b] = t1;
  const [c, d] = t2;

  if (policy.teammateDepth > 0) {
    const teammatePairs = [[a, b], [c, d]];
    for (const [p1, p2] of teammatePairs) {
      if (playersShareFlag(p1, p2, 'couple')) continue;
      if (
        getRecentNamesWithinDepth(p1, 'recentTeammates', policy.teammateDepth).includes(getPlayerRef(p2)) ||
        getRecentNamesWithinDepth(p2, 'recentTeammates', policy.teammateDepth).includes(getPlayerRef(p1))
      ) {
        return `recent_teammate:${pairKey(p1, p2)}`;
      }
    }
  }

  if (policy.opponentDepth > 0) {
    const opponentPairs = [[a, c], [a, d], [b, c], [b, d]];
    for (const [p1, p2] of opponentPairs) {
      if (
        getRecentNamesWithinDepth(p1, 'recentOpponents', policy.opponentDepth).includes(getPlayerRef(p2)) ||
        getRecentNamesWithinDepth(p2, 'recentOpponents', policy.opponentDepth).includes(getPlayerRef(p1))
      ) {
        return `recent_opponent:${pairKey(p1, p2)}`;
      }
    }
  }

  return null;
}

function markPlayersLastPlayed(match) {
  if (!match) return;
  const [team1, team2] = match;
  if (team1?.[0]) {
    pushRecentRound(team1[0], 'recentTeammates', team1[1] ? [getPlayerRef(team1[1])] : []);
    pushRecentRound(team1[0], 'recentOpponents', team2.filter(Boolean).map(getPlayerRef));
  }
  if (team1?.[1]) {
    pushRecentRound(team1[1], 'recentTeammates', team1[0] ? [getPlayerRef(team1[0])] : []);
    pushRecentRound(team1[1], 'recentOpponents', team2.filter(Boolean).map(getPlayerRef));
  }
  if (team2?.[0]) {
    pushRecentRound(team2[0], 'recentTeammates', team2[1] ? [getPlayerRef(team2[1])] : []);
    pushRecentRound(team2[0], 'recentOpponents', team1.filter(Boolean).map(getPlayerRef));
  }
  if (team2?.[1]) {
    pushRecentRound(team2[1], 'recentTeammates', team2[0] ? [getPlayerRef(team2[0])] : []);
    pushRecentRound(team2[1], 'recentOpponents', team1.filter(Boolean).map(getPlayerRef));
  }
}

function clearSatisfiedPartnerFlags(match) {
  if (!match) return;

  [match[0], match[1]].forEach(team => {
    if (!team || team.length < 2) return;
    const [p1, p2] = team;
    if (!p1 || !p2) return;
    if (!playersShareFlag(p1, p2, 'partnerSlot')) return;

    p1.partnerSlot = null;
    p2.partnerSlot = null;
  });
}

function getAvailablePartnerSlot(excludedPlayers = []) {
  const excludedRefs = new Set((excludedPlayers || []).filter(Boolean).map(getPlayerRef));
  const usedSlots = new Set(
    (players || [])
      .filter(player => player && player.partnerSlot && !excludedRefs.has(getPlayerRef(player)))
      .map(player => player.partnerSlot)
  );

  for (let idx = 1; idx <= MAX_COUPLE; idx++) {
    const slot = `P${idx}`;
    if (!usedSlots.has(slot)) return slot;
  }

  let idx = MAX_COUPLE + 1;
  while (usedSlots.has(`P${idx}`)) idx += 1;
  return `P${idx}`;
}

function assignWishPartner(playerIndex, partnerIndex) {
  const player = players[playerIndex];
  const partner = players[partnerIndex];
  if (!player || !partner || samePlayer(player, partner)) return false;

  const slot = playersShareFlag(player, partner, 'partnerSlot')
    ? player.partnerSlot
    : getAvailablePartnerSlot([player, partner]);

  player.partnerSlot = slot;
  partner.partnerSlot = slot;
  return true;
}

function playerFlagValue(player, key) {
  if (!player) return null;
  const value = player[key];
  return value === undefined || value === null || value === '' ? null : value;
}

function playersShareFlag(a, b, key) {
  const aValue = playerFlagValue(a, key);
  const bValue = playerFlagValue(b, key);
  return aValue !== null && bValue !== null && aValue === bValue;
}

function isUnpairMain(player) {
  return !!player && playerFlagValue(player, 'unpair') !== null && !!player.unpairMain;
}

function playersConflictOnUnpair(a, b) {
  if (!playersShareFlag(a, b, 'unpair')) return false;
  return isUnpairMain(a) || isUnpairMain(b);
}

function clearDuplicateUnpairMain(groupId, keeper) {
  if (groupId === null || groupId === undefined || groupId === '') return;
  (players || []).forEach(player => {
    if (!player || player === keeper) return;
    if (playerFlagValue(player, 'unpair') !== groupId) return;
    player.unpairMain = false;
  });
}

function formatUnpairLabel(player) {
  const groupId = playerFlagValue(player, 'unpair');
  if (groupId === null) return 'Normal';
  return `No${groupId}.${player.unpairMain ? 'Main' : 'Member'}`;
}

function advanceUnpairState(player) {
  if (!player) return;

  const currentGroup = playerFlagValue(player, 'unpair');
  if (currentGroup === null) {
    player.unpair = 1;
    clearDuplicateUnpairMain(1, player);
    player.unpairMain = true;
    return;
  }

  if (player.unpairMain) {
    player.unpairMain = false;
    return;
  }

  if (currentGroup < MAX_COUPLE) {
    player.unpair = currentGroup + 1;
    clearDuplicateUnpairMain(player.unpair, player);
    player.unpairMain = true;
    return;
  }

  player.unpair = null;
  player.unpairMain = false;
}

function getPlayerTeamIndex(match, player) {
  if (!match || !player) return -1;
  const playerRef = getPlayerRef(player);
  for (let teamIdx = 0; teamIdx < 2; teamIdx++) {
    if ((match[teamIdx] || []).some(p => p && getPlayerRef(p) === playerRef)) return teamIdx;
  }
  return -1;
}

function areTeammates(match, a, b) {
  const teamA = getPlayerTeamIndex(match, a);
  const teamB = getPlayerTeamIndex(match, b);
  return teamA !== -1 && teamA === teamB;
}

function getPlayerPlacementInState(state, player) {
  if (!state || !player) return null;
  const playerRef = getPlayerRef(player);

  for (let idx = 0; idx < (state.active || []).length; idx++) {
    const match = state.active[idx];
    const teamIndex = getPlayerTeamIndex(match, playerRef);
    if (teamIndex !== -1) return { bucket: 'active', index: idx, teamIndex };
  }

  for (let idx = 0; idx < (state.queue || []).length; idx++) {
    const match = state.queue[idx];
    const teamIndex = getPlayerTeamIndex(match, playerRef);
    if (teamIndex !== -1) return { bucket: 'queue', index: idx, teamIndex };
  }

  return null;
}

function validateHardRulesForMatch(match) {
  if (!match || !match[0] || !match[1]) return { valid: false, reason: 'invalid_match' };

  const flat = match.flat().filter(Boolean);
  for (let i = 0; i < flat.length - 1; i++) {
    for (let j = i + 1; j < flat.length; j++) {
      if (playersShareFlag(flat[i], flat[j], 'couple') && !areTeammates(match, flat[i], flat[j])) {
        return { valid: false, reason: `couple_split:${pairKey(flat[i], flat[j])}` };
      }
      if (playersConflictOnUnpair(flat[i], flat[j]) && areTeammates(match, flat[i], flat[j])) {
        return { valid: false, reason: `unpair_teammate:${pairKey(flat[i], flat[j])}` };
      }
    }
  }

  return { valid: true, reason: 'ok' };
}

function validateCouplesInState(state) {
  const coupleGroups = new Map();

  (players || []).filter(p => p && p.ready).forEach(player => {
    const coupleId = playerFlagValue(player, 'couple');
    if (coupleId === null) return;
    if (!coupleGroups.has(coupleId)) coupleGroups.set(coupleId, []);
    coupleGroups.get(coupleId).push(player);
  });

  for (const members of coupleGroups.values()) {
    if (members.length < 2) continue;
    for (let i = 0; i < members.length - 1; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const aPlacement = getPlayerPlacementInState(state, members[i]);
        const bPlacement = getPlayerPlacementInState(state, members[j]);

        if (!!aPlacement !== !!bPlacement) {
          return { valid: false, reason: `couple_assignment:${pairKey(members[i], members[j])}` };
        }

        if (aPlacement && bPlacement) {
          if (
            aPlacement.bucket !== bPlacement.bucket ||
            aPlacement.index !== bPlacement.index ||
            aPlacement.teamIndex !== bPlacement.teamIndex
          ) {
            return { valid: false, reason: `couple_split:${pairKey(members[i], members[j])}` };
          }
        }
      }
    }
  }

  return { valid: true, reason: 'ok' };
}

function computePartnerMatchPenalty(match) {
  if (!match) return 0;
  const flat = match.flat().filter(Boolean);
  let penalty = 0;

  for (let i = 0; i < flat.length - 1; i++) {
    for (let j = i + 1; j < flat.length; j++) {
      if (!playersShareFlag(flat[i], flat[j], 'partnerSlot')) continue;
      penalty += areTeammates(match, flat[i], flat[j]) ? -1.5 : 1;
    }
  }

  return penalty;
}

function computePreferMatchPenalty(match) {
  // Prefer is now enforced as a seed-only grouping rule during match creation.
  return 0;
}

function computePartnerStatePenalty(state) {
  const partnerGroups = new Map();
  let penalty = 0;

  (players || []).filter(p => p && p.ready).forEach(player => {
    const slot = playerFlagValue(player, 'partnerSlot');
    if (slot === null) return;
    if (!partnerGroups.has(slot)) partnerGroups.set(slot, []);
    partnerGroups.get(slot).push(player);
  });

  for (const members of partnerGroups.values()) {
    if (members.length < 2) continue;
    for (let i = 0; i < members.length - 1; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const aPlacement = getPlayerPlacementInState(state, members[i]);
        const bPlacement = getPlayerPlacementInState(state, members[j]);

        if (aPlacement && bPlacement) {
          if (
            aPlacement.bucket === bPlacement.bucket &&
            aPlacement.index === bPlacement.index &&
            aPlacement.teamIndex === bPlacement.teamIndex
          ) penalty -= 2;
          else penalty += 1.5;
        } else if (aPlacement || bPlacement) {
          penalty += 0.75;
        }
      }
    }
  }

  return penalty;
}

function computeMatchTypeBalancePenalty(state) {
  const counts = { MM: 0, MF: 0, FF: 0 };
  [...(state.active || []), ...(state.queue || [])].forEach(match => {
    if (!match) return;
    const type = team_type(match[0]);
    if (counts[type] !== undefined) counts[type] += 1;
  });

  return Math.abs(counts.MM - counts.MF) + Math.abs(counts.MM - counts.FF) + Math.abs(counts.MF - counts.FF);
}

function groupRespectsAvailableCouples(group, candidatePlayers) {
  const groupRefs = new Set((group || []).filter(Boolean).map(getPlayerRef));

  for (const player of (group || [])) {
    const coupleId = playerFlagValue(player, 'couple');
    if (coupleId === null) continue;
    const availablePartners = (candidatePlayers || []).filter(other => other && !samePlayer(other, player) && playersShareFlag(player, other, 'couple'));
    if (availablePartners.some(other => !groupRefs.has(getPlayerRef(other)))) return false;
  }

  return true;
}

function countFemales(group) {
  return (group || []).filter(player => player && player.gender === 'female').length;
}

function countEmptyCourts() {
  return (active_matches || []).filter((match, index) => isCourtEnabled(index) && !match).length;
}

function scoreCandidateForSeed(seed, candidate) {
  if (!seed || !candidate) return -Infinity;

  let score = idleIndexOf(candidate) * 100;
  score -= Math.abs((seed.level || 0) - (candidate.level || 0)) * 8;

  if (playersShareFlag(seed, candidate, 'couple')) score += 220;
  if (playersShareFlag(seed, candidate, 'partnerSlot')) score += 120;
  if (playersConflictOnUnpair(seed, candidate)) score -= 30;

  const candidateRecentTeam = getRecentNames(candidate, 'recentTeammates');
  const candidateRecentOpp = getRecentNames(candidate, 'recentOpponents');
  const seedRecentTeam = getRecentNames(seed, 'recentTeammates');
  const seedRecentOpp = getRecentNames(seed, 'recentOpponents');

  if (!playersShareFlag(seed, candidate, 'couple') && (seedRecentTeam.includes(getPlayerRef(candidate)) || candidateRecentTeam.includes(getPlayerRef(seed)))) score -= 25;
  if (seedRecentOpp.includes(getPlayerRef(candidate)) || candidateRecentOpp.includes(getPlayerRef(seed))) score -= 15;

  return score;
}

function buildSupportPoolForSeed(rankedPlayers, seed, poolLimit) {
  return (rankedPlayers || [])
    .filter(player => player !== seed)
    .map(player => ({ player, seedScore: scoreCandidateForSeed(seed, player) }))
    .sort((a, b) => {
      if (b.seedScore !== a.seedScore) return b.seedScore - a.seedScore;
      const idleDiff = idleIndexOf(b.player) - idleIndexOf(a.player);
      if (idleDiff !== 0) return idleDiff;
      return (a.player.name || '').localeCompare(b.player.name || '');
    })
    .slice(0, Math.min(poolLimit, Math.max(3, rankedPlayers.length - 1)))
    .map(entry => entry.player);
}

function getPoolExpansionSizes(totalPlayers) {
  if (!Number.isFinite(totalPlayers) || totalPlayers <= 0) return [];

  const poolSizes = [];
  let size = Math.min(MATCH_SELECTION_POOL_SIZE, totalPlayers);

  while (size < totalPlayers) {
    poolSizes.push(size);
    size *= 2;
  }

  poolSizes.push(totalPlayers);
  return Array.from(new Set(poolSizes));
}

function selectBestMatchFromPlayers(candidatePlayers, options = {}) {
  if (!candidatePlayers || candidatePlayers.length < 4) return null;

  const {
    logContext = '',
    policyKey = 'strict2',
    seed = null,
    poolLimit = MATCH_SELECTION_POOL_SIZE,
    verbose = false
  } = options;

  const ranked = candidatePlayers.slice().sort((a, b) => {
    const idleDiff = idleIndexOf(b) - idleIndexOf(a);
    if (idleDiff !== 0) return idleDiff;
    return (a.name || '').localeCompare(b.name || '');
  });
  const selectedSeed = seed || ranked[0];
  if (!selectedSeed) return null;

  const supportPool = buildSupportPoolForSeed(ranked, selectedSeed, poolLimit);
  const pool = [selectedSeed, ...supportPool];
  const candidateGroups = [];

  for (let i = 1; i < pool.length - 2; i++) {
    for (let j = i + 1; j < pool.length - 1; j++) {
      for (let k = j + 1; k < pool.length; k++) {
        const group = [selectedSeed, pool[i], pool[j], pool[k]];
        if (!groupMatchesSeedPrefer(selectedSeed, group)) continue;
        if (countFemales(group) % 2 !== 0) continue;
        if (!groupRespectsAvailableCouples(group, candidatePlayers)) continue;

        let partnerPairs = 0;
        let couplePairs = 0;
        for (let a = 0; a < group.length - 1; a++) {
          for (let b = a + 1; b < group.length; b++) {
            if (playersShareFlag(group[a], group[b], 'partnerSlot')) partnerPairs += 1;
            if (playersShareFlag(group[a], group[b], 'couple')) couplePairs += 1;
          }
        }

        candidateGroups.push({
          group,
          idleScore: group.reduce((sum, player) => sum + idleIndexOf(player), 0),
          partnerPairs,
          couplePairs,
          seedAffinity: scoreCandidateForSeed(selectedSeed, pool[i]) + scoreCandidateForSeed(selectedSeed, pool[j]) + scoreCandidateForSeed(selectedSeed, pool[k])
        });
      }
    }
  }

  candidateGroups.sort((a, b) => {
    if (b.idleScore !== a.idleScore) return b.idleScore - a.idleScore;
    if (b.couplePairs !== a.couplePairs) return b.couplePairs - a.couplePairs;
    if (b.partnerPairs !== a.partnerPairs) return b.partnerPairs - a.partnerPairs;
    if (b.seedAffinity !== a.seedAffinity) return b.seedAffinity - a.seedAffinity;
    return 0;
  });

  const shortlistedGroups = candidateGroups.slice(0, MAX_CANDIDATE_GROUPS);

  if (logContext) {
    logLine(`${logContext}:attempt policy=${policyKey} seed=${formatPlayer(selectedSeed)} poolLimit=${supportPool.length} candidateGroups=${candidateGroups.length} shortlisted=${shortlistedGroups.length}`);
  }

  for (let idx = 0; idx < shortlistedGroups.length; idx++) {
    const candidate = shortlistedGroups[idx];
    if (verbose && logContext) logLine(`${logContext}:tryGroup#${idx + 1} idleScore=${candidate.idleScore} group=${formatGroup(candidate.group)}`);
    const match = findBestMatch(candidate.group, verbose && logContext ? `${logContext}:${policyKey}` : '', policyKey);
    if (match) {
      return {
        match,
        seed: selectedSeed,
        poolLimit: supportPool.length,
        candidateGroupCount: candidateGroups.length,
        shortlistedCount: shortlistedGroups.length
      };
    }
  }

  return {
    match: null,
    seed: selectedSeed,
    poolLimit: supportPool.length,
    candidateGroupCount: candidateGroups.length,
    shortlistedCount: shortlistedGroups.length
  };
}

function getChallengeReservePlan(rankedPlayers, policyKey, poolLimit) {
  if (!rankedPlayers || rankedPlayers.length < 4) return null;

  const reserveCandidates = rankedPlayers
    .slice(0, Math.min(CHALLENGE_RESERVE_WINDOW, rankedPlayers.length))
    .map((player, rankIndex) => ({ player, rankIndex }))
    .filter(({ player, rankIndex }) => rankIndex >= MAX_SEED_ATTEMPTS && getEffectivePrefer(player) === 'challenge')
    .sort((a, b) => {
      const idleDiff = idleIndexOf(b.player) - idleIndexOf(a.player);
      if (idleDiff !== 0) return idleDiff;
      return a.rankIndex - b.rankIndex;
    });

  for (const candidate of reserveCandidates) {
    const result = selectBestMatchFromPlayers(rankedPlayers, {
      policyKey,
      seed: candidate.player,
      poolLimit,
      verbose: false
    });

    if (!result || !result.match) continue;

    return {
      challenge: candidate.player,
      rankIndex: candidate.rankIndex,
      result,
      reserveNames: new Set(result.match.flat().filter(Boolean).map(getPlayerRef))
    };
  }

  return null;
}

// ============== HISTORY TRACKING ==============

function buildHistoricalMaps() {
  const teammateMap = {};
  const opponentMap = {};
  
  for (const h of match_history || []) {
    if (!h || !h.team1 || !h.team2) continue;
    const [t1a, t1b] = getHistoryTeamRefs(h, 'team1');
    const [t2a, t2b] = getHistoryTeamRefs(h, 'team2');
    
    // Track teammates
    const tk1 = pairKey(t1a, t1b);
    const tk2 = pairKey(t2a, t2b);
    teammateMap[tk1] = (teammateMap[tk1] || 0) + 1;
    teammateMap[tk2] = (teammateMap[tk2] || 0) + 1;
    
    // Track opponents
    const oppPairs = [
      pairKey(t1a, t2a), pairKey(t1a, t2b),
      pairKey(t1b, t2a), pairKey(t1b, t2b)
    ];
    oppPairs.forEach(k => {
      opponentMap[k] = (opponentMap[k] || 0) + 1;
    });
  }
  
  return { teammateMap, opponentMap };
}

function toHistoryLikeMatch(match) {
  if (!match || !match[0] || !match[1]) return null;
  if (!match[0][0] || !match[0][1] || !match[1][0] || !match[1][1]) return null;
  return {
    team1Ids: [getPlayerRef(match[0][0]), getPlayerRef(match[0][1])],
    team2Ids: [getPlayerRef(match[1][0]), getPlayerRef(match[1][1])],
    team1: [match[0][0].name, match[0][1].name],
    team2: [match[1][0].name, match[1][1].name]
  };
}

// debug logging helpers
function logLine(msg){
  const ts = new Date().toISOString();
  debug_log.push(`[${ts}] ${msg}`);
  if(debug_log.length > 3000) debug_log = debug_log.slice(-3000);
  try{ localStorage.setItem('badminton_log', JSON.stringify(debug_log)); }catch(e){}
  const preview = document.getElementById('logPreview');
  if(preview) preview.textContent = debug_log.slice(-120).join('\n');
}

function loadLog(){
  try{ const l = localStorage.getItem('badminton_log'); if(l) debug_log = JSON.parse(l); }catch(e){}
  const preview = document.getElementById('logPreview'); if(preview) preview.textContent = debug_log.slice(-50).join('\n');
}

function downloadLog(){
  try{ const stored = localStorage.getItem('badminton_log'); if(stored) debug_log = JSON.parse(stored); }catch(e){}
  const blob = new Blob([debug_log.join('\n')], {type:'text/plain'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'badminton_log.txt'; a.click(); URL.revokeObjectURL(url);
}

function clearLog(){ debug_log = []; try{ localStorage.removeItem('badminton_log'); }catch(e){} const preview = document.getElementById('logPreview'); if(preview) preview.textContent = ''; }

function analyzeMatch(match, maps, policyKey = 'strict2') {
  if (!match || !match[0] || !match[1]) return { valid: false, reason: 'invalid_match', score: Infinity, levelDiff: Infinity };

  const [t1, t2] = match;
  const [a, b] = t1;
  const [c, d] = t2;

  if (!a || !b || !c || !d) return { valid: false, reason: 'missing_player', score: Infinity, levelDiff: Infinity };

  const type1 = team_type(t1);
  const type2 = team_type(t2);
  const levelDiff = levelDiffForMatch(match);

  if (type1 !== type2) {
    return { valid: false, reason: `type_mismatch:${type1}_${type2}`, score: Infinity, levelDiff, type1, type2 };
  }

  const hardRuleCheck = validateHardRulesForMatch(match);
  if (!hardRuleCheck.valid) {
    return { valid: false, reason: hardRuleCheck.reason, score: Infinity, levelDiff, type1, type2 };
  }

  const recentViolation = getPreviousMatchViolation(match, policyKey);
  if (recentViolation) return { valid: false, reason: recentViolation, score: Infinity, levelDiff, type1, type2 };

  const teamRep = (maps.teammateMap[pairKey(a, b)] || 0) + (maps.teammateMap[pairKey(c, d)] || 0);
  const oppRep = (maps.opponentMap[pairKey(a, c)] || 0) +
    (maps.opponentMap[pairKey(a, d)] || 0) +
    (maps.opponentMap[pairKey(b, c)] || 0) +
    (maps.opponentMap[pairKey(b, d)] || 0);
  const ratingDiff = Math.abs(team_rating(t1) - team_rating(t2));
  const partnerPenalty = computePartnerMatchPenalty(match);
  const preferPenalty = computePreferMatchPenalty(match);
  const score = teamRep * WEIGHTS.teammateRepeat +
    oppRep * WEIGHTS.opponentRepeat +
    ratingDiff * WEIGHTS.levelBalance / 100 +
    partnerPenalty * WEIGHTS.partnerWish +
    preferPenalty * WEIGHTS.preferWish;

  return {
    valid: true,
    reason: levelDiff < 2 ? 'balanced' : 'rebalance_best_effort',
    score,
    levelDiff,
    ratingDiff,
    teamRep,
    oppRep,
    partnerPenalty,
    preferPenalty,
    type1,
    type2
  };
}

// ============== MATCH SCORING ==============

const WEIGHTS = {
  teammateRepeat: 100,   // Penalty for repeating teammates
  opponentRepeat: 80,    // Penalty for repeating opponents
  levelBalance: 50,      // Penalty for level imbalance between teams
  partnerWish: 35,
  preferWish: 12,
  partnerState: 40,
  matchTypeBalance: 18,
};

function scoreMatch(match, maps, policyKey = 'strict2') {
  return analyzeMatch(match, maps, policyKey).score;
}

// ============== MATCH CREATION ==============

function findBestMatch(group, logContext = '', policyKey = 'strict2') {
  // Try all 3 possible pairings for 4 players
  const pairings = [
    [[group[0], group[1]], [group[2], group[3]]],
    [[group[0], group[2]], [group[1], group[3]]],
    [[group[0], group[3]], [group[1], group[2]]]
  ];
  
  const maps = buildHistoricalMaps();
  let bestMatch = null;
  let bestScore = Infinity;
  let bestLevelDiff = Infinity;
  let foundBalanced = false;

  if (logContext) logLine(`${logContext}:start group=${formatGroup(group)}`);
  
  for (let idx = 0; idx < pairings.length; idx++) {
    const m = pairings[idx];
    const analysis = analyzeMatch(m, maps, policyKey);
    const levelDiff = analysis.levelDiff;
    const balanced = levelDiff < 2;
    const score = analysis.score;

    if (logContext) {
      logLine(`${logContext}:pairing#${idx + 1} match=${formatMatch(m)} valid=${analysis.valid} reason=${analysis.reason} type=${analysis.type1 || 'n/a'} score=${Number.isFinite(score) ? score : 'Infinity'} levelDiff=${Number.isFinite(levelDiff) ? levelDiff : 'Infinity'} teamRep=${analysis.teamRep ?? 'n/a'} oppRep=${analysis.oppRep ?? 'n/a'}`);
    }

    if (!analysis.valid) continue;

    if (balanced && !foundBalanced) {
      foundBalanced = true;
      bestLevelDiff = levelDiff;
      bestScore = score;
      bestMatch = m;
      if (logContext) logLine(`${logContext}:selectBalanced pairing#${idx + 1} match=${formatMatch(m)}`);
      continue;
    }

    if (foundBalanced && !balanced) continue;

    if (
      levelDiff < bestLevelDiff ||
      (levelDiff === bestLevelDiff && score < bestScore)
    ) {
      bestLevelDiff = levelDiff;
      bestScore = score;
      bestMatch = m;
      if (logContext) logLine(`${logContext}:updateBest pairing#${idx + 1} match=${formatMatch(m)} bestLevelDiff=${bestLevelDiff} bestScore=${bestScore}`);
    }
  }

  if (logContext) {
    logLine(`${logContext}:${bestMatch ? 'result' : 'noResult'} match=${bestMatch ? formatMatch(bestMatch) : 'none'} bestLevelDiff=${Number.isFinite(bestLevelDiff) ? bestLevelDiff : 'Infinity'} bestScore=${Number.isFinite(bestScore) ? bestScore : 'Infinity'}`);
  }
  
  return bestMatch;
}

function rebalanceExistingMatches() {
  active_matches = (active_matches || []).map((m, idx) => {
    if (!m) return null;
    const flat = m.flat().filter(Boolean);
    if (flat.length !== 4) return m;
    if (hasEqualLevelTeams(m)) return m;
    const next = findBestMatch(flat) || m;
    if (formatMatch(next) !== formatMatch(m)) logLine(`rebalance:active:${idx}:changed from=${formatMatch(m)} to=${formatMatch(next)}`);
    return next;
  });

  queue_matches = (queue_matches || []).map((m, idx) => {
    if (!m) return null;
    const flat = m.flat().filter(Boolean);
    if (flat.length !== 4) return m;
    if (hasEqualLevelTeams(m)) return m;
    const next = findBestMatch(flat) || m;
    if (formatMatch(next) !== formatMatch(m)) logLine(`rebalance:queue:${idx}:changed from=${formatMatch(m)} to=${formatMatch(next)}`);
    return next;
  }).filter(Boolean);
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ============== OPTIMIZER (Simulated Annealing + Local Search) ==============

const SA_CONFIG = {
  iterations: 500,
  tempStart: 100,
  cooling: 0.95,
  tempMin: 0.5,
  localSteps: 50
};

function cloneMatch(m) {
  if (!m) return null;
  return [[m[0][0], m[0][1]], [m[1][0], m[1][1]]];
}

function cloneState(state) {
  return {
    active: (state.active || []).map(cloneMatch),
    queue: (state.queue || []).map(cloneMatch),
    idle: (state.idle || []).slice()
  };
}

function getPlayersInState(state) {
  const inMatch = new Set();
  [...(state.active || []), ...(state.queue || [])].forEach(m => {
    if (m) m.flat().forEach(p => { if (p) inMatch.add(p.name); });
  });
  (state.idle || []).forEach(p => { if (p) inMatch.add(p.name); });
  return inMatch;
}

function isStateValid(state) {
  const seen = new Set();
  
  for (const m of [...(state.active || []), ...(state.queue || [])]) {
    if (!m) continue;
    const flat = m.flat();
    if (flat.length !== 4 || flat.some(p => !p)) return false;
    
    // Check match type
    if (team_type(m[0]) !== team_type(m[1])) return false;
    if (!validateHardRulesForMatch(m).valid) return false;
    
    // Rule 2/3: no teammate/opponent repeat from each player's 2 most recent played matches
    if (getPreviousMatchViolation(m)) return false;
    
    // Check duplicates
    for (const p of flat) {
      if (seen.has(p.name)) return false;
      seen.add(p.name);
    }
  }
  
  for (const p of (state.idle || [])) {
    if (!p) continue;
    if (seen.has(p.name)) return false;
    seen.add(p.name);
  }

  return validateCouplesInState(state).valid;
}

function evaluateState(state) {
  if (!isStateValid(state)) return 1e12;
  
  const maps = buildHistoricalMaps();

  let totalCost = 0;
  [...(state.active || []), ...(state.queue || [])].forEach(m => {
    if (m) totalCost += scoreMatch(m, maps);
  });

  totalCost += computePartnerStatePenalty(state) * WEIGHTS.partnerState;
  totalCost += computeMatchTypeBalancePenalty(state) * WEIGHTS.matchTypeBalance;
  
  return totalCost;
}

function makeNeighbor(state) {
  const next = cloneState(state);
  
  // Collect all player locations
  const locs = [];
  (next.active || []).forEach((m, ci) => {
    if (!m) return;
    for (let t = 0; t < 2; t++) for (let p = 0; p < 2; p++) 
      locs.push({ type: 'active', ci, t, p, player: m[t][p] });
  });
  (next.queue || []).forEach((m, qi) => {
    if (!m) return;
    for (let t = 0; t < 2; t++) for (let p = 0; p < 2; p++)
      locs.push({ type: 'queue', qi, t, p, player: m[t][p] });
  });
  (next.idle || []).forEach((player, ii) => {
    locs.push({ type: 'idle', ii, player });
  });
  
  if (locs.length < 2) return next;
  
  // Pick two different players from DIFFERENT matches/idle to swap
  let i, j, tries = 0;
  do {
    i = Math.floor(Math.random() * locs.length);
    j = Math.floor(Math.random() * locs.length);
    tries++;
    
    // Ensure different locations and different match/idle group
    const sameGroup = (locs[i].type === locs[j].type) && 
                      ((locs[i].type === 'active' && locs[i].ci === locs[j].ci) ||
                       (locs[i].type === 'queue' && locs[i].qi === locs[j].qi));
    if (i !== j && !sameGroup) break;
  } while (tries < 30);
  
  if (i === j) return next;
  
  // Perform swap
  const locA = locs[i], locB = locs[j];
  
  const setPlayer = (loc, player) => {
    if (loc.type === 'active') next.active[loc.ci][loc.t][loc.p] = player;
    else if (loc.type === 'queue') next.queue[loc.qi][loc.t][loc.p] = player;
    else next.idle[loc.ii] = player;
  };
  
  setPlayer(locA, locB.player);
  setPlayer(locB, locA.player);
  
  return next;
}

function buildSeedState() {
  const ready = players.filter(p => p && p.ready);
  const matches = [];
  let remaining = ready.slice().sort((a, b) => {
    const idleDiff = idleIndexOf(b) - idleIndexOf(a);
    if (idleDiff !== 0) return idleDiff;
    return (a.name || '').localeCompare(b.name || '');
  });

  while (remaining.length >= 4) {
    const pickedMatch = selectBestMatchFromPlayers(remaining, 'buildSeedState');
    if (!pickedMatch) break;

    matches.push(pickedMatch);
    const pickedNames = new Set(pickedMatch.flat().map(p => p.name));
    remaining = remaining.filter(p => !pickedNames.has(p.name));
  }
  
  const active = matches.slice(0, Math.min(COURTS, matches.length));
  while (active.length < COURTS) active.push(null);
  const queue = matches.slice(COURTS);
  const used = new Set(matches.flatMap(m => m.flat().map(p => p.name)));
  const idle = ready.filter(p => !used.has(p.name));
  
  return { active, queue, idle };
}

function optimizeState(mode = 'build') {
  let current = (mode === 'build') ? buildSeedState() : cloneState({
    active: active_matches,
    queue: queue_matches,
    idle: idle_players
  });
  
  let currentCost = evaluateState(current);
  if (currentCost >= 1e12) {
    if (mode === 'build') return buildSeedState();
    return current;
  }
  
  let best = cloneState(current);
  let bestCost = currentCost;
  
  // Local search phase
  for (let step = 0; step < SA_CONFIG.localSteps; step++) {
    for (let t = 0; t < 10; t++) {
      const cand = makeNeighbor(current);
      const cc = evaluateState(cand);
      if (cc < currentCost) {
        current = cand;
        currentCost = cc;
        if (cc < bestCost) {
          best = cloneState(cand);
          bestCost = cc;
        }
        break;
      }
    }
  }
  
  // Simulated annealing phase
  let temp = SA_CONFIG.tempStart;
  for (let i = 0; i < SA_CONFIG.iterations; i++) {
    if (temp < SA_CONFIG.tempMin) break;
    
    const cand = makeNeighbor(current);
    const candCost = evaluateState(cand);
    const delta = candCost - currentCost;
    
    if (delta <= 0 || Math.random() < Math.exp(-delta / temp)) {
      current = cand;
      currentCost = candCost;
      if (candCost < bestCost) {
        best = cloneState(cand);
        bestCost = candCost;
      }
    }
    
    temp *= SA_CONFIG.cooling;
  }
  
  return best;
}

function applyState(state) {
  active_matches = (state.active || []).map(cloneMatch);
  queue_matches = (state.queue || []).map(cloneMatch);
  idle_players = (state.idle || []).slice();
  rebalanceExistingMatches();
  while (active_matches.length < COURTS) active_matches.push(null);
}

// ============== RENDERING ==============

function isCompleteMatch(match) {
  return !!(match && match[0] && match[1] && match.flat().every(player => player));
}

function renderCourtSlot(player, loc) {
  if (player) return renderPlayerSpan(player, loc);
  return `<span class="player-drop-slot" data-loc="${loc}" ondragover="onPlayerDragOver(event)" ondrop="onPlayerDrop(event)">Drop Player</span>`;
}

function renderPlayerSpan(p, loc) {
  const cls = (p && p.gender === 'female') ? 'female' : 'male';
  const name = p ? p.name : '';
  const dataLoc = loc ? ` data-loc="${loc}"` : '';
  return `<span class="player-name ${cls}" draggable="true" ${dataLoc} ondragstart="onPlayerDragStart(event)" ondragover="onPlayerDragOver(event)" ondrop="onPlayerDrop(event)">${name}</span>`;
}

function renderCourt(i) {
  const courtsRow = document.getElementById('courtsRow');
  while (courtsRow.children.length <= i) {
    const wrapper = document.createElement('div');
    wrapper.className = 'col-12 court-card';
    courtsRow.appendChild(wrapper);
  }
  const card = courtsRow.children[i];
  const courtLabel = getCourtLabel(i);
  const courtEnabled = isCourtEnabled(i);
  const toggleButtonHtml = `<button class="court-switch ${courtEnabled ? 'court-switch-on' : 'court-switch-off'}" type="button" role="switch" aria-checked="${courtEnabled}" aria-label="${courtEnabled ? 'Turn off' : 'Turn on'} ${courtLabel}" data-toggle-court="${i}"><span class="court-switch-track"><span class="court-switch-thumb"></span></span></button>`;
  let html = '';
  
  if (active_matches[i] && isCompleteMatch(active_matches[i])) {
    const [t1, t2] = active_matches[i];
    html = `<div class="card">
      <div class="card-header position-relative d-flex justify-content-between align-items-center">
        <div class="fs-5 fw-bold">${courtLabel}</div>
        ${toggleButtonHtml}
      </div>
      <div class="card-body d-flex align-items-center">
        <div class="team-col text-center flex-fill">
          <div class="team-row">
            <span class="match-handle-card me-2 align-middle" data-court-index="${i}" draggable="true">≡</span>
            ${renderPlayerSpan(t1[0], 'court:' + i + ':0:0')}
            <span class="sep">-</span>
            ${renderPlayerSpan(t1[1], 'court:' + i + ':0:1')}
          </div>
        </div>
        <div class="vs-col text-center px-2"><strong>VS</strong></div>
        <div class="team-col text-center flex-fill">
          <div class="team-row">
            ${renderPlayerSpan(t2[0], 'court:' + i + ':1:0')}
            <span class="sep">-</span>
            ${renderPlayerSpan(t2[1], 'court:' + i + ':1:1')}
          </div>
        </div>
        <div class="enter-col ms-2">
          <button class="btn btn-sm btn-enter-score" data-court="${i}">Enter Result</button>
        </div>
      </div>
    </div>`;
  } else if (active_matches[i]) {
    const [t1, t2] = active_matches[i];
    html = `<div class="card manual-match-card">
      <div class="card-header position-relative d-flex justify-content-between align-items-center">
        <div class="fs-5 fw-bold">${courtLabel}</div>
        <div class="d-flex align-items-center gap-2">
          ${toggleButtonHtml}
          <button class="btn btn-sm uniform-btn" data-clear-manual="${i}">Clear Manual</button>
        </div>
      </div>
      <div class="card-body d-flex align-items-center">
        <div class="team-col text-center flex-fill">
          <div class="team-row">
            ${renderCourtSlot(t1[0], 'court:' + i + ':0:0')}
            <span class="sep">-</span>
            ${renderCourtSlot(t1[1], 'court:' + i + ':0:1')}
          </div>
        </div>
        <div class="vs-col text-center px-2"><strong>VS</strong></div>
        <div class="team-col text-center flex-fill">
          <div class="team-row">
            ${renderCourtSlot(t2[0], 'court:' + i + ':1:0')}
            <span class="sep">-</span>
            ${renderCourtSlot(t2[1], 'court:' + i + ':1:1')}
          </div>
        </div>
        <div class="enter-col ms-2">
          <span class="badge bg-secondary">Manual</span>
        </div>
      </div>
    </div>`;
  } else {
    html = `<div class="card">
      <div class="card-header position-relative d-flex justify-content-between align-items-center">
        <div class="fs-5 fw-bold">${courtLabel}</div>
        ${toggleButtonHtml}
      </div>
      <div class="card-body">
        ${courtEnabled
          ? `<div class="empty-slot" data-loc="court:${i}:empty" ondragover="onPlayerDragOver(event)" ondrop="onPlayerDrop(event)">
          <button class="btn btn-sm uniform-btn" data-manual-court="${i}">Manual Match</button>
        </div>`
          : `<div class="empty-slot empty-slot-off">Court OFF</div>`}
      </div>
    </div>`;
  }
  
  card.innerHTML = html;
  
  // Wire handlers
  const mh = card.querySelector('.match-handle-card');
  if (mh) {
    mh.ondragstart = matchHandleDragStart;
    mh.ondragover = matchHandleDragOver;
    mh.ondrop = matchHandleDrop;
  }
  card.ondragover = matchHandleDragOver;
  card.ondrop = matchHandleDrop;
  
  const btn = card.querySelector('button[data-court]');
  if (btn) btn.onclick = () => openScoreModal(i);
  const toggleBtn = card.querySelector('button[data-toggle-court]');
  if (toggleBtn) {
    toggleBtn.onclick = () => {
      setCourtEnabledState(i, !isCourtEnabled(i));
      updateIdlePlayers();
      promoteQueueMatchesToEnabledCourts('courtToggle:promoteQueue');
      saveState();
      render();
      renderAdminPlayers();
    };
  }
  const manualBtn = card.querySelector('button[data-manual-court]');
  if (manualBtn) {
    manualBtn.onclick = () => {
      active_matches[i] = [[null, null], [null, null]];
      saveState();
      updateIdlePlayers();
      render();
      renderAdminPlayers();
    };
  }
  const clearManualBtn = card.querySelector('button[data-clear-manual]');
  if (clearManualBtn) {
    clearManualBtn.onclick = () => {
      const match = active_matches[i];
      if (match) {
        match.flat().filter(Boolean).forEach(player => {
          if (!idle_players.some(idle => samePlayer(idle, player))) idle_players.push(player);
        });
      }
      active_matches[i] = null;
      saveState();
      updateIdlePlayers();
      render();
      renderAdminPlayers();
    };
  }
}

function renderQueue() {
  const queueList = document.getElementById('queueList');
  queueList.innerHTML = '';
  
  for (let qi = 0; qi < queue_matches.length; qi++) {
    const m = queue_matches[qi];
    if (!m) continue;
    
    const [t1, t2] = m;
    const li = document.createElement('li');
    li.className = 'list-group-item d-flex align-items-center';
    
    const handle = document.createElement('span');
    handle.className = 'match-handle me-2';
    handle.textContent = '≡';
    handle.setAttribute('data-queue-index', String(qi));
    handle.draggable = true;
    handle.ondragstart = matchHandleDragStart;
    handle.ondragover = matchHandleDragOver;
    handle.ondrop = matchHandleDrop;
    li.appendChild(handle);
    
    const label = document.createElement('div');
    label.className = 'flex-fill';
    label.innerHTML = `${renderPlayerSpan(t1[0], 'queue:' + qi + ':0:0')} - ${renderPlayerSpan(t1[1], 'queue:' + qi + ':0:1')} &nbsp;&nbsp; vs &nbsp;&nbsp; ${renderPlayerSpan(t2[0], 'queue:' + qi + ':1:0')} - ${renderPlayerSpan(t2[1], 'queue:' + qi + ':1:1')}`;
    li.appendChild(label);
    
    li.ondragover = matchHandleDragOver;
    li.ondrop = matchHandleDrop;
    queueList.appendChild(li);
  }
}

function renderIdle() {
  const idleBox = document.getElementById('idlePlayers');
  idleBox.innerHTML = '';
  
  const ul = document.createElement('ul');
  ul.className = 'list-group';
  
  sortIdlePlayersByIndex();

  idle_players.forEach((p, idx) => {
    ensureIdleIndex(p);
    const li = document.createElement('li');
    li.className = 'list-group-item';
    li.innerHTML = `${renderPlayerSpan(p, 'idle:' + idx)} <span class="badge bg-secondary ms-2">Idle ${p.idleIndex}</span>`;
    ul.appendChild(li);
  });
  
  idleBox.appendChild(ul);
}

function formatHistoryRatingUpdates(entry) {
  const updates = Array.isArray(entry?.ratingUpdates) ? entry.ratingUpdates : [];
  if (!updates.length) return '';
  return updates
    .map(update => `${update.name} ${formatSignedRating(update.delta)}${update.beforeLevel !== update.afterLevel ? ` (L${update.beforeLevel}->L${update.afterLevel})` : ''}${update.mvpBonus ? ' MVP' : ''}`)
    .join(', ');
}

function renderHistory() {
  const hb = document.getElementById('adminHistoryBox');
  if (!hb) return;
  hb.innerHTML = '';
  
  match_history.slice().reverse().forEach(m => {
    const d = document.createElement('div');
    if (m.note) {
      d.textContent = m.note;
    } else {
      const t1 = m.team1.join(' - ');
      const t2 = m.team2.join(' - ');
      const scoreStr = m.score ? `${m.score[0]}-${m.score[1]}` : '';
      const winStr = m.winnerTeam ? (m.winnerTeam === 1 ? '(T1 win)' : '(T2 win)') : '';
      const ratingSummary = formatHistoryRatingUpdates(m);
      d.textContent = `${t1} ${scoreStr} vs ${t2} ${winStr}${ratingSummary ? `\nR: ${ratingSummary}` : ''}`;
    }
    hb.appendChild(d);
  });
}

function render() {
  for (let i = 0; i < COURTS; i++) renderCourt(i);
  renderQueue();
  renderIdle();
  renderHistory();
  populateWishLists();
}

function setWishPreferSelection(prefer = null) {
  wishPreferSelection = ['chill', 'normal', 'challenge'].includes(prefer) ? prefer : null;

  const mappings = [
    { id: 'wishChill', activeClass: 'wish-selected-chill', value: 'chill' },
    { id: 'wishNormal', activeClass: 'wish-selected-normal', value: 'normal' },
    { id: 'wishChallenge', activeClass: 'wish-selected-challenge', value: 'challenge' }
  ];

  mappings.forEach(({ id, activeClass, value }) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.classList.remove('wish-selected-chill', 'wish-selected-normal', 'wish-selected-challenge');
    if (value === wishPreferSelection) btn.classList.add(activeClass);
  });
}

function toggleWishPreferSelection(prefer) {
  if (!['chill', 'normal', 'challenge'].includes(prefer)) {
    setWishPreferSelection(null);
    return;
  }
  setWishPreferSelection(wishPreferSelection === prefer ? null : prefer);
}

function populateWishPartnerOptions(selectedPlayerIndex = null, preservedPartnerValue = '') {
  const partnerSel = document.getElementById('wishPartnerSelect');
  if (!partnerSel) return;

  partnerSel.innerHTML = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = selectedPlayerIndex === null ? 'Chọn Partner' : 'Chọn tên Partner';
  placeholder.disabled = true;
  placeholder.selected = true;
  partnerSel.appendChild(placeholder);

  players.forEach((p, idx) => {
    if (selectedPlayerIndex !== null && idx === selectedPlayerIndex) return;
    const option = document.createElement('option');
    option.value = String(idx);
    option.textContent = p.name;
    partnerSel.appendChild(option);
  });

  if (preservedPartnerValue && Array.from(partnerSel.options).some(option => option.value === preservedPartnerValue)) {
    partnerSel.value = preservedPartnerValue;
  }
}

function populateWishLists() {
  const sel = document.getElementById('wishPlayerSelect');
  if (!sel) return;
  const partnerSel = document.getElementById('wishPartnerSelect');
  const preservedPlayerValue = sel.value;
  const preservedPartnerValue = partnerSel ? partnerSel.value : '';
  
  sel.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = 'Chọn Tên Bạn';
  ph.disabled = true;
  ph.selected = true;
  sel.appendChild(ph);
  
  players.forEach((p, idx) => {
    const o = document.createElement('option');
    o.value = String(idx);
    o.textContent = p.name;
    sel.appendChild(o);
  });

  if (preservedPlayerValue && Array.from(sel.options).some(option => option.value === preservedPlayerValue)) {
    sel.value = preservedPlayerValue;
  }

  const selectedPlayerIndex = sel.value === '' ? null : parseInt(sel.value, 10);
  const selectedPlayer = Number.isInteger(selectedPlayerIndex) ? players[selectedPlayerIndex] : null;
  setWishPreferSelection(selectedPlayer?.prefer || null);
  populateWishPartnerOptions(Number.isInteger(selectedPlayerIndex) ? selectedPlayerIndex : null, preservedPartnerValue);
}

// ============== DRAG & DROP ==============

function onPlayerDragStart(e) {
  const loc = e.target.getAttribute('data-loc');
  if (!loc) return;
  e.dataTransfer.setData('text/plain', loc);
}

function onPlayerDragOver(e) {
  e.preventDefault();
}

function onPlayerDrop(e) {
  e.preventDefault();
  const src = e.dataTransfer.getData('text/plain');
  const dst = e.target.getAttribute('data-loc');
  if (!src || !dst) return;
  try { performSwap(src, dst); } catch (err) { console.error('drop swap failed', err); }
}

function matchHandleDragStart(e) {
  const el = e.currentTarget || e.target;
  const q = el.getAttribute('data-queue-index');
  const c = el.getAttribute('data-court-index');
  if (q !== null && q !== undefined) e.dataTransfer.setData('text/plain', 'match:queue:' + q);
  else if (c !== null && c !== undefined) e.dataTransfer.setData('text/plain', 'match:court:' + c);
  e.dataTransfer.effectAllowed = 'move';
}

function matchHandleDragOver(e) {
  e.preventDefault();
  try { e.dataTransfer.dropEffect = 'move'; } catch (ex) {}
}

function matchHandleDrop(e) {
  e.preventDefault();
  const data = e.dataTransfer.getData('text/plain') || '';
  if (!data.startsWith('match:')) return;
  
  const parts = data.split(':');
  if (parts.length < 3) return;
  const srcType = parts[1];
  const srcIdx = parseInt(parts[2], 10);
  
  let tgt = e.currentTarget || e.target;
  let dstQueue = null, dstCourt = null;
  
  while (tgt) {
    if (tgt.getAttribute) {
      if (tgt.getAttribute('data-queue-index')) { dstQueue = parseInt(tgt.getAttribute('data-queue-index'), 10); break; }
      if (tgt.getAttribute('data-court-index')) { dstCourt = parseInt(tgt.getAttribute('data-court-index'), 10); break; }
    }
    tgt = tgt.parentElement;
  }
  
  try {
    if (srcType === 'queue' && dstQueue !== null) {
      const a = queue_matches[srcIdx], b = queue_matches[dstQueue];
      if (!a || !b) return;
      queue_matches[srcIdx] = b;
      queue_matches[dstQueue] = a;
      saveState(); renderQueue(); render();
      return;
    }
    if (srcType === 'queue' && dstCourt !== null) {
      const qmatch = queue_matches[srcIdx];
      if (!qmatch) return;
      const replaced = active_matches[dstCourt];
      if (replaced) queue_matches[srcIdx] = replaced;
      else queue_matches.splice(srcIdx, 1);
      active_matches[dstCourt] = qmatch;
      saveState(); updateIdlePlayers(); render(); renderAdminPlayers();
      return;
    }
    if (srcType === 'court' && dstQueue !== null) {
      const cmatch = active_matches[srcIdx];
      if (!cmatch) return;
      const replaced = queue_matches[dstQueue];
      active_matches[srcIdx] = replaced || null;
      queue_matches[dstQueue] = cmatch;
      saveState(); updateIdlePlayers(); render(); renderAdminPlayers();
      return;
    }
    if (srcType === 'court' && dstCourt !== null) {
      const a = active_matches[srcIdx], b = active_matches[dstCourt];
      active_matches[srcIdx] = b;
      active_matches[dstCourt] = a;
      saveState(); updateIdlePlayers(); render(); renderAdminPlayers();
      return;
    }
  } catch (err) { console.error('matchHandleDrop failed', err); }
}

function getPlayerAtLoc(loc) {
  const parts = loc.split(':');
  if (parts[0] === 'court') {
    if (parts[2] === 'empty') return null;
    const ci = parseInt(parts[1], 10), team = parseInt(parts[2], 10), pos = parseInt(parts[3], 10);
    return active_matches[ci]?.[team]?.[pos] || null;
  }
  if (parts[0] === 'queue') {
    const qi = parseInt(parts[1], 10), team = parseInt(parts[2], 10), pos = parseInt(parts[3], 10);
    return queue_matches[qi]?.[team]?.[pos] || null;
  }
  if (parts[0] === 'idle') {
    return idle_players[parseInt(parts[1], 10)] || null;
  }
  return null;
}

function setPlayerAtLoc(loc, player) {
  const parts = loc.split(':');
  if (parts[0] === 'court') {
    if (parts[2] === 'empty') return;
    const ci = parseInt(parts[1], 10), team = parseInt(parts[2], 10), pos = parseInt(parts[3], 10);
    if (!active_matches[ci]) active_matches[ci] = [[null, null], [null, null]];
    active_matches[ci][team][pos] = player;
  } else if (parts[0] === 'queue') {
    const qi = parseInt(parts[1], 10), team = parseInt(parts[2], 10), pos = parseInt(parts[3], 10);
    if (queue_matches[qi]) queue_matches[qi][team][pos] = player;
  } else if (parts[0] === 'idle') {
    const ii = parseInt(parts[1], 10);
    if (ii >= 0 && ii < idle_players.length) idle_players[ii] = player;
    else if (player) idle_players.push(player);
  }
}

function removePlayerFromLocation(loc) {
  const parts = loc.split(':');
  if (parts[0] === 'court') {
    if (parts[2] === 'empty') return null;
    const ci = parseInt(parts[1], 10), team = parseInt(parts[2], 10), pos = parseInt(parts[3], 10);
    if (!active_matches[ci]) return null;
    const p = active_matches[ci][team][pos];
    active_matches[ci][team][pos] = null;
    return p;
  }
  if (parts[0] === 'queue') {
    const qi = parseInt(parts[1], 10), team = parseInt(parts[2], 10), pos = parseInt(parts[3], 10);
    if (!queue_matches[qi]) return null;
    const p = queue_matches[qi][team][pos];
    queue_matches[qi][team][pos] = null;
    return p;
  }
  if (parts[0] === 'idle') {
    const ii = parseInt(parts[1], 10);
    if (ii < 0 || ii >= idle_players.length) return null;
    return idle_players.splice(ii, 1)[0];
  }
  return null;
}

function performSwap(srcLoc, dstLoc) {
  if (srcLoc === dstLoc) return;
  
  const srcPlayer = getPlayerAtLoc(srcLoc);
  const dstPlayer = getPlayerAtLoc(dstLoc);
  logLine(`dragSwap:start src=${srcLoc} srcPlayer=${formatPlayer(srcPlayer)} dst=${dstLoc} dstPlayer=${formatPlayer(dstPlayer)}`);

  const selectedFromIdle = [];
  if (srcLoc.startsWith('idle:') && isMatchLocation(dstLoc) && srcPlayer) selectedFromIdle.push(srcPlayer);
  if (dstLoc.startsWith('idle:') && isMatchLocation(srcLoc) && dstPlayer) selectedFromIdle.push(dstPlayer);
  if (selectedFromIdle.length) applyIdleIndexOnAssignment(selectedFromIdle);

  let returningToIdlePlayer = null;
  if (isMatchLocation(srcLoc) && dstLoc.startsWith('idle:') && srcPlayer) returningToIdlePlayer = srcPlayer;
  if (isMatchLocation(dstLoc) && srcLoc.startsWith('idle:') && dstPlayer) returningToIdlePlayer = dstPlayer;
  if (returningToIdlePlayer) {
    returningToIdlePlayer.idleIndex = getTopIdleSeedIndex(selectedFromIdle);
    logLine(`idleIndex:returnToIdle priority name=${returningToIdlePlayer.name} idleIndex=${returningToIdlePlayer.idleIndex}`);
  }
  
  removePlayerFromLocation(srcLoc);
  removePlayerFromLocation(dstLoc);
  
  if (dstPlayer) setPlayerAtLoc(srcLoc, dstPlayer);
  if (srcPlayer) setPlayerAtLoc(dstLoc, srcPlayer);
  
  // Cleanup invalid matches
  queue_matches = queue_matches.filter(m => m && m.flat().every(p => p));
  while (active_matches.length < COURTS) active_matches.push(null);
  rebalanceExistingMatches();
  
  logLine(`dragSwap:done src=${srcLoc} dst=${dstLoc} state=${JSON.stringify(getStateSnapshot())}`);
  saveState();
  updateIdlePlayers();
  render();
  renderAdminPlayers();
}

// ============== SCORE & RESULTS ==============

function openScoreModal(courtIdx) {
  document.getElementById('modalCourtIdx').value = courtIdx;
  const match = active_matches[courtIdx];
  const modalT1 = document.getElementById('modalTeam1');
  const modalT2 = document.getElementById('modalTeam2');
  
  if (modalT1 && modalT2 && match) {
    const t1 = match[0].map(p => p ? p.name : '').join(' - ');
    const t2 = match[1].map(p => p ? p.name : '').join(' - ');
    modalT1.textContent = `Team 1: ${t1}`;
    modalT2.textContent = `Team 2: ${t2}`;
  }
  
  const modal = new bootstrap.Modal(document.getElementById('scoreModal'));
  modal.show();
}

function applyResult(courtIdx, scoreStr) {
  const match = active_matches[courtIdx];
  if (!match) return;
  
  const [t1, t2] = match;
  let winners, losers;
  
  if (scoreStr === 'T1') { winners = t1; losers = t2; }
  else if (scoreStr === 'T2') { winners = t2; losers = t1; }
  else {
    const pick = confirm('Mark team1 as winner? OK=team1, Cancel=team2');
    if (pick) { winners = t1; losers = t2; }
    else { winners = t2; losers = t1; }
  }

  logLine(`applyResult:start court=${courtIdx} scoreInput=${scoreStr} match=${formatMatch(match)} winners=${winners.map(formatPlayer).join(', ')} losers=${losers.map(formatPlayer).join(', ')}`);
  
  // Update player stats
  [...t1, ...t2].forEach(p => { p.matches++; });
  const ratingUpdates = applyRatingUpdatesForMatch(winners, losers);
  ratingUpdates.forEach(update => {
    logLine(`rating:update player=${update.name} won=${update.won} before=${update.beforeRating} delta=${formatSignedRating(update.delta)} after=${update.afterRating} base=${update.base} teamDiff=${formatSignedRating(update.teamDiff)} mvp=${formatSignedRating(update.mvpBonus)} level=${update.beforeLevel}->${update.afterLevel}`);
  });
  
  // Record history
  const hist = {
    ts: new Date().toISOString(),
    team1Ids: [getPlayerRef(t1[0]), getPlayerRef(t1[1])],
    team2Ids: [getPlayerRef(t2[0]), getPlayerRef(t2[1])],
    team1: [t1[0].name, t1[1].name],
    team2: [t2[0].name, t2[1].name],
    winnerTeam: winners === t1 ? 1 : 2,
    ratingUpdates
  };
  match_history.push(hist);
  markPlayersLastPlayed(match);
  clearSatisfiedPartnerFlags(match);
  try{ localStorage.setItem('badminton_history', JSON.stringify(match_history)); }catch(e){}
  logLine(`applyResult: court=${courtIdx} winner=${hist.winnerTeam} match=${JSON.stringify(hist)}`);
  
  // Free players back to idle
  const freePlayers = [...t1, ...t2];
  logLine(`applyResult:freePlayers court=${courtIdx} players=${freePlayers.map(formatPlayer).join(', ')}`);
  freePlayers.forEach(p => {
    const existing = idle_players.find(x => samePlayer(x, p));
    if (existing) {
      existing.idleIndex = 0;
    } else {
      p.idleIndex = 0;
      idle_players.push(p);
    }
  });
  
  // Move next queue match to court
  if (isCourtEnabled(courtIdx) && queue_matches.length > 0) {
    active_matches[courtIdx] = queue_matches.shift();
    logLine(`applyResult:promoteQueue court=${courtIdx} promoted=${formatMatch(active_matches[courtIdx])}`);
  } else {
    active_matches[courtIdx] = null;
    logLine(`applyResult:clearCourt court=${courtIdx} reason=${isCourtEnabled(courtIdx) ? 'no_queue_match' : 'court_disabled'}`);
  }
  
  // Keep creating matches from idle while possible, to fill all empty courts first
  let buildCount = 0;
  while (idle_players.length >= 4) {
    const newMatch = createNewMatch();
    if (!newMatch) {
      logLine(`applyResult:stopCreate reason=no_valid_match idleCount=${idle_players.length}`);
      break;
    }

    buildCount += 1;
    logLine(`applyResult:newMatch#${buildCount} match=${formatMatch(newMatch)}`);

    applyIdleIndexOnAssignment(newMatch.flat());

    // Remove selected players from idle
    newMatch.flat().forEach(p => {
      const idx = idle_players.findIndex(x => samePlayer(x, p));
      if (idx !== -1) idle_players.splice(idx, 1);
    });

    // Add to queue or fill empty court
    const emptyCourtIdx = getFirstAvailableEnabledCourtIndex();
    if (emptyCourtIdx !== -1) {
      active_matches[emptyCourtIdx] = newMatch;
      logLine(`applyResult:assignCourt court=${emptyCourtIdx} match=${formatMatch(newMatch)}`);
    } else {
      queue_matches.push(newMatch);
      logLine(`applyResult:pushQueue index=${queue_matches.length - 1} match=${formatMatch(newMatch)}`);
    }
  }

  rebalanceExistingMatches();
  logLine(`applyResult:end court=${courtIdx} createdMatches=${buildCount} state=${JSON.stringify(getStateSnapshot())}`);
  
  saveState();
  render();
  renderAdminPlayers();
}

function createNewMatch() {
  if (idle_players.length < 4) return null;

  const ranked = idle_players.slice().sort((a, b) => {
    const diff = idleIndexOf(b) - idleIndexOf(a);
    if (diff !== 0) return diff;
    return (a.name || '').localeCompare(b.name || '');
  });
  const emptyCourts = countEmptyCourts();
  const policySequence = emptyCourts >= 2
    ? ['strict2', 'strict1', 'skipRule3', 'skipRule2And3']
    : ['strict2'];
  const poolSizes = getPoolExpansionSizes(Math.max(0, ranked.length - 1));
  const initialSeedCandidates = ranked.slice(0, Math.min(MAX_SEED_ATTEMPTS, ranked.length));
  logLine(`createNewMatch:start idleCount=${idle_players.length} seeds=${initialSeedCandidates.map(formatPlayer).join(', ')} emptyCourts=${emptyCourts} policies=${policySequence.join('>')} poolSizes=${poolSizes.join('>')}`);

  let challengeFallback = null;

  for (const policyKey of policySequence) {
    for (const poolSize of poolSizes) {
      const reservePlan = getChallengeReservePlan(ranked, policyKey, poolSize);
      if (reservePlan && !challengeFallback) {
        challengeFallback = { policyKey, poolSize, reservePlan };
      }

      const candidatePool = reservePlan
        ? ranked.filter(player => !reservePlan.reserveNames.has(getPlayerRef(player)))
        : ranked;
      const seedCandidates = candidatePool.slice(0, Math.min(MAX_SEED_ATTEMPTS, candidatePool.length));

      for (let seedIdx = 0; seedIdx < seedCandidates.length; seedIdx++) {
        const result = selectBestMatchFromPlayers(candidatePool, {
          logContext: 'createNewMatch',
          policyKey,
          seed: seedCandidates[seedIdx],
          poolLimit: poolSize,
          verbose: false
        });
        if (!result || !result.match) continue;

        if (policyKey !== 'strict2') logLine(`createNewMatch:fallbackApplied policy=${policyKey} emptyCourts=${emptyCourts}`);
        if (poolSize > MATCH_SELECTION_POOL_SIZE) logLine(`createNewMatch:poolExpanded seed=${formatPlayer(result.seed)} poolLimit=${result.poolLimit}`);
        if (seedIdx > 0) logLine(`createNewMatch:alternateSeed seed=${formatPlayer(result.seed)} rankIndex=${seedIdx}`);
        if (reservePlan) logLine(`createNewMatch:challengeHeld challenge=${formatPlayer(reservePlan.challenge)} rankIndex=${reservePlan.rankIndex} reserved=${Array.from(reservePlan.reserveNames).join(', ')}`);
        logLine(`createNewMatch:selected match=${formatMatch(result.match)}`);
        return result.match;
      }
    }
  }

  if (challengeFallback && challengeFallback.reservePlan?.result?.match) {
    const { policyKey, poolSize, reservePlan } = challengeFallback;
    if (policyKey !== 'strict2') logLine(`createNewMatch:fallbackApplied policy=${policyKey} emptyCourts=${emptyCourts}`);
    if (poolSize > MATCH_SELECTION_POOL_SIZE) logLine(`createNewMatch:poolExpanded seed=${formatPlayer(reservePlan.result.seed)} poolLimit=${reservePlan.result.poolLimit}`);
    logLine(`createNewMatch:challengeFallback challenge=${formatPlayer(reservePlan.challenge)} rankIndex=${reservePlan.rankIndex}`);
    logLine(`createNewMatch:selected match=${formatMatch(reservePlan.result.match)}`);
    return reservePlan.result.match;
  }

  logLine('createNewMatch:noMatchFound');
  return null;
}

function getMatchPolicySequence() {
  const emptyCourts = countEmptyCourts();
  return emptyCourts >= 2
    ? ['strict2', 'strict1', 'skipRule3', 'skipRule2And3']
    : ['strict2'];
}

function rankIdleCandidates(candidates) {
  return (candidates || []).slice().sort((a, b) => {
    const diff = idleIndexOf(b) - idleIndexOf(a);
    if (diff !== 0) return diff;
    return (a.name || '').localeCompare(b.name || '');
  });
}

function buildCurrentStateSnapshot() {
  return {
    active: (active_matches || []).map(cloneMatch),
    queue: (queue_matches || []).map(cloneMatch),
    idle: (idle_players || []).slice()
  };
}

function findIdleReplacementForQueueMatch(queueIndex, removedPlayer) {
  const queueMatch = queue_matches?.[queueIndex];
  if (!queueMatch) return null;

  const remainingPlayers = queueMatch.flat().filter(player => player && !samePlayer(player, removedPlayer));
  if (remainingPlayers.length !== 3) return null;

  const rankedIdle = rankIdleCandidates(
    (idle_players || []).filter(candidate =>
      candidate &&
      candidate.ready &&
      !remainingPlayers.some(player => samePlayer(player, candidate))
    )
  );
  if (!rankedIdle.length) return null;

  const policySequence = getMatchPolicySequence();
  const maps = buildHistoricalMaps();
  let bestReplacement = null;

  for (const policyKey of policySequence) {
    for (const candidate of rankedIdle) {
      const group = [...remainingPlayers, candidate];
      const match = findBestMatch(group, '', policyKey);
      if (!match) continue;

      const analysis = analyzeMatch(match, maps, policyKey);
      if (!analysis.valid) continue;

      const state = buildCurrentStateSnapshot();
      state.queue[queueIndex] = cloneMatch(match);
      state.idle = state.idle.filter(player => !samePlayer(player, candidate));
      const stateCost = evaluateState(state);
      if (!Number.isFinite(stateCost)) continue;

      const replacement = { candidate, match, policyKey, analysis, stateCost };
      if (!bestReplacement) {
        bestReplacement = replacement;
        continue;
      }

      const idleDiff = idleIndexOf(candidate) - idleIndexOf(bestReplacement.candidate);
      if (idleDiff > 0) {
        bestReplacement = replacement;
        continue;
      }
      if (idleDiff < 0) continue;

      if (stateCost < bestReplacement.stateCost) {
        bestReplacement = replacement;
        continue;
      }
      if (stateCost > bestReplacement.stateCost) continue;

      const levelDiff = Number.isFinite(analysis.levelDiff) ? analysis.levelDiff : Infinity;
      const bestLevelDiff = Number.isFinite(bestReplacement.analysis.levelDiff) ? bestReplacement.analysis.levelDiff : Infinity;
      if (levelDiff < bestLevelDiff) {
        bestReplacement = replacement;
        continue;
      }
      if (levelDiff > bestLevelDiff) continue;

      const score = Number.isFinite(analysis.score) ? analysis.score : Infinity;
      const bestScore = Number.isFinite(bestReplacement.analysis.score) ? bestReplacement.analysis.score : Infinity;
      if (score < bestScore) {
        bestReplacement = replacement;
      }
    }

    if (bestReplacement) return bestReplacement;
  }

  return null;
}

function handleQueuedPlayerMarkedNotReady(player) {
  if (!player) return false;

  const placement = getPlayerPlacementInState({ active: active_matches, queue: queue_matches }, player);
  if (!placement || placement.bucket !== 'queue') return false;

  updateIdlePlayers();

  const queueMatch = queue_matches[placement.index];
  if (!queueMatch) return false;

  const replacement = findIdleReplacementForQueueMatch(placement.index, player);
  if (replacement?.match) {
    applyIdleIndexOnAssignment([replacement.candidate]);
    queue_matches[placement.index] = replacement.match;
    logLine(`toggleReady:queueReplace removed=${formatPlayer(player)} replacement=${formatPlayer(replacement.candidate)} queueIndex=${placement.index} policy=${replacement.policyKey} match=${formatMatch(replacement.match)}`);
  } else {
    queue_matches.splice(placement.index, 1);
    logLine(`toggleReady:queueRemove removed=${formatPlayer(player)} queueIndex=${placement.index} reason=no_idle_replacement match=${formatMatch(queueMatch)}`);
  }

  rebalanceExistingMatches();
  fillMatchesFromIdle('toggleReady:notReadyQueue');
  return true;
}

function serializeMatchByName(match) {
  if (!match || !match[0] || !match[1]) return null;
  return match.map(team => team.map(player => getPlayerRef(player)));
}

function deserializeMatchByName(snapshot, byName) {
  if (!Array.isArray(snapshot) || snapshot.length !== 2) return null;
  const restored = snapshot.map(team => {
    if (!Array.isArray(team) || team.length !== 2) return null;
    return team.map(ref => {
      if (!ref) return null;
      const player = byName.get(ref.id || ref) || byName.get(ref) || findPlayerByRef(ref);
      return player && player.ready ? player : null;
    });
  });

  if (restored.some(team => !team || team.length !== 2 || team.some(player => !player))) return null;
  return restored;
}

function saveLayoutState() {
  const snapshot = {
    active_matches: (active_matches || []).map(serializeMatchByName),
    queue_matches: (queue_matches || []).map(serializeMatchByName)
  };
  localStorage.setItem('badminton_layout', JSON.stringify(snapshot));
}

function loadLayoutState() {
  const raw = localStorage.getItem('badminton_layout');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('failed to parse layout', e);
    return null;
  }
}

function restoreLatestArrangement() {
  const snapshot = loadLayoutState();
  const byName = new Map();
  const { byId } = buildPlayerLookups(players);
  (players || []).forEach(player => {
    byName.set(player.name, player);
    byName.set(player.id, player);
  });

  active_matches = [];
  queue_matches = [];

  if (snapshot) {
    const restoredActive = Array.isArray(snapshot.active_matches)
      ? snapshot.active_matches.map(match => deserializeMatchByName(match, byName))
      : [];
    const restoredQueue = Array.isArray(snapshot.queue_matches)
      ? snapshot.queue_matches.map(match => deserializeMatchByName(match, byName)).filter(Boolean)
      : [];

    active_matches = restoredActive.slice(0, COURTS);
    queue_matches = restoredQueue;
  }

  while (active_matches.length < COURTS) active_matches.push(null);
  relocateDisabledCourtMatches('restoreLatest');
  promoteQueueMatchesToEnabledCourts('restoreLatest:promoteQueue');
  updateIdlePlayers();
}

function fillMatchesFromIdle(logPrefix) {
  let buildCount = 0;

  promoteQueueMatchesToEnabledCourts(`${logPrefix || 'fillMatches'}:promoteQueue`);

  while (idle_players.length >= 4) {
    const newMatch = createNewMatch();
    if (!newMatch) break;

    buildCount += 1;
    applyIdleIndexOnAssignment(newMatch.flat());

    newMatch.flat().forEach(p => {
      const idx = idle_players.findIndex(x => samePlayer(x, p));
      if (idx !== -1) idle_players.splice(idx, 1);
    });

    const emptyCourtIdx = getFirstAvailableEnabledCourtIndex();
    if (emptyCourtIdx !== -1) active_matches[emptyCourtIdx] = newMatch;
    else queue_matches.push(newMatch);
  }

  rebalanceExistingMatches();
  updateIdlePlayers();
  if (logPrefix) logLine(`${logPrefix}: builtMatches=${buildCount} state=${JSON.stringify(getStateSnapshot())}`);
  return buildCount;
}

function continueFromLatest() {
  restoreLatestArrangement();
  fillMatchesFromIdle('continueLatest');
}

// ============== INITIALIZATION & STATE ==============

function initialize() {
  active_matches = [];
  queue_matches = [];
  while (active_matches.length < COURTS) active_matches.push(null);
  ensureCourtEnabledStates();

  (players || []).forEach(player => {
    if (player?.ready) player.idleIndex = 0;
  });

  updateIdlePlayers();
  fillMatchesFromIdle('initialize');
}

function updateIdlePlayers() {
  const assigned = new Set();
  active_matches.forEach(m => { if (m) m.flat().forEach(p => { if (p) assigned.add(getPlayerRef(p)); }); });
  queue_matches.forEach(m => { if (m) m.flat().forEach(p => { if (p) assigned.add(getPlayerRef(p)); }); });
  idle_players = players.filter(p => p.ready && !assigned.has(getPlayerRef(p)));
  idle_players.forEach(ensureIdleIndex);
  sortIdlePlayersByIndex();
  logLine(`idle:update assigned=${JSON.stringify(Array.from(assigned))} idle=${JSON.stringify(idle_players.map(p => ({ name: p.name, level: p.level, idleIndex: p.idleIndex })))}`);
}

function saveState() {
  finalizePlayerRecords(players);
  match_history = finalizeHistoryEntries(match_history, players);
  players.forEach(normalizePlayerPrefer);
  localStorage.setItem('badminton_players', JSON.stringify(players));
  localStorage.setItem('badminton_history', JSON.stringify(match_history));
  localStorage.setItem('badminton_settings', JSON.stringify({ autoSyncLevelsFromRating, courtEnabledStates }));
  saveLayoutState();
}

function loadState() {
  const p = localStorage.getItem('badminton_players');
  if (p) {
    try {
      const parsed = JSON.parse(p);
      players = parsed.map(normalizePlayerRecord);
      finalizePlayerRecords(players);
    } catch (e) { console.error('failed to parse players', e); }
  }

  const h = localStorage.getItem('badminton_history');
  if (h) {
    try { match_history = JSON.parse(h); }
    catch (e) { console.error('failed to parse history', e); }
  }

  const settings = localStorage.getItem('badminton_settings');
  if (settings) {
    try {
      const parsed = JSON.parse(settings);
      autoSyncLevelsFromRating = parsed.autoSyncLevelsFromRating !== undefined ? !!parsed.autoSyncLevelsFromRating : true;
      courtEnabledStates = Array.isArray(parsed.courtEnabledStates) ? parsed.courtEnabledStates : courtEnabledStates;
      ensureCourtEnabledStates();
    } catch (e) { console.error('failed to parse settings', e); }
  }
  match_history = finalizeHistoryEntries(match_history, players);
  // load debug log too
  loadLog();
}

// ============== ADMIN PANEL ==============

function renderAdminPlayers() {
  const box = document.getElementById('adminPlayerList');
  if (!box) return;
  box.innerHTML = '';

  const preferOrder = ['chill', 'normal', 'challenge'];
  let draggedPlayerIndex = null;

  players.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = 'd-flex justify-content-between align-items-center mb-0';

    const readyBtnClass = p.ready ? 'btn-ready' : 'btn-notready';
    const readySymbol = p.ready ? 'V' : 'X';
    const genderLabel = p.gender === 'female' ? 'Female' : 'Male';
    const pref = getEffectivePrefer(p);
    const prefClass = pref === 'chill' ? 'prefer-chill' : (pref === 'challenge' ? 'prefer-challenge' : 'prefer-normal');
    const prefLabel = pref.charAt(0).toUpperCase() + pref.slice(1);
    const accumulatedRating = getPlayerAccumulatedRating(p);
    const levelTitle = `Rating ${Math.round(getPlayerRating(p))} (${formatSignedRating(accumulatedRating)} from L${p.level} base)`;
    const ratingSummary = `R${Math.round(getPlayerRating(p))} | ${formatSignedRating(accumulatedRating)}`;
    const partnerSelectHtml = buildSelectOptions(getPartnerSlotOptions(), p.partnerSlot || '');
    const coupleSelectHtml = buildSelectOptions(getCoupleOptions(), p.couple || '');
    const unpairSelectHtml = buildSelectOptions(getUnpairOptions(), getUnpairSelectValue(p));

    row.innerHTML = `
      <div class="admin-row admin-row--draggable" draggable="true" data-player-index="${idx}">
        <div class="admin-left"><span class="drag-handle" aria-hidden="true">::</span><div class="admin-player-copy"><strong class="admin-player-name">${p.name}</strong><div class="admin-player-meta">${ratingSummary}</div></div></div>
        <div class="admin-actions">
          <div class="admin-edit">
            <button draggable="false" class="btn btn-sm btn-outline-secondary" data-idx="${idx}" data-action="edit">Edit</button>
          </div>
          <div class="admin-right">
            <button draggable="false" class="btn btn-sm gender-btn ${p.gender === 'female' ? 'btn-female' : 'btn-male'}" data-idx="${idx}" data-action="toggleGender">${genderLabel}</button>
            <input draggable="false" class="form-control form-control-sm admin-level-input" type="number" min="1" max="10" value="${p.level}" data-idx="${idx}" data-action="setLevel" title="${levelTitle}" aria-label="Level for ${p.name}">
            <button draggable="false" class="btn btn-sm btn-rating-reset" data-idx="${idx}" data-action="resetAccumulated" title="Reset accumulated rating for ${p.name}">RP</button>
            <button draggable="false" class="btn btn-sm ${readyBtnClass}" data-idx="${idx}" data-action="toggleReady">${readySymbol}</button>
            <button draggable="false" class="btn btn-sm ${prefClass} ms-1 prefer-btn" data-idx="${idx}" data-action="togglePrefer">${prefLabel}</button>
            <select draggable="false" class="form-select form-select-sm admin-flag-select admin-partner-select ms-2" data-idx="${idx}" data-action="setPartner" aria-label="Partner for ${p.name}">${partnerSelectHtml}</select>
            <select draggable="false" class="form-select form-select-sm admin-flag-select admin-couple-select ms-2" data-idx="${idx}" data-action="setCouple" aria-label="Couple for ${p.name}">${coupleSelectHtml}</select>
            <select draggable="false" class="form-select form-select-sm admin-flag-select admin-unpair-select ms-2" data-idx="${idx}" data-action="setUnpair" aria-label="Unpair for ${p.name}">${unpairSelectHtml}</select>
            <button draggable="false" class="btn btn-sm uniform-btn btn-delete ms-2" data-idx="${idx}" data-action="delete">Del</button>
          </div>
        </div>
      </div>`;
    box.appendChild(row);
  });

  box.querySelectorAll('.admin-row[data-player-index]').forEach(row => {
    row.addEventListener('dragstart', event => {
      draggedPlayerIndex = parseInt(row.getAttribute('data-player-index'), 10);
      row.classList.add('admin-row--dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(draggedPlayerIndex));
      }
    });

    row.addEventListener('dragend', () => {
      draggedPlayerIndex = null;
      box.querySelectorAll('.admin-row--dragging, .admin-row--dragover').forEach(el => {
        el.classList.remove('admin-row--dragging', 'admin-row--dragover');
      });
    });

    row.addEventListener('dragover', event => {
      event.preventDefault();
      if (draggedPlayerIndex === null) return;
      row.classList.add('admin-row--dragover');
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    });

    row.addEventListener('dragleave', () => {
      row.classList.remove('admin-row--dragover');
    });

    row.addEventListener('drop', event => {
      event.preventDefault();
      row.classList.remove('admin-row--dragover');

      const targetIndex = parseInt(row.getAttribute('data-player-index'), 10);
      const sourceIndex = draggedPlayerIndex;
      if (!Number.isInteger(sourceIndex) || !Number.isInteger(targetIndex) || sourceIndex === targetIndex) return;

      const [movedPlayer] = players.splice(sourceIndex, 1);
      if (!movedPlayer) return;
      players.splice(targetIndex, 0, movedPlayer);

      saveState();
      render();
      renderAdminPlayers();
    });
  });

  box.querySelectorAll('[data-action]').forEach(control => {
    const action = control.getAttribute('data-action');

    if (action === 'setLevel') {
      control.onchange = () => {
        const idx = parseInt(control.getAttribute('data-idx'));
        const player = players[idx];
        if (!player) return;

        const previousLevel = Number.isFinite(Number(player.level)) ? Number(player.level) : 1;
        const parsedLevel = parseInt(control.value, 10);
        const nextLevel = clampNumber(Number.isFinite(parsedLevel) ? parsedLevel : previousLevel, RATING_CONFIG.minLevel, RATING_CONFIG.maxLevel);
        control.value = String(nextLevel);
        if (nextLevel === previousLevel) return;

        const previousAccumulated = getPlayerAccumulatedRating(player);
        const message = `Change ${player.name} from L${previousLevel} to L${nextLevel}?\nCurrent accumulated rating: ${formatSignedRating(previousAccumulated)}\n\nOK = keep accumulated rating on the new level.\nCancel = revert.`;
        if (!confirm(message)) {
          control.value = String(previousLevel);
          return;
        }

        setPlayerLevelWithAccumulatedRating(player, nextLevel);
        normalizePlayerPrefer(player);
        saveState(); render(); renderAdminPlayers();
      };
      return;
    }

    if (action === 'setPartner' || action === 'setCouple' || action === 'setUnpair') {
      control.onchange = () => {
        const idx = parseInt(control.getAttribute('data-idx'));
        const player = players[idx];
        if (!player) return;
        const value = control.value;

        if (action === 'setPartner') {
          setPlayerPartnerSlot(player, value);
        } else if (action === 'setCouple') {
          setPlayerCoupleValue(player, value);
        } else if (action === 'setUnpair') {
          setPlayerUnpairValue(player, value);
        }

        saveState(); render(); renderAdminPlayers();
      };
      return;
    }

    control.onclick = () => {
      const idx = parseInt(control.getAttribute('data-idx'));
      const action = control.getAttribute('data-action');

      if (action === 'toggleReady') {
        const player = players[idx];
        player.ready = !player.ready;
        if (!player.ready) handleQueuedPlayerMarkedNotReady(player);
        updateIdlePlayers();
        saveState(); render(); renderAdminPlayers();
      } else if (action === 'toggleGender') {
        players[idx].gender = players[idx].gender === 'male' ? 'female' : 'male';
        saveState(); render(); renderAdminPlayers();
      } else if (action === 'resetAccumulated') {
        const player = players[idx];
        const accumulated = getPlayerAccumulatedRating(player);
        if (!accumulated) return;
        const message = `Reset accumulated rating for ${player.name}?\nCurrent accumulated rating: ${formatSignedRating(accumulated)}\n\nThis keeps level L${player.level} and resets rating to ${levelBaseRating(player.level)}.`;
        if (!confirm(message)) return;
        resetPlayerAccumulatedRating(player);
        saveState(); render(); renderAdminPlayers();
      } else if (action === 'togglePrefer') {
        const current = getEffectivePrefer(players[idx]);
        const currentIndex = preferOrder.indexOf(current);
        players[idx].prefer = preferOrder[(currentIndex + 1 + preferOrder.length) % preferOrder.length];
        normalizePlayerPrefer(players[idx]);
        saveState(); render(); renderAdminPlayers();
      } else if (action === 'delete') {
        if (confirm('Delete player ' + players[idx].name + '?')) {
          players.splice(idx, 1);
          saveState(); updateIdlePlayers(); render(); renderAdminPlayers();
        }
      } else if (action === 'edit') {
        const newName = prompt('Edit name for ' + players[idx].name, players[idx].name);
        if (newName && newName.trim()) {
          const player = players[idx];
          const nextName = newName.trim();
          if (!player || nextName === player.name) return;
          player.name = nextName;
          refreshHistoryNamesForPlayer(player);
          saveState(); updateIdlePlayers(); render(); renderAdminPlayers();
        }
      }
    };
  });
}

// ============== EXPORT/IMPORT ==============

function buildExportPlayerSnapshot(player) {
  normalizePlayerPrefer(player);
  return {
    id: ensurePlayerId(player),
    name: player.name,
    level: player.level || 4,
    gender: player.gender || 'male',
    prefer: getEffectivePrefer(player),
    rating: player.rating !== undefined ? player.rating : ((player.level || 4) * 100),
    matches: player.matches || 0,
    ready: player.ready === undefined ? true : player.ready,
    idleIndex: Number.isFinite(Number(player.idleIndex)) ? Math.max(0, Math.floor(Number(player.idleIndex))) : 0,
    couple: player.couple === undefined ? null : player.couple,
    unpair: player.unpair === undefined ? null : player.unpair,
    unpairMain: player.unpairMain === undefined ? false : !!player.unpairMain,
    partnerSlot: player.partnerSlot === undefined ? null : player.partnerSlot,
    recentTeammates: normalizeRecentHistory(player.recentTeammates),
    recentOpponents: normalizeRecentHistory(player.recentOpponents)
  };
}

function stringifyExportPlayers(playersToExport) {
  const lines = ['{', '  "players": ['];
  playersToExport.forEach((player, idx) => {
    const suffix = idx < playersToExport.length - 1 ? ',' : '';
    lines.push(`    ${JSON.stringify(player)}${suffix}`);
  });
  lines.push('  ]');
  lines.push('}');
  return lines.join('\n');
}

function exportJSON() {
  const exportedPlayers = players.map(buildExportPlayerSnapshot);
  const blob = new Blob([stringifyExportPlayers(exportedPlayers)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'badminton_player_list.json';
  a.click();
  URL.revokeObjectURL(url);
}

function formatExportTimestamp(ts) {
  try {
    const d = ts ? new Date(ts) : new Date();
    // Convert moment to UTC+7 by adding 7 hours to the timestamp
    const tzOffsetHours = 7;
    const target = new Date(d.getTime() + tzOffsetHours * 3600000);
    const dd = String(target.getUTCDate()).padStart(2, '0');
    const mm = String(target.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = target.getUTCFullYear();
    const hh = String(target.getUTCHours()).padStart(2, '0');
    const min = String(target.getUTCMinutes()).padStart(2, '0');
    return `${dd}-${mm}-${yyyy} ${hh}:${min}`;
  } catch (e) {
    return ts || '';
  }
}

function importJSON(text) {
  try {
    const state = JSON.parse(text);
    if (state.players) {
      players = state.players.map(normalizePlayerRecord);
      finalizePlayerRecords(players);
    }
    const byRef = ref => findPlayerByRef(ref, players);
    
    if (state.active_matches) {
      active_matches = state.active_matches.map(m => {
        if (!m) return null;
        return [[byRef(m[0][0]), byRef(m[0][1])], [byRef(m[1][0]), byRef(m[1][1])]];
      });
      while (active_matches.length < COURTS) active_matches.push(null);
    }
    
    if (state.queue_matches) {
      queue_matches = state.queue_matches.map(m => {
        if (!m) return null;
        return [[byRef(m[0][0]), byRef(m[0][1])], [byRef(m[1][0]), byRef(m[1][1])]];
      }).filter(x => x);
    }
    
    if (state.idle_players) {
      idle_players = state.idle_players.map(ref => byRef(ref)).filter(x => x);
    }
    
    if (state.match_history) match_history = finalizeHistoryEntries(state.match_history, players);
    
    saveState();
    updateIdlePlayers();
    render();
    renderAdminPlayers();
    alert('Import successful');
  } catch (e) { alert('Import failed: ' + e.message); }
}

function resetAll() {
  if (!confirm('Reset local data?')) return;
  localStorage.clear();
  location.reload();
}

function downloadHistory() {
  const historyForExport = finalizeHistoryEntries(match_history, players);
  const exportEntries = historyForExport.map(m => {
    const ts = formatExportTimestamp(m && m.ts);
    if (m && m.note) {
      return {
        prefix: `[${ts}] ${m.note}`,
        ratingSummary: ''
      };
    }
    const t1 = (m && m.team1) ? m.team1.join(' + ') : '';
    const t2 = (m && m.team2) ? m.team2.join(' + ') : '';
    const winStr = m && m.winnerTeam ? (m.winnerTeam === 1 ? '(T1 win)' : '(T2 win)') : '';
    const ratingSummary = formatHistoryRatingUpdates(m);
    return {
      prefix: `[${ts}] ${t1} vs ${t2} ${winStr}`.trimEnd(),
      ratingSummary
    };
  });
  const ratingColumnWidth = exportEntries.reduce((maxWidth, entry) => {
    if (!entry?.ratingSummary) return maxWidth;
    return Math.max(maxWidth, (entry.prefix || '').length);
  }, 0);
  const lines = exportEntries.map(entry => {
    if (!entry?.ratingSummary) return entry?.prefix || '';
    return `${(entry.prefix || '').padEnd(ratingColumnWidth, ' ')} | R: ${entry.ratingSummary}`;
  });

  // --- Build mini-report ---
  const reportLines = [];
  reportLines.push('');
  reportLines.push('--- BÁO CÁO TÓM TẮT ---');
  reportLines.push(`Total set: ${historyForExport.length}`);

  // Group history into non-overlapping groups of 3 (in chronological order)
  const sorted = historyForExport.slice().filter(m => m && m.ts).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const groups = [];
  for (let i = 0; i < sorted.length; i += 3) {
    groups.push(sorted.slice(i, i + 3));
  }

  // Compute intervals (minutes) between group starts
  const groupStarts = groups.map(g => (g && g[0] && g[0].ts) ? new Date(g[0].ts) : null).filter(Boolean);
  const intervals = [];
  for (let i = 1; i < groupStarts.length; i++) {
    const deltaMin = Math.round((groupStarts[i] - groupStarts[i - 1]) / 60000);
    intervals.push(deltaMin);
  }
  const avgInterval = intervals.length ? Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length) : 0;
  reportLines.push(`Trung bình mỗi set = ${avgInterval} phút`);

  // Detail per-group intervals
  const maxGroupIndexWidth = String(groups.length).length;
  const intervalLabels = intervals.map((_, i) => {
    const leftIndex = String(i + 1).padStart(maxGroupIndexWidth, ' ');
    const rightIndex = String(i + 2).padStart(maxGroupIndexWidth, ' ');
    return `Nhóm ${leftIndex} -> Nhóm ${rightIndex}:`;
  });
  const maxIntervalLabelWidth = intervalLabels.reduce((maxWidth, label) => Math.max(maxWidth, label.length), 0);
  const maxIntervalValueWidth = intervals.reduce((maxWidth, value) => Math.max(maxWidth, String(value).length), 0);
  for (let i = 0; i < intervals.length; i++) {
    const g1 = groups[i];
    const g2 = groups[i + 1];
    const t1 = g1 && g1[0] && g1[0].ts ? formatExportTimestamp(g1[0].ts) : 'n/a';
    const t2 = g2 && g2[0] && g2[0].ts ? formatExportTimestamp(g2[0].ts) : 'n/a';
    const labelText = intervalLabels[i].padEnd(maxIntervalLabelWidth, ' ');
    const intervalText = String(intervals[i]).padStart(maxIntervalValueWidth, ' ');
    reportLines.push(`${labelText} ${intervalText} phút (${t1} -> ${t2})`);
  }

  // Player statistics
  const levelMap = new Map((players || []).map(p => [getPlayerRef(p), p.level || 0]));
  const stats = new Map();
  for (const m of historyForExport || []) {
    if (!m || !m.team1 || !m.team2) continue;
    const teams = [getHistoryTeamRefs(m, 'team1'), getHistoryTeamRefs(m, 'team2')];
    for (let ti = 0; ti < 2; ti++) {
      const team = teams[ti];
      const opp = teams[1 - ti];
      for (const ref of team) {
        if (!ref) continue;
        if (!stats.has(ref)) stats.set(ref, { sets: 0, teammates: {}, opponents: {}, ge: 0, lt: 0 });
        const s = stats.get(ref);
        s.sets++;
        team.filter(other => other && other !== ref).forEach(other => {
          const teammateName = getPlayerNameByRef(other);
          s.teammates[teammateName] = (s.teammates[teammateName] || 0) + 1;
        });
        opp.filter(other => other).forEach(other => {
          const opponentName = getPlayerNameByRef(other);
          s.opponents[opponentName] = (s.opponents[opponentName] || 0) + 1;
        });
        const lvl = levelMap.get(ref);
        if (lvl !== undefined) {
          const oppAvg = opp.reduce((acc, other) => acc + (levelMap.get(other) || 0), 0) / opp.length;
          if (lvl >= Math.floor(oppAvg)) s.ge++; else s.lt++;
        }
      }
    }
  }

  reportLines.push('');
  reportLines.push('Player set:');
  const playerStatEntries = Array.from(stats.entries()).map(([ref, s]) => {
    const name = getPlayerNameByRef(ref, ref);
    const teammateCounts = Object.values(s.teammates);
    const opponentCounts = Object.values(s.opponents);
    return {
      name,
      sets: s.sets,
      repeatedTeammates: teammateCounts.reduce((sum, count) => sum + Math.max(0, count - 1), 0),
      uniqueTeammates: teammateCounts.length,
      repeatedOpponents: opponentCounts.reduce((sum, count) => sum + Math.max(0, count - 1), 0),
      uniqueOpponents: opponentCounts.length,
      ge: s.ge,
      lt: s.lt
    };
  });
  const maxPlayerNameWidth = playerStatEntries.reduce((maxWidth, entry) => Math.max(maxWidth, entry.name.length), 0);
  const maxSetWidth = playerStatEntries.reduce((maxWidth, entry) => Math.max(maxWidth, String(entry.sets).length), 0);
  const maxRepeatedTeammatesWidth = playerStatEntries.reduce((maxWidth, entry) => Math.max(maxWidth, String(entry.repeatedTeammates).length), 0);
  const maxUniqueTeammatesWidth = playerStatEntries.reduce((maxWidth, entry) => Math.max(maxWidth, String(entry.uniqueTeammates).length), 0);
  const maxRepeatedOpponentsWidth = playerStatEntries.reduce((maxWidth, entry) => Math.max(maxWidth, String(entry.repeatedOpponents).length), 0);
  const maxUniqueOpponentsWidth = playerStatEntries.reduce((maxWidth, entry) => Math.max(maxWidth, String(entry.uniqueOpponents).length), 0);
  const maxGeWidth = playerStatEntries.reduce((maxWidth, entry) => Math.max(maxWidth, String(entry.ge).length), 0);
  const maxLtWidth = playerStatEntries.reduce((maxWidth, entry) => Math.max(maxWidth, String(entry.lt).length), 0);
  for (const [ref, s] of stats) {
    const name = getPlayerNameByRef(ref, ref);
    const teammateCounts = Object.values(s.teammates);
    const opponentCounts = Object.values(s.opponents);
    const uniqueTeammates = teammateCounts.length;
    const uniqueOpponents = opponentCounts.length;
    const repeatedTeammates = teammateCounts.reduce((sum, count) => sum + Math.max(0, count - 1), 0);
    const repeatedOpponents = opponentCounts.reduce((sum, count) => sum + Math.max(0, count - 1), 0);
    const nameText = name.padEnd(maxPlayerNameWidth, ' ');
    const setText = String(s.sets).padStart(maxSetWidth, ' ');
    const repeatedTeammatesText = String(repeatedTeammates).padStart(maxRepeatedTeammatesWidth, ' ');
    const uniqueTeammatesText = String(uniqueTeammates).padStart(maxUniqueTeammatesWidth, ' ');
    const repeatedOpponentsText = String(repeatedOpponents).padStart(maxRepeatedOpponentsWidth, ' ');
    const uniqueOpponentsText = String(uniqueOpponents).padStart(maxUniqueOpponentsWidth, ' ');
    const geText = String(s.ge).padStart(maxGeWidth, ' ');
    const ltText = String(s.lt).padStart(maxLtWidth, ' ');
    reportLines.push(`${nameText}: ${setText} set, đồng đội = {lặp lại = ${repeatedTeammatesText}, khác nhau = ${uniqueTeammatesText}}, đối thủ = {lặp lại = ${repeatedOpponentsText}, khác nhau = ${uniqueOpponentsText}}, số trận ngang lv trở lên = ${geText}, số trận dưới lv = ${ltText}`);
  }

  reportLines.push('');
  reportLines.push('Rating/Elo:');
  const ratingSummaryPlayers = (players || []).slice().sort((a, b) => {
    const ratingDiff = Math.round(getPlayerRating(b)) - Math.round(getPlayerRating(a));
    if (ratingDiff !== 0) return ratingDiff;
    return (a.name || '').localeCompare(b.name || '');
  });
  const maxRatingNameLength = ratingSummaryPlayers.reduce((maxLength, player) => {
    return Math.max(maxLength, (player?.name || '').length);
  }, 0);
  const maxRatingWidth = ratingSummaryPlayers.reduce((maxWidth, player) => {
    return Math.max(maxWidth, String(Math.round(getPlayerRating(player))).length);
  }, 0);
  const maxLevelWidth = ratingSummaryPlayers.reduce((maxWidth, player) => {
    return Math.max(maxWidth, String(player?.level ?? '').length);
  }, 0);
  const maxAccumulatedWidth = ratingSummaryPlayers.reduce((maxWidth, player) => {
    return Math.max(maxWidth, formatSignedRating(getPlayerAccumulatedRating(player)).length);
  }, 0);
  ratingSummaryPlayers.forEach(player => {
    const nameText = (player.name || '').padEnd(maxRatingNameLength, ' ');
    const ratingText = String(Math.round(getPlayerRating(player))).padStart(maxRatingWidth, ' ');
    const levelText = String(player.level).padStart(maxLevelWidth, ' ');
    const accumulatedText = formatSignedRating(getPlayerAccumulatedRating(player)).padStart(maxAccumulatedWidth, ' ');
    reportLines.push(`${nameText}: R=${ratingText}, L=${levelText}, tích lũy=${accumulatedText}`);
  });

  const dividerWidth = Math.max(
    80,
    ...[...lines, ...reportLines]
      .filter(line => typeof line === 'string' && line.length > 0)
      .map(line => line.length)
  );
  const sectionDivider = '-'.repeat(dividerWidth);
  const sectionTitles = new Set(['--- BÁO CÁO TÓM TẮT ---', 'Player set:', 'Rating/Elo:']);
  const formattedReportLines = [];

  reportLines.forEach(line => {
    if (line === '') {
      if (formattedReportLines[formattedReportLines.length - 1] !== '') formattedReportLines.push('');
      return;
    }

    if (sectionTitles.has(line)) {
      if (formattedReportLines[formattedReportLines.length - 1] !== '') formattedReportLines.push('');
      formattedReportLines.push(sectionDivider);
      formattedReportLines.push('');
    }

    formattedReportLines.push(line);
  });

  const blob = new Blob([lines.join('\n') + '\n\n' + formattedReportLines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'match_history.txt';
  a.click();
  URL.revokeObjectURL(url);
}

function clearHistory() {
  if (!confirm('Clear match history?')) return;
  match_history = [];
  localStorage.removeItem('badminton_history');
  saveState();
  renderHistory();
}

// ============== INIT ==============

// Load persisted state then players, then initialize UI
function startApp() {
  loadState();
  active_matches = [];
  queue_matches = [];
  while (active_matches.length < COURTS) active_matches.push(null);
  updateIdlePlayers();
  render();
  renderLevelSyncControl();
  renderAdminPlayers();
}

startApp();

function hideBuildModeModal() {
  const modalEl = document.getElementById('buildModeModal');
  if (!modalEl) return;
  const modal = bootstrap.Modal.getInstance(modalEl);
  if (modal) modal.hide();
}

// UI bindings for result modal
const modalTeam1Btn = document.getElementById('modalTeam1');
const modalTeam2Btn = document.getElementById('modalTeam2');
if (modalTeam1Btn) {
  modalTeam1Btn.onclick = () => {
    const idx = parseInt(document.getElementById('modalCourtIdx').value);
    const modalEl = document.getElementById('scoreModal');
    const modal = bootstrap.Modal.getInstance(modalEl);
    applyResult(idx, 'T1');
    if (modal) modal.hide();
  };
}
if (modalTeam2Btn) {
  modalTeam2Btn.onclick = () => {
    const idx = parseInt(document.getElementById('modalCourtIdx').value);
    const modalEl = document.getElementById('scoreModal');
    const modal = bootstrap.Modal.getInstance(modalEl);
    applyResult(idx, 'T2');
    if (modal) modal.hide();
  };
}

// Log controls (if UI elements exist)
if(document.getElementById('downloadLog')) document.getElementById('downloadLog').onclick = downloadLog;
if(document.getElementById('clearLog')) document.getElementById('clearLog').onclick = clearLog;

// Button bindings
if (document.getElementById('resetData')) document.getElementById('resetData').onclick = resetAll;
if (document.getElementById('exportJson')) document.getElementById('exportJson').onclick = exportJSON;
if (document.getElementById('importJson')) {
  document.getElementById('importJson').onclick = () => document.getElementById('importJsonFile').click();
}
if (document.getElementById('importJsonFile')) {
  document.getElementById('importJsonFile').onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => importJSON(reader.result);
    reader.readAsText(f);
  };
}
if (document.getElementById('wishPlayerSelect')) {
  document.getElementById('wishPlayerSelect').onchange = (e) => {
    const value = e.target.value;
    const selectedPlayerIndex = value === '' ? null : parseInt(value, 10);
    const selectedPlayer = Number.isInteger(selectedPlayerIndex) ? players[selectedPlayerIndex] : null;
    setWishPreferSelection(getEffectivePrefer(selectedPlayer));
    populateWishPartnerOptions(Number.isInteger(selectedPlayerIndex) ? selectedPlayerIndex : null);
  };
}
if (document.getElementById('wishChill')) document.getElementById('wishChill').onclick = () => toggleWishPreferSelection('chill');
if (document.getElementById('wishNormal')) document.getElementById('wishNormal').onclick = () => toggleWishPreferSelection('normal');
if (document.getElementById('wishChallenge')) document.getElementById('wishChallenge').onclick = () => toggleWishPreferSelection('challenge');
if (document.getElementById('wishSetPrefer')) {
  document.getElementById('wishSetPrefer').onclick = () => {
    const playerSel = document.getElementById('wishPlayerSelect');
    if (!playerSel) return;

    const playerIndex = parseInt(playerSel.value, 10);
    if (!Number.isInteger(playerIndex) || !players[playerIndex]) {
      alert('Chọn player trước');
      return;
    }

    if (!wishPreferSelection) {
      alert('Chọn prefer trước');
      return;
    }

    players[playerIndex].prefer = wishPreferSelection;
    normalizePlayerPrefer(players[playerIndex]);
    saveState();
    render();
    renderAdminPlayers();

    playerSel.value = String(playerIndex);
    setWishPreferSelection(null);
  };
}
if (document.getElementById('wishSetPartner')) {
  document.getElementById('wishSetPartner').onclick = () => {
    const playerSel = document.getElementById('wishPlayerSelect');
    const partnerSel = document.getElementById('wishPartnerSelect');
    if (!playerSel || !partnerSel) return;

    const playerIndex = parseInt(playerSel.value, 10);
    const partnerIndex = parseInt(partnerSel.value, 10);
    if (!Number.isInteger(playerIndex)) return alert('Chọn player trước');
    if (!Number.isInteger(partnerIndex)) return alert('Chọn partner trước');

    if (!assignWishPartner(playerIndex, partnerIndex)) {
      alert('Không thể set partner cho cặp này');
      return;
    }

    saveState();
    render();
    renderAdminPlayers();

    playerSel.value = String(playerIndex);
    populateWishPartnerOptions(playerIndex, '');
  };
}
if (document.getElementById('buildNewMatches')) {
  document.getElementById('buildNewMatches').onclick = () => {
    initialize();
    saveState();
    render();
    renderAdminPlayers();
    hideBuildModeModal();
    try {
      const displayEl = document.getElementById('display-tab');
      if (displayEl) {
        const t = new bootstrap.Tab(displayEl);
        t.show();
      }
    } catch (e) { console.error('failed to switch tab', e); }
  };
}
if (document.getElementById('buildContinueLatest')) {
  document.getElementById('buildContinueLatest').onclick = () => {
    continueFromLatest();
    saveState();
    render();
    renderAdminPlayers();
    hideBuildModeModal();
    try {
      const displayEl = document.getElementById('display-tab');
      if (displayEl) {
        const t = new bootstrap.Tab(displayEl);
        t.show();
      }
    } catch (e) { console.error('failed to switch tab', e); }
  };
}
if (document.getElementById('rebuildMatches')) {
  const btn = document.getElementById('rebuildMatches');
  try { btn.textContent = 'Build Matches'; } catch (e) {}
  btn.onclick = () => {
    const modalEl = document.getElementById('buildModeModal');
    if (!modalEl) {
      initialize();
      saveState();
      render();
      renderAdminPlayers();
      return;
    }
    const modal = new bootstrap.Modal(modalEl);
    modal.show();
  };
}
if (document.getElementById('toggleLevelSync')) {
  document.getElementById('toggleLevelSync').onclick = () => {
    const nextState = !autoSyncLevelsFromRating;
    setAutoSyncLevelsFromRating(nextState, { save: false, syncAll: nextState });
    saveState();
    render();
    renderAdminPlayers();
  };
}
if (document.getElementById('downloadHistory')) document.getElementById('downloadHistory').onclick = downloadHistory;
if (document.getElementById('clearHistory')) document.getElementById('clearHistory').onclick = clearHistory;

// Add player form
function handleAddPlayer(event) {
  if (event) event.preventDefault();

  const nameInput = document.getElementById('pName');
  const levelInput = document.getElementById('pLevel');
  const genderInput = document.getElementById('pGender');
  const preferInput = document.getElementById('pPrefer');
  if (!nameInput || !levelInput || !genderInput || !preferInput) return;

  const name = nameInput.value.trim();
  if (!name) return alert('Name required');

  const parsedLevel = parseInt(levelInput.value, 10);
  const level = Number.isFinite(parsedLevel) ? parsedLevel : 4;
  const gender = genderInput.value || 'male';
  const prefer = preferInput.value || 'normal';

  const player = normalizePlayerRecord({
    name,
    level,
    gender,
    prefer,
    rating: levelBaseRating(level),
    matches: 0,
    ready: true,
    idleIndex: 0,
    couple: null,
    unpair: null,
    unpairMain: false,
    partnerSlot: null,
    recentTeammates: [],
    recentOpponents: []
  });
  normalizePlayerPrefer(player);
  players.push(player);

  nameInput.value = '';
  levelInput.value = '';
  genderInput.value = 'male';
  preferInput.value = 'normal';

  saveState();
  updateIdlePlayers();
  render();
  renderAdminPlayers();
}

if (document.getElementById('playerFormTop')) {
  document.getElementById('playerFormTop').addEventListener('submit', handleAddPlayer);
}
if (document.getElementById('savePlayer')) {
  document.getElementById('savePlayer').onclick = handleAddPlayer;
}
if (document.getElementById('savePlayerTop')) {
  document.getElementById('savePlayerTop').onclick = handleAddPlayer;
}
