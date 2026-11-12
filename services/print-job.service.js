const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { printEtiquetasBatch } = require('./zebra.service');

const PRODUCT_BATCH_SIZE = 100;
const DATA_DIR = process.env.PRINT_JOBS_DIR || path.join(__dirname, '..', 'data');
const STATE_PATH = path.join(DATA_DIR, 'print-jobs.json');
const STATE_BACKUP_PATH = `${STATE_PATH}.bak`;
const AUDIT_PATH = path.join(DATA_DIR, 'print-audit.jsonl');
const AUDIT_MAX_BYTES = 10 * 1024 * 1024;

let mutationQueue = Promise.resolve();
const activeBatches = new Set();

function now() {
  return new Date().toISOString();
}

function enqueueMutation(work) {
  const next = mutationQueue.then(work, work);
  mutationQueue = next.catch(() => {});
  return next;
}

async function ensureDataDir() {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      try {
        const backup = await fs.promises.readFile(STATE_BACKUP_PATH, 'utf8');
        return JSON.parse(backup);
      } catch (_) {
        throw new Error(`No se pudo leer el estado persistente: ${error.message}`);
      }
    }
    return fallback;
  }
}

async function atomicWriteJson(filePath, value, backupPath = null) {
  await ensureDataDir();
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const handle = await fs.promises.open(tempPath, 'w');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  // The temporary file is complete and synced before the replacement. A backup
  // remains available if Windows or a process interruption leaves the primary
  // file unavailable during replacement.
  if (backupPath) {
    try {
      const currentContent = await fs.promises.readFile(filePath, 'utf8');
      JSON.parse(currentContent);
      await fs.promises.copyFile(filePath, backupPath);
    } catch (error) {
      if (error.code !== 'ENOENT' && error instanceof SyntaxError) {
        // Keep the last known-good backup when the primary is corrupt.
      } else if (error.code !== 'ENOENT') {
        await fs.promises.unlink(tempPath).catch(() => {});
        throw error;
      }
    }
  }

  try {
    await fs.promises.rename(tempPath, filePath);
  } catch (error) {
    // Windows may reject rename when the destination exists. The previous
    // valid state is already in backupPath, so replacing the primary remains
    // recoverable even if the process stops between these two operations.
    if (backupPath && (error.code === 'EEXIST' || error.code === 'EPERM')) {
      try {
        await fs.promises.unlink(filePath);
        await fs.promises.rename(tempPath, filePath);
        return;
      } catch (fallbackError) {
        await fs.promises.unlink(tempPath).catch(() => {});
        throw new Error(`No se pudo reemplazar el estado persistente: ${fallbackError.message}`);
      }
    }
    await fs.promises.unlink(tempPath).catch(() => {});
    throw new Error(`No se pudo reemplazar el estado persistente: ${error.message}`);
  }
}

