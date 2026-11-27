/**
 * TheChimmyTCG — Starter Twitch Extension Backend Service (EBS)
 * -----------------------------------------------------------------
 * Handles:
 *  1. Twitch Extension JWT verification (using your Extension Secret from Developer Console)
 *  2. Server-side weighted card pulling (tamper-proof RNG)
 *  3. Duplicate-to-Chimbles conversion & Chimbles card unlocking
 *  4. 100% Cardset completion badge awards
 *  5. FIFO queue for Global Stream Overlay "Show Off" events
 *  6. Built-in Visual Endpoint Tester at http://localhost:3001/test
 */

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.PORT || 3001;
const TWITCH_EXTENSION_SECRET = process.env.TWITCH_EXTENSION_SECRET || '7trjndRI++DeJBa4J+6BYFN+YJEcSk9T6o78HaeJZPc=';

// ============================================================================
// 1. IN-MEMORY STARTER STORE (Replace with PostgreSQL / Redis / DynamoDB in prod)
// ============================================================================
const RARITY_CONFIG = {
  Common:      { weight: 50, duplicateChimbles: 10,  craftCost: 40 },
  Rare:        { weight: 25, duplicateChimbles: 25,  craftCost: 100 },
  Epic:        { weight: 12, duplicateChimbles: 60,  craftCost: 240 },
  Legendary:   { weight: 5,  duplicateChimbles: 150, craftCost: 600 },
  Holographic: { weight: 2,  duplicateChimbles: 300, craftCost: 1200 }
};

const channelSets = {
  set_series_1: {
    id: 'set_series_1',
    name: 'Series 1: Stream Legends',
    badgeName: 'Series 1 Champion',
    badgeEmoji: '🏆',
    pullable: true,
    cards: [
      { id: 'card_01', name: 'Hydrate Check', rarity: 'Common', emoji: '💧' },
      { id: 'card_02', name: 'VIP Diamond Badge', rarity: 'Rare', emoji: '💎' },
      { id: 'card_03', name: 'Hype Train Conductor', rarity: 'Epic', emoji: '🚂' },
      { id: 'card_04', name: 'Golden Subathon Crown', rarity: 'Legendary', emoji: '👑' },
      { id: 'card_05', name: 'Prismatic Glitch Entity', rarity: 'Holographic', emoji: '🌌' }
    ]
  }
};

// Keyed by `${channelId}:${opaqueOrTwitchUserId}`
const viewerProfiles = {};

// FIFO queue for global stream overlay show-offs
const streamShowOffQueue = [];

function getViewerProfile(channelId, userId) {
  const key = `${channelId}:${userId}`;
  if (!viewerProfiles[key]) {
    viewerProfiles[key] = {
      userId,
      channelId,
      chimbles: 0,
      earnedBadges: [],
      binder: {} // { [cardId]: { count: number, firstPulledAt: number } }
    };
  }
  return viewerProfiles[key];
}

// ============================================================================
// 2. TWITCH EXTENSION JWT AUTHENTICATION MIDDLEWARE
// ============================================================================
function verifyTwitchExtensionJWT(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    // Allow local dev bypass ONLY if explicitly running in non-production without a token
    if (!token && process.env.ALLOW_DEV_MOCK === 'true') {
      req.twitchAuth = {
        channel_id: req.headers['x-mock-channel'] || '12345678',
        user_id: req.headers['x-mock-user'] || 'U_mock_viewer_1',
        role: req.headers['x-mock-role'] || 'viewer'
      };
      return next();
    }

    if (!token) {
      return res.status(401).json({ error: 'Missing Twitch Extension Bearer token' });
    }

    const decodedSecret = Buffer.from(TWITCH_EXTENSION_SECRET, 'base64');
    const payload = jwt.verify(token, decodedSecret);

    req.twitchAuth = {
      channel_id: payload.channel_id,
      user_id: payload.user_id || payload.opaque_user_id,
      role: payload.role // 'broadcaster', 'moderator', 'viewer', or 'external'
    };
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired Twitch Extension JWT' });
  }
}

