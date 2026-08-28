const DAY_KEYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

const DAY_LABELS = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

const DEFAULT_SEASONS = [
  { id: "winter", name: "Winter", icon: "❄️", defaultMode: "heat" },
  { id: "summer", name: "Summer", icon: "☀️", defaultMode: "cool" },
  { id: "shoulder", name: "Spring / Fall", icon: "🍃", defaultMode: "auto" },
];

const DEFAULT_GRADIENT_START = "#2563eb";
const DEFAULT_GRADIENT_END = "#ef4444";
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function configuredColor(value, defaultColor, optionName) {
  if (value == null) return defaultColor;
  if (!HEX_COLOR.test(value)) {
    throw new Error(`climate-schedule-card ${optionName} must be a six-digit hex color`);
  }
  return value.toLowerCase();
}

const HVAC_MODES = [
  { id: "heat", label: "Heat", icon: "♨" },
  { id: "cool", label: "Cool", icon: "❄" },
  { id: "auto", label: "Auto", icon: "↕" },
  { id: "dry", label: "Dry", icon: "💧" },
  { id: "fan_only", label: "Fan only", icon: "◉" },
  { id: "off", label: "Off", icon: "○" },
];

function emptyWeek() {
  return Object.fromEntries(DAY_KEYS.map((day) => [day, []]));
}

