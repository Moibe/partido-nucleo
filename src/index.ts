export { CDP_URL, mismaPagina } from './navegador.js';
export { sanear, carpetaDesdeUrl } from './carpeta.js';

// Capturador: screenshots por sección del widget Sportradar, con dedupe.
export { capturador, NOMBRES_SECCION } from './capturador.js';
export type { NombreSeccion, SeccionEstado, EstadoCaptura } from './capturador.js';

// Registrador: movimientos del balón leídos del DOM del tracker (sin imágenes).
export { registrador } from './registrador.js';
export type { EventoBalon, EstadoMotion, MensajeMotion } from './registrador.js';

// Marcador: tiempo, goles, equipos y goleadores leídos del DOM del scoreboard.
export { marcador } from './marcador.js';
export type {
	DatosMarcador,
	LadoMarcador,
	UltimoGol,
	EventoMarcador,
	EstadoMarcador,
	MensajeMarcador
} from './marcador.js';
