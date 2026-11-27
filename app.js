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
    drafts: Object.create(null),
    model: null,
    offline: false,
    loading: false,
    savingId: "",
    notice: "",
    noticeTone: "",
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
      requests: model.requests || [],
      requestsReady: !!model.requestsReady,
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
      requests: parsed.requests || [],
      requestsReady: !!parsed.requestsReady,
      summary: summary,
      updated: summary.updated || parsed.updated || "",
      savedAt: new Date().toISOString(),
      headerFound: true,
    };
  }

  function withRequests(model, requestTable) {
    var parsed = logic.parseRequests(requestTable);
    model.requests = parsed.items;
    model.requestsReady = parsed.headerFound;
    return model;
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
    var requestTable = null;
    try {
      requestTable = await loadSheet("Solicitações");
    } catch (e) {
      requestTable = null;
    }
    return withRequests(buildModel(summaryTable, demandTable), requestTable);
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
    button.setAttribute("aria-label", loading ? "Atualizando" : "Atualizar");
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

  function emptyState(title, text) {
    var box = el("div", "empty");
    var icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 48 48");
    icon.setAttribute("width", "48");
    icon.setAttribute("height", "48");
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = '<rect x="8" y="10" width="32" height="28" rx="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 22h16M16 28h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
    box.appendChild(icon);
    box.appendChild(el("p", "empty-title", title));
    if (text) box.appendChild(el("p", "", text));
    return box;
  }

  function renderResumo() {
    var summary = state.model.summary || {};
    var totals = logic.counts(state.model.items || []);
    els.searchWrap.hidden = true;
    els.hint.hidden = true;
    els.resultMeta.hidden = true;
    els.list.replaceChildren();
    var grid = el("div", "stats");
    function tile(label, value, wide) {
      if (value == null || value === "") return;
      var node = el("article", "stat" + (wide ? " stat-wide" : ""));
      node.appendChild(el("span", "", label));
      node.appendChild(el("strong", "", String(value)));
      grid.appendChild(node);
    }
    tile("Pendências", summary.pending || totals.active);
    tile("Concluídas na lista", totals.closed);
    tile("Créditos estimados", summary.credits);
    tile("Franquia por ciclo", summary.franchise);
    tile("Alterações consolidadas", summary.changes, true);
    tile("Correções", summary.fixes);
    if (!grid.childElementCount) {
      els.list.appendChild(emptyState("Resumo indisponível", "A aba Resumo da planilha não trouxe os números."));
      return;
    }
    els.list.appendChild(grid);
    els.live.textContent = "Resumo da planilha";
  }

  function renderDue(due, closed) {
    var node = el("p", "chip-due due-" + (due.kind || "empty"));
    var text = due.label || "Sem data";
    if (closed && due.label && due.kind !== "missing" && due.kind !== "empty" && due.kind !== "confirm") {
      node.className = "chip-due due-missing";
      node.textContent = "Concluída em " + due.label;
      return node;
    }
    if (due.kind === "today") text = "Hoje · " + due.label;
    else if (due.kind === "tomorrow") text = "Amanhã · " + due.label;
    else if (due.kind === "soon" || due.kind === "overdue") text = due.hint || due.label;
    node.textContent = text;
    return node;
  }

  function itemKey(item) {
    return (item.id || "sem-id") + "::" + item.order;
  }

  function renderCard(item) {
    var key = itemKey(item);
    var card = el("article", "card" + (item.closed ? "" : dueClass(item.due.kind)));
    var main = el("div", "card-main");
    var top = el("div", "card-top");
    top.appendChild(el("p", "demand-id", item.id || "—"));
    top.appendChild(el("p", "badge badge-" + statusTone(item.status), item.status));
    top.appendChild(renderDue(item.due, item.closed));
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
      var panel = el("div", "next" + (open ? " is-open" : ""));
      var inner = el("div", "next-inner");
      inner.appendChild(el("p", "", item.next));
      panel.appendChild(inner);
      button.addEventListener("click", function () {
        state.expanded[key] = !state.expanded[key];
        var expanded = !!state.expanded[key];
        button.setAttribute("aria-expanded", expanded ? "true" : "false");
        panel.classList.toggle("is-open", expanded);
      });
      card.appendChild(button);
      card.appendChild(panel);
    }
    if (!item.closed) {
      var finish = document.createElement("button");
      finish.type = "button";
      finish.className = "btn-complete";
      finish.textContent = state.savingId === item.id ? "Salvando…" : "Concluir";
      finish.disabled = !approvalsEnabled() || state.savingId === item.id;
      finish.addEventListener("click", function () { decide("complete", item); });
      card.appendChild(finish);
    }
    return card;
  }

  function dueClass(kind) {
    if (kind === "overdue") return " is-overdue";
    if (kind === "today") return " is-today";
    if (kind === "tomorrow") return " is-tomorrow";
    if (kind === "soon") return " is-soon";
    return "";
  }

  function webAppUrl() {
    var config = window.UJUMP_CONFIG || {};
    return String(config.approvalWebAppUrl || "").trim();
  }

  function approvalsEnabled() {
    return /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec\/?$/.test(webAppUrl());
  }

  function storedPin() {
    try { return localStorage.getItem("ujump-approval-pin") || ""; } catch (e) { return ""; }
  }

  function storedName() {
    try { return localStorage.getItem("ujump-approver-name") || ""; } catch (e) { return ""; }
  }

  function markCompleted(item) {
    var today = logic.saoPauloToday();
    var raw = String(today.getDate()).padStart(2, "0") + "/" + String(today.getMonth() + 1).padStart(2, "0") + "/" + today.getFullYear();
    item.closed = true;
    item.status = "Concluído";
    item.dueRaw = raw;
    item.due = logic.dueForItem(raw, true, today);
  }

  function showToast(message, tone) {
    var toast = $("toast");
    toast.hidden = false;
    toast.className = "toast " + (tone === "err" ? "err" : "ok");
    toast.textContent = message;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(function () { toast.hidden = true; }, 3400);
  }

  function closeSheet() {
    var sheet = $("sheet");
    sheet.classList.remove("is-open");
    sheet.hidden = true;
  }

  function openDecisionSheet(action, request) {
    return new Promise(function (resolve, reject) {
      var sheet = $("sheet");
      var form = $("sheet-form");
      var pinWrap = $("sheet-pin-wrap");
      var pinNote = $("sheet-pin-note");
      var pinInput = $("sheet-pin");
      var nameInput = $("sheet-name");
      var commentInput = $("sheet-comment");
      var hasPin = !!storedPin();
      sheet.hidden = false;
      var sheetCopy = {
        approve: ["Aprovar ", "Confirmar aprovação", "btn-approve"],
        reject: ["Recusar ", "Confirmar recusa", "btn-reject"],
        complete: ["Concluir ", "Confirmar conclusão", "btn-approve"],
      }[action] || ["Decidir ", "Confirmar", "btn-approve"];
      $("sheet-title").textContent = sheetCopy[0] + (request.id || "pedido");
      $("sheet-demand").textContent = request.title || "";
      $("sheet-ok").textContent = sheetCopy[1];
      $("sheet-ok").className = sheetCopy[2];
      nameInput.value = storedName();
      commentInput.value = "";
      pinInput.value = "";
      pinWrap.hidden = hasPin;
      pinNote.hidden = !hasPin;
      pinInput.required = !hasPin;
      function finish(value) {
        closeSheet();
        form.onsubmit = null;
        $("sheet-cancel").onclick = null;
        $("sheet-backdrop").onclick = null;
        $("sheet-pin-change").onclick = null;
        if (value) resolve(value);
        else reject(new Error("cancelado"));
      }
      $("sheet-pin-change").onclick = function () {
        pinWrap.hidden = false;
        pinNote.hidden = true;
        pinInput.required = true;
        pinInput.focus();
      };
      form.onsubmit = function (event) {
        event.preventDefault();
        var pin = pinInput.value.trim() || storedPin();
        if (!pin) return;
        var name = nameInput.value.trim();
        try {
          localStorage.setItem("ujump-approval-pin", pin);
          if (name) localStorage.setItem("ujump-approver-name", name);
        } catch (e) { /* segue sem gravar */ }
        finish({ pin: pin, name: name, comment: commentInput.value.trim() });
      };
      $("sheet-cancel").onclick = function () { finish(null); };
      $("sheet-backdrop").onclick = function () { finish(null); };
      (hasPin ? nameInput : pinInput).focus();
    });
  }

  function postApproval(url, payload) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    }).then(function (response) {
      if (!response || response.type === "opaque") throw new Error("sem leitura");
      return response.text();
    }).then(function (text) {
      return JSON.parse(text);
    });
  }

  function jsonpApproval(url, payload) {
    return new Promise(function (resolve, reject) {
      var cb = "__ujumpApproval" + Math.random().toString(36).slice(2);
      var params = new URLSearchParams();
      params.set("action", payload.action);
      params.set("id", payload.id);
      params.set("pin", payload.pin || "");
      params.set("name", payload.name || "");
      params.set("comment", payload.comment || "");
      params.set("callback", cb);
      var script = document.createElement("script");
      var timer = setTimeout(function () {
        cleanup();
        reject(new Error("O Apps Script demorou para responder."));
      }, 20000);
      function cleanup() {
        clearTimeout(timer);
        try { delete window[cb]; } catch (e) { window[cb] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      }
      window[cb] = function (data) {
        cleanup();
        resolve(data);
      };
      script.onerror = function () {
        cleanup();
        reject(new Error("Não consegui falar com o Apps Script."));
      };
      script.src = url + (url.indexOf("?") === -1 ? "?" : "&") + params.toString();
      document.head.appendChild(script);
    });
  }

  function callApproval(payload) {
    var url = webAppUrl();
    return postApproval(url, payload).catch(function () {
      return jsonpApproval(url, payload);
    });
  }

  async function decide(action, request) {
    if (!approvalsEnabled() || state.savingId) return;
    var form;
    try {
      form = await openDecisionSheet(action, request);
    } catch (error) {
      return;
    }
    state.savingId = request.id;
    renderList();
    try {
      var result = await callApproval({
        action: action,
        id: request.id,
        pin: form.pin,
        name: form.name,
        comment: form.comment,
      });
      if (result && result.code === "pin") {
        try { localStorage.removeItem("ujump-approval-pin"); } catch (e) { /* ignore */ }
        showToast("PIN incorreto. Tente de novo.", "err");
        state.savingId = "";
        renderList();
        return decide(action, request);
      }
      if (!result || result.ok === false) {
        throw new Error((result && result.error) || "Não foi possível salvar a decisão.");
      }
      if (action === "complete") markCompleted(request);
      showToast(action === "approve"
        ? request.id + " aprovado" + (result.itemId ? " · " + result.itemId : "")
        : action === "complete"
          ? request.id + " concluída."
          : request.id + " recusado.", "ok");
      state.savingId = "";
      render();
      await requestRefresh({ quiet: true });
    } catch (error) {
      state.savingId = "";
      showToast(error && error.message ? error.message : "Não foi possível salvar a decisão.", "err");
      renderList();
    }
  }

  function requestCard(request) {
    var card = el("article", "card");
    var main = el("div", "card-main");
    var top = el("div", "card-top");
    top.appendChild(el("p", "demand-id", request.id || "Novo"));
    var tone = request.state === "approved" ? "done" : request.state === "rejected" ? "rejected" : "todo";
    top.appendChild(el("p", "badge badge-" + tone, request.status));
    main.appendChild(top);
    main.appendChild(el("h2", "title", request.title));
    var meta = [];
    if (request.person) meta.push(request.person);
    if (request.askedOn) meta.push("pedido em " + request.askedOn);
    if (meta.length) main.appendChild(el("p", "meta", meta.join(" · ")));
    if (request.detail) main.appendChild(el("p", "detail", request.detail));
    if (request.decidedBy || request.decidedOn || request.createdId) {
      var decision = [];
      if (request.decidedBy) decision.push(request.decidedBy);
      if (request.decidedOn) decision.push(request.decidedOn);
      var line = decision.join(" · ");
      if (request.createdId) line = (line ? line + " · " : "") + "item " + request.createdId;
      main.appendChild(el("p", "meta", line));
    }
    if (request.note) main.appendChild(el("p", "meta", request.note));
    card.appendChild(main);

    if (request.state === "pending") {
      var actions = el("div", "actions");
      var approve = document.createElement("button");
      approve.type = "button";
      approve.className = "btn-approve";
      approve.textContent = state.savingId === request.id ? "Salvando…" : "Aprovar";
      var reject = document.createElement("button");
      reject.type = "button";
      reject.className = "btn-reject";
      reject.textContent = "Recusar";
      var enabled = approvalsEnabled() && state.savingId !== request.id;
      approve.disabled = !enabled;
      reject.disabled = !enabled;
      approve.addEventListener("click", function () { decide("approve", request); });
      reject.addEventListener("click", function () { decide("reject", request); });
      actions.appendChild(approve);
      actions.appendChild(reject);
      card.appendChild(actions);
    }
    return card;
  }

  function renderApprovals() {
    var requests = state.model.requests || [];
    var counts = logic.requestCounts(requests);
    document.querySelector('[data-count="approval"]').textContent = String(counts.pending);
    var button = document.querySelector('[data-filter="aprovar"]');
    if (button) button.classList.toggle("has-queue", counts.pending > 0);
    var shown = logic.filterRequests(requests, state.query);
    var pending = shown.filter(function (item) { return item.state === "pending"; });
    var decided = shown.filter(function (item) { return item.state !== "pending"; });
    els.resultMeta.hidden = false;
    els.resultMeta.textContent = counts.pending === 1
      ? "1 pedido aguardando aprovação"
      : counts.pending + " pedidos aguardando aprovação";
    els.hint.hidden = true;
    els.q.placeholder = "Buscar pedido";
    els.searchWrap.hidden = false;
    els.list.replaceChildren();
    if (!approvalsEnabled()) {
      els.list.appendChild(el("p", "approve-note", "Os botões ficam desligados até o endereço /exec do Apps Script ser colado em config.js."));
    } else if (!storedPin()) {
      var pinNote = el("p", "approve-note", "Na primeira decisão, o app pede o PIN e guarda neste celular.");
      els.list.appendChild(pinNote);
    } else {
      var forget = document.createElement("button");
      forget.type = "button";
      forget.className = "linkish";
      forget.textContent = "Esquecer PIN deste celular";
      forget.addEventListener("click", function () {
        try { localStorage.removeItem("ujump-approval-pin"); } catch (e) { /* ignore */ }
        renderList();
      });
      els.list.appendChild(forget);
    }
    if (!state.model.requestsReady) {
      var missing = el("div", "empty");
      missing.appendChild(el("p", "empty-title", "A aba Solicitações ainda não está na planilha."));
      missing.appendChild(el("p", "", "No Apps Script, execute a função setupSolicitacoes."));
      els.list.appendChild(missing);
      return;
    }
    if (!shown.length) {
      var empty = el("div", "empty");
      empty.appendChild(el("p", "empty-title", state.query.trim() ? "Nenhum pedido encontrado." : "Nenhum pedido para aprovar."));
      els.list.appendChild(empty);
      return;
    }
    pending.forEach(function (item) { els.list.appendChild(requestCard(item)); });
    if (decided.length) {
      els.list.appendChild(el("p", "section-label", "Já decididas"));
      decided.forEach(function (item) { els.list.appendChild(requestCard(item)); });
    }
  }

  function dueGroups(items) {
    var order = [
      ["overdue", "Atrasadas"],
      ["today", "Hoje"],
      ["tomorrow", "Amanhã"],
      ["soon", "Esta semana"],
      ["later", "Depois"],
      ["confirm", "A confirmar"],
    ];
    var buckets = {};
    items.forEach(function (item) {
      var kind = (item.due && item.due.kind) || "confirm";
      if (kind === "missing" || kind === "empty" || kind === "text") kind = "confirm";
      if (!buckets[kind]) buckets[kind] = [];
      buckets[kind].push(item);
    });
    return order.filter(function (pair) { return buckets[pair[0]] && buckets[pair[0]].length; })
      .map(function (pair) { return { title: pair[1], items: buckets[pair[0]] }; });
  }

  function visibleItems() {
    return logic.filterItems(state.model.items, state.filter, state.query);
  }

  function renderList() {
    var items = state.model.items;
    var totals = logic.counts(items);
    var approval = logic.requestCounts(state.model.requests || []);
    document.querySelectorAll("[data-count]").forEach(function (node) {
      var key = node.getAttribute("data-count");
      if (key === "approval") {
        node.textContent = String(approval.pending);
        node.hidden = approval.pending === 0;
      }
    });
    if (state.filter === "resumo") {
      renderResumo();
      return;
    }
    if (state.filter === "aprovar") {
      renderApprovals();
      els.live.textContent = els.resultMeta.textContent;
      return;
    }
    els.q.placeholder = "Buscar por ID ou demanda";
    els.searchWrap.hidden = false;
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
      return item.due.kind === "overdue" || item.due.kind === "today" || item.due.kind === "tomorrow" || item.due.kind === "soon" || item.due.kind === "later";
    });
    var hasConfirm = activeShown.some(function (item) { return item.due.kind === "confirm"; });
    var overdueCount = activeShown.filter(function (item) { return item.due.kind === "overdue"; }).length;
    var todayCount = activeShown.filter(function (item) { return item.due.kind === "today"; }).length;
    var tomorrowCount = activeShown.filter(function (item) { return item.due.kind === "tomorrow"; }).length;
    if (overdueCount > 0) {
      els.hint.hidden = false;
      els.hint.textContent = overdueCount === 1
        ? "1 demanda atrasada."
        : overdueCount + " demandas atrasadas.";
    } else if (todayCount > 0 && state.filter !== "concluidas" && !state.query.trim()) {
      els.hint.hidden = false;
      els.hint.textContent = todayCount === 1 ? "1 vence hoje." : todayCount + " vencem hoje.";
    } else if (tomorrowCount > 0 && state.filter !== "concluidas" && !state.query.trim()) {
      els.hint.hidden = false;
      els.hint.textContent = tomorrowCount === 1 ? "1 vence amanhã." : tomorrowCount + " vencem amanhã.";
    } else if (state.filter !== "concluidas" && !state.query.trim() && hasConfirm && !hasRealDate && activeShown.length) {
      els.hint.hidden = false;
      els.hint.textContent = "As datas de conclusão seguem a confirmar até serem combinadas.";
    } else {
      els.hint.hidden = true;
      els.hint.textContent = "";
    }

    els.list.replaceChildren();
    if (!shown.length) {
      els.list.appendChild(emptyState(
        state.query.trim() ? "Nenhuma demanda encontrada." : "Nenhuma demanda nesta lista.",
        state.query.trim() ? "Tente outro termo ou limpe a busca." : ""
      ));
      return;
    }
    var fragment = document.createDocumentFragment();
    if (state.filter === "ativas") {
      dueGroups(shown).forEach(function (group) {
        fragment.appendChild(el("h2", "group-label", group.title));
        group.items.forEach(function (item) { fragment.appendChild(renderCard(item)); });
      });
    } else {
      shown.forEach(function (item) { fragment.appendChild(renderCard(item)); });
    }
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
    var titles = {
      ativas: "Demandas",
      aprovar: "Aguardando aprovação",
      concluidas: "Concluídas",
      resumo: "Resumo",
    };
    els.title.textContent = titles[state.filter] || "Demandas";
    renderList();
  }

  function renderFatal(error) {
    els.updated.textContent = "Não foi possível ler a planilha";
    els.banner.hidden = true;
    els.hint.hidden = true;
    els.resultMeta.hidden = true;
    els.list.replaceChildren();
    var box = emptyState(error && error.message ? error.message : "Não foi possível ler a planilha.", "Confira a conexão e tente de novo.");
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
    if (state.model) render();
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
      title: $("screen-title"),
      list: $("list"),
      q: $("q"),
      searchWrap: $("search-wrap"),
      hint: $("hint"),
      banner: $("banner"),
      resultMeta: $("result-meta"),
      live: $("live"),
      ptr: $("ptr"),
      tabs: document.querySelector(".tabbar"),
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
