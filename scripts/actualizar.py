#!/usr/bin/env python3
"""Junta mareas (Instituto Hidrográfico de la Marina), oleaje y tiempo (Open-Meteo),
predicción de playas y avisos (AEMET) para los lugares de lugares.json y escribe estado.json.

Uso: python scripts/actualizar.py --salida out [--previo carpeta_con_cache.json]
Solo biblioteca estándar. La clave de AEMET va en la variable AEMET_API_KEY.
"""
import argparse
import io
import json
import math
import os
import re
import sys
import tarfile
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

RAIZ = Path(__file__).resolve().parent.parent
MADRID = ZoneInfo("Europe/Madrid")
AHORA = datetime.now(timezone.utc)
UA = "mobilityastur-costa/1.0 (+https://github.com/mobilityastur/costa)"
URL_IHM = "https://ideihm.covam.es/api-ihm/getmarea?request=gettide&id={id}&format=json&month={mes}"
URL_MARINA = "https://marine-api.open-meteo.com/v1/marine"
URL_TIEMPO = "https://api.open-meteo.com/v1/forecast"
URL_AEMET_PLAYA = "https://opendata.aemet.es/opendata/api/prediccion/especifica/playa/{codigo}"
URL_AEMET_AVISOS = "https://opendata.aemet.es/opendata/api/avisos_cap/ultimoelaborado/area/63"
HORAS = 72  # 3 días de previsión
PASO_GRAFICO = 3  # el gráfico de oleaje va cada 3 h
REFRESCO_AEMET_PLAYAS = timedelta(hours=3)
MAX_PLAYAS_POR_PASADA = 6


# ---------- utilidades ----------

def descargar(url, cabeceras=None, intentos=3, espera=4):
    h = {"User-Agent": UA, "Accept": "*/*"}
    h.update(cabeceras or {})
    ultimo = None
    for i in range(intentos):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=60) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            ultimo = e
            print(f"  aviso: {url[:90]} intento {i + 1}: {e}", file=sys.stderr)
            if getattr(e, "code", None) == 429:
                break  # límite de peticiones: reintentar solo lo empeora
            time.sleep(espera * (i + 1))
    raise RuntimeError(f"no se pudo descargar {url[:90]}: {ultimo}")


def json_url(url, cabeceras=None, codificacion="utf-8"):
    return json.loads(descargar(url, cabeceras).decode(codificacion))


def iso(d):
    return d.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z") if d else None


