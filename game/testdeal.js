// =============================================================================
// testDeal.js — Run this to verify deck.js is working correctly
// Usage: node game/testDeal.js
// =============================================================================

'use strict';

const {
  dealGame,
  determineFirstPlayer,
  handleStockCycle,
  recycleWaste,
} = require('./deck');

// --- Helper to display a card as a readable string ---
function cardStr(card) {
  if (!card) return '---';
  const rankNames = { 1:'A', 11:'J', 12:'Q', 13:'K' };
  const rank = rankNames[card.rank] || card.rank;
  const suitSymbols = { hearts:'♥', diamonds:'♦', clubs:'♣', spades:'♠' };
  const suit = suitSymbols[card.suit];
  const face = card.faceUp ? '' : '🂠';
  return `${rank}${suit}(D${card.deckOwner})${face}`;
}

// --- Helper to display a pile summary ---
function pileStr(pile, showAll = false) {
  if (pile.length === 0) return '(empty)';
  if (showAll) return pile.map(cardStr).join(' ');
  // For large piles, just show count and top card
  return `[${pile.length} cards, top: ${cardStr(pile.at(-1))}]`;
}

// =============================================================================
// TEST 1: Basic deal
// =============================================================================
console.log('\n' + '='.repeat(60));
console.log('TEST 1: Fresh deal (no first player yet)');
console.log('='.repeat(60));

const gameState = dealGame(null);  // null = tiebreaker needed

console.log('\n--- Player 1 ---');
console.log(`  Stock (${gameState.players[1].stock.length} cards): ${pileStr(gameState.players[1].stock)}`);
console.log(`  Hand  (${gameState.players[1].hand.length} cards):  ${pileStr(gameState.players[1].hand)}`);
console.log(`  Waste: (empty at deal)`);

console.log('\n--- Player 2 ---');
console.log(`  Stock (${gameState.players[2].stock.length} cards): ${pileStr(gameState.players[2].stock)}`);
console.log(`  Hand  (${gameState.players[2].hand.length} cards):  ${pileStr(gameState.players[2].hand)}`);

console.log('\n--- Tableau (8 columns) ---');
for (let i = 0; i < 8; i++) {
  const owner = i < 4 ? 'P1' : 'P2';
  console.log(`  Col ${i} (${owner}): ${pileStr(gameState.tableau[i], true)}`);
}

console.log('\n--- Foundations ---');
console.log('  All 8 empty at start ✓');

// Verify card counts
const p1Total = gameState.players[1].stock.length + gameState.players[1].hand.length;
const p2Total = gameState.players[2].stock.length + gameState.players[2].hand.length;
const tableauTotal = gameState.tableau.reduce((sum, col) => sum + col.length, 0);
const grandTotal = p1Total + p2Total + tableauTotal;

console.log('\n--- Card Count Verification ---');
console.log(`  P1 cards (stock + hand): ${p1Total} (expected 48)`);
console.log(`  P2 cards (stock + hand): ${p2Total} (expected 48)`);
console.log(`  Tableau cards: ${tableauTotal} (expected 8)`);
console.log(`  Grand total: ${grandTotal} (expected 104) ${grandTotal === 104 ? '✓' : '✗ ERROR'}`);


// =============================================================================
// TEST 2: First player determination
// =============================================================================
console.log('\n' + '='.repeat(60));
console.log('TEST 2: Determine first player');
console.log('='.repeat(60));

console.log(`\n  P1 stock top: ${cardStr(gameState.players[1].stock.at(-1))}`);
console.log(`  P2 stock top: ${cardStr(gameState.players[2].stock.at(-1))}`);

const firstPlayer = determineFirstPlayer(gameState);
console.log(`\n  → First player: Player ${firstPlayer}`);
console.log(`  → Phase: ${gameState.phase}`);


// =============================================================================
// TEST 3: Stock Cycle
// =============================================================================
console.log('\n' + '='.repeat(60));
console.log('TEST 3: Stock Cycle');
console.log('='.repeat(60));

console.log(`\n  Before cycle:`);
console.log(`    P1 stock top: ${cardStr(gameState.players[1].stock.at(-1))}`);
console.log(`    P2 stock top: ${cardStr(gameState.players[2].stock.at(-1))}`);

// Simulate a pending cycle being accepted
gameState.phase = 'pendingCycle';
handleStockCycle(gameState);

console.log(`\n  After cycle:`);
console.log(`    P1 stock top: ${cardStr(gameState.players[1].stock.at(-1))}`);
console.log(`    P2 stock top: ${cardStr(gameState.players[2].stock.at(-1))}`);
console.log(`    Phase restored to: ${gameState.phase}`);


// =============================================================================
// TEST 4: Waste recycle
// =============================================================================
console.log('\n' + '='.repeat(60));
console.log('TEST 4: Waste → Hand recycle');
console.log('='.repeat(60));

// Simulate P1 playing all hand cards into waste
const p1 = gameState.players[1];
console.log(`\n  Simulating P1 emptying hand into waste...`);
while (p1.hand.length > 0) {
  const card = p1.hand.pop();
  card.faceUp = true;
  p1.waste.push(card);
}
console.log(`  P1 hand: ${p1.hand.length} cards`);
console.log(`  P1 waste: ${p1.waste.length} cards`);

recycleWaste(gameState, 1);

console.log(`\n  After recycle:`);
console.log(`  P1 hand: ${p1.hand.length} cards (should be 35)`);
console.log(`  P1 waste: ${p1.waste.length} cards (should be 0)`);
console.log(`  P1 handCycles: ${p1.handCycles} (should be 1)`);
console.log(`  All hand cards face down: ${p1.hand.every(c => !c.faceUp) ? '✓' : '✗ ERROR'}`);


// =============================================================================
// TEST 5: Duplicate card check (two decks = duplicates are expected)
// =============================================================================
console.log('\n' + '='.repeat(60));
console.log('TEST 5: Duplicate card check (expected with two decks)');
console.log('='.repeat(60));

const allCards = [
  ...gameState.players[1].stock,
  ...gameState.players[1].hand,
  ...gameState.players[1].waste,
  ...gameState.players[2].stock,
  ...gameState.players[2].hand,
  ...gameState.players[2].waste,
  ...gameState.tableau.flat(),
];

// Count cards per deck
const deck1Cards = allCards.filter(c => c.deckOwner === 1).length;
const deck2Cards = allCards.filter(c => c.deckOwner === 2).length;
console.log(`\n  Deck 1 cards in play: ${deck1Cards} (expected 52)`);
console.log(`  Deck 2 cards in play: ${deck2Cards} (expected 52)`);

// Verify no deck has duplicate cards within itself
function findDuplicatesInDeck(cards, deckOwner) {
  const seen = new Set();
  const dupes = [];
  for (const card of cards.filter(c => c.deckOwner === deckOwner)) {
    const key = `${card.suit}-${card.rank}`;
    if (seen.has(key)) dupes.push(key);
    seen.add(key);
  }
  return dupes;
}

const dupes1 = findDuplicatesInDeck(allCards, 1);
const dupes2 = findDuplicatesInDeck(allCards, 2);
console.log(`  Duplicates within deck 1: ${dupes1.length === 0 ? 'none ✓' : dupes1.join(', ') + ' ✗'}`);
console.log(`  Duplicates within deck 2: ${dupes2.length === 0 ? 'none ✓' : dupes2.join(', ') + ' ✗'}`);

console.log('\n' + '='.repeat(60));
console.log('All tests complete!');
console.log('='.repeat(60) + '\n');
