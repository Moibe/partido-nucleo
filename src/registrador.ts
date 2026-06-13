// Registrador de movimientos del balón: lee la posición del marcador del balón
// (sr-lmt-bspot) y el estado del juego (sr-lmt-sitstr) directo del DOM del
// tracker vía CDP — sin imágenes y sin IA. Singleton del proceso; las apps lo
// manejan desde sus propios endpoints (p. ej. /api/motion/* en SvelteKit).
// Cada evento se persiste en shots/<carpeta>/movimientos.jsonl (cwd del consumidor).
import { appendFile, mkdir } from 'node:fs/promises';
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import { CDP_URL, mismaPagina } from './navegador.js';

const SELECTOR_CANCHA = '.sr-lmt-plus__comp.srm-isLmt';
const MUESTREO = 400; // ms entre lecturas; los movimientos llegan en ráfagas de ~1/s
const MAX_FALLAS = 8;
const MAX_EVENTOS_MEMORIA = 300; // los que recibe la UI al conectar

export interface EventoBalon {
	t: string; // ISO
	x: number; // % del ancho de la cancha (0 = izquierda)
	y: number; // % del alto (0 = arriba)
	estado: string | null; // texto del widget: Ball Safe / Attacking / …
}

export interface EstadoMotion {
	activo: boolean;
	url: string | null;
	carpeta: string | null;
	total: number; // eventos registrados en la sesión
	error: string | null; // motivo si el registro se detuvo solo
}

export type MensajeMotion =
	| { tipo: 'snapshot'; estado: EstadoMotion; eventos: EventoBalon[] }
	| { tipo: 'evento'; evento: EventoBalon; total: number }
	| { tipo: 'estado'; estado: EstadoMotion };

type Oyente = (m: MensajeMotion) => void;

class Registrador {
	private browser: Browser | null = null;
	private cancha: Locator | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private firma: string | null = null; // dedupe: última lectura x,y,estado
	private eventos: EventoBalon[] = [];
	private fallas = 0;
	private iniciando = false; // candado: iniciar() en vuelo
	private oyentes = new Set<Oyente>();

	private est: EstadoMotion = {
		activo: false,
		url: null,
		carpeta: null,
		total: 0,
		error: null
	};

	snapshot(): MensajeMotion {
		return { tipo: 'snapshot', estado: { ...this.est }, eventos: [...this.eventos] };
	}

	/** El SSE se cuelga aquí; devuelve la función para desuscribirse. */
	suscribir(oyente: Oyente): () => void {
		this.oyentes.add(oyente);
		return () => this.oyentes.delete(oyente);
	}

	private avisar(m: MensajeMotion) {
		for (const o of this.oyentes) o(m);
	}

