# Costa · Asturias

App web (instalable) con mareas, oleaje, tiempo, avisos y webcams de playas y puertos de Asturias, por zonas (occidental, central y oriental).

- `scripts/actualizar.py` junta los datos y genera `estado.json`; la tarea `.github/workflows/datos.yml` lo publica en la rama `datos`.
- `lugares.json` define los puertos y playas (coordenadas, código de playa de AEMET, puerto de marea de referencia y webcam).
- La clave de AEMET va en el secreto del repo `AEMET_API_KEY`.

Fuentes: Instituto Hidrográfico de la Marina (mareas) · AEMET OpenData (avisos y predicción de playas) · Open-Meteo (oleaje, temperatura del agua y tiempo; uso no comercial con atribución).
