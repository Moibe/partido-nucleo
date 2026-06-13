// Lector del marcador: lee tiempo, periodo, goles, equipos y último goleador
// directo del DOM del scoreboard del widget Sportradar (.sr-lmt-plus__segment
// .srm-scoreboard) vía CDP — sin imágenes y sin IA, igual que el registrador con
// el balón. Singleton del proceso; las apps lo manejan desde sus endpoints.
//
// Dedup por cambios SIGNIFICATIVOS (periodo + goles + goleador), no por el reloj:
// el cronómetro tickea cada segundo y no queremos un evento por tick. El reloj
// vivo viaja en el snapshot/heartbeat; en shots/<carpeta>/marcador.jsonl solo se
// persisten goles y cambios de periodo (con el reloj del momento del cambio).
import { appendFile, mkdir } from 'node:fs/promises';
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import { CDP_URL, mismaPagina } from './navegador.js';

const SELECTOR = '.sr-lmt-plus__segment.srm-scoreboard';
const MUESTREO = 2_000; // ms entre lecturas; el marcador cambia lento
const MAX_FALLAS = 8;
const MAX_EVENTOS_MEMORIA = 100; // los que recibe la UI al conectar

export interface UltimoGol {
	minuto: string; // texto del widget, p. ej. "31'"
	jugador: string | null; // nombre del goleador, o "Goal" si la liga no lo trae
}

export interface LadoMarcador {
	nombre: string | null;
	abrev: string | null;
	goles: number | null;
	ultimoGol: UltimoGol | null;
}

export interface DatosMarcador {
	periodo: string | null; // "1st", "2nd", "HT", …
	reloj: string | null; // "39:40"
	local: LadoMarcador;
	visitante: LadoMarcador;
}

export interface EventoMarcador {
	t: string; // ISO del cambio
	marcador: DatosMarcador; // estado completo en ese momento (incluye el reloj)
}

export interface EstadoMarcador {
	activo: boolean;
	url: string | null;
	carpeta: string | null;
	total: number; // cambios significativos registrados en la sesión
	ultimo: DatosMarcador | null; // última lectura completa (reloj vivo)
	error: string | null; // motivo si el registro se detuvo solo
}

export type MensajeMarcador =
	| { tipo: 'snapshot'; estado: EstadoMarcador; eventos: EventoMarcador[] }
	| { tipo: 'evento'; evento: EventoMarcador; total: number }
	| { tipo: 'estado'; estado: EstadoMarcador };

type Oyente = (m: MensajeMarcador) => void;

class Marcador {
	private browser: Browser | null = null;
	private seccion: Locator | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private firma: string | null = null; // dedupe: cambios significativos (sin reloj)
	private eventos: EventoMarcador[] = [];
	private fallas = 0;
	private iniciando = false; // candado: iniciar() en vuelo
	private oyentes = new Set<Oyente>();

	private est: EstadoMarcador = {
		activo: false,
		url: null,
		carpeta: null,
		total: 0,
		ultimo: null,
		error: null
	};

	estado(): EstadoMarcador {
		return structuredClone(this.est);
	}

	snapshot(): MensajeMarcador {
		return { tipo: 'snapshot', estado: this.estado(), eventos: [...this.eventos] };
	}

	/** El SSE se cuelga aquí; devuelve la función para desuscribirse. */
	suscribir(oyente: Oyente): () => void {
		this.oyentes.add(oyente);
		return () => this.oyentes.delete(oyente);
	}

	private avisar(m: MensajeMarcador) {
		for (const o of this.oyentes) o(m);
	}