	async iniciar(url: string, carpeta: string): Promise<EstadoMotion> {
		if (this.est.activo || this.iniciando) {
			throw new Error('Ya hay un registro activo o iniciándose; detenlo primero.');
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

				const abiertas = browser.contexts().flatMap((c) => c.pages());
				let page = abiertas.find((p) => mismaPagina(p.url(), url));
				if (!page) {
					paginaCreada = await contexto.newPage();
					page = paginaCreada;
					await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
				}
				await page.bringToFront();

				const cancha = page.locator(SELECTOR_CANCHA).first();
				try {
					await cancha.waitFor({ state: 'visible', timeout: 20_000 });
				} catch {
					throw new Error(
						`No encontré la cancha del tracker (${SELECTOR_CANCHA}). ¿Es una página de partido de soccer en vivo?`
					);
				}

				await mkdir(`shots/${carpeta}`, { recursive: true });

				this.browser = browser;
				this.cancha = cancha;
				this.firma = null;
				this.eventos = [];
				this.fallas = 0;
				this.est = {
					activo: true,
					url: page.url(),
					carpeta,
					total: 0,
					error: null
				};
				this.programar(0);
				this.avisar({ tipo: 'estado', estado: { ...this.est } });
				return { ...this.est };
			} catch (err) {
				if (paginaCreada) await paginaCreada.close().catch(() => {});
				await browser.close().catch(() => {});
				throw err;
			}
		} finally {
			this.iniciando = false;
		}
	}

	async detener(error: string | null = null): Promise<EstadoMotion> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.est.activo = false;
		this.est.error = error;
		this.cancha = null;
		if (this.browser) {
			await this.browser.close().catch(() => {}); // solo desconecta; el Chrome sigue
			this.browser = null;
		}
		this.avisar({ tipo: 'estado', estado: { ...this.est } });
		return { ...this.est };
	}

	private programar(ms: number) {
		this.timer = setTimeout(() => void this.tick(), ms);
	}

	/** Una lectura del DOM: posición del balón en % de la cancha + estado. */
	private leer(): Promise<{ x: number; y: number; estado: string | null } | null> {
		if (!this.cancha) return Promise.resolve(null);
		return this.cancha.evaluate((raiz) => {
			const marco = raiz.getBoundingClientRect();
			// El balón: icono bspot__change; en su ausencia, el anillo de ping.
			const bola =
				raiz.querySelector('.sr-lmt-bspot__change') ?? raiz.querySelector('.sr-lmt-bspot__ping');
			const estado =
				raiz
					.querySelector('.sr-lmt-sitstr__str.srm-active .sr-lmt-sitstr__text')
					?.textContent?.trim() ?? null;
			if (!bola || marco.width === 0) return null;
			const r = bola.getBoundingClientRect();
			return {
				x: Math.round(((r.x + r.width / 2 - marco.x) / marco.width) * 1000) / 10,
				y: Math.round(((r.y + r.height / 2 - marco.y) / marco.height) * 1000) / 10,
				estado
			};
		});
	}

	private async tick() {
		if (!this.est.activo) return;
		const inicio = Date.now();
		try {
			const lectura = await this.leer();
			this.fallas = 0;
			// Sin balón (descansos, tarjetas de pausa) no es falla: solo no hay evento.
			if (lectura) {
				const firma = `${lectura.x},${lectura.y},${lectura.estado}`;
				if (firma !== this.firma) {
					this.firma = firma;
					const evento: EventoBalon = { t: new Date().toISOString(), ...lectura };
					this.eventos.push(evento);
					if (this.eventos.length > MAX_EVENTOS_MEMORIA) this.eventos.shift();
					this.est.total++;
					await appendFile(
						`shots/${this.est.carpeta}/movimientos.jsonl`,
						JSON.stringify(evento) + '\n'
					);
					this.avisar({ tipo: 'evento', evento, total: this.est.total });
				}
			}
		} catch (err) {
			// detener() manual con una lectura en vuelo rechaza la promesa: no es falla real.
			if (!this.est.activo) return;
			this.fallas++;
			if (this.fallas >= MAX_FALLAS) {
				const detalle = err instanceof Error ? err.message.split('\n')[0] : String(err);
				await this.detener(`Se perdió el tracker tras ${MAX_FALLAS} lecturas fallidas (${detalle}).`);
				return;
			}
		}
		if (this.est.activo) {
			this.programar(Math.max(0, MUESTREO - (Date.now() - inicio)));
		}
	}
}

// Singleton que sobrevive los re-imports de HMR, con VERSION para descartar
// instancias de forma vieja en vez de migrarlas (mismo patrón que capturador).
const VERSION = 1;
const g = globalThis as typeof globalThis & { __registrador?: Registrador; __registradorV?: number };
if (g.__registrador && g.__registradorV !== VERSION) {
	void g.__registrador.detener().catch(() => {});
	g.__registrador = undefined;
}
if (g.__registrador) {
	Object.setPrototypeOf(g.__registrador, Registrador.prototype);
}
g.__registradorV = VERSION;
export const registrador = (g.__registrador ??= new Registrador());
