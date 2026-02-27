// services/zebra.service.js
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { port, apiToken, printMode } = require('../config/env');

// etiquetas / textos (ajusta según tus .CH)
const LABELS = {
  LBL_037: "OFERTA",  // equiv a LBL_037 en CHI_ETIQUETAS.ch
  LBL_038: "HASTA ",  // equiv a LBL_038
  SIMBOLO_MONEDA: "$",
};

// ---- genera EPL equivalente al código VFP que mostraste
function buildEplEtiqueta({
  descripIzq,
  descripDer,
  precio,
  barra,
  fechaTermino,
  codigo,
  comision,
}) {
  const q = '"';
  const eol = '\r\n';

  descripIzq = (descripIzq ?? '').toString().trim();
  descripDer = (descripDer ?? '').toString().trim();
  precio = (precio ?? '').toString().trim();
  barra = (barra ?? '').toString().trim();
  fechaTermino = (fechaTermino ?? '').toString().trim();
  codigo = (codigo ?? '').toString().trim();
  comision = (comision ?? '').toString().trim();

  const lines = [
    'N',
    'Q590,B160+0',
    'R0,0',
    'S2',
    'D5',
    'ZB',
    `A630,81,1,4,3,3,N,${q}${LABELS.LBL_037}${q}`,
    `A590,391,1,1,2,1,N,${q}${LABELS.LBL_038}${fechaTermino}${q}`,
    `A550,3,1,2,4,2,N,${q}${descripIzq}${q}`,
    `A490,1,1,2,4,2,N,${q}${descripDer}${q}`,
    `A410,71,1,4,5,4,N,${q}${LABELS.SIMBOLO_MONEDA}${q}`,
    `A420,15,1,4,6,4,N,${q}${precio}${q}`,
    `A295,10,1,2,1,1,N,${q}${codigo}${q}`,
    `A270,580,1,2,1,1,N,${q}${comision}${q}`,
    `B295,171,1,E30,3,30,80,B,${q}${barra}${q}`,
    'P1',
  ];

  return lines.join(eol) + eol;
}

// ---- envío TCP (impresora con IP)
function sendEplTcp(epl) {
  const zebraHost = process.env.ZEBRA_HOST || '192.168.1.50';
  const zebraPort = parseInt(process.env.ZEBRA_PORT || '9100', 10);
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    client.connect(zebraPort, zebraHost, () => {
      client.write(epl, 'utf8', () => client.end());
    });
    client.on('error', reject);
    client.on('close', resolve);
  });
}

// services/zebra.service.js (solo esta función)
function sendEplWindowsRaw(epl) {
  const sharePath = process.env.ZEBRA_SHARE_PATH; // p.ej. "\\\\localhost\\flejes"
  console.log('>> sendEplWindowsRaw sharePath:', sharePath);

  const dstRaw = (sharePath || '').trim();
  if (!dstRaw || !dstRaw.startsWith('\\\\')) {
    throw new Error(`sharePath inválido para impresión RAW: "${sharePath}"`);
  }

  // Archivo temporal (escribe como bytes para evitar problemas de codificación)
  const tmpName = `label_${Date.now()}.epl`;
  const tempPath = path.join(os.tmpdir(), tmpName);
  fs.writeFileSync(tempPath, Buffer.from(epl, 'utf8'));

  const src = path.win32.normalize(tempPath);
  const dst = dstRaw;
  const dstIp = /^\\\\localhost\\/i.test(dstRaw)
    ? dstRaw.replace(/^\\\\localhost\\/i, '\\\\127.0.0.1\\')
    : null;

  const execCopy = (target) =>
    new Promise((resolve, reject) => {
      execFile(
        'cmd.exe',
        ['/d', '/c', 'copy', '/y', '/b', src, target],
        { windowsHide: true },
        (error, stdout, stderr) => {
          if (error) return reject(Object.assign(error, { stdout, stderr }));
          resolve(stdout);
        }
      );
    });

  const execPrint = (target) =>
    new Promise((resolve, reject) => {
      execFile(
        'cmd.exe',
        ['/d', '/c', 'print', `/D:${target}`, src],
        { windowsHide: true },
        (error, stdout, stderr) => {
          if (error) return reject(Object.assign(error, { stdout, stderr }));
          resolve(stdout);
        }
      );
    });

  return (async () => {
    try {
      const out1 = await execCopy(dst);
      return `copy: ${out1 || 'OK'}`;
    } catch (_e1) {
      try {
        if (dstIp) {
          const out2 = await execCopy(dstIp);
          return `copy(ip): ${out2 || 'OK'}`;
        }
      } catch (_e2) {
        // ignoramos y probamos print
      }
      const out3 = await execPrint(dst);
      return `print: ${out3 || 'OK'}`;
    }
  })().finally(() => {
    fs.unlink(tempPath, () => {});
  });
}

async function sendEtiqueta(epl) {
  console.log('[v0] sendEtiqueta - printMode:', printMode);
  
  if (printMode === 'tcp') return sendEplTcp(epl);
  if (printMode === 'windows-raw') return sendEplWindowsRaw(epl);
  if (printMode === 'mock-epl') {
    // Modo mock: guarda el archivo localmente
    const outDir = path.join(__dirname, '..', 'mock-prints');
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    const filePath = path.join(outDir, `mock_${Date.now()}.epl`);
    fs.writeFileSync(filePath, epl, 'utf8');
    console.log(`[MOCK] EPL guardado en: ${filePath}`);
    return { filePath };
  }
  throw new Error(`Modo de impresión no soportado: ${printMode}`);
}

// ---- usa un producto de posmapre y arma la etiqueta
async function printEtiquetaOferta(producto) {
  const payload = {
    descripIzq:
      producto?.DESPROD ??
      producto?.DESCRIPCION ??
      '',
    descripDer: '',
    precio:
      producto?.PRECIO_OFERTA ??
      producto?.PRECIO ??
      producto?.PRECIO1 ??
      '',
    barra:
      producto?.CODBARRA ??
      producto?.CODBAR ??
      '',
    fechaTermino: producto?.FEC_TERMINO ?? '',
    codigo:
      producto?.CODPROD ??
      producto?.CODIGO ??
      producto?.COD ??
      '',
    comision: producto?.COMISION ?? '0',
  };

  const epl = buildEplEtiqueta(payload);
  return sendEtiqueta(epl);
}

module.exports = {
  printEtiquetaOferta,
};
``
