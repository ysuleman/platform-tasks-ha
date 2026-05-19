/**
 * platform-task-countdown-list-card
 * Reads sensor.platform_tasks_upcoming.attributes.tasks and renders a
 * scrolling Reddit-style countdown list — one row per task, big "X days"
 * badge, project pill, tap-to-complete.
 *
 * Config:
 *   type: custom:platform-task-countdown-list-card
 *   entity: sensor.platform_tasks_upcoming        # default
 *   max_items: 25                                 # default
 *   show_overdue: true                            # default
 *   compact: false                                # tighter row height
 *   smart_add: true                               # show the smart-add input
 *   default_project_id: ''                        # fallback project for smart_add
 *
 * Smart-add syntax (matches the web's QuickAddBar):
 *   ~Project    ~Multi Word    @username    #tag    !1-4 (priority)
 *   today | tonight | tomorrow | <weekday> | next <weekday> | MM/DD
 *   at 2pm | 2:30pm | 14:30 | in 30 minutes | in 2 hours
 *   daily | weekly | monthly | yearly | every <weekday>
 *
 * Heuristics on top of the web parser:
 *   "Milk to Costco"                  → project hint "Costco"
 *   "Pickup Hafsa 2pm today Madiha"   → assignee "Madiha"
 */

class PlatformTaskCountdownListCard extends HTMLElement {
  setConfig(config) {
    this._config = {
      entity: 'sensor.platform_tasks_upcoming',
      max_items: 200,
      show_overdue: true,
      compact: false,
      default_filter: 'next7', // 'today' | 'tomorrow' | 'next7' | 'all'
      smart_add: true,
      default_project_id: '',
      ...config,
    };
    if (!this._filter) {
      this._filter = this._config.default_filter || 'next7';
    }
    if (this._addValue === undefined) this._addValue = '';
    if (this._addBusy === undefined) this._addBusy = false;
    if (this._addError === undefined) this._addError = '';
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  getCardSize() {
    return 6;
  }

  _render() {
    const hass = this._hass;
    if (!hass) return;
    const sensor = hass.states[this._config.entity];

    if (!this._root) {
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `<style>${this._css()}</style><ha-card class="root"></ha-card>`;
      this._root = this.shadowRoot.querySelector('.root');
      this._root.addEventListener('click', (e) => this._onClick(e));
      this._root.addEventListener('keydown', (e) => this._onKeydown(e));
      this._root.addEventListener('input', (e) => this._onInput(e));
    }

    if (!sensor) {
      this._root.innerHTML = `<div class="empty">${this._config.entity} not found.</div>`;
      return;
    }

    let tasks = (sensor.attributes.tasks || []).slice();
    if (!this._config.show_overdue) {
      tasks = tasks.filter((t) => !t.is_overdue);
    }
    this._projects = sensor.attributes.projects || [];
    this._users = sensor.attributes.users || [];

    const counts = this._counts(tasks);
    const filtered = this._applyFilter(tasks, this._filter).slice(0, this._config.max_items);

    const pillsHtml = this._pillsHtml(counts);
    const overdue = counts.overdue;
    const addBarHtml = this._addBarHtml();

    if (filtered.length === 0) {
      this._root.innerHTML = `
        <div class="header">
          <div class="title">Up next</div>
          <div class="meta">${overdue > 0 ? `<span class="badge overdue">${overdue} overdue</span>` : '<span class="count">0</span>'}</div>
        </div>
        ${addBarHtml}
        ${pillsHtml}
        <div class="empty">No tasks in this view 🎉</div>
      `;
      this._restoreInputFocus();
      return;
    }

    const rowsHtml = filtered.map((t) => this._row(t)).join('');

    this._root.innerHTML = `
      <div class="header">
        <div class="title">Up next</div>
        <div class="meta">
          ${overdue > 0 ? `<span class="badge overdue">${overdue} overdue</span>` : ''}
          <span class="count">${filtered.length}</span>
        </div>
      </div>
      ${addBarHtml}
      ${pillsHtml}
      <div class="list ${this._config.compact ? 'compact' : ''}">
        ${rowsHtml}
      </div>
    `;
    this._restoreInputFocus();
  }

  _restoreInputFocus() {
    // Re-render destroys the input element; if the user was typing into it
    // we put their cursor back where they left it. Skip the focus if the
    // user was interacting elsewhere — e.g. mid-row hover.
    if (!this._addHadFocus) return;
    const el = this.shadowRoot.querySelector('.add-input');
    if (!el) return;
    el.value = this._addValue;
    el.focus();
    const len = this._addValue.length;
    try { el.setSelectionRange(this._addCursor ?? len, this._addCursor ?? len); } catch {}
  }

  _counts(tasks) {
    let today = 0, tomorrow = 0, next7 = 0, overdue = 0;
    for (const t of tasks) {
      if (t.is_overdue) overdue++;
      if (t.is_today || t.is_overdue) today++;
      if (t.days_until === 1) tomorrow++;
      if (t.is_overdue || t.days_until <= 7) next7++;
    }
    return { today, tomorrow, next7, all: tasks.length, overdue };
  }

  _applyFilter(tasks, key) {
    switch (key) {
      case 'today':
        return tasks.filter((t) => t.is_overdue || t.is_today);
      case 'tomorrow':
        return tasks.filter((t) => !t.is_overdue && t.days_until === 1);
      case 'next7':
        return tasks.filter((t) => t.is_overdue || t.days_until <= 7);
      case 'all':
      default:
        return tasks;
    }
  }

  _addBarHtml() {
    if (!this._config.smart_add) return '';
    const value = this._addValue || '';
    const preview = value.trim() ? this._previewParse(value) : null;
    const chipsHtml = preview ? this._previewChipsHtml(preview) : '';
    const errorHtml = this._addError
      ? `<div class="add-error">${this._esc(this._addError)}</div>`
      : '';
    const busy = this._addBusy ? 'busy' : '';
    return `
      <div class="add-bar ${busy}">
        <div class="add-row">
          <input
            class="add-input"
            type="text"
            placeholder="Smart add: Milk to Costco · Pickup Hafsa 2pm today Madiha · Gym every monday !2"
            ${this._addBusy ? 'disabled' : ''}
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
          />
          <button class="add-btn" data-add-submit ${this._addBusy ? 'disabled' : ''} title="Add task (Enter)">
            ${this._addBusy ? '…' : 'Add'}
          </button>
        </div>
        ${chipsHtml}
        ${errorHtml}
      </div>
    `;
  }

  _previewChipsHtml(p) {
    const chips = [];
    if (p.projectName) chips.push(`<span class="pchip pchip-project">~${this._esc(p.projectName)}</span>`);
    else if (p.projectHint) chips.push(`<span class="pchip pchip-project unresolved" title="No project matched">~${this._esc(p.projectHint)}?</span>`);
    if (p.assigneeDisplay) chips.push(`<span class="pchip pchip-user">@${this._esc(p.assigneeDisplay)}</span>`);
    else if (p.assigneeHint) chips.push(`<span class="pchip pchip-user unresolved" title="No user matched">@${this._esc(p.assigneeHint)}?</span>`);
    if (p.due) chips.push(`<span class="pchip pchip-date">${this._esc(p.due)}</span>`);
    if (p.repeat) chips.push(`<span class="pchip pchip-rep">${this._esc(p.repeat)}</span>`);
    if (p.priority) chips.push(`<span class="pchip pchip-pri">!${p.priority}</span>`);
    for (const t of p.tags) chips.push(`<span class="pchip pchip-tag">#${this._esc(t)}</span>`);
    if (!chips.length) return '';
    return `
      <div class="add-preview">
        <span class="add-preview-title">${this._esc(p.title || '(no title)')}</span>
        <span class="add-preview-chips">${chips.join('')}</span>
      </div>
    `;
  }

  // ── Smart-add parser ──────────────────────────────────────────────
  // Mirrors `services/.../platform_tasks/parser.py` for live previews.
  // The Python parser is the source of truth at submission time — this
  // JS pass exists so the user sees their chips resolve as they type.
  _previewParse(raw) {
    const projects = this._projects || [];
    const users = this._users || [];
    const out = {
      title: '',
      priority: 0,
      tags: [],
      projectHint: null,
      projectId: null,
      projectName: null,
      assigneeHint: null,
      assigneeDisplay: null,
      due: null,
      repeat: null,
    };
    let work = raw.trim();
    if (!work) return out;

    // Priority
    const priM = work.match(/(?:^|\s)!([1-4])(?=\s|$)/);
    if (priM) { out.priority = parseInt(priM[1], 10); work = work.replace(priM[0], ' '); }

    // Tags
    work = work.replace(/(?:^|\s)#([A-Za-z0-9_-]+)/g, (_m, t) => {
      if (!out.tags.includes(t)) out.tags.push(t);
      return ' ';
    });

    // ~Project chip
    const projM = work.match(/(?:^|\s)~([A-Za-z0-9_][A-Za-z0-9_\- ]*?)(?=\s[!#@]|$)/);
    if (projM) {
      out.projectHint = projM[1].trim();
      const lc = out.projectHint.toLowerCase();
      const exact = projects.find((p) => (p.name || '').toLowerCase() === lc);
      if (exact) { out.projectId = exact.id; out.projectName = exact.name; }
      work = work.replace(projM[0], ' ');
    }

    // @Assignee chip
    const asnM = work.match(/(?:^|\s)@([A-Za-z0-9_.-]+)/);
    if (asnM) {
      out.assigneeHint = asnM[1];
      const lc = asnM[1].toLowerCase();
      const u = users.find((x) => (x.username || '').toLowerCase() === lc || (x.displayName || '').toLowerCase() === lc);
      if (u) out.assigneeDisplay = u.displayName || u.username;
      work = work.replace(asnM[0], ' ');
    }

    // Recurrence
    const rrules = [
      [/\bevery\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, (m) => `every ${m[1].toLowerCase()}`],
      [/\bevery\s+day\b|\bdaily\b/i, () => 'daily'],
      [/\bevery\s+week\b|\bweekly\b/i, () => 'weekly'],
      [/\bevery\s+month\b|\bmonthly\b/i, () => 'monthly'],
      [/\bevery\s+year\b|\byearly\b|\bannually\b/i, () => 'yearly'],
    ];
    for (const [re, lbl] of rrules) {
      const m = work.match(re);
      if (m) { out.repeat = lbl(m); work = work.replace(m[0], ' '); break; }
    }

    // Date phrase
    const now = new Date();
    let date = null;
    const dayMap = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    const datePatterns = [
      { re: /\btomorrow\b|\btmrw\b/i, resolve: () => new Date(now.getTime() + 86400000) },
      { re: /\btoday\b|\btonight\b|\bnow\b/i, resolve: () => new Date(now) },
      { re: /\bnext\s+week\b/i, resolve: () => new Date(now.getTime() + 7 * 86400000) },
      { re: /\b(?:next|this)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, resolve: (m) => {
        const t = dayMap[m[1].toLowerCase()];
        let delta = (t - now.getDay() + 7) % 7;
        if (/^next/i.test(m[0]) && delta === 0) delta = 7;
        return new Date(now.getTime() + delta * 86400000);
      }},
      { re: /\bin\s+(\d+)\s+(day|week|wk)s?\b/i, resolve: (m) => {
        const n = parseInt(m[1], 10);
        const mult = /week|wk/i.test(m[2]) ? 7 : 1;
        return new Date(now.getTime() + n * mult * 86400000);
      }},
      { re: /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, resolve: (m) => {
        const t = dayMap[m[1].toLowerCase()];
        const delta = ((t - now.getDay()) + 7) % 7 || 7;
        return new Date(now.getTime() + delta * 86400000);
      }},
      { re: /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/, resolve: (m) => {
        const mm = parseInt(m[1], 10), dd = parseInt(m[2], 10);
        let yy = m[3] ? parseInt(m[3], 10) : now.getFullYear();
        if (yy < 100) yy += 2000;
        const d = new Date(yy, mm - 1, dd);
        if (!m[3] && d < now) d.setFullYear(yy + 1);
        return d;
      }},
    ];
    for (const { re, resolve } of datePatterns) {
      const m = work.match(re);
      if (!m) continue;
      try {
        date = resolve(m);
        work = work.replace(m[0], ' ');
      } catch {}
      break;
    }

    // Time phrase
    let timeSet = false;
    const timeM = work.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(?:at\s+)?(\d{1,2}):(\d{2})\b/i);
    if (timeM) {
      let h, mm;
      if (timeM[3]) {
        h = parseInt(timeM[1], 10);
        mm = parseInt(timeM[2] || '0', 10);
        const ap = timeM[3].toLowerCase();
        if (ap === 'pm' && h < 12) h += 12;
        if (ap === 'am' && h === 12) h = 0;
      } else {
        h = parseInt(timeM[4], 10);
        mm = parseInt(timeM[5], 10);
      }
      if (h >= 0 && h < 24 && mm >= 0 && mm < 60) {
        if (!date) date = new Date(now);
        date.setHours(h, mm, 0, 0);
        timeSet = true;
        work = work.replace(timeM[0], ' ');
      }
    }

    // "in N min/hour" supersedes date+time
    const relM = work.match(/\bin\s+(\d+)\s+(minute|min|hour|hr)s?\b/i);
    if (relM) {
      const n = parseInt(relM[1], 10);
      const unit = relM[2].toLowerCase();
      const ms = unit.startsWith('min') ? n * 60000 : n * 3600000;
      date = new Date(now.getTime() + ms);
      timeSet = true;
      work = work.replace(relM[0], ' ');
    }

    if (date) {
      out.due = this._fmtDuePreview(date, timeSet);
    }

    // "to <known-project>" trailing heuristic
    if (!out.projectId && projects.length) {
      const lcWork = work.toLowerCase();
      const sorted = projects.slice().sort((a, b) => (b.name || '').length - (a.name || '').length);
      for (const p of sorted) {
        const name = (p.name || '').trim();
        if (!name) continue;
        const needle = ' to ' + name.toLowerCase();
        if (lcWork.endsWith(needle)) {
          out.projectId = p.id;
          out.projectName = p.name;
          out.projectHint = p.name;
          work = work.slice(0, work.length - needle.length).trimEnd();
          break;
        }
      }
    }

    // Trailing known-name assignee
    if (!out.assigneeDisplay && users.length) {
      const tokens = work.split(/\s+/).filter(Boolean);
      for (const take of [2, 1]) {
        if (tokens.length < take + 1) continue;
        const tail = tokens.slice(-take).join(' ').toLowerCase();
        const u = users.find((x) => (x.username || '').toLowerCase() === tail || (x.displayName || '').toLowerCase() === tail);
        if (u) {
          out.assigneeDisplay = u.displayName || u.username;
          out.assigneeHint = u.displayName || u.username;
          work = tokens.slice(0, tokens.length - take).join(' ');
          break;
        }
      }
    }

    out.title = work.replace(/\s+/g, ' ').trim();
    return out;
  }

  _fmtDuePreview(d, hasTime) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = Math.round((target - today) / 86400000);
    let label;
    if (diff === 0) label = 'Today';
    else if (diff === 1) label = 'Tomorrow';
    else if (diff > 1 && diff < 7) label = d.toLocaleDateString(undefined, { weekday: 'short' });
    else if (diff === -1) label = 'Yesterday';
    else label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    if (hasTime) {
      label += ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(/\s/g, '');
    }
    return label;
  }

  _pillsHtml(counts) {
    const pills = [
      { key: 'today',    label: 'Today',    n: counts.today },
      { key: 'tomorrow', label: 'Tomorrow', n: counts.tomorrow },
      { key: 'next7',    label: '7 days',   n: counts.next7 },
      { key: 'all',      label: 'All',      n: counts.all },
    ];
    return `
      <div class="pills" role="tablist">
        ${pills.map((p) => `
          <button class="pill ${this._filter === p.key ? 'active' : ''}"
                  data-filter="${p.key}"
                  role="tab"
                  aria-selected="${this._filter === p.key}">
            <span class="pill-label">${p.label}</span>
            <span class="pill-count">${p.n}</span>
          </button>
        `).join('')}
      </div>
    `;
  }

  _row(t) {
    const days = t.days_until;
    let label, big, tone;
    if (t.is_overdue) {
      tone = 'overdue';
      big = `${Math.abs(days)}`;
      label = `day${Math.abs(days) === 1 ? '' : 's'} late`;
    } else if (days === 0) {
      tone = 'today';
      big = 'TODAY';
      label = '';
    } else if (days === 1) {
      tone = 'soon';
      big = '1';
      label = 'day';
    } else {
      tone = days <= 3 ? 'soon' : 'later';
      big = `${days}`;
      label = 'days';
    }

    const fill = this._resolveColor(t);
    const ink = this._isLight(fill) ? '#0f172a' : '#ffffff';
    const inkSoft = this._isLight(fill) ? 'rgba(15,23,42,0.62)' : 'rgba(255,255,255,0.72)';
    const inkBig = this._isLight(fill) ? 'rgba(15,23,42,0.92)' : 'rgba(255,255,255,0.95)';
    const chipBg = this._isLight(fill) ? 'rgba(15,23,42,0.10)' : 'rgba(255,255,255,0.18)';
    const checkBg = this._isLight(fill) ? 'rgba(15,23,42,0.10)' : 'rgba(255,255,255,0.18)';

    const entityId = this._resolveEntity(t) || '';

    const rowStyle = `style="background:${fill};color:${ink};--ink:${ink};--ink-soft:${inkSoft};--ink-big:${inkBig};--chip-bg:${chipBg};--check-bg:${checkBg};"`;

    return `
      <div class="row ${tone}" ${rowStyle}
           data-uid="${this._esc(t.id)}"
           data-entity="${this._esc(entityId)}"
           data-title="${this._esc(t.title)}">
        <div class="body">
          <div class="task-title">${this._esc(t.title)}</div>
          <div class="row-meta">
            <span class="project chip">${this._esc(t.project_name)}</span>
            ${t.is_all_day ? '' : `<span class="time">${this._fmtTime(t.due_at)}</span>`}
            ${t.is_overdue ? `<span class="state-chip overdue-chip">overdue</span>` : ''}
            ${t.is_today && !t.is_overdue ? `<span class="state-chip today-chip">today</span>` : ''}
          </div>
        </div>
        <div class="countdown">
          <div class="big">${big}</div>
          ${label ? `<div class="label">${label}</div>` : ''}
        </div>
        <button class="check" title="Mark complete" aria-label="Mark complete">
          <svg viewBox="0 0 24 24" width="20" height="20"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.42L9 16.17z" fill="currentColor"/></svg>
        </button>
      </div>
    `;
  }

  _resolveColor(task) {
    // 1. Explicit project color.
    const explicit = this._safeColor(task.project_color || '');
    if (explicit !== 'transparent') return explicit;
    // 2. Deterministic fallback by project_id hash. Palette tuned to
    // sit alongside the Platform web app's emerald accent — saturated
    // but not neon. Emerald lead so projects without colors still
    // feel on-brand.
    const palette = [
      '#059669', // emerald (Platform accent)
      '#0ea5e9', // sky
      '#8b5cf6', // violet
      '#f97316', // orange
      '#ec4899', // pink
      '#14b8a6', // teal
      '#6366f1', // indigo
      '#eab308', // amber
    ];
    const key = task.project_id || task.project_name || task.title || '';
    let h = 0;
    for (let i = 0; i < key.length; i++) {
      h = (h * 31 + key.charCodeAt(i)) | 0;
    }
    return palette[Math.abs(h) % palette.length];
  }

  _isLight(hexOrRgb) {
    let h = (hexOrRgb || '').trim();
    if (!h.startsWith('#')) return false;
    h = h.slice(1);
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6) return false;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    // Perceived luminance per ITU-R BT.601.
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62;
  }

