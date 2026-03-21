// =============================================================================
// server.js — Russian Bank game server
// =============================================================================
//
// This file is responsible for:
//   1. Serving the frontend (index.html) to browsers
//   2. Managing the WebSocket connections for both players
//   3. Holding the authoritative game state
//   4. Validating moves via rules.js before applying them
//   5. Broadcasting updated state to both players after every change
//
// FLOW FOR EVERY PLAYER ACTION:
//   Client emits event → server validates → server mutates state → 
//   server broadcasts new state to both clients → clients re-render
//
// The client NEVER updates its own state directly.
// =============================================================================

'use strict';

console.log('ALL ENV VARS:', JSON.stringify(process.env));

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');

const {
  dealGame,
  determineFirstPlayer,
  handleRedeal,
  handleStockCycle,
  recycleWaste,
} = require('./game/deck');

const {
  isLegalMove,
  canRequestRedeal,
  canRequestCycle,
  canForfeit,
  canFlipHandToWaste,
  checkWinCondition,
} = require('./game/rules');


// =============================================================================
// Server setup
// =============================================================================

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // Use polling only — works reliably behind Railway's reverse proxy.
  // WebSocket upgrades are blocked by Railway's load balancer.
  transports: ['polling'],
  pingTimeout:  60000,
  pingInterval: 25000,
});

app.use(express.static('public'));


// =============================================================================
// Game state
// Kept here at module level — this is the single source of truth.
// Both player sockets read from and write to this object (via the server).
// =============================================================================

let gameState = null;   // null until both players have connected

// Maps socket.id → player number (1 or 2)
// We need this to know which player is behind each socket event.
const socketToPlayer = {};

// Maps player number → socket.id (reverse lookup)
const playerToSocket = {};


// =============================================================================
// Helpers
// =============================================================================

// Send the full game state to both connected players.
// This is called after EVERY state change.
function broadcastState() {
  io.emit('gameStateUpdate', gameState);
}

// Send a message to one specific player only.
function messagePlayer(playerNum, event, data) {
  const socketId = playerToSocket[playerNum];
  if (socketId) {
    io.to(socketId).emit(event, data);
  }
}

// Get the opponent's player number.
function opponent(playerNum) {
  return playerNum === 1 ? 2 : 1;
}

// Auto-flip the top hand card into activeHandCard for the given player.
// Called at turn start — no player action needed.
function autoFlipForPlayer(playerNum) {
  const playerState = gameState.players[playerNum];

  // Recycle waste into hand if hand is empty
  if (playerState.hand.length === 0) {
    recycleWaste(gameState, playerNum);
  }

  if (playerState.hand.length === 0) {
    // Nothing left to flip — hand and waste both empty
    // Win condition should catch this, but guard here too
    return;
  }

  const card = playerState.hand.pop();
  card.faceUp = true;
  gameState.turn.activeHandCard = card;
}

// Advance to the next player's turn, resetting all per-turn flags,
// and auto-flip the opening card for the new player.
function advanceTurn() {
  const nextPlayer = opponent(gameState.turn.player);
  gameState.turn = {
    ...gameState.turn,
    player:          nextPlayer,
    movesThisAction: 0,
    cardMoved:       false,
    cycleUsed:       false,
    redalUsed:       false,
    activeHandCard:  null,
  };
  autoFlipForPlayer(nextPlayer);
}

// Apply a validated card move to the game state.
// Removes card from source pile, adds to destination pile.
function applyMove(move) {
  const { player, from, to } = move;
  const playerState   = gameState.players[player];
  const oppState      = gameState.players[opponent(player)];

  // --- Remove card from source ---
  let card;
  switch (from.type) {
    case 'stock':
      card = playerState.stock.pop();
      // Auto-reveal the new top card of stock if any remain
      if (playerState.stock.length > 0) {
        playerState.stock.at(-1).faceUp = true;
      }
      break;

    case 'activeHand':
      // Playing the active hand card — clear it, then immediately flip
      // the next hand card so play can continue uninterrupted.
      card = gameState.turn.activeHandCard;
      gameState.turn.activeHandCard = null;
      // Auto-flip the next card (unless hand+waste are both empty — win state)
      autoFlipForPlayer(player);
      break;

    case 'tableau':
      card = gameState.tableau[from.column].pop();
      break;
  }

  // --- Add card to destination ---
  card.faceUp = true;  // all played cards are face-up

  switch (to.type) {
    case 'foundation':
      gameState.foundations[to.pile].push(card);
      break;

    case 'tableau':
      gameState.tableau[to.column].push(card);
      break;

    case 'opponentStock':
      oppState.stock.push(card);
      break;

    case 'opponentWaste':
      oppState.waste.push(card);
      break;
  }

  // --- Mark that a card has moved this turn ---
  gameState.turn.cardMoved       = true;
  gameState.turn.movesThisAction += 1;

  // --- Recycle waste → hand if hand is now empty (for non-activeHand moves) ---
  if (from.type !== 'activeHand') {
    recycleWaste(gameState, player);
  }
}


