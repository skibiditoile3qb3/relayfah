const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const { MongoClient } = require('mongodb');

const MONGO_URI = process.env.MONGO_URI;
let db = null;

async function connectDB() {
  try {
    const client = await MongoClient.connect(MONGO_URI);
    db = client.db('gladiator_game');
    console.log('MongoDBAtlas connected');
  } catch(e) {
    console.error('MongoDBAtlas connection failed:', e);
  }
}
async function saveMessage(room, message) {
  if (!db) return;
  
  try {
    await db.collection('chat_history').insertOne({
      room: room,
      message: message,
      timestamp: Date.now()
    });
    
    // Keep only last 20 messages per room
    const allMessages = await db.collection('chat_history')
      .find({ room: room })
      .sort({ timestamp: -1 })
      .toArray();
    
    if (allMessages.length > 20) {
      const messagesToDelete = allMessages.slice(20);
      const idsToDelete = messagesToDelete.map(msg => msg._id);
      
      await db.collection('chat_history').deleteMany({
        _id: { $in: idsToDelete }
      });
    }
  } catch(e) {
    console.error('Error saving message:', e);
  }
}

async function loadChatHistory(room) {
  if (!db) return [];
  
  try {
    const messages = await db.collection('chat_history')
      .find({ room: room })
      .sort({ timestamp: 1 }) // Oldest first
      .limit(20)
      .toArray();
    
    return messages.map(msg => ({
      id: msg.message.id,
      username: msg.message.username,
      status: msg.message.status,
      nametag: msg.message.nametag || 'none',
      clientId: msg.message.clientId,
      message: msg.message.message,
      timestamp: msg.message.timestamp
      // Note: IP is NOT included here for privacy
    }));
  } catch(e) {
    console.error('Error loading chat history:', e);
    return [];
  }
}
connectDB();

const PORT = process.env.PORT || 8080;

// Create HTTP server
const server = http.createServer();

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Store connections
const clients = new Map();
const rooms = new Map();
const queuedPlayers = new Map();
const BANNED_IPS = new Set([
  '68.103.231.240'
  // Add more IPs here as needed
]);

// Track last logged actions to prevent spam
const lastLoggedActions = new Map();

// Utility functions
function generateId() {
  return Math.random().toString(36).substring(2, 15);
}

function broadcast(room, message, excludeId = null) {
  if (!rooms.has(room)) return;
  
  rooms.get(room).forEach(clientId => {
    if (clientId !== excludeId && clients.has(clientId)) {
      const client = clients.get(clientId);
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(message));
      }
    }
  });
}

function log(type, data) {
  // Don't log repetitive game actions
  const skipTypes = ['GAME_STATE', 'PLAYER_ACTION', 'HEARTBEAT'];
  
  if (skipTypes.includes(type)) {
    const key = `${type}_${data.clientId}_${data.action || 'state'}`;
    const lastLog = lastLoggedActions.get(key);
    const now = Date.now();
    
    // Only log if it's been more than 10 seconds since last same action
    if (lastLog && now - lastLog < 10000) {
      return; // Skip logging
    }
    
    lastLoggedActions.set(key, now);
    
    // Clean up old entries (older than 1 minute)
    for (const [k, time] of lastLoggedActions.entries()) {
      if (now - time > 60000) {
        lastLoggedActions.delete(k);
      }
    }
  }
  
  // Just console log, don't store
  console.log(`[${new Date().toISOString()}] ${type}:`, data);
}

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  const clientId = generateId();
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  
  clients.set(clientId, {
    ws,
    id: clientId,
    username: null,
    room: null,
    status: 'player',
    ip,
    connectedAt: Date.now(),
    lastHeartbeat: Date.now()
  });
  
  log('CONNECTION', { clientId, ip });
  
  // Send client their ID
  ws.send(JSON.stringify({
    type: 'connected',
    clientId,
    password: process.env.SITE_PASSWORD || 'igotmogged',
    message: 'Connected to relay server'
  }));
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(clientId, data);
    } catch (error) {
      log('ERROR', { clientId, error: error.message });
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format'
      }));
    }
  });
  
  ws.on('close', () => {
    handleDisconnect(clientId);
  });
  
  ws.on('error', (error) => {
    log('ERROR', { clientId, error: error.message });
  });
});

