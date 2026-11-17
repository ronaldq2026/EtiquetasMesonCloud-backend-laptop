//pos.service.js
const { DBFFile, DELETED } = require("dbffile");
const path = require("path");
const fs = require("fs");

// =============================
// Rutas DBF
// =============================
const rutaMAPRE = path.join("P:", "data", "posmapre.dbf");
const rutaDPOFE = path.join("P:", "data", "posdpofe.dbf");

// =============================
// Constantes
// =============================

// Codigo de etiqueta de la mecanica "precio fijo" en POSDPOFE (etiqueta amarilla)
const COD_ETI_PRECIO_FIJO = "217";
const INTERVALO_REVISION_MS = 30 * 1000; // cada 30 segundos

// =============================
// CACHE GLOBAL Y METADATOS DBF
// =============================

let mapProductos = new Map();
let mapOfertas = new Map();
let cargaPromesa = null;

let statMAPRE = { mtimeMs: 0, size: 0 };
let statDPOFE = { mtimeMs: 0, size: 0 };

// =============================
// Helpers
// =============================

async function getFileStat(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (err) {
    return null;
  }
}

function cleanStr(s) {
  return (s ?? "").toString().trim();
}

function cleanDate(d) {
  if (!d) return null;
  if (d instanceof Date && !isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }
  const s = String(d).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10);
  }
  return s || null;
}

function cleanNum(n) {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? v : 0;
}

function normalizeSku(value) {

  if (value == null) return null;

  let s = String(value).trim();

  s = s.replace(/\D+/g, "");
  s = s.replace(/^0+/, "");

  return s || null;
}

// =============================
// Mapear MAPRE
// =============================

function mapMAPRE(row) {

  const sku = normalizeSku(row.MAPCODIN);
  if (!sku) return null;  
  
 // unidad de medida  20260402 mlepin
  let unidad = cleanStr(row.MAPUDESC);
  if (unidad === "ST") {
    unidad = "UNIDAD";
  }

  return {
    sku,
    descripcion: cleanStr(row.MAPDESCL),
    marca: cleanStr(row.MAPLAB),
    contenido: cleanStr(row.MAPCONCENT),
    ean13: cleanStr(row.MAPBARRA),
	unidadMedida: unidad,   //cleanStr(row.MAPUDESC),     
    precioNormal: cleanNum(row.MAPPREVT),   // antes precioUnitario
    precioUnitario: cleanNum(row.MAPREUNI)  // nuevo campo real
  };
}

// =============================
// Mapear DPOFE
// =============================

function mapDPOFE(row) {

  const sku = normalizeSku(row.DP_DATO);
  if (!sku) return null;

  return {
    sku,
    precioOferta: cleanNum(row.DP_VALOFER),
    vigenciaInicio: cleanDate(row.DP_FINICIO ?? row.DP_INICIO),
    vigenciaFin: cleanDate(row.DP_FFIN ?? row.DP_TERMINO)
  };
}

// =============================
// Cargar DBF en memoria (Individual y Atómico)
// =============================

async function cargarMAPRE(currentStat) {
  const stat = currentStat || (await getFileStat(rutaMAPRE));
  if (!stat) return false;

  console.log("[POS] Leyendo POSMAPRE.DBF...");
  const start = Date.now();
  const nuevoMap = new Map();

  const dbfMAPRE = await DBFFile.open(rutaMAPRE, { encoding: "cp1252" });
  let records = await dbfMAPRE.readRecords(5000);

  while (records.length > 0) {
    for (const row of records) {
      const p = mapMAPRE(row);
      if (p) nuevoMap.set(p.sku, p);
    }
    records = await dbfMAPRE.readRecords(5000);
  }

  // Reemplazo atómico solo si la lectura completó sin errores
  mapProductos = nuevoMap;
  statMAPRE = stat;
  console.log(`[POS] MAPRE cargado (${mapProductos.size} productos) en ${Date.now() - start} ms`);
  return true;
}

