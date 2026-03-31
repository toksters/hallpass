// Step 1: Parse the .apkg and return metadata + field info for user to pick front/back
async function previewApkg(arrayBuffer, onProgress) {
  onProgress = onProgress || (() => {});

  onProgress('Extracting archive...');
  const zip = await JSZip.loadAsync(arrayBuffer);

  let dbFileName = null;
  for (const name of Object.keys(zip.files)) {
    if (name === 'collection.anki21' || name === 'collection.anki21b' || name === 'collection.anki2') {
      dbFileName = name;
      break;
    }
  }

  if (!dbFileName) {
    throw new Error('No Anki database found in .apkg file. Expected collection.anki2 or collection.anki21.');
  }

  onProgress('Loading database...');
  const dbData = await zip.file(dbFileName).async('uint8array');

  const SQL = await initSqlJs({
    locateFile: file => chrome.runtime.getURL('lib/' + file)
  });
  const db = new SQL.Database(dbData);

  try {
    const tables = new Set();
    const tableResult = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    if (tableResult.length > 0) {
      for (const row of tableResult[0].values) tables.add(row[0]);
    }

    let fieldMap;
    if (tables.has('notetypes') && tables.has('fields')) {
      fieldMap = buildFieldMapFromTables(db);
    } else if (tables.has('col')) {
      fieldMap = buildFieldMapFromCol(db);
    } else {
      throw new Error('Unrecognized Anki database schema.');
    }

    // Get a sample note to show field values as preview
    const notesResult = db.exec('SELECT mid, flds FROM notes LIMIT 5');
    const samples = [];
    if (notesResult.length) {
      for (const row of notesResult[0].values) {
        const [mid, flds] = row;
        const fields = flds.split('\x1f');
        const names = fieldMap[String(mid)] || fields.map((_, i) => `Field ${i + 1}`);
        samples.push({ mid: String(mid), fields, fieldNames: names });
      }
    }

    // Collect all unique field name lists across models
    const allFieldNames = {};
    for (const [mid, names] of Object.entries(fieldMap)) {
      allFieldNames[mid] = names;
    }

    // Get deck name
    let deckName = 'Imported Deck';
    try {
      if (tables.has('decks')) {
        const deckResult = db.exec('SELECT name FROM decks LIMIT 1');
        if (deckResult.length && deckResult[0].values.length) {
          deckName = deckResult[0].values[0][0];
        }
      } else if (tables.has('col')) {
        const colResult = db.exec('SELECT decks FROM col LIMIT 1');
        if (colResult.length && colResult[0].values.length) {
          const decks = JSON.parse(colResult[0].values[0][0]);
          const deckEntries = Object.values(decks);
          const nonDefault = deckEntries.find(d => d.name && d.name !== 'Default');
          deckName = (nonDefault || deckEntries[0])?.name || deckName;
        }
      }
    } catch { /* keep default */ }

    // Count cards
    const countResult = db.exec('SELECT COUNT(*) FROM cards');
    const cardCount = countResult.length ? countResult[0].values[0][0] : 0;

    onProgress('Ready for field selection.');

    return {
      deckName,
      cardCount,
      allFieldNames,
      samples,
      // Keep raw data for step 2
      _dbData: dbData
    };
  } finally {
    db.close();
  }
}

// Step 2: Build cards using user-selected front/back field indices + display fields
async function buildCards(dbData, frontIndex, backIndex, displayFieldIndices, onProgress) {
  onProgress = onProgress || (() => {});

  const SQL = await initSqlJs({
    locateFile: file => chrome.runtime.getURL('lib/' + file)
  });
  const db = new SQL.Database(dbData);

  try {
    const tables = new Set();
    const tableResult = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    if (tableResult.length > 0) {
      for (const row of tableResult[0].values) tables.add(row[0]);
    }

    // Build field map for field names
    let fieldMap;
    if (tables.has('notetypes') && tables.has('fields')) {
      fieldMap = buildFieldMapFromTables(db);
    } else if (tables.has('col')) {
      fieldMap = buildFieldMapFromCol(db);
    } else {
      fieldMap = {};
    }

    onProgress('Extracting notes...');
    const notesResult = db.exec('SELECT id, mid, flds, tags FROM notes');
    if (!notesResult.length) throw new Error('No notes found in the deck.');

    const notes = {};
    for (const row of notesResult[0].values) {
      const [id, mid, flds, tags] = row;
      const fields = flds.split('\x1f');
      const fieldNames = fieldMap[String(mid)] || fields.map((_, i) => `Field ${i + 1}`);

      const front = fields[frontIndex] || '';
      const back = fields[backIndex] || '';

      // Build display fields from selected indices
      const displayFields = [];
      for (const idx of (displayFieldIndices || [])) {
        const value = fields[idx] || '';
        if (value.trim()) {
          const role = idx === frontIndex ? 'front' : idx === backIndex ? 'back' : undefined;
          displayFields.push({ name: fieldNames[idx] || `Field ${idx + 1}`, value, role });
        }
      }

      notes[String(id)] = { front, back, tags: (tags || '').trim(), displayFields };
    }

    onProgress('Extracting cards...');
    const cardsResult = db.exec('SELECT id, nid, did FROM cards');
    if (!cardsResult.length) throw new Error('No cards found in the deck.');

    const cards = {};
    for (const row of cardsResult[0].values) {
      const [cardId, noteId] = row;
      const note = notes[String(noteId)];
      if (!note || !note.front || !note.back) continue;

      cards[String(cardId)] = {
        front: note.front,
        back: note.back,
        tags: note.tags,
        displayFields: note.displayFields
      };
    }

    // Get deck name
    let deckName = 'Imported Deck';
    try {
      if (tables.has('decks')) {
        const deckResult = db.exec('SELECT name FROM decks LIMIT 1');
        if (deckResult.length && deckResult[0].values.length) {
          deckName = deckResult[0].values[0][0];
        }
      } else if (tables.has('col')) {
        const colResult = db.exec('SELECT decks FROM col LIMIT 1');
        if (colResult.length && colResult[0].values.length) {
          const decks = JSON.parse(colResult[0].values[0][0]);
          const deckEntries = Object.values(decks);
          const nonDefault = deckEntries.find(d => d.name && d.name !== 'Default');
          deckName = (nonDefault || deckEntries[0])?.name || deckName;
        }
      }
    } catch { /* keep default */ }

    onProgress(`Built ${Object.keys(cards).length} cards.`);
    return { cards, deckName, cardCount: Object.keys(cards).length };
  } finally {
    db.close();
  }
}

function buildFieldMapFromCol(db) {
  const fieldMap = {};
  const colResult = db.exec('SELECT models FROM col LIMIT 1');
  if (!colResult.length) return fieldMap;

  const models = JSON.parse(colResult[0].values[0][0]);
  for (const [modelId, model] of Object.entries(models)) {
    fieldMap[modelId] = (model.flds || [])
      .sort((a, b) => a.ord - b.ord)
      .map(f => f.name);
  }
  return fieldMap;
}

function buildFieldMapFromTables(db) {
  const fieldMap = {};
  const fieldsResult = db.exec('SELECT ntid, name, ord FROM fields ORDER BY ntid, ord');
  if (!fieldsResult.length) return fieldMap;

  for (const row of fieldsResult[0].values) {
    const [ntid, name] = row;
    const key = String(ntid);
    if (!fieldMap[key]) fieldMap[key] = [];
    fieldMap[key].push(name);
  }
  return fieldMap;
}

if (typeof globalThis !== 'undefined') {
  globalThis.previewApkg = previewApkg;
  globalThis.buildCards = buildCards;
}
