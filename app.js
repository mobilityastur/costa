"use strict";

// Datos generados por la tarea programada del repo (rama "datos").
const URL_DATOS = location.hostname === "localhost" || location.hostname === "127.0.0.1"
  ? "data/estado.json"
  : "https://raw.githubusercontent.com/mobilityastur/costa/datos/estado.json";
const REFRESCO_MS = 5 * 60 * 1000;
const ESTACION_ZONA = { occidental: "9", central: "6", oriental: "5" }; // Navia, Gijón, Ribadesella

const vista = document.getElementById("vista");
let estado = null;
let mapa = null;
let zona = leer("costa:zona") || "central";
let estacionMareas = leer("costa:estacion") || "6";
let estacionInicio = null;

function leer(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function guardar(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } }

// ---------- utilidades ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v, d = 1) => (v == null || Number.isNaN(v) ? "–" : Number(v).toLocaleString("es-ES", { minimumFractionDigits: d, maximumFractionDigits: d }));
const hhmm = (d) => d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" });
const diaClave = (d) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" }); // AAAA-MM-DD en hora de Madrid
const RUMBOS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO"];
const rumbo = (g) => (g == null ? "" : RUMBOS[Math.round(((g % 360) + 360) % 360 / 22.5) % 16]);
const nivelOla = (h) => (h == null ? 0 : h >= 2.5 ? 2 : h >= 1 ? 1 : 0);
const ICO = {
  aviso: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12c2-2 4-2 6 0s4 2 6 0 4-2 6 0M2 17c2-2 4-2 6 0s4 2 6 0 4-2 6 0M12 3v5"/></svg>',
  flecha: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  atras: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>',
  fuera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4 10 14M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>',
};
const CIELO = { 0: "Despejado", 1: "Poco nuboso", 2: "Nubes y claros", 3: "Cubierto", 45: "Niebla", 48: "Niebla", 51: "Llovizna", 53: "Llovizna", 55: "Llovizna", 56: "Llovizna helada", 57: "Llovizna helada", 61: "Lluvia débil", 63: "Lluvia", 65: "Lluvia fuerte", 66: "Lluvia helada", 67: "Lluvia helada", 71: "Nieve", 73: "Nieve", 75: "Nieve fuerte", 77: "Nieve", 80: "Chubascos", 81: "Chubascos", 82: "Chubascos fuertes", 85: "Chubascos de nieve", 86: "Chubascos de nieve", 95: "Tormenta", 96: "Tormenta con granizo", 99: "Tormenta con granizo" };
const uvTexto = (u) => (u == null ? "" : u < 3 ? "bajo" : u < 6 ? "moderado" : u < 8 ? "alto" : u < 11 ? "muy alto" : "extremo");