function handleMessage(clientId, data) {
  const client = clients.get(clientId);
  if (!client) return;
  
  switch (data.type) {
    case 'join':
      handleJoin(clientId, data);
      break;
      
    case 'leave':
      handleLeave(clientId);
      break;
      
    case 'chat':
      handleChat(clientId, data);
      break;

      case 'check_password':  // ADDED
      handlePasswordCheck(clientId, data);
      break;
      
    case 'check_owner_password':  // ADDED
      handleOwnerPasswordCheck(clientId, data);
      break;
      
    case 'game_state':
      handleGameState(clientId, data);
      break;
      
    case 'player_action':
      handlePlayerAction(clientId, data);
      break;

   case 'heartbeat':
  handleHeartbeat(clientId, data);
  break;
    case 'donation':
      handleDonation(clientId, data);
      break;
      
    case 'get_players':
      handleGetPlayers(clientId);
      break;

      case 'get_queue_count':  // NEW
  handleGetQueueCount(clientId);
  break;
      
   case 'save_game':
      handleSaveGame(clientId, data);
      break;

    case 'load_game':
      handleLoadGame(clientId, data);
      break;

    case 'update_elo':
      handleUpdateElo(clientId, data);
      break;

    case 'get_leaderboard':
      handleGetLeaderboard(clientId);
      break;
    case 'update_coins':  
      handleUpdateCoins(clientId, data);
      break;

  case 'get_coins_leaderboard':  
    handleGetCoinsLeaderboard(clientId);
    break;
      
   case 'admin_action':
    handleAdminAction(clientId, data);
    break;
 
    default:
      client.ws.send(JSON.stringify({
        type: 'error',
        message: 'Unknown message type'
      }));
  }
}

async function handleJoin(clientId, data) {  
  const client = clients.get(clientId);
  const { room, username, status } = data;
    if (BANNED_IPS.has(client.ip)) {
    client.ws.send(JSON.stringify({
      type: 'error',
      message: 'Connection error. Please try again later.'
    }));
    setTimeout(() => {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.close();
      }
    }, 2000);
    log('SILENT_IP_BAN', { ip: client.ip, username });
    return;
  }
  console.log('🎯 JOIN REQUEST:', { clientId, room, username, status });
  
  if (!room) {
    client.ws.send(JSON.stringify({
      type: 'error',
      message: 'Room ID required'
    }));
    return;
  }
  
  // Validate staff_chat access
  if (room === 'staff_chat') {
    const staffRanks = ['owner', 'sr.admin', 'admin', 'moderator'];
    if (!staffRanks.includes(status)) {
      client.ws.send(JSON.stringify({
        type: 'error',
        message: 'Staff chat is for staff only'
      }));
      return;
    }
  }
  
  // Leave current room if in one
  if (client.room) {
    handleLeave(clientId);
  }
  
  client.room = room;
client.username = username || `Player${clientId.substring(0, 6)}`;
client.status = status || 'player';
client.permanentId = data.permanentId || null;
client.lastHeartbeat = Date.now();
client.gladiatorCosmetics = data.gladiatorCosmetics || {  // ADD THIS
  icon: '⚔️',
  slashColor: '#ffffff'
};
  

  
  if (!rooms.has(room)) {
    rooms.set(room, new Set());
  }
  rooms.get(room).add(clientId);
  
  log('JOIN', { clientId, username: client.username, room, status: client.status });
  
  // Get room players
