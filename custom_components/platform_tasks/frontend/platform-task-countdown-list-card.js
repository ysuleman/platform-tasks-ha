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
 */

class PlatformTaskCountdownListCard extends HTMLElement {
  setConfig(config) {
    this._config = {
      entity: 'sensor.platform_tasks_upcoming',
      max_items: 25,
      show_overdue: true,
      compact: false,
      ...config,
    };
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
    }

    if (!sensor) {
      this._root.innerHTML = `<div class="empty">${this._config.entity} not found.</div>`;
      return;
    }

    let tasks = (sensor.attributes.tasks || []).slice();
    if (!this._config.show_overdue) {
      tasks = tasks.filter((t) => !t.is_overdue);
    }
    tasks = tasks.slice(0, this._config.max_items);

    if (tasks.length === 0) {
      this._root.innerHTML = `
        <div class="header">
          <div class="title">Up next</div>
          <div class="meta">all caught up</div>
        </div>
        <div class="empty">No upcoming tasks 🎉</div>
      `;
      return;
    }

    const overdue = sensor.attributes.overdue_count || 0;
    const today = sensor.attributes.today_count || 0;

    const rowsHtml = tasks.map((t) => this._row(t)).join('');

    this._root.innerHTML = `
      <div class="header">
        <div class="title">Up next</div>
        <div class="meta">
          ${overdue > 0 ? `<span class="badge overdue">${overdue} overdue</span>` : ''}
          ${today > 0 ? `<span class="badge today">${today} today</span>` : ''}
          <span class="count">${tasks.length}</span>
        </div>
      </div>
      <div class="list ${this._config.compact ? 'compact' : ''}">
        ${rowsHtml}
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

  async _onClick(e) {
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
