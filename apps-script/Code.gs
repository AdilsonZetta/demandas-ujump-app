/**
 * Aprovação das solicitações UJUMP.
 * Cole este arquivo no Apps Script ligado à planilha.
 * A função setupSolicitacoes cria a aba. O app da web grava aprovação e recusa.
 */
var REQUEST_SHEET = "Solicitações";
var TRACKING_SHEET = "Acompanhamento";
var STATUS_PENDING = "Aguardando aprovação";
var STATUS_APPROVED = "Aprovada";
var STATUS_REJECTED = "Recusada";
var REQUEST_HEADERS = [
  "ID",
  "Data do pedido",
  "Solicitante",
  "Demanda",
  "Descrição",
  "Status",
  "Aprovado por",
  "Data da decisão",
  "Observação",
  "Item criado",
];

function setupSolicitacoes() {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(REQUEST_SHEET);
  if (!sheet) sheet = ss.insertSheet(REQUEST_SHEET);
  ensureRequestHeaders_(sheet);
  formatRequestSheet_(sheet);
  ensureExampleRequest_(sheet);
  SpreadsheetApp.flush();
  return "Aba " + REQUEST_SHEET + " pronta.";
}

function ensureExampleRequest_(sheet) {
  var map = requestMap_(sheet);
  var last = sheet.getLastRow();
  if (last >= 2) {
    var ids = sheet.getRange(2, map.id, last - 1, 1).getDisplayValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0] || "").trim()) return;
    }
  }
  var row = Math.max(last, 1) + 1;
  if (map.id) sheet.getRange(row, map.id).setValue("S-01");
  if (map.asked) sheet.getRange(row, map.asked).setValue(today_()).setNumberFormat("dd/MM/yyyy");
  if (map.person) sheet.getRange(row, map.person).setValue("Fred");
  if (map.title) sheet.getRange(row, map.title).setValue("Demanda de exemplo para teste");
  if (map.detail) sheet.getRange(row, map.detail).setValue("Pedido de exemplo para testar a aprovação no celular.");
  if (map.status) sheet.getRange(row, map.status).setValue(STATUS_PENDING);
}

function doGet(e) {
  return handle_((e && e.parameter) || {}, e && e.parameter && e.parameter.callback);
}

function doPost(e) {
  var data = {};
  try {
    data = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    data = {};
  }
  var params = (e && e.parameter) || {};
  Object.keys(params).forEach(function (key) {
    if (data[key] == null || data[key] === "") data[key] = params[key];
  });
  return handle_(data, data.callback || params.callback);
}

function handle_(data, callback) {
  var action = String((data && data.action) || "health");
  try {
    if (action === "health") {
      return respond_({ ok: true, ready: pinConfigured_() }, callback);
    }
    if (action !== "approve" && action !== "reject") {
      return respond_({ ok: false, error: "Ação desconhecida." }, callback);
    }
    assertPin_(data.pin);
    var result = action === "approve" ? approve_(data) : reject_(data);
    return respond_(result, callback);
  } catch (err) {
    return respond_({
      ok: false,
      error: String((err && err.message) || err),
      code: (err && err.code) || "error",
    }, callback);
  }
}

function onEdit(e) {
  if (!e || !e.range) return;
  var sheet = e.range.getSheet();
  if (sheet.getName() !== REQUEST_SHEET) return;
  var start = e.range.getRow();
  var count = e.range.getNumRows();
  if (start === 1 && count === 1) return;
  for (var row = start; row < start + count; row++) {
    if (row > 1) fillNewRequestRow_(sheet, row);
  }
}

function approve_(data) {
  return withLock_(function () {
    var sheet = requestsSheet_();
    var map = requestMap_(sheet);
    var found = findRequestRow_(sheet, map, data.id);
    var comment = cleanText_(data.comment, 2000);
    var name = cleanText_(data.name, 80);
    var created = map.created ? String(sheet.getRange(found.row, map.created).getDisplayValue() || "").trim() : "";
    var status = fold_(sheet.getRange(found.row, map.status).getDisplayValue());
    if (status.indexOf("aprov") !== -1 && created) {
      return { ok: true, id: found.id, status: STATUS_APPROVED, itemId: created, already: true };
    }
    var itemId = created || appendTrackingItem_(found.values, comment);
    sheet.getRange(found.row, map.status).setValue(STATUS_APPROVED);
    if (map.by) sheet.getRange(found.row, map.by).setValue(name);
    if (map.decision) {
      sheet.getRange(found.row, map.decision).setValue(today_()).setNumberFormat("dd/MM/yyyy");
    }
    if (map.note && comment) {
      var previous = String(sheet.getRange(found.row, map.note).getDisplayValue() || "").trim();
      sheet.getRange(found.row, map.note).setValue(previous ? previous + "\n" + comment : comment);
    }
    if (map.created) sheet.getRange(found.row, map.created).setValue(itemId);
    return { ok: true, id: found.id, status: STATUS_APPROVED, itemId: itemId };
  });
}

