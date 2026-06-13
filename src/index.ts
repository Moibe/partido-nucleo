export { CDP_URL, mismaPagina } from './navegador.js';
export { sanear, carpetaDesdeUrl } from './carpeta.js';

// Capturador: screenshots por sección del widget Sportradar, con dedupe.
export { capturador, NOMBRES_SECCION } from './capturador.js';
export type { NombreSeccion, SeccionEstado, EstadoCaptura } from './capturador.js';

// Registrador: movimientos del balón leídos del DOM del tracker (sin imágenes).
export { registrador } from './registrador.js';
export type { EventoBalon, EstadoMotion, MensajeMotion } from './registrador.js';