const players = Array.from(rooms.get(room))
  .map(id => {
    const c = clients.get(id);
    return {
      id: c.id,
      username: c.username,
      status: c.status,
      gladiatorCosmetics: c.gladiatorCosmetics || { icon: '⚔️', slashColor: '#ffffff' }  
    };
  });
   console.log('📜 Loading chat history for room:', room);
  const dbHistory = await loadChatHistory(room);
    console.log('📜 Loaded messages:', dbHistory.length); // ← ADD THIS
  console.log('📜 Sample message:', dbHistory[0]); // ← ADD THIS
  
  console.log('📤 Sending joined event to client'); // ← ADD THIS
  
  client.ws.send(JSON.stringify({
    type: 'joined',
    room,
    players,
    chatHistory: dbHistory  
  }));
  console.log('✅ Joined event sent!');
  
  // Notify others in room
  broadcast(room, {
    type: 'player_joined',
    player: {
      id: client.id,
      username: client.username,
      status: client.status
    }
  }, clientId);
  
  broadcast(room, {
    type: 'players_update',
    players
  });
}

function handleLeave(clientId) {
  const client = clients.get(clientId);
  if (!client || !client.room) return;
  
  const room = client.room;
  
  log('LEAVE', { clientId, username: client.username, room });
  
  // Remove from room
  if (rooms.has(room)) {
    rooms.get(room).delete(clientId);
    
    // Delete room if empty
    if (rooms.get(room).size === 0) {
      rooms.delete(room);
    } else {
      // Notify others
      broadcast(room, {
        type: 'player_left',
        player: {
          id: client.id,
          username: client.username
        }
      });
      
      // Update player count
const players = Array.from(rooms.get(room))
  .map(id => {
    const c = clients.get(id);
    return {
      id: c.id,
      username: c.username,
      status: c.status,
      gladiatorCosmetics: c.gladiatorCosmetics || { icon: '⚔️', slashColor: '#ffffff' }  // ADD THIS
    };
  });
      
      broadcast(room, {
        type: 'players_update',
        players
      });
    }
  }
  
  client.room = null;
}

async function handleChat(clientId, data) {  // ← Add 'async'
  const client = clients.get(clientId);
  if (!client || !client.room) return;
  
  const { message, room } = data;
  if (!message || message.trim().length === 0) return;
  
  // Check if trying to send to staff_chat
  if (room === 'staff_chat') {
    const staffRanks = ['owner', 'sr.admin', 'admin', 'moderator'];
    if (!staffRanks.includes(client.status)) {
      client.ws.send(JSON.stringify({
        type: 'error',
        message: 'Staff chat is for staff only'
      }));
      return;
    }
  }
  
  const chatMessage = {
    id: generateId(),
    username: client.username,
    status: client.status || 'player',
    nametag: data.nametag || 'none',
    clientId,
    message: message.substring(0, 500),
    timestamp: Date.now(),
    ip: client.ip
  };
  
  // ✅ Save to database (with IP for logs)
  await saveMessage(client.room, chatMessage);
  
  // Log with IP
  log('CHAT', { 
    room: client.room, 
    username: client.username, 
    message,
    ip: client.ip
  });
  
  // Broadcast to room (IP not included in broadcast for privacy)
  broadcast(client.room, {
    type: 'chat_message',
    message: {
      id: chatMessage.id,
      username: chatMessage.username,
      status: chatMessage.status,
      nametag: chatMessage.nametag,
      clientId: chatMessage.clientId,
      message: chatMessage.message,
      timestamp: chatMessage.timestamp
    }
  });
}
function handleGameState(clientId, data) {
  const client = clients.get(clientId);
  if (!client || !client.room) return;
  
  log('GAME_STATE', { room: client.room, clientId, state: data.state });
  
  // Relay game state to all players in room
  broadcast(client.room, {
    type: 'game_state_update',
    playerId: clientId,
    state: data.state
  }, clientId);
}

function handlePlayerAction(clientId, data) {
  const client = clients.get(clientId);
  if (!client || !client.room) return;
  
  log('PLAYER_ACTION', { room: client.room, clientId, action: data.action });
  
  // Relay action to all players in room
  broadcast(client.room, {
    type: 'player_action',
    playerId: clientId,
    action: data.action,
    actionData: data.data
  }, clientId);
}