def fecha(s):
    if not s:
        return None
    try:
        d = datetime.fromisoformat(s.strip().replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def distancia(a_lat, a_lon, b_lat, b_lon):
    x = (b_lon - a_lon) * math.cos(math.radians((a_lat + b_lat) / 2))
    return math.hypot(x, b_lat - a_lat)


def redondear(v, n=1):
    return None if v is None else round(v, n)


# ---------- mareas (IHM) ----------

def leer_mareas(estaciones):
    """Pleamares y bajamares desde ayer hasta dentro de 8 días. La API da la hora en UTC."""
    hoy = AHORA.astimezone(MADRID).date()
    meses = sorted({(hoy - timedelta(days=1)).strftime("%Y%m"), (hoy + timedelta(days=8)).strftime("%Y%m")})
    desde = AHORA - timedelta(days=1, hours=12)
    hasta = AHORA + timedelta(days=8)
    salida = {}
    for est in estaciones:
        extremos = []
        for mes in meses:
            j = json_url(URL_IHM.format(id=est["id"], mes=mes))
            for m in j["mareas"]["datos"]["marea"]:
                t = datetime.fromisoformat(f'{m["fecha"]}T{m["hora"]}').replace(tzinfo=timezone.utc)
                if desde <= t <= hasta:
                    extremos.append({"t": iso(t), "h": round(float(m["altura"]), 2),
                                     "tipo": "pleamar" if m["tipo"].lower().startswith("plea") else "bajamar"})
        extremos.sort(key=lambda e: e["t"])
        salida[est["id"]] = {"id": est["id"], "nombre": est["nombre"], "extremos": extremos}
        time.sleep(0.3)
    return salida


# ---------- Open-Meteo (varios puntos en una sola petición) ----------

def open_meteo(url, lugares, variables, extra=None):
    params = {
        "latitude": ",".join(f'{l["lat"]:.4f}' for l in lugares),
        "longitude": ",".join(f'{l["lon"]:.4f}' for l in lugares),
        "hourly": ",".join(variables),
        "timezone": "UTC",
        "forecast_days": 4,
    }
    params.update(extra or {})
    j = json_url(f"{url}?{urllib.parse.urlencode(params)}")
    if isinstance(j, dict):
        if j.get("error"):
            raise RuntimeError(j.get("reason"))
        j = [j]
    return j


def series(res, variables):
    """Recorta cada serie a las próximas HORAS horas empezando en la hora actual."""
    tiempos = [datetime.fromisoformat(t).replace(tzinfo=timezone.utc) for t in res["hourly"]["time"]]
    inicio = AHORA.replace(minute=0, second=0, microsecond=0)
    i0 = next((i for i, t in enumerate(tiempos) if t >= inicio), 0)
    sal = {"t0": iso(tiempos[i0]), "paso": PASO_GRAFICO}
    for v in variables:
        sal[v] = [redondear(x, 1) for x in res["hourly"].get(v, [])[i0:i0 + HORAS:PASO_GRAFICO]]
    return sal


VARS_MAR = ["wave_height", "wave_direction", "wave_period", "swell_wave_height", "swell_wave_direction",
            "swell_wave_period", "sea_surface_temperature"]
VARS_TIEMPO = ["temperature_2m", "apparent_temperature", "wind_speed_10m", "wind_direction_10m",
               "wind_gusts_10m", "weather_code", "uv_index", "precipitation_probability"]


# ---------- AEMET ----------

def aemet(url, clave):
    meta = json_url(url, {"api_key": clave, "Accept": "application/json"}, "latin-1")
    if meta.get("estado") == 404:
        return None
    if meta.get("estado") not in (200, None) or not meta.get("datos"):
        raise RuntimeError(f"AEMET: {meta.get('estado')} {meta.get('descripcion')}")
    return descargar(meta["datos"])


def leer_playa(codigo, clave):
    datos = aemet(URL_AEMET_PLAYA.format(codigo=codigo), clave)
    if datos is None:
        return None
    j = json.loads(datos.decode("latin-1"))
    j = j[0] if isinstance(j, list) else j
    dias = []
    for d in j.get("prediccion", {}).get("dia", [])[:3]:
        f = str(d.get("fecha", ""))
        dias.append({
            "fecha": f"{f[:4]}-{f[4:6]}-{f[6:8]}" if len(f) == 8 else f,
            "cielo": (d.get("estadoCielo") or {}).get("descripcion1"),
            "cieloTarde": (d.get("estadoCielo") or {}).get("descripcion2"),
            "viento": (d.get("viento") or {}).get("descripcion1"),
            "vientoTarde": (d.get("viento") or {}).get("descripcion2"),
            "oleaje": (d.get("oleaje") or {}).get("descripcion1"),
            "oleajeTarde": (d.get("oleaje") or {}).get("descripcion2"),
            "tMax": (d.get("tMaxima") or {}).get("valor1"),
            "sensacion": (d.get("sTermica") or {}).get("descripcion1"),
            "tAgua": (d.get("tAgua") or {}).get("valor1"),
            "uv": (d.get("uvMax") or {}).get("valor1"),
        })
    return {"elaborado": j.get("elaborado"), "nombre": j.get("nombre"), "dias": dias, "descargado": iso(AHORA)}


NIVELES = {"amarillo": 1, "naranja": 2, "rojo": 3}


def texto(el, nombre):
    for c in el.iter():
        if c.tag.rsplit("}", 1)[-1] == nombre:
            return c.text.strip() if c.text else None
    return None


def hijos(el, nombre):
    return [c for c in el if c.tag.rsplit("}", 1)[-1] == nombre]


def leer_cap(xml_bytes):
    raiz = ET.fromstring(xml_bytes)
    if (texto(raiz, "msgType") or "").lower() == "cancel":
        return []
    sal = []
    for info in hijos(raiz, "info"):
        if not (texto(info, "language") or "").lower().startswith("es"):
            continue
        params = {texto(p, "valueName") or "": texto(p, "value") or "" for p in hijos(info, "parameter")}
        nivel = (params.get("AEMET-Meteoalerta nivel") or "").lower()
        if nivel not in NIVELES:
            continue
        fin = fecha(texto(info, "expires"))
        if fin and fin < AHORA:
            continue
        inicio = fecha(texto(info, "onset")) or fecha(texto(info, "effective"))
        fen = params.get("AEMET-Meteoalerta fenomeno", "")
        fen = fen.split(";", 1)[-1] if fen else ""
        if not fen:
            m = re.search(r"[Aa]viso (?:especial )?de (.+?) de nivel", texto(info, "event") or "")
            fen = m.group(1) if m else (texto(info, "event") or "")
        for area in hijos(info, "area"):
            poli = []
            for par in (texto(area, "polygon") or "").split():
                la, _, lo = par.partition(",")
                try:
                    poli.append((float(la), float(lo)))
                except ValueError:
                    pass
            zona = next((texto(g, "value") for g in hijos(area, "geocode")
                         if "zona" in (texto(g, "valueName") or "").lower()), None)
            sal.append({"zona": zona, "zonaNombre": texto(area, "areaDesc"), "nivel": nivel,
                        "nivelNum": NIVELES[nivel], "fenomeno": fen[:1].upper() + fen[1:],
                        "texto": texto(info, "description"), "inicio": iso(inicio), "fin": iso(fin),
                        "ahora": bool(inicio is None or inicio <= AHORA), "poligono": poli})
    return sal


def leer_avisos(clave):
    datos = aemet(URL_AEMET_AVISOS, clave)
    if datos is None:
        return []
    avisos = []
    try:
        with tarfile.open(fileobj=io.BytesIO(datos), mode="r:*") as tar:
            for m in tar.getmembers():
                if m.isfile() and m.name.lower().endswith(".xml"):
                    avisos.extend(leer_cap(tar.extractfile(m).read()))
    except tarfile.ReadError:
        avisos.extend(leer_cap(datos))
    # une tramos seguidos de un mismo aviso
    avisos.sort(key=lambda a: (a["zona"] or "", a["fenomeno"], a["nivelNum"], a["inicio"] or ""))
    unidos = []
    for a in avisos:
        p = unidos[-1] if unidos else None
        if (p and (p["zona"], p["fenomeno"], p["nivel"]) == (a["zona"], a["fenomeno"], a["nivel"])
                and p["fin"] and a["inicio"] and fecha(a["inicio"]) <= fecha(p["fin"]) + timedelta(minutes=2)):
            if (fecha(a["fin"]) or AHORA) > (fecha(p["fin"]) or AHORA):
                p["fin"] = a["fin"]
            p["ahora"] = p["ahora"] or a["ahora"]
            continue
        unidos.append(dict(a))
    return unidos


def en_poligono(lat, lon, poli):
    dentro, j = False, len(poli) - 1
    for i in range(len(poli)):
        yi, xi = poli[i]
        yj, xj = poli[j]
        if (xi > lon) != (xj > lon) and lat < (yj - yi) * (lon - xi) / ((xj - xi) or 1e-12) + yi:
            dentro = not dentro
        j = i
    return dentro


def cerca_de(lat, lon, poli, margen=0.04):
    """Dentro del polígono o a menos de ~4 km de él (las playas quedan justo en el borde)."""
    if en_poligono(lat, lon, poli):
        return True
    return any(en_poligono(lat + dy, lon + dx, poli)
               for dy in (-margen, 0, margen) for dx in (-margen, 0, margen))


# ---------- composición ----------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--salida", default="out")
    ap.add_argument("--previo", default=None)
    args = ap.parse_args()
    salida = Path(args.salida)
    salida.mkdir(parents=True, exist_ok=True)
    conf = json.loads((RAIZ / "lugares.json").read_text(encoding="utf-8"))
    lugares, estaciones = conf["lugares"], conf["estacionesMarea"]

    previo = {}
    if args.previo and (Path(args.previo) / "cache.json").exists():
        try:
            previo = json.loads((Path(args.previo) / "cache.json").read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            previo = {}
    cache_prev, fuentes_prev = previo.get("_cache", {}), previo.get("fuentes", {})
    fuentes, cache = {}, {}

    def fuente(nombre, fn):
        try:
            cache[nombre] = fn()
            fuentes[nombre] = {"ok": True, "hora": iso(AHORA)}
        except Exception as e:  # noqa: BLE001
            print(f"ERROR {nombre}: {e}", file=sys.stderr)
            ant = fuentes_prev.get(nombre, {})
            fuentes[nombre] = {"ok": False, "hora": ant.get("hora"), "error": str(e)[:200]}
            cache[nombre] = cache_prev.get(nombre)
        print(f"{nombre}: {fuentes[nombre]}")

    fuente("mareas", lambda: leer_mareas(estaciones))
    fuente("mar", lambda: [series(r, VARS_MAR) for r in
                           open_meteo(URL_MARINA, lugares, VARS_MAR, {"cell_selection": "sea"})])
    fuente("tiempo", lambda: [series(r, VARS_TIEMPO) for r in open_meteo(URL_TIEMPO, lugares, VARS_TIEMPO)])

    clave = os.environ.get("AEMET_API_KEY", "").strip()
    if clave:
        fuente("avisos", lambda: leer_avisos(clave))
        # la predicción de playas cambia poco: se pide cada 3 horas y si no se reutiliza
        playas_prev = cache_prev.get("playas") or {}
        def playas():
            # La clave de AEMET se comparte con la app de carreteras: se renuevan como mucho
            # MAX_PLAYAS_POR_PASADA playas en cada ejecución (las más antiguas primero), espaciadas.
            res = {c: p for c, p in playas_prev.items()}
            codigos = [l["aemet"] for l in lugares if l.get("aemet")]
            def edad(c):
                p = playas_prev.get(c)
                return fecha(p.get("descargado")) if p and p.get("descargado") else datetime.min.replace(tzinfo=timezone.utc)
            pendientes = [c for c in sorted(codigos, key=edad) if AHORA - edad(c) >= REFRESCO_AEMET_PLAYAS]
            for c in pendientes[:MAX_PLAYAS_POR_PASADA]:
                try:
                    res[c] = leer_playa(c, clave) or res.get(c)
                except Exception as e:  # noqa: BLE001
                    print(f"  playa {c}: {e}", file=sys.stderr)
                    if "429" in str(e):
                        break
                time.sleep(3)
            return {c: res[c] for c in codigos if res.get(c)}
        fuente("playas", playas)
    else:
        for n in ("avisos", "playas"):
            fuentes[n] = {"ok": False, "hora": None, "error": "Falta el secreto AEMET_API_KEY"}
            cache[n] = cache_prev.get(n)

    mareas = cache.get("mareas") or {}
    mar = cache.get("mar") or [None] * len(lugares)
    tiempo = cache.get("tiempo") or [None] * len(lugares)
    avisos = cache.get("avisos") or []
    playas = cache.get("playas") or {}

    sal_lugares = []
    for i, l in enumerate(lugares):
        ref = l.get("marea") or min(estaciones, key=lambda e: distancia(l["lat"], l["lon"], e["lat"], e["lon"]))["id"]
        m = mar[i] if i < len(mar) else None
        t = tiempo[i] if i < len(tiempo) else None
        av = [{k: v for k, v in a.items() if k != "poligono"} for a in avisos
              if cerca_de(l["lat"], l["lon"], a["poligono"])]
        sal_lugares.append({
            **{k: l[k] for k in ("id", "nombre", "tipo", "municipio", "zona", "lat", "lon")},
            "marea": ref, "webcams": l.get("webcams") or [],
            "mar": m, "tiempo": t,
            "aemet": playas.get(l.get("aemet")) if l.get("aemet") else None,
            "tieneAemet": bool(l.get("aemet")),
            "avisos": av,
        })

    # avisos para el banner: los que afectan a algún lugar, con la lista de zonas de costa
    vistos, banner = {}, []
    for l in sal_lugares:
        for a in l["avisos"]:
            k = (a["zona"], a["fenomeno"], a["inicio"])
            if k not in vistos:
                vistos[k] = {**a, "zonas": []}
                banner.append(vistos[k])
            if l["zona"] not in vistos[k]["zonas"]:
                vistos[k]["zonas"].append(l["zona"])
    banner.sort(key=lambda a: (not a["ahora"], -a["nivelNum"], a["inicio"] or ""))

    estado = {
        "actualizado": iso(AHORA),
        "fuentes": fuentes,
        "zonas": conf["zonas"],
        "mareas": mareas,
        "avisos": banner,
        "lugares": sal_lugares,
    }
    (salida / "estado.json").write_text(json.dumps(estado, ensure_ascii=False, separators=(",", ":")),
                                        encoding="utf-8")
    (salida / "cache.json").write_text(json.dumps({"_cache": cache, "fuentes": fuentes}, ensure_ascii=False),
                                       encoding="utf-8")
    print(f"ok: {len(sal_lugares)} lugares, {len(mareas)} estaciones de marea, {len(banner)} avisos")


if __name__ == "__main__":
    main()
