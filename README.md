# @moibe/partido-nucleo

Núcleo reutilizable para observar partidos en vivo a través del widget
Sportradar (`div.sr-lmt-plus`) embebido en sitios como Cloudbet, usando el
Chrome real del usuario vía CDP (sin olor a bot, login persistente).

Extraído de `partido-tiempo-real`; mismo patrón de paquete que
`@moibe/falai-nucleo` → `estudio-cine`.

## Qué exporta

- **`capturador`** — singleton que captura screenshots del widget por secciones
  (`marcador`, `momentum`, `cancha`, `estadisticas`), cada una a su intervalo
  (cancha 3 s, resto 30 s) y con dedupe por hash. Frames en
  `shots/<carpeta>/<seccion>/<ts>.png` relativos al cwd de la app.
- **`registrador`** — singleton que registra los movimientos del balón leyendo
  el DOM del tracker (`sr-lmt-bspot`) cada 400 ms: posición x/y en % de la
  cancha + estado del juego (`Ball Safe`, `Dangerous Attack`, …). Eventos por
  suscripción (ideal para SSE) y persistidos en `shots/<carpeta>/movimientos.jsonl`.
- **`sanear` / `carpetaDesdeUrl`** — nombres de carpeta seguros.
- **`CDP_URL` / `mismaPagina`** — helpers de conexión/reuso de pestañas.

## Requisito: el Chrome dedicado

Ambos singletons se conectan a `http://localhost:9222`. Lanza un Chrome real con:

```bat
chrome.exe ^
  --remote-debugging-port=9222 ^
  --user-data-dir=<carpeta-perfil-dedicado> ^
  --disable-backgrounding-occluded-windows ^
  --disable-renderer-backgrounding ^
  --no-first-run ^
  --start-minimized
```

(En `partido-tiempo-real/scripts/chrome-capturas.bat` está el ejemplo completo.)
El perfil dedicado guarda el login del sitio; solo te logueas la primera vez.

## Uso en una app SvelteKit

```jsonc
// package.json del consumidor
"dependencies": {
  "@moibe/partido-nucleo": "file:../partido-nucleo"
}
```

```ts
// src/routes/api/motion/eventos/+server.ts (ejemplo)
import { registrador, type MensajeMotion } from '@moibe/partido-nucleo';

// snapshot al conectar + un mensaje por evento; ver endpoints de
// partido-tiempo-real (src/routes/api/) como referencia completa.
```

Los singletons sobreviven el HMR de Vite (patrón globalThis + VERSION).
Importa el paquete solo desde código de servidor (`+server.ts`,
`$lib/server/...`); desde componentes solo `import type`.

## Desarrollo

```sh
npm run build   # tsc -> dist/
npm run dev     # tsc --watch
```

Tras editar el paquete: rebuild y reinicia el dev server del consumidor.