  _resolveEntity(task) {
    // Prefer the explicit entity_id from the coordinator. If missing
    // (older integration build), fall back to matching a todo entity by
    // friendly_name `Platform: <project_name>`.
    if (task.project_entity_id) return task.project_entity_id;
    if (!task.project_name || !this._hass) return null;
    const target = `Platform: ${task.project_name}`;
    for (const eid in this._hass.states) {
      if (!eid.startsWith('todo.platform_')) continue;
      const fname = this._hass.states[eid].attributes.friendly_name || '';
      if (fname === target) return eid;
    }
    return null;
  }

  _onInput(e) {
    const input = e.target.closest('.add-input');
    if (!input) return;
    this._addValue = input.value;
    this._addCursor = input.selectionStart || 0;
    this._addHadFocus = true;
    if (this._addError) this._addError = '';
    // Throttle preview re-render so fast typing doesn't thrash.
    clearTimeout(this._previewT);
    this._previewT = setTimeout(() => this._renderPreviewOnly(), 80);
  }

  _renderPreviewOnly() {
    const host = this.shadowRoot.querySelector('.add-bar');
    if (!host) return;
    const value = this._addValue || '';
    const preview = value.trim() ? this._previewParse(value) : null;
    let chips = host.querySelector('.add-preview');
    const html = preview ? this._previewChipsHtml(preview) : '';
    if (chips) chips.outerHTML = html || '';
    else if (html) {
      const errorEl = host.querySelector('.add-error');
      const tpl = document.createElement('template');
      tpl.innerHTML = html.trim();
      if (errorEl) errorEl.before(tpl.content);
      else host.appendChild(tpl.content);
    }
  }