function handleHeartbeat(clientId, data) {  // Add data parameter
  const client = clients.get(clientId);
  if (!client || !client.room) return;
  
  // Update last activity
  client.lastHeartbeat = Date.now();
  
  // Store queue status from heartbeat data
  if (data && typeof data.inQueue !== 'undefined') {
    client.inQueue = data.inQueue;
  }
  
  log('HEARTBEAT', { clientId });
  
  // Send updated player count to everyone in room
  const room = client.room;
  if (!rooms.has(room)) return;
  
  const players = Array.from(rooms.get(room))
  .map(id => {
    const c = clients.get(id);
    return {
      id: c.id,
      username: c.username,
      status: c.status,
      gladiatorCosmetics: c.gladiatorCosmetics || { icon: '⚔️', slashColor: '#ffffff' }  // ADD THIS
    };
  });
  
  broadcast(room, {
    type: 'players_update',
    players
  });
}

function handleDonation(clientId, data) {
  const client = clients.get(clientId);
  if (!client || !client.room) return;
  
 const { targetUsername, amount, donationType, from, senderStatus, senderPermanentId } = data;

  let targetClient = null;
  for (const [id, c] of clients.entries()) {
    if (c.username === targetUsername && c.room === client.room) {
      targetClient = c;
      break;
    }
  }

  if (targetClient && senderPermanentId && targetClient.permanentId && senderPermanentId === targetClient.permanentId) {
    client.ws.send(JSON.stringify({
      type: 'error',
      message: 'Cannot donate to yourself'
    }));
    log('DONATION_BLOCKED', { reason: 'same_permanentId', from: client.username, to: targetUsername });
    return;
  }

  log('DONATION', {
    room: client.room, 
    from, 
    to: targetUsername, 
    amount, 
    type: donationType,
    senderStatus: senderStatus || 'player',
    ip: client.ip 
  });
  
  // Broadcast to room
  broadcast(client.room, {
    type: 'donation',
    targetUsername,
    amount,
    donationType,
    from,
    senderStatus: senderStatus || 'player'
  });
}

function handleGetPlayers(clientId) {
  const client = clients.get(clientId);
  if (!client || !client.room) return;
  
  const room = client.room;
  
  if (!rooms.has(room)) return;
  
const players = Array.from(rooms.get(room))
  .map(id => {
    const c = clients.get(id);
    return {
      id: c.id,
      username: c.username,
      status: c.status,
      gladiatorCosmetics: c.gladiatorCosmetics || { icon: '⚔️', slashColor: '#ffffff' }  // ADD THIS
    };
  });
  
  client.ws.send(JSON.stringify({
    type: 'players_update',
    players
  }));
}

function handleGetQueueCount(clientId) {
  const client = clients.get(clientId);
  if (!client || !client.room) return;
  
  const room = client.room;
  
  // Count players in queue for this room
  let queueCount = 0;
  if (rooms.has(room)) {
    rooms.get(room).forEach(id => {
      const c = clients.get(id);
      // Check if they sent inQueue=true in their heartbeat
      if (c && c.inQueue) {
        queueCount++;
      }
    });
  }
  
  client.ws.send(JSON.stringify({
    type: 'queue_count',
    count: queueCount
  }));
}
async function handleSaveGame(clientId, data) {
  const client = clients.get(clientId);
  if (!client || !db) return;
  
  const { saveId, saveData } = data;
  
  try {
    await db.collection('saves').updateOne(
      { saveId },
      { $set: { saveId, data: saveData, lastUpdated: Date.now() } },
      { upsert: true }
    );
    
    client.ws.send(JSON.stringify({
      type: 'save_result',
      success: true,
      message: 'Game saved successfully'
    }));
    
    log('SAVE_GAME', { clientId, saveId });
  } catch(e) {
    client.ws.send(JSON.stringify({
      type: 'save_result',
      success: false,
      message: 'Save failed'
    }));
    log('ERROR', { action: 'SAVE_GAME', error: e.message });
  }
}

