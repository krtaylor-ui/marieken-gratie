// =============================================================================
// testRules.js — Tests for every rule in rules.js
// Usage: node game/testRules.js
// =============================================================================

'use strict';

const { isLegalMove, checkFoundation, checkTableau,
        checkOpponentPile, canRequestRedeal, canRequestCycle,
        canForfeit, checkWinCondition } = require('./rules');

// --- Test tracking ---
let passed = 0;
let failed = 0;

function expect(description, result, shouldBeLegal) {
  const ok = result.legal === shouldBeLegal;
  if (ok) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    const detail = result.legal
      ? '(was legal, expected illegal)'
      : `(was illegal: "${result.reason}")`;
    console.log(`  ✗ ${description} ${detail}`);
    failed++;
  }
}

// --- Card builder shorthand ---
// e.g. card('hearts', 7) or card('hearts', 7, false) for face-down
function card(suit, rank, faceUp = true, deckOwner = 1) {
  return { suit, rank, faceUp, deckOwner };
}

// --- Minimal game state builder ---
// Builds just enough state to test a specific scenario
function makeState(overrides = {}) {
  return {
    players: {
      1: { stock: [card('hearts', 5)], hand: [card('clubs', 3)], waste: [], handCycles: 0 },
      2: { stock: [card('spades', 9)], hand: [card('diamonds', 2)], waste: [card('hearts', 7)], handCycles: 0 },
    },
    tableau: [
      [card('spades', 8)],   // col 0
      [card('hearts', 6)],   // col 1
      [],                    // col 2 empty
      [card('clubs', 4)],    // col 3
      [card('diamonds', 3)], // col 4
      [card('clubs', 10)],   // col 5
      [card('hearts', 2)],   // col 6
      [card('spades', 5)],   // col 7
    ],
    foundations: [[], [], [], [], [], [], [], []],
    turn: {
      player: 1,
      firstPlayer: 1,
      movesThisAction: 0,
      moveLimit: null,
      cardMoved: false,
      cycleUsed: false,
      redalUsed: false,
    },
    pendingRequest: { type: null, requestedBy: null },
    phase: 'playing',
    winner: null,
    gameNumber: 1,
    ...overrides,
  };
}


// =============================================================================
// SECTION 1: Foundation rules
// =============================================================================
console.log('\n--- Foundation Rules ---');

// Empty foundation
expect('Ace can start empty foundation',
  checkFoundation(card('hearts', 1), 0, makeState()),
  true);

expect('Non-ace cannot start empty foundation',
  checkFoundation(card('hearts', 5), 0, makeState()),
  false);

// Occupied foundation
const stateWith3H = makeState();
stateWith3H.foundations[0] = [card('hearts', 1), card('hearts', 2), card('hearts', 3)];

expect('4♥ can play on 3♥ foundation',
  checkFoundation(card('hearts', 4), 0, stateWith3H),
  true);

expect('5♥ cannot skip to play on 3♥ foundation',
  checkFoundation(card('hearts', 5), 0, stateWith3H),
  false);

expect('4♠ cannot play on 3♥ foundation (wrong suit)',
  checkFoundation(card('spades', 4), 0, stateWith3H),
  false);

expect('2♥ cannot play backwards on 3♥ foundation',
  checkFoundation(card('hearts', 2), 0, stateWith3H),
  false);


// =============================================================================
// SECTION 2: Tableau rules — occupied columns
// =============================================================================
console.log('\n--- Tableau Rules (occupied columns) ---');

// Col 0 has 8♠ (black). Needs a red 7.
const move = (fromType, fromCol, toCol) => ({
  player: 1,
  from: fromType === 'tableau' ? { type: 'tableau', column: fromCol } : { type: fromType },
  to: { type: 'tableau', column: toCol },
});

const state = makeState();

// stock top is 5♥ (red). Playing to col 0 which has 8♠ (black) — needs red 7. Fail.
expect('5♥ cannot play on 8♠ (wrong rank)',
  isLegalMove({ player: 1, from: { type: 'stock' }, to: { type: 'tableau', column: 0 } }, state),
  false);

