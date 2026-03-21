// =============================================================================
// deck.js — Card creation, shuffling, dealing, and first-player determination
// =============================================================================
//
// CONCEPTS TO KNOW:
//   - This file uses CommonJS modules (require / module.exports) which is the
//     standard for Node.js. You'll see this pattern everywhere in Node.
//   - Arrays are used for all piles. Index 0 = bottom, last index = top.
//     e.g. pile.at(-1) gets the top card; pile.pop() removes the top card.
//   - We export functions at the bottom so server.js can import them.
// =============================================================================

'use strict';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
// Rank 1 = Ace, 11 = Jack, 12 = Queen, 13 = King

const RED_SUITS   = ['hearts', 'diamonds'];
const BLACK_SUITS = ['clubs',  'spades'];

const STOCK_SIZE   = 13;
const TABLEAU_COLS = 8;   // 4 dealt by each player


// -----------------------------------------------------------------------------
// createDeck(deckOwner)
//
// Returns an array of 52 card objects, all face-down, tagged with their owner.
// deckOwner: 1 or 2 — which player's deck this is.
//
// A card object always looks like:
//   { suit: 'hearts', rank: 7, faceUp: false, deckOwner: 1 }
// -----------------------------------------------------------------------------

function createDeck(deckOwner) {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, faceUp: false, deckOwner });
    }
  }
  return deck;  // 52 cards
}


// -----------------------------------------------------------------------------
// shuffle(deck)
//
// Randomises a deck in-place using the Fisher-Yates algorithm.
// This is the standard correct way to shuffle — a naive approach
// (sorting by Math.random()) produces a biased distribution.
//
// Fisher-Yates works by walking backwards through the array and swapping
// each element with a randomly chosen element at or before it.
// -----------------------------------------------------------------------------

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];  // ES6 destructuring swap
  }
  return deck;  // returns same array (modified in place) for convenience
}


// -----------------------------------------------------------------------------
// dealGame(firstPlayer)
//
// Builds and returns a complete starting gameState.
// firstPlayer: 1 or 2 — who takes the first turn.
//              Pass null on the very first game to run the tiebreaker.
//              Pass 1 or 2 on redeals (alternates from previous game).
//
// Deal sequence per player:
//   1. Shuffle their 52-card deck
//   2. Deal 13 cards face-down to stock; flip top card face-up
//   3. Deal 4 cards face-up to their 4 tableau columns
//   4. Remaining 35 cards go to hand (face-down)
// -----------------------------------------------------------------------------

