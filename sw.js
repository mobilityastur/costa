// Service worker: permite instalar la app y ver la última consulta sin cobertura.
// Siempre intenta la red primero (para no quedarse con versiones viejas) y,
// si no hay conexión, sirve lo último guardado.
const CACHE = "costa-v1";
const BASE = ["./", "index.html", "app.css", "app.js", "manifest.webmanifest", "icono.svg", "icono-192.png"];
const DATOS = "https://raw.githubusercontent.com/mobilityastur/costa/datos/estado.json";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(BASE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const esDatos = url.href.startsWith(DATOS);
  const propio = url.origin === self.location.origin;
  if (!propio && !esDatos) return; // cámaras, mapa y fuentes: directo a la red
  const clave = esDatos ? DATOS : req;
  e.respondWith(
    // "no-cache": pregunta siempre al servidor si hay versión nueva (GitHub Pages deja 10 min de caché)
    fetch(req, { cache: "no-cache" })
      .then((res) => {
        if (res.ok) {
          const copia = res.clone();
          caches.open(CACHE).then((c) => c.put(clave, copia));
        }
        return res;
      })
      .catch(() => caches.match(clave, { ignoreSearch: true })
        .then((r) => r || (req.mode === "navigate" ? caches.match("index.html") : Response.error())))
  );
});