async function cargarDPOFE(currentStat) {
  const stat = currentStat || (await getFileStat(rutaDPOFE));
  if (!stat) return false;

  console.log("[POS] Leyendo POSDPOFE.DBF...");
  const start = Date.now();
  const nuevoMap = new Map();

  const dbfDPOFE = await DBFFile.open(rutaDPOFE, { encoding: "cp1252" });
  let records = await dbfDPOFE.readRecords(5000);

  while (records.length > 0) {
    for (const row of records) {
      const o = mapDPOFE(row);
      if (o && cleanStr(row.DP_COD_ETI) === COD_ETI_PRECIO_FIJO) {
        if (!nuevoMap.has(o.sku)) {
          nuevoMap.set(o.sku, []);
        }
        nuevoMap.get(o.sku).push(o);
      }
    }
    records = await dbfDPOFE.readRecords(5000);
  }

  // Excepción controlada: POSDPOFE puede contener un único registro por SKU
  // marcado como eliminado aunque siga siendo válido para un producto PAI.
  // La lectura con eliminados se usa solo para contar y seleccionar candidatos;
  // la carga normal anterior continúa excluyendo registros eliminados.
  const dbfDPOFEVerificacion = await DBFFile.open(rutaDPOFE, {
    encoding: "cp1252",
    includeDeletedRecords: true
  });
  const conteoPorSku = new Map();
  const candidatosEliminados = new Map();
  records = await dbfDPOFEVerificacion.readRecords(5000);

  while (records.length > 0) {
    for (const row of records) {
      const sku = normalizeSku(row.DP_DATO);
      if (!sku) continue;

      conteoPorSku.set(sku, (conteoPorSku.get(sku) || 0) + 1);

      if (
        row[DELETED] === true &&
        cleanStr(row.DP_COD_ETI) === COD_ETI_PRECIO_FIJO &&
        mapProductos.has(sku)
      ) {
        candidatosEliminados.set(sku, mapDPOFE(row));
      }
    }
    records = await dbfDPOFEVerificacion.readRecords(5000);
  }

  for (const [sku, ofertaEliminada] of candidatosEliminados) {
    if (conteoPorSku.get(sku) === 1 && !nuevoMap.has(sku)) {
      nuevoMap.set(sku, [ofertaEliminada]);
      console.warn(
        `[POS] EXCEPCIÓN APLICADA SKU ${sku}: ` +
        "único registro DPOFE eliminado, SKU presente en PAI y DP_COD_ETI=217"
      );
    }
  }

  // Reemplazo atómico solo si la lectura completó sin errores
  mapOfertas = nuevoMap;
  statDPOFE = stat;
  console.log(`[POS] DPOFE cargado (${mapOfertas.size} ofertas) en ${Date.now() - start} ms`);
  return true;
}

async function verificarYRecargarCache(force = false) {
  if (cargaPromesa) {
    return cargaPromesa;
  }

  cargaPromesa = (async () => {
    try {
      const curMapre = await getFileStat(rutaMAPRE);
      const curDpofe = await getFileStat(rutaDPOFE);

      const mapreCambio =
        force ||
        mapProductos.size === 0 ||
        (curMapre && (curMapre.mtimeMs !== statMAPRE.mtimeMs || curMapre.size !== statMAPRE.size));

      const dpofeCambio =
        force ||
        mapOfertas.size === 0 ||
        (curDpofe && (curDpofe.mtimeMs !== statDPOFE.mtimeMs || curDpofe.size !== statDPOFE.size));

      if (mapreCambio && curMapre) {
        // Estabilidad: si el archivo cambió hace menos de 1000 ms y no es forzado, esperar al siguiente ciclo
        if (!force && mapProductos.size > 0 && Date.now() - curMapre.mtimeMs < 1000) {
          console.log("[POS] POSMAPRE.DBF en modificación activa, se reintentará en el siguiente ciclo");
        } else {
          try {
            await cargarMAPRE(curMapre);
          } catch (err) {
            console.error("[POS] Error leyendo POSMAPRE.DBF, se conserva caché anterior:", err.message);
          }
        }
      }

      if (dpofeCambio && curDpofe) {
        if (!force && mapOfertas.size > 0 && Date.now() - curDpofe.mtimeMs < 1000) {
          console.log("[POS] POSDPOFE.DBF en modificación activa, se reintentará en el siguiente ciclo");
        } else {
          try {
            await cargarDPOFE(curDpofe);
          } catch (err) {
            console.error("[POS] Error leyendo POSDPOFE.DBF, se conserva caché anterior:", err.message);
          }
        }
      }
    } finally {
      cargaPromesa = null;
    }
  })();

  return cargaPromesa;
}

async function cargarCache(force = false) {
  await verificarYRecargarCache(force || mapProductos.size === 0 || mapOfertas.size === 0);
}