// col 1 has 6♥ (red). Needs black 5. P1 stock is 5♥ — wrong colour.
expect('5♥ cannot play on 6♥ (same colour)',
  isLegalMove({ player: 1, from: { type: 'stock' }, to: { type: 'tableau', column: 1 } }, state),
  false);

// col 3 has 4♣ (black). Needs red 3. P1 stock is 5♥ — wrong rank.
expect('5♥ cannot play on 4♣ (wrong rank for that column)',
  isLegalMove({ player: 1, from: { type: 'stock' }, to: { type: 'tableau', column: 3 } }, state),
  false);

// Build a state where the move IS legal: col has black 6, stock has red 5
const stateGoodTableau = makeState();
stateGoodTableau.tableau[0] = [card('clubs', 6)];       // black 6
stateGoodTableau.players[1].stock = [card('hearts', 5)]; // red 5

expect('5♥ (red) can play on 6♣ (black) — correct rank and colour',
  isLegalMove({ player: 1, from: { type: 'stock' }, to: { type: 'tableau', column: 0 } }, stateGoodTableau),
  true);

// Cannot move tableau card to its own column
expect('Cannot move tableau card to its own column',
  isLegalMove({ player: 1, from: { type: 'tableau', column: 0 }, to: { type: 'tableau', column: 0 } }, stateGoodTableau),
  false);


// =============================================================================
// SECTION 3: Tableau rules — empty columns
// =============================================================================
console.log('\n--- Tableau Rules (empty columns) ---');

// Col 2 is empty in base state
expect('Stock card can fill empty tableau column',
  isLegalMove({ player: 1, from: { type: 'stock' }, to: { type: 'tableau', column: 2 } }, state),
  true);

expect('Tableau card can fill empty tableau column',
  isLegalMove({ player: 1, from: { type: 'tableau', column: 0 }, to: { type: 'tableau', column: 2 } }, state),
  true);

// Hand card to empty column — only legal when stock is empty
expect('Hand card cannot fill empty column when stock has cards',
  isLegalMove({ player: 1, from: { type: 'hand' }, to: { type: 'tableau', column: 2 } }, state),
  false);

const stateEmptyStock = makeState();
stateEmptyStock.players[1].stock = [];  // stock emptied
stateEmptyStock.tableau[2] = [];        // col 2 empty

expect('Hand card CAN fill empty column when stock is empty',
  isLegalMove({ player: 1, from: { type: 'hand' }, to: { type: 'tableau', column: 2 } }, stateEmptyStock),
  true);


// =============================================================================
// SECTION 4: Opponent pile rules
// =============================================================================
console.log('\n--- Opponent Pile Rules ---');

// P2 stock top is 9♠, P2 waste top is 7♥
// P1 stock top is 5♥

// Playing 5♥ to P2 waste (7♥): same suit ♥, rank diff = 2 → illegal
expect('5♥ cannot play on opponent 7♥ (rank diff is 2)',
  isLegalMove({ player: 1, from: { type: 'stock' }, to: { type: 'opponentWaste' } }, state),
  false);

// Build state where move IS legal: P1 stock = 6♥, P2 waste top = 7♥
const stateOpponent = makeState();
stateOpponent.players[1].stock = [card('hearts', 6)];
stateOpponent.players[2].waste = [card('hearts', 7)];

expect('6♥ can play on opponent 7♥ (same suit, rank diff 1)',
  isLegalMove({ player: 1, from: { type: 'stock' }, to: { type: 'opponentWaste' } }, stateOpponent),
  true);

// Same rank diff but wrong suit
const stateWrongSuit = makeState();
stateWrongSuit.players[1].stock = [card('spades', 6)];
stateWrongSuit.players[2].waste = [card('hearts', 7)];

expect('6♠ cannot play on opponent 7♥ (wrong suit)',
  isLegalMove({ player: 1, from: { type: 'stock' }, to: { type: 'opponentWaste' } }, stateWrongSuit),
  false);