function reject_(data) {
  return withLock_(function () {
    var sheet = requestsSheet_();
    var map = requestMap_(sheet);
    var found = findRequestRow_(sheet, map, data.id);
    var status = fold_(sheet.getRange(found.row, map.status).getDisplayValue());
    var created = map.created ? String(sheet.getRange(found.row, map.created).getDisplayValue() || "").trim() : "";
    if (status.indexOf("aprov") !== -1 || created) {
      fail_("Este pedido já foi aprovado" + (created ? " e virou " + created : "") + ". Ajuste a planilha se precisar desfazer.", "already-approved");
    }
    var comment = cleanText_(data.comment, 2000);
    var name = cleanText_(data.name, 80);
    sheet.getRange(found.row, map.status).setValue(STATUS_REJECTED);
    if (map.by) sheet.getRange(found.row, map.by).setValue(name);
    if (map.decision) {
      sheet.getRange(found.row, map.decision).setValue(today_()).setNumberFormat("dd/MM/yyyy");
    }
    if (map.note && comment) {
      var previous = String(sheet.getRange(found.row, map.note).getDisplayValue() || "").trim();
      sheet.getRange(found.row, map.note).setValue(previous ? previous + "\n" + comment : comment);
    }
    return { ok: true, id: found.id, status: STATUS_REJECTED };
  });
}

function appendTrackingItem_(request, comment) {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(TRACKING_SHEET);
  if (!sheet) fail_("Não encontrei a aba Acompanhamento.", "sheet");
  var headerRow = findTrackingHeaderRow_(sheet);
  var headers = sheet.getRange(headerRow, 1, 1, Math.max(sheet.getLastColumn(), 7)).getDisplayValues()[0];
  var demandaCol = columnBy_(headers, function (label) { return label === "demanda" || endsWith_(label, " demanda"); });
  if (!demandaCol) fail_("Não encontrei a coluna Demanda em Acompanhamento.", "format");
  var idCol = findIdColumn_(headers, demandaCol);
  var statusCol = columnBy_(headers, function (label) { return label === "situacao" || label.indexOf("situacao") !== -1; });
  var dueCol = columnBy_(headers, function (label) { return label.indexOf("conclus") !== -1; });
  var nextCol = columnBy_(headers, function (label) { return label.indexOf("proximo") !== -1; });
  var registroCol = columnBy_(headers, function (label) { return label === "registro" || label.indexOf("registro") === 0; });
  var itemId = nextTrackingId_(sheet, idCol, headerRow);
  sheet.insertRowAfter(headerRow);
  var row = headerRow + 1;
  var width = Math.max(sheet.getLastColumn(), registroCol || 7, idCol);
  sheet.getRange(row, 1, 1, width).clearFormat().clearDataValidations();
  sheet.getRange(row, 1, 1, width).setFontWeight("normal").setFontColor("#1a2420").setBackground(null);
  if (idCol) sheet.getRange(row, idCol).setValue(itemId);
  if (demandaCol) sheet.getRange(row, demandaCol).setValue(request.title);
  if (statusCol) sheet.getRange(row, statusCol).setValue("A fazer");
  if (dueCol) sheet.getRange(row, dueCol).clearContent();
  if (nextCol) sheet.getRange(row, nextCol).setValue(nextStepText_(request, comment));
  if (registroCol) sheet.getRange(row, registroCol).setValue(today_()).setNumberFormat("dd/MM/yyyy");
  return itemId;
}

function nextStepText_(request, comment) {
  var lines = [];
  if (request.person) lines.push("Pedido de " + request.person + " (" + request.id + ").");
  else lines.push("Pedido " + request.id + ".");
  if (request.detail) lines.push(request.detail);
  if (comment) lines.push("Na aprovação: " + comment);
  return lines.join("\n");
}

function nextTrackingId_(sheet, idCol, headerRow) {
  var last = Math.max(sheet.getLastRow(), headerRow);
  var values = sheet.getRange(headerRow + 1, idCol, Math.max(last - headerRow, 1), 1).getDisplayValues();
  var max = 0;
  values.forEach(function (row) {
    var match = /^P-(\d+)$/i.exec(String(row[0] || "").trim());
    if (match) max = Math.max(max, Number(match[1]));
  });
  return formatCode_("P", max + 1);
}

function requestsSheet_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(REQUEST_SHEET);
  if (!sheet) fail_("A aba Solicitações não existe. Execute setupSolicitacoes.", "sheet");
  return sheet;
}

