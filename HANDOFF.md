# Handoff — `@moibe/partido-nucleo`

Para un agente que entra fresco a este proyecto. Léelo antes de tocar nada.

## Qué es este proyecto

`partido-nucleo` es un **paquete TypeScript puro** (sin framework) que contiene
la lógica reutilizable para observar partidos de fútbol en vivo a través del
widget de **Sportradar** (`div.sr-lmt-plus`) embebido en casas de apuestas como
Cloudbet. No es una app: no tiene UI, no tiene servidor, no se ejecuta solo. Es
una librería que otras apps importan.

Se extrajo de la app `partido-tiempo-real` (carpeta hermana) para poder
reutilizar el mismo código desde varios proyectos sin copiar-pegar. Sigue
exactamente el mismo patrón que `falai-nucleo` → `estudio-cine` del usuario:
un paquete `@moibe/*` compilado con `tsc` plano y consumido vía `file:`.

**Quién lo consume hoy:** `partido-tiempo-real` y `quiniela` (ambos lo tienen
como `"@moibe/partido-nucleo": "file:../partido-nucleo"`).

## Qué exporta (ver `src/index.ts`)

Dos singletons de proceso, más helpers:

- **`capturador`** — toma screenshots del widget **por secciones**
  (`marcador`, `momentum`, `cancha`, `estadisticas`). Cada sección tiene su
  propio intervalo (cancha 3 s, las demás 30 s) y su propio dedupe por hash md5
  (un `Set` de hashes vistos — descarta cualquier frame ya guardado, no solo el
  anterior). Frames a `shots/<carpeta>/<seccion>/<timestamp>.png`.
- **`registrador`** — registra los **movimientos del balón** leyendo el DOM del
  tracker (`sr-lmt-bspot`) cada 400 ms: posición x/y en % de la cancha + estado
  del juego (`Ball Safe`, `Dangerous Attack`, …). **Sin imágenes y sin IA** —
  es lectura directa del SVG. Eventos por suscripción (pensado para SSE) y
  persistidos en `shots/<carpeta>/movimientos.jsonl`.
- **`sanear` / `carpetaDesdeUrl`** — nombres de carpeta seguros desde una URL.
- **`CDP_URL` / `mismaPagina`** — helpers de conexión y reuso de pestañas.

## Cómo funciona por dentro (lo que no es obvio)

1. **Ambos singletons se conectan a un Chrome real vía CDP** (`connectOverCDP`
   a `http://localhost:9222`). NO lanzan un Chromium propio. El usuario lanza
   un Chrome dedicado con `--remote-debugging-port=9222` y un perfil propio
   (`--user-data-dir`); ese perfil queda logueado en el sitio y no tiene
   fingerprint de bot. El `.bat` que lo lanza vive en
   `partido-tiempo-real/scripts/chrome-capturas.bat`.

2. **Son singletons que sobreviven el HMR del consumidor.** Usan
   `globalThis.__capturador` / `__registrador` + una constante `VERSION`. Si
   editas la **forma** de la clase (campos nuevos/renombrados), sube `VERSION`:
   al re-evaluar el módulo, la instancia vieja se detiene y se crea una limpia,
   en vez de intentar migrar en caliente un objeto con forma vieja (eso causaba
   un bug de campos `undefined`). Si solo cambias lógica sin tocar campos, no
   hace falta.

3. **`mismaPagina` normaliza www y slash final** porque Cloudbet reescribe la
   URL pegada al cargar; sin eso se abrirían pestañas duplicadas.

4. **El dedupe del registrador es por "firma"** `x,y,estado`: también emite un
   evento cuando cambia solo el estado del juego aunque el balón no se mueva.

## Cómo se construye y se consume

```sh
# en este proyecto, tras cualquier edición de src/:
npm run build      # tsc -> dist/   (o `npm run dev` para watch)
```

El consumidor importa desde `'@moibe/partido-nucleo'`. **Solo desde código de
servidor** (`+server.ts`, `$lib/server/...`); desde componentes Svelte usa
`import type` únicamente (los singletons tocan Playwright/fs, no pueden ir al
browser). Tras editar el paquete: rebuild aquí **y reinicia el dev server del
consumidor** (el `file:` apunta a `dist/`, no se recarga solo).

## Gotchas que ya costaron tiempo

- **`tsconfig` necesita `"types": ["node"]`.** Sin esa línea, TypeScript 6 da
  error TS2591 (`Buffer`, `node:crypto` no encontrados) porque el paquete usa
  builtins de Node. (`falai-nucleo` no la trae porque no usa builtins.)
- **Los `import` internos llevan extensión `.js`** (no `.ts`), por NodeNext —
  p. ej. `from './navegador.js'`. Es lo correcto aunque el archivo sea `.ts`.
- **Las rutas `shots/...` son relativas al cwd del proceso consumidor**, no del
  paquete. Cada app escribe en su propia carpeta `shots/`.

## Estado actual

Funciona y está validado en vivo (capturas por sección y registro de balón
probados contra partidos reales de Cloudbet, 2026-06-12). `npm run build` pasa
limpio. Versión `0.1.0`.

## Si te piden cambios

- Lógica de captura/registro → edita `src/capturador.ts` / `src/registrador.ts`,
  `npm run build`, reinicia el consumidor.
- Algo nuevo que exportar → agrégalo a `src/index.ts` con extensión `.js`.
- Los selectores de Sportradar (`.sr-lmt-plus__*`, `.sr-lmt-bspot__*`) se
  descubrieron con scripts de sondeo que viven en
  `partido-tiempo-real/scripts/` (`secciones.mjs`, `sondear-balon.mjs`,
  `sondear-movimiento.mjs`) — úsalos si Sportradar cambia el markup.
