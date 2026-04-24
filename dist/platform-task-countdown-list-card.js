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

    const color = t.project_color || '';
    const accentStyle = color ? `style="background:${this._safeColor(color)}"` : '';

    return `
      <div class="row ${tone}"
           data-uid="${this._esc(t.id)}"
           data-entity="${this._esc(t.project_entity_id)}"
           data-title="${this._esc(t.title)}">
        <div class="accent" ${accentStyle}></div>
        <div class="body">
          <div class="task-title">${this._esc(t.title)}</div>
          <div class="row-meta">
            <span class="project">${this._esc(t.project_name)}</span>
            ${t.is_all_day ? '' : `<span class="time">${this._fmtTime(t.due_at)}</span>`}
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
      ha-card.root { padding: 0; overflow: hidden; }

      .header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        padding: 16px 18px 8px;
      }
      .title { font-size: 18px; font-weight: 600; color: var(--primary-text-color); }
      .meta { display: flex; gap: 8px; align-items: center; color: var(--secondary-text-color); font-size: 12px; }
      .badge {
        padding: 2px 8px; border-radius: 10px;
        font-size: 11px; font-weight: 600; letter-spacing: 0.02em;
      }
      .badge.overdue { background: rgba(239,68,68,0.15); color: #dc2626; }
      .badge.today   { background: rgba(245,158,11,0.18); color: #b45309; }
      .count { font-variant-numeric: tabular-nums; opacity: 0.6; }

      .list { padding: 4px 8px 12px; max-height: 60vh; overflow-y: auto; }
      .list::-webkit-scrollbar { width: 6px; }
      .list::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.15); border-radius: 3px; }

      .row {
        position: relative;
        display: grid;
        grid-template-columns: 4px 1fr auto auto;
        gap: 12px;
        align-items: center;
        padding: 12px 10px 12px 0;
        border-bottom: 1px solid var(--divider-color, rgba(0,0,0,0.08));
        cursor: pointer;
        transition: background 120ms ease, opacity 200ms ease, transform 200ms ease;
      }
      .list.compact .row { padding: 8px 10px 8px 0; }
      .row:last-child { border-bottom: none; }
      .row:hover { background: rgba(0,0,0,0.03); }

      .accent {
        width: 4px;
        align-self: stretch;
        background: var(--primary-color);
        border-radius: 0 4px 4px 0;
        opacity: 0.85;
      }
      .row.overdue .accent { background: #dc2626; }
      .row.today .accent { background: #f59e0b; }

      .body { min-width: 0; }
      .task-title {
        font-size: 15px;
        font-weight: 500;
        color: var(--primary-text-color);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .row-meta {
        margin-top: 2px;
        display: flex;
        gap: 8px;
        font-size: 12px;
        color: var(--secondary-text-color);
      }
      .row-meta .time { font-variant-numeric: tabular-nums; opacity: 0.85; }

      .countdown {
        text-align: right;
        min-width: 56px;
        line-height: 1;
      }
      .countdown .big {
        font-size: 28px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: var(--primary-text-color);
        letter-spacing: -0.02em;
      }
      .countdown .label {
        margin-top: 2px;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--secondary-text-color);
      }
      .row.overdue .countdown .big { color: #dc2626; }
      .row.today .countdown .big { color: #b45309; font-size: 22px; }

      .check {
        background: transparent;
        border: 1px solid var(--divider-color, rgba(0,0,0,0.18));
        color: var(--primary-text-color);
        border-radius: 50%;
        width: 32px;
        height: 32px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        opacity: 0.55;
        transition: opacity 120ms ease, background 120ms ease, color 120ms ease;
      }
      .row:hover .check { opacity: 1; }
      .check:hover { background: #16a34a; color: white; border-color: #16a34a; }

      .row.checked { opacity: 0.4; transform: translateX(8px); pointer-events: none; }

      .empty {
        padding: 24px;
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
