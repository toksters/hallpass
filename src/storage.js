const DEFAULTS = {
  hp_settings: {
    enabled: true,
    blockedSites: [],
    cardsRequired: 1,
    passDuration: 30
  },
  hp_decks: [],
  hp_cards: {},
  hp_srs: {},
  hp_sessions: {},
  hp_stats: {
    totalReviews: 0,
    totalCorrect: 0,
    streakDays: 0,
    lastReviewDate: '',
    reviewsByDate: {}
  }
};

const storage = {
  async get(key) {
    const result = await chrome.storage.local.get(key);
    return result[key] ?? structuredClone(DEFAULTS[key]);
  },

  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },

  async update(key, updater) {
    const current = await this.get(key);
    const updated = updater(current);
    await this.set(key, updated);
    return updated;
  },

  async getMultiple(keys) {
    const result = await chrome.storage.local.get(keys);
    const out = {};
    for (const key of keys) {
      out[key] = result[key] ?? structuredClone(DEFAULTS[key]);
    }
    return out;
  }
};

if (typeof globalThis !== 'undefined') {
  globalThis.hallpassStorage = storage;
}
