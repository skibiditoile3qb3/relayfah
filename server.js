const WebSocket = require('ws');
const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 8080;

// Create HTTP server
const server = http.createServer();

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Store connections
const clients = new Map();
const rooms = new Map();
const chatHistory = new Map();

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
      
    case 'game_state':
      handleGameState(clientId, data);
      break;
      
    case 'player_action':
      handlePlayerAction(clientId, data);
      break;

    case 'heartbeat':
      handleHeartbeat(clientId);
      break;

    case 'donation':
      handleDonation(clientId, data);
      break;
      
    case 'get_players':
      handleGetPlayers(clientId);
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

function handleJoin(clientId, data) {
  const client = clients.get(clientId);
  const { room, username, status } = data;
  
  if (!room) {
    client.ws.send(JSON.stringify({
      type: 'error',
      message: 'Room ID required'
    }));
    return;
  }
  
  // Leave current room if in one
  if (client.room) {
    handleLeave(clientId);
  }
  
  // Update client data
  client.room = room;
  client.username = username || `Player${clientId.substring(0, 6)}`;
  client.status = status || 'player';
  client.lastHeartbeat = Date.now();
  
  // Add to room
  if (!rooms.has(room)) {
    rooms.set(room, new Set());
    chatHistory.set(room, []);
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
        status: c.status
      };
    });
  
  // Send join confirmation to client
  client.ws.send(JSON.stringify({
    type: 'joined',
    room,
    players,
    chatHistory: chatHistory.get(room).slice(-50)
  }));
  
  // Notify others in room
  broadcast(room, {
    type: 'player_joined',
    player: {
      id: client.id,
      username: client.username,
      status: client.status
    }
  }, clientId);
  
  // Send initial player count to everyone
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
      chatHistory.delete(room);
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
            status: c.status
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

function handleChat(clientId, data) {
  const client = clients.get(clientId);
  if (!client || !client.room) return;
  
  const { message } = data;
  if (!message || message.trim().length === 0) return;
  
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
  
  // Store in history
  const history = chatHistory.get(client.room);
  history.push(chatMessage);
  if (history.length > 100) {
    history.shift();
  }
  
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

function handleHeartbeat(clientId) {
  const client = clients.get(clientId);
  if (!client || !client.room) return;
  
  // Update last activity
  client.lastHeartbeat = Date.now();
  
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
        status: c.status
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
  
  const { targetUsername, amount, donationType, from, senderStatus } = data;
  
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
        status: c.status
      };
    });
  
  client.ws.send(JSON.stringify({
    type: 'players_update',
    players
  }));
}

function handleDisconnect(clientId) {
  const client = clients.get(clientId);
  if (!client) return;
  
  log('DISCONNECT', { clientId, username: client.username });
  
  handleLeave(clientId);
  clients.delete(clientId);
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
      
      case 'unban':  // ADD THIS CASE
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
  
  // ✅ OWNER CAN BAN ANYONE (including staff)
  if (adminRank === 'owner') {
    // Owner bypasses all restrictions - skip to ban logic below
  } else if (adminRank === 'admin' && ['moderator', 'admin', 'sr.admin', 'owner'].includes(targetRank)) {
    adminClient.ws.send(JSON.stringify({
      type: 'admin_action_result',
      success: false,
      message: 'Cannot ban staff members'
    }));
    return;
  } else if (adminRank === 'sr.admin' && ['sr.admin', 'owner'].includes(targetRank)) {
    adminClient.ws.send(JSON.stringify({
      type: 'admin_action_result',
      success: false,
      message: 'Cannot ban Sr. Admins or Owner'
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
    target: targetClient.username,
    targetRank: targetRank,  // ✅ Log target rank for reference
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
  const { hours } = data;
  
  // Send directly to target
  if (targetClient.ws.readyState === WebSocket.OPEN) {
    targetClient.ws.send(JSON.stringify({
      type: 'muted',
      until: Date.now() + (hours * 60 * 60 * 1000),
      mutedBy: data.adminUsername,
      hours: hours
    }));
  }
 
  
  // Log mute
  log('ADMIN_ACTION', {
    action: 'MUTE',
    admin: data.adminUsername,
    target: targetClient.username,
    hours: hours
  });
  
  // Send confirmation to admin
  if (adminClient.ws.readyState === WebSocket.OPEN) {
    adminClient.ws.send(JSON.stringify({
      type: 'admin_action_result',
      success: true,
      message: `${targetClient.username} muted for ${hours} hours`
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