	async iniciar(url: string, carpeta: string): Promise<EstadoMarcador> {
		if (this.est.activo || this.iniciando) {
			throw new Error('Ya hay un marcador activo o iniciándose; detenlo primero.');
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

				const seccion = page.locator(SELECTOR).first();
				try {
					await seccion.waitFor({ state: 'visible', timeout: 20_000 });
				} catch {
					throw new Error(
						`No encontré el marcador del widget (${SELECTOR}). ¿Es una página de partido en vivo?`
					);
				}

				await mkdir(`shots/${carpeta}`, { recursive: true });

				this.browser = browser;
				this.seccion = seccion;
				this.firma = null;
				this.eventos = [];
				this.fallas = 0;
				this.est = {
					activo: true,
					url: page.url(),
					carpeta,
					total: 0,
					ultimo: null,
					error: null
				};
				this.programar(0);
				this.avisar({ tipo: 'estado', estado: this.estado() });
				return this.estado();
			} catch (err) {
				if (paginaCreada) await paginaCreada.close().catch(() => {});
				await browser.close().catch(() => {});
				throw err;
			}
		} finally {
			this.iniciando = false;
		}
	}

	async detener(error: string | null = null): Promise<EstadoMarcador> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.est.activo = false;
		this.est.error = error;
		this.seccion = null;
		if (this.browser) {
			await this.browser.close().catch(() => {}); // solo desconecta; el Chrome sigue
			this.browser = null;
		}
		this.avisar({ tipo: 'estado', estado: this.estado() });
		return this.estado();
	}

	private programar(ms: number) {
		this.timer = setTimeout(() => void this.tick(), ms);
	}

	/** Una lectura del DOM del scoreboard. null si aún no está listo (loader). */
	private leer(): Promise<DatosMarcador | null> {
		if (!this.seccion) return Promise.resolve(null);
		return this.seccion.evaluate((raiz): DatosMarcador | null => {
			const txt = (el: Element | null, sel: string) =>
				el?.querySelector(sel)?.textContent?.trim() ?? null;
			const num = (s: string | null) => {
				if (s == null) return null;
				const n = parseInt(s, 10);
				return Number.isNaN(n) ? null : n;
			};
			const lado = (n: number): LadoMarcador => {
				const team = raiz.querySelector(`.sr-lmt-plus-scb__team.srm-team${n}`);
				const scorer = raiz.querySelector(`.sr-lmt-plus-scb__last-scorer.srm-team${n}`);
				const minuto = txt(scorer, '.sr-last-goal-scorer-label__scorer-time');
				const jugador = txt(scorer, '.sr-last-goal-scorer-label__scorer-name');
				return {
					nombre: txt(team, '.sr-lmt-plus-scb__team-name'),
					abrev: txt(team, '.sr-lmt-plus-scb__team-abbr'),
					goles: num(txt(raiz, `.sr-lmt-plus-scb__result-team.srm-team${n}`)),
					ultimoGol: minuto || jugador ? { minuto: minuto ?? '', jugador } : null
				};
			};
			const local = lado(1);
			const visitante = lado(2);
			const reloj = txt(raiz, '.sr-lmt-plus-scb__clock');
			// Sin reloj ni equipos: el scoreboard aún no pintó (loader) — no es lectura.
			if (!reloj && !local.nombre && !visitante.nombre) return null;
			return { periodo: txt(raiz, '.sr-lmt-plus-scb__s-cap'), reloj, local, visitante };
		});
	}

	private async tick() {
		if (!this.est.activo) return;
		const inicio = Date.now();
		try {
			const lectura = await this.leer();
			this.fallas = 0;
			// Lectura nula (loader, descanso sin scoreboard) no es falla: solo no actualiza.
			if (lectura) {
				this.est.ultimo = lectura;
				const g = (l: LadoMarcador) => `${l.goles}/${l.ultimoGol?.minuto ?? ''}-${l.ultimoGol?.jugador ?? ''}`;
				const firma = `${lectura.periodo}|${g(lectura.local)}|${g(lectura.visitante)}`;
				if (firma !== this.firma) {
					this.firma = firma;
					const evento: EventoMarcador = { t: new Date().toISOString(), marcador: lectura };
					this.eventos.push(evento);
					if (this.eventos.length > MAX_EVENTOS_MEMORIA) this.eventos.shift();
					this.est.total++;
					await appendFile(
						`shots/${this.est.carpeta}/marcador.jsonl`,
						JSON.stringify(evento) + '\n'
					);
					this.avisar({ tipo: 'evento', evento, total: this.est.total });
				}
				// Heartbeat: late el reloj a los suscriptores aunque no haya evento.
				this.avisar({ tipo: 'estado', estado: this.estado() });
			}
		} catch (err) {
			// detener() manual con una lectura en vuelo rechaza la promesa: no es falla real.
			if (!this.est.activo) return;
			this.fallas++;
			if (this.fallas >= MAX_FALLAS) {
				const detalle = err instanceof Error ? err.message.split('\n')[0] : String(err);
				await this.detener(`Se perdió el marcador tras ${MAX_FALLAS} lecturas fallidas (${detalle}).`);
				return;
			}
		}
		if (this.est.activo) {
			this.programar(Math.max(0, MUESTREO - (Date.now() - inicio)));
		}
	}
}

// Singleton que sobrevive los re-imports de HMR, con VERSION para descartar
// instancias de forma vieja en vez de migrarlas (mismo patrón que registrador).
const VERSION = 1;
const g = globalThis as typeof globalThis & { __marcador?: Marcador; __marcadorV?: number };
if (g.__marcador && g.__marcadorV !== VERSION) {
	void g.__marcador.detener().catch(() => {});
	g.__marcador = undefined;
}
if (g.__marcador) {
	Object.setPrototypeOf(g.__marcador, Marcador.prototype);
}
g.__marcadorV = VERSION;
export const marcador = (g.__marcador ??= new Marcador());