  _onKeydown(e) {
    const input = e.target.closest('.add-input');
    if (!input) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this._submitAdd();
    } else if (e.key === 'Escape') {
      this._addValue = '';
      this._addError = '';
      this._addHadFocus = false;
      this._render();
    }
  }

  async _submitAdd() {
    const text = (this._addValue || '').trim();
    if (!text || this._addBusy) return;
    this._addBusy = true;
    this._addError = '';
    this._render();
    try {
      await this._hass.callService(
        'platform_tasks',
        'smart_add',
        this._config.default_project_id
          ? { text, default_project_id: this._config.default_project_id }
          : { text },
      );
      this._addValue = '';
      this._addHadFocus = true;
      this._addCursor = 0;
    } catch (err) {
      this._addError = (err && (err.message || err.error || String(err))) || 'Add failed.';
    } finally {
      this._addBusy = false;
      this._render();
    }
  }

  async _onClick(e) {
    const addBtn = e.target.closest('[data-add-submit]');
    if (addBtn) {
      this._submitAdd();
      return;
    }
    const pill = e.target.closest('.pill');
    if (pill) {
      const next = pill.dataset.filter;
      if (next && next !== this._filter) {
        this._filter = next;
        this._render();
      }
      return;
    }
    const row = e.target.closest('.row');
    if (!row) return;
    const isCheck = !!e.target.closest('.check');
    const uid = row.dataset.uid;
    const entity = row.dataset.entity;
    const title = row.dataset.title;

    if (isCheck && uid && entity) {
      // Optimistic UI: collapse the row immediately.
      row.classList.add('checked');
      try {
        await this._hass.callService('todo', 'update_item', {
          entity_id: entity,
          item: uid,           // platform task UUID is the HA TodoItem.uid
          status: 'completed',
        });
      } catch (err) {
        row.classList.remove('checked');
        // Fallback: try matching by title (shouldn't be needed).
        try {
          await this._hass.callService('todo', 'update_item', {
            entity_id: entity,
            item: title,
            status: 'completed',
          });
        } catch (err2) {
          console.error('platform-task-countdown-list-card: complete failed', err, err2);
        }
      }
      return;
    }

    // Tap on row body opens the more-info dialog for the project entity.
    if (entity) {
      this._fireEvent('hass-more-info', { entityId: entity });
    }
  }

  _fireEvent(type, detail) {
    const event = new Event(type, { bubbles: true, composed: true });
    event.detail = detail;
    this.dispatchEvent(event);
  }

  _fmtTime(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  _safeColor(c) {
    // Accept #abc / #aabbcc / rgb(...) only — block anything else.
    return /^(#[0-9a-fA-F]{3,8}|rgb[a]?\([^)]+\))$/.test(c) ? c : 'transparent';
  }

  _css() {
    return `
      :host { display: block; }
      ha-card.root { padding: 0; overflow: hidden; background: transparent; box-shadow: none; }

      .header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        padding: 16px 18px 12px;
      }
      .title { font-size: 18px; font-weight: 600; color: var(--primary-text-color); letter-spacing: -0.01em; }
      .meta { display: flex; gap: 8px; align-items: center; color: var(--secondary-text-color); font-size: 12px; }
      .badge {
        padding: 2px 9px; border-radius: 999px;
        font-size: 11px; font-weight: 600; letter-spacing: 0.02em;
      }
      .badge.overdue { background: rgba(220,38,38,0.14); color: #dc2626; }
      .badge.today   { background: rgba(180,83,9,0.16); color: #b45309; }
      .count { font-variant-numeric: tabular-nums; opacity: 0.55; font-weight: 600; }

      .add-bar {
        padding: 4px 14px 10px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .add-bar.busy { opacity: 0.7; }
      .add-row {
        display: flex;
        gap: 6px;
        align-items: stretch;
      }
      .add-input {
        flex: 1 1 auto;
        min-width: 0;
        font: inherit;
        font-size: 13.5px;
        padding: 9px 12px;
        border-radius: 12px;
        border: 1px solid var(--divider-color, rgba(0,0,0,0.10));
        background: var(--card-background-color, rgba(0,0,0,0.02));
        color: var(--primary-text-color);
        outline: none;
        transition: border-color 120ms ease, box-shadow 120ms ease;
      }
      .add-input:focus {
        border-color: #059669;
        box-shadow: 0 0 0 3px rgba(5,150,105,0.18);
      }
      .add-input::placeholder { color: var(--secondary-text-color); opacity: 0.7; }
      .add-btn {
        background: #059669;
        color: #fff;
        border: none;
        border-radius: 12px;
        padding: 0 14px;
        font: inherit;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.02em;
        cursor: pointer;
        transition: background 120ms ease, transform 120ms ease;
      }
      .add-btn:hover:not([disabled]) { background: #047857; }
      .add-btn:active:not([disabled]) { transform: scale(0.97); }
      .add-btn[disabled] { opacity: 0.6; cursor: progress; }
      .add-preview {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
        font-size: 11.5px;
        color: var(--secondary-text-color);
        padding: 0 4px;
      }
      .add-preview-title {
        font-weight: 600;
        color: var(--primary-text-color);
        max-width: 240px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .add-preview-chips { display: contents; }
      .pchip {
        padding: 1px 7px;
        border-radius: 999px;
        background: rgba(5,150,105,0.10);
        color: #059669;
        font-weight: 600;
        font-size: 10.5px;
        letter-spacing: 0.01em;
      }
      .pchip.unresolved {
        background: rgba(220,38,38,0.10);
        color: #dc2626;
      }
      .pchip-user { background: rgba(99,102,241,0.10); color: #6366f1; }
      .pchip-date { background: rgba(245,158,11,0.14); color: #b45309; }
      .pchip-rep  { background: rgba(14,165,233,0.12); color: #0369a1; }
      .pchip-pri  { background: rgba(220,38,38,0.10); color: #dc2626; }
      .pchip-tag  { background: rgba(0,0,0,0.06); color: var(--secondary-text-color); }
      .pchip-user.unresolved, .pchip-project.unresolved { background: rgba(220,38,38,0.10); color: #dc2626; }
      .add-error {
        font-size: 11.5px;
        color: #dc2626;
        padding: 0 4px;
        font-weight: 600;
      }

      .pills {
        display: flex;
        gap: 6px;
        padding: 0 14px 12px;
        flex-wrap: wrap;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: var(--card-background-color, rgba(0,0,0,0.04));
        color: var(--secondary-text-color);
        border: 1px solid var(--divider-color, rgba(0,0,0,0.08));
        border-radius: 999px;
        padding: 5px 12px;
        font-size: 12.5px;
        font-weight: 600;
        cursor: pointer;
        line-height: 1;
        transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
      }
      .pill:hover { background: rgba(5,150,105,0.10); color: var(--primary-text-color); }
      .pill.active {
        background: #059669;
        color: #fff;
        border-color: #059669;
      }
      .pill .pill-count {
        background: rgba(0,0,0,0.10);
        color: inherit;
        padding: 1px 7px;
        border-radius: 999px;
        font-size: 10.5px;
        font-variant-numeric: tabular-nums;
      }
      .pill.active .pill-count { background: rgba(255,255,255,0.22); }

      .list {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 0 12px 14px;
        max-height: 70vh;
        overflow-y: auto;
      }
      .list.compact { gap: 6px; }
      .list::-webkit-scrollbar { width: 6px; }
      .list::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.18); border-radius: 3px; }

      .row {
        position: relative;
        display: grid;
        grid-template-columns: 1fr auto auto;
        gap: 14px;
        align-items: center;
        padding: 14px 16px;
        border-radius: 16px;
        cursor: pointer;
        color: var(--ink);
        box-shadow: 0 1px 0 rgba(0,0,0,0.04), 0 6px 14px -8px rgba(0,0,0,0.18);
        transition: transform 140ms ease, box-shadow 140ms ease, opacity 200ms ease, filter 140ms ease;
      }
      .list.compact .row { padding: 10px 14px; border-radius: 12px; }
      .row:hover {
        transform: translateY(-1px);
        box-shadow: 0 1px 0 rgba(0,0,0,0.04), 0 12px 22px -10px rgba(0,0,0,0.24);
        filter: saturate(1.05);
      }
      .row.overdue { box-shadow: 0 0 0 2px rgba(220,38,38,0.55), 0 6px 14px -8px rgba(0,0,0,0.18); }
      .row.today   { box-shadow: 0 0 0 2px rgba(245,158,11,0.55), 0 6px 14px -8px rgba(0,0,0,0.18); }

      .body { min-width: 0; }
      .task-title {
        font-size: 15px;
        font-weight: 600;
        color: var(--ink);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        letter-spacing: -0.005em;
      }
      .row-meta {
        margin-top: 6px;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
        font-size: 11.5px;
        color: var(--ink-soft);
      }
      .chip {
        background: var(--chip-bg);
        color: var(--ink);
        padding: 2px 9px;
        border-radius: 999px;
        font-weight: 600;
        font-size: 11px;
        letter-spacing: 0.01em;
      }
      .row-meta .time { font-variant-numeric: tabular-nums; opacity: 0.95; }
      .state-chip {
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 10.5px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .overdue-chip { background: rgba(220,38,38,0.92); color: #fff; }
      .today-chip   { background: rgba(245,158,11,0.92); color: #1f1300; }

      .countdown {
        text-align: right;
        min-width: 60px;
        line-height: 1;
      }
      .countdown .big {
        font-size: 32px;
        font-weight: 800;
        font-variant-numeric: tabular-nums;
        color: var(--ink-big);
        letter-spacing: -0.025em;
      }
      .countdown .label {
        margin-top: 3px;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--ink-soft);
        font-weight: 600;
      }
      .row.today .countdown .big { font-size: 22px; }

      .check {
        background: var(--check-bg);
        border: none;
        color: var(--ink);
        border-radius: 50%;
        width: 34px;
        height: 34px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        opacity: 0.85;
        transition: opacity 120ms ease, background 120ms ease, color 120ms ease, transform 120ms ease;
      }
      .row:hover .check { opacity: 1; }
      .check:hover { background: #16a34a; color: white; transform: scale(1.05); }

      .row.checked { opacity: 0.4; transform: translateX(8px); pointer-events: none; }

      .empty {
        padding: 32px;
        text-align: center;
        color: var(--secondary-text-color);
        font-size: 14px;
      }
    `;
  }
}

if (!customElements.get('platform-task-countdown-list-card')) {
  customElements.define('platform-task-countdown-list-card', PlatformTaskCountdownListCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'platform-task-countdown-list-card',
    name: 'Platform Task Countdown List',
    description: 'Scrolling list of upcoming Platform tasks with day-countdown badges.',
    preview: false,
  });
}