function ensureRequestHeaders_(sheet) {
  var width = Math.max(sheet.getLastColumn(), REQUEST_HEADERS.length);
  var current = sheet.getRange(1, 1, 1, width).getDisplayValues()[0];
  var blank = current.join("").trim() === "";
  if (blank) {
    sheet.getRange(1, 1, 1, REQUEST_HEADERS.length).setValues([REQUEST_HEADERS]);
    return;
  }
  var have = {};
  current.forEach(function (value) { have[fold_(value)] = true; });
  REQUEST_HEADERS.forEach(function (header) {
    if (have[fold_(header)]) return;
    var col = sheet.getLastColumn() + 1;
    sheet.getRange(1, col).setValue(header);
    have[fold_(header)] = true;
  });
}

function requestMap_(sheet) {
  var headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), REQUEST_HEADERS.length)).getDisplayValues()[0];
  function col(test) {
    for (var i = 0; i < headers.length; i++) if (test(fold_(headers[i]))) return i + 1;
    return 0;
  }
  var map = {
    id: col(function (label) { return label === "id"; }),
    asked: col(function (label) { return label.indexOf("data do pedido") !== -1; }),
    person: col(function (label) { return label.indexOf("solicitante") !== -1; }),
    title: col(function (label) { return label === "demanda"; }),
    detail: col(function (label) { return label.indexOf("descricao") !== -1; }),
    status: col(function (label) { return label === "status"; }),
    by: col(function (label) { return label.indexOf("aprovado por") !== -1; }),
    decision: col(function (label) { return label.indexOf("data da decisao") !== -1; }),
    note: col(function (label) { return label.indexOf("observacao") !== -1; }),
    created: col(function (label) { return label.indexOf("item criado") !== -1; }),
  };
  if (!map.id || !map.title || !map.status) {
    fail_("A aba Solicitações não tem as colunas ID, Demanda e Status. Execute setupSolicitacoes.", "format");
  }
  return map;
}

function findRequestRow_(sheet, map, rawId) {
  var id = String(rawId || "").trim();
  if (!/^S-\d+$/i.test(id)) fail_("Informe um ID no formato S-01.", "id");
  var last = sheet.getLastRow();
  if (last < 2) fail_("Não há pedidos na aba Solicitações.", "missing");
  var values = sheet.getRange(2, 1, last - 1, Math.max(sheet.getLastColumn(), 1)).getDisplayValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][map.id - 1] || "").trim().toUpperCase() === id.toUpperCase()) {
      return {
        row: i + 2,
        id: String(values[i][map.id - 1]).trim(),
        values: {
          id: String(values[i][map.id - 1]).trim(),
          person: map.person ? String(values[i][map.person - 1] || "").trim() : "",
          title: map.title ? String(values[i][map.title - 1] || "").trim() : "",
          detail: map.detail ? String(values[i][map.detail - 1] || "").trim() : "",
        },
      };
    }
  }
  fail_("Não encontrei o pedido " + id + ".", "missing");
}

function fillNewRequestRow_(sheet, row) {
  var map;
  try { map = requestMap_(sheet); } catch (err) { return; }
  var title = map.title ? sheet.getRange(row, map.title).getDisplayValue() : "";
  var person = map.person ? sheet.getRange(row, map.person).getDisplayValue() : "";
  if (!String(title || "").trim() && !String(person || "").trim()) return;
  if (map.id && !String(sheet.getRange(row, map.id).getDisplayValue() || "").trim()) {
    sheet.getRange(row, map.id).setValue(nextRequestId_(sheet, map.id));
  }
  if (map.asked && !sheet.getRange(row, map.asked).getValue()) {
    sheet.getRange(row, map.asked).setValue(today_()).setNumberFormat("dd/MM/yyyy");
  }
  if (map.status && !String(sheet.getRange(row, map.status).getDisplayValue() || "").trim()) {
    sheet.getRange(row, map.status).setValue(STATUS_PENDING);
  }
}

function nextRequestId_(sheet, idCol) {
  var last = Math.max(sheet.getLastRow(), 1);
  var values = sheet.getRange(1, idCol, last, 1).getDisplayValues();
  var max = 0;
  values.forEach(function (row) {
    var match = /^S-(\d+)$/i.exec(String(row[0] || "").trim());
    if (match) max = Math.max(max, Number(match[1]));
  });
  return formatCode_("S", max + 1);
}

