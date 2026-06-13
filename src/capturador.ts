// Capturador del widget del partido: CDP al Chrome real + screenshot por
// elemento + dedupe por hash, como singleton del proceso. Las apps lo manejan
// desde sus propios endpoints (p. ej. /api/capturas/* en SvelteKit).
//
// El widget Sportradar (div.sr-lmt-plus) se captura por secciones: la cancha
// es la única animada en continuo y se muestrea rápido; marcador, momentum y
// estadísticas cambian lento y se muestrean cada 30 s. Cada sección dedupea
// por su cuenta — así el reloj de la cancha no obliga a re-guardar las
// estadísticas ni viceversa. Los frames van a shots/<carpeta>/<seccion>/
// relativos al cwd del proceso consumidor.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import { CDP_URL, mismaPagina } from './navegador.js';

const SELECTOR = 'div.sr-lmt-plus';

// Selectores internos del widget Sportradar, verificados sobre Cloudbet
// (scripts secciones.mjs + verificar-secciones.mjs de partido-tiempo-real).
const SECCIONES = {
	marcador: { selector: '.sr-lmt-plus__segment.srm-scoreboard', intervalo: 30_000 },
	momentum: { selector: '.sr-lmt-plus__segment.srm-momentum', intervalo: 30_000 },
	cancha: { selector: '.sr-lmt-plus__comp.srm-isLmt', intervalo: 3_000 },
	estadisticas: { selector: '.sr-lmt-plus__comp.srm-notLmt', intervalo: 30_000 }
} as const;

const TICK = 3_000; // paso base del loop: el intervalo más corto de SECCIONES
const MAX_FALLAS = 5;

export type NombreSeccion = keyof typeof SECCIONES;
export const NOMBRES_SECCION = Object.keys(SECCIONES) as NombreSeccion[];

export interface SeccionEstado {
	guardadas: number;
	repetidas: number;
	ultimaTs: string | null; // ISO de la última guardada
}

export interface EstadoCaptura {
	activo: boolean;
	url: string | null;
	carpeta: string | null;
	secciones: Record<NombreSeccion, SeccionEstado>;
	error: string | null; // motivo si la captura se detuvo sola
}

type Oyente = (estado: EstadoCaptura) => void;

/** Runtime por sección mientras la captura está activa. */
interface SeccionViva {
	locator: Locator;
	hashes: Set<string>; // dedupe completo: descarta cualquier frame ya guardado
	proximaVez: number; // epoch ms del siguiente intento
}

function seccionesEnCero(): Record<NombreSeccion, SeccionEstado> {
	return Object.fromEntries(
		NOMBRES_SECCION.map((n) => [n, { guardadas: 0, repetidas: 0, ultimaTs: null }])
	) as Record<NombreSeccion, SeccionEstado>;
}

class Capturador {
	private browser: Browser | null = null;
	private vivas = new Map<NombreSeccion, SeccionViva>();
	private buffers = new Map<NombreSeccion, Buffer>(); // último frame por sección (persiste tras detener)
	private timer: ReturnType<typeof setTimeout> | null = null;
	private fallas = 0;
	private iniciando = false; // candado: iniciar() en vuelo (la fase async dura hasta ~50 s)
	private oyentes = new Set<Oyente>();

	private est: EstadoCaptura = {
		activo: false,
		url: null,
		carpeta: null,
		secciones: seccionesEnCero(),
		error: null
	};

	estado(): EstadoCaptura {
		return structuredClone(this.est);
	}

	ultimaImagen(seccion: NombreSeccion = 'cancha'): Buffer | null {
		return this.buffers.get(seccion) ?? null;
	}

	/** El SSE se cuelga aquí; devuelve la función para desuscribirse. */
	suscribir(oyente: Oyente): () => void {
		this.oyentes.add(oyente);
		return () => this.oyentes.delete(oyente);
	}

	private avisar() {
		const e = this.estado();
		for (const o of this.oyentes) o(e);
	}

