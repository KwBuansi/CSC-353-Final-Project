/**
 * View Grades — loads linked Form-response spreadsheets and renders a student × quiz heatmap.
 * Depends on js/config.local.js defining window.__VIEW_GRADES_CONFIG__.sheetsApiKey (gitignored).
 */

(function () {
  'use strict';

  // --- Configuration (from optional local file) ---------------------------------

  const CFG = typeof window.__VIEW_GRADES_CONFIG__ === 'object' ? window.__VIEW_GRADES_CONFIG__ : {};
  const SHEETS_API_KEY = typeof CFG.sheetsApiKey === 'string' ? CFG.sheetsApiKey.trim() : '';

  const STORAGE_KEY_QR_CODES = 'qrCodes';

  const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

  /** Sequential heatmap blue: pale at 0%, saturated at 100%. */
  const HEATMAP_BLUE_LIGHT = Object.freeze([232, 242, 255]);
  const HEATMAP_BLUE_DARK = Object.freeze([12, 59, 130]);

  // --- Google Sheets API -----------------------------------------------------------

  function escapeSheetTitleForRange(name) {
    return `'${String(name).replace(/'/g, "''")}'`;
  }

  async function fetchJson(url) {
    const response = await fetch(url);
    const payload = await response.json();
    if (!response.ok) {
      const message = payload.error?.message || response.statusText || 'Request failed';
      throw new Error(message);
    }
    return payload;
  }

  /**
   * Finds the responses tab Google creates (“Form Responses 1”), else uses the first sheet.
   */
  async function resolveResponsesSheetTitle(spreadsheetId, apiKey) {
    const fields = encodeURIComponent('sheets(properties(title,sheetId))');
    const url = `${SHEETS_API_BASE}/${spreadsheetId}?key=${encodeURIComponent(apiKey)}&fields=${fields}`;
    const meta = await fetchJson(url);
    const titles = (meta.sheets || []).map((sheet) => sheet.properties?.title).filter(Boolean);

    if (!titles.length) throw new Error('Spreadsheet has no sheets.');

    const formResponsesTab = titles.find((title) => /^form responses/i.test(String(title)));
    return formResponsesTab || titles[0];
  }

  async function fetchSpreadsheetRows(spreadsheetId, apiKey) {
    const sheetTitle = await resolveResponsesSheetTitle(spreadsheetId, apiKey);
    const range = `${escapeSheetTitleForRange(sheetTitle)}!A:ZZ`;
    const rangeEncoded = encodeURIComponent(range);
    const url = `${SHEETS_API_BASE}/${spreadsheetId}/values/${rangeEncoded}?key=${encodeURIComponent(apiKey)}`;
    const data = await fetchJson(url);
    return data.values || [];
  }

  // --- Detect columns & parse scores ----------------------------------------------

  const HEADER_MATCH_TOTAL_POINTS = [
    (header) => /^total\s*points?$/i.test(String(header).trim()),
    (header) => /total\s*points?/i.test(String(header)),
    (header) => /^score$/i.test(String(header).trim()),
    (header) => /\bscore\b/i.test(String(header)),
  ];

  function indexOfScoreColumn(headerRow) {
    if (!headerRow?.length) return -1;

    for (const matchesHeader of HEADER_MATCH_TOTAL_POINTS) {
      const index = headerRow.findIndex((cell) => cell != null && matchesHeader(String(cell)));
      if (index !== -1) return index;
    }
    return -1;
  }

  const HEADER_MATCH_STUDENT_ID = [
    (header) => /student\s*id/i.test(header),
    (header) => /student\s*(number|no\.?|#)/i.test(header),
    (header) => /what.*student.*id/i.test(header),
    (header) => /\bu\s*id\b/i.test(header),
  ];

  function indexOfStudentIdColumn(headerRow, scoreColumnIndex) {
    const headers = headerRow.map((cell) => String(cell == null ? '' : cell).trim());

    for (let columnIndex = 0; columnIndex < headers.length; columnIndex++) {
      if (columnIndex === scoreColumnIndex) continue;
      if (HEADER_MATCH_STUDENT_ID.some((match) => match(headers[columnIndex]))) {
        return columnIndex;
      }
    }

    const timestampIndex = headers.findIndex((header) => /^timestamp$/i.test(header));

    for (let columnIndex = 0; columnIndex < headers.length; columnIndex++) {
      if (columnIndex === scoreColumnIndex || columnIndex === timestampIndex) continue;
      if (/total\s*points?|total\s*score|\bscore\b.*total/i.test(headers[columnIndex])) continue;
      return columnIndex;
    }

    return timestampIndex >= 0 ? 1 : 0;
  }

  /**
   * @returns {number|null} Percentage 0–100, or null if the cell is not a usable score.
   */
  function parseCellToPercent(cellValue) {
    if (cellValue == null || cellValue === '') return null;

    const text = String(cellValue).trim();

    const fractionMatch = text.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
    if (fractionMatch) {
      const numerator = parseFloat(fractionMatch[1]);
      const denominator = parseFloat(fractionMatch[2]);
      if (denominator > 0) return (numerator / denominator) * 100;
      return null;
    }

    const percentSuffix = text.match(/^(\d+(?:\.\d+)?)\s*%$/);
    if (percentSuffix) return parseFloat(percentSuffix[1]);

    const plainNumber = parseFloat(text.replace(/,/g, ''));
    if (Number.isNaN(plainNumber)) return null;
    if (plainNumber >= 0 && plainNumber <= 100) return plainNumber;

    return null;
  }

  /**
   * Reads Form-response rows into map: studentId -> latest score percent (last row wins).
   */
  function scoresByStudentFromRows(rows) {
    if (!rows.length) {
      return {
        byStudent: {},
        note: 'Empty sheet.',
      };
    }

    const headerRow = rows[0].map((cell) => (cell == null ? '' : String(cell)));

    let scoreColumnIndex = indexOfScoreColumn(headerRow);
    if (scoreColumnIndex === -1) scoreColumnIndex = Math.max(0, headerRow.length - 1);

    const studentIdColumnIndex = indexOfStudentIdColumn(headerRow, scoreColumnIndex);

    const byStudent = {};

    for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex] || [];
      const rawId = row[studentIdColumnIndex];
      const studentId = rawId == null ? '' : String(rawId).trim();
      if (!studentId) continue;

      const percent = parseCellToPercent(row[scoreColumnIndex]);
      if (percent == null) continue;

      byStudent[studentId] = percent;
    }

    let note = '';
    if (Object.keys(byStudent).length === 0) {
      note =
        'No scores found. Make sure the quiz has a mandatory student identification question, and is graded (Form → Settings → Make this a quiz).';
    }

    return { byStudent, note };
  }

  // --- Heatmap colors --------------------------------------------------------------

  function mix(a, b, t) {
    return a + (b - a) * t;
  }

  function mixRgb(rgbA, rgbB, t) {
    const clamped = Math.max(0, Math.min(1, t));
    return [
      Math.round(mix(rgbA[0], rgbB[0], clamped)),
      Math.round(mix(rgbA[1], rgbB[1], clamped)),
      Math.round(mix(rgbA[2], rgbB[2], clamped)),
    ];
  }

  function backgroundRgbForPercent(percent) {
    const clampedPercent = Math.max(0, Math.min(100, percent));
    return mixRgb(HEATMAP_BLUE_LIGHT, HEATMAP_BLUE_DARK, clampedPercent / 100);
  }

  function textColorForBackground(rgb) {
    const luminance = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
    return luminance > 0.62 ? '#1a1a1a' : '#fafafa';
  }

  // --- DOM rendering ---------------------------------------------------------------

  function createEl(tagName, className, textContent) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (textContent != null) node.textContent = textContent;
    return node;
  }

  function buildLegend() {
    const container = createEl('div', 'heatmap-legend');
    container.appendChild(createEl('span', null, 'Score scale (lighter → darker blue):'));

    const bar = createEl('div', 'heatmap-legend-bar');
    bar.setAttribute('aria-hidden', 'true');
    bar.style.background = `linear-gradient(to right, rgb(${HEATMAP_BLUE_LIGHT.join(',')}), rgb(${HEATMAP_BLUE_DARK.join(',')}))`;
    container.appendChild(bar);

    const ticks = createEl('div', 'heatmap-legend-ticks');
    ticks.appendChild(createEl('span', null, '0%'));
    ticks.appendChild(createEl('span', null, '100%'));
    container.appendChild(ticks);

    return container;
  }

  function buildScoreCell(quizColumnResult, studentId) {
    const td = createEl('td', 'heatmap-cell');

    if (quizColumnResult.error) {
      td.textContent = '—';
      td.title = quizColumnResult.error;
      td.style.background = '#fce4ec';
      td.style.color = '#333';
      td.style.fontWeight = 'normal';
      return td;
    }

    const scorePercent = quizColumnResult.byStudent[studentId];

    if (scorePercent == null) {
      td.textContent = '—';
      td.style.background = '#eceff1';
      td.style.color = '#607d8b';
      td.style.fontWeight = 'normal';
      td.title = 'No submission';
      return td;
    }

    const rounded = Math.round(scorePercent * 10) / 10;
    td.textContent = `${rounded}%`;

    const rgb = backgroundRgbForPercent(scorePercent);
    td.style.backgroundColor = `rgb(${rgb.join(',')})`;
    td.style.color = textColorForBackground(rgb);
    td.title = `Score: ${rounded}%`;

    return td;
  }

  function renderHeatmap(quizResults, sortedStudentIds, quizTitles) {
    const wrap = document.getElementById('heatmapWrap');
    wrap.innerHTML = '';

    wrap.appendChild(buildLegend());

    const table = createEl('table', 'heatmap-table');

    const headerRow = createEl('tr');
    const cornerHeader = createEl('th', 'row-head', 'Student ID');
    headerRow.appendChild(cornerHeader);

    quizTitles.forEach((title, index) => {
      const th = createEl('th', null, title);
      const columnResult = quizResults[index];
      if (columnResult?.error) {
        th.title = columnResult.error;
        th.style.opacity = '0.85';
      }
      headerRow.appendChild(th);
    });

    const thead = createEl('thead');
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = createEl('tbody');

    sortedStudentIds.forEach((studentId) => {
      const row = createEl('tr');
      row.appendChild(createEl('th', 'row-head', studentId));

      quizResults.forEach((quizColumnResult) => {
        row.appendChild(buildScoreCell(quizColumnResult, studentId));
      });

      tbody.appendChild(row);
    });

    table.appendChild(tbody);
    wrap.appendChild(table);

    quizResults.forEach((quizColumnResult, index) => {
      if (!quizColumnResult.note) return;
      const noteParagraph = createEl('p', 'sheet-note', `${quizTitles[index]}: ${quizColumnResult.note}`);
      wrap.appendChild(noteParagraph);
    });
  }

  // --- Load pipeline ---------------------------------------------------------------

  function readStoredQuizDefinitions() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY_QR_CODES) || '[]');
    } catch {
      return [];
    }
  }

  function collectSortedStudentIds(quizResults) {
    const ids = new Set();
    quizResults.forEach((column) => {
      if (column.byStudent) Object.keys(column.byStudent).forEach((id) => ids.add(id));
    });
    return Array.from(ids).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
    );
  }

  async function fetchOneQuizColumn(entry, apiKey) {
    const title = entry.title || '(Untitled)';

    if (!entry.spreadsheetId) {
      return {
        title,
        error: 'No spreadsheet URL was saved for this assignment. Re-add it from the home page.',
      };
    }

    try {
      const rows = await fetchSpreadsheetRows(entry.spreadsheetId, apiKey);
      const extracted = scoresByStudentFromRows(rows);
      return {
        title,
        byStudent: extracted.byStudent,
        note: extracted.note,
      };
    } catch (error) {
      return {
        title,
        error: String(error.message || error),
      };
    }
  }

  async function loadHeatmapPage() {
    const loadingEl = document.getElementById('loading');
    const errorEl = document.getElementById('error');
    const configHintEl = document.getElementById('configHint');

    errorEl.textContent = '';
    configHintEl.hidden = true;
    configHintEl.innerHTML = '';

    const apiKeyConfigured =
      SHEETS_API_KEY.length > 0 && SHEETS_API_KEY !== 'YOUR_BROWSER_API_KEY_HERE';

    if (!apiKeyConfigured) {
      loadingEl.style.display = 'none';
      configHintEl.hidden = false;
      configHintEl.innerHTML =
        'Copy <code>js/config.local.example.js</code> to <code>js/config.local.js</code>, paste your browser API key into <code>sheetsApiKey</code>, ' +
        'and reload. Sheets must be shared so anyone with the link can view them.';
      return;
    }

    const quizDefinitions = readStoredQuizDefinitions();

    if (!quizDefinitions.length) {
      loadingEl.style.display = 'none';
      errorEl.textContent =
        'No assignments yet. Create a QR code on the home page and include the linked spreadsheet URL.';
      return;
    }

    const missingSpreadsheetCount = quizDefinitions.filter((entry) => !entry.spreadsheetId).length;
    if (missingSpreadsheetCount === quizDefinitions.length) {
      loadingEl.style.display = 'none';
      errorEl.innerHTML =
        'Saved QR codes have no spreadsheet IDs. Recreate them on the home page and paste the <strong>linked Google Sheet</strong> URL from Form → Responses.';
      return;
    }

    const quizResults = await Promise.all(
      quizDefinitions.map((entry) => fetchOneQuizColumn(entry, SHEETS_API_KEY))
    );

    loadingEl.style.display = 'none';

    const quizTitles = quizResults.map((column) => column.title);
    const studentIds = collectSortedStudentIds(quizResults);

    if (studentIds.length === 0 && quizResults.every((column) => column.error)) {
      errorEl.textContent = 'Could not load any spreadsheet. Check sharing and API key.';
    } else if (studentIds.length === 0) {
      errorEl.textContent =
        'No student IDs matched with scores. Ensure the Form asks for student ID and the question title mentions “student id” (or similar).';
    }

    renderHeatmap(quizResults, studentIds, quizTitles);
  }

  loadHeatmapPage();
})();
