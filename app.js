// Badminton Matchmaking - Rule-based Algorithm (5 Rules)
// Rules:
// 1. Match type: MM-MM, MF-MF, or FF-FF only
// 2. No repeat teammate from each player's 2 most recent played matches
// 3. No repeat opponent from each player's 2 most recent played matches
// 4. Idle Index priority: prioritize players waiting longer in Idle
// 5. Equal Level Team: after selecting 4 players, swap pairings inside that group to make team levels as close as possible

let COURTS = 3;
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
      players = data.map(p => ({
        name: p.name,
        level: p.level || 4,
        gender: p.gender || 'male',
        prefer: p.prefer || 'normal',
        rating: p.rating !== undefined ? p.rating : ((p.level || 4) * 100),
        matches: p.matches || 0,
        ready: p.ready === undefined ? true : p.ready,
        idleIndex: Number.isFinite(Number(p.idleIndex)) ? Math.max(0, Math.floor(Number(p.idleIndex))) : 0,
        couple: p.couple === undefined ? null : p.couple,
        unpair: p.unpair === undefined ? (p.uncouple === undefined ? null : p.uncouple) : p.unpair,
        partnerSlot: p.partnerSlot === undefined ? null : p.partnerSlot,
        recentTeammates: normalizeRecentHistory(p.recentTeammates),
        recentOpponents: normalizeRecentHistory(p.recentOpponents)
      }));
      players.forEach(normalizePlayerPrefer);
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
const MAX_COUPLE = 5;
const MATCH_SELECTION_POOL_SIZE = 8;
const MAX_CANDIDATE_GROUPS = 18;
const MAX_SEED_ATTEMPTS = 2;
const CHALLENGE_RESERVE_WINDOW = 4;

// ============== CORE UTILITIES ==============

function pairKey(a, b) {
  const n1 = (a && a.name) ? a.name : a;
  const n2 = (b && b.name) ? b.name : b;
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
    idle: (idle_players || []).map(formatPlayer)
  };
}

function levelDiffForMatch(match) {
  if (!match || !match[0] || !match[1]) return Infinity;
  return Math.abs(team_level(match[0]) - team_level(match[1]));
}