async function handleLoadGame(clientId, data) {
  const client = clients.get(clientId);
  if (!client || !db) return;
  
  const { saveId } = data;
  
  try {
    const save = await db.collection('saves').findOne({ saveId });
    
    if (save) {
      client.ws.send(JSON.stringify({
        type: 'load_result',
        success: true,
        data: save.data
      }));
      log('LOAD_GAME', { clientId, saveId });
    } else {
      client.ws.send(JSON.stringify({
        type: 'load_result',
        success: false,
        message: 'Save ID not found'
      }));
    }
  } catch(e) {
    client.ws.send(JSON.stringify({
      type: 'load_result',
      success: false,
      message: 'Load failed'
    }));
    log('ERROR', { action: 'LOAD_GAME', error: e.message });
  }
}

async function handleUpdateElo(clientId, data) {
  const client = clients.get(clientId);
  if (!client || !db) return;
  
  const { username, elo, userId } = data; 
  
  try {
   
    await db.collection('leaderboard').updateOne(
      { userId: userId }, 
      { 
        $set: { 
          userId: userId,       
          username: username,   
          elo: elo, 
          lastUpdated: Date.now() 
        } 
      },
      { upsert: true }
    );
    
    log('UPDATE_ELO', { userId, username, elo });
  } catch(e) {
    log('ERROR', { action: 'UPDATE_ELO', error: e.message });
  }
}

async function handleUpdateCoins(clientId, data) {
  const client = clients.get(clientId);
  if (!client || !db) return;
  
  const { username, coins, userId } = data;
  
  try {
    // Update coins in database
    await db.collection('coins_leaderboard').updateOne(
      { userId: userId },
      {
        $set: {
          userId: userId,
          username: username,
          coins: coins,
          lastUpdated: Date.now()
        }
      },
      { upsert: true }
    );
    
    // Get current top 3
    const top3 = await db.collection('coins_leaderboard')
      .find({})
      .sort({ coins: -1 })
      .limit(3)
      .toArray();
    
    const top3UserIds = top3.map(p => p.userId);
    
    // Check if this user just entered top 3
    if (top3UserIds.includes(userId)) {
      const rank = top3UserIds.indexOf(userId) + 1;
      
      log('TOP_3_ACHIEVEMENT', { 
        userId, 
        username, 
        coins,
        rank 
      });
      
      // Send notification to the user
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify({
          type: 'top3_achievement',
          rank: rank
        }));
      }
    }
    
    log('UPDATE_COINS', { userId, username, coins });
  } catch(e) {
    log('ERROR', { action: 'UPDATE_COINS', error: e.message });
  }
}


async function handleGetCoinsLeaderboard(clientId) {
  const client = clients.get(clientId);
  if (!client || !db) return;
  
  try {
    const top = await db.collection('coins_leaderboard')
      .find({})
      .sort({ coins: -1 })
      .limit(10)
      .toArray();
    
    client.ws.send(JSON.stringify({
      type: 'coins_leaderboard_data',
      leaderboard: top
    }));
  } catch(e) {
    log('ERROR', { action: 'GET_COINS_LEADERBOARD', error: e.message });
  }
}
async function handleGetLeaderboard(clientId) {
  const client = clients.get(clientId);
  if (!client || !db) return;
  
  try {
    const top = await db.collection('leaderboard')
      .find({})
      .sort({ elo: -1 })
      .limit(50)
      .toArray();
    
    client.ws.send(JSON.stringify({
      type: 'leaderboard_data',
      leaderboard: top
    }));
  } catch(e) {
    log('ERROR', { action: 'GET_LEADERBOARD', error: e.message });
  }
}
function handleDisconnect(clientId) {
  const client = clients.get(clientId);
  if (!client) return;
  
  log('DISCONNECT', { clientId, username: client.username });
  
  handleLeave(clientId);
  clients.delete(clientId);
}

function handlePasswordCheck(clientId, data) {
  const client = clients.get(clientId);
  if (!client) return;
  
  const correctPassword = process.env.SITE_PASSWORD || 'igotmogged';
  const isValid = data.password === correctPassword;
  
  client.ws.send(JSON.stringify({
    type: 'password_result',
    valid: isValid
  }));
  
  log('PASSWORD_CHECK', { 
    clientId, 
    valid: isValid,
    ip: client.ip 
  });
}

