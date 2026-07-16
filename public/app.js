(() => {
  "use strict";

  const STORAGE_KEY = "cat-medicine-tracker.records.v1";
  const ADMIN_TOKEN_KEY = "muku-capsule.admin-token.v1";
  const VIEW_TOKEN_KEY = "muku-capsule.view-token.v1";
  const REMOTE_REFRESH_MS = 10_000;
  const REMOTE_HOST = location.hostname.endsWith(".workers.dev") || location.hostname.endsWith(".pages.dev");
  const PERIODS = {
    morning: { label: "朝", symbol: "☀" },
    evening: { label: "夜", symbol: "☾" },
  };

  const linkTokens = captureLinkTokens();
  const state = {
    records: loadRecords(),
    selectedPeriod: new Date().getHours() < 15 ? "morning" : "evening",
    selectedHour: new Date().getHours(),
    selectedMinute: new Date().getMinutes(),
    selectedDateKey: dateKey(new Date()),
    adminToken: linkTokens.adminToken || loadToken(ADMIN_TOKEN_KEY),
    viewToken: linkTokens.viewToken || loadToken(VIEW_TOKEN_KEY),
    remoteAvailable: REMOTE_HOST,
    accessMissing: false,
    syncInFlight: false,
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
    recordCard: document.querySelector(".record-card"),
    toast: document.querySelector("#toast"),
  };

  let toastTimer;

  init().catch(() => showToast("読み込みに失敗しました。再読み込みしてください"));

  async function init() {
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
    renderAccessMode();
    render();
    await refreshRemoteRecords({ silent: true });
    window.setInterval(renderStatus, 60_000);
    window.setInterval(() => {
      if (document.visibilityState === "visible") refreshRemoteRecords({ silent: true });
    }, REMOTE_REFRESH_MS);
    window.addEventListener("focus", () => refreshRemoteRecords({ silent: true }));
  }

  async function refreshRemoteRecords(options = {}) {
    if (state.syncInFlight) return;
    state.syncInFlight = true;
    try {
      const response = await apiRequest("/api/records", { method: "GET" });
      if (response.status === 404 && !REMOTE_HOST) return;

      state.remoteAvailable = true;
      if (response.status === 401) {
        if (state.adminToken && state.viewToken) {
          state.adminToken = "";
          localStorage.removeItem(ADMIN_TOKEN_KEY);
          renderAccessMode();
          state.syncInFlight = false;
          return refreshRemoteRecords(options);
        }
        state.accessMissing = true;
        state.records = [];
        renderAccessMode();
        render();
        return;
      }
      if (!response.ok) throw new Error(`Sync failed: ${response.status}`);

      const data = await response.json();
      state.records = normalizeRecords(data.records);
      state.accessMissing = false;
      renderAccessMode();
      render();
    } catch {
      if ((REMOTE_HOST || state.remoteAvailable) && !options.silent) {
        showToast("共有データを読み込めませんでした");
      }
    } finally {
      state.syncInFlight = false;
    }
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
      if (usesRemoteStorage() && !state.adminToken) {
        showToast(record ? `${formatDateLong(new Date(record.timestamp))} ${formatTime(new Date(record.timestamp))}の記録です` : "まだ記録されていません");
        return;
      }
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
    if (state.accessMissing) {
      elements.elapsed.textContent = "共有リンクから開いてね";
      elements.lastRecord.textContent = "家族用リンクをもう一度開いてください";
      elements.shareButton.disabled = true;
      return;
    }

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

  function renderAccessMode() {
    const viewerMode = usesRemoteStorage() && !state.adminToken;
    elements.recordCard.hidden = viewerMode;
    document.body.classList.toggle("viewer-mode", viewerMode);
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

  async function recordDose() {
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

    if (usesRemoteStorage()) {
      elements.recordButton.disabled = true;
      try {
        const response = await apiRequest("/api/records", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(record),
        });
        if (!response.ok) {
          handleWriteFailure(response.status);
          return;
        }
        const data = await response.json();
        upsertStateRecord(data.record);
        render();
        showToast(`${PERIODS[state.selectedPeriod].label} ${formatTime(timestamp)} に記録しました`);
      } catch {
        showToast("記録できませんでした。通信を確認してください");
      } finally {
        elements.recordButton.disabled = false;
      }
      return;
    }

    upsertStateRecord(record);
    saveRecords();
    render();
    showToast(`${PERIODS[state.selectedPeriod].label} ${formatTime(timestamp)} に記録しました`);
  }

  async function deleteSelectedRecord() {
    const record = findRecord(state.selectedDateKey, state.selectedPeriod);
    if (!record) return;

    if (usesRemoteStorage()) {
      elements.deleteButton.disabled = true;
      try {
        const path = `/api/records/${encodeURIComponent(record.dateKey)}/${encodeURIComponent(record.period)}`;
        const response = await apiRequest(path, { method: "DELETE" });
        if (!response.ok) {
          handleWriteFailure(response.status);
          return;
        }
        state.records = state.records.filter((item) => item.id !== record.id);
        render();
        showToast(`${PERIODS[state.selectedPeriod].label}の記録を削除しました`);
      } catch {
        showToast("削除できませんでした。通信を確認してください");
      } finally {
        elements.deleteButton.disabled = false;
      }
      return;
    }

    state.records = state.records.filter((item) => item.id !== record.id);
    saveRecords();
    render();
    showToast(`${PERIODS[state.selectedPeriod].label}の記録を削除しました`);
  }

  async function shareLatestRecord() {
    const latest = getLatestRecord();
    if (!latest) return;

    const latestDate = new Date(latest.timestamp);
    const lines = [
      "🐾 ムクカプセル記録",
      `${formatDateLong(latestDate)} ${formatTime(latestDate)}（${PERIODS[latest.period].label}）にあげました。`,
      `前回から：${elapsedLabel(latestDate, new Date())}`,
    ];
    const familyUrl = buildFamilyUrl();
    if (familyUrl) lines.push(familyUrl);
    const text = lines.join("\n");

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
      return normalizeRecords(parsed);
    } catch {
      return [];
    }
  }

  function saveRecords() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.records));
  }

  function normalizeRecords(records) {
    if (!Array.isArray(records)) return [];
    return records
      .filter((record) =>
        record &&
        typeof record.dateKey === "string" &&
        PERIODS[record.period] &&
        Number.isFinite(new Date(record.timestamp).getTime()),
      )
      .map((record) => ({
        id: typeof record.id === "string" ? record.id : `${record.dateKey}-${record.period}`,
        dateKey: record.dateKey,
        period: record.period,
        timestamp: new Date(record.timestamp).toISOString(),
      }))
      .sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp));
  }

  function upsertStateRecord(record) {
    const normalized = normalizeRecords([record])[0];
    if (!normalized) return;
    const existingIndex = state.records.findIndex(
      (item) => item.dateKey === normalized.dateKey && item.period === normalized.period,
    );
    if (existingIndex >= 0) state.records[existingIndex] = normalized;
    else state.records.push(normalized);
    state.records.sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp));
  }

  function usesRemoteStorage() {
    return REMOTE_HOST || state.remoteAvailable;
  }

  function apiRequest(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("Accept", "application/json");
    const token = state.adminToken || state.viewToken;
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(path, { ...options, headers, cache: "no-store" });
  }

  function handleWriteFailure(status) {
    if (status === 401 || status === 403) {
      state.adminToken = "";
      localStorage.removeItem(ADMIN_TOKEN_KEY);
      renderAccessMode();
      showToast("管理用リンクをもう一度開いてください");
      return;
    }
    showToast("記録を保存できませんでした");
  }

  function captureLinkTokens() {
    const mode = new URLSearchParams(location.search).get("mode");
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));
    let adminToken = validToken(params.get("admin"));
    const viewToken = validToken(params.get("view"));

    if (mode === "family") {
      adminToken = "";
      localStorage.removeItem(ADMIN_TOKEN_KEY);
    } else if (adminToken) {
      localStorage.setItem(ADMIN_TOKEN_KEY, adminToken);
    }
    if (viewToken) localStorage.setItem(VIEW_TOKEN_KEY, viewToken);
    if (params.has("admin") || params.has("view")) {
      history.replaceState(null, "", `${location.pathname}${location.search}`);
    }
    return { adminToken, viewToken };
  }

  function loadToken(key) {
    try {
      return validToken(localStorage.getItem(key));
    } catch {
      return "";
    }
  }

  function validToken(value) {
    return typeof value === "string" && /^[A-Za-z0-9_-]{32,}$/.test(value) ? value : "";
  }

  function buildFamilyUrl() {
    if (!usesRemoteStorage() || !state.viewToken) return "";
    const url = new URL(`${location.origin}${location.pathname}`);
    url.searchParams.set("mode", "family");
    return `${url.href}#view=${encodeURIComponent(state.viewToken)}`;
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
