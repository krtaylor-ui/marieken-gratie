// =============================================================================
// rules.js — Move validation engine for Russian Bank
// =============================================================================
//
// This file answers one question: "Is this move legal?"
// It never modifies game state — that is server.js's job.
//
// A MOVE object always looks like:
// {
//   player: 1,
//   from: { type: 'stock' }                      ← source pile
//   from: { type: 'hand' }
//   from: { type: 'waste' }
//   from: { type: 'tableau', column: 2 }
//
//   to:   { type: 'foundation', pile: 3 }         ← destination pile
//   to:   { type: 'tableau', column: 5 }
//   to:   { type: 'opponentStock' }
//   to:   { type: 'opponentWaste' }
// }
//
// The card being moved is always the TOP card of the source pile.
// (Bottom-most exposed card for tableau — same thing since tableau
//  stores cards with the playable card at the end of the array.)
// =============================================================================

'use strict';

const { isRed, isBlack } = require('./deck');


// =============================================================================
// MASTER VALIDATOR
// The only function server.js needs to call directly.
// Returns { legal: true } or { legal: false, reason: 'explanation' }
// =============================================================================

function isLegalMove(move, gameState) {

  // --- Basic sanity checks ---
  const validation = validateMoveStructure(move, gameState);
  if (!validation.legal) return validation;

  // --- Get the card being moved ---
  const card = getSourceCard(move, gameState);
  if (!card) {
    return illegal('No card found at source pile');
  }

  // --- Route to the appropriate destination rule ---
  const { to } = move;

  switch (to.type) {
    case 'foundation':
      return checkFoundation(card, to.pile, gameState);

    case 'tableau':
      return checkTableau(card, move.from, to.column, move.player, gameState);

    case 'opponentStock':
      return checkOpponentPile(card, getOpponentStock(move.player, gameState));

    case 'opponentWaste':
      return checkOpponentPile(card, getOpponentWaste(move.player, gameState));

    default:
      return illegal(`Unknown destination type: ${to.type}`);
  }
}


// =============================================================================
// RULE 1: Foundation
// Any Ace can start an empty foundation pile.
// After that: same suit, exactly one rank higher than current top.
// =============================================================================

function checkFoundation(card, pileIndex, gameState) {
  const pile = gameState.foundations[pileIndex];

  if (pile.length === 0) {
    // Only an Ace can start a foundation
    if (card.rank !== 1) {
      return illegal('Only an Ace can start a foundation pile');
    }
    return legal();
  }

  const top = pile.at(-1);

  if (card.suit !== top.suit) {
    return illegal(`Foundation pile is ${top.suit} — cannot play ${card.suit}`);
  }

  if (card.rank !== top.rank + 1) {
    return illegal(`Foundation needs rank ${top.rank + 1}, got ${card.rank}`);
  }

  return legal();
}


// =============================================================================
// RULE 2: Tableau
// Occupied column: alternating colour, exactly one rank lower than column's
//                  bottom exposed card.
// Empty column:    any tableau card or stock top;
//                  hand cards only if stock is empty.
// =============================================================================

function checkTableau(card, from, targetColumn, player, gameState) {
  const column = gameState.tableau[targetColumn];

  // --- Can't move a card to the same column it came from ---
  if (from.type === 'tableau' && from.column === targetColumn) {
    return illegal('Cannot move a card to its own column');
  }

  if (column.length === 0) {
    return checkEmptyTableau(card, from, player, gameState);
  }

  const bottomCard = column.at(-1);  // the exposed (playable) card

  // Must be exactly one rank lower
  if (card.rank !== bottomCard.rank - 1) {
    return illegal(
      `Tableau needs rank ${bottomCard.rank - 1}, got ${card.rank}`
    );
  }

  // Must be opposite colour (standard solitaire rule)
  if (isRed(card) === isRed(bottomCard)) {
    return illegal('Tableau requires alternating colours');
  }

  return legal();
}

function checkEmptyTableau(card, from, player, gameState) {
  // Tableau cards can always fill an empty column
  if (from.type === 'tableau') return legal();

  // Stock top can always fill an empty column
  if (from.type === 'stock') return legal();

  // Active hand card can always fill an empty column
  if (from.type === 'activeHand') return legal();

  // Direct hand source is no longer valid — must flip first
  if (from.type === 'hand') {
    return illegal('Flip your hand card first before playing it');
  }

  // Waste is never playable on your own turn
  if (from.type === 'waste') {
    return illegal('Your waste pile is not playable on your turn');
  }

  return illegal('Cannot move that card to an empty tableau column');
}


// =============================================================================
// RULE 3: Opponent's stock or waste
// Same suit, within 1 rank (one higher OR one lower).
// Target pile must not be empty.
// =============================================================================

function checkOpponentPile(card, targetPile) {
  if (targetPile.length === 0) {
    return illegal('Cannot play to an empty opponent pile');
  }

  const top = targetPile.at(-1);

  if (card.suit !== top.suit) {
    return illegal(
      `Opponent pile is ${top.suit} — must match suit to play there`
    );
  }

  if (Math.abs(card.rank - top.rank) !== 1) {
    return illegal(
      `Must be within 1 rank of opponent's card (${top.rank}), got ${card.rank}`
    );
  }

  return legal();
}


// =============================================================================
// SOURCE CARD RETRIEVAL
// Gets the top (playable) card from a source pile without removing it.
// =============================================================================

