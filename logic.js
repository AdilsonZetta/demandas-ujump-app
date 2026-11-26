(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.UjumpLogic = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function fold(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function formatBR(date) {
    return pad(date.getDate()) + "/" + pad(date.getMonth() + 1) + "/" + date.getFullYear();
  }

  function saoPauloToday(now) {
    var parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now || new Date());
    function pick(type) {
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === type) return Number(parts[i].value);
      }
      return 0;
    }
    return new Date(pick("year"), pick("month") - 1, pick("day"));
  }

  function cellText(cell) {
    if (cell == null) return "";
    if (typeof cell === "string" || typeof cell === "number") return String(cell).trim();
    if (typeof cell !== "object") return "";
    if (cell.f != null && String(cell.f).trim() !== "") return String(cell.f).trim();
    var value = cell.v;
    if (value == null) return "";
    if (typeof value === "number") return String(value);
    var match = /^Date\((-?\d+),(\d+),(\d+)/.exec(String(value));
    if (match) {
      return formatBR(new Date(Number(match[1]), Number(match[2]), Number(match[3])));
    }
    return String(value).trim();
  }

  function tableMatrix(table) {
    var cols = (table && table.cols) || [];
    var header = cols.map(function (col) {
      return col && col.label ? String(col.label).trim() : "";
    });
    var body = ((table && table.rows) || []).map(function (row) {
      var cells = (row && row.c) || [];
      return header.map(function (_, index) {
        return cellText(cells[index]);
      });
    });
    return [header].concat(body);
  }

  function isIdHeader(label) {
    return /(^|\s)id$/.test(fold(label));
  }

  function findHeaderIndex(matrix) {
    for (var i = 0; i < matrix.length; i++) {
      var labels = matrix[i].map(fold);
      var hasDemanda = labels.some(function (label) {
        return label === "demanda" || label.endsWith(" demanda");
      });
      var hasStatus = labels.some(function (label) {
        return label === "situacao" || label.indexOf("situacao") !== -1;
      });
      var hasDue = labels.some(function (label) {
        return label.indexOf("conclus") !== -1;
      });
      if (hasDemanda && (hasStatus || hasDue)) return i;
    }
    return -1;
  }

  function columnIndex(headers, test, options) {
    var allowLong = options && options.allowLong;
    var labels = headers.map(fold);
    var found = -1;
    for (var i = 0; i < labels.length; i++) {
      var label = labels[i];
      if (!label || !test(label, headers[i])) continue;
      // The merged title sits in the ID header and can mention other column names.
      if (!allowLong && (isIdHeader(label) || label.length > 48)) continue;
      if (found < 0 || label.length < labels[found].length) found = i;
    }
    return found;
  }

  function isClosed(status) {
    var text = fold(status);
    if (!text) return false;
    if (text.indexOf("parcial") !== -1) return false;
    if (text.indexOf("nao ") !== -1) return false;
    return (
      text.indexOf("conclu") !== -1 ||
      text.indexOf("finaliz") !== -1 ||
      text.indexOf("entreg") !== -1 ||
      text.indexOf("resolvid") !== -1 ||
      text.indexOf("encerrad") !== -1 ||
      text.indexOf("cancel") !== -1 ||
      text === "feito" ||
      text === "feita" ||
      text === "ok" ||
      text === "done"
    );
  }

  function parseBRDate(text) {
    var match = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(String(text || "").trim());
    if (!match) return null;
    var year = Number(match[3]);
    if (year < 100) year += 2000;
    var day = Number(match[1]);
    var month = Number(match[2]);
    var date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }
    return date;
  }

  function classifyDue(text, today) {
    var raw = String(text || "").trim();
    var folded = fold(raw);
    if (!raw) return { kind: "empty", label: "Sem data", hint: "" };
    if (
      folded.indexOf("confirmar") !== -1 ||
      folded.indexOf("a combinar") !== -1 ||
      folded === "definir" ||
      folded === "tbd"
    ) {
      return { kind: "confirm", label: raw, hint: "" };
    }
    if (
      folded.indexOf("nao inform") !== -1 ||
      folded.indexOf("sem data") !== -1 ||
      folded.indexOf("indefin") !== -1
    ) {
      return { kind: "missing", label: raw, hint: "" };
    }
    var date = parseBRDate(raw);
    if (!date) return { kind: "text", label: raw, hint: "" };
    var base = today || saoPauloToday();
    var diff = Math.round((date.getTime() - base.getTime()) / 86400000);
    var label = formatBR(date);
    if (diff < 0) {
      return {
        kind: "overdue",
        label: label,
        hint: diff === -1 ? "Atrasada há 1 dia" : "Atrasada há " + -diff + " dias",
        diff: diff,
      };
    }
    if (diff === 0) return { kind: "today", label: label, hint: "Vence hoje", diff: diff };
    if (diff === 1) return { kind: "soon", label: label, hint: "Vence amanhã", diff: diff };
    if (diff <= 7) return { kind: "soon", label: label, hint: "Vence em " + diff + " dias", diff: diff };
    return { kind: "later", label: label, hint: "", diff: diff };
  }

  function extractUpdated(texts) {
    for (var i = 0; i < texts.length; i++) {
      var match = /atualizado em\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i.exec(String(texts[i] || ""));
      if (match) return match[1];
    }
    return "";
  }

  function parseDemands(table, options) {
    var matrix = tableMatrix(table);
    var headerIndex = findHeaderIndex(matrix);
    if (headerIndex < 0) {
      return { items: [], headerFound: false, updated: extractUpdated(matrix.flat ? matrix.flat() : flatten(matrix)) };
    }
    var headers = matrix[headerIndex];
    var demandaCol = columnIndex(headers, function (label) {
      return label === "demanda" || label.endsWith(" demanda");
    });
    var statusCol = columnIndex(headers, function (label) {
      return label === "situacao" || label.indexOf("situacao") !== -1;
    });
    var dueCol = columnIndex(headers, function (label) {
      return label.indexOf("conclus") !== -1;
    });
    var nextCol = columnIndex(headers, function (label) {
      return label.indexOf("proximo") !== -1;
    });
    var registeredCol = columnIndex(headers, function (label) {
      return label === "registro" || label.indexOf("registro") === 0;
    });
    var idCol = columnIndex(headers, function (label) {
      return isIdHeader(label);
    }, { allowLong: true });
    if (idCol < 0 && demandaCol > 0) idCol = demandaCol - 1;
    var today = options && options.today;
    var items = [];
    for (var r = headerIndex + 1; r < matrix.length; r++) {
      var row = matrix[r];
      if (!row || row.every(function (cell) { return !String(cell || "").trim(); })) continue;
      var id = idCol >= 0 ? String(row[idCol] || "").trim() : "";
      var title = demandaCol >= 0 ? String(row[demandaCol] || "").trim() : "";
      var status = statusCol >= 0 ? String(row[statusCol] || "").trim() : "";
      if (!id && !title) continue;
      if (fold(title) === "demanda" || fold(id) === "id") continue;
      if (id.length > 40) continue;
      if (!title) continue;
      var dueRaw = dueCol >= 0 ? String(row[dueCol] || "").trim() : "";
      items.push({
        id: id,
        title: title,
        status: status || "Sem situação",
        dueRaw: dueRaw,
        due: classifyDue(dueRaw, today),
        next: nextCol >= 0 ? String(row[nextCol] || "").trim() : "",
        registered: registeredCol >= 0 ? String(row[registeredCol] || "").trim() : "",
        closed: isClosed(status),
        order: items.length,
      });
    }
    return {
      items: items,
      headerFound: true,
      updated: extractUpdated(headers),
    };
  }

  function flatten(matrix) {
    var out = [];
    for (var i = 0; i < matrix.length; i++) out = out.concat(matrix[i]);
    return out;
  }

  function valueAfter(row, index) {
    for (var i = index + 1; i < row.length; i++) {
      if (String(row[i] || "").trim()) return String(row[i]).trim();
    }
    return "";
  }

  function parseSummary(table) {
    var matrix = tableMatrix(table);
    var specs = [
      ["updated", function (label) { return label === "atualizado em"; }],
      ["credits", function (label) { return label.indexOf("creditos estimados") !== -1; }],
      ["franchise", function (label) { return label.indexOf("franquia") !== -1; }],
      ["changes", function (label) { return label.indexOf("alteracoes consolidadas") !== -1; }],
      ["pending", function (label) { return label.indexOf("pendencias") !== -1; }],
      ["fixes", function (label) { return label.indexOf("correcoes") !== -1; }],
    ];
    var summary = {};
    for (var r = 0; r < matrix.length; r++) {
      var row = matrix[r];
      for (var c = 0; c < row.length; c++) {
        var label = fold(row[c]);
        if (!label) continue;
        for (var s = 0; s < specs.length; s++) {
          var key = specs[s][0];
          if (summary[key] || !specs[s][1](label)) continue;
          var value = valueAfter(row, c);
          if (value) summary[key] = value;
        }
      }
    }
    if (!summary.updated) summary.updated = extractUpdated(flatten(matrix));
    return summary;
  }

  function urgency(item) {
    var due = item.due || { kind: "empty" };
    if (due.kind === "overdue") return [0, due.diff || 0];
    if (due.kind === "today") return [1, 0];
    if (due.kind === "soon") return [2, due.diff || 0];
    if (due.kind === "later") return [3, due.diff || 0];
    if (due.kind === "confirm") return [4, 0];
    if (due.kind === "missing") return [5, 0];
    return [6, 0];
  }

  function sortActive(items) {
    return items
      .map(function (item, index) { return { item: item, index: index }; })
      .sort(function (a, b) {
        var ua = urgency(a.item);
        var ub = urgency(b.item);
        if (ua[0] !== ub[0]) return ua[0] - ub[0];
        if (ua[1] !== ub[1]) return ua[1] - ub[1];
        return a.item.order - b.item.order || a.index - b.index;
      })
      .map(function (entry) { return entry.item; });
  }

  function matchesQuery(item, query) {
    if (!query) return true;
    var haystack = fold([
      item.id,
      item.title,
      item.status,
      item.next,
      item.dueRaw,
      item.due && item.due.label,
      item.due && item.due.hint,
      item.registered,
    ].join(" "));
    return haystack.indexOf(query) !== -1;
  }

  function filterItems(items, filter, query) {
    var foldedQuery = fold(query || "");
    var list = items.filter(function (item) {
      if (filter === "ativas" && item.closed) return false;
      if (filter === "concluidas" && !item.closed) return false;
      return matchesQuery(item, foldedQuery);
    });
    if (filter === "concluidas") return list.slice();
    var open = [];
    var closed = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].closed) closed.push(list[i]);
      else open.push(list[i]);
    }
    return sortActive(open).concat(closed);
  }

  function counts(items) {
    var closed = 0;
    for (var i = 0; i < items.length; i++) if (items[i].closed) closed += 1;
    return { active: items.length - closed, closed: closed, all: items.length };
  }

  function reclassify(items, today) {
    return items.map(function (item) {
      var copy = {};
      for (var key in item) copy[key] = item[key];
      copy.due = classifyDue(item.dueRaw, today);
      copy.closed = isClosed(item.status);
      return copy;
    });
  }

  return {
    fold: fold,
    cellText: cellText,
    parseDemands: parseDemands,
    parseSummary: parseSummary,
    classifyDue: classifyDue,
    isClosed: isClosed,
    filterItems: filterItems,
    counts: counts,
    reclassify: reclassify,
    saoPauloToday: saoPauloToday,
  };
});