// =============================================================================
// Connection handling
// =============================================================================

io.on('connection', (socket) => {

  // --- Reject if room is already full ---
  const connectedCount = Object.keys(playerToSocket).length;
  if (connectedCount >= 2) {
    socket.emit('rejected', { reason: 'Game is full. Try again later.' });
    socket.disconnect();
    return;
  }

  // --- Assign player number ---
  const playerNum = connectedCount + 1;
  socketToPlayer[socket.id] = playerNum;
  playerToSocket[playerNum] = socket.id;

  console.log(`Player ${playerNum} connected (socket: ${socket.id})`);
  socket.emit('assigned', { playerNumber: playerNum });

  // --- Start the game when both players are present ---
  if (Object.keys(playerToSocket).length === 2) {
    console.log('Both players connected — dealing...');
    gameState = dealGame(null);
    determineFirstPlayer(gameState);
    console.log(`First player: ${gameState.turn.player}`);
    gameState.phase = 'playing';
    // Auto-flip opening card for the first player
    autoFlipForPlayer(gameState.turn.player);
    broadcastState();
  } else {
    // First player is waiting — let them know
    socket.emit('waiting', { message: 'Waiting for opponent to connect...' });
  }


  // =========================================================================
  // EVENT: makeMove
  // Player attempts to move a card.
  // Payload: { from: { type, column? }, to: { type, column?, pile? } }
  // =========================================================================
  socket.on('makeMove', (data) => {
    const playerNum = socketToPlayer[socket.id];
    const move      = { player: playerNum, ...data };

    // Validate
    const check = isLegalMove(move, gameState);
    if (!check.legal) {
      messagePlayer(playerNum, 'moveRejected', { reason: check.reason });
      return;
    }

    // Apply
    applyMove(move);

    // Check win condition
    if (checkWinCondition(playerNum, gameState)) {
      gameState.phase  = 'gameOver';
      gameState.winner = playerNum;
      broadcastState();
      return;
    }

    broadcastState();
  });


  // =========================================================================
  // EVENT: endTurn
  // Sends the active hand card to waste, then advances to next player
  // who gets their opening card auto-flipped.
  // =========================================================================
  socket.on('endTurn', () => {
    const playerNum   = socketToPlayer[socket.id];
    const playerState = gameState.players[playerNum];

    if (gameState.turn.player !== playerNum) {
      messagePlayer(playerNum, 'moveRejected', { reason: "It's not your turn" });
      return;
    }
    if (gameState.phase !== 'playing') {
      messagePlayer(playerNum, 'moveRejected', { reason: 'Cannot end turn during this phase' });
      return;
    }
    if (!gameState.turn.activeHandCard) {
      messagePlayer(playerNum, 'moveRejected', { reason: 'No active card to end turn with' });
      return;
    }

    // Send active card to waste
    playerState.waste.push(gameState.turn.activeHandCard);
    gameState.turn.activeHandCard = null;

    // Advance to next player and auto-flip their opening card
    advanceTurn();
    broadcastState();
  });


  // =========================================================================
  // EVENT: requestRedeal
  // Player requests a redeal at the start of their turn.
  // =========================================================================
  socket.on('requestRedeal', () => {
    const playerNum = socketToPlayer[socket.id];
    const check     = canRequestRedeal(playerNum, gameState);

    if (!check.legal) {
      messagePlayer(playerNum, 'moveRejected', { reason: check.reason });
      return;
    }

    gameState.phase                  = 'pendingRedeal';
    gameState.pendingRequest         = { type: 'redeal', requestedBy: playerNum };
    gameState.turn.redalUsed         = true;

    broadcastState();
  });


  // =========================================================================
  // EVENT: requestCycle
  // Player requests a Stock Cycle at the start of their turn.
  // =========================================================================
  socket.on('requestCycle', () => {
    const playerNum = socketToPlayer[socket.id];
    const check     = canRequestCycle(playerNum, gameState);

    if (!check.legal) {
      messagePlayer(playerNum, 'moveRejected', { reason: check.reason });
      return;
    }

    gameState.phase          = 'pendingCycle';
    gameState.pendingRequest = { type: 'cycle', requestedBy: playerNum };
    gameState.turn.cycleUsed = true;

    broadcastState();
  });


  // =========================================================================
  // EVENT: respondToRequest
  // Opponent responds Yes or No to a pending redeal or cycle request.
  // Payload: { accepted: true | false }
  // =========================================================================
  socket.on('respondToRequest', ({ accepted }) => {
    const playerNum    = socketToPlayer[socket.id];
    const requestingPlayer = gameState.pendingRequest.requestedBy;

    // Only the opponent of the requester can respond
    if (playerNum === requestingPlayer) {
      messagePlayer(playerNum, 'moveRejected', { reason: "You cannot respond to your own request" });
      return;
    }

    if (!['pendingRedeal', 'pendingCycle'].includes(gameState.phase)) {
      messagePlayer(playerNum, 'moveRejected', { reason: 'No pending request to respond to' });
      return;
    }

    if (accepted) {
      if (gameState.pendingRequest.type === 'redeal') {
        gameState = handleRedeal(gameState);
        // Auto-flip opening card for the first player of the new game
        autoFlipForPlayer(gameState.turn.player);
        console.log(`Redeal accepted — game #${gameState.gameNumber}, first player: ${gameState.turn.player}`);
      } else if (gameState.pendingRequest.type === 'cycle') {
        // Push current active card back to waste before cycling
        const currentPlayer = gameState.pendingRequest.requestedBy;
        const playerState   = gameState.players[currentPlayer];
        if (gameState.turn.activeHandCard) {
          playerState.waste.push(gameState.turn.activeHandCard);
          gameState.turn.activeHandCard = null;
        }
        handleStockCycle(gameState);
        // Auto-flip the new stock top as the active card
        autoFlipForPlayer(currentPlayer);
        console.log('Stock Cycle accepted');
      }
    } else {
      // Declined — just unfreeze
      gameState.phase          = 'playing';
      gameState.pendingRequest = { type: null, requestedBy: null };
      console.log(`${gameState.pendingRequest?.type || 'Request'} declined — play continues`);
    }

    broadcastState();
  });


  // =========================================================================
  // EVENT: requestForfeit
  // Player wants to forfeit — server sends confirmation request back to them.
  // =========================================================================
  socket.on('requestForfeit', () => {
    const playerNum = socketToPlayer[socket.id];
    const check     = canForfeit(playerNum, gameState);

    if (!check.legal) {
      messagePlayer(playerNum, 'moveRejected', { reason: check.reason });
      return;
    }

    // Ask the player to confirm (the UI shows a dialog)
    messagePlayer(playerNum, 'confirmForfeit', {});
  });


  // =========================================================================
  // EVENT: confirmForfeit
  // Player confirmed they want to forfeit.
  // =========================================================================
  socket.on('confirmForfeit', () => {
    const playerNum = socketToPlayer[socket.id];

    // Re-check they're still allowed to forfeit
    const check = canForfeit(playerNum, gameState);
    if (!check.legal) {
      messagePlayer(playerNum, 'moveRejected', { reason: check.reason });
      return;
    }

    gameState.phase  = 'gameOver';
    gameState.winner = opponent(playerNum);
    console.log(`Player ${playerNum} forfeited — Player ${gameState.winner} wins`);
    broadcastState();
  });


  // =========================================================================
  // EVENT: requestRestart
  // Either player clicking "Play Again" immediately starts a new game.
  // No confirmation needed from the other player.
  // =========================================================================
  socket.on('requestRestart', () => {
    const playerNum = socketToPlayer[socket.id];
    if (!gameState || gameState.phase !== 'gameOver') return;

    gameState = dealGame(null);
    determineFirstPlayer(gameState);
    gameState.phase = 'playing';
    autoFlipForPlayer(gameState.turn.player);
    console.log(`Restart by P${playerNum} — game #${gameState.gameNumber}, first player: ${gameState.turn.player}`);
    io.emit('restarted', {});
    broadcastState();
  });


  // =========================================================================
  // EVENT: disconnect
  // A player closed their browser tab or lost connection.
  // =========================================================================
  socket.on('disconnect', () => {
    const playerNum = socketToPlayer[socket.id];
    console.log(`Player ${playerNum} disconnected`);

    delete socketToPlayer[socket.id];
    delete playerToSocket[playerNum];

    // If a game was in progress, notify the remaining player
    if (gameState && gameState.phase !== 'gameOver') {
      gameState.phase  = 'gameOver';
      gameState.winner = opponent(playerNum);
      broadcastState();
      console.log(`Player ${playerNum} disconnected mid-game — Player ${gameState.winner} wins by default`);
    }

    // Reset so a new player can take this slot
    // (allows reconnection without restarting the server)
    gameState = null;
  });

});


// =============================================================================
// Start the server
// =============================================================================

const PORT = process.env.PORT || 3000;
console.log('Starting — ENV PORT:', process.env.PORT, '→ binding to:', PORT);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
========================================
  Russian Bank server running
  http://localhost:${PORT}
========================================
  `);
});
