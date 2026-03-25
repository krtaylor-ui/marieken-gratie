// =============================================================================
// server.js — Marieke's Gratie game server
// =============================================================================
'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');

const {
  dealGame, determineFirstPlayer, handleRedeal, handleStockCycle, recycleWaste,
} = require('./game/deck');

const {
  isLegalMove, canRequestRedeal, canRequestCycle, canForfeit, checkWinCondition,
} = require('./game/rules');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports:   ['polling'],
  pingTimeout:  60000,
  pingInterval: 25000,
});
app.use(express.static('public'));

// =============================================================================
// Room registry
// =============================================================================
const rooms       = new Map(); // code → Room
const socketToRoom = new Map(); // socketId → code

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({length:6}, () => chars[Math.floor(Math.random()*chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

function opponent(n) { return n === 1 ? 2 : 1; }

function getRoomForSocket(sid)       { const c = socketToRoom.get(sid); return c ? rooms.get(c) : null; }
function getPlayerNum(room, sid)     { if (room.players[1]?.socketId===sid) return 1; if (room.players[2]?.socketId===sid) return 2; return null; }
function msgPlayer(room, n, ev, d)   { const p=room.players[n]; if (p?.socketId) io.to(p.socketId).emit(ev,d); }
function broadcastRoom(room, ev, d)  { io.to(room.code).emit(ev,d); }
function sanitiseName(raw)           { return (typeof raw==='string' ? raw.trim().slice(0,20) : '') || 'Player'; }

function statePayload(room, lastEvent='update', lastMove=null) {
  const names = { 1: room.players[1]?.name||'Player 1', 2: room.players[2]?.name||'Player 2' };
  // tableTheme: non-first-player's theme sets the table felt/watermark
  const tableTheme = room.players[2]?.theme || room.players[1]?.theme || 'classic';
  // playerThemes: each player's own theme for their card backs
  const playerThemes = {
    1: room.players[1]?.theme || 'classic',
    2: room.players[2]?.theme || 'classic',
  };
  return { ...room.gameState, names, tableTheme, playerThemes, lastEvent, lastMove };
}
function broadcastState(room, lastEvent='update', lastMove=null) {
  broadcastRoom(room, 'gameStateUpdate', statePayload(room, lastEvent, lastMove));
}

function destroyRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.players[1]) socketToRoom.delete(room.players[1].socketId);
  if (room.players[2]) socketToRoom.delete(room.players[2].socketId);
  rooms.delete(code);
  console.log(`Room ${code} destroyed. Active rooms: ${rooms.size}`);
}

// =============================================================================
// Game helpers
// =============================================================================
function autoFlipForPlayer(playerNum, gs) {
  const ps = gs.players[playerNum];
  if (gs.turn.activeHandCard) return;
  if (ps.hand.length === 0) { recycleWaste(gs, playerNum); if (ps.hand.length===0) return; }
  const card = ps.hand.pop(); card.faceUp = true; gs.turn.activeHandCard = card;
}

function advanceTurn(gs) {
  const now = Date.now(); const next = opponent(gs.turn.player);
  if (gs.turn.turnStartTime) { const e=now-gs.turn.turnStartTime; gs.timing[gs.turn.player]+=e; gs.timing.turns[gs.turn.player]+=1; }
  gs.turn = { ...gs.turn, player:next, movesThisAction:0, cardMoved:false, cycleUsed:false, redalUsed:false, activeHandCard:null, turnStartTime:now };
  autoFlipForPlayer(next, gs);
}

function getMovingCard(move, gs) {
  const ps = gs.players[move.player];
  if (move.from.type==='stock')      return ps.stock.at(-1)||null;
  if (move.from.type==='activeHand') return gs.turn.activeHandCard||null;
  if (move.from.type==='tableau')    return gs.tableau[move.from.column]?.at(-1)||null;
  return null;
}

function applyMove(move, gs) {
  const { player, from, to } = move;
  const ps=gs.players[player], ops=gs.players[opponent(player)];
  let card, eventType='cardMove';
  switch(from.type) {
    case 'stock':      card=ps.stock.pop(); if(ps.stock.length>0) ps.stock.at(-1).faceUp=true; break;
    case 'activeHand': card=gs.turn.activeHandCard; gs.turn.activeHandCard=null; autoFlipForPlayer(player,gs); break;
    case 'tableau':    card=gs.tableau[from.column].pop(); break;
  }
  card.faceUp=true;
  switch(to.type) {
    case 'foundation':    gs.foundations[to.pile].push(card); eventType='cardToFoundation'; break;
    case 'tableau':       gs.tableau[to.column].push(card); break;
    case 'opponentStock': ops.stock.push(card); eventType='cardToOpponent'; break;
    case 'opponentWaste': ops.waste.push(card); eventType='cardToOpponent'; break;
  }
  gs.turn.cardMoved=true; gs.turn.movesThisAction+=1;
  if (from.type!=='activeHand') recycleWaste(gs,player);
  return eventType;
}

function startGame(room) {
  const gs = dealGame(null); determineFirstPlayer(gs);
  gs.phase='playing'; gs.timing={1:0,2:0,turns:{1:0,2:0}}; gs.turn.turnStartTime=Date.now();
  autoFlipForPlayer(gs.turn.player, gs); room.gameState=gs;
  console.log(`Room ${room.code}: game started — first player: ${gs.turn.player}`);
}

// =============================================================================
// Connection
// =============================================================================
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // List open rooms (waiting for player 2)
  socket.on('listRooms', () => {
    const open = [];
    for (const [code, room] of rooms) {
      if (!room.players[2]) open.push({ code, gameType:room.gameType, hostName:room.players[1]?.name||'Unknown', createdAt:room.createdAt });
    }
    socket.emit('roomList', open);
  });

  // Create a room
  socket.on('createRoom', ({ name, gameType='marieken-gratie', theme='classic' }) => {
    const existing = getRoomForSocket(socket.id);
    if (existing) handleLeave(socket, existing);

    const code = generateCode();
    rooms.set(code, { code, gameType, gameState:null, players:{1:null,2:null}, createdAt:Date.now() });
    const room = rooms.get(code);
    const safeName = sanitiseName(name);
    room.players[1] = { socketId:socket.id, name:safeName, theme:theme };
    socketToRoom.set(socket.id, code);
    socket.join(code);
    console.log(`Room ${code} created by "${safeName}"`);
    socket.emit('roomCreated', { roomCode:code, playerNum:1, name:safeName });
  });

  // Join an existing room
  socket.on('joinRoom', ({ roomCode, name, theme='classic' }) => {
    const code = (roomCode||'').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room)           { socket.emit('joinError', { reason:`Room "${code}" not found. Check the code and try again.` }); return; }
    if (room.players[2]) { socket.emit('joinError', { reason:`Room "${code}" is already full.` }); return; }

    const existing = getRoomForSocket(socket.id);
    if (existing) handleLeave(socket, existing);

    const safeName = sanitiseName(name);
    room.players[2] = { socketId:socket.id, name:safeName, theme:theme };
    socketToRoom.set(socket.id, code);
    socket.join(code);
    console.log(`Room ${code}: "${safeName}" joined as player 2`);
    socket.emit('roomJoined', { roomCode:code, playerNum:2, name:safeName });
    startGame(room);
    broadcastState(room, 'gameStart');
  });

  // Helper — wrap game events with room/player lookup
  function req(cb) {
    const room = getRoomForSocket(socket.id); if (!room||!room.gameState) return;
    const pn   = getPlayerNum(room, socket.id); if (!pn) return;
    cb(room, pn, room.gameState);
  }

  socket.on('makeMove', (data) => req((room,pn,gs) => {
    const move={player:pn,...data}, check=isLegalMove(move,gs);
    if (!check.legal) { msgPlayer(room,pn,'moveRejected',{reason:check.reason}); return; }
    const movedCard=getMovingCard(move,gs), eventType=applyMove(move,gs);
    const lastMove={card:movedCard,from:move.from,to:move.to,player:pn};
    if (checkWinCondition(pn,gs)) {
      gs.phase='gameOver'; gs.winner=pn;
      if (gs.turn.turnStartTime) { gs.timing[pn]+=Date.now()-gs.turn.turnStartTime; gs.timing.turns[pn]+=1; }
      broadcastState(room,'gameOver',lastMove); return;
    }
    broadcastState(room,eventType,lastMove);
  }));

  socket.on('endTurn', () => req((room,pn,gs) => {
    if (gs.turn.player!==pn) { msgPlayer(room,pn,'moveRejected',{reason:"It's not your turn"}); return; }
    if (gs.phase!=='playing') return;
    if (!gs.turn.activeHandCard) { msgPlayer(room,pn,'moveRejected',{reason:'No active card'}); return; }
    const activeCard=gs.turn.activeHandCard;
    gs.players[pn].waste.push(activeCard); gs.turn.activeHandCard=null;
    const lastMove={card:activeCard,from:{type:'activeHand'},to:{type:'waste'},player:pn};
    advanceTurn(gs); broadcastState(room,'turnEnd',lastMove);
  }));

  socket.on('requestRedeal', () => req((room,pn,gs) => {
    const check=canRequestRedeal(pn,gs); if (!check.legal) { msgPlayer(room,pn,'moveRejected',{reason:check.reason}); return; }
    gs.phase='pendingRedeal'; gs.pendingRequest={type:'redeal',requestedBy:pn}; gs.turn.redalUsed=true;
    broadcastState(room,'update');
  }));

  socket.on('requestCycle', () => req((room,pn,gs) => {
    const check=canRequestCycle(pn,gs); if (!check.legal) { msgPlayer(room,pn,'moveRejected',{reason:check.reason}); return; }
    gs.phase='pendingCycle'; gs.pendingRequest={type:'cycle',requestedBy:pn}; gs.turn.cycleUsed=true;
    broadcastState(room,'update');
  }));

  socket.on('respondToRequest', ({accepted}) => req((room,pn,gs) => {
    if (!gs.pendingRequest?.type) return;
    if (!accepted) { gs.phase='playing'; gs.pendingRequest={type:null,requestedBy:null}; broadcastState(room,'update'); return; }
    if (gs.pendingRequest.type==='redeal') {
      handleRedeal(gs); gs.phase='playing'; gs.pendingRequest={type:null,requestedBy:null}; autoFlipForPlayer(gs.turn.player,gs); broadcastState(room,'gameStart');
    } else if (gs.pendingRequest.type==='cycle') {
      handleStockCycle(gs); gs.phase='playing'; gs.pendingRequest={type:null,requestedBy:null}; autoFlipForPlayer(gs.turn.player,gs); broadcastState(room,'update');
    }
  }));

  socket.on('requestForfeit', () => req((room,pn,gs) => {
    const check=canForfeit(pn,gs); if (!check.legal) { msgPlayer(room,pn,'moveRejected',{reason:check.reason}); return; }
    msgPlayer(room,pn,'confirmForfeit',{});
  }));

  socket.on('confirmForfeit', () => req((room,pn,gs) => {
    const check=canForfeit(pn,gs); if (!check.legal) { msgPlayer(room,pn,'moveRejected',{reason:check.reason}); return; }
    gs.phase='gameOver'; gs.winner=opponent(pn);
    console.log(`Room ${room.code}: player ${pn} forfeited`);
    broadcastState(room,'gameOver');
  }));

  socket.on('requestRestart', () => req((room,pn,gs) => {
    if (gs.phase!=='gameOver') return;
    startGame(room); broadcastRoom(room,'restarted',{}); broadcastState(room,'gameStart');
  }));

  socket.on('returnToLobby', () => {
    const room = getRoomForSocket(socket.id);
    if (room) handleLeave(socket, room);
    socket.emit('lobbyReady');
  });

  socket.on('disconnect', () => {
    const room = getRoomForSocket(socket.id);
    if (room) handleLeave(socket, room);
    console.log(`Socket disconnected: ${socket.id}`);
  });

  function handleLeave(socket, room) {
    const pn = getPlayerNum(room, socket.id); if (!pn) return;
    socketToRoom.delete(socket.id); socket.leave(room.code);
    const opn = opponent(pn), oppPresent = !!room.players[opn];
    console.log(`Room ${room.code}: player ${pn} ("${room.players[pn]?.name}") left`);
    room.players[pn] = null;
    if (oppPresent && room.gameState && room.gameState.phase!=='gameOver') {
      room.gameState.phase='gameOver'; room.gameState.winner=opn;
      broadcastState(room,'opponentLeft');
      setTimeout(() => destroyRoom(room.code), 30000);
    } else {
      destroyRoom(room.code);
    }
  }
});

// Periodic cleanup of rooms older than 2 hours
setInterval(() => {
  const cutoff = Date.now() - 2*60*60*1000;
  for (const [code,room] of rooms) if (room.createdAt<cutoff) { console.log(`Cleaning stale room ${code}`); destroyRoom(code); }
}, 15*60*1000);

const PORT = process.env.PORT || 3000;
console.log('Starting — ENV PORT:', process.env.PORT, '→ binding to:', PORT);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n========================================\n  Marieke's Gratie server running\n  http://localhost:${PORT}\n========================================\n`);
});
