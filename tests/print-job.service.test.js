const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impetiq-print-jobs-'));
process.env.PRINT_JOBS_DIR = testDir;

const zebraPath = require.resolve('../services/zebra.service');
let calls = 0;
let failNext = false;
require.cache[zebraPath] = {
  id: zebraPath,
  filename: zebraPath,
  loaded: true,
  exports: {
    printEtiquetasBatch: async (products) => {
      calls += 1;
      if (failNext) {
        failNext = false;
        throw new Error('simulated spooler failure');
      }
      return {
        ok: true,
        recibidos: products.length,
        etiquetasGeneradas: products.length,
        lotesPreparados: 1,
        lotesEnviados: 1,
        etiquetasEnviadas: products.length
      };
    }
  }
};

const jobs = require('../services/print-job.service');

function products(count) {
  return Array.from({ length: count }, (_, index) => ({ sku: String(index + 1), cantidad: 1 }));
}

async function main() {
  const small = await jobs.createPrintJob({ products: products(3), origin: 'test-3' });
  assert.equal(small.totalBatches, 1);
  const hundred = await jobs.createPrintJob({ products: products(100), origin: 'test-100' });
  assert.equal(hundred.totalBatches, 1);
  const large = await jobs.createPrintJob({ products: products(900), origin: 'test-900' });
  assert.equal(large.totalBatches, 9);
  const persistedLarge = JSON.parse(await fs.promises.readFile(jobs.paths.STATE_PATH, 'utf8')).jobs[large.printId];
  assert.equal(persistedLarge.originalPayload.length, 900);
  assert.equal(persistedLarge.batches[0].products[0].sku, '1');
  assert.equal(persistedLarge.batches[8].products[99].sku, '900');
  assert.ok(fs.existsSync(jobs.paths.STATE_BACKUP_PATH));

  const chunked = await jobs.createPrintJob({ totalProducts: 900, totalBatches: 9, origin: 'test-uploaded-chunks' });
  for (let batchNumber = 1; batchNumber <= 9; batchNumber += 1) {
    await jobs.uploadBatchPayload(chunked.printId, batchNumber, products(900).slice((batchNumber - 1) * 100, batchNumber * 100));
  }
  const persistedChunked = JSON.parse(await fs.promises.readFile(jobs.paths.STATE_PATH, 'utf8')).jobs[chunked.printId];
  assert.equal(persistedChunked.originalPayload.length, 900);
  assert.equal(persistedChunked.batches[8].products[99].sku, '900');

  for (const batchNumber of [1, 2, 3]) {
    await jobs.processBatch(large.printId, batchNumber);
  }
  let state = await jobs.getPrintJob(large.printId);
  assert.deepEqual(state.confirmedBatches, [1, 2, 3]);
  assert.deepEqual(state.pendingBatches, [4, 5, 6, 7, 8, 9]);

  await jobs.processBatch(large.printId, 1);
  state = await jobs.getPrintJob(large.printId);
  assert.deepEqual(state.confirmedBatches, [1, 2, 3]);

  for (const batchNumber of [4, 5, 6, 7, 8, 9]) {
    await jobs.processBatch(large.printId, batchNumber);
  }
  state = await jobs.getPrintJob(large.printId);
  assert.equal(state.status, 'completed');
  assert.equal(state.completedProducts, 900);

  failNext = true;
  const failed = await jobs.createPrintJob({ products: products(100), origin: 'test-failed' });
  await assert.rejects(() => jobs.processBatch(failed.printId, 1));
  state = await jobs.getPrintJob(failed.printId);
  assert.deepEqual(state.failedBatches, [1]);
  await assert.rejects(() => jobs.processBatch(failed.printId, 1), /requiere una acción explícita/);
  await jobs.retryUncertainBatch(failed.printId, 1, true);

  const interrupted = await jobs.createPrintJob({ products: products(100), origin: 'test-restart' });
  const statePath = jobs.paths.STATE_PATH;
  const persisted = JSON.parse(await fs.promises.readFile(statePath, 'utf8'));
  persisted.jobs[interrupted.printId].batches[0].status = 'sending';
  await fs.promises.writeFile(statePath, JSON.stringify(persisted), 'utf8');
  delete require.cache[require.resolve('../services/print-job.service')];
  const restartedJobs = require('../services/print-job.service');
  state = await restartedJobs.getPrintJob(interrupted.printId);
  assert.deepEqual(state.uncertainBatches, [1]);
  await assert.rejects(() => restartedJobs.processBatch(interrupted.printId, 1), /requiere una acción explícita/);
  await assert.rejects(() => restartedJobs.retryUncertainBatch(interrupted.printId, 1, false), /confirmación explícita/);
  state = await restartedJobs.retryUncertainBatch(interrupted.printId, 1, true);
  assert.equal(state.status, 'completed');

  const audit = await fs.promises.readFile(jobs.paths.AUDIT_PATH, 'utf8');
  assert.ok(audit.includes('job_started'));
  assert.ok(audit.includes('batch_spooler_confirmed'));
  assert.ok(audit.includes('batch_failed'));
  assert.ok(audit.includes('batch_uncertain'));
  assert.ok(calls >= 5);

  await fs.promises.writeFile(jobs.paths.STATE_PATH, '{ incomplete', 'utf8');
  const recoveredFromBackup = await restartedJobs.getPrintJob(large.printId);
  assert.equal(recoveredFromBackup.status, 'completed');

  await fs.promises.rm(testDir, { recursive: true, force: true });
  console.log('print-job.service tests passed');
}

main().catch(async (error) => {
  await fs.promises.rm(testDir, { recursive: true, force: true }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
});
