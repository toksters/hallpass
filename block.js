(() => {
  const params = new URLSearchParams(window.location.search);
  const sitePattern = params.get('site') || '';
  const originalUrl = params.get('url') || `https://${sitePattern}`;

  // UI elements
  const siteNameEl = document.getElementById('site-name');
  const noCardsState = document.getElementById('no-cards-state');
  const cardState = document.getElementById('card-state');
  const cardFrontEl = document.getElementById('card-front');
  const cardBackEl = document.getElementById('card-back');
  const answerInput = document.getElementById('answer-input');
  const answerForm = document.getElementById('answer-form');
  const submitBtn = document.getElementById('submit-btn');
  const feedbackEl = document.getElementById('feedback');
  const showAnswerContainer = document.getElementById('show-answer-container');
  const showAnswerBtn = document.getElementById('show-answer-btn');
  const answerRevealed = document.getElementById('answer-revealed');
  const continueBtn = document.getElementById('continue-btn');
  const progressText = document.getElementById('progress-text');
  const optionsLink = document.getElementById('options-link');

  const correctOverlay = document.getElementById('correct-overlay');
  const correctFieldsEl = document.getElementById('correct-fields');
  const countdownBar = document.getElementById('countdown-bar');
  const completedCardsEl = document.getElementById('completed-cards');
  const summaryState = document.getElementById('summary-state');
  const summaryCardsEl = document.getElementById('summary-cards');
  const summarySiteEl = document.getElementById('summary-site');

  // State
  let currentCard = null;
  let wrongAttempts = 0;
  let startTime = 0;
  let cardsRequired = 1;
  let cardsAnswered = 0;
  let countdownTimer = null;
  const completedCardData = [];
  const DISPLAY_DURATION = 5000; // 5 seconds

  siteNameEl.textContent = sitePattern;
  optionsLink.href = chrome.runtime.getURL('options.html');

  // --- Answer Comparison ---

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function stripHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent || div.innerText || '';
  }

  function normalize(str) {
    return str.toLowerCase().trim().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');
  }

  function stripParenthetical(str) {
    return str.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').trim();
  }

  function checkAnswer(userAnswer, correctAnswer) {
    const normUser = normalize(userAnswer);
    if (!normUser) return false;

    const cleaned = stripParenthetical(stripHtml(correctAnswer));

    // Split on comma or semicolon to get individual definitions
    const definitions = cleaned.split(/[,;]/).map(d => d.trim()).filter(Boolean);

    // Also try the full string (without parentheticals) as one candidate
    const candidates = [cleaned, ...definitions];

    return candidates.some(candidate => normUser === normalize(candidate));
  }

  // --- Stats ---

  async function recordReview(correct) {
    await hallpassStorage.update('hp_stats', stats => {
      stats.totalReviews++;
      if (correct) stats.totalCorrect++;

      const today = new Date().toISOString().slice(0, 10);
      if (!stats.reviewsByDate[today]) {
        stats.reviewsByDate[today] = { reviews: 0, correct: 0 };
      }
      stats.reviewsByDate[today].reviews++;
      if (correct) stats.reviewsByDate[today].correct++;

      // Streak
      if (stats.lastReviewDate !== today) {
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        stats.streakDays = (stats.lastReviewDate === yesterday) ? stats.streakDays + 1 : 1;
        stats.lastReviewDate = today;
      }

      return stats;
    });
  }

  // --- Card Flow ---

  async function loadNextCard() {
    const result = await selectCard();

    if (!result) {
      noCardsState.style.display = 'block';
      cardState.style.display = 'none';
      return;
    }

    currentCard = result;
    wrongAttempts = 0;
    startTime = Date.now();

    noCardsState.style.display = 'none';
    cardState.style.display = 'block';
    cardFrontEl.innerHTML = currentCard.card.front;
    answerInput.value = '';
    requestAnimationFrame(() => answerInput.focus());
    feedbackEl.style.display = 'none';
    showAnswerContainer.style.display = 'none';
    answerRevealed.style.display = 'none';
    correctOverlay.style.display = 'none';
    cardFrontEl.style.display = '';
    cardFrontEl.previousElementSibling.style.display = '';
    answerForm.style.display = 'flex';

    progressText.textContent = `Card ${cardsAnswered + 1} of ${cardsRequired}`;
  }

  function addCompletedCard(card) {
    const el = document.createElement('div');
    el.className = 'completed-card';

    let fieldsHtml = '';
    if (card.displayFields && card.displayFields.length > 0) {
      fieldsHtml = card.displayFields
        .filter(f => f.value && f.value.trim())
        .map(f => `
          <div class="completed-field-label">${escapeHtml(f.name)}</div>
          <div class="completed-field-value">${stripHtml(f.value)}</div>
        `).join('');
    } else {
      fieldsHtml = `<div class="completed-back">${stripHtml(card.back)}</div>`;
    }

    el.innerHTML = `
      <div class="completed-front">${stripHtml(card.front)}</div>
      ${fieldsHtml}
    `;
    completedCardsEl.appendChild(el);
  }

  function showSummary() {
    cardState.style.display = 'none';
    summarySiteEl.textContent = sitePattern;
    summaryCardsEl.innerHTML = completedCardData.map(card => {
      let fieldsHtml = '';
      if (card.displayFields && card.displayFields.length > 0) {
        fieldsHtml = card.displayFields
          .filter(f => f.value && f.value.trim())
          .map(f => `
            <div class="summary-field-label">${escapeHtml(f.name)}</div>
            <div class="summary-field-value">${stripHtml(f.value)}</div>
          `).join('');
      } else {
        fieldsHtml = `<div class="summary-field-value">${stripHtml(card.back)}</div>`;
      }
      return `<div class="summary-card">
        <div class="summary-card-front">${stripHtml(card.front)}</div>
        ${fieldsHtml}
      </div>`;
    }).join('');
    summaryState.style.display = 'block';
  }

  function advanceAfterCorrect() {
    if (countdownTimer) {
      clearTimeout(countdownTimer);
      countdownTimer = null;
    }
    correctOverlay.style.display = 'none';
    completedCardData.push(currentCard.card);

    if (cardsAnswered >= cardsRequired) {
      showSummary();
      chrome.runtime.sendMessage({ type: 'grantPass', site: sitePattern }).then(() => {
        window.location.href = originalUrl;
      });
    } else {
      addCompletedCard(currentCard.card);
      loadNextCard();
    }
  }

  async function handleCorrect() {
    const responseTime = Date.now() - startTime;
    const quality = hallpassSRS.inferQuality(responseTime, wrongAttempts);
    const newState = hallpassSRS.updateSRS(currentCard.srs, quality);

    await hallpassStorage.update('hp_srs', srs => {
      srs[currentCard.id] = newState;
      return srs;
    });

    await recordReview(true);

    cardsAnswered++;

    // Show correct overlay with full answer, hide question content
    answerForm.style.display = 'none';
    feedbackEl.style.display = 'none';
    showAnswerContainer.style.display = 'none';
    cardFrontEl.style.display = 'none';
    cardFrontEl.previousElementSibling.style.display = 'none'; // hide "Translate / Answer:" label

    // Build display fields HTML
    const fields = currentCard.card.displayFields;
    if (fields && fields.length > 0) {
      correctFieldsEl.innerHTML = fields.map(f =>
        `<div class="correct-field"${f.role ? ` data-role="${f.role}"` : ''}>
          <div class="correct-field-label">${escapeHtml(f.name)}</div>
          <div class="correct-field-value">${f.value}</div>
        </div>`
      ).join('');
    } else {
      // Fallback: just show the back field
      correctFieldsEl.innerHTML =
        `<div class="correct-field">
          <div class="correct-field-label">Answer</div>
          <div class="correct-field-value">${currentCard.card.back}</div>
        </div>`;
    }
    correctOverlay.style.display = 'flex';

    // Animate countdown bar
    countdownBar.style.transition = 'none';
    countdownBar.style.width = '100%';
    // Force reflow so the transition restarts
    countdownBar.offsetWidth;
    countdownBar.style.transition = `width ${DISPLAY_DURATION}ms linear`;
    countdownBar.style.width = '0%';

    countdownTimer = setTimeout(advanceAfterCorrect, DISPLAY_DURATION);
  }

  // Click overlay or press Enter to skip countdown
  correctOverlay.addEventListener('click', advanceAfterCorrect);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && correctOverlay.style.display === 'flex') {
      advanceAfterCorrect();
    }
  });

  async function handleShowAnswer() {
    // Treat as a failure — quality will be low
    const responseTime = Date.now() - startTime;
    const quality = hallpassSRS.inferQuality(responseTime, wrongAttempts + 3);
    const newState = hallpassSRS.updateSRS(currentCard.srs, quality);

    await hallpassStorage.update('hp_srs', srs => {
      srs[currentCard.id] = newState;
      return srs;
    });

    await recordReview(false);

    answerForm.style.display = 'none';
    showAnswerContainer.style.display = 'none';
    feedbackEl.style.display = 'none';
    answerRevealed.style.display = 'block';
    cardBackEl.innerHTML = currentCard.card.back;
  }

  // --- Event Handlers ---

  answerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const answer = answerInput.value.trim();
    if (!answer) return;

    if (checkAnswer(answer, currentCard.card.back)) {
      await handleCorrect();
    } else {
      wrongAttempts++;
      feedbackEl.textContent = 'Incorrect, try again.';
      feedbackEl.className = 'feedback incorrect';
      feedbackEl.style.display = 'block';
      answerInput.value = '';
      answerInput.focus();

      if (wrongAttempts >= 2) {
        showAnswerContainer.style.display = 'block';
      }
    }
  });

  showAnswerBtn.addEventListener('click', handleShowAnswer);

  continueBtn.addEventListener('click', () => {
    // After seeing answer, load next card (doesn't count toward required)
    loadNextCard();
  });

  // --- Init ---

  async function init() {
    // Check for active pass first
    const response = await chrome.runtime.sendMessage({ type: 'checkPass', site: sitePattern });
    if (response.pass) {
      window.location.href = originalUrl;
      return;
    }

    const settings = await hallpassStorage.get('hp_settings');
    cardsRequired = settings.cardsRequired || 1;

    await loadNextCard();
  }

  init();
})();
