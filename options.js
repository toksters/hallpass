(() => {
  const siteInput = document.getElementById('site-input');
  const addSiteBtn = document.getElementById('add-site-btn');
  const sitesList = document.getElementById('sites-list');
  const sitesEmpty = document.getElementById('sites-empty');
  const deckFile = document.getElementById('deck-file');
  const decksList = document.getElementById('decks-list');
  const decksEmpty = document.getElementById('decks-empty');
  const importProgress = document.getElementById('import-progress');
  const progressBar = document.getElementById('progress-bar');
  const progressTextEl = document.getElementById('progress-text');
  const cardsRequiredInput = document.getElementById('cards-required');
  const passDurationInput = document.getElementById('pass-duration');

  // --- Blocked Sites ---

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function cleanDomain(input) {
    let domain = input.trim().toLowerCase();
    // Strip protocol
    domain = domain.replace(/^https?:\/\//, '');
    // Strip path
    domain = domain.split('/')[0];
    // Strip www.
    domain = domain.replace(/^www\./, '');
    return domain;
  }

  async function renderSites() {
    const settings = await hallpassStorage.get('hp_settings');
    const sites = settings.blockedSites || [];

    sitesList.innerHTML = '';
    sitesEmpty.style.display = sites.length ? 'none' : 'block';

    for (const site of sites) {
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="item-info">
          <div class="item-name">${escapeHtml(site.pattern)}</div>
        </div>
        <div class="item-actions">
          <label class="toggle-switch">
            <input type="checkbox" ${site.enabled ? 'checked' : ''} data-site-id="${site.id}" />
            <span class="toggle-slider"></span>
          </label>
          <button class="btn-delete" data-site-id="${site.id}">Remove</button>
        </div>
      `;
      sitesList.appendChild(li);
    }

    // Toggle handlers
    sitesList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', async () => {
        const id = cb.dataset.siteId;
        await hallpassStorage.update('hp_settings', s => {
          const site = s.blockedSites.find(x => x.id === id);
          if (site) site.enabled = cb.checked;
          return s;
        });
        await chrome.runtime.sendMessage({ type: 'updateRules' });
      });
    });

    // Delete handlers
    sitesList.querySelectorAll('.btn-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.siteId;
        await hallpassStorage.update('hp_settings', s => {
          s.blockedSites = s.blockedSites.filter(x => x.id !== id);
          return s;
        });
        await chrome.runtime.sendMessage({ type: 'updateRules' });
        renderSites();
      });
    });
  }

  addSiteBtn.addEventListener('click', async () => {
    const domain = cleanDomain(siteInput.value);
    if (!domain || !domain.includes('.')) return;

    await hallpassStorage.update('hp_settings', s => {
      // Avoid duplicates
      if (s.blockedSites.some(x => x.pattern === domain)) return s;
      s.blockedSites.push({ id: generateId(), pattern: domain, enabled: true });
      return s;
    });

    siteInput.value = '';
    await chrome.runtime.sendMessage({ type: 'updateRules' });
    renderSites();
  });

  siteInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addSiteBtn.click();
  });

  // --- Deck Import ---

  async function renderDecks() {
    const decks = await hallpassStorage.get('hp_decks');

    decksList.innerHTML = '';
    decksEmpty.style.display = decks.length ? 'none' : 'block';

    for (const deck of decks) {
      const date = new Date(deck.importedAt).toLocaleDateString();
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="item-info">
          <div class="item-name">${escapeHtml(deck.name)}</div>
          <div class="item-meta">${deck.cardCount} cards &middot; Imported ${date}</div>
        </div>
        <div class="item-actions">
          <label class="toggle-switch">
            <input type="checkbox" ${deck.enabled ? 'checked' : ''} data-deck-id="${deck.id}" />
            <span class="toggle-slider"></span>
          </label>
          <button class="btn-delete" data-deck-id="${deck.id}">Remove</button>
        </div>
      `;
      decksList.appendChild(li);
    }

    // Toggle handlers
    decksList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', async () => {
        const id = cb.dataset.deckId;
        await hallpassStorage.update('hp_decks', decks => {
          const deck = decks.find(d => d.id === id);
          if (deck) deck.enabled = cb.checked;
          return decks;
        });
      });
    });

    // Delete handlers
    decksList.querySelectorAll('.btn-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.deckId;
        const deckName = btn.closest('li').querySelector('.item-name').textContent;
        if (!confirm(`Remove "${deckName}"? This will delete all cards and learning progress for this deck.`)) return;

        // Remove deck metadata
        await hallpassStorage.update('hp_decks', decks =>
          decks.filter(d => d.id !== id)
        );

        // Remove cards and SRS state belonging to this deck
        await hallpassStorage.update('hp_cards', cards => {
          for (const [cardId, card] of Object.entries(cards)) {
            if (card.deckId === id) delete cards[cardId];
          }
          return cards;
        });

        await hallpassStorage.update('hp_srs', srs => {
          const cards = {}; // need to check which cards belong to this deck
          // Since we already deleted from hp_cards, just clean up orphaned SRS entries
          return srs;
        });

        // Clean orphaned SRS entries
        const { hp_cards: remainingCards, hp_srs: srsData } =
          await hallpassStorage.getMultiple(['hp_cards', 'hp_srs']);
        const validIds = new Set(Object.keys(remainingCards));
        const cleanedSrs = {};
        for (const [id, state] of Object.entries(srsData)) {
          if (validIds.has(id)) cleanedSrs[id] = state;
        }
        await hallpassStorage.set('hp_srs', cleanedSrs);

        renderDecks();
      });
    });
  }

  // --- Two-step Import Flow ---

  const fieldPicker = document.getElementById('field-picker');
  const frontFieldSelect = document.getElementById('front-field');
  const backFieldSelect = document.getElementById('back-field');
  const fieldPreview = document.getElementById('field-preview');
  const displayFieldsChecklist = document.getElementById('display-fields-checklist');
  const cancelImportBtn = document.getElementById('cancel-import-btn');
  const confirmImportBtn = document.getElementById('confirm-import-btn');

  let pendingImport = null; // holds { preview, dbData } between steps

  function stripHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent || div.innerText || '';
  }

  function updateFieldPreview() {
    if (!pendingImport) return;
    const fi = parseInt(frontFieldSelect.value);
    const bi = parseInt(backFieldSelect.value);
    const sample = pendingImport.preview.samples[0];
    if (!sample) return;

    // Front/back preview
    let html = `
      <div class="field-preview-label">Question (front)</div>
      <div class="field-preview-value">${escapeHtml(stripHtml(sample.fields[fi] || '(empty)'))}</div>
      <div class="field-preview-label">Answer (back)</div>
      <div class="field-preview-value">${escapeHtml(stripHtml(sample.fields[bi] || '(empty)'))}</div>
    `;

    // Correct answer preview from checked display fields
    const checkedIndices = [];
    displayFieldsChecklist.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
      checkedIndices.push(parseInt(cb.value));
    });

    if (checkedIndices.length > 0) {
      html += `<div class="field-preview-correct">
        <div class="field-preview-correct-heading">Correct answer preview</div>`;
      for (const idx of checkedIndices) {
        const name = sample.fieldNames[idx] || `Field ${idx + 1}`;
        const value = sample.fields[idx] || '';
        if (value.trim()) {
          html += `
            <div class="field-preview-correct-label">${escapeHtml(name)}</div>
            <div class="field-preview-correct-value">${escapeHtml(stripHtml(value))}</div>`;
        }
      }
      html += `</div>`;
    }

    fieldPreview.innerHTML = html;
  }

  // Step 1: Parse and show field picker
  deckFile.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    importProgress.style.display = 'block';
    fieldPicker.style.display = 'none';
    progressBar.style.width = '0%';
    progressBar.style.background = '';

    try {
      progressTextEl.textContent = 'Reading file...';
      progressBar.style.width = '10%';

      const arrayBuffer = await file.arrayBuffer();
      progressBar.style.width = '30%';

      const preview = await previewApkg(arrayBuffer, (msg) => {
        progressTextEl.textContent = msg;
      });
      progressBar.style.width = '100%';

      // Get field names from the first model
      const firstModelId = Object.keys(preview.allFieldNames)[0];
      const fieldNames = preview.allFieldNames[firstModelId] || [];

      if (fieldNames.length < 2) {
        // Only 2 fields — no need to pick, import directly
        pendingImport = { preview, dbData: preview._dbData };
        await finishImport(0, 1);
        return;
      }

      // Populate dropdowns
      frontFieldSelect.innerHTML = '';
      backFieldSelect.innerHTML = '';
      fieldNames.forEach((name, i) => {
        const sampleVal = preview.samples[0]?.fields[i] || '';
        const truncated = stripHtml(sampleVal).slice(0, 40);
        const label = `${name}${truncated ? ' — ' + truncated : ''}`;

        frontFieldSelect.add(new Option(label, i));
        backFieldSelect.add(new Option(label, i));
      });

      // Default: first field as front, second as back
      frontFieldSelect.value = '0';
      backFieldSelect.value = '1';

      // Populate display fields checklist (all checked by default except front)
      displayFieldsChecklist.innerHTML = '';
      fieldNames.forEach((name, i) => {
        const label = document.createElement('label');
        label.className = 'display-field-checkbox';
        const checked = i !== 0 ? 'checked' : '';
        label.innerHTML = `<input type="checkbox" value="${i}" ${checked} /> ${escapeHtml(name)}`;
        displayFieldsChecklist.appendChild(label);
      });

      // Update preview when display field checkboxes change
      displayFieldsChecklist.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', updateFieldPreview);
      });

      pendingImport = { preview, dbData: preview._dbData };
      updateFieldPreview();

      progressTextEl.textContent = `${preview.deckName} — ${preview.cardCount} cards. Select fields below.`;
      fieldPicker.style.display = 'block';
    } catch (err) {
      progressTextEl.textContent = `Error: ${err.message}`;
      progressBar.style.width = '100%';
      progressBar.style.background = 'rgba(239, 68, 68, 0.3)';
      console.error('Import error:', err);
    }

    deckFile.value = '';
  });

  frontFieldSelect.addEventListener('change', updateFieldPreview);
  backFieldSelect.addEventListener('change', updateFieldPreview);

  cancelImportBtn.addEventListener('click', () => {
    pendingImport = null;
    fieldPicker.style.display = 'none';
    importProgress.style.display = 'none';
  });

  // Step 2: Build cards with chosen fields
  confirmImportBtn.addEventListener('click', async () => {
    const fi = parseInt(frontFieldSelect.value);
    const bi = parseInt(backFieldSelect.value);

    if (fi === bi) {
      alert('Question and answer fields must be different.');
      return;
    }

    // Collect display field indices from checkboxes
    const displayFieldIndices = [];
    displayFieldsChecklist.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
      displayFieldIndices.push(parseInt(cb.value));
    });

    await finishImport(fi, bi, displayFieldIndices);
  });

  async function finishImport(frontIndex, backIndex, displayFieldIndices) {
    if (!pendingImport) return;

    // Default display fields: all except front
    if (!displayFieldIndices) {
      const firstModelId = Object.keys(pendingImport.preview.allFieldNames)[0];
      const fieldNames = pendingImport.preview.allFieldNames[firstModelId] || [];
      displayFieldIndices = fieldNames.map((_, i) => i).filter(i => i !== frontIndex);
    }

    fieldPicker.style.display = 'none';
    progressBar.style.width = '50%';
    progressBar.style.background = '';
    progressTextEl.textContent = 'Building cards...';

    try {
      const result = await buildCards(pendingImport.dbData, frontIndex, backIndex, displayFieldIndices, (msg) => {
        progressTextEl.textContent = msg;
      });
      progressBar.style.width = '70%';

      const deckId = generateId();

      const cardsWithDeck = {};
      for (const [cardId, card] of Object.entries(result.cards)) {
        cardsWithDeck[cardId] = { ...card, deckId };
      }

      progressTextEl.textContent = 'Saving cards...';
      await hallpassStorage.update('hp_cards', existing => {
        return { ...existing, ...cardsWithDeck };
      });
      progressBar.style.width = '85%';

      await hallpassStorage.update('hp_srs', existing => {
        for (const cardId of Object.keys(cardsWithDeck)) {
          if (!existing[cardId]) {
            existing[cardId] = hallpassSRS.createInitialSRS();
          }
        }
        return existing;
      });
      progressBar.style.width = '95%';

      await hallpassStorage.update('hp_decks', decks => {
        decks.push({
          id: deckId,
          name: result.deckName,
          importedAt: Date.now(),
          cardCount: result.cardCount,
          enabled: true
        });
        return decks;
      });

      progressBar.style.width = '100%';
      progressTextEl.textContent = `Imported ${result.cardCount} cards from "${result.deckName}"`;

      setTimeout(() => {
        importProgress.style.display = 'none';
      }, 3000);

      renderDecks();
    } catch (err) {
      progressTextEl.textContent = `Error: ${err.message}`;
      progressBar.style.width = '100%';
      progressBar.style.background = 'rgba(239, 68, 68, 0.3)';
      console.error('Import error:', err);
    }

    pendingImport = null;
  }

  // --- General Settings ---

  async function loadSettings() {
    const settings = await hallpassStorage.get('hp_settings');
    cardsRequiredInput.value = settings.cardsRequired || 1;
    passDurationInput.value = settings.passDuration || 30;
  }

  cardsRequiredInput.addEventListener('change', async () => {
    const val = Math.max(1, Math.min(10, parseInt(cardsRequiredInput.value) || 1));
    cardsRequiredInput.value = val;
    await hallpassStorage.update('hp_settings', s => {
      s.cardsRequired = val;
      return s;
    });
  });

  passDurationInput.addEventListener('change', async () => {
    const val = Math.max(1, Math.min(480, parseInt(passDurationInput.value) || 30));
    passDurationInput.value = val;
    await hallpassStorage.update('hp_settings', s => {
      s.passDuration = val;
      return s;
    });
  });

  // --- Utilities ---

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Init ---

  renderSites();
  renderDecks();
  loadSettings();
})();
