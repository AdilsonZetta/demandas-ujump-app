const assert = require("assert");
const L = require("../logic.js");

const TODAY = new Date(2026, 10, 26);

function row(values) {
  return { c: values.map(function (value) { return value == null || value === "" ? null : { v: value }; }) };
}

function testClassify() {
  assert.strictEqual(L.classifyDue("A confirmar", TODAY).kind, "confirm");
  assert.strictEqual(L.classifyDue("Não informada", TODAY).kind, "missing");
  assert.strictEqual(L.classifyDue("", TODAY).kind, "empty");
  const overdue = L.classifyDue("23/11/2026", TODAY);
  assert.strictEqual(overdue.kind, "overdue");
  assert.strictEqual(overdue.hint, "Atrasada há 3 dias");
  assert.strictEqual(L.classifyDue("26/11/2026", TODAY).kind, "today");
  assert.strictEqual(L.classifyDue("27/11/2026", TODAY).hint, "Vence amanhã");
  assert.strictEqual(L.classifyDue("02/12/2026", TODAY).kind, "soon");
  assert.strictEqual(L.classifyDue("20/12/2026", TODAY).kind, "later");
  assert.strictEqual(L.isClosed("Concluído"), true);
  assert.strictEqual(L.isClosed("A fazer"), false);
  assert.strictEqual(L.isClosed("Não concluído"), false);
  assert.strictEqual(L.isClosed("Em andamento"), false);
  assert.strictEqual(L.cellText({ v: "Date(2026,10,26)", f: "26/11/2026" }), "26/11/2026");
}

function testHeaderAndBlanks() {
  const table = {
    cols: [
      { label: "" },
      { label: "Acompanhamento de demandas | Eventos UJUMP Atualizado em 26/11/2026 • As datas de conclusão ficam a confirmar. ID" },
      { label: "Demanda" },
      { label: "Situação" },
      { label: "Data de conclusão" },
      { label: "Próximo passo" },
      { label: "Registro" },
    ],
    rows: [
      row(["", "P-10", "Demanda atrasada", "A fazer", "20/11/2026", "Ligar", "26/11/2026"]),
      row(["", "", "", "", "", "", ""]),
      row(["", "P-11", "Demanda a confirmar", "Em andamento", "A confirmar", "Esperar", "26/11/2026"]),
      row(["", "ID", "Demanda", "Situação", "Data de conclusão", "Próximo passo", "Registro"]),
      row(["", "P-01", "Já feita", "Concluído", "Não informada", "", "25/11/2026"]),
    ],
  };
  const parsed = L.parseDemands(table, { today: TODAY });
  assert.strictEqual(parsed.headerFound, true);
  assert.strictEqual(parsed.updated, "26/11/2026");
  assert.strictEqual(parsed.items.length, 3);
  assert.strictEqual(parsed.items[0].id, "P-10");
  assert.strictEqual(parsed.items[0].due.kind, "overdue");
  assert.strictEqual(parsed.items[1].status, "Em andamento");
  assert.strictEqual(parsed.items[2].closed, true);
  const active = L.filterItems(parsed.items, "ativas", "");
  assert.deepStrictEqual(active.map(function (item) { return item.id; }), ["P-10", "P-11"]);
  const done = L.filterItems(parsed.items, "concluidas", "");
  assert.deepStrictEqual(done.map(function (item) { return item.id; }), ["P-01"]);
  const found = L.filterItems(parsed.items, "todas", "ligar");
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].id, "P-10");
}

function testTitleRowBeforeHeaders() {
  const table = {
    cols: [{ label: "" }, { label: "" }, { label: "" }, { label: "" }, { label: "" }, { label: "" }, { label: "" }],
    rows: [
      row(["", "Controle geral sem colunas", "", "", "", "", ""]),
      row(["", "ID", "Demanda", "Situação", "Data de conclusão", "Próximo passo", "Registro"]),
      row(["", "P-09", "Demanda real", "A fazer", "28/11/2026", "Fazer X", "26/11/2026"]),
    ],
  };
  const parsed = L.parseDemands(table, { today: TODAY });
  assert.strictEqual(parsed.items.length, 1);
  assert.strictEqual(parsed.items[0].id, "P-09");
  assert.strictEqual(parsed.items[0].due.kind, "soon");
  assert.strictEqual(parsed.items[0].due.hint, "Vence em 2 dias");
}

function testSummary() {
  const table = {
    cols: [{ label: "" }, { label: "" }, { label: "" }, { label: "" }, { label: "" }, { label: "" }, { label: "" }],
    rows: [
      row(["", "Controle de créditos UJUMP", "", "", "", "", ""]),
      row(["", "Grupo Zetta | Eventos UJUMP", "", "", "Atualizado em", "26/11/2026", ""]),
      row(["", "Créditos estimados por complexidade", "11", "", "Pequeno", "1", ""]),
      row(["", "Franquia por ciclo (referência)", "30", "", "", "", ""]),
      row(["", "", "", "", "Alterações consolidadas", "9", ""]),
      row(["", "", "", "", "Pendências em acompanhamento", "29", ""]),
      row(["", "", "", "", "Correções entre as realizadas", "3", ""]),
    ],
  };
  const summary = L.parseSummary(table);
  assert.strictEqual(summary.updated, "26/11/2026");
  assert.strictEqual(summary.credits, "11");
  assert.strictEqual(summary.franchise, "30");
  assert.strictEqual(summary.changes, "9");
  assert.strictEqual(summary.pending, "29");
  assert.strictEqual(summary.fixes, "3");
}

async function testLiveSheet() {
  const base = "https://docs.google.com/spreadsheets/d/1ShHyseBI4PANomqr2oaHipg-GZYTsfbM4gBuggFmeZ4/gviz/tq?tqx=out:json;responseHandler:cb&sheet=";
  async function load(name) {
    const response = await fetch(base + encodeURIComponent(name));
    const raw = await response.text();
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    return JSON.parse(raw.slice(start, end + 1)).table;
  }
  const [resumo, acomp] = await Promise.all([load("Resumo"), load("Acompanhamento")]);
  const summary = L.parseSummary(resumo);
  const parsed = L.parseDemands(acomp, { today: TODAY });
  assert.strictEqual(summary.pending, "29");
  assert.strictEqual(summary.changes, "9");
  assert.strictEqual(summary.updated, "26/11/2026");
  assert.strictEqual(parsed.headerFound, true);
  const totals = L.counts(parsed.items);
  assert.strictEqual(totals.active, 29, "ativas na aba Acompanhamento");
  assert.strictEqual(totals.closed, 4, "concluídas na aba Acompanhamento");
  assert.strictEqual(parsed.items[0].id, "P-05");
  assert.strictEqual(parsed.items[0].due.kind, "confirm");
  assert.ok(parsed.items[0].next.length > 20);
  assert.strictEqual(parsed.items[0].title.indexOf("bilheteria") !== -1, true);
  const active = L.filterItems(parsed.items, "ativas", "instagram");
  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0].id, "P-11");
}

(async function main() {
  testClassify();
  testHeaderAndBlanks();
  testTitleRowBeforeHeaders();
  testSummary();
  await testLiveSheet();
  console.log("logic tests ok");
})().catch(function (error) {
  console.error(error);
  process.exit(1);
});