function getSourceCard(move, gameState) {
  const { from, player } = move;
  const playerState = gameState.players[player];

  switch (from.type) {
    case 'stock':
      return playerState.stock.at(-1) || null;

    case 'activeHand':
      return gameState.turn.activeHandCard || null;

    case 'waste':
      return null;  // waste never playable on your own turn

    case 'tableau': {
      const col = gameState.tableau[from.column];
      return col.at(-1) || null;
    }

    default:
      return null;
  }
}


// =============================================================================
// STRUCTURE VALIDATION
// Checks that the move is well-formed and the player is allowed to act.
// =============================================================================

function validateMoveStructure(move, gameState) {
  const { player, from, to } = move;

  // Must be this player's turn
  if (gameState.turn.player !== player) {
    return illegal("It's not your turn");
  }

  // Game must be in playing phase
  if (gameState.phase !== 'playing') {
    return illegal(`Cannot move cards during phase: ${gameState.phase}`);
  }

  // from and to must exist
  if (!from || !to) {
    return illegal('Move must have a from and to');
  }

  // Player cannot play from their own waste pile
  if (from.type === 'waste') {
    return illegal('Your waste pile is not playable on your turn');
  }

  // Player cannot play from hand directly (must use flipCard first)
  if (from.type === 'hand') {
    return illegal('Flip your hand card first before playing it');
  }

  // Player cannot play FROM opponent's piles
  const opponentPiles = ['opponentStock', 'opponentWaste'];
  if (opponentPiles.includes(from.type)) {
    return illegal("Cannot move cards from your opponent's piles");
  }

  // Player cannot play TO their own waste (waste receives cards only via
  // the end-of-turn flip from hand, which is handled separately in server.js)
  if (to.type === 'waste') {
    return illegal('Cannot play directly to your own waste pile');
  }

  // Validate tableau column indices if provided
  if (from.type === 'tableau') {
    if (from.column < 0 || from.column > 7) {
      return illegal(`Invalid tableau column: ${from.column}`);
    }
    const col = gameState.tableau[from.column];
    if (col.length === 0) {
      return illegal(`Tableau column ${from.column} is empty`);
    }
  }

  if (to.type === 'tableau') {
    if (to.column < 0 || to.column > 7) {
      return illegal(`Invalid tableau column: ${to.column}`);
    }
  }

  // Validate foundation pile index if provided
  if (to.type === 'foundation') {
    if (to.pile < 0 || to.pile > 7) {
      return illegal(`Invalid foundation pile: ${to.pile}`);
    }
  }

  return legal();
}


// =============================================================================
// TURN-LEVEL VALIDATORS
// Called by server.js to check actions that aren't card moves.
// =============================================================================

// Can the player request a Redeal right now?
function canRequestRedeal(player, gameState) {
  if (gameState.turn.player !== player) {
    return illegal("It's not your turn");
  }
  if (gameState.phase !== 'playing') {
    return illegal('Cannot request redeal during this phase');
  }
  if (gameState.turn.cardMoved) {
    return illegal('Redeal can only be requested before moving any cards');
  }
  if (gameState.turn.redalUsed) {
    return illegal('Redeal already requested this turn');
  }
  return legal();
}

// Can the player request a Stock Cycle right now?
function canRequestCycle(player, gameState) {
  if (gameState.turn.player !== player) {
    return illegal("It's not your turn");
  }
  if (gameState.phase !== 'playing') {
    return illegal('Cannot request Stock Cycle during this phase');
  }
  if (gameState.turn.cardMoved) {
    return illegal('Stock Cycle can only be requested before moving any cards');
  }
  if (gameState.turn.cycleUsed) {
    return illegal('Stock Cycle already requested this turn');
  }
  return legal();
}

// Can the player forfeit right now?
function canForfeit(player, gameState) {
  if (gameState.turn.player !== player) {
    return illegal("It's not your turn");
  }
  // Forfeit is allowed in any active phase
  const activePhrases = ['playing', 'pendingRedeal', 'pendingCycle'];
  if (!activePhrases.includes(gameState.phase)) {
    return illegal('Cannot forfeit during this phase');
  }
  return legal();
}

// Can the player flip the top card from hand to waste?
// (This is the mandatory action at the start of each turn)
function canFlipHandToWaste(player, gameState) {
  if (gameState.turn.player !== player) {
    return illegal("It's not your turn");
  }
  if (gameState.phase !== 'playing') {
    return illegal('Cannot flip cards during this phase');
  }
  const playerState = gameState.players[player];
  if (playerState.hand.length === 0) {
    return illegal('Hand is empty — nothing to flip');
  }
  return legal();
}


// =============================================================================
// WIN CONDITION CHECK
// Returns true if the given player has emptied all three of their piles.
// =============================================================================

function checkWinCondition(player, gameState) {
  const p = gameState.players[player];
  return (
    p.stock.length === 0 &&
    p.hand.length  === 0 &&
    p.waste.length === 0 &&
    gameState.turn.activeHandCard === null  // active card still counts as a card in play
  );
}


// =============================================================================
// HELPER UTILITIES
// =============================================================================

function getOpponentStock(player, gameState) {
  const opponent = player === 1 ? 2 : 1;
  return gameState.players[opponent].stock;
}

function getOpponentWaste(player, gameState) {
  const opponent = player === 1 ? 2 : 1;
  return gameState.players[opponent].waste;
}

// Convenience constructors for return values
function legal()          { return { legal: true }; }
function illegal(reason)  { return { legal: false, reason }; }


// =============================================================================
// Exports
// =============================================================================

module.exports = {
  isLegalMove,
  canRequestRedeal,
  canRequestCycle,
  canForfeit,
  canFlipHandToWaste,
  checkWinCondition,
  // Exported for testing
  checkFoundation,
  checkTableau,
  checkOpponentPile,
};