async function appendAudit(event) {
  await ensureDataDir();
  try {
    const stat = await fs.promises.stat(AUDIT_PATH);
    if (stat.size >= AUDIT_MAX_BYTES) {
      const archive = path.join(
        DATA_DIR,
        `print-audit-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
      );
      await fs.promises.rename(AUDIT_PATH, archive);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.promises.appendFile(
    AUDIT_PATH,
    `${JSON.stringify({ timestamp: now(), ...event })}\n`,
    'utf8'
  );
}

async function loadState() {
  const state = await readJson(STATE_PATH, { version: 1, jobs: {} });
  if (!state || typeof state !== 'object' || !state.jobs) {
    throw new Error('El archivo de trabajos de impresión no tiene un formato válido');
  }
  return state;
}

function summarize(job) {
  const batches = job.batches;
  const confirmed = batches.filter((batch) => batch.status === 'spooler_confirmed');
  const uncertain = batches.filter((batch) => batch.status === 'uncertain');
  const failed = batches.filter((batch) => batch.status === 'failed');
  const pending = batches.filter((batch) => batch.status === 'pending');
  const sending = batches.filter((batch) => batch.status === 'sending');
  const completedProducts = confirmed.reduce((sum, batch) => sum + batch.productCount, 0);
  const status = confirmed.length === batches.length
    ? 'completed'
    : uncertain.length || failed.length
      ? 'interrupted'
      : sending.length || confirmed.length
        ? 'in_progress'
        : 'pending';

  return {
    printId: job.printId,
    origin: job.origin,
    status,
    totalProducts: job.totalProducts,
    totalBatches: batches.length,
    completedProducts,
    pendingProducts: job.totalProducts - completedProducts,
    confirmedBatches: confirmed.map((batch) => batch.batchNumber),
    pendingBatches: pending.map((batch) => batch.batchNumber),
    failedBatches: failed.map((batch) => batch.batchNumber),
    uncertainBatches: uncertain.map((batch) => batch.batchNumber),
    uploadedBatches: batches.filter((batch) => batch.uploaded).map((batch) => batch.batchNumber),
    currentBatch: batches.find((batch) => batch.status === 'sending')?.batchNumber ||
      batches.find((batch) => batch.status === 'pending')?.batchNumber ||
      uncertain[0]?.batchNumber || null,
    batches: batches.map(({ products, ...batch }) => batch)
  };
}

async function recoverStaleSendingJobs(state) {
  let changed = false;
  for (const job of Object.values(state.jobs)) {
    for (const batch of job.batches) {
      if (batch.status === 'sending' && !activeBatches.has(`${job.printId}:${batch.batchNumber}`)) {
        batch.status = 'uncertain';
        batch.finishedAt = now();
        batch.error = 'El proceso se interrumpió mientras el lote estaba siendo enviado';
        job.updatedAt = now();
        changed = true;
        await appendAudit({
          type: 'batch_uncertain',
          printId: job.printId,
          batchNumber: batch.batchNumber,
          reason: 'stale_sending_recovered'
        });
      }
    }
  }
  if (changed) await atomicWriteJson(STATE_PATH, state, STATE_BACKUP_PATH);
  return state;
}

async function createPrintJob({ products = null, totalProducts, totalBatches, origin = 'unknown' }) {
  const suppliedProducts = Array.isArray(products) ? products : null;
  const productTotal = suppliedProducts ? suppliedProducts.length : Number(totalProducts);
  if (!Number.isInteger(productTotal) || productTotal <= 0) {
    throw new Error('La impresión masiva requiere al menos un producto');
  }
  const batchTotal = suppliedProducts
    ? Math.ceil(productTotal / PRODUCT_BATCH_SIZE)
    : Number(totalBatches);
  if (!Number.isInteger(batchTotal) || batchTotal <= 0) {
    throw new Error('La impresión masiva requiere un número válido de lotes');
  }
  return enqueueMutation(async () => {
    const state = await loadState();
    const printId = crypto.randomUUID();
    const batches = [];
    for (let i = 0; i < productTotal; i += PRODUCT_BATCH_SIZE) {
      const batchProducts = suppliedProducts ? suppliedProducts.slice(i, i + PRODUCT_BATCH_SIZE) : null;
      batches.push({
        batchNumber: batches.length + 1,
        productCount: batchProducts ? batchProducts.length : 0,
        products: batchProducts,
        uploaded: Boolean(batchProducts),
        status: 'pending',
        attempts: 0,
        createdAt: now()
      });
    }
    if (batches.length !== batchTotal) {
      throw new Error('El total de productos y lotes no coincide');
    }
    const job = {
      printId,
      origin,
      createdAt: now(),
      updatedAt: now(),
      totalProducts: productTotal,
      uploadedProducts: suppliedProducts ? productTotal : 0,
      originalPayload: suppliedProducts || [],
      batches
    };
    state.jobs[printId] = job;
    await atomicWriteJson(STATE_PATH, state, STATE_BACKUP_PATH);
    await appendAudit({
      type: 'job_started',
      printId,
      origin,
      totalProducts: job.totalProducts,
      totalBatches: batches.length
    });
    return summarize(job);
  });
}

async function uploadBatchPayload(printId, batchNumber, products) {
  if (!Array.isArray(products) || products.length === 0 || products.length > PRODUCT_BATCH_SIZE) {
    throw Object.assign(new Error(`Cada lote debe contener entre 1 y ${PRODUCT_BATCH_SIZE} productos`), { statusCode: 400 });
  }
  return enqueueMutation(async () => {
    const state = await recoverStaleSendingJobs(await loadState());
    const job = state.jobs[printId];
    if (!job) throw Object.assign(new Error('Trabajo no encontrado'), { statusCode: 404 });
    const batch = job.batches.find((item) => item.batchNumber === Number(batchNumber));
    if (!batch) throw Object.assign(new Error('Lote no encontrado'), { statusCode: 404 });
    if (batch.status === 'spooler_confirmed') return summarize(job);
    if (activeBatches.has(`${printId}:${batch.batchNumber}`)) {
      throw Object.assign(new Error('El lote ya está siendo procesado'), { statusCode: 409 });
    }
    if (batch.products) {
      if (JSON.stringify(batch.products) !== JSON.stringify(products)) {
        throw Object.assign(new Error('El lote ya fue persistido con un payload diferente'), { statusCode: 409 });
      }
      return summarize(job);
    }
    const expectedCount = Math.min(PRODUCT_BATCH_SIZE, job.totalProducts - (batch.batchNumber - 1) * PRODUCT_BATCH_SIZE);
    if (products.length !== expectedCount) {
      throw Object.assign(new Error(`El lote ${batch.batchNumber} debe contener ${expectedCount} productos`), { statusCode: 400 });
    }
    batch.products = products;
    batch.productCount = products.length;
    batch.uploaded = true;
    job.uploadedProducts += products.length;
    job.originalPayload = job.batches.flatMap((item) => item.products || []);
    job.updatedAt = now();
    await atomicWriteJson(STATE_PATH, state, STATE_BACKUP_PATH);
    await appendAudit({
      type: 'batch_payload_persisted',
      printId,
      batchNumber: batch.batchNumber,
      productCount: products.length
    });
    return summarize(job);
  });
}

async function getPrintJob(printId) {
  return enqueueMutation(async () => {
    const state = await recoverStaleSendingJobs(await loadState());
    const job = state.jobs[printId];
    if (!job) return null;
    return summarize(job);
  });
}

async function prepareBatch(printId, batchNumber, allowRetry) {
  return enqueueMutation(async () => {
    const state = await recoverStaleSendingJobs(await loadState());
    const job = state.jobs[printId];
    if (!job) throw Object.assign(new Error('Trabajo no encontrado'), { statusCode: 404 });
    const batch = job.batches.find((item) => item.batchNumber === Number(batchNumber));
    if (!batch) throw Object.assign(new Error('Lote no encontrado'), { statusCode: 404 });
    const lockKey = `${printId}:${batch.batchNumber}`;
    if (activeBatches.has(lockKey)) {
      throw Object.assign(new Error('El lote ya está siendo procesado'), { statusCode: 409 });
    }
    if (batch.status === 'spooler_confirmed') {
      return { alreadyConfirmed: true, job, batch };
    }
    if (!batch.products) {
      throw Object.assign(new Error('El payload del lote aún no ha sido persistido'), { statusCode: 409, code: 'payload_missing' });
    }
    if ((batch.status === 'uncertain' || batch.status === 'failed') && !allowRetry) {
      throw Object.assign(new Error(`El lote está ${batch.status} y requiere una acción explícita`), { statusCode: 409, code: batch.status });
    }
    activeBatches.add(lockKey);
    batch.status = 'sending';
    batch.attempts += 1;
    batch.startedAt = now();
    batch.error = undefined;
    job.updatedAt = now();
    await atomicWriteJson(STATE_PATH, state, STATE_BACKUP_PATH);
    await appendAudit({
      type: allowRetry ? 'batch_retry_started' : 'batch_started',
      printId,
      batchNumber: batch.batchNumber,
      attempt: batch.attempts,
      reason: allowRetry ? 'explicit_user_authorization' : undefined
    });
    return { alreadyConfirmed: false, job, batch, lockKey };
  });
}

async function processBatch(printId, batchNumber, { allowRetry = false } = {}) {
  const prepared = await prepareBatch(printId, batchNumber, allowRetry);
  if (prepared.alreadyConfirmed) return summarize(prepared.job);
  const { batch, lockKey } = prepared;
  try {
    const result = await printEtiquetasBatch(batch.products);
    return await enqueueMutation(async () => {
      const state = await loadState();
      const job = state.jobs[printId];
      const current = job.batches.find((item) => item.batchNumber === Number(batchNumber));
      current.status = 'spooler_confirmed';
      current.finishedAt = now();
      current.result = result;
      job.updatedAt = now();
      await atomicWriteJson(STATE_PATH, state, STATE_BACKUP_PATH);
      await appendAudit({
        type: 'batch_spooler_confirmed',
        printId,
        batchNumber: current.batchNumber,
        labelsSent: result.etiquetasEnviadas
      });
      if (state.jobs[printId].batches.every((item) => item.status === 'spooler_confirmed')) {
        await appendAudit({ type: 'job_completed', printId });
      }
      return summarize(job);
    });
  } catch (error) {
    await enqueueMutation(async () => {
      const state = await loadState();
      const job = state.jobs[printId];
      const current = job.batches.find((item) => item.batchNumber === Number(batchNumber));
      current.status = 'failed';
      current.finishedAt = now();
      current.error = error.message;
      job.updatedAt = now();
      await atomicWriteJson(STATE_PATH, state, STATE_BACKUP_PATH);
      await appendAudit({
        type: 'batch_failed',
        printId,
        batchNumber: current.batchNumber,
        error: error.message
      });
    });
    throw error;
  } finally {
    activeBatches.delete(lockKey);
  }
}

async function retryUncertainBatch(printId, batchNumber, confirmation) {
  if (confirmation !== true) {
    throw Object.assign(new Error('Se requiere confirmación explícita para reintentar'), { statusCode: 400 });
  }
  return processBatch(printId, batchNumber, { allowRetry: true });
}

module.exports = {
  PRODUCT_BATCH_SIZE,
  createPrintJob,
  uploadBatchPayload,
  getPrintJob,
  processBatch,
  retryUncertainBatch,
  paths: { STATE_PATH, STATE_BACKUP_PATH, AUDIT_PATH }
};
