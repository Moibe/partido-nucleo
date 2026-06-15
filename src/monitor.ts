// Monitor multi-partido del marcador: una sola conexión CDP al Chrome dedicado
// y N partidos vigilados a la vez, cada uno en su pestaña, leyendo el scoreboard
// del widget Sportradar directo del DOM (sin imágenes ni IA).
//
// A diferencia del singleton `marcador` (un partido, con bringToFront), aquí NO
// traemos pestañas al frente: leer texto del DOM no necesita foreground, así que
// 4+ partidos en pestañas de fondo del mismo Chrome conviven sin pelearse (y sin
// chocar con el capturador/registrador, que sí dependen del foreground).
//
// Es el motor reutilizable; el host (p. ej. el server de quiniela) decide qué
// hacer con los datos: persistir, empujar por SSE, escribir a su BD, etc.
import { appendFile, mkdir } from 'node:fs/promises';
import { type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { abrirNavegador, mismaPagina } from './navegador.js';
import { carpetaDesdeUrl } from './carpeta.js';
import {
	MUESTREO,
	MUESTREO_MIN,
	SELECTOR_MARCADOR,
	firmaMarcador,
	leerMarcador,
	type DatosMarcador,
	type EventoMarcador
} from './marcador.js';

const MAX_FALLAS = 8;
const MAX_EVENTOS_MEMORIA = 100;

export interface OpcionesPartido {
	carpeta?: string; // subcarpeta en shots/; default carpetaDesdeUrl(url)
	muestreoMs?: number; // ms entre lecturas; default 2 s, mínimo 250 ms
	persistir?: boolean; // escribir eventos a shots/<carpeta>/marcador.jsonl; default true
}

export interface PartidoEstado {
	url: string; // URL canónica de la pestaña
	carpeta: string;
	activo: boolean;
	total: number; // cambios significativos registrados
	ultimo: DatosMarcador | null; // última lectura (reloj vivo)
	error: string | null;
}

export type MensajeMonitor =
	| { tipo: 'snapshot'; partidos: PartidoEstado[] }
	| { tipo: 'alta'; estado: PartidoEstado }
	| { tipo: 'baja'; url: string }
	| { tipo: 'evento'; url: string; evento: EventoMarcador; total: number }
	| { tipo: 'estado'; url: string; estado: PartidoEstado };

type Oyente = (m: MensajeMonitor) => void;

interface PartidoVivo {
	page: Page;
	seccion: Locator;
	paginaPropia: boolean; // la abrimos nosotros → la cerramos al quitar
	timer: ReturnType<typeof setTimeout> | null;
	firma: string | null;
	muestreo: number;
	persistir: boolean;
	enTick: boolean;
	eventos: EventoMarcador[];
	fallas: number;
	est: PartidoEstado;
}

class MonitorMarcadores {
	private browser: Browser | null = null;
	private contexto: BrowserContext | null = null; // donde abrimos pestañas nuevas
	private partidos = new Map<string, PartidoVivo>(); // key: url canónica de la pestaña
	private oyentes = new Set<Oyente>();

	/** Partidos vigilados ahora mismo. */
	listar(): PartidoEstado[] {
		return [...this.partidos.values()].map((p) => structuredClone(p.est));
	}

	estado(url: string): PartidoEstado | null {
		const e = this.buscar(url);
		return e ? structuredClone(e[1].est) : null;
	}

	snapshot(): MensajeMonitor {
		return { tipo: 'snapshot', partidos: this.listar() };
	}

	/** El SSE se cuelga aquí; recibe altas/bajas/eventos/heartbeats de TODOS los
	 *  partidos (cada mensaje trae su `url`). Filtra por url en el consumidor si
	 *  quieres uno solo. */
	suscribir(oyente: Oyente): () => void {
		this.oyentes.add(oyente);
		return () => this.oyentes.delete(oyente);
	}

	private avisar(m: MensajeMonitor) {
		for (const o of this.oyentes) o(m);
	}

	private buscar(url: string): [string, PartidoVivo] | undefined {
		return [...this.partidos.entries()].find(([u]) => mismaPagina(u, url));
	}

	private async asegurar(): Promise<{ browser: Browser; contexto: BrowserContext }> {
		if (this.browser && this.browser.isConnected() && this.contexto) {
			return { browser: this.browser, contexto: this.contexto };
		}
		const { browser, contexto } = await abrirNavegador(); // modo conectar|lanzar (env/opts)
		this.browser = browser;
		this.contexto = contexto;
		return { browser, contexto };
	}

	/** Cierra/desconecta el navegador y suelta el contexto. En 'lanzar' libera la RAM
	 *  del Chromium; en 'conectar' solo desconecta (el Chrome del usuario sigue vivo). */
	private async cerrarNavegador(): Promise<void> {
		if (this.browser) {
			await this.browser.close().catch(() => {});
			this.browser = null;
		}
		this.contexto = null;
	}

	/** Agrega un partido a la vigilancia. Reusa su pestaña si ya está abierta; si
	 *  no, la abre (SIN traerla al frente). Idempotente: si ya lo vigilamos,
	 *  devuelve su estado actual sin duplicar. */
	async agregar(url: string, opts: OpcionesPartido = {}): Promise<PartidoEstado> {
		const ya = this.buscar(url);
		if (ya) return structuredClone(ya[1].est);

		const { browser, contexto } = await this.asegurar();

		let paginaPropia = false;
		const abiertas = browser.contexts().flatMap((c) => c.pages());
		let page = abiertas.find((p) => mismaPagina(p.url(), url));
		if (!page) {
			page = await contexto.newPage();
			paginaPropia = true;
			await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
		}
		// Sin bringToFront a propósito: leer texto no necesita foreground, y traer
		// la pestaña al frente pelearía con los demás partidos y con el capturador.

		const seccion = page.locator(SELECTOR_MARCADOR).first();
		try {
			await seccion.waitFor({ state: 'visible', timeout: 20_000 });
		} catch {
			if (paginaPropia) await page.close().catch(() => {});
			// Si este alta fallido era lo único en vuelo, no dejes el navegador colgado.
			if (this.partidos.size === 0) await this.cerrarNavegador();
			throw new Error(`No encontré el marcador (${SELECTOR_MARCADOR}) en ${url}. ¿Es un partido en vivo?`);
		}

		const clave = page.url();
		const carpeta = opts.carpeta ?? carpetaDesdeUrl(new URL(clave));
		const persistir = opts.persistir ?? true;
		if (persistir) await mkdir(`shots/${carpeta}`, { recursive: true });

		const vivo: PartidoVivo = {
			page,
			seccion,
			paginaPropia,
			timer: null,
			firma: null,
			muestreo: Math.max(MUESTREO_MIN, opts.muestreoMs ?? MUESTREO),
			persistir,
			enTick: false,
			eventos: [],
			fallas: 0,
			est: { url: clave, carpeta, activo: true, total: 0, ultimo: null, error: null }
		};
		this.partidos.set(clave, vivo);
		this.programar(clave, 0);
		this.avisar({ tipo: 'alta', estado: structuredClone(vivo.est) });
		return structuredClone(vivo.est);
	}

	/** Quita un partido de la vigilancia. Cierra su pestaña solo si la abrimos nosotros. */
	async quitar(url: string): Promise<void> {
		const e = this.buscar(url);
		if (!e) return;
		const [clave, vivo] = e;
		if (vivo.timer) clearTimeout(vivo.timer);
		vivo.timer = null;
		vivo.est.activo = false;
		this.partidos.delete(clave);
		if (vivo.paginaPropia) await vivo.page.close().catch(() => {});
		this.avisar({ tipo: 'baja', url: clave });
		// Idle: sin partidos vigilados, libera el navegador (RAM ≈ 0). El próximo
		// agregar() lo relanza solo (asegurar()).
		if (this.partidos.size === 0) await this.cerrarNavegador();
	}

	/** Cambia el muestreo de un partido vigilado, al vuelo (mismo piso de 250 ms). */
	reconfigurar(url: string, muestreoMs: number): PartidoEstado {
		const e = this.buscar(url);
		if (!e) throw new Error(`No estoy vigilando ${url}.`);
		const [clave, vivo] = e;
		vivo.muestreo = Math.max(MUESTREO_MIN, muestreoMs);
		if (!vivo.enTick && vivo.timer) {
			clearTimeout(vivo.timer);
			vivo.timer = null;
			this.programar(clave, 0);
		}
		this.avisar({ tipo: 'estado', url: clave, estado: structuredClone(vivo.est) });
		return structuredClone(vivo.est);
	}

	/** Detiene todos los partidos y suelta la conexión al Chrome (el Chrome sigue). */
	async detenerTodo(): Promise<void> {
		for (const vivo of this.partidos.values()) {
			if (vivo.timer) clearTimeout(vivo.timer);
			vivo.timer = null;
			vivo.est.activo = false;
		}
		this.partidos.clear();
		await this.cerrarNavegador();
	}

	private programar(clave: string, ms: number) {
		const vivo = this.partidos.get(clave);
		if (!vivo) return;
		vivo.timer = setTimeout(() => void this.tick(clave), ms);
	}

	private async tick(clave: string) {
		const vivo = this.partidos.get(clave);
		if (!vivo || !vivo.est.activo) return;
		const inicio = Date.now();
		vivo.enTick = true;
		try {
			const lectura = await leerMarcador(vivo.seccion);
			// quitar()/detenerTodo() mientras leíamos: no toques un partido ya retirado.
			if (!this.partidos.has(clave) || !vivo.est.activo) return;
			vivo.fallas = 0;
			if (lectura) {
				vivo.est.ultimo = lectura;
				const firma = firmaMarcador(lectura);
				if (firma !== vivo.firma) {
					vivo.firma = firma;
					const evento: EventoMarcador = { t: new Date().toISOString(), marcador: lectura };
					vivo.eventos.push(evento);
					if (vivo.eventos.length > MAX_EVENTOS_MEMORIA) vivo.eventos.shift();
					vivo.est.total++;
					if (vivo.persistir) {
						await appendFile(
							`shots/${vivo.est.carpeta}/marcador.jsonl`,
							JSON.stringify(evento) + '\n'
						);
					}
					this.avisar({ tipo: 'evento', url: clave, evento, total: vivo.est.total });
				}
				// Heartbeat: late el reloj a los suscriptores aunque no haya evento.
				this.avisar({ tipo: 'estado', url: clave, estado: structuredClone(vivo.est) });
			}
		} catch (err) {
			if (!this.partidos.has(clave) || !vivo.est.activo) return;
			vivo.fallas++;
			if (vivo.fallas >= MAX_FALLAS) {
				const detalle = err instanceof Error ? err.message.split('\n')[0] : String(err);
				vivo.est.activo = false;
				vivo.est.error = `Se perdió el marcador tras ${MAX_FALLAS} lecturas fallidas (${detalle}).`;
				if (vivo.timer) clearTimeout(vivo.timer);
				vivo.timer = null;
				this.avisar({ tipo: 'estado', url: clave, estado: structuredClone(vivo.est) });
				return;
			}
		} finally {
			vivo.enTick = false;
		}
		if (this.partidos.has(clave) && vivo.est.activo) {
			this.programar(clave, Math.max(0, vivo.muestreo - (Date.now() - inicio)));
		}
	}
}

// Singleton multi-tenant: una instancia (el registro de N partidos) por proceso,
// que sobrevive el HMR del dev server del consumidor. Se exporta también la clase
// por si se quiere instanciar a mano (tests, varios Chromes, etc.).
const VERSION = 1;
const gm = globalThis as typeof globalThis & {
	__monitorMarcadores?: MonitorMarcadores;
	__monitorMarcadoresV?: number;
};
if (gm.__monitorMarcadores && gm.__monitorMarcadoresV !== VERSION) {
	void gm.__monitorMarcadores.detenerTodo().catch(() => {});
	gm.__monitorMarcadores = undefined;
}
if (gm.__monitorMarcadores) {
	Object.setPrototypeOf(gm.__monitorMarcadores, MonitorMarcadores.prototype);
}
gm.__monitorMarcadoresV = VERSION;
export const monitorMarcadores = (gm.__monitorMarcadores ??= new MonitorMarcadores());
export { MonitorMarcadores };
