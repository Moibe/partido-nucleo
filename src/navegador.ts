// Helpers compartidos para hablar con el Chrome real de capturas vía CDP.
// El Chrome debe lanzarse con --remote-debugging-port=9222 y un perfil
// dedicado (ver README): el login persiste y no hay olor a bot.
import { chromium, type Browser, type BrowserContext } from 'playwright-core';

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

export type ModoNavegador = 'conectar' | 'lanzar';

export interface OpcionesNavegador {
	/** 'conectar' (default): CDP a un Chrome ya lanzado (local, logueado).
	 *  'lanzar': Chromium propio headless con contexto limpio (servidor, sin login). */
	modo?: ModoNavegador;
	cdpUrl?: string; // para 'conectar'
	executablePath?: string; // para 'lanzar': ruta al Chrome/Chromium del sistema
	headless?: boolean; // para 'lanzar' (default true)
	args?: string[]; // para 'lanzar': flags de Chromium (default: seguros para server)
}

// Flags por defecto para correr en server (droplet, headless, como root):
// --no-sandbox: Chrome como root no arranca sin esto. --disable-dev-shm-usage: el
// /dev/shm chico de un droplet hace crashear Chrome. --disable-gpu: no hay GPU.
const ARGS_SERVER = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];

/** Abre el navegador y su contexto según el modo. El modo sale de opts.modo o de la
 *  env PARTIDO_NAVEGADOR_MODO (default 'conectar'), para que un server pueda pasar a
 *  'lanzar' sin tocar código. En 'lanzar', la ruta del ejecutable sale de
 *  opts.executablePath o de la env PARTIDO_CHROME_PATH (playwright-core no trae
 *  navegador propio, así que en server hay que instalar Chromium y apuntar la ruta). */
export async function abrirNavegador(
	opts: OpcionesNavegador = {}
): Promise<{ browser: Browser; contexto: BrowserContext }> {
	const modo: ModoNavegador =
		opts.modo ?? (process.env.PARTIDO_NAVEGADOR_MODO === 'lanzar' ? 'lanzar' : 'conectar');

	if (modo === 'lanzar') {
		const browser = await chromium.launch({
			headless: opts.headless ?? true,
			executablePath: opts.executablePath ?? process.env.PARTIDO_CHROME_PATH ?? undefined,
			args: opts.args ?? ARGS_SERVER
		});
		const contexto = await browser.newContext(); // contexto limpio, sin login
		// Solo leemos texto del DOM: bloquear imágenes/fuentes/media baja RAM, CPU y red.
		// NO bloqueamos css/js/xhr/websocket: el SPA y sus datos en vivo los necesitan.
		await contexto.route('**/*', (route) => {
			const tipo = route.request().resourceType();
			return tipo === 'image' || tipo === 'media' || tipo === 'font'
				? route.abort()
				: route.continue();
		});
		return { browser, contexto };
	}

	let browser: Browser;
	try {
		browser = await chromium.connectOverCDP(opts.cdpUrl ?? CDP_URL);
	} catch {
		throw new Error(
			'No pude conectarme al Chrome de capturas (puerto 9222). ¿Lanzaste el Chrome dedicado?'
		);
	}
	const contexto = browser.contexts()[0];
	if (!contexto) throw new Error('El Chrome de capturas no tiene ninguna ventana abierta.');
	return { browser, contexto };
}