	async iniciar(url: string, carpeta: string): Promise<EstadoCaptura> {
		// El candado iniciando cierra la ventana entre este check y activo=true
		// (hasta ~50 s de awaits): sin él, dos POST simultáneos arrancan dos
		// loops y fugan una conexión CDP.
		if (this.est.activo || this.iniciando) {
			throw new Error('Ya hay una captura activa o iniciándose; detenla primero.');
		}
		this.iniciando = true;
		try {
			let browser: Browser;
			try {
				browser = await chromium.connectOverCDP(CDP_URL);
			} catch {
				throw new Error(
					'No pude conectarme al Chrome de capturas (puerto 9222). ¿Lanzaste el Chrome dedicado?'
				);
			}

			let paginaCreada: Page | null = null;
			try {
				const contexto = browser.contexts()[0];
				if (!contexto) throw new Error('El Chrome de capturas no tiene ninguna ventana abierta.');

				// Si la pestaña del partido ya está abierta la reusamos; si no, la
				// abrimos nosotros en ese mismo Chrome (navegación normal, sin olor a bot).
				const abiertas = browser.contexts().flatMap((c) => c.pages());
				let page = abiertas.find((p) => mismaPagina(p.url(), url));
				if (!page) {
					paginaCreada = await contexto.newPage();
					page = paginaCreada;
					await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
				}
				// Al frente: las animaciones de tabs en background se congelan.
				await page.bringToFront();

				const raiz = page.locator(SELECTOR).first();
				try {
					await raiz.waitFor({ state: 'visible', timeout: 20_000 });
				} catch {
					throw new Error(
						`No encontré el widget (${SELECTOR}) en la página. ¿Es una página de partido con tracker en vivo?`
					);
				}

				// Localiza cada sección dentro del widget; si falta una, el layout
				// no es el esperado (¿otro deporte?) y mejor fallar con nombre claro.
				const vivas = new Map<NombreSeccion, SeccionViva>();
				for (const nombre of NOMBRES_SECCION) {
					const loc = raiz.locator(SECCIONES[nombre].selector).first();
					try {
						await loc.waitFor({ state: 'visible', timeout: 10_000 });
					} catch {
						throw new Error(
							`El widget apareció pero no encontré la sección «${nombre}» (${SECCIONES[nombre].selector}). ¿Es un partido de soccer?`
						);
					}
					vivas.set(nombre, { locator: loc, hashes: new Set(), proximaVez: 0 });
					await mkdir(`shots/${carpeta}/${nombre}`, { recursive: true });
				}

				this.browser = browser;
				this.vivas = vivas;
				this.buffers.clear();
				this.fallas = 0;
				this.est = {
					activo: true,
					// La URL canónica de la pestaña (el sitio puede reescribir la pegada).
					url: page.url(),
					carpeta,
					secciones: seccionesEnCero(),
					error: null
				};
				this.programar(0);
				this.avisar();
				return this.estado();
			} catch (err) {
				// Si la pestaña la abrimos nosotros y no sirvió, no se la dejamos
				// huérfana al usuario (browser.close solo desconecta, no cierra tabs).
				if (paginaCreada) await paginaCreada.close().catch(() => {});
				await browser.close().catch(() => {});
				throw err;
			}
		} finally {
			this.iniciando = false;
		}
	}

	async detener(error: string | null = null): Promise<EstadoCaptura> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.est.activo = false;
		this.est.error = error;
		this.vivas.clear();
		if (this.browser) {
			await this.browser.close().catch(() => {}); // solo desconecta; el Chrome sigue
			this.browser = null;
		}
		this.avisar();
		return this.estado();
	}

	private programar(ms: number) {
		this.timer = setTimeout(() => void this.capturar(), ms);
	}

	private async capturar() {
		if (!this.est.activo || this.vivas.size === 0) return;
		const inicio = Date.now();
		try {
			for (const [nombre, viva] of this.vivas) {
				if (Date.now() < viva.proximaVez) continue;
				const buf = await viva.locator.screenshot({ timeout: 10_000 });
				const hash = createHash('md5').update(buf).digest('hex');
				const s = this.est.secciones[nombre];
				if (viva.hashes.has(hash)) {
					s.repetidas++;
				} else {
					const ahora = new Date();
					const archivo = ahora.toISOString().replace(/[:.]/g, '-');
					await writeFile(`shots/${this.est.carpeta}/${nombre}/${archivo}.png`, buf);
					viva.hashes.add(hash);
					this.buffers.set(nombre, buf);
					s.guardadas++;
					s.ultimaTs = ahora.toISOString();
				}
				viva.proximaVez = Date.now() + SECCIONES[nombre].intervalo;
			}
			this.fallas = 0;
			this.avisar();
		} catch (err) {
			// Si la falla la causó un detener() manual mientras el screenshot iba
			// en vuelo (cerrar la conexión rechaza la promesa), no es una falla
			// real: no contarla ni pisar el estado limpio con un error espurio.
			if (!this.est.activo) return;
			this.fallas++;
			if (this.fallas >= MAX_FALLAS) {
				const detalle = err instanceof Error ? err.message.split('\n')[0] : String(err);
				await this.detener(`Se perdió el widget tras ${MAX_FALLAS} intentos seguidos (${detalle}).`);
				return;
			}
		}
		// detener() pudo correr mientras esperábamos el screenshot: no revivir el loop.
		if (this.est.activo) {
			this.programar(Math.max(0, TICK - (Date.now() - inicio)));
		}
	}
}

// Singleton que sobrevive los re-imports de HMR del dev server del consumidor.
// VERSION marca la forma interna de la clase: si el módulo se re-evalúa con
// campos nuevos o renombrados, migrar la instancia viva en caliente es terreno
// de zombis — se detiene la vieja (best-effort) y se estrena una limpia. Para
// ediciones que no cambian la forma basta re-enganchar el prototipo nuevo.
const VERSION = 2;
const g = globalThis as typeof globalThis & { __capturador?: Capturador; __capturadorV?: number };
if (g.__capturador && g.__capturadorV !== VERSION) {
	void g.__capturador.detener().catch(() => {});
	g.__capturador = undefined;
}
if (g.__capturador) {
	Object.setPrototypeOf(g.__capturador, Capturador.prototype);
}
g.__capturadorV = VERSION;
export const capturador = (g.__capturador ??= new Capturador());