function elegirMejorOferta(ofertas = []) {

  if (!ofertas.length) return null;

  const hoy = new Date();
  const yyyy = hoy.getFullYear();
  const mm = String(hoy.getMonth() + 1).padStart(2, '0');
  const dd = String(hoy.getDate()).padStart(2, '0');
  const hoyStr = `${yyyy}-${mm}-${dd}`;

  const vigentes = ofertas.filter(o => {
    if (!o.vigenciaFin) return true;
    const fin = String(o.vigenciaFin).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(fin)) {
      return fin >= hoyStr;
    }
    const m = fin.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) {
      const finIso = `${m[3]}-${m[2]}-${m[1]}`;
      return finIso >= hoyStr;
    }
    return fin >= hoyStr;
  });

  if (!vigentes.length) return null;

  return vigentes.reduce((mejor, actual) => {
    if (!mejor) return actual;

    const a = cleanNum(actual.precioOferta);
    const b = cleanNum(mejor.precioOferta);

    return a < b ? actual : mejor;
  }, null);
}

// =============================
// Obtener producto
// =============================

async function getProductoPorSku(skuRaw) {

  if (mapProductos.size === 0) {
    await cargarCache();
  }

  const sku = normalizeSku(skuRaw);

  if (!sku) {
    return {
      ok: false,
      foundInExcel: false,
      foundInDPOFE: false,
      producto: null
    };
  }
	const base = mapProductos.get(sku) || null;

	const ofertas = mapOfertas.get(sku) || [];
	const mejorOferta = elegirMejorOferta(ofertas);

	if (!base && ofertas.length === 0) {
	  return {
		ok: true,
		foundInExcel: false,
		foundInDPOFE: false,
		producto: null
	  };
	}

	return {
	  ok: true,
	  foundInExcel: !!base,
	  foundInDPOFE: ofertas.length > 0,
	  producto: {
		sku,
		descripcion: base?.descripcion ?? "",
		marca: base?.marca ?? "",
		contenido: base?.contenido ?? "",
		ean13: base?.ean13 ?? "",
		imagenUrl: null,
		unidadMedida: base?.unidadMedida ?? "", 
		precioNormal: cleanNum(base?.precioNormal),
		precioUnitario: cleanNum(base?.precioUnitario),

		precioOferta: mejorOferta ? cleanNum(mejorOferta.precioOferta) : null,

		vigenciaInicio: mejorOferta?.vigenciaInicio ?? null,
		vigenciaFin: mejorOferta?.vigenciaFin ?? null
	  }
	};
}

// =============================
// Obtener varios
// =============================

async function getProductosPorSku(listaSku = []) {

  if (mapProductos.size === 0) {
    await cargarCache();
  }

  return listaSku
    .map(normalizeSku)
    .filter(Boolean)
    .map(sku => {

      const base = mapProductos.get(sku) || null;

		const ofertas = mapOfertas.get(sku) || [];
		const mejorOferta = elegirMejorOferta(ofertas);

		if (!base && ofertas.length === 0) {
		  return {
			ok: true,
			foundInExcel: false,
			foundInDPOFE: false,
			producto: null
		  };
		}

		return {
		  ok: true,
		  foundInExcel: !!base,
		  foundInDPOFE: ofertas.length > 0,
		  producto: {
			sku,
			descripcion: base?.descripcion ?? "",
			marca: base?.marca ?? "",
			contenido: base?.contenido ?? "",
			ean13: base?.ean13 ?? "",
			imagenUrl: null,
			unidadMedida: base?.unidadMedida ?? "", 
			precioNormal: cleanNum(base?.precioNormal),
			precioUnitario: cleanNum(base?.precioUnitario),

			precioOferta: mejorOferta ? cleanNum(mejorOferta.precioOferta) : null,

			vigenciaInicio: mejorOferta?.vigenciaInicio ?? null,
			vigenciaFin: mejorOferta?.vigenciaFin ?? null
		  }
		};
    })
    .filter(Boolean);
}

// =============================
// Revisión periódica de cambios DBF
// =============================

setInterval(() => {
  verificarYRecargarCache();
}, INTERVALO_REVISION_MS);

// =============================
// Exports
// =============================

module.exports = {
  getProductoPorSku,
  getProductosPorSku,
  cargarCache,
  verificarYRecargarCache
};