function dealGame(firstPlayer = null) {

  // --- Build and shuffle both decks ---
  const deck1 = shuffle(createDeck(1));
  const deck2 = shuffle(createDeck(2));

  // --- Helper: deal N cards off the top of a deck (modifies deck in place) ---
  // Remember: we treat the END of the array as the top of the deck.
  function dealCards(deck, count) {
    return deck.splice(deck.length - count, count);
  }

  // --- Deal Player 1's stock (13 cards) ---
  const stock1 = dealCards(deck1, STOCK_SIZE);
  stock1[stock1.length - 1].faceUp = true;  // flip top card

  // --- Deal Player 2's stock (13 cards) ---
  const stock2 = dealCards(deck2, STOCK_SIZE);
  stock2[stock2.length - 1].faceUp = true;  // flip top card

  // --- Deal tableau ---
  // Columns 0-3 are started by Player 1 (one card each, face-up)
  // Columns 4-7 are started by Player 2 (one card each, face-up)
  // Deal order matters for first-player tiebreaking:
  //   P1 col 0 is dealt first, then P2 col 4, then P1 col 1, then P2 col 5...
  //   We store the deal order index on each card for tiebreaker comparison.

  const tableau = [[], [], [], [], [], [], [], []];

  // Interleave dealing so deal order is tracked correctly
  // P1 deals to cols 0,1,2,3 — P2 deals to cols 4,5,6,7
  // But we deal them in pairs so tiebreaker order is: col0 vs col4, col1 vs col5...
  const p1Cols = [0, 1, 2, 3];
  const p2Cols = [4, 5, 6, 7];

  for (let i = 0; i < 4; i++) {
    const card1 = dealCards(deck1, 1)[0];
    card1.faceUp = true;
    card1.dealOrder = i;  // used by tiebreaker: 0 = first dealt
    tableau[p1Cols[i]].push(card1);

    const card2 = dealCards(deck2, 1)[0];
    card2.faceUp = true;
    card2.dealOrder = i;
    tableau[p2Cols[i]].push(card2);
  }

  // --- Remaining cards go to each player's hand ---
  // deck1 and deck2 now each have 35 cards left (52 - 13 stock - 4 tableau)
  const hand1 = deck1;  // 35 cards, all face-down
  const hand2 = deck2;  // 35 cards, all face-down

  // --- Assemble the game state ---
  const gameState = {
    players: {
      1: {
        stock:      stock1,
        hand:       hand1,
        waste:      [],
        handCycles: 0,
      },
      2: {
        stock:      stock2,
        hand:       hand2,
        waste:      [],
        handCycles: 0,
      }
    },

    tableau,

    // 8 foundation piles — suit assigned dynamically when an Ace is played
    foundations: [[], [], [], [], [], [], [], []],

    turn: {
      player:          firstPlayer,  // null if tiebreaker needed
      firstPlayer:     firstPlayer,
      movesThisAction: 0,
      moveLimit:       null,         // null = unlimited (future variant hook)
      cardMoved:       false,        // true once any card moves this turn
      cycleUsed:       false,        // Stock Cycle used this turn
      redalUsed:       false,        // Redeal requested this turn
    },

    pendingRequest: {
      type:        null,  // 'redeal' | 'cycle' | 'forfeit' | null
      requestedBy: null,
    },

    // 'waiting'        — not enough players connected
    // 'determining'    — running first-player tiebreaker (flipping hand cards)
    // 'playing'        — active game
    // 'pendingRedeal'  — waiting for opponent to respond
    // 'pendingCycle'   — waiting for opponent to respond
    // 'pendingForfeit' — waiting for forfeiting player to confirm
    // 'gameOver'       — game finished
    phase:  firstPlayer === null ? 'determining' : 'playing',

    winner:     null,
    gameNumber: 1,
  };

  return gameState;
}


// -----------------------------------------------------------------------------
// determineFirstPlayer(gameState)
//
// Runs the tiebreaker chain to decide who goes first.
// Modifies gameState.turn.player and gameState.turn.firstPlayer in place.
// Returns the winning player number (1 or 2).
//
// Tiebreaker order:
//   1. Top of each player's stock (highest rank wins)
//   2. Tableau cards in deal order (col 0 vs col 4, col 1 vs col 5, ...)
//   3. Flip hand cards until ranks differ
// -----------------------------------------------------------------------------

function determineFirstPlayer(gameState) {
  const p1 = gameState.players[1];
  const p2 = gameState.players[2];

  // --- Step 1: Compare stock top cards ---
  const stockTop1 = p1.stock.at(-1);
  const stockTop2 = p2.stock.at(-1);

  const stockResult = compareRanks(stockTop1.rank, stockTop2.rank);
  if (stockResult !== 0) {
    return setFirstPlayer(gameState, stockResult > 0 ? 1 : 2);
  }

  // --- Step 2: Compare tableau cards in deal order ---
  // P1's cols 0-3 vs P2's cols 4-7, compared pair by pair
  for (let i = 0; i < 4; i++) {
    const p1Card = gameState.tableau[i][0];      // col 0,1,2,3
    const p2Card = gameState.tableau[i + 4][0];  // col 4,5,6,7

    const tableauResult = compareRanks(p1Card.rank, p2Card.rank);
    if (tableauResult !== 0) {
      return setFirstPlayer(gameState, tableauResult > 0 ? 1 : 2);
    }
  }

  // --- Step 3: Flip hand cards until ranks differ ---
  // We flip one card at a time from each player's hand.
  // Flipped cards go to a temporary comparison pile, NOT the waste pile,
  // because the turn hasn't started yet.
  // After a winner is found, all comparison cards go to each player's waste.

  const comparisonCards1 = [];
  const comparisonCards2 = [];

  while (p1.hand.length > 0 && p2.hand.length > 0) {
    const card1 = p1.hand.pop();
    const card2 = p2.hand.pop();
    card1.faceUp = true;
    card2.faceUp = true;
    comparisonCards1.push(card1);
    comparisonCards2.push(card2);

    const handResult = compareRanks(card1.rank, card2.rank);
    if (handResult !== 0) {
      // Move all comparison cards to waste
      p1.waste.push(...comparisonCards1);
      p2.waste.push(...comparisonCards2);
      return setFirstPlayer(gameState, handResult > 0 ? 1 : 2);
    }
  }

  // Extreme edge case: every single card tied. Default to Player 1.
  // This is astronomically unlikely with two independent shuffled decks.
  console.warn('All cards tied in tiebreaker — defaulting to Player 1');
  p1.waste.push(...comparisonCards1);
  p2.waste.push(...comparisonCards2);
  return setFirstPlayer(gameState, 1);
}