// ============================================================================
// 3. RNG, CHIMBLES & SET BADGE LOGIC
// ============================================================================
function rollWeightedCard(cards) {
  const totalWeight = cards.reduce((sum, card) => {
    const cfg = RARITY_CONFIG[card.rarity] || RARITY_CONFIG.Common;
    return sum + cfg.weight;
  }, 0);

  let roll = Math.random() * totalWeight;
  for (const card of cards) {
    const cfg = RARITY_CONFIG[card.rarity] || RARITY_CONFIG.Common;
    roll -= cfg.weight;
    if (roll <= 0) return card;
  }
  return cards[cards.length - 1];
}

function evaluateSetBadges(profile) {
  const newlyUnlocked = [];
  for (const set of Object.values(channelSets)) {
    if (!set.cards || set.cards.length === 0) continue;
    const ownsAll = set.cards.every(c => profile.binder[c.id] && profile.binder[c.id].count > 0);
    if (ownsAll && !profile.earnedBadges.includes(set.id)) {
      profile.earnedBadges.push(set.id);
      newlyUnlocked.push({
        setId: set.id,
        badgeName: set.badgeName,
        badgeEmoji: set.badgeEmoji
      });
    }
  }
  return newlyUnlocked;
}

// ============================================================================
// 4. BUILT-IN VISUAL TESTER (BEGINNER-FRIENDLY BROWSER DASHBOARD)
// ============================================================================
app.get('/test', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>TheChimmyTCG — Endpoint Health & Tester</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0e0e10; color: #efeff1; max-width: 820px; margin: 32px auto; padding: 0 16px; }
    h1 { color: #a970ff; margin-bottom: 4px; }
    p.sub { color: #adadb8; margin-top: 0; }
    .card { background: #18181b; border: 1px solid #2f2f35; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    button { background: #9146ff; color: white; border: none; border-radius: 8px; padding: 10px 14px; font-weight: 700; cursor: pointer; margin: 4px 6px 4px 0; }
    button:hover { background: #a970ff; }
    button.green { background: #00b894; color: #0e0e10; }
    .badge { display: inline-block; padding: 3px 8px; border-radius: 999px; font-size: 12px; font-weight: 700; }
    .ok { background: #064e3b; color: #6ee7b7; }
    .err { background: #7f1d1d; color: #fca5a5; }
    pre { background: #09090b; border: 1px solid #2f2f35; border-radius: 8px; padding: 12px; overflow-x: auto; font-size: 13px; color: #a7f3d0; }
    .row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #26262c; }
    .row:last-child { border-bottom: none; }
  </style>
</head>
<body>
  <h1>TheChimmyTCG — Endpoint Check</h1>
  <p class="sub">Click <strong>Run All Checks</strong> to verify every backend feature works automatically.</p>

  <div class="card">
    <button class="green" onclick="runAllChecks()">▶ Run All Checks Automatically</button>
    <button onclick="callApi('GET', '/health')">1. Check Server Health</button>
    <button onclick="callApi('GET', '/api/viewer/state')">2. Load Viewer Binder</button>
    <button onclick="callApi('POST', '/api/packs/pull', { setId: 'set_series_1', count: 3 })">3. Pull 3-Card Pack</button>
    <button onclick="testShowOff()">4. Show Off Card on Stream</button>
    <button onclick="callApi('GET', '/api/overlay/next')">5. Pop Next Stream Alert</button>
  </div>

  <div class="card" id="checklist">
    <div class="row"><span>1. Server Health (<code>GET /health</code>)</span><span id="status-1" class="badge">Not tested</span></div>
    <div class="row"><span>2. Viewer Binder & Chimbles (<code>GET /api/viewer/state</code>)</span><span id="status-2" class="badge">Not tested</span></div>
    <div class="row"><span>3. Pack Pulling & RNG (<code>POST /api/packs/pull</code>)</span><span id="status-3" class="badge">Not tested</span></div>
    <div class="row"><span>4. Stream Show-Off Queue (<code>POST /api/overlay/show-off</code>)</span><span id="status-4" class="badge">Not tested</span></div>
    <div class="row"><span>5. Stream Alert Pop (<code>GET /api/overlay/next</code>)</span><span id="status-5" class="badge">Not tested</span></div>
  </div>

  <div class="card">
    <strong>Latest Server Response:</strong>
    <pre id="output">Click any button above to see what the server sends back...</pre>
  </div>

  <script>
    const mockHeaders = {
      'Content-Type': 'application/json',
      'x-mock-user': 'viewer_1',
      'x-mock-channel': '12345'
    };

    function setBadge(num, ok, text) {
      const el = document.getElementById('status-' + num);
      el.className = 'badge ' + (ok ? 'ok' : 'err');
      el.textContent = ok ? ('✅ ' + text) : ('❌ ' + text);
    }

    async function callApi(method, path, body) {
      const res = await fetch(path, {
        method,
        headers: mockHeaders,
        body: body ? JSON.stringify(body) : undefined
      });
      const data = await res.json();
      document.getElementById('output').textContent = JSON.stringify({ status: res.status, data }, null, 2);
      return { ok: res.ok, status: res.status, data };
    }

    async function testShowOff() {
      const stateRes = await callApi('GET', '/api/viewer/state');
      const ownedIds = Object.keys(stateRes.data?.profile?.binder || {});
      if (ownedIds.length === 0) {
        document.getElementById('output').textContent = 'Pull a pack first so you own a card to show off!';
        return { ok: false };
      }
      return callApi('POST', '/api/overlay/show-off', { cardId: ownedIds[0], displayName: 'Viewer_1' });
    }

    async function runAllChecks() {
      const r1 = await callApi('GET', '/health');
      setBadge(1, r1.ok, r1.ok ? 'Working' : 'Failed (' + r1.status + ')');

      const r2 = await callApi('GET', '/api/viewer/state');
      setBadge(2, r2.ok, r2.ok ? 'Working' : 'Check ALLOW_DEV_MOCK=true in .env');

      const r3 = await callApi('POST', '/api/packs/pull', { setId: 'set_series_1', count: 3 });
      setBadge(3, r3.ok, r3.ok ? 'Pulled 3 cards!' : 'Failed');

      const r4 = await testShowOff();
      setBadge(4, r4.ok, r4.ok ? 'Queued alert!' : 'Failed');

      const r5 = await callApi('GET', '/api/overlay/next');
      setBadge(5, r5.ok && r5.data.event !== null, r5.ok ? 'Alert popped!' : 'Failed');
    }
  </script>
</body>
</html>`);
});

// ============================================================================
// 5. API ENDPOINTS
// ============================================================================

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'TheChimmyTCG EBS',
    visualTester: `http://localhost:${PORT}/test`,
    endpoints: [
      'GET  /test',
      'GET  /health',
      'GET  /api/viewer/state',
      'POST /api/packs/pull',
      'POST /api/binder/unlock',
      'POST /api/overlay/show-off',
      'GET  /api/overlay/next'
    ]
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'thechimmytcg-ebs' });
});

app.get('/api/viewer/state', verifyTwitchExtensionJWT, (req, res) => {
  try {
    const { channel_id, user_id } = req.twitchAuth;
    const profile = getViewerProfile(channel_id, user_id);
    res.json({
      profile,
      cardsets: Object.values(channelSets)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load viewer state' });
  }
});

app.post('/api/packs/pull', verifyTwitchExtensionJWT, (req, res) => {
  try {
    const { channel_id, user_id } = req.twitchAuth;
    const { setId, count } = req.body;
    const pullCount = count === 3 ? 3 : 1;

    const targetSet = channelSets[setId];
    if (!targetSet) {
      return res.status(404).json({ error: 'Cardset not found' });
    }
    if (targetSet.pullable === false) {
      return res.status(400).json({ error: 'This cardset is vaulted from pack pulls' });
    }
    if (!targetSet.cards || targetSet.cards.length === 0) {
      return res.status(400).json({ error: 'Cardset has no cards' });
    }

    const profile = getViewerProfile(channel_id, user_id);
    const now = Date.now();
    let totalChimblesEarned = 0;

    const pulled = Array.from({ length: pullCount }, () => {
      const card = rollWeightedCard(targetSet.cards);
      const isNew = !profile.binder[card.id] || profile.binder[card.id].count === 0;
      let chimblesGained = 0;

      if (isNew) {
        profile.binder[card.id] = { count: 1, firstPulledAt: now };
      } else {
        profile.binder[card.id].count += 1;
        chimblesGained = (RARITY_CONFIG[card.rarity] || RARITY_CONFIG.Common).duplicateChimbles;
        profile.chimbles += chimblesGained;
        totalChimblesEarned += chimblesGained;
      }

      return { card, isNew, chimblesGained };
    });

    const newlyUnlockedBadges = evaluateSetBadges(profile);

    res.json({
      pulled,
      totalChimblesEarned,
      chimbles: profile.chimbles,
      newlyUnlockedBadges,
      binder: profile.binder
    });
  } catch (err) {
    res.status(500).json({ error: 'Error processing pack pull' });
  }
});

app.post('/api/binder/unlock', verifyTwitchExtensionJWT, (req, res) => {
  try {
    const { channel_id, user_id } = req.twitchAuth;
    const { cardId } = req.body;

    let targetCard = null;
    for (const set of Object.values(channelSets)) {
      const found = set.cards.find(c => c.id === cardId);
      if (found) {
        targetCard = found;
        break;
      }
    }

    if (!targetCard) {
      return res.status(404).json({ error: 'Card not found' });
    }

    const profile = getViewerProfile(channel_id, user_id);
    if (profile.binder[cardId] && profile.binder[cardId].count > 0) {
      return res.status(400).json({ error: 'Card already collected' });
    }

    const cost = (RARITY_CONFIG[targetCard.rarity] || RARITY_CONFIG.Common).craftCost;
    if (profile.chimbles < cost) {
      return res.status(400).json({ error: `Need ${cost} Chimbles` });
    }

    profile.chimbles -= cost;
    profile.binder[cardId] = { count: 1, firstPulledAt: Date.now() };
    const newlyUnlockedBadges = evaluateSetBadges(profile);

    res.json({
      unlockedCard: targetCard,
      chimbles: profile.chimbles,
      newlyUnlockedBadges,
      binder: profile.binder
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unlock card' });
  }
});

app.post('/api/overlay/show-off', verifyTwitchExtensionJWT, (req, res) => {
  try {
    const { channel_id, user_id } = req.twitchAuth;
    const { cardId, displayName } = req.body;
    const profile = getViewerProfile(channel_id, user_id);

    if (!profile.binder[cardId] || profile.binder[cardId].count < 1) {
      return res.status(403).json({ error: 'Viewer does not own this card' });
    }

    let card = null;
    for (const set of Object.values(channelSets)) {
      const found = set.cards.find(c => c.id === cardId);
      if (found) {
        card = found;
        break;
      }
    }

    const eventItem = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      channelId: channel_id,
      username: displayName || user_id,
      card,
      createdAt: Date.now()
    };

    streamShowOffQueue.push(eventItem);
    res.status(201).json({ queued: true, queueLength: streamShowOffQueue.length, event: eventItem });
  } catch (err) {
    res.status(500).json({ error: 'Failed to queue stream show-off' });
  }
});

app.get('/api/overlay/next', (req, res) => {
  const nextEvent = streamShowOffQueue.shift() || null;
  res.json({ event: nextEvent, remainingInQueue: streamShowOffQueue.length });
});

app.listen(PORT, () => {
  console.log(`TheChimmyTCG EBS running on http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT}/test in your browser to test all endpoints!`);
});