// Playing to empty opponent pile — illegal
const stateEmptyOpponent = makeState();
stateEmptyOpponent.players[2].waste = [];
expect('Cannot play to empty opponent waste pile',
  isLegalMove({ player: 1, from: { type: 'stock' }, to: { type: 'opponentWaste' } }, stateEmptyOpponent),
  false);

// Playing to opponent stock
const stateOpponentStock = makeState();
stateOpponentStock.players[1].stock = [card('spades', 8)];  // 8♠
stateOpponentStock.players[2].stock = [card('spades', 9)];  // 9♠

expect('8♠ can play on opponent stock 9♠ (same suit, rank diff 1)',
  isLegalMove({ player: 1, from: { type: 'stock' }, to: { type: 'opponentStock' } }, stateOpponentStock),
  true);


// =============================================================================
// SECTION 5: Turn and phase restrictions
// =============================================================================
console.log('\n--- Turn and Phase Restrictions ---');

// Wrong player's turn
const stateP2Turn = makeState({ turn: { ...makeState().turn, player: 2 } });
expect("Player 1 cannot move on Player 2's turn",
  isLegalMove({ player: 1, from: { type: 'stock' }, to: { type: 'tableau', column: 2 } }, stateP2Turn),
  false);

// Wrong phase
const statePending = makeState({ phase: 'pendingRedeal' });
expect('Cannot move cards during pendingRedeal phase',
  isLegalMove({ player: 1, from: { type: 'stock' }, to: { type: 'tableau', column: 2 } }, statePending),
  false);

// Cannot play FROM waste
expect('Cannot play from own waste pile',
  isLegalMove({ player: 1, from: { type: 'waste' }, to: { type: 'tableau', column: 2 } }, state),
  false);

// Cannot play TO own waste
expect('Cannot play directly to own waste pile',
  isLegalMove({ player: 1, from: { type: 'stock' }, to: { type: 'waste' } }, state),
  false);


// =============================================================================
// SECTION 6: Turn-level actions
// =============================================================================
console.log('\n--- Turn-Level Actions (Redeal, Cycle, Forfeit) ---');

expect('Can request redeal at start of turn',
  canRequestRedeal(1, state),
  true);

const stateCardMoved = makeState();
stateCardMoved.turn.cardMoved = true;
expect('Cannot request redeal after moving a card',
  canRequestRedeal(1, stateCardMoved),
  false);

const stateRedalUsed = makeState();
stateRedalUsed.turn.redalUsed = true;
expect('Cannot request redeal twice in one turn',
  canRequestRedeal(1, stateRedalUsed),
  false);

expect('Can request Stock Cycle at start of turn',
  canRequestCycle(1, state),
  true);

const stateCycleUsed = makeState();
stateCycleUsed.turn.cycleUsed = true;
expect('Cannot request Stock Cycle twice in one turn',
  canRequestCycle(1, stateCycleUsed),
  false);

expect('Can forfeit on your turn',
  canForfeit(1, state),
  true);

expect("Cannot forfeit on opponent's turn",
  canForfeit(2, state),
  false);


// =============================================================================
// SECTION 7: Win condition
// =============================================================================
console.log('\n--- Win Condition ---');

const stateAlmostWon = makeState();
stateAlmostWon.players[1].stock = [];
stateAlmostWon.players[1].hand  = [];
stateAlmostWon.players[1].waste = [card('hearts', 5)];  // one card left
expect('Player 1 has not won with one waste card remaining',
  { legal: checkWinCondition(1, stateAlmostWon) },
  false);

const stateWon = makeState();
stateWon.players[1].stock = [];
stateWon.players[1].hand  = [];
stateWon.players[1].waste = [];
expect('Player 1 wins when all piles are empty',
  { legal: checkWinCondition(1, stateWon) },
  true);

expect('Player 2 has not won in default state',
  { legal: checkWinCondition(2, state) },
  false);


// =============================================================================
// SUMMARY
// =============================================================================
console.log('\n' + '='.repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('All rules tests passed! ✓');
} else {
  console.log('Some tests failed — review the rules logic above.');
}
console.log('='.repeat(60) + '\n');
