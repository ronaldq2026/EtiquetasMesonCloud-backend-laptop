// services/zebra.service.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

// ------------------------------------------------
// CONFIG
// ------------------------------------------------
const TEMPLATE_PATH =
  path.join(__dirname, '/zpl/etiqueta_60x32_base.zpl');

const PRINTER_SHARE =
  process.env.ZEBRA_SHARE_PATH || '\\\\localhost\\Zebra';

// ------------------------------------------------
// HELPERS
// ------------------------------------------------
function toNumber(val) {
  if (val === null || val === undefined) return null;
  return typeof val === 'number' ? val : Number(val);
}

function fmtCLP(val) {
  const n = toNumber(val);
  if (n === null) return '$0';
  return '$' + Math.round(n).toLocaleString('es-CL');
}

function formatDateCL(date) {
  if (!date) return '';

  // ✅ Si ya viene en formato DD/MM/YYYY, devolver tal cual
  if (typeof date === 'string') {
    const s = date.trim();
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
      return s;
    }

    // ✅ Si viene en formato YYYY-MM-DD
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      return `${m[3]}/${m[2]}/${m[1]}`;
    }

    // Limpiar textos como
    date = s.replace(/\s*\(.*\)$/, '');
  }

  const d = new Date(date);
  if (isNaN(d.getTime())) return '';

  return `${String(d.getUTCDate()).padStart(2,'0')}/${
    String(d.getUTCMonth() + 1).padStart(2,'0')
  }/${d.getUTCFullYear()}`;
}

// ------------------------------------------------
// BUILD ZPL
// ------------------------------------------------
function buildEtiqueta(data) {

  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

  // -------------------------
  // Precios
  // -------------------------
  const precioNormalFmt = fmtCLP(data.precioNormal);
  const precioOfertaFmt = fmtCLP(data.precioOferta);

  const precioFinal = data.precioOferta
    ? precioOfertaFmt
    : precioNormalFmt;

  const mostrarPrecioNormal =
    data.precioOferta &&
    data.precioNormal &&
    data.precioNormal !== data.precioOferta;

  const precioNormalPrint = mostrarPrecioNormal
    ? precioNormalFmt
    : '';

  const precioUnit = fmtCLP(data.precioUnitario);

  // -------------------------
  // Fecha (YA CORRECTA)
  // -------------------------
  const validoHasta = formatDateCL(
    data.validoHasta || data.vigenciaFin
  );

  // -------------------------
  // EAN (compatibilidad)
  // -------------------------
  const ean = data.ean13 || data.codigoBarras || '';

  return template
    .replace('{PRODUCTO}', data.producto || '')
    .replace('{PRECIO_NORMAL}', precioNormalPrint)
    .replace('{PRECIO}', precioFinal || '')
    .replace('{PRECIO_UNIT}', precioUnit || '')
    .replace('{UM}', data.unidadMedida || '')
    .replace(/{EAN13}/g, ean)
    .replace('{SKU}', data.sku || '')
    .replace('{FECHA}', validoHasta || '');
}

const LOTE_SIZE = 50;

// ------------------------------------------------
// PRINT RAW WINDOWS
// ------------------------------------------------
async function sendWindowsRaw(zpl) {
  const uniqueId = `${Date.now()}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const tmp = path.join(os.tmpdir(), `label_batch_${uniqueId}.zpl`);

  await fs.promises.writeFile(tmp, zpl, 'utf8');

  try {
    await new Promise((resolve, reject) => {
      execFile(
        'cmd.exe',
        ['/d', '/c', 'copy', '/y', '/b', tmp, PRINTER_SHARE],
        { windowsHide: true },
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  } finally {
    // Controlar y esperar el borrado del archivo temporal
    await fs.promises.unlink(tmp).catch(() => {});
  }
}

// ------------------------------------------------
// API
// ------------------------------------------------
async function printEtiquetaOferta(payload) {
  const zpl = buildEtiqueta(payload);
  await sendWindowsRaw(zpl);
  return {
    ok: true,
    recibidos: 1,
    etiquetasGeneradas: 1,
    lotesPreparados: 1,
    lotesEnviados: 1,
    etiquetasEnviadas: 1
  };
}

async function printEtiquetasBatch(productos = []) {
  if (!Array.isArray(productos) || productos.length === 0) {
    return {
      ok: true,
      recibidos: 0,
      etiquetasGeneradas: 0,
      lotesPreparados: 0,
      lotesEnviados: 0,
      etiquetasEnviadas: 0
    };
  }

  // 1. Generar todas las etiquetas respetando exactamente el orden original
  const todasLasEtiquetas = [];
  for (const p of productos) {
    const qty = Math.max(1, Number(p.cantidad) || 1);
    const zpl = buildEtiqueta(p).trim();
    for (let i = 0; i < qty; i++) {
      todasLasEtiquetas.push(zpl);
    }
  }

  // 2. Concatenar en lotes de 50 etiquetas conservando bloques ^XA...^XZ
  const lotes = [];
  for (let i = 0; i < todasLasEtiquetas.length; i += LOTE_SIZE) {
    lotes.push(todasLasEtiquetas.slice(i, i + LOTE_SIZE));
  }

  let lotesEnviados = 0;
  let etiquetasEnviadas = 0;

  // 3. Enviar secuencialmente cada lote a Windows
  for (let idx = 0; idx < lotes.length; idx++) {
    const lote = lotes[idx];
    const zplConcat = lote.join('\n') + '\n';

    try {
      await sendWindowsRaw(zplConcat);
      lotesEnviados++;
      etiquetasEnviadas += lote.length;

      // Pausa controlada entre lotes para registro del spooler
      if (idx < lotes.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (err) {
      console.error(`[ZEBRA] Error enviando lote ${idx + 1}/${lotes.length}:`, err.message);
      throw new Error(
        `Fallo al enviar lote ${idx + 1}/${lotes.length} (${etiquetasEnviadas}/${todasLasEtiquetas.length} etiquetas enviadas antes del error): ${err.message}`
      );
    }
  }

  return {
    ok: true,
    recibidos: productos.length,
    etiquetasGeneradas: todasLasEtiquetas.length,
    lotesPreparados: lotes.length,
    lotesEnviados,
    etiquetasEnviadas
  };
}

async function printEtiquetas(payload) {
  const lista = Array.isArray(payload) ? payload : [payload];
  return printEtiquetasBatch(lista);
}

module.exports = {
	buildEtiqueta,
  printEtiquetaOferta,
  printEtiquetasBatch,
  printEtiquetas  
};