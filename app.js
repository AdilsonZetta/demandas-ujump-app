(function () {
  "use strict";

  var SHEET_ID = "1ShHyseBI4PANomqr2oaHipg-GZYTsfbM4gBuggFmeZ4";
  var DATA_CACHE = "ujump-data-v1";
  var CALLBACK = "__ujumpGviz";
  var logic = window.UjumpLogic;

  var state = {
    filter: "ativas",
    query: "",
    expanded: Object.create(null),
    model: null,
    offline: false,
    loading: false,
  };

  var els = {};
  var inflight = null;
  var queued = null;
  var ptrStart = null;
  var ptrDistance = 0;

  function $(id) {
    return document.getElementById(id);
  }

  function sheetUrl(name) {
    var url =
      "https://docs.google.com/spreadsheets/d/" +
      SHEET_ID +
      "/gviz/tq?tqx=" +
      encodeURIComponent("out:json;responseHandler:" + CALLBACK);
    if (name) url += "&sheet=" + encodeURIComponent(name);
    url += "&t=" + Date.now();
    return url;
  }

  function tellWorker(message) {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage(message);
    }
  }

  function loadSheet(name) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var script = document.createElement("script");
      var timer = setTimeout(function () {
        finish(new Error("A planilha demorou para responder."));
      }, 20000);

      function finish(error, table) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        script.onload = null;
        script.onerror = null;
        if (script.parentNode) script.parentNode.removeChild(script);
        try {
          delete window[CALLBACK];
        } catch (e) {
          window[CALLBACK] = undefined;
        }
        if (error) {
          tellWorker({ type: "discard-sheet", sheet: name || "" });
          reject(error);
        } else {
          tellWorker({ type: "commit-sheet", sheet: name || "" });
          resolve(table);
        }
      }

      window[CALLBACK] = function (payload) {
        if (!payload || payload.status !== "ok" || !payload.table) {
          finish(new Error("A planilha não retornou dados."));
          return;
        }
        finish(null, payload.table);
      };

      script.async = true;
      script.onerror = function () {
        finish(new Error("Sem conexão com a planilha."));
      };
      script.src = sheetUrl(name);
      document.head.appendChild(script);
    });
  }

  function modelKey() {
    return new URL("offline-model.json", window.location.href).href;
  }

  function persistModel(model) {
    var json = JSON.stringify(model);
    try {
      localStorage.setItem("ujump-model", json);
    } catch (e) {
      /* armazenamento cheio ou bloqueado */
    }
    tellWorker({ type: "store-model", model: model });
    if (!("caches" in window)) return Promise.resolve();
    return caches.open(DATA_CACHE).then(function (cache) {
      return cache.put(
        modelKey(),
        new Response(json, { headers: { "Content-Type": "application/json" } })
      );
    }).catch(function () {
      return undefined;
    });
  }

  function readModel() {
    var fromCache = ("caches" in window)
      ? caches.open(DATA_CACHE).then(function (cache) {
          return cache.match(modelKey());
        }).then(function (response) {
          return response ? response.json() : null;
        }).catch(function () {
          return null;
        })
      : Promise.resolve(null);

    return fromCache.then(function (model) {
      if (model && model.items) return model;
      try {
        var raw = localStorage.getItem("ujump-model");
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    });
  }

  function prepareModel(model) {
    var items = logic.reclassify(model.items || [], logic.saoPauloToday());
    return {
      items: items,
      summary: model.summary || {},
      updated: model.updated || (model.summary && model.summary.updated) || "",
      savedAt: model.savedAt || null,
      headerFound: model.headerFound !== false,
    };
  }

  function buildModel(summaryTable, demandTable) {
    var summary = summaryTable ? logic.parseSummary(summaryTable) : {};
    var parsed = logic.parseDemands(demandTable);
    if (!parsed.headerFound) {
      var error = new Error("Não encontrei as colunas da aba Acompanhamento.");
      error.code = "format";
      throw error;
    }
    return {
      items: parsed.items,
      summary: summary,
      updated: summary.updated || parsed.updated || "",
      savedAt: new Date().toISOString(),
      headerFound: true,
    };
  }

  async function fetchModel() {
    var summaryTable = null;
    try {
      summaryTable = await loadSheet("Resumo");
    } catch (e) {
      try {
        summaryTable = await loadSheet("");
      } catch (again) {
        summaryTable = null;
      }
    }
    var demandTable = await loadSheet("Acompanhamento");
    return buildModel(summaryTable, demandTable);
  }

  function canPing() {
    if (navigator.onLine === false) return Promise.resolve(false);
    return fetch(sheetUrl("Resumo"), { mode: "no-cors", cache: "no-store" })
      .then(function (response) {
        return response.type === "opaque" || response.ok;
      })
      .catch(function () { return false; });
  }

  function setLoading(loading) {
    state.loading = loading;
    var button = els.refresh;
    button.disabled = loading;
    button.setAttribute("aria-busy", loading ? "true" : "false");
    button.querySelector("span").textContent = loading ? "Atualizando" : "Atualizar";
    button.classList.toggle("is-loading", loading);
  }

  async function doRefresh(options) {
    var quiet = options && options.quiet && state.model;
    if (!quiet) setLoading(true);
    else setLoading(true);
    try {
      var model = await fetchModel();
      var online = await canPing();
      state.model = prepareModel(model);
      state.offline = !online;
      await persistModel(model);
      render();
      announce(state.offline
        ? "Sem conexão. Mostrando a última leitura salva."
        : "Demandas atualizadas.");
    } catch (error) {
      var cached = await readModel();
      if (cached && cached.items) {
        state.model = prepareModel(cached);
        state.offline = true;
        render();
        announce("Sem conexão. Mostrando a última leitura salva.");
      } else if (!state.model) {
        renderFatal(error);
        announce("Não foi possível ler a planilha.");
      } else {
        state.offline = true;
        render();
      }
    } finally {
      setLoading(false);
    }
  }

  function requestRefresh(options) {
    if (inflight) {
      queued = options || queued || { quiet: true };
      return inflight;
    }
    inflight = doRefresh(options || {}).finally(function () {
      inflight = null;
      if (queued) {
        var next = queued;
        queued = null;
        requestRefresh(next);
      }
    });
    return inflight;
  }

  function formatSavedAt(iso) {
    if (!iso) return null;
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    var dateText = new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "2-digit",
    }).format(date);
    var timeText = new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
    return { dateText: dateText, timeText: timeText };
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function statusTone(status) {
    var text = logic.fold(status);
    if (logic.isClosed(status)) return "done";
    if (text.indexOf("andamento") !== -1 || text.indexOf("progress") !== -1 || text.indexOf("revis") !== -1) {
      return "progress";
    }
    if (text.indexOf("fazer") !== -1 || text.indexOf("pend") !== -1 || text.indexOf("aberto") !== -1) {
      return "todo";
    }
    if (text.indexOf("paus") !== -1 || text.indexOf("aguard") !== -1 || text.indexOf("bloque") !== -1) {
      return "wait";
    }
    return "neutral";
  }

  function renderSummary(summary) {
    els.summary.replaceChildren();
    var chips = [
      ["pending", summary.pending, "pendências"],
      ["credits", summary.credits, "créditos"],
      ["franchise", summary.franchise, "franquia"],
      ["changes", summary.changes, "consolidadas"],
      ["fixes", summary.fixes, "correções"],
    ];
    var any = false;
    chips.forEach(function (chip) {
      if (!chip[1]) return;
      any = true;
      var node = el("p", "chip chip-" + chip[0]);
      if (chip[0] === "franchise") {
        node.appendChild(document.createTextNode(chip[2] + " "));
        node.appendChild(el("strong", "", chip[1]));
      } else {
        node.appendChild(el("strong", "", chip[1]));
        node.appendChild(document.createTextNode(" " + chip[2]));
      }
      els.summary.appendChild(node);
    });
    els.summary.hidden = !any;
  }

  function renderDue(due) {
    var node = el("p", "due due-" + due.kind);
    if (due.hint && due.kind !== "confirm" && due.kind !== "missing" && due.kind !== "empty" && due.kind !== "text") {
      node.appendChild(el("span", "due-hint", due.hint));
      node.appendChild(el("span", "due-date", due.label));
    } else {
      node.textContent = due.label || "Sem data";
    }
    return node;
  }

  function itemKey(item) {
    return (item.id || "sem-id") + "::" + item.order;
  }

  function renderCard(item) {
    var key = itemKey(item);
    var card = el("article", "card" + (item.due.kind === "overdue" ? " is-overdue" : item.due.kind === "today" || item.due.kind === "soon" ? " is-soon" : ""));
    var main = el("div", "card-main");
    var top = el("div", "card-top");
    top.appendChild(el("p", "demand-id", item.id || "—"));
    top.appendChild(el("p", "badge badge-" + statusTone(item.status), item.status));
    top.appendChild(renderDue(item.due));
    main.appendChild(top);
    main.appendChild(el("h2", "title", item.title));
    if (item.registered) main.appendChild(el("p", "meta", "Registro " + item.registered));
    card.appendChild(main);

    if (item.next) {
      var open = !!state.expanded[key];
      var button = document.createElement("button");
      button.type = "button";
      button.className = "next-toggle";
      button.setAttribute("aria-expanded", open ? "true" : "false");
      var label = el("span", "", "Próximo passo");
      var chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      chevron.setAttribute("viewBox", "0 0 20 20");
      chevron.setAttribute("aria-hidden", "true");
      chevron.classList.add("chevron");
      var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M5 7.5 10 12.5 15 7.5");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "1.8");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      chevron.appendChild(path);
      button.appendChild(label);
      button.appendChild(chevron);
      var panel = el("div", "next");
      panel.hidden = !open;
      panel.appendChild(el("p", "", item.next));
      button.addEventListener("click", function () {
        state.expanded[key] = !state.expanded[key];
        var expanded = !!state.expanded[key];
        button.setAttribute("aria-expanded", expanded ? "true" : "false");
        panel.hidden = !expanded;
      });
      card.appendChild(button);
      card.appendChild(panel);
    }
    return card;
  }

  function visibleItems() {
    return logic.filterItems(state.model.items, state.filter, state.query);
  }

  function renderList() {
    var items = state.model.items;
    var totals = logic.counts(items);
    document.querySelectorAll("[data-count]").forEach(function (node) {
      var key = node.getAttribute("data-count");
      node.textContent = String(totals[key] == null ? 0 : totals[key]);
    });
    var shown = visibleItems();
    var filterLabel = state.filter === "ativas" ? "ativas" : state.filter === "concluidas" ? "concluídas" : "no total";
    if (state.query.trim()) {
      els.resultMeta.textContent = shown.length === 1
        ? "1 resultado"
        : shown.length + " resultados";
    } else if (state.filter === "ativas") {
      els.resultMeta.textContent = totals.active === 1 ? "1 demanda ativa" : totals.active + " demandas ativas";
    } else if (state.filter === "concluidas") {
      els.resultMeta.textContent = totals.closed === 1 ? "1 demanda concluída" : totals.closed + " demandas concluídas";
    } else {
      els.resultMeta.textContent = totals.all === 1 ? "1 demanda" : totals.all + " demandas";
    }
    els.resultMeta.hidden = false;

    var activeShown = shown.filter(function (item) { return !item.closed; });
    var hasRealDate = activeShown.some(function (item) {
      return item.due.kind === "overdue" || item.due.kind === "today" || item.due.kind === "soon" || item.due.kind === "later";
    });
    var hasConfirm = activeShown.some(function (item) { return item.due.kind === "confirm"; });
    var overdueCount = activeShown.filter(function (item) { return item.due.kind === "overdue"; }).length;
    if (overdueCount > 0) {
      els.hint.hidden = false;
      els.hint.textContent = overdueCount === 1
        ? "1 demanda atrasada."
        : overdueCount + " demandas atrasadas.";
    } else if (state.filter !== "concluidas" && !state.query.trim() && hasConfirm && !hasRealDate && activeShown.length) {
      els.hint.hidden = false;
      els.hint.textContent = "As datas de conclusão seguem a confirmar até serem combinadas.";
    } else {
      els.hint.hidden = true;
      els.hint.textContent = "";
    }

    els.list.replaceChildren();
    if (!shown.length) {
      var empty = el("div", "empty");
      empty.appendChild(el("p", "empty-title", state.query.trim() ? "Nenhuma demanda encontrada." : "Nenhuma demanda nesta lista."));
      if (state.query.trim()) {
        empty.appendChild(el("p", "", "Tente outro termo ou limpe a busca."));
      }
      els.list.appendChild(empty);
      return;
    }
    var fragment = document.createDocumentFragment();
    shown.forEach(function (item) { fragment.appendChild(renderCard(item)); });
    els.list.appendChild(fragment);
    els.live.textContent = els.resultMeta.textContent + " " + filterLabel;
  }

  function render() {
    var model = state.model;
    if (model.updated) {
      els.updated.textContent = "Atualizado em " + model.updated;
    } else {
      els.updated.textContent = "Data de atualização não informada na planilha";
    }
    var saved = formatSavedAt(model.savedAt);
    if (state.offline) {
      els.banner.hidden = false;
      els.banner.textContent = saved
        ? "Sem conexão. Mostrando a leitura de " + saved.dateText + " às " + saved.timeText + "."
        : "Sem conexão. Mostrando a última leitura salva.";
    } else {
      els.banner.hidden = true;
      els.banner.textContent = "";
      if (saved) els.updated.textContent += " · lido às " + saved.timeText;
    }
    renderSummary(model.summary || {});
    renderList();
  }

  function renderFatal(error) {
    els.updated.textContent = "Não foi possível ler a planilha";
    els.summary.hidden = true;
    els.banner.hidden = true;
    els.hint.hidden = true;
    els.resultMeta.hidden = true;
    els.list.replaceChildren();
    var box = el("div", "empty");
    box.appendChild(el("p", "empty-title", error && error.message ? error.message : "Não foi possível ler a planilha."));
    box.appendChild(el("p", "", "Confira a conexão e tente de novo. A última versão fica disponível depois da primeira leitura."));
    var retry = document.createElement("button");
    retry.type = "button";
    retry.className = "retry";
    retry.textContent = "Tentar de novo";
    retry.addEventListener("click", function () { requestRefresh(); });
    box.appendChild(retry);
    els.list.appendChild(box);
  }

  function announce(text) {
    els.live.textContent = text;
  }

  function selectFilter(filter) {
    state.filter = filter;
    document.querySelectorAll("[data-filter]").forEach(function (button) {
      var selected = button.getAttribute("data-filter") === filter;
      button.setAttribute("aria-selected", selected ? "true" : "false");
      button.tabIndex = selected ? 0 : -1;
    });
    if (state.model) renderList();
  }

  function enableServiceWorker() {
    if (!("serviceWorker" in navigator)) return Promise.resolve();
    return navigator.serviceWorker.register("sw.js").then(function () {
      return navigator.serviceWorker.ready;
    }).then(function () {
      if (navigator.serviceWorker.controller) return undefined;
      return new Promise(function (resolve) {
        var timer = setTimeout(resolve, 1500);
        navigator.serviceWorker.addEventListener("controllerchange", function () {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }).catch(function () {
      return undefined;
    });
  }

  function onReturn() {
    if (document.visibilityState && document.visibilityState !== "visible") return;
    requestRefresh({ quiet: true });
  }

  function bindPullToRefresh() {
    var threshold = 72;
    window.addEventListener("touchstart", function (event) {
      if (window.scrollY > 8 || !event.touches || event.touches.length !== 1) {
        ptrStart = null;
        return;
      }
      ptrStart = event.touches[0].clientY;
      ptrDistance = 0;
    }, { passive: true });

    window.addEventListener("touchmove", function (event) {
      if (ptrStart == null) return;
      var distance = event.touches[0].clientY - ptrStart;
      if (distance <= 0 || window.scrollY > 8) {
        els.ptr.classList.remove("show");
        return;
      }
      ptrDistance = Math.min(distance, 128);
      els.ptr.classList.add("show");
      els.ptr.style.transform = "translateY(" + Math.min(ptrDistance * 0.35, 36) + "px)";
      els.ptr.textContent = state.loading
        ? "Atualizando…"
        : ptrDistance > threshold
          ? "Solte para atualizar"
          : "Puxe para atualizar";
    }, { passive: true });

    function endPull() {
      var shouldRefresh = ptrStart != null && ptrDistance > threshold && !state.loading;
      ptrStart = null;
      ptrDistance = 0;
      els.ptr.classList.remove("show");
      els.ptr.style.transform = "";
      if (shouldRefresh) requestRefresh({ quiet: true });
    }

    window.addEventListener("touchend", endPull);
    window.addEventListener("touchcancel", endPull);
  }

  function bind() {
    els.refresh.addEventListener("click", function () { requestRefresh(); });
    els.q.addEventListener("input", function () {
      state.query = els.q.value;
      if (state.model) renderList();
    });
    document.querySelectorAll("[data-filter]").forEach(function (button) {
      button.addEventListener("click", function () {
        selectFilter(button.getAttribute("data-filter"));
      });
    });
    els.tabs.addEventListener("keydown", function (event) {
      var buttons = Array.prototype.slice.call(els.tabs.querySelectorAll("[data-filter]"));
      var index = buttons.findIndex(function (button) {
        return button.getAttribute("aria-selected") === "true";
      });
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      event.preventDefault();
      var next = event.key === "ArrowRight" ? index + 1 : index - 1;
      if (next < 0) next = buttons.length - 1;
      if (next >= buttons.length) next = 0;
      selectFilter(buttons[next].getAttribute("data-filter"));
      buttons[next].focus();
    });
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    window.addEventListener("pageshow", function (event) {
      if (event.persisted) onReturn();
    });
    window.addEventListener("online", function () { requestRefresh({ quiet: true }); });
    bindPullToRefresh();
  }

  function showSkeleton() {
    els.list.replaceChildren();
    for (var i = 0; i < 4; i++) {
      var card = el("article", "card skeleton");
      card.appendChild(el("div", "sk sk-line"));
      card.appendChild(el("div", "sk sk-title"));
      card.appendChild(el("div", "sk sk-short"));
      els.list.appendChild(card);
    }
  }

  async function start() {
    els = {
      refresh: $("refresh"),
      updated: $("updated"),
      summary: $("summary"),
      list: $("list"),
      q: $("q"),
      hint: $("hint"),
      banner: $("banner"),
      resultMeta: $("result-meta"),
      live: $("live"),
      ptr: $("ptr"),
      tabs: document.querySelector(".tabs"),
    };
    bind();
    selectFilter("ativas");
    showSkeleton();
    await enableServiceWorker();
    await requestRefresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
