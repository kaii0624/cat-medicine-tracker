(() => {
  "use strict";

  const STORAGE_KEY = "cat-medicine-tracker.records.v1";
  const PERIODS = {
    morning: { label: "朝", symbol: "☀" },
    evening: { label: "夜", symbol: "☾" },
  };

  const state = {
    records: loadRecords(),
    selectedPeriod: new Date().getHours() < 15 ? "morning" : "evening",
    selectedHour: new Date().getHours(),
    selectedMinute: new Date().getMinutes(),
    selectedDateKey: dateKey(new Date()),
  };

  const elements = {
    calendar: document.querySelector("#calendar"),
    elapsed: document.querySelector("#status-title"),
    lastRecord: document.querySelector("#last-record"),
    shareButton: document.querySelector("#share-button"),
    periodButtons: [...document.querySelectorAll(".period-button")],
    hourWheel: document.querySelector("#hour-wheel"),
    minuteWheel: document.querySelector("#minute-wheel"),
    recordButton: document.querySelector("#record-button"),
    recordButtonLabel: document.querySelector("#record-button-label"),
    deleteButton: document.querySelector("#delete-button"),
    toast: document.querySelector("#toast"),
  };

  let toastTimer;

  init();

  function init() {
    buildWheel(elements.hourWheel, 24, state.selectedHour, (value) => {
      state.selectedHour = value;
    });
    buildWheel(elements.minuteWheel, 60, state.selectedMinute, (value) => {
      state.selectedMinute = value;
    });

    elements.periodButtons.forEach((button) => {
      button.addEventListener("click", () => selectPeriod(button.dataset.period));
    });
    elements.recordButton.addEventListener("click", recordDose);
    elements.deleteButton.addEventListener("click", deleteSelectedRecord);
    elements.shareButton.addEventListener("click", shareLatestRecord);

    selectPeriod(state.selectedPeriod, { keepTime: true });
    render();
    window.setInterval(renderStatus, 60_000);
  }

  function buildWheel(container, count, initialValue, onChange) {
    const options = [];
    for (let value = 0; value < count; value += 1) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "wheel-option";
      option.id = `${container.id}-option-${value}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      option.dataset.value = String(value);
      option.textContent = String(value).padStart(2, "0");
      option.addEventListener("click", () => {
        container.scrollTo({ top: value * 50, behavior: "smooth" });
      });
      container.append(option);
      options.push(option);
    }

    let settleTimer;
    const update = () => {
      const value = Math.max(0, Math.min(count - 1, Math.round(container.scrollTop / 50)));
      options.forEach((option, index) => {
        const isSelected = index === value;
        option.classList.toggle("is-selected", isSelected);
        option.setAttribute("aria-selected", String(isSelected));
      });
      container.setAttribute("aria-activedescendant", options[value].id);
      onChange(value);
    };

    container.addEventListener("scroll", () => {
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(update, 70);
    }, { passive: true });

    container.addEventListener("keydown", (event) => {
      const current = Math.round(container.scrollTop / 50);
      let next = current;
      if (event.key === "ArrowDown") next += 1;
      if (event.key === "ArrowUp") next -= 1;
      if (event.key === "PageDown") next += 5;
      if (event.key === "PageUp") next -= 5;
      if (next !== current) {
        event.preventDefault();
        container.scrollTo({ top: Math.max(0, Math.min(count - 1, next)) * 50, behavior: "smooth" });
      }
    });

    requestAnimationFrame(() => {
      container.scrollTop = initialValue * 50;
      update();
    });

    container.setValue = (value) => {
      container.scrollTop = value * 50;
      update();
    };
  }

  function render() {
    renderCalendar();
    renderStatus();
    renderEditorState();
  }

  function renderCalendar() {
    elements.calendar.replaceChildren();
    const today = startOfDay(new Date());

    for (let offset = -3; offset <= 0; offset += 1) {
      const date = addDays(today, offset);
      const key = dateKey(date);
      const day = document.createElement("article");
      day.className = `day-card${offset === 0 ? " is-today" : ""}`;

      const relative = offset === 0 ? "今日" : `${Math.abs(offset)}日前`;
      day.innerHTML = `
        <div class="day-label">
          <span class="relative-date">${relative}</span>
          <span class="absolute-date">${formatMonthDay(date)}（${weekday(date)}）</span>
        </div>
        <div class="dose-square"></div>
      `;

      const square = day.querySelector(".dose-square");
      square.append(
        createDoseSlot(key, "morning"),
        createDoseSlot(key, "evening"),
      );
      elements.calendar.append(day);
    }
  }

  function createDoseSlot(key, period) {
    const record = findRecord(key, period);
    const button = document.createElement("button");
    const periodInfo = PERIODS[period];
    button.type = "button";
    button.className = `dose-slot dose-slot--${period}${record ? " is-done" : ""}`;
    button.setAttribute(
      "aria-label",
      `${key} ${periodInfo.label}${record ? ` ${formatTime(new Date(record.timestamp))}に記録済み。編集する` : " 未記録"}`,
    );
    button.innerHTML = `
      <span class="slot-symbol" aria-hidden="true">${periodInfo.symbol}</span>
      <span class="mini-pill" aria-hidden="true"></span>
      ${record ? `<span class="dose-time">${formatTime(new Date(record.timestamp))}</span>` : ""}
    `;

    button.addEventListener("click", () => {
      const todayKey = dateKey(new Date());
      if (key !== todayKey) {
        showToast(record ? `${formatDateLong(new Date(record.timestamp))}の記録です` : "過去の日付には記録できません");
        return;
      }
      state.selectedDateKey = key;
      selectPeriod(period, { keepTime: Boolean(record) });
      if (record) {
        const date = new Date(record.timestamp);
        state.selectedHour = date.getHours();
        state.selectedMinute = date.getMinutes();
        elements.hourWheel.setValue(state.selectedHour);
        elements.minuteWheel.setValue(state.selectedMinute);
      }
      elements.recordButton.scrollIntoView({ behavior: "smooth", block: "center" });
      renderEditorState();
    });

    return button;
  }

  function renderStatus() {
    const latest = getLatestRecord();
    if (!latest) {
      elements.elapsed.textContent = "まだ記録がありません";
      elements.lastRecord.textContent = "最初のお薬を記録しよう";
      elements.shareButton.disabled = true;
      return;
    }

    const latestDate = new Date(latest.timestamp);
    elements.elapsed.textContent = elapsedLabel(latestDate, new Date());
    elements.lastRecord.textContent = `前回 ${formatDateTimeForStatus(latestDate)}・${PERIODS[latest.period].label}`;
    elements.shareButton.disabled = false;
  }

  function renderEditorState() {
    const record = findRecord(state.selectedDateKey, state.selectedPeriod);
    elements.recordButtonLabel.textContent = record ? "記録を更新" : "記録する";
    elements.deleteButton.hidden = !record;
  }

  function selectPeriod(period, options = {}) {
    state.selectedPeriod = period;
    elements.periodButtons.forEach((button) => {
      const active = button.dataset.period === period;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });

    if (!options.keepTime) {
      const now = new Date();
      state.selectedHour = now.getHours();
      state.selectedMinute = now.getMinutes();
      elements.hourWheel?.setValue(state.selectedHour);
      elements.minuteWheel?.setValue(state.selectedMinute);
    }
    renderEditorState();
  }

  function recordDose() {
    const timestamp = timestampFromSelection();
    const now = new Date();
    if (timestamp.getTime() > now.getTime() + 5 * 60_000) {
      showToast("未来の時間は記録できません");
      return;
    }

    const existingIndex = state.records.findIndex(
      (record) => record.dateKey === state.selectedDateKey && record.period === state.selectedPeriod,
    );
    const record = {
      id: existingIndex >= 0 ? state.records[existingIndex].id : cryptoSafeId(),
      dateKey: state.selectedDateKey,
      period: state.selectedPeriod,
      timestamp: timestamp.toISOString(),
    };

    if (existingIndex >= 0) state.records[existingIndex] = record;
    else state.records.push(record);

    state.records.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    saveRecords();
    render();
    showToast(`${PERIODS[state.selectedPeriod].label} ${formatTime(timestamp)} に記録しました`);
  }

  function deleteSelectedRecord() {
    const record = findRecord(state.selectedDateKey, state.selectedPeriod);
    if (!record) return;
    state.records = state.records.filter((item) => item.id !== record.id);
    saveRecords();
    render();
    showToast(`${PERIODS[state.selectedPeriod].label}の記録を削除しました`);
  }

  async function shareLatestRecord() {
    const latest = getLatestRecord();
    if (!latest) return;

    const latestDate = new Date(latest.timestamp);
    const text = [
      "🐾 ムクカプセル記録",
      `${formatDateLong(latestDate)} ${formatTime(latestDate)}（${PERIODS[latest.period].label}）にあげました。`,
      `前回から：${elapsedLabel(latestDate, new Date())}`,
    ].join("\n");

    try {
      if (navigator.share) {
        await navigator.share({ title: "ムクカプセル", text });
        showToast("共有画面を開きました");
        return;
      }
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        showToast("共有用メッセージをコピーしました");
        return;
      }
      window.prompt("このメッセージをコピーして家族に送ってください", text);
    } catch (error) {
      if (error?.name !== "AbortError") showToast("共有を開けませんでした");
    }
  }

  function timestampFromSelection() {
    const date = parseDateKey(state.selectedDateKey);
    date.setHours(state.selectedHour, state.selectedMinute, 0, 0);
    return date;
  }

  function findRecord(key, period) {
    return state.records.find((record) => record.dateKey === key && record.period === period);
  }

  function getLatestRecord() {
    return [...state.records]
      .filter((record) => Number.isFinite(new Date(record.timestamp).getTime()))
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
  }

  function loadRecords() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((record) =>
        record &&
        typeof record.id === "string" &&
        typeof record.dateKey === "string" &&
        PERIODS[record.period] &&
        Number.isFinite(new Date(record.timestamp).getTime()),
      );
    } catch {
      return [];
    }
  }

  function saveRecords() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.records));
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => elements.toast.classList.remove("is-visible"), 2600);
  }

  function elapsedLabel(from, to) {
    const milliseconds = Math.max(0, to.getTime() - from.getTime());
    const minutes = Math.floor(milliseconds / 60_000);
    if (minutes < 1) return "たった今";
    if (minutes < 60) return `${minutes}分前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}時間前`;
    const days = Math.floor(hours / 24);
    return `${days}日前`;
  }

  function formatTime(date) {
    return new Intl.DateTimeFormat("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }

  function formatMonthDay(date) {
    return new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric" }).format(date);
  }

  function formatDateLong(date) {
    return new Intl.DateTimeFormat("ja-JP", {
      month: "numeric",
      day: "numeric",
      weekday: "short",
    }).format(date);
  }

  function formatDateTimeForStatus(date) {
    const isToday = dateKey(date) === dateKey(new Date());
    return `${isToday ? "今日" : formatMonthDay(date)} ${formatTime(date)}`;
  }

  function weekday(date) {
    return new Intl.DateTimeFormat("ja-JP", { weekday: "short" }).format(date).replace("曜日", "");
  }

  function startOfDay(date) {
    const result = new Date(date);
    result.setHours(0, 0, 0, 0);
    return result;
  }

  function addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
  }

  function dateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function parseDateKey(key) {
    const [year, month, day] = key.split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  function cryptoSafeId() {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
})();
