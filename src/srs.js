function inferQuality(responseTimeMs, wrongAttempts) {
  if (wrongAttempts >= 3) return 1;
  if (wrongAttempts === 2) return 2;
  if (wrongAttempts === 1) return 3;
  if (responseTimeMs < 8000) return 5;
  if (responseTimeMs < 20000) return 4;
  return 3;
}

function updateSRS(cardState, quality) {
  let { ef, interval, repetitions } = cardState;

  if (quality >= 3) {
    if (repetitions === 0) {
      interval = 1;
    } else if (repetitions === 1) {
      interval = 6;
    } else {
      interval = Math.round(interval * ef);
    }
    repetitions += 1;
  } else {
    repetitions = 0;
    interval = 1;
  }

  ef = ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  ef = Math.max(1.3, ef);

  const now = Date.now();
  const dueDate = now + interval * 24 * 60 * 60 * 1000;

  return { ef, interval, repetitions, dueDate, lastReview: now };
}

function createInitialSRS() {
  return {
    ef: 2.5,
    interval: 0,
    repetitions: 0,
    dueDate: Date.now(),
    lastReview: null
  };
}

if (typeof globalThis !== 'undefined') {
  globalThis.hallpassSRS = { inferQuality, updateSRS, createInitialSRS };
}