// -----------------------------------------------------------------------------
// handleRedeal(gameState)
//
// Resets the game with a fresh deal. First player alternates from previous game.
// Returns a brand new gameState.
// -----------------------------------------------------------------------------

function handleRedeal(gameState) {
  const previousFirst = gameState.turn.firstPlayer;
  const nextFirst     = previousFirst === 1 ? 2 : 1;
  const nextGameNum   = gameState.gameNumber + 1;

  const freshState = dealGame(nextFirst);
  freshState.gameNumber = nextGameNum;
  freshState.phase = 'playing';
  return freshState;
}


// -----------------------------------------------------------------------------
// handleStockCycle(gameState)
//
// Moves the top card of each player's stock to the bottom (if 2+ cards).
// Reveals the new top card. Modifies gameState in place.
// -----------------------------------------------------------------------------

function handleStockCycle(gameState) {
  for (const playerNum of [1, 2]) {
    const stock = gameState.players[playerNum].stock;

    if (stock.length >= 2) {
      const topCard = stock.pop();       // remove top card
      topCard.faceUp = false;            // face it down before burying
      stock.unshift(topCard);            // place at bottom (index 0)
      stock.at(-1).faceUp = true;        // reveal new top card
    }
    // If 0 or 1 cards: do nothing (exemption rule)
  }

  // Clear the pending request and unfreeze
  gameState.pendingRequest = { type: null, requestedBy: null };
  gameState.phase = 'playing';
}


// -----------------------------------------------------------------------------
// recycleWaste(gameState, playerNum)
//
// When a player's hand is empty, flip their waste pile to become the new hand.
// Waste is reversed (so first-wasted is now at bottom) and all cards face down.
// -----------------------------------------------------------------------------

function recycleWaste(gameState, playerNum) {
  const player = gameState.players[playerNum];

  if (player.hand.length === 0 && player.waste.length > 0) {
    // Reverse so the card that went to waste first is now at the bottom of hand
    player.hand = player.waste.reverse();
    player.hand.forEach(card => card.faceUp = false);
    player.waste = [];
    player.handCycles += 1;
    console.log(`Player ${playerNum} recycled waste → hand (cycle #${player.handCycles})`);
  }
}


// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

// compareRanks: returns positive if rank1 > rank2, negative if less, 0 if equal
function compareRanks(rank1, rank2) {
  return rank1 - rank2;
}

// setFirstPlayer: applies the decision to gameState and returns the player number
function setFirstPlayer(gameState, playerNum) {
  gameState.turn.player      = playerNum;
  gameState.turn.firstPlayer = playerNum;
  gameState.phase            = 'playing';
  console.log(`First player determined: Player ${playerNum}`);
  return playerNum;
}

// isRed / isBlack: used by rules.js for tableau alternating-colour validation
function isRed(card)   { return RED_SUITS.includes(card.suit); }
function isBlack(card) { return BLACK_SUITS.includes(card.suit); }


// -----------------------------------------------------------------------------
// Exports — these are the functions server.js and rules.js will import
// -----------------------------------------------------------------------------

module.exports = {
  createDeck,
  shuffle,
  dealGame,
  determineFirstPlayer,
  handleRedeal,
  handleStockCycle,
  recycleWaste,
  isRed,
  isBlack,
  // Constants exported so rules.js doesn't need to redefine them
  SUITS,
  RANKS,
  STOCK_SIZE,
  TABLEAU_COLS,
};
