// Helpers compartidos para hablar con el Chrome real de capturas vía CDP.
// El Chrome debe lanzarse con --remote-debugging-port=9222 y un perfil
// dedicado (ver README): el login persiste y no hay olor a bot.

export const CDP_URL = 'http://localhost:9222';

/** ¿La pestaña abierta y la URL pedida son la misma página? Normaliza
 *  www/slash final y descarta query/hash, porque el sitio canonicaliza
 *  la URL al cargar y el match exacto abriría pestañas duplicadas. */
export function mismaPagina(abierta: string, pedida: string): boolean {
	try {
		const a = new URL(abierta);
		const b = new URL(pedida);
		const host = (u: URL) => u.host.replace(/^www\./, '');
		const ruta = (u: URL) => u.pathname.replace(/\/+$/, '');
		return host(a) === host(b) && ruta(a) === ruta(b);
	} catch {
		return abierta === pedida;
	}
}
