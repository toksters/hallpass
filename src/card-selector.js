async function selectCard() {
  const { hp_srs: srsData, hp_cards: cards, hp_decks: decks } =
    await hallpassStorage.getMultiple(['hp_srs', 'hp_cards', 'hp_decks']);

  const enabledDeckIds = new Set(decks.filter(d => d.enabled).map(d => d.id));

  const now = Date.now();
  const candidates = Object.entries(srsData)
    .filter(([id]) => cards[id] && enabledDeckIds.has(cards[id].deckId));

  if (candidates.length === 0) return null;

  const overdue = candidates
    .filter(([, s]) => s.dueDate <= now && s.lastReview !== null)
    .sort((a, b) => a[1].dueDate - b[1].dueDate);

  const newCards = candidates
    .filter(([, s]) => s.lastReview === null);

  if (overdue.length > 0) {
    const pool = overdue.slice(0, 10);
    const [id] = pool[Math.floor(Math.random() * pool.length)];
    return { id, card: cards[id], srs: srsData[id] };
  }

  if (newCards.length > 0) {
    const pool = newCards.slice(0, 5);
    const [id] = pool[Math.floor(Math.random() * pool.length)];
    return { id, card: cards[id], srs: srsData[id] };
  }

  // Nothing due — pick the one due soonest
  candidates.sort((a, b) => a[1].dueDate - b[1].dueDate);
  const [id] = candidates[0];
  return { id, card: cards[id], srs: srsData[id] };
}

if (typeof globalThis !== 'undefined') {
  globalThis.selectCard = selectCard;
}