function hace(isoStr) {
  if (!isoStr) return "—";
  const min = Math.round((Date.now() - new Date(isoStr)) / 60000);
  if (min < 1) return "ahora mismo";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  return h < 24 ? `hace ${h} h` : `hace ${Math.round(h / 24)} días`;
}
function fmtFecha(isoStr) {
  const d = new Date(isoStr), hoy = new Date(), man = new Date(Date.now() + 86400000);
  const dia = diaClave(d) === diaClave(hoy) ? "hoy" : diaClave(d) === diaClave(man) ? "mañana"
    : d.toLocaleDateString("es-ES", { weekday: "short", day: "numeric", timeZone: "Europe/Madrid" });
  return `${dia} a las ${hhmm(d)}`;
}
function nombreDia(d, corto = false) {
  const k = diaClave(d);
  if (k === diaClave(new Date())) return "Hoy";
  if (k === diaClave(new Date(Date.now() + 86400000))) return "Mañana";
  const s = d.toLocaleDateString("es-ES", { weekday: corto ? "short" : "long", timeZone: "Europe/Madrid" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------- mareas ----------
// Entre dos extremos oficiales, la altura sigue una curva coseno (aproximación habitual).
function alturaEn(extremos, t) {
  for (let i = 0; i < extremos.length - 1; i++) {
    const a = extremos[i], b = extremos[i + 1];
    const ta = new Date(a.t).getTime(), tb = new Date(b.t).getTime();
    if (t >= ta && t <= tb) {
      const f = (t - ta) / (tb - ta);
      return { h: a.h + (b.h - a.h) * (1 - Math.cos(Math.PI * f)) / 2, sube: b.tipo === "pleamar", siguiente: b };
    }
  }
  return null;
}
function inicioDia(d = new Date()) {
  // medianoche de Madrid del día de d
  const k = diaClave(d);
  for (const off of [-1, -2, 0]) {
    const c = new Date(`${k}T00:00:00Z`).getTime() - off * 3600000;
    if (diaClave(new Date(c)) === k && diaClave(new Date(c - 60000)) !== k) return c;
  }
  return new Date(`${k}T00:00:00+01:00`).getTime();
}
function graficoMarea(est, dia = new Date(), conAhora = true) {
  const ext = est.extremos, W = 330, top = 18, bot = 108, max = 5;
  const t0 = inicioDia(dia), t1 = t0 + 86400000;
  const y = (h) => bot - (Math.max(0, h) / max) * (bot - top), x = (t) => ((t - t0) / (t1 - t0)) * W;
  const pts = [];
  for (let t = t0; t <= t1; t += 900000) {
    const r = alturaEn(ext, t);
    if (r) pts.push(`${x(t).toFixed(1)},${y(r.h).toFixed(1)}`);
  }
  if (pts.length < 2) return '<p class="nota">Sin predicción de marea para este día.</p>';
  const linea = "M" + pts.join(" L");
  const area = `${linea} L${pts[pts.length - 1].split(",")[0]},${bot} L${pts[0].split(",")[0]},${bot} Z`;
  const delDia = ext.filter((e) => { const t = new Date(e.t).getTime(); return t >= t0 && t < t1; });
  let marcas = "";
  for (const e of delDia) {
    const px = x(new Date(e.t).getTime()), py = y(e.h), alta = e.tipo === "pleamar";
    const tx = Math.min(Math.max(px - 15, 0), W - 32);
    marcas += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.5" fill="${alta ? "#5EE0D6" : "#C9D6DF"}"></circle>
      <text x="${tx.toFixed(1)}" y="${alta ? py - 7 : py + 15}" font-size="11" fill="${alta ? "#CFF6F2" : "#C9D6DF"}">${hhmm(new Date(e.t))}</text>`;
  }
  let ahora = "";
  const tn = Date.now();
  if (conAhora && tn >= t0 && tn <= t1) {
    const r = alturaEn(ext, tn);
    if (r) ahora = `<line x1="${x(tn).toFixed(1)}" y1="6" x2="${x(tn).toFixed(1)}" y2="${bot}" stroke="#fff" stroke-width="1.5" stroke-dasharray="3 3"></line>
      <circle cx="${x(tn).toFixed(1)}" cy="${y(r.h).toFixed(1)}" r="6" fill="#fff" stroke="#0C1822" stroke-width="2.5"></circle>`;
  }
  const rejilla = [6, 12, 18].map((h) => `<line x1="${W * h / 24}" y1="${top}" x2="${W * h / 24}" y2="${bot}" stroke="#1C3446"></line>`).join("");
  const ejes = [0, 6, 12, 18].map((h) => `<text x="${h ? W * h / 24 - 8 : 0}" y="126" font-size="11" fill="#9FB3C1">${h} h</text>`).join("");
  const desc = delDia.map((e) => `${e.tipo} a las ${hhmm(new Date(e.t))}`).join(", ");
  return `<svg class="grafico" viewBox="0 0 ${W} 130" role="img" aria-label="Curva de marea: ${esc(desc)}" font-family="Barlow, sans-serif">
    <line x1="0" y1="${bot}" x2="${W}" y2="${bot}" stroke="#2A4357"></line>${rejilla}
    <path d="${area}" fill="#5EE0D6" fill-opacity="0.16"></path>
    <path d="${linea}" fill="none" stroke="#5EE0D6" stroke-width="2.5" stroke-linejoin="round"></path>
    ${marcas}${ahora}${ejes}</svg>`;
}
function extremosHoy(est) {
  const t0 = inicioDia(), t1 = t0 + 86400000, tn = Date.now();
  const lista = est.extremos.filter((e) => { const t = new Date(e.t).getTime(); return t >= t0 && t < t1; });
  const prox = est.extremos.find((e) => new Date(e.t).getTime() > tn);
  return `<div class="extremos">${lista.map((e) => `<div class="${e.tipo === "pleamar" ? "" : "baja"} ${prox && e.t === prox.t ? "proximo" : ""}">
    <span>${e.tipo === "pleamar" ? "Pleamar" : "Bajamar"}</span><strong>${hhmm(new Date(e.t))}</strong><em>${num(e.h, 2)} m</em></div>`).join("")}</div>`;
}
function resumenMarea(est) {
  const r = alturaEn(est.extremos, Date.now());
  if (!r) return { titulo: "Sin datos", detalle: "" };
  const s = r.siguiente, mins = Math.round((new Date(s.t) - Date.now()) / 60000);
  const falta = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
  return {
    titulo: `${r.sube ? "Subiendo" : "Bajando"} · ${num(r.h)} m`,
    detalle: `${s.tipo === "pleamar" ? "Pleamar" : "Bajamar"} a las ${hhmm(new Date(s.t))} (${num(s.h, 2)} m), dentro de ${falta}`,
  };
}

// ---------- oleaje ----------
function graficoOleaje(mar) {
  const alt = mar.wave_height || [], dir = mar.wave_direction || [], paso = mar.paso || 3;
  const t0 = new Date(mar.t0).getTime(), W = 330, base = 92, n = alt.length;
  if (!n) return '<p class="nota">Sin previsión de oleaje.</p>';
  const max = Math.max(1.5, ...alt.filter((v) => v != null)) * 1.1;
  const ancho = W / n;
  let barras = "", flechas = "", dias = "", separadores = "";
  alt.forEach((h, i) => {
    if (h == null) return;
    const alto = (h / max) * 74, col = ["#5EE0D6", "#F2B33D", "#F07167"][nivelOla(h)];
    barras += `<rect x="${(i * ancho + 1.5).toFixed(1)}" y="${(base - alto).toFixed(1)}" width="${(ancho - 3).toFixed(1)}" height="${alto.toFixed(1)}" rx="2" fill="${col}"></rect>`;
    if (i % 2 === 0 && dir[i] != null) {
      flechas += `<g transform="translate(${(i * ancho + ancho).toFixed(1)} 108) rotate(${(dir[i] + 180) % 360})"><path d="M0 -6 L0 6 M-3 3 L0 6 L3 3"></path></g>`;
    }
  });
  let prev = null;
  for (let i = 0; i < n; i++) {
    const d = new Date(t0 + i * paso * 3600000), k = diaClave(d);
    if (k !== prev) {
      if (prev) separadores += `<line x1="${(i * ancho).toFixed(1)}" y1="14" x2="${(i * ancho).toFixed(1)}" y2="${base + 4}" stroke="#2A4357"></line>`;
      dias += `<text x="${(i * ancho + 3).toFixed(1)}" y="136" font-size="12" fill="#CFE0EA">${esc(nombreDia(d, true))}</text>`;
      prev = k;
    }
  }
  const y1 = base - (1 / max) * 74;
  return `<svg class="grafico" viewBox="0 0 ${W} 142" role="img" aria-label="Altura de ola cada ${paso} horas durante 3 días, entre ${num(Math.min(...alt))} y ${num(Math.max(...alt))} metros" font-family="Barlow, sans-serif">
    <line x1="0" y1="${base}" x2="${W}" y2="${base}" stroke="#2A4357"></line>
    <line x1="0" y1="${y1.toFixed(1)}" x2="${W}" y2="${y1.toFixed(1)}" stroke="#2A4357" stroke-dasharray="2 4"></line>
    <text x="2" y="${(y1 - 4).toFixed(1)}" font-size="10" fill="#9FB3C1">1 m</text>
    ${separadores}${barras}
    <g stroke="#CFE0EA" stroke-width="1.6" fill="none" stroke-linecap="round">${flechas}</g>${dias}</svg>`;
}
function resumenOleaje(mar) {
  const per = mar.wave_period || [], fondoP = mar.swell_wave_period || [], fondoD = mar.swell_wave_direction || [], alt = mar.wave_height || [];
  const imax = alt.indexOf(Math.max(...alt));
  const partes = [];
  if (imax >= 0) {
    const d = new Date(new Date(mar.t0).getTime() + imax * (mar.paso || 3) * 3600000);
    partes.push(`Máximo de ${num(alt[imax])} m ${nombreDia(d).toLowerCase() === "hoy" ? "hoy" : nombreDia(d).toLowerCase()} hacia las ${hhmm(d)}.`);
  }
  const ifondo = fondoP.findIndex((p) => p != null && p >= 10);
  if (ifondo >= 0) {
    const d = new Date(new Date(mar.t0).getTime() + ifondo * (mar.paso || 3) * 3600000);
    partes.push(`Mar de fondo del ${rumbo(fondoD[ifondo])} con periodo de ${num(fondoP[ifondo], 0)} s desde ${fmtFecha(d.toISOString()).replace(" a las", ",")}.`);
  } else if (per[0] != null) {
    partes.push(`Periodo de ${num(per[0], 0)} s ahora.`);
  }
  return partes.join(" ");
}

// ---------- carga ----------
async function cargar() {
  try {
    const r = await fetch(`${URL_DATOS}?t=${Math.floor(Date.now() / 60000)}`, { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    estado = await r.json();
    guardar("costa:ultimo", JSON.stringify(estado));
  } catch (e) {
    if (!estado) { try { estado = JSON.parse(leer("costa:ultimo") || "null"); } catch (e2) { estado = null; } }
    if (!estado) { vista.innerHTML = '<p class="vacio">No se han podido cargar los datos. Comprueba la conexión y vuelve a intentarlo.</p>'; return; }
  }
  pintar();
}

// ---------- piezas comunes ----------
function cabecera(titulo, extra = "", sub = "") {
  const viejo = !estado.actualizado || Date.now() - new Date(estado.actualizado) > 90 * 60000;
  return `<header class="cabecera">
    <div class="fila"><span class="marca">mobilityastur · Costa</span>${viejo ? '<span class="chip-estado">Datos antiguos</span>' : ""}</div>
    ${extra}<h1 class="${titulo.length > 18 ? "medio" : ""}">${esc(titulo)}</h1>
    ${sub ? `<span class="hora">${sub}</span>` : ""}
    <span class="hora">Actualizado ${hace(estado.actualizado)} · IHM, AEMET y Open-Meteo</span>
  </header>`;
}
function bloqueAvisos(avisos, max = 2, detalle = false) {
  return avisos.slice(0, max).map((a) => `<section class="aviso ${esc(a.nivel)} ${a.ahora ? "" : "previsto"}">${ICO.aviso}
    <div><strong>${a.ahora ? "" : "Previsto: "}Aviso ${esc(a.nivel)} por ${esc((a.fenomeno || "").toLowerCase())}</strong>
    <span>${esc(a.zonaNombre)}, ${a.ahora ? "hasta " + fmtFecha(a.fin) : fmtFecha(a.inicio) + " → " + fmtFecha(a.fin)}.${detalle && a.texto ? " " + esc(a.texto) : ""}</span></div></section>`).join("");
}
const estacion = (id) => estado.mareas?.[id];
const ahoraMar = (l) => ({
  ola: l.mar?.wave_height?.[0], olaDir: l.mar?.wave_direction?.[0], olaPer: l.mar?.wave_period?.[0],
  agua: l.mar?.sea_surface_temperature?.[0], aire: l.tiempo?.temperature_2m?.[0], sens: l.tiempo?.apparent_temperature?.[0],
  viento: l.tiempo?.wind_speed_10m?.[0], vientoDir: l.tiempo?.wind_direction_10m?.[0], racha: l.tiempo?.wind_gusts_10m?.[0],
  cielo: l.tiempo?.weather_code?.[0], uv: l.tiempo?.uv_index?.[0],
});
function pie() {
  return `<p class="fuentes">Mareas: <a href="https://armada.defensa.gob.es/ihm/" target="_blank" rel="noopener">Instituto Hidrográfico de la Marina</a> (horas y alturas oficiales; la curva entre ellas es aproximada) ·
    Avisos y playas: <a href="https://www.aemet.es/" target="_blank" rel="noopener">AEMET</a> ·
    Oleaje y tiempo: <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> (modelos de Météo-France, DWD y ECMWF). El oleaje es un modelo de 5–9 km: orientativo para cada tramo de costa, no para una playa concreta. No sirve para navegar.</p>`;
}

// ---------- vistas ----------
function vistaInicio() {
  const lugares = estado.lugares.filter((l) => l.zona === zona);
  const ids = [...new Set(lugares.map((l) => l.marea))];
  if (!estacionInicio || !ids.includes(estacionInicio)) estacionInicio = ids.includes(ESTACION_ZONA[zona]) ? ESTACION_ZONA[zona] : ids[0];
  const est = estacion(estacionInicio);
  const avisos = (estado.avisos || []).filter((a) => a.zonas.includes(zona));
  const rm = est ? resumenMarea(est) : null;
  let html = cabecera("Costa de Asturias") + bloqueAvisos(avisos) +
    `<nav class="segmento" aria-label="Zona de costa">${estado.zonas.map((z) => `<button type="button" data-zona="${z.id}" aria-pressed="${z.id === zona}">${esc(z.nombre)}</button>`).join("")}</nav>`;
  if (est) {
    html += `<section class="tarjeta"><div class="cab"><h2>Marea en ${esc(est.nombre)}</h2><small>${esc(nombreDia(new Date()))}, ${new Date().toLocaleDateString("es-ES", { day: "numeric", month: "short", timeZone: "Europe/Madrid" })}</small></div>
      <div class="marea-grande"><strong>${esc(rm.titulo)}</strong><span>${esc(rm.detalle)}</span></div>
      ${graficoMarea(est)}${extremosHoy(est)}
      ${ids.length > 1 ? `<div class="chips" role="group" aria-label="Puerto de referencia">${ids.map((id) => `<button type="button" data-est="${id}" aria-pressed="${id === estacionInicio}">${esc(estacion(id)?.nombre || id)}</button>`).join("")}</div>` : ""}
    </section>`;
  }
  html += `<section class="seccion"><h2>Puertos y playas</h2>${lugares.map((l) => {
    const a = ahoraMar(l);
    const sub = [l.municipio, a.agua != null ? `agua ${num(a.agua, 0)} °C` : "", a.viento != null ? `viento ${rumbo(a.vientoDir)} ${num(a.viento, 0)} km/h` : ""].filter(Boolean).join(" · ");
    return `<a class="lugar" href="#/lugar/${esc(l.id)}">
      <div class="ola n${nivelOla(a.ola)}"><strong>${num(a.ola)}</strong><span>m</span></div>
      <div class="cuerpo"><strong class="nom">${esc(l.nombre.replace(/^(Playa de |Puerto de )/, ""))}<span class="etq-tipo">${l.tipo === "puerto" ? "Puerto" : "Playa"}</span></strong>
      <span class="sub">${esc(sub)}</span></div>${ICO.flecha}</a>`;
  }).join("")}</section>` + pie();
  vista.innerHTML = html;
  vista.querySelectorAll("[data-zona]").forEach((b) => b.addEventListener("click", () => { zona = b.dataset.zona; guardar("costa:zona", zona); estacionInicio = null; pintar(); }));
  vista.querySelectorAll("[data-est]").forEach((b) => b.addEventListener("click", () => { estacionInicio = b.dataset.est; pintar(); }));
}

function vistaLugar(id) {
  const l = estado.lugares.find((x) => x.id === id);
  if (!l) { location.hash = "#/"; return; }
  const a = ahoraMar(l), est = estacion(l.marea), zonaNom = estado.zonas.find((z) => z.id === l.zona)?.nombre || "";
  const nv = nivelOla(a.ola);
  let html = cabecera(l.nombre, `<a class="atras" href="#/">${ICO.atras}Costa ${esc(zonaNom.toLowerCase())}</a>`,
    `${esc(l.municipio)} · marea de referencia: ${esc(est?.nombre || "—")}`);
  html += bloqueAvisos(l.avisos || [], 3, true);
  html += `<section class="cuadros">
    <div class="destacado n${nv}"><span>Oleaje</span><strong>${num(a.ola)} m</strong><span>del ${rumbo(a.olaDir)} · ${num(a.olaPer, 0)} s</span></div>
    <div><span>Agua</span><strong>${num(a.agua, 0)} °C</strong><span>superficie</span></div>
    <div><span>Viento</span><strong>${num(a.viento, 0)}</strong><span>km/h del ${rumbo(a.vientoDir)}${a.racha != null ? ` · rachas ${num(a.racha, 0)}` : ""}</span></div>
    <div><span>Aire</span><strong>${num(a.aire, 0)} °C</strong><span>sensación ${num(a.sens, 0)} °C</span></div>
    <div><span>Cielo</span><strong class="txt">${esc(CIELO[a.cielo] || "–")}</strong></div>
    <div><span>Índice UV</span><strong>${num(a.uv, 0)}</strong><span>${uvTexto(a.uv)}</span></div>
  </section>`;
  if (est) {
    const rm = resumenMarea(est);
    html += `<section class="tarjeta"><div class="cab"><h2>Marea hoy</h2><small>${esc(rm.titulo)}</small></div>
      ${graficoMarea(est)}${extremosHoy(est)}<span class="nota">${esc(rm.detalle)}. Horas y alturas oficiales del Instituto Hidrográfico en ${esc(est.nombre)}; la curva entre ellas es aproximada.</span></section>`;
  }
  if (l.mar) {
    html += `<section class="tarjeta"><div class="cab"><h2>Oleaje · 3 días</h2><small>altura (m)</small></div>
      ${graficoOleaje(l.mar)}<span class="nota">${esc(resumenOleaje(l.mar))} Ámbar desde 1 m, coral desde 2,5 m. Las flechas indican hacia dónde va la ola.</span></section>`;
  }
  const ae = l.aemet;
  html += `<section class="tarjeta" style="background:var(--tarjeta)"><div class="cab"><h2>AEMET · playa</h2>${ae?.nombre ? `<small>${esc(ae.nombre)}</small>` : ""}</div>`;
  if (ae?.dias?.length) {
    html += `<div class="tabla">${ae.dias.map((d) => {
      const fuerte = /moderad|fuerte/i.test(d.oleaje || "") ? "n1" : "";
      const cielo = [d.cielo, d.cieloTarde && d.cieloTarde !== d.cielo ? `tarde ${d.cieloTarde.toLowerCase()}` : ""].filter(Boolean).join(", ");
      return `<div class="fila"><strong>${esc(nombreDia(new Date(`${d.fecha}T12:00:00`)))}</strong>
        <span>${esc(cielo)} · viento ${esc((d.viento || "").toLowerCase())}${d.tMax ? ` · ${esc(d.tMax)} °C` : ""}${d.tAgua ? ` · agua ${esc(d.tAgua)} °C` : ""}</span>
        <span class="der ${fuerte}">Oleaje ${esc((d.oleaje || "–").toLowerCase())}</span></div>`;
    }).join("")}</div>`;
  } else {
    html += `<span class="nota">${l.tieneAemet ? "La predicción de AEMET para esta playa aún no está disponible." : "AEMET no tiene predicción específica para este lugar; los datos de arriba son de Open-Meteo."}</span>`;
  }
  html += `</section>`;
  html += `<section class="seccion"><h2>Webcam</h2>${l.webcam
    ? `<div class="webcam"><span class="nota">Cámara pública de un tercero; se abre en su web.</span>
        <a class="boton" href="${esc(l.webcam.url)}" target="_blank" rel="noopener">Ver webcam en ${esc(l.webcam.fuente)} ${ICO.fuera}</a></div>`
    : `<div class="webcam"><span class="nota">Todavía no tenemos una webcam pública para este lugar.</span></div>`}</section>`;
  html += pie();
  vista.innerHTML = html;
}

function vistaMareas() {
  const ests = Object.values(estado.mareas || {}).sort((a, b) => Number(b.id) - Number(a.id)); // de oeste a este
  if (!estacion(estacionMareas)) estacionMareas = ests[0]?.id;
  const est = estacion(estacionMareas);
  let html = cabecera("Mareas") + `<div class="chips" style="padding:0 20px" role="group" aria-label="Puerto">${ests.map((e) =>
    `<button type="button" data-est="${e.id}" aria-pressed="${e.id === estacionMareas}">${esc(e.nombre)}</button>`).join("")}</div>`;
  if (est) {
    const rm = resumenMarea(est);
    html += `<section class="tarjeta"><div class="cab"><h2>${esc(est.nombre)} · hoy</h2></div>
      <div class="marea-grande"><strong>${esc(rm.titulo)}</strong><span>${esc(rm.detalle)}</span></div>${graficoMarea(est)}</section>`;
    const porDia = {};
    for (const e of est.extremos) {
      const d = new Date(e.t), k = diaClave(d);
      if (k < diaClave(new Date())) continue;
      (porDia[k] = porDia[k] || { fecha: d, p: [], b: [] })[e.tipo === "pleamar" ? "p" : "b"].push(e);
    }
    html += `<section class="tarjeta" style="background:var(--tarjeta)"><div class="cab"><h2>Próximos 7 días</h2><small>hora de España</small></div>
      <div class="tabla tabla-mareas"><div class="fila"><span></span><span class="p">Pleamares</span><span>Bajamares</span></div>
      ${Object.values(porDia).slice(0, 7).map((d) => `<div class="fila"><strong>${esc(nombreDia(d.fecha, true))} ${d.fecha.toLocaleDateString("es-ES", { day: "numeric", timeZone: "Europe/Madrid" })}</strong>
        <span class="p">${d.p.map((e) => `${hhmm(new Date(e.t))} <small>${num(e.h, 1)} m</small>`).join("<br>")}</span>
        <span>${d.b.map((e) => `${hhmm(new Date(e.t))} <small>${num(e.h, 1)} m</small>`).join("<br>")}</span></div>`).join("")}</div></section>`;
  }
  html += pie();
  vista.innerHTML = html;
  vista.querySelectorAll("[data-est]").forEach((b) => b.addEventListener("click", () => { estacionMareas = b.dataset.est; guardar("costa:estacion", estacionMareas); pintar(); }));
}

function vistaMapa() {
  vista.innerHTML = cabecera("Mapa") + `<div id="mapa" role="region" aria-label="Mapa de puertos y playas"></div>
    <div class="leyenda"><span><i style="background:#5EE0D6"></i>Ola &lt; 1 m</span><span><i style="background:#F2B33D"></i>1 – 2,5 m</span><span><i style="background:#F07167"></i>≥ 2,5 m</span></div>` + pie();
  if (!window.L) { document.getElementById("mapa").innerHTML = '<p class="vacio">No se ha podido cargar el mapa.</p>'; return; }
  if (mapa) { mapa.remove(); mapa = null; }
  mapa = L.map("mapa");
  const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/";
  const fondo = L.tileLayer(`${ESRI}World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 16, attribution: 'Mapa © <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, © OpenStreetMap' }).addTo(mapa);
  const nombres = L.tileLayer(`${ESRI}World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 16 }).addTo(mapa);
  let fallos = 0;
  fondo.on("tileerror", () => {
    if (++fallos !== 4) return;
    mapa.removeLayer(fondo); mapa.removeLayer(nombres);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 16, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(mapa);
  });
  const caja = L.latLngBounds(estado.lugares.map((l) => [l.lat, l.lon]));
  const z = Math.max(8, mapa.getBoundsZoom(caja, false, L.point(16, 16)));
  mapa.setView(z > 8 ? caja.getCenter() : [43.5, -5.8], z, { animate: false });
  for (const l of estado.lugares) {
    const a = ahoraMar(l);
    L.circleMarker([l.lat, l.lon], { radius: l.tipo === "puerto" ? 8 : 10, color: "#0C1822", weight: 3, fillColor: ["#5EE0D6", "#F2B33D", "#F07167"][nivelOla(a.ola)], fillOpacity: 1 })
      .addTo(mapa).bindPopup(`<strong>${esc(l.nombre)}</strong><br>Ola ${num(a.ola)} m · agua ${num(a.agua, 0)} °C<br><a href="#/lugar/${esc(l.id)}">Ver detalle</a>`);
  }
}

function vistaCamaras() {
  let html = cabecera("Cámaras");
  for (const z of estado.zonas) {
    const ls = estado.lugares.filter((l) => l.zona === z.id && l.webcam);
    if (!ls.length) continue;
    html += `<section class="seccion"><h2>${esc(z.nombre)}</h2>${ls.map((l) => `<a class="boton sec" href="${esc(l.webcam.url)}" target="_blank" rel="noopener" style="justify-content:space-between">
      <span>${esc(l.nombre)}<br><small style="color:var(--suave);font-weight:400">${esc(l.webcam.fuente)}</small></span>${ICO.fuera}</a>`).join("")}</section>`;
  }
  html += `<p class="fuentes">Son webcams públicas de terceros y se abren en su web. Si conoces otra buena para algún sitio, se puede añadir.</p>` + pie();
  vista.innerHTML = html;
}

// ---------- navegación ----------
function pintar() {
  if (!estado) return;
  const [seccion, arg] = location.hash.replace(/^#\/?/, "").split("/");
  const tab = { "": "costa", lugar: "costa", mareas: "mareas", mapa: "mapa", camaras: "camaras" }[seccion] || "costa";
  document.querySelectorAll(".pestanas a").forEach((a) => { if (a.dataset.tab === tab) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  if (seccion !== "mapa" && mapa) { mapa.remove(); mapa = null; }
  if (seccion === "lugar") vistaLugar(arg);
  else if (seccion === "mareas") vistaMareas();
  else if (seccion === "mapa") vistaMapa();
  else if (seccion === "camaras") vistaCamaras();
  else vistaInicio();
}
addEventListener("hashchange", () => { pintar(); scrollTo(0, 0); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) cargar(); });
setInterval(() => { if (!document.hidden && !location.hash.startsWith("#/mapa")) cargar(); }, REFRESCO_MS);
cargar();

// ---------- instalación ----------
if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
(function avisoInstalar() {
  const caja = document.getElementById("instalar"), CLAVE = "costa:instalar-cerrado";
  const instalada = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (instalada || leer(CLAVE)) return;
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const interno = /FBAN|FBAV|Instagram|Line\/|; wv\)|WhatsApp/i.test(ua);
  let peticion = null;
  const mostrar = (m) => { caja.classList.remove("modo-android", "modo-ios", "modo-interno"); caja.classList.add(`modo-${m}`); caja.hidden = false; };
  const ocultar = (rec) => { caja.hidden = true; if (rec) guardar(CLAVE, "1"); };
  caja.querySelector(".cerrar-instalar").addEventListener("click", () => ocultar(true));
  caja.querySelector(".si").addEventListener("click", async () => {
    if (!peticion) return;
    peticion.prompt();
    const { outcome } = await peticion.userChoice;
    peticion = null; ocultar(outcome === "accepted");
  });
  addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); peticion = e; if (!leer(CLAVE)) mostrar("android"); });
  addEventListener("appinstalled", () => ocultar(true));
  setTimeout(() => { if (!caja.hidden || leer(CLAVE)) return; if (interno) mostrar("interno"); else if (ios) mostrar("ios"); }, 1500);
})();
