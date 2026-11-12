// routes/print.routes.js
const express = require('express');
const router = express.Router();
const axios = require('axios');

const {
  buildEtiqueta,
  printEtiquetas
} = require('../services/zebra.service');
const {
  createPrintJob,
  uploadBatchPayload,
  getPrintJob,
  processBatch,
  retryUncertainBatch
} = require('../services/print-job.service');

// -------------------------------
// Utils
// -------------------------------
function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) {
      out[k] = obj[k];
    }
  }
  return out;
}

// -------------------------------
// Imprimir etiquetas (individual o batch)
// -------------------------------
router.post('/api/labels/print', async (req, res) => {
  console.log('🔥 PRINT CALLED', {
    time: new Date().toISOString(),
    isArray: Array.isArray(req.body),
    items: Array.isArray(req.body) ? req.body.length : 1
  });

  try {
    const result = await printEtiquetas(req.body); // ✅ dispatcher único
    res.json(result);
  } catch (err) {
    console.error('[labels/print] error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------------------
// Impresión masiva persistente
// -------------------------------
router.post('/api/labels/print/jobs', async (req, res) => {
  try {
    const { products, totalProducts, totalBatches, origin } = req.body || {};
    const job = await createPrintJob({ products, totalProducts, totalBatches, origin });
    res.status(201).json(job);
  } catch (err) {
    console.error('[labels/print/jobs] create error:', err);
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.post('/api/labels/print/jobs/:printId/batches/:batchNumber/payload', async (req, res) => {
  try {
    const job = await uploadBatchPayload(
      req.params.printId,
      req.params.batchNumber,
      req.body?.products
    );
    res.json(job);
  } catch (err) {
    console.error('[labels/print/jobs] payload error:', err);
    res.status(err.statusCode || 500).json({ ok: false, code: err.code, error: err.message });
  }
});

router.get('/api/labels/print/jobs/:printId', async (req, res) => {
  try {
    const job = await getPrintJob(req.params.printId);
    if (!job) return res.status(404).json({ ok: false, error: 'Trabajo no encontrado' });
    res.json(job);
  } catch (err) {
    console.error('[labels/print/jobs] get error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/api/labels/print/jobs/:printId/batches/:batchNumber', async (req, res) => {
  try {
    const job = await processBatch(req.params.printId, req.params.batchNumber);
    res.json(job);
  } catch (err) {
    console.error('[labels/print/jobs] batch error:', err);
    res.status(err.statusCode || 500).json({ ok: false, code: err.code, error: err.message });
  }
});

router.post('/api/labels/print/jobs/:printId/batches/:batchNumber/retry', async (req, res) => {
  try {
    const job = await retryUncertainBatch(
      req.params.printId,
      req.params.batchNumber,
      req.body?.confirmRisk === true
    );
    res.json(job);
  } catch (err) {
    console.error('[labels/print/jobs] retry error:', err);
    res.status(err.statusCode || 500).json({ ok: false, code: err.code, error: err.message });
  }
});

// -------------------------------
// Preview (Labelary)
// -------------------------------
router.post('/api/labels/preview', async (req, res) => {
  try {
    const payload = req.body;

    // ✅ ZPL desde template real
    const zpl = buildEtiqueta(payload);

    // ✅ 60x32 mm = 2.36 x 1.26 inches
    const response = await axios.post(
      'http://api.labelary.com/v1/printers/8dpmm/labels/2.36x1.26/0/',
      zpl,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        responseType: 'arraybuffer'
      }
    );

    res.set('Content-Type', 'image/png');
    res.send(response.data);

  } catch (err) {
    console.error('preview error', err);
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

// -------------------------------
// Exportar ZPL o imprimir según modo
// -------------------------------
router.post('/api/print/export-html', async (req, res) => {
  try {
    const { product, config, mode } = req.body || {};

    const payload = {
      producto: product?.producto ?? product?.nombre ?? '',
      sku: product?.sku ?? product?.codigo ?? '',
      codigoBarras: product?.codigoBarras ?? '',
      cantidad: config?.cantidad ?? product?.cantidad ?? 1,

      precioNormal: product?.precioNormal,
      precioOferta: product?.precioOferta,
      precioUnitario: product?.precioUnitario,
      unidadMedida: product?.unidadMedida,

      validoHasta: product?.validoHasta,
      vigenciaFin: product?.vigenciaFin
    };

    const zpl = buildEtiqueta(payload);

    if (mode === 'print') {
      await printEtiquetas(payload);
      return res.json({ ok: true, mode });
    }

    res.setHeader('Content-Type', 'application/zpl');
    res.setHeader('Content-Disposition', 'attachment; filename="etiqueta.zpl"');
    return res.send(zpl);

  } catch (err) {
    console.error('[print/export-html] error:', err);
    res.status(500).json({
      ok: false,
      error: err.message,
      stack: err.stack
    });
  }
});

module.exports = router;
``