function minutes(value) {
  if (value === "24:00") return 1440;
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function clockTime(totalMinutes) {
  const bounded = Math.max(0, Math.min(1440, totalMinutes));
  if (bounded === 1440) return "24:00";
  const hour = Math.floor(bounded / 60);
  const minute = bounded % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function displayTime(value) {
  if (value === "24:00") return "12a";
  const hour = Number(value.slice(0, 2));
  const minute = value.slice(3);
  const suffix = hour >= 12 ? "p" : "a";
  const clockHour = hour % 12 || 12;
  return `${clockHour}${minute === "00" ? "" : `:${minute}`}${suffix}`;
}

class ClimateScheduleCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._selectedZone = 0;
    this._selectedSeason = DEFAULT_SEASONS[0].id;
    this._seasonWeeks = [];
    this._zones = [];
    this._seasons = [];
    this._editor = null;
    this._editorError = "";
    this._drag = null;
    this._documentEntities = {};
    this._revision = 0;
    this._activeSeason = DEFAULT_SEASONS[0].id;
    this._gradientStart = DEFAULT_GRADIENT_START;
    this._gradientEnd = DEFAULT_GRADIENT_END;
    this._loaded = false;
    this._loading = false;
    this._saving = false;
    this._loadError = "";
    this._saveChain = Promise.resolve();
    this._unsubscribe = null;
    this.shadowRoot.addEventListener("click", (event) => this._handleClick(event));
    this.shadowRoot.addEventListener("keydown", (event) => this._handleKeydown(event));
    this.shadowRoot.addEventListener("pointerdown", (event) => this._startResize(event));
    this.shadowRoot.addEventListener("pointermove", (event) => this._moveResize(event));
    this.shadowRoot.addEventListener("pointerup", (event) => this._finishResize(event));
    this.shadowRoot.addEventListener("pointercancel", (event) => this._finishResize(event, true));
  }

  setConfig(config) {
    const zones = config.entities || config.zones;
    if (!Array.isArray(zones) || zones.length === 0) {
      throw new Error("climate-schedule-card requires at least one entity");
    }
    this._config = config;
    this._zones = zones;
    this._gradientStart = configuredColor(
      config.gradient_start,
      DEFAULT_GRADIENT_START,
      "gradient_start",
    );
    this._gradientEnd = configuredColor(
      config.gradient_end,
      DEFAULT_GRADIENT_END,
      "gradient_end",
    );
    this._seasons = DEFAULT_SEASONS;
    this._selectedSeason = config.default_season || this._seasons[0].id;
    this._activeSeason = this._selectedSeason;
    this._seasonWeeks = zones.map(() =>
      Object.fromEntries(
        this._seasons.map((season) => [season.id, emptyWeek()]),
      ),
    );
    this._loaded = false;
    this._loadError = "";
    this._render();
    this._loadSchedule();
  }

  set hass(hass) {
    const firstHass = !this._hass;
    this._hass = hass;
    // This card renders saved schedule data, not live climate state. Home
    // Assistant assigns hass for every state update, so redrawing here would
    // reset the dashboard's scroll position while someone is reading it.
    if (firstHass) this._render();
    this._loadSchedule();
  }

  disconnectedCallback() {
    if (this._unsubscribe) this._unsubscribe();
    this._unsubscribe = null;
  }

  getCardSize() {
    return 9;
  }

  async _loadSchedule(force = false) {
    if (!this._hass || this._loading || (this._loaded && !force)) return;
    this._loading = true;
    this._loadError = "";
    this._render({ preserveEditor: true });
    try {
      const document = await this._hass.callWS({ type: "climate_schedule/get" });
      this._applyDocument(document);
      if (!this._unsubscribe) {
        this._unsubscribe = await this._hass.connection.subscribeMessage(
          (event) => {
            if (!this._saving && Number(event.revision) > this._revision) {
              this._loadSchedule(true);
            }
          },
          { type: "climate_schedule/subscribe" },
        );
      }
    } catch (error) {
      this._loadError = error?.message || "Climate Schedule integration is not available.";
    } finally {
      this._loading = false;
      this._render({ preserveEditor: true });
    }
  }

  _applyDocument(document) {
    this._revision = Number(document.revision) || 0;
    this._activeSeason = document.active_season || DEFAULT_SEASONS[0].id;
    this._seasons = Array.isArray(document.seasons) && document.seasons.length
      ? document.seasons.map((season) => ({
        ...season,
        defaultMode: season.default_mode || season.defaultMode,
      }))
      : DEFAULT_SEASONS;
    this._documentEntities = JSON.parse(JSON.stringify(document.entities || {}));
    this._seasonWeeks = this._zones.map((zone) => {
      const stored = this._documentEntities[zone.entity]?.seasons || {};
      return Object.fromEntries(
        this._seasons.map((season) => {
          const rawWeek = stored[season.id] || {};
          const week = Object.fromEntries(
            DAY_KEYS.map((day) => [
              day,
              Array.isArray(rawWeek[day])
                ? rawWeek[day].map((period) => ({ ...period }))
                : [],
            ]),
          );
          return [season.id, week];
        }),
      );
    });
    if (!this._seasons.some((season) => season.id === this._selectedSeason)) {
      this._selectedSeason = this._seasons[0].id;
    }
    this._loaded = true;
  }

  _scheduleDocument() {
    const entities = JSON.parse(JSON.stringify(this._documentEntities));
    this._zones.forEach((zone, index) => {
      entities[zone.entity] = {
        seasons: JSON.parse(JSON.stringify(this._seasonWeeks[index])),
      };
    });
    return {
      active_season: this._activeSeason,
      seasons: this._seasons.map((season) => ({
        id: season.id,
        name: season.name,
        icon: season.icon,
        default_mode: season.defaultMode,
      })),
      entities,
    };
  }

  _persist() {
    if (!this._hass || !this._loaded) return;
    this._saving = true;
    this._loadError = "";
    this._render();
    this._saveChain = this._saveChain
      .catch(() => undefined)
      .then(async () => {
        const document = await this._hass.callWS({
          type: "climate_schedule/save",
          schedule: this._scheduleDocument(),
          expected_revision: this._revision,
        });
        this._applyDocument(document);
      })
      .catch((error) => {
        this._loadError = error?.message || "Could not save the schedule.";
      })
      .finally(() => {
        this._saving = false;
        this._render();
      });
  }

  _activateSeason() {
    if (!this._hass || !this._loaded || this._selectedSeason === this._activeSeason) return;
    this._saving = true;
    this._loadError = "";
    this._render();
    this._saveChain = this._saveChain
      .catch(() => undefined)
      .then(async () => {
        const document = await this._hass.callWS({
          type: "climate_schedule/set_active_season",
          season_id: this._selectedSeason,
        });
        this._applyDocument(document);
      })
      .catch((error) => {
        this._loadError = error?.message || "Could not activate the season.";
      })
      .finally(() => {
        this._saving = false;
        this._render();
      });
  }

  _zone() {
    return this._zones[this._selectedZone];
  }

  _season() {
    return this._seasons.find((season) => season.id === this._selectedSeason);
  }

  _week() {
    return this._seasonWeeks[this._selectedZone][this._selectedSeason];
  }

  _mode(modeId) {
    return HVAC_MODES.find((mode) => mode.id === modeId) || HVAC_MODES[0];
  }

  _availableModes() {
    const supported = this._hass?.states?.[this._zone().entity]?.attributes?.hvac_modes;
    if (!Array.isArray(supported) || supported.length === 0) return HVAC_MODES;
    const modes = HVAC_MODES.filter((mode) => supported.includes(mode.id));
    return modes.length > 0 ? modes : HVAC_MODES;
  }

  _defaultMode() {
    const modes = this._availableModes();
    return modes.find((mode) => mode.id === this._season().defaultMode)?.id || modes[0].id;
  }

  _temperatureBounds() {
    const attributes = this._hass?.states?.[this._zone().entity]?.attributes || {};
    const unit = this._hass?.config?.unit_system?.temperature || "°F";
    const celsius = unit.includes("C");
    return {
      min: Number.isFinite(Number(attributes.min_temp))
        ? Number(attributes.min_temp)
        : celsius ? 7 : 45,
      max: Number.isFinite(Number(attributes.max_temp))
        ? Number(attributes.max_temp)
        : celsius ? 35 : 95,
      step: Number.isFinite(Number(attributes.target_temp_step))
        ? Number(attributes.target_temp_step)
        : celsius ? 0.5 : 1,
    };
  }

  _range() {
    const temperatures = DAY_KEYS.flatMap((day) =>
      this._week()[day].map((block) => Number(block.temperature)),
    ).filter(Number.isFinite);
    if (temperatures.length === 0) {
      const unit = this._hass?.config?.unit_system?.temperature || "°F";
      return unit.includes("C") ? { min: 18, max: 27 } : { min: 65, max: 80 };
    }
    return { min: Math.min(...temperatures), max: Math.max(...temperatures) };
  }

  _blockColor(temperature, mode) {
    if (mode === "off") return "hsl(215 12% 42%)";
    const { min, max } = this._range();
    const position = max === min ? 0.5 : (temperature - min) / (max - min);
    const normalized = Math.max(0, Math.min(1, position));
    if (normalized === 0) return this._gradientStart;
    if (normalized === 1) return this._gradientEnd;
    return `color-mix(in oklab, ${this._gradientStart} ${Math.round((1 - normalized) * 100)}%, ${this._gradientEnd})`;
  }

  _render({ preserveEditor = false } = {}) {
    if (!this._config || !this.shadowRoot) return;
    // Home Assistant calls the hass setter whenever state changes. Rebuilding
    // the shadow DOM while the dialog is open would replace its form controls,
    // reset their values, and take focus away from the person editing.
    if (preserveEditor && this._editor) return;
    const zone = this._zone();
    const range = this._range();
    const unit = this._hass?.config?.unit_system?.temperature || "°F";
    const unitMark = unit.includes("C") ? "°C" : "°F";
    const todayIndex = (new Date().getDay() + 6) % 7;
    const activeSeason = this._seasons.find((season) => season.id === this._activeSeason);
    const statusText = this._loadError
      ? this._loadError
      : this._loading || !this._loaded
        ? "Connecting to Climate Schedule…"
        : this._saving
          ? "Saving to Home Assistant…"
          : `Saved in Home Assistant · Active: ${activeSeason?.icon || ""} ${activeSeason?.name || this._activeSeason}`;

    this.shadowRoot.innerHTML = `
      <style>${this._styles()}</style>
      <ha-card>
        <div class="card-header">
          <div>
            <div class="eyebrow">${escapeHtml(this._config.eyebrow || "Weekly baseline setpoints")}</div>
            <h2>${escapeHtml(this._config.title || "Zone temperature schedules")}</h2>
          </div>
          <button class="primary" data-action="add" data-day="${DAY_KEYS[todayIndex]}">
            <span aria-hidden="true">＋</span> Add period
          </button>
        </div>

        <div class="zone-tabs" role="tablist" aria-label="Climate zone">
          ${this._zones
            .map(
              (item, index) => `
                <button
                  role="tab"
                  aria-selected="${index === this._selectedZone}"
                  class="zone-tab ${index === this._selectedZone ? "selected" : ""}"
                  data-action="zone"
                  data-zone="${index}"
                >${escapeHtml(item.name || item.entity)}</button>
              `,
            )
            .join("")}
        </div>

        <div class="season-bar">
          <span class="season-label">Schedule season</span>
          <div class="season-tabs" role="tablist" aria-label="Schedule season">
            ${this._seasons.map((season) => `
              <button
                role="tab"
                aria-selected="${season.id === this._selectedSeason}"
                class="season-tab ${season.id === this._selectedSeason ? "selected" : ""} ${season.id === this._activeSeason ? "active" : ""}"
                data-action="season"
                data-season="${season.id}"
              >
                <span aria-hidden="true">${season.icon}</span>
                ${escapeHtml(season.name)}
                ${season.id === this._activeSeason ? '<span class="active-marker">Active</span>' : ""}
              </button>
            `).join("")}
          </div>
          <button
            class="activate-season"
            data-action="activate-season"
            ${this._selectedSeason === this._activeSeason ? "disabled" : ""}
          >${this._selectedSeason === this._activeSeason ? "Active schedule" : "Use this season"}</button>
        </div>

        <section class="schedule-shell" aria-label="${escapeHtml(zone.name)} weekly schedule">
          <div class="schedule-heading">
            <div>
              <div class="zone-name">${escapeHtml(zone.name || zone.entity)}</div>
              <div class="entity-id">${escapeHtml(zone.entity)}</div>
            </div>
            <div class="scale-wrap" aria-label="Dynamic temperature color scale">
              <div class="scale-labels">
                <span>${range.min}${unitMark}</span>
                <span>${range.max}${unitMark}</span>
              </div>
              <div class="scale" style="--gradient-start:${this._gradientStart};--gradient-end:${this._gradientEnd}"></div>
            </div>
          </div>

          <div class="time-axis" aria-label="Timeline with typical daylight highlighted from 6 AM to 6 PM">
            <div class="daylight-axis" aria-hidden="true"><span>☀️</span></div>
            ${[0, 3, 6, 9, 12, 15, 18, 21, 24]
              .map((hour) => `<span class="time-tick" aria-hidden="true" style="left:${(hour / 24) * 100}%">${hour === 24 ? "" : displayTime(`${String(hour).padStart(2, "0")}:00`)}</span>`)
              .join("")}
          </div>

          <div class="week-grid">
            ${DAY_KEYS.map((day, index) => this._renderDay(day, index === todayIndex, unitMark)).join("")}
          </div>
        </section>

        <div class="footer-note ${this._loadError ? "error-status" : ""}">
          <span class="dot"></span>
          ${escapeHtml(statusText)}
        </div>
      </ha-card>
      ${this._editor ? this._renderEditor(unitMark) : ""}
    `;
  }

  _renderDay(day, isToday, unitMark) {
    const blocks = this._week()[day];
    return `
      <div class="day-row ${isToday ? "today" : ""}">
        <button class="day-label" data-action="add" data-day="${day}" title="Add a ${DAY_LABELS[day]} period">
          ${DAY_LABELS[day]}${isToday ? '<span class="today-dot" title="Today"></span>' : ""}
        </button>
        <div
          class="track"
          role="button"
          tabindex="0"
          data-action="add-at"
          data-day="${day}"
          aria-label="Add a ${DAY_LABELS[day]} period by clicking an empty time"
          title="Click an empty time to add a period"
        >
          <div class="grid-lines" aria-hidden="true"></div>
          ${blocks
            .map((block, index) => {
              const left = (minutes(block.start) / 1440) * 100;
              const width = ((minutes(block.end) - minutes(block.start)) / 1440) * 100;
              const mode = this._mode(block.mode);
              return `
                <button
                  class="period"
                  data-action="edit"
                  data-day="${day}"
                  data-index="${index}"
                  style="left:${left}%;width:${width}%;background:${this._blockColor(block.temperature, block.mode)}"
                  title="${displayTime(block.start)}–${displayTime(block.end)}, ${block.temperature}${unitMark}, ${mode.label}"
                >
                  <span class="resize-handle start" data-action="resize" data-edge="start" title="Drag to change start time" aria-hidden="true"></span>
                  <span class="period-topline"><strong>${block.mode === "off" ? "Off" : `${block.temperature}°`}</strong><span class="mode-badge">${mode.icon} ${mode.label}</span></span>
                  <small class="period-time">${displayTime(block.start)}–${displayTime(block.end)}</small>
                  <span class="resize-handle end" data-action="resize" data-edge="end" title="Drag to change end time" aria-hidden="true"></span>
                </button>
              `;
            })
            .join("")}
          <div class="daylight-band" aria-hidden="true"></div>
        </div>
      </div>
    `;
  }

  _renderEditor(unitMark) {
    const editor = this._editor;
    const bounds = this._temperatureBounds();
    const checkedDays = new Set(editor.days || [editor.day]);
    return `
      <div class="scrim" data-action="cancel">
        <section class="editor" role="dialog" aria-modal="true" aria-label="${editor.index == null ? "Add" : "Edit"} schedule period" data-editor-panel>
          <div class="editor-header">
            <div>
              <div class="eyebrow">${escapeHtml(this._zone().name)} · ${escapeHtml(this._season().name)}</div>
              <h3>${editor.index == null ? "Add period" : "Edit period"}</h3>
            </div>
            <button class="icon-button" data-action="cancel" aria-label="Close">×</button>
          </div>

          <div class="form-grid">
            <label>Start
              <input name="start" type="time" value="${editor.start}" step="900">
            </label>
            <label>End
              <input name="end" type="time" value="${editor.end === "24:00" ? "23:59" : editor.end}" step="900">
            </label>
            <label class="temperature-field">Temperature
              <div class="temperature-input">
                <input name="temperature" type="number" min="${bounds.min}" max="${bounds.max}" step="${bounds.step}" value="${editor.temperature}">
                <span>${unitMark}</span>
              </div>
            </label>
            <label class="mode-field">HVAC mode
              <select name="mode">
                ${this._availableModes().map((mode) => `
                  <option value="${mode.id}" ${mode.id === editor.mode ? "selected" : ""}>
                    ${mode.icon} ${mode.label}
                  </option>
                `).join("")}
              </select>
            </label>
          </div>

          <fieldset>
            <legend>${editor.index == null ? "Apply to days" : "Also copy to"}</legend>
            <div class="day-pills">
              ${DAY_KEYS.map(
                (day) => `
                  <label>
                    <input type="checkbox" name="days" value="${day}" ${checkedDays.has(day) ? "checked" : ""}>
                    <span>${DAY_LABELS[day]}</span>
                  </label>
                `,
              ).join("")}
            </div>
          </fieldset>

          ${this._editorError ? `<div class="error">${escapeHtml(this._editorError)}</div>` : ""}

          <div class="editor-actions">
            ${editor.index == null ? "" : '<button class="danger" data-action="delete">Delete</button>'}
            <span></span>
            <button class="secondary" data-action="cancel">Cancel</button>
            <button class="primary" data-action="save">Save period</button>
          </div>
        </section>
      </div>
    `;
  }

  _openEditorRange(day, startMinutes, endMinutes) {
    const boundedStart = Math.max(0, Math.min(1320, startMinutes));
    const boundedEnd = Math.max(boundedStart + 15, Math.min(1440, endMinutes));
    this._editorError = "";
    this._editor = {
      day,
      days: [day],
      index: null,
      start: clockTime(boundedStart),
      end: clockTime(boundedEnd),
      temperature: Math.round((this._range().min + this._range().max) / 2),
      mode: this._defaultMode(),
    };
    this._render();
  }

  _openEditorAt(day, startMinutes) {
    this._openEditorRange(day, startMinutes, startMinutes + 120);
  }

  _emptyGaps(day) {
    const gaps = [];
    let cursor = 0;
    for (const block of this._week()[day]) {
      const start = minutes(block.start);
      const end = minutes(block.end);
      if (start > cursor) gaps.push({ start: cursor, end: start });
      cursor = Math.max(cursor, end);
    }
    if (cursor < 1440) gaps.push({ start: cursor, end: 1440 });
    return gaps;
  }

  _openEditorForGap(day, pointerMinutes) {
    const gap = this._emptyGaps(day).find(
      ({ start, end }) => pointerMinutes >= start && pointerMinutes < end,
    );
    if (!gap) return;
    this._openEditorRange(day, gap.start, gap.end);
  }

  _startResize(event) {
    const handle = event.target.closest(".resize-handle");
    if (!handle) return;
    const period = handle.closest(".period");
    const track = handle.closest(".track");
    const day = period.dataset.day;
    const index = Number(period.dataset.index);
    const blocks = this._week()[day];
    const block = blocks[index];
    event.preventDefault();
    event.stopPropagation();
    handle.setPointerCapture?.(event.pointerId);
    period.classList.add("resizing");
    this._drag = {
      pointerId: event.pointerId,
      edge: handle.dataset.edge,
      handle,
      period,
      track,
      day,
      index,
      start: minutes(block.start),
      end: minutes(block.end),
      minStart: index === 0 ? 0 : minutes(blocks[index - 1].end),
      maxEnd: index === blocks.length - 1 ? 1440 : minutes(blocks[index + 1].start),
    };
  }

  _moveResize(event) {
    const drag = this._drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const bounds = drag.track.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const pointerMinutes = Math.round(
      (Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * 1440) / 15,
    ) * 15;
    if (drag.edge === "start") {
      drag.start = Math.max(drag.minStart, Math.min(pointerMinutes, drag.end - 15));
    } else {
      drag.end = Math.min(drag.maxEnd, Math.max(pointerMinutes, drag.start + 15));
    }
    drag.period.style.left = `${(drag.start / 1440) * 100}%`;
    drag.period.style.width = `${((drag.end - drag.start) / 1440) * 100}%`;
    const timeLabel = `${displayTime(clockTime(drag.start))}–${displayTime(clockTime(drag.end))}`;
    drag.period.querySelector("small").textContent = timeLabel;
    drag.period.title = `${timeLabel}, ${this._week()[drag.day][drag.index].temperature}°`;
  }

  _finishResize(event, cancelled = false) {
    const drag = this._drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (drag.handle.hasPointerCapture?.(event.pointerId)) {
      drag.handle.releasePointerCapture(event.pointerId);
    }
    if (!cancelled) {
      const block = this._week()[drag.day][drag.index];
      block.start = clockTime(drag.start);
      block.end = clockTime(drag.end);
    }
    this._drag = null;
    this._render();
    if (!cancelled) this._persist();
  }

  _handleKeydown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    const track = event.target.closest('[data-action="add-at"]');
    if (!track || event.target.closest(".period")) return;
    const gap = this._emptyGaps(track.dataset.day)[0];
    if (!gap) return;
    event.preventDefault();
    this._openEditorRange(track.dataset.day, gap.start, gap.end);
  }

  _handleClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;

    if (action === "resize") return;

    if (action === "zone") {
      this._selectedZone = Number(button.dataset.zone);
      this._editor = null;
      this._render();
      return;
    }
    if (action === "season") {
      this._selectedSeason = button.dataset.season;
      this._editor = null;
      this._render();
      return;
    }
    if (action === "activate-season") {
      this._activateSeason();
      return;
    }
    if (action === "add") {
      this._openEditorAt(button.dataset.day, 480);
      return;
    }
    if (action === "add-at") {
      const bounds = button.getBoundingClientRect();
      const position = bounds.width > 0
        ? Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width))
        : 1 / 3;
      this._openEditorForGap(button.dataset.day, position * 1440);
      return;
    }
    if (action === "edit") {
      const day = button.dataset.day;
      const index = Number(button.dataset.index);
      const block = this._week()[day][index];
      this._editorError = "";
      this._editor = { day, days: [day], index, ...block };
      this._render();
      return;
    }
    if (action === "cancel") {
      if (event.target.closest("[data-editor-panel]") && !button.classList.contains("icon-button") && !button.classList.contains("secondary")) return;
      this._editor = null;
      this._editorError = "";
      this._render();
      return;
    }
    if (action === "delete") {
      const { day, index } = this._editor;
      this._week()[day].splice(index, 1);
      this._editor = null;
      this._render();
      this._persist();
      return;
    }
    if (action === "save") this._saveEditor();
  }

  _saveEditor() {
    const panel = this.shadowRoot.querySelector("[data-editor-panel]");
    const selectedDays = [...panel.querySelectorAll('input[name="days"]:checked')].map((item) => item.value);
    const start = panel.querySelector('[name="start"]').value;
    let end = panel.querySelector('[name="end"]').value;
    const temperature = Number(panel.querySelector('[name="temperature"]').value);
    const mode = panel.querySelector('[name="mode"]').value;
    if (end === "23:59") end = "24:00";

    this._editor = { ...this._editor, start, end, temperature, mode, days: selectedDays };
    if (!start || !end || minutes(end) <= minutes(start)) {
      this._editorError = "End time must be later than start time.";
      this._render();
      return;
    }
    if (!Number.isFinite(temperature)) {
      this._editorError = "Enter a valid target temperature.";
      this._render();
      return;
    }
    if (selectedDays.length === 0) {
      this._editorError = "Select at least one day.";
      this._render();
      return;
    }

    for (const day of selectedDays) {
      const overlap = this._week()[day].some((block, index) => {
        if (day === this._editor.day && index === this._editor.index) return false;
        return minutes(start) < minutes(block.end) && minutes(end) > minutes(block.start);
      });
      if (overlap) {
        this._editorError = `That period overlaps an existing ${DAY_LABELS[day]} block.`;
        this._render();
        return;
      }
    }

    const saved = { start, end, temperature, mode };
    if (this._editor.index != null) {
      this._week()[this._editor.day][this._editor.index] = saved;
    }
    for (const day of selectedDays) {
      if (day === this._editor.day && this._editor.index != null) continue;
      this._week()[day].push({ ...saved });
    }
    for (const day of DAY_KEYS) {
      this._week()[day].sort((a, b) => minutes(a.start) - minutes(b.start));
    }
    this._editor = null;
    this._editorError = "";
    this._render();
    this._persist();
  }

  _styles() {
    return `
      :host { display:block; color:var(--primary-text-color); container-type:inline-size; }
      * { box-sizing:border-box; }
      button, input, select { font:inherit; }
      ha-card { overflow:hidden; background:var(--ha-card-background, var(--card-background-color)); }
      .card-header { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:22px 24px 16px; }
      h2, h3 { margin:2px 0 0; font-weight:650; letter-spacing:-.02em; }
      h2 { font-size:22px; } h3 { font-size:20px; }
      .eyebrow { color:var(--secondary-text-color); text-transform:uppercase; letter-spacing:.08em; font-size:11px; font-weight:700; }
      button { border:0; cursor:pointer; }
      .primary { color:white; background:var(--primary-color, #03a9f4); border-radius:10px; padding:10px 14px; font-weight:650; box-shadow:0 2px 8px rgb(0 0 0 / 18%); }
      .secondary { color:var(--primary-text-color); background:var(--secondary-background-color); border-radius:10px; padding:10px 14px; font-weight:600; }
      .danger { color:var(--error-color, #db4437); background:transparent; padding:10px 4px; font-weight:650; }
      .zone-tabs { display:flex; gap:6px; padding:0 24px 18px; overflow:auto; }
      .zone-tab { flex:0 0 auto; padding:8px 14px; border-radius:999px; background:var(--secondary-background-color); color:var(--secondary-text-color); }
      .zone-tab.selected { background:color-mix(in srgb, var(--primary-color, #03a9f4) 18%, transparent); color:var(--primary-color, #03a9f4); font-weight:700; box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--primary-color, #03a9f4) 30%, transparent); }
      .season-bar { display:flex; align-items:center; gap:12px; padding:0 24px 18px; }
      .season-label { flex:0 0 auto; color:var(--secondary-text-color); font-size:10px; font-weight:750; text-transform:uppercase; letter-spacing:.07em; }
      .season-tabs { display:flex; flex:1 1 auto; gap:6px; min-width:0; overflow:auto; }
      .season-tab { flex:0 0 auto; display:flex; align-items:center; gap:6px; padding:8px 12px; border-radius:9px; color:var(--secondary-text-color); background:transparent; box-shadow:inset 0 0 0 1px var(--divider-color); }
      .season-tab.selected { color:var(--primary-text-color); background:color-mix(in srgb, var(--primary-color, #03a9f4) 10%, var(--card-background-color)); box-shadow:inset 0 0 0 2px color-mix(in srgb, var(--primary-color, #03a9f4) 45%, transparent); font-weight:700; }
      .season-tab > span:first-child { font-size:14px; }
      .active-marker { padding:2px 5px; border-radius:999px; color:var(--success-color, #2e7d32); background:color-mix(in srgb, var(--success-color, #2e7d32) 14%, transparent); font-size:8px; font-weight:800; text-transform:uppercase; letter-spacing:.04em; }
      .activate-season { flex:0 0 auto; margin-left:auto; padding:8px 11px; border-radius:9px; color:white; background:var(--primary-color, #03a9f4); font-size:11px; font-weight:700; }
      .activate-season:disabled { cursor:default; color:var(--secondary-text-color); background:var(--secondary-background-color); opacity:.8; }
      .schedule-shell { margin:0 16px 14px; padding:18px; border:1px solid var(--divider-color); border-radius:14px; background:color-mix(in srgb, var(--secondary-background-color) 48%, transparent); }
      .schedule-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; margin-bottom:18px; }
      .zone-name { font-size:18px; font-weight:700; }
      .entity-id { color:var(--secondary-text-color); font-family:ui-monospace, SFMono-Regular, Consolas, monospace; font-size:12px; margin-top:3px; }
      .scale-wrap { width:230px; max-width:48%; }
      .scale-labels { display:flex; align-items:center; justify-content:space-between; font-size:12px; font-weight:700; margin-bottom:4px; }
      .scale { height:8px; border-radius:999px; background:linear-gradient(90deg, var(--gradient-start) 0%, var(--gradient-end) 100%); box-shadow:inset 0 0 0 1px rgb(255 255 255 / 18%); }
      .time-axis { position:relative; height:34px; margin-left:48px; border-bottom:1px solid var(--divider-color); }
      .time-tick { position:absolute; transform:translateX(-50%); font-size:10px; color:var(--secondary-text-color); bottom:4px; }
      .daylight-axis { position:absolute; top:0; bottom:0; left:25%; width:50%; border-inline:1px dashed color-mix(in srgb, #fbbf24 58%, transparent); background:linear-gradient(90deg, color-mix(in srgb, #fbbf24 5%, transparent), color-mix(in srgb, #fbbf24 14%, transparent), color-mix(in srgb, #fbbf24 5%, transparent)); pointer-events:none; }
      .daylight-axis span { position:absolute; top:0; left:50%; transform:translateX(-50%); font-size:13px; line-height:1; }
      .week-grid { display:grid; gap:7px; padding-top:8px; }
      .day-row { display:grid; grid-template-columns:40px minmax(0, 1fr); gap:8px; min-height:48px; align-items:center; }
      .day-label { position:relative; color:var(--secondary-text-color); background:transparent; padding:8px 0; text-align:left; font-weight:650; border-radius:8px; }
      .day-label:hover { color:var(--primary-color); }
      .today-dot { display:inline-block; width:5px; height:5px; margin-left:4px; vertical-align:middle; border-radius:50%; background:var(--primary-color); }
      .track { position:relative; height:44px; border-radius:9px; background:var(--card-background-color); overflow:hidden; cursor:crosshair; box-shadow:inset 0 0 0 1px var(--divider-color); }
      .track:focus-visible { outline:2px solid var(--primary-color); outline-offset:2px; }
      .grid-lines { position:absolute; inset:0; background:repeating-linear-gradient(90deg, transparent 0, transparent calc(12.5% - 1px), var(--divider-color) calc(12.5% - 1px), var(--divider-color) 12.5%); opacity:.65; }
      .daylight-band { position:absolute; z-index:2; inset-block:0; left:25%; width:50%; border-inline:1px dashed rgb(255 226 128 / 70%); background:linear-gradient(90deg, rgb(255 214 64 / 3%), rgb(255 214 64 / 10%), rgb(255 214 64 / 3%)); pointer-events:none; }
      .period { position:absolute; z-index:1; top:4px; bottom:4px; min-width:2px; color:white; border-radius:7px; padding:3px 7px; text-align:left; overflow:hidden; cursor:pointer; box-shadow:0 2px 6px rgb(0 0 0 / 22%), inset 0 0 0 1px rgb(255 255 255 / 16%); transition:transform 120ms ease, filter 120ms ease; }
      .period:hover, .period:focus-visible { transform:translateY(-1px); filter:brightness(1.08); z-index:3; outline:2px solid var(--primary-text-color); outline-offset:1px; }
      .period.resizing { z-index:4; transform:none; filter:brightness(1.08); user-select:none; }
      .resize-handle { position:absolute; z-index:5; top:0; bottom:0; width:12px; cursor:ew-resize; touch-action:none; opacity:0; transition:opacity 100ms ease; }
      .resize-handle.start { left:0; }
      .resize-handle.end { right:0; }
      .resize-handle::after { content:""; position:absolute; top:9px; bottom:9px; width:2px; border-radius:2px; background:rgb(255 255 255 / 86%); box-shadow:0 0 0 1px rgb(0 0 0 / 20%); }
      .resize-handle.start::after { left:3px; }
      .resize-handle.end::after { right:3px; }
      .period:hover .resize-handle, .period:focus-visible .resize-handle, .period.resizing .resize-handle { opacity:1; }
      .period strong { display:block; font-size:14px; line-height:15px; text-shadow:0 1px 2px rgb(0 0 0 / 45%); }
      .period-topline { display:flex; align-items:center; justify-content:space-between; gap:5px; min-width:0; }
      .mode-badge { flex:0 1 auto; padding:1px 4px; border-radius:4px; background:rgb(0 0 0 / 18%); font-size:8px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .period small { display:block; white-space:nowrap; font-size:9px; opacity:.9; text-shadow:0 1px 2px rgb(0 0 0 / 55%); }
      .footer-note { display:flex; align-items:center; gap:8px; color:var(--secondary-text-color); font-size:11px; padding:0 24px 18px; }
      .footer-note.error-status { color:var(--error-color, #db4437); }
      .dot { width:7px; height:7px; border-radius:50%; background:var(--success-color, #2e7d32); }
      .footer-note.error-status .dot { background:var(--error-color, #db4437); }
      .scrim { position:fixed; inset:0; z-index:9999; display:grid; place-items:center; padding:20px; background:rgb(0 0 0 / 52%); backdrop-filter:blur(3px); }
      .editor { width:min(560px, 100%); padding:22px; border-radius:16px; background:var(--card-background-color); box-shadow:0 24px 70px rgb(0 0 0 / 42%); color:var(--primary-text-color); }
      .editor-header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:20px; }
      .icon-button { width:36px; height:36px; border-radius:50%; background:var(--secondary-background-color); color:var(--secondary-text-color); font-size:24px; line-height:1; }
      .form-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
      label, legend { color:var(--secondary-text-color); font-size:12px; font-weight:650; }
      input[type="time"], input[type="number"], select { width:100%; margin-top:6px; padding:10px; border:1px solid var(--divider-color); border-radius:9px; color:var(--primary-text-color); background:var(--secondary-background-color); outline:none; }
      input:focus, select:focus { border-color:var(--primary-color); box-shadow:0 0 0 2px color-mix(in srgb, var(--primary-color) 25%, transparent); }
      .temperature-input { position:relative; }
      .temperature-input input { padding-right:40px; }
      .temperature-input span { position:absolute; right:10px; bottom:11px; color:var(--secondary-text-color); }
      fieldset { border:0; padding:18px 0 0; margin:0; }
      legend { padding:0 0 8px; }
      .day-pills { display:flex; gap:6px; flex-wrap:wrap; }
      .day-pills input { position:absolute; opacity:0; pointer-events:none; }
      .day-pills span { display:grid; place-items:center; width:43px; height:34px; border-radius:999px; background:var(--secondary-background-color); cursor:pointer; }
      .day-pills input:checked + span { color:white; background:var(--primary-color); }
      .error { margin-top:14px; padding:10px 12px; border-radius:8px; background:color-mix(in srgb, var(--error-color, #db4437) 12%, transparent); color:var(--error-color, #db4437); font-size:12px; }
      .editor-actions { display:grid; grid-template-columns:auto 1fr auto auto; gap:10px; align-items:center; margin-top:22px; }
      @container (max-width:720px) {
        .season-bar { align-items:stretch; flex-direction:column; gap:8px; }
        .season-tabs { width:100%; max-width:100%; }
        .activate-season { align-self:flex-start; margin-left:0; }
      }
      @media (max-width:700px) {
        .card-header { align-items:flex-start; padding:18px 16px 14px; }
        .card-header .primary { padding:9px 10px; }
        .zone-tabs { padding:0 16px 14px; }
        .season-bar { padding:0 16px 14px; }
        .schedule-shell { margin:0 8px 12px; padding:13px 9px; }
        .schedule-heading { display:block; }
        .scale-wrap { width:100%; max-width:none; margin-top:14px; }
        .time-axis { margin-left:40px; }
        .day-row { grid-template-columns:32px minmax(0, 1fr); gap:8px; }
        .period { padding:4px; text-align:center; }
        .period small { display:none; }
        .form-grid { grid-template-columns:1fr 1fr; }
        .temperature-field, .mode-field { grid-column:auto; }
        .editor-actions { grid-template-columns:auto 1fr auto; }
        .editor-actions .secondary { display:none; }
      }
    `;
  }
}

if (!customElements.get("climate-schedule-card")) {
  customElements.define("climate-schedule-card", ClimateScheduleCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "climate-schedule-card",
    name: "Climate Schedule",
    description: "Standalone seasonal weekly schedule card for Home Assistant climate entities.",
    preview: true,
  });
}
