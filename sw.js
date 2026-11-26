/* App shell + planilha.
   A planilha pública não envia CORS. O app carrega o gviz como script.
   Rede primeiro: com internet, a resposta nova segue para a página.
   Sem rede, devolve o último script confirmado e, se faltar, o modelo salvo. */
var SHELL_CACHE = "ujump-shell-v2";
var DATA_CACHE = "ujump-data-v1";
var SHELL_FILES = [
  "index.html",
  "styles.css",
  "logic.js",
  "app.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-192.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
];

var pendingSheets = Object.create(null);

function abs(path) {
  return new URL(path, self.location).href;
}

function isSheetRequest(url) {
  return url.hostname === "docs.google.com" && url.pathname.indexOf("/spreadsheets/") !== -1 && url.pathname.endsWith("/gviz/tq");
}

function sheetCacheKey(requestUrl) {
  var url = new URL(requestUrl);
  url.searchParams.delete("t");
  url.searchParams.delete("_");
  return url.toString();
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      return Promise.all(
        SHELL_FILES.map(function (path) {
          var url = abs(path);
          return fetch(url, { cache: "no-cache" }).then(function (response) {
            if (!response.ok) throw new Error("Falha ao pré-carregar " + path);
            return cache.put(url, response);
          });
        })
      );
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.map(function (key) {
          if (key !== SHELL_CACHE && key !== DATA_CACHE) return caches.delete(key);
          return undefined;
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

function networkFirstSheet(request) {
  var key = sheetCacheKey(request.url);
  var sheet = new URL(request.url).searchParams.get("sheet") || "";
  return fetch(request).then(function (fresh) {
    if (request.destination === "script") {
      pendingSheets[sheet] = { key: key, response: fresh.clone() };
    }
    return fresh;
  }).catch(function () {
    if (request.destination !== "script") {
      return new Response("", { status: 504, statusText: "Offline" });
    }
    return caches.open(DATA_CACHE).then(function (cache) {
      return cache.match(key).then(function (cached) {
        if (cached) return cached;
        return new Response("", { status: 504, statusText: "Offline" });
      });
    });
  });
}

function isShellPath(url) {
  if (url.origin !== self.location.origin) return false;
  var shellPrefix = new URL("./", self.location).pathname;
  return url.pathname.indexOf(shellPrefix) === 0;
}

function networkFirstShell(request) {
  var cacheRequest = request;
  return fetch(request).then(function (fresh) {
    if (fresh && fresh.ok && !fresh.redirected) {
      var copy = fresh.clone();
      caches.open(SHELL_CACHE).then(function (cache) {
        return cache.put(cacheRequest, copy);
      });
    }
    return fresh;
  }).catch(function () {
    return caches.open(SHELL_CACHE).then(function (cache) {
      return cache.match(request).then(function (cached) {
        if (cached) return cached;
        if (request.mode === "navigate") return cache.match(abs("index.html"));
        return new Response("", { status: 504, statusText: "Offline" });
      });
    });
  });
}

self.addEventListener("fetch", function (event) {
  var url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (url.pathname.endsWith("/sw.js")) return;
  if (url.pathname.endsWith("/offline-model.json")) {
    event.respondWith(
      caches.open(DATA_CACHE).then(function (cache) {
        return cache.match(abs("offline-model.json")).then(function (cached) {
          return cached || new Response("", { status: 404 });
        });
      })
    );
    return;
  }
  if (isSheetRequest(url)) {
    event.respondWith(networkFirstSheet(event.request));
    return;
  }
  if (isShellPath(url)) {
    event.respondWith(networkFirstShell(event.request));
  }
});

self.addEventListener("message", function (event) {
  var data = event.data || {};
  if (data.type === "commit-sheet") {
    var pending = pendingSheets[data.sheet || ""];
    delete pendingSheets[data.sheet || ""];
    if (!pending) return;
    event.waitUntil(
      caches.open(DATA_CACHE).then(function (cache) {
        return cache.put(pending.key, pending.response);
      })
    );
    return;
  }
  if (data.type === "discard-sheet") {
    delete pendingSheets[data.sheet || ""];
    return;
  }
  if (data.type === "store-model") {
    event.waitUntil(
      caches.open(DATA_CACHE).then(function (cache) {
        return cache.put(
          abs("offline-model.json"),
          new Response(JSON.stringify(data.model), {
            headers: { "Content-Type": "application/json" },
          })
        );
      })
    );
  }
});
