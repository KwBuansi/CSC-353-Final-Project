/**
 * View Grades — loads `data/grades_snapshot.json` (written by DataImporter.py).
 * and renders a student × assignment heatmap with filters.
 */

(function () {
  'use strict';

  const CFG = typeof window.__VIEW_GRADES_CONFIG__ === 'object' ? window.__VIEW_GRADES_CONFIG__ : {};
  const GRADES_JSON_URL =
    typeof CFG.gradesJsonUrl === 'string' && CFG.gradesJsonUrl.trim()
      ? CFG.gradesJsonUrl.trim()
      : 'data/grades_snapshot.json';

  const HEATMAP_BLUE_LIGHT = Object.freeze([232, 242, 255]);
  const HEATMAP_BLUE_DARK = Object.freeze([12, 59, 130]);

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

  function buildScoreCell(percent) {
    const td = createEl('td', 'heatmap-cell');
    if (percent == null || Number.isNaN(percent)) {
      td.textContent = '—';
      td.style.background = '#eceff1';
      td.style.color = '#607d8b';
      td.style.fontWeight = 'normal';
      td.title = 'No grade';
      return td;
    }
    const rounded = Math.round(percent * 10) / 10;
    td.textContent = `${rounded}%`;
    const rgb = backgroundRgbForPercent(percent);
    td.style.backgroundColor = `rgb(${rgb.join(',')})`;
    td.style.color = textColorForBackground(rgb);
    td.title = `Score: ${rounded}%`;
    return td;
  }

  function rowIdentity(r) {
    return [r.student_number, r.course_code, r.year, r.season, r.section_label].join('|');
  }

  function uniqueSorted(values) {
    return Array.from(new Set(values.filter((v) => v != null && String(v).length)))
      .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' }));
  }

  function applyFilters(rows, f) {
    return rows.filter((r) => {
      if (f.year && String(r.year) !== String(f.year)) return false;
      if (f.season && String(r.season) !== String(f.season)) return false;
      if (f.course && String(r.course_code) !== String(f.course)) return false;
      if (f.section && String(r.section_label) !== String(f.section)) return false;
      return true;
    });
  }

  function buildFilterBar(rows, onChange) {
    const wrap = document.getElementById('filterBar');
    if (!wrap) return;

    const years = uniqueSorted(rows.map((r) => r.year));
    const seasons = uniqueSorted(rows.map((r) => r.season));
    const courses = uniqueSorted(rows.map((r) => r.course_code));
    const sections = uniqueSorted(rows.map((r) => r.section_label));

    function addSelect(labelText, id, options, includeAll) {
      const group = createEl('div', 'filter-field');
      const lab = createEl('label', null, labelText);
      lab.setAttribute('for', id);
      const sel = createEl('select', 'w3-select w3-border');
      sel.id = id;
      if (includeAll) {
        const opt0 = createEl('option', null, 'All');
        opt0.value = '';
        sel.appendChild(opt0);
      }
      options.forEach((v) => {
        const opt = createEl('option', null, String(v));
        opt.value = String(v);
        sel.appendChild(opt);
      });
      sel.addEventListener('change', onChange);
      group.appendChild(lab);
      group.appendChild(sel);
      wrap.appendChild(group);
    }

    wrap.innerHTML = '';
    addSelect('Year', 'fltYear', years, false);
    addSelect('Semester', 'fltSeason', seasons, true);
    addSelect('Course', 'fltCourse', courses, true);
    addSelect('Section', 'fltSection', sections, true);
  }

  function readFilters() {
    const y = document.getElementById('fltYear');
    const s = document.getElementById('fltSeason');
    const c = document.getElementById('fltCourse');
    const sec = document.getElementById('fltSection');
    return {
      year: y && y.value ? y.value : '',
      season: s && s.value ? s.value : '',
      course: c && c.value ? c.value : '',
      section: sec && sec.value ? sec.value : '',
    };
  }

  function pivotForHeatmap(filteredRows) {
    const assignmentNames = uniqueSorted(filteredRows.map((r) => r.assignment_name));
    const rowKeys = uniqueSorted(filteredRows.map((r) => rowIdentity(r)));

    const matrix = new Map();
    filteredRows.forEach((r) => {
      const rk = rowIdentity(r);
      if (!matrix.has(rk)) matrix.set(rk, new Map());
      matrix.get(rk).set(r.assignment_name, Number(r.grade_percent));
    });

    const rowMeta = new Map();
    filteredRows.forEach((r) => {
      rowMeta.set(rowIdentity(r), r);
    });

    function rowLabel(rk) {
      const r = rowMeta.get(rk);
      if (!r) return rk;
      const name = String(r.student_name || '').trim();
      return name || String(r.student_number);
    }

    function rowTitle(rk) {
      const r = rowMeta.get(rk);
      if (!r) return '';
      return `ID ${r.student_number} · ${r.course_code} (${r.season} ${r.year}) sec ${r.section_label}`;
    }

    return { assignmentNames, rowKeys, matrix, rowLabel, rowTitle };
  }

  function renderHeatmap(pivot) {
    const wrap = document.getElementById('heatmapWrap');
    wrap.innerHTML = '';

    wrap.appendChild(buildLegend());

    const table = createEl('table', 'heatmap-table');
    const headerRow = createEl('tr');
    headerRow.appendChild(createEl('th', 'row-head', 'Name'));

    pivot.assignmentNames.forEach((title) => {
      headerRow.appendChild(createEl('th', null, title));
    });

    const thead = createEl('thead');
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = createEl('tbody');
    pivot.rowKeys.forEach((rk) => {
      const tr = createEl('tr');
      const head = createEl('th', 'row-head', pivot.rowLabel(rk));
      head.title = pivot.rowTitle(rk);
      tr.appendChild(head);
      pivot.assignmentNames.forEach((an) => {
        const pct = pivot.matrix.get(rk)?.get(an);
        tr.appendChild(buildScoreCell(pct));
      });
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  async function loadJson() {
    const response = await fetch(GRADES_JSON_URL, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Could not load ${GRADES_JSON_URL} (${response.status})`);
    }
    return response.json();
  }

  async function loadHeatmapPage() {
    const loadingEl = document.getElementById('loading');
    const errorEl = document.getElementById('error');
    const hintEl = document.getElementById('dataHint');

    errorEl.textContent = '';
    if (hintEl) hintEl.hidden = true;

    let allRows;
    try {
      const payload = await loadJson();
      allRows = Array.isArray(payload.rows) ? payload.rows : [];
    } catch (e) {
      loadingEl.style.display = 'none';
      errorEl.textContent = String(e.message || e);
      if (hintEl) {
        hintEl.hidden = false;
        hintEl.innerHTML =
          'Put one or more <code>.csv</code> files in <code>data/</code>, set <code>MYSQL_PASSWORD</code> in <code>DataImporter.py</code>, then run <code>python DataImporter.py</code>. ' +
          'Use a local web server (e.g. <code>python -m http.server</code>) so the browser can load the JSON file.';
      }
      return;
    }

    loadingEl.style.display = 'none';

    if (!allRows.length) {
      errorEl.textContent = 'No grades in the snapshot yet. Import a CSV, then export JSON.';
      document.getElementById('heatmapWrap').innerHTML = '';
      const fb = document.getElementById('filterBar');
      if (fb) fb.innerHTML = '';
      return;
    }

    const rerender = () => {
      const f = readFilters();
      const filtered = applyFilters(allRows, f);
      if (!filtered.length) {
        document.getElementById('heatmapWrap').innerHTML = '';
        errorEl.textContent = 'No rows match the current filters.';
        return;
      }
      errorEl.textContent = '';
      const pivot = pivotForHeatmap(filtered);
      renderHeatmap(pivot);
    };

    buildFilterBar(allRows, rerender);
    rerender();
  }

  loadHeatmapPage();
})();