// Owner Password Check Handler
function handleOwnerPasswordCheck(clientId, data) {
  const client = clients.get(clientId);
  if (!client) return;
  
  const correctOwnerPassword = process.env.OWNER_KEY || 'goofy';
  const isValid = data.password === correctOwnerPassword;
  
  client.ws.send(JSON.stringify({
    type: 'owner_password_result',
    valid: isValid
  }));
  
  log('OWNER_PASSWORD_CHECK', { 
    clientId,
    username: client.username,
    valid: isValid,
    ip: client.ip 
  });
}
// ============================================
// ADMIN FUNCTIONS
// ============================================

function handleAdminAction(clientId, data) {
  const client = clients.get(clientId);
  if (!client) return;
  
  const { action, targetUsername, adminUsername, adminRank } = data;
  
  // Verify admin permissions
  const staffRanks = ['owner', 'sr.admin', 'admin', 'moderator'];
  if (!staffRanks.includes(adminRank)) {
    client.ws.send(JSON.stringify({
      type: 'admin_action_result',
      success: false,
      message: 'Insufficient permissions'
    }));
    return;
  }
  
  // Search ALL clients, not just in admin's room
  let targetClient = null;
  for (const [id, c] of clients.entries()) {
    if (c.username === targetUsername) {
      targetClient = c;
      break;
    }
  }
  
  if (!targetClient) {
    client.ws.send(JSON.stringify({
      type: 'admin_action_result',
      success: false,
      message: `User ${targetUsername} is not online`
    }));
    return;
  }
  
switch (action) {
    case 'promote':
        handlePromoteAction(client, targetClient, data);
        break;
    case 'ban':
        handleBanAction(client, targetClient, data);
        break;
    case 'mute':
        handleMuteAction(client, targetClient, data);
        break;
    case 'unmute':
        handleUnmuteAction(client, targetClient, data);
        break;
    case 'unban':
        handleUnbanAction(client, targetClient, data);
        break;
}
}

function handlePromoteAction(adminClient, targetClient, data) {
  const { newRank, adminRank } = data;
  
  // Only owner can promote
  if (adminRank !== 'owner') {
    adminClient.ws.send(JSON.stringify({
      type: 'admin_action_result',
      success: false,
      message: 'Only owner can change ranks'
    }));
    return;
  }
  
  // Update target's status in server
  targetClient.status = newRank;
  
  // Send directly to target
  if (targetClient.ws.readyState === WebSocket.OPEN) {
    targetClient.ws.send(JSON.stringify({
      type: 'rank_changed',
      newRank: newRank,
      changedBy: data.adminUsername
    }));
  }
  
  // Log action
  log('ADMIN_ACTION', {
    action: 'PROMOTE',
    admin: data.adminUsername,
    target: targetClient.username,
    newRank: newRank
  });
  
  // Send confirmation to admin
  if (adminClient.ws.readyState === WebSocket.OPEN) {
    adminClient.ws.send(JSON.stringify({
      type: 'admin_action_result',
      success: true,
      message: `${targetClient.username} rank changed to ${newRank}`
    }));
  }
}

