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
const logs = [];

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
  const logEntry = {
    timestamp: new Date().toISOString(),
    type,
    data
  };
  logs.push(logEntry);
  
  // Keep only last 1000 logs
  if (logs.length > 1000) {
    logs.shift();
  }
  
  console.log(`[${logEntry.timestamp}] ${type}:`, data);
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
    ip,
    connectedAt: Date.now()
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
      
    case 'get_logs':
      handleGetLogs(clientId, data);
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
    const { room, username, status } = data;  // ADD status HERE
    
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
    client.status = status || 'player';  // ADD THIS LINE
  
  // Add to room
  if (!rooms.has(room)) {
    rooms.set(room, new Set());
    chatHistory.set(room, []);
  }
  rooms.get(room).add(clientId);
  
  log('JOIN', { clientId, username: client.username, room });
  
  // Get room players
  const players = Array.from(rooms.get(room))
    .map(id => {
      const c = clients.get(id);
      return {
        id: c.id,
        username: c.username
      };
    });
  
  // Send join confirmation to client
  client.ws.send(JSON.stringify({
    type: 'joined',
    room,
    players,
    chatHistory: chatHistory.get(room).slice(-50) // Last 50 messages
  }));
  
  // Notify others in room
  broadcast(room, {
    type: 'player_joined',
    player: {
      id: client.id,
      username: client.username
    }
  }, clientId);
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
        status: client.status || 'player',  // ADD THIS LINE
        clientId,
        message: message.substring(0, 500),
        timestamp: Date.now()
    };
  
  // Store in history
  const history = chatHistory.get(client.room);
  history.push(chatMessage);
  if (history.length > 100) {
    history.shift();
  }
  
  log('CHAT', { room: client.room, username: client.username, message });
  
  // Broadcast to room
  broadcast(client.room, {
    type: 'chat_message',
    message: chatMessage
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

function handleGetLogs(clientId, data) {
  const client = clients.get(clientId);
  
  // Only allow if client has admin privileges (you can add auth here)
  const limit = Math.min(data.limit || 100, 1000);
  const recentLogs = logs.slice(-limit);
  
  client.ws.send(JSON.stringify({
    type: 'logs',
    logs: recentLogs
  }));
}

function handleDisconnect(clientId) {
  const client = clients.get(clientId);
  if (!client) return;
  
  log('DISCONNECT', { clientId, username: client.username });
  
  handleLeave(clientId);
  clients.delete(clientId);
}

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
