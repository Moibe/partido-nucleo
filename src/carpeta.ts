// Helpers de nombres de carpeta para todo lo que se persiste bajo shots/.

/** Nombre de carpeta seguro: minúsculas, [a-z0-9-_], sin traversal. */
export function sanear(nombre: string): string {
	return nombre
		.toLowerCase()
		.replace(/[^a-z0-9-_]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);
}

/** Carpeta default a partir de la URL: fecha + último segmento del path. */
export function carpetaDesdeUrl(url: URL): string {
	const segmento = url.pathname.split('/').filter(Boolean).pop() ?? 'partido';
	const fecha = new Date().toISOString().slice(0, 10);
	return sanear(`${fecha}-${segmento}`);
}