function handleBanAction(adminClient, targetClient, data) {
  const { days, permanent, adminRank, reason, maxDays } = data;
  
  // Check permissions
  const targetRank = targetClient.status || 'player';
  
  // Define staff ranks
  const staffRanks = ['owner', 'sr.admin', 'admin', 'moderator'];
  const isTargetStaff = staffRanks.includes(targetRank);
  
  // ✅ OWNER CAN BAN ANYONE (including staff)
  if (adminRank === 'owner') {
    // Owner bypasses all restrictions - skip to ban logic below
  } 
  // ✅ SR.ADMIN can ban everyone except owner and other sr.admins
  else if (adminRank === 'sr.admin' && ['sr.admin', 'owner'].includes(targetRank)) {
    adminClient.ws.send(JSON.stringify({
      type: 'admin_action_result',
      success: false,
      message: 'Cannot ban Sr. Admins or Owner'
    }));
    return;
  }
  // ✅ ADMIN can ban moderators and non-staff only
  else if (adminRank === 'admin' && ['admin', 'sr.admin', 'owner'].includes(targetRank)) {
    adminClient.ws.send(JSON.stringify({
      type: 'admin_action_result',
      success: false,
      message: 'Cannot ban staff members of equal or higher rank'
    }));
    return;
  }
  // ✅ MODERATOR cannot ban anyone (if they even have ban perms)
  else if (adminRank === 'moderator' && isTargetStaff) {
    adminClient.ws.send(JSON.stringify({
      type: 'admin_action_result',
      success: false,
      message: 'Moderators cannot ban staff members'
    }));
    return;
  }
  
  // Validate day limits (owner can bypass this too if you want)
  if (adminRank !== 'owner' && maxDays && days > maxDays) {
    adminClient.ws.send(JSON.stringify({
      type: 'admin_action_result',
      success: false,
      message: `Cannot ban for more than ${maxDays} days`
    }));
    return;
  }
  
  // Calculate ban duration
  const banUntil = permanent ? 9999999999999 : Date.now() + (days * 24 * 60 * 60 * 1000);
  
  // Send directly to target
  if (targetClient.ws.readyState === WebSocket.OPEN) {
    targetClient.ws.send(JSON.stringify({
      type: 'banned',
      until: banUntil,
      bannedBy: data.adminUsername,
      reason: reason || 'No reason provided',
      days: permanent ? 0 : days
    }));
    
    // Disconnect them after 3 seconds
    setTimeout(() => {
      if (targetClient.ws.readyState === WebSocket.OPEN) {
        targetClient.ws.close();
      }
    }, 3000);
  }
  
  // Log ban
  log('ADMIN_ACTION', {
    action: 'BAN',
    admin: data.adminUsername,
    adminRank: adminRank,
    target: targetClient.username,
    targetRank: targetRank,
    days: permanent ? 'PERMANENT' : days,
    reason: reason
  });
  
  // Send confirmation to admin
  if (adminClient.ws.readyState === WebSocket.OPEN) {
    adminClient.ws.send(JSON.stringify({
      type: 'admin_action_result',
      success: true,
      message: `${targetClient.username} (${targetRank}) banned for ${permanent ? 'PERMANENT' : days + ' days'}`
    }));
  }
}
function handleMuteAction(adminClient, targetClient, data) {
  const { hours, adminRank } = data;
  
  // Check permissions based on hierarchy
  const targetRank = targetClient.status || 'player';
  
  // Define staff ranks
  const staffRanks = ['owner', 'sr.admin', 'admin', 'moderator'];
  const isTargetStaff = staffRanks.includes(targetRank);
  
  // ✅ OWNER CAN MUTE ANYONE
  if (adminRank === 'owner') {
    // Owner bypasses all restrictions - skip to mute logic below
  } 
  // ✅ SR.ADMIN can mute everyone except owner and other sr.admins
  else if (adminRank === 'sr.admin' && ['sr.admin', 'owner'].includes(targetRank)) {
    adminClient.ws.send(JSON.stringify({
      type: 'admin_action_result',
      success: false,
      message: 'Cannot mute Sr. Admins or Owner'
    }));
    return;
  }
  // ✅ ADMIN can mute moderators and non-staff only
  else if (adminRank === 'admin' && ['admin', 'sr.admin', 'owner'].includes(targetRank)) {
    adminClient.ws.send(JSON.stringify({
      type: 'admin_action_result',
      success: false,
      message: 'Cannot mute staff members of equal or higher rank'
    }));
    return;
  }
  // ✅ MODERATOR can mute non-staff only (players, legendary, rare, mystical, etc.)
  else if (adminRank === 'moderator' && isTargetStaff) {
    adminClient.ws.send(JSON.stringify({
      type: 'admin_action_result',
      success: false,
      message: 'Moderators cannot mute staff members'
    }));
    return;
  }
  
  // Calculate mute duration
  const muteUntil = Date.now() + (hours * 60 * 60 * 1000);
  
  // Send directly to target
  if (targetClient.ws.readyState === WebSocket.OPEN) {
    targetClient.ws.send(JSON.stringify({
      type: 'muted',
      until: muteUntil,
      mutedBy: data.adminUsername,
      hours: hours
    }));
  }
  
  // Log mute
  log('ADMIN_ACTION', {
    action: 'MUTE',
    admin: data.adminUsername,
    adminRank: adminRank,
    target: targetClient.username,
    targetRank: targetRank,
    hours: hours
  });
  
  // Send confirmation to admin
  if (adminClient.ws.readyState === WebSocket.OPEN) {
    adminClient.ws.send(JSON.stringify({
      type: 'admin_action_result',
      success: true,
      message: `${targetClient.username} (${targetRank}) muted for ${hours} hours`
    }));
  }
}