function hasEqualLevelTeams(match) {
  return levelDiffForMatch(match) < 2;
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
  const selectedNames = new Set((selectedPlayers || []).filter(p => p && p.name).map(p => p.name));
  if (!selectedNames.size) return;
  (idle_players || []).forEach(p => {
    ensureIdleIndex(p);
    if (selectedNames.has(p.name)) p.idleIndex = 0;
    else p.idleIndex += 1;
  });
  sortIdlePlayersByIndex();
  logLine(`idleIndex:update selected=${JSON.stringify(Array.from(selectedNames))} idleOrder=${JSON.stringify(idle_players.map(p => ({ name: p.name, idleIndex: p.idleIndex })))}`);
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
        getRecentNamesWithinDepth(p1, 'recentTeammates', policy.teammateDepth).includes(p2.name) ||
        getRecentNamesWithinDepth(p2, 'recentTeammates', policy.teammateDepth).includes(p1.name)
      ) {
        return `recent_teammate:${pairKey(p1, p2)}`;
      }
    }
  }

  if (policy.opponentDepth > 0) {
    const opponentPairs = [[a, c], [a, d], [b, c], [b, d]];
    for (const [p1, p2] of opponentPairs) {
      if (
        getRecentNamesWithinDepth(p1, 'recentOpponents', policy.opponentDepth).includes(p2.name) ||
        getRecentNamesWithinDepth(p2, 'recentOpponents', policy.opponentDepth).includes(p1.name)
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
    pushRecentRound(team1[0], 'recentTeammates', team1[1] ? [team1[1].name] : []);
    pushRecentRound(team1[0], 'recentOpponents', team2.filter(Boolean).map(player => player.name));
  }
  if (team1?.[1]) {
    pushRecentRound(team1[1], 'recentTeammates', team1[0] ? [team1[0].name] : []);
    pushRecentRound(team1[1], 'recentOpponents', team2.filter(Boolean).map(player => player.name));
  }
  if (team2?.[0]) {
    pushRecentRound(team2[0], 'recentTeammates', team2[1] ? [team2[1].name] : []);
    pushRecentRound(team2[0], 'recentOpponents', team1.filter(Boolean).map(player => player.name));
  }
  if (team2?.[1]) {
    pushRecentRound(team2[1], 'recentTeammates', team2[0] ? [team2[0].name] : []);
    pushRecentRound(team2[1], 'recentOpponents', team1.filter(Boolean).map(player => player.name));
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
  const excludedNames = new Set((excludedPlayers || []).filter(Boolean).map(player => player.name));
  const usedSlots = new Set(
    (players || [])
      .filter(player => player && player.partnerSlot && !excludedNames.has(player.name))
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
  if (!player || !partner || player.name === partner.name) return false;

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

function getPlayerTeamIndex(match, player) {
  if (!match || !player) return -1;
  const playerName = typeof player === 'string' ? player : player.name;
  for (let teamIdx = 0; teamIdx < 2; teamIdx++) {
    if ((match[teamIdx] || []).some(p => p && p.name === playerName)) return teamIdx;
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
  const playerName = typeof player === 'string' ? player : player.name;

  for (let idx = 0; idx < (state.active || []).length; idx++) {
    const match = state.active[idx];
    const teamIndex = getPlayerTeamIndex(match, playerName);
    if (teamIndex !== -1) return { bucket: 'active', index: idx, teamIndex };
  }

  for (let idx = 0; idx < (state.queue || []).length; idx++) {
    const match = state.queue[idx];
    const teamIndex = getPlayerTeamIndex(match, playerName);
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
      if (playersShareFlag(flat[i], flat[j], 'unpair') && areTeammates(match, flat[i], flat[j])) {
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
  const groupNames = new Set((group || []).filter(Boolean).map(player => player.name));

  for (const player of (group || [])) {
    const coupleId = playerFlagValue(player, 'couple');
    if (coupleId === null) continue;
    const availablePartners = (candidatePlayers || []).filter(other => other && other.name !== player.name && playersShareFlag(player, other, 'couple'));
    if (availablePartners.some(other => !groupNames.has(other.name))) return false;
  }

  return true;
}

function countFemales(group) {
  return (group || []).filter(player => player && player.gender === 'female').length;
}

function countEmptyCourts() {
  return (active_matches || []).filter(match => !match).length;
}

function scoreCandidateForSeed(seed, candidate) {
  if (!seed || !candidate) return -Infinity;

  let score = idleIndexOf(candidate) * 100;
  score -= Math.abs((seed.level || 0) - (candidate.level || 0)) * 8;

  if (playersShareFlag(seed, candidate, 'couple')) score += 220;
  if (playersShareFlag(seed, candidate, 'partnerSlot')) score += 120;
  if (playersShareFlag(seed, candidate, 'unpair')) score -= 30;

  const candidateRecentTeam = getRecentNames(candidate, 'recentTeammates');
  const candidateRecentOpp = getRecentNames(candidate, 'recentOpponents');
  const seedRecentTeam = getRecentNames(seed, 'recentTeammates');
  const seedRecentOpp = getRecentNames(seed, 'recentOpponents');

  if (!playersShareFlag(seed, candidate, 'couple') && (seedRecentTeam.includes(candidate.name) || candidateRecentTeam.includes(seed.name))) score -= 25;
  if (seedRecentOpp.includes(candidate.name) || candidateRecentOpp.includes(seed.name)) score -= 15;

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
      reserveNames: new Set(result.match.flat().filter(Boolean).map(player => player.name))
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
    const [t1a, t1b] = h.team1;
    const [t2a, t2b] = h.team2;
    
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
  let html = '';
  
  if (active_matches[i] && isCompleteMatch(active_matches[i])) {
    const [t1, t2] = active_matches[i];
    html = `<div class="card">
      <div class="card-header position-relative">
        <div class="w-100 text-center fs-5 fw-bold">Sân ${10 + i}</div>
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
        <div class="fs-5 fw-bold">Sân ${10 + i}</div>
        <button class="btn btn-sm uniform-btn" data-clear-manual="${i}">Clear Manual</button>
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
      <div class="card-header position-relative">
        <div class="w-100 text-center fs-5 fw-bold">Sân ${10 + i}</div>
      </div>
      <div class="card-body">
        <div class="empty-slot" data-loc="court:${i}:empty" ondragover="onPlayerDragOver(event)" ondrop="onPlayerDrop(event)">
          <button class="btn btn-sm uniform-btn" data-manual-court="${i}">Manual Match</button>
        </div>
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
          if (!idle_players.some(idle => idle.name === player.name)) idle_players.push(player);
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
      d.textContent = `${t1} ${scoreStr} vs ${t2} ${winStr}`;
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
  
  // Record history
  const hist = {
    ts: new Date().toISOString(),
    team1: [t1[0].name, t1[1].name],
    team2: [t2[0].name, t2[1].name],
    winnerTeam: winners === t1 ? 1 : 2
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
    const existing = idle_players.find(x => x.name === p.name);
    if (existing) {
      existing.idleIndex = 0;
    } else {
      p.idleIndex = 0;
      idle_players.push(p);
    }
  });
  
  // Move next queue match to court
  if (queue_matches.length > 0) {
    active_matches[courtIdx] = queue_matches.shift();
    logLine(`applyResult:promoteQueue court=${courtIdx} promoted=${formatMatch(active_matches[courtIdx])}`);
  } else {
    active_matches[courtIdx] = null;
    logLine(`applyResult:clearCourt court=${courtIdx} reason=no_queue_match`);
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
      const idx = idle_players.findIndex(x => x.name === p.name);
      if (idx !== -1) idle_players.splice(idx, 1);
    });

    // Add to queue or fill empty court
    const emptyCourtIdx = active_matches.findIndex(m => !m);
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
        ? ranked.filter(player => !reservePlan.reserveNames.has(player.name))
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

function serializeMatchByName(match) {
  if (!match || !match[0] || !match[1]) return null;
  return match.map(team => team.map(player => player?.name || null));
}

function deserializeMatchByName(snapshot, byName) {
  if (!Array.isArray(snapshot) || snapshot.length !== 2) return null;
  const restored = snapshot.map(team => {
    if (!Array.isArray(team) || team.length !== 2) return null;
    return team.map(name => {
      if (!name) return null;
      const player = byName.get(name);
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
  const byName = new Map((players || []).map(player => [player.name, player]));

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
  updateIdlePlayers();
}

function fillMatchesFromIdle(logPrefix) {
  let buildCount = 0;

  while (idle_players.length >= 4) {
    const newMatch = createNewMatch();
    if (!newMatch) break;

    buildCount += 1;
    applyIdleIndexOnAssignment(newMatch.flat());

    newMatch.flat().forEach(p => {
      const idx = idle_players.findIndex(x => x.name === p.name);
      if (idx !== -1) idle_players.splice(idx, 1);
    });

    const emptyCourtIdx = active_matches.findIndex(m => !m);
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

  (players || []).forEach(player => {
    if (player?.ready) player.idleIndex = 0;
  });

  updateIdlePlayers();
  fillMatchesFromIdle('initialize');
}

function updateIdlePlayers() {
  const assigned = new Set();
  active_matches.forEach(m => { if (m) m.flat().forEach(p => { if (p) assigned.add(p.name); }); });
  queue_matches.forEach(m => { if (m) m.flat().forEach(p => { if (p) assigned.add(p.name); }); });
  idle_players = players.filter(p => p.ready && !assigned.has(p.name));
  idle_players.forEach(ensureIdleIndex);
  sortIdlePlayersByIndex();
  logLine(`idle:update assigned=${JSON.stringify(Array.from(assigned))} idle=${JSON.stringify(idle_players.map(p => ({ name: p.name, level: p.level, idleIndex: p.idleIndex })))}`);
}

function saveState() {
  players.forEach(normalizePlayerPrefer);
  localStorage.setItem('badminton_players', JSON.stringify(players));
  localStorage.setItem('badminton_history', JSON.stringify(match_history));
  saveLayoutState();
}

function loadState() {
  const p = localStorage.getItem('badminton_players');
  if (p) {
    try {
      const parsed = JSON.parse(p);
      players = parsed.map(p0 => ({
        name: p0.name,
        level: p0.level || 4,
        gender: p0.gender || 'male',
        prefer: p0.prefer || 'normal',
        rating: p0.rating !== undefined ? p0.rating : ((p0.level || 4) * 100),
        matches: p0.matches || 0,
        ready: p0.ready === undefined ? true : p0.ready,
        idleIndex: Number.isFinite(Number(p0.idleIndex)) ? Math.max(0, Math.floor(Number(p0.idleIndex))) : 0,
        couple: p0.couple === undefined ? null : p0.couple,
        unpair: p0.unpair === undefined ? (p0.uncouple === undefined ? null : p0.uncouple) : p0.unpair,
        partnerSlot: p0.partnerSlot === undefined ? null : p0.partnerSlot,
        recentTeammates: normalizeRecentHistory(p0.recentTeammates),
        recentOpponents: normalizeRecentHistory(p0.recentOpponents)
      }));
      players.forEach(normalizePlayerPrefer);
    } catch (e) { console.error('failed to parse players', e); }
  }

  const h = localStorage.getItem('badminton_history');
  if (h) {
    try { match_history = JSON.parse(h); }
    catch (e) { console.error('failed to parse history', e); }
  }
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
    const partnerLabel = p.partnerSlot || 'No Partner';
    const coupleLabel = p.couple ? ('C' + p.couple) : 'Single';
    const coupleClass = p.couple ? 'btn-info text-white' : 'btn-single';
    const unpairLabel = p.unpair ? ('No' + p.unpair) : 'Normal';

    row.innerHTML = `
      <div class="admin-row admin-row--draggable" draggable="true" data-player-index="${idx}">
        <div class="admin-left"><span class="drag-handle" aria-hidden="true">::</span><strong class="admin-player-name">${p.name}</strong></div>
        <div class="admin-actions">
          <div class="admin-edit">
            <button draggable="false" class="btn btn-sm btn-outline-secondary" data-idx="${idx}" data-action="edit">Edit</button>
          </div>
          <div class="admin-right">
            <button draggable="false" class="btn btn-sm gender-btn ${p.gender === 'female' ? 'btn-female' : 'btn-male'}" data-idx="${idx}" data-action="toggleGender">${genderLabel}</button>
            <button draggable="false" class="btn btn-sm btn-level" data-idx="${idx}" data-action="toggleLevel">L${p.level}</button>
            <button draggable="false" class="btn btn-sm ${readyBtnClass}" data-idx="${idx}" data-action="toggleReady">${readySymbol}</button>
            <button draggable="false" class="btn btn-sm ${prefClass} ms-1 prefer-btn" data-idx="${idx}" data-action="togglePrefer">${prefLabel}</button>
            <button draggable="false" class="btn btn-sm partner-btn ms-2" data-idx="${idx}" data-action="partnerToggle">${partnerLabel}</button>
            <button draggable="false" class="btn btn-sm ${coupleClass} ms-2" data-idx="${idx}" data-action="toggleType">${coupleLabel}</button>
            <button draggable="false" class="btn btn-sm btn-uncouple ms-2" data-idx="${idx}" data-action="toggleUnpair">${unpairLabel}</button>
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

  box.querySelectorAll('button[data-action]').forEach(btn => {
    btn.onclick = () => {
      const idx = parseInt(btn.getAttribute('data-idx'));
      const action = btn.getAttribute('data-action');

      if (action === 'toggleReady') {
        players[idx].ready = !players[idx].ready;
        saveState(); updateIdlePlayers(); render(); renderAdminPlayers();
      } else if (action === 'toggleGender') {
        players[idx].gender = players[idx].gender === 'male' ? 'female' : 'male';
        saveState(); render(); renderAdminPlayers();
      } else if (action === 'toggleLevel') {
        players[idx].level = (players[idx].level % 10) + 1;
        players[idx].rating = players[idx].level * 100;
        normalizePlayerPrefer(players[idx]);
        saveState(); render(); renderAdminPlayers();
      } else if (action === 'togglePrefer') {
        const current = getEffectivePrefer(players[idx]);
        const currentIndex = preferOrder.indexOf(current);
        players[idx].prefer = preferOrder[(currentIndex + 1 + preferOrder.length) % preferOrder.length];
        normalizePlayerPrefer(players[idx]);
        saveState(); render(); renderAdminPlayers();
      } else if (action === 'partnerToggle') {
        const order = ['', 'P1', 'P2', 'P3', 'P4', 'P5'];
        const current = players[idx].partnerSlot || '';
        const currentIndex = order.indexOf(current);
        players[idx].partnerSlot = order[(currentIndex + 1 + order.length) % order.length] || null;
        saveState(); render(); renderAdminPlayers();
      } else if (action === 'toggleType') {
        const current = players[idx].couple;
        if (current === null || current === undefined) players[idx].couple = 1;
        else if (current < MAX_COUPLE) players[idx].couple = current + 1;
        else players[idx].couple = null;
        saveState(); render(); renderAdminPlayers();
      } else if (action === 'toggleUnpair') {
        const current = players[idx].unpair;
        if (current === null || current === undefined) players[idx].unpair = 1;
        else if (current < MAX_COUPLE) players[idx].unpair = current + 1;
        else players[idx].unpair = null;
        saveState(); render(); renderAdminPlayers();
      } else if (action === 'delete') {
        if (confirm('Delete player ' + players[idx].name + '?')) {
          players.splice(idx, 1);
          saveState(); updateIdlePlayers(); render(); renderAdminPlayers();
        }
      } else if (action === 'edit') {
        const newName = prompt('Edit name for ' + players[idx].name, players[idx].name);
        if (newName && newName.trim()) {
          players[idx].name = newName.trim();
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

function importJSON(text) {
  try {
    const state = JSON.parse(text);
    if (state.players) {
      players = state.players.map(p => ({
        name: p.name,
        level: p.level || 4,
        gender: p.gender || 'male',
        prefer: p.prefer || 'normal',
        rating: p.rating !== undefined ? p.rating : ((p.level || 4) * 100),
        matches: p.matches || 0,
        ready: p.ready === undefined ? true : p.ready,
        idleIndex: Number.isFinite(Number(p.idleIndex)) ? Math.max(0, Math.floor(Number(p.idleIndex))) : 0,
        couple: p.couple === undefined ? null : p.couple,
        unpair: p.unpair === undefined ? (p.uncouple === undefined ? null : p.uncouple) : p.unpair,
        partnerSlot: p.partnerSlot === undefined ? null : p.partnerSlot,
        recentTeammates: normalizeRecentHistory(p.recentTeammates),
        recentOpponents: normalizeRecentHistory(p.recentOpponents)
      }));
    }
    
    const byName = name => players.find(p => p.name === name);
    
    if (state.active_matches) {
      active_matches = state.active_matches.map(m => {
        if (!m) return null;
        return [[byName(m[0][0]), byName(m[0][1])], [byName(m[1][0]), byName(m[1][1])]];
      });
      while (active_matches.length < COURTS) active_matches.push(null);
    }
    
    if (state.queue_matches) {
      queue_matches = state.queue_matches.map(m => {
        if (!m) return null;
        return [[byName(m[0][0]), byName(m[0][1])], [byName(m[1][0]), byName(m[1][1])]];
      }).filter(x => x);
    }
    
    if (state.idle_players) {
      idle_players = state.idle_players.map(n => byName(n)).filter(x => x);
    }
    
    if (state.match_history) match_history = state.match_history;
    
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
  const lines = match_history.map(m => {
    if (m.note) return `[${m.ts}] ${m.note}`;
    const t1 = m.team1.join(' + ');
    const t2 = m.team2.join(' + ');
    const winStr = m.winnerTeam ? (m.winnerTeam === 1 ? '(T1 win)' : '(T2 win)') : '';
    return `[${m.ts}] ${t1} vs ${t2} ${winStr}`;
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
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

  const player = {
    name,
    level,
    gender,
    prefer,
    rating: level * 100,
    matches: 0,
    ready: true,
    idleIndex: 0,
    couple: null,
    unpair: null,
    partnerSlot: null,
    recentTeammates: [],
    recentOpponents: []
  };
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
