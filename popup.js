(() => {
  const enabledToggle = document.getElementById('enabled-toggle');
  const todayReviewsEl = document.getElementById('today-reviews');
  const totalReviewsEl = document.getElementById('total-reviews');
  const streakDaysEl = document.getElementById('streak-days');
  const activePassesEl = document.getElementById('active-passes');
  const settingsLink = document.getElementById('settings-link');

  settingsLink.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Toggle
  enabledToggle.addEventListener('change', async () => {
    await chrome.runtime.sendMessage({ type: 'toggleEnabled' });
  });

  // Load state
  async function load() {
    const settings = await hallpassStorage.get('hp_settings');
    enabledToggle.checked = settings.enabled;

    const stats = await hallpassStorage.get('hp_stats');
    const today = new Date().toISOString().slice(0, 10);
    const todayStats = stats.reviewsByDate[today];

    todayReviewsEl.textContent = todayStats ? todayStats.reviews : 0;
    totalReviewsEl.textContent = stats.totalReviews;
    streakDaysEl.textContent = stats.streakDays;

    // Active passes
    const sessions = await hallpassStorage.get('hp_sessions');
    const now = Date.now();
    activePassesEl.innerHTML = '';

    for (const [site, pass] of Object.entries(sessions)) {
      if (pass.expiresAt <= now) continue;
      const minsLeft = Math.ceil((pass.expiresAt - now) / 60000);
      const div = document.createElement('div');
      div.className = 'pass-item';
      div.innerHTML = `
        <span class="pass-site">${site}</span>
        <span class="pass-time">${minsLeft} min left</span>
      `;
      activePassesEl.appendChild(div);
    }
  }

  load();
})();
