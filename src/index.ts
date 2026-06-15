export { CDP_URL, mismaPagina, abrirNavegador } from './navegador.js';
export type { ModoNavegador, OpcionesNavegador } from './navegador.js';
export { sanear, carpetaDesdeUrl } from './carpeta.js';

// Capturador: screenshots por sección del widget Sportradar, con dedupe.
export { capturador, NOMBRES_SECCION } from './capturador.js';
export type { NombreSeccion, SeccionEstado, EstadoCaptura } from './capturador.js';

// Registrador: movimientos del balón leídos del DOM del tracker (sin imágenes).
export { registrador } from './registrador.js';
export type { EventoBalon, EstadoMotion, MensajeMotion } from './registrador.js';

// Marcador: tiempo, goles, equipos y goleadores leídos del DOM del scoreboard.
// Singleton (un partido) + lectura pura reutilizable + constantes.
export { marcador, leerMarcador, firmaMarcador, SELECTOR_MARCADOR, MUESTREO, MUESTREO_MIN } from './marcador.js';
export type {
	DatosMarcador,
	LadoMarcador,
	UltimoGol,
	EventoMarcador,
	EstadoMarcador,
	MensajeMarcador
} from './marcador.js';

// Monitor multi-partido del marcador: N partidos a la vez con una sola conexión CDP.
export { monitorMarcadores, MonitorMarcadores } from './monitor.js';
export type { OpcionesPartido, PartidoEstado, MensajeMonitor } from './monitor.js';