function formatRequestSheet_(sheet) {
  var map = requestMap_(sheet);
  var header = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), REQUEST_HEADERS.length));
  header.setBackground("#1b4332").setFontColor("#ffffff").setFontWeight("bold").setWrap(true);
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 32);
  var bodyRows = Math.max(1, Math.min(500, sheet.getMaxRows() - 1));
  if (map.asked) sheet.getRange(2, map.asked, bodyRows, 1).setNumberFormat("dd/MM/yyyy");
  if (map.decision) sheet.getRange(2, map.decision, bodyRows, 1).setNumberFormat("dd/MM/yyyy");
  [map.detail, map.note, map.title].forEach(function (col) {
    if (col) sheet.getRange(2, col, bodyRows, 1).setWrap(true);
  });
  var widths = {};
  widths[map.id] = 80;
  widths[map.asked] = 130;
  widths[map.person] = 150;
  widths[map.title] = 280;
  widths[map.detail] = 340;
  widths[map.status] = 190;
  widths[map.by] = 150;
  widths[map.decision] = 140;
  widths[map.note] = 280;
  widths[map.created] = 120;
  Object.keys(widths).forEach(function (col) {
    if (Number(col) > 0 && widths[col]) sheet.setColumnWidth(Number(col), widths[col]);
  });
  if (map.status) {
    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList([STATUS_PENDING, STATUS_APPROVED, STATUS_REJECTED], true)
      .setAllowInvalid(true)
      .build();
    sheet.getRange(2, map.status, bodyRows, 1).setDataValidation(rule);
    applyStatusColors_(sheet, map.status, bodyRows);
  }
}

function applyStatusColors_(sheet, statusCol, bodyRows) {
  var range = sheet.getRange(2, statusCol, bodyRows, 1);
  var rules = sheet.getConditionalFormatRules().filter(function (rule) {
    var ranges = rule.getRanges();
    return !ranges.some(function (item) { return item.getColumn() === statusCol; });
  });
  function when(text, background, color) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(text)
      .setBackground(background)
      .setFontColor(color)
      .setRanges([range])
      .build();
  }
  rules.push(when(STATUS_PENDING, "#fff4e8", "#9a4d12"));
  rules.push(when(STATUS_APPROVED, "#e7f3ec", "#145c3a"));
  rules.push(when(STATUS_REJECTED, "#fdecec", "#9f1d1d"));
  sheet.setConditionalFormatRules(rules);
}

function findTrackingHeaderRow_(sheet) {
  var rows = Math.min(Math.max(sheet.getLastRow(), 1), 8);
  var cols = Math.max(sheet.getLastColumn(), 7);
  var values = sheet.getRange(1, 1, rows, cols).getDisplayValues();
  for (var r = 0; r < values.length; r++) {
    for (var c = 0; c < values[r].length; c++) {
      var label = fold_(values[r][c]);
      if (label === "demanda" || endsWith_(label, " demanda")) return r + 1;
    }
  }
  fail_("Não encontrei o cabeçalho de Acompanhamento.", "format");
}

function columnBy_(headers, test) {
  var found = 0;
  var best = 9999;
  for (var i = 0; i < headers.length; i++) {
    var label = fold_(headers[i]);
    if (!label || !test(label)) continue;
    if (isIdHeader_(label) || label.length > 48) continue;
    if (label.length < best) {
      best = label.length;
      found = i + 1;
    }
  }
  return found;
}

function findIdColumn_(headers, demandaCol) {
  var exact = 0;
  var suffix = 0;
  for (var i = 0; i < headers.length; i++) {
    var label = fold_(headers[i]);
    if (label === "id") exact = i + 1;
    else if (isIdHeader_(label)) suffix = i + 1;
  }
  if (exact) return exact;
  if (suffix) return suffix;
  return demandaCol > 1 ? demandaCol - 1 : 1;
}

function isIdHeader_(label) {
  return /(^|\s)id$/.test(label);
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function pinConfigured_() {
  return !!PropertiesService.getScriptProperties().getProperty("APPROVAL_PIN");
}

function assertPin_(pin) {
  var expected = PropertiesService.getScriptProperties().getProperty("APPROVAL_PIN");
  if (!expected) fail_("O PIN de aprovação ainda não foi configurado nas propriedades do script.", "pin-missing");
  if (String(pin || "") !== String(expected)) fail_("PIN incorreto.", "pin");
}

function today_() {
  var zone = Session.getScriptTimeZone() || "America/Sao_Paulo";
  var parts = Utilities.formatDate(new Date(), zone, "yyyy-MM-dd").split("-");
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

function formatCode_(prefix, number) {
  var text = String(number);
  if (number < 100) text = ("0" + text).slice(-2);
  return prefix + "-" + text;
}

function cleanText_(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function fold_(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function endsWith_(text, suffix) {
  return text.length >= suffix.length && text.substring(text.length - suffix.length) === suffix;
}

function fail_(message, code) {
  var error = new Error(message);
  error.code = code || "error";
  throw error;
}

function respond_(payload, callback) {
  var body = JSON.stringify(payload);
  if (callback && /^[A-Za-z_$][\w$]*$/.test(String(callback))) {
    return ContentService.createTextOutput(callback + "(" + body + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}