function handleUnmuteAction(adminClient, targetClient, data) {
    const { adminRank } = data;
    
    // All staff can unmute
    const staffRanks = ['owner', 'sr.admin', 'admin', 'moderator'];
    if (!staffRanks.includes(adminRank)) {
        adminClient.ws.send(JSON.stringify({
            type: 'admin_action_result',
            success: false,
            message: 'Insufficient permissions'
        }));
        return;
    }
    
    // Send directly to target to clear their mute
    if (targetClient.ws.readyState === WebSocket.OPEN) {
        targetClient.ws.send(JSON.stringify({
            type: 'unmuted',
            unmutedBy: data.adminUsername
        }));
    }

    log('ADMIN_ACTION', {
        action: 'UNMUTE',
        admin: data.adminUsername,
        target: targetClient.username
    });
    
    // Send confirmation to admin
    if (adminClient.ws.readyState === WebSocket.OPEN) {
        adminClient.ws.send(JSON.stringify({
            type: 'admin_action_result',
            success: true,
            message: `${targetClient.username} has been unmuted`
        }));
    }
}
 function handleUnbanAction(adminClient, targetClient, data) {
  const { adminRank } = data;
  
  // All staff can unban
  const staffRanks = ['owner', 'sr.admin', 'admin', 'moderator'];
  if (!staffRanks.includes(adminRank)) {
    adminClient.ws.send(JSON.stringify({
      type: 'admin_action_result',
      success: false,
      message: 'Insufficient permissions'
    }));
    return;
  }
  
  // Send directly to target to clear their ban
  if (targetClient.ws.readyState === WebSocket.OPEN) {
    targetClient.ws.send(JSON.stringify({
      type: 'unbanned',
      unbannedBy: data.adminUsername
    }));
  }

  log('ADMIN_ACTION', {
    action: 'UNBAN',
    admin: data.adminUsername,
    target: targetClient.username
  });
  
  // Send confirmation to admin
  if (adminClient.ws.readyState === WebSocket.OPEN) {
    adminClient.ws.send(JSON.stringify({
      type: 'admin_action_result',
      success: true,
      message: `${targetClient.username} has been unbanned`
    }));
  }
}

// Clean up dead connections every 15 seconds
setInterval(() => {
  const now = Date.now();
  const timeout = 15000; // 15 seconds
  
  for (const [clientId, client] of clients.entries()) {
    if (client.room && client.lastHeartbeat) {
      if (now - client.lastHeartbeat > timeout) {
        console.log(`Cleaning up inactive client: ${client.username}`);
        handleDisconnect(clientId);
      }
    }
  }
}, 15000);

// Status endpoint - shows server stats
server.on('request', (req, res) => {
  const pathname = url.parse(req.url).pathname;
  
  res.setHeader('Content-Type', pathname === '/status' ? 'application/json' : 'text/plain');
  
  if (pathname === '/status') {
    res.statusCode = 200;
    res.end(JSON.stringify({
      status: 'online',
      connections: clients.size,
      rooms: rooms.size,
      uptime: process.uptime(),
      memory: process.memoryUsage()
    }, null, 2));
  } else {
    res.statusCode = 200;
    res.end('WebSocket Relay Server\n\nConnected clients: ' + clients.size + '\nActive rooms: ' + rooms.size);
  }
});

server.listen(PORT, () => {
  console.log(`WebSocket Relay Server running on port ${PORT}`);
  console.log(`ws://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  wss.close(() => {
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
});
