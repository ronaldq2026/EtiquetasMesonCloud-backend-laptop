// config/printer.js
const fs = require("fs");
const path = require("path");

function printZpl(zpl) {
  return new Promise((resolve) => {
    const outDir = path.join(__dirname, "..", "mock-prints");

    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    // ⚠️ si quieres generar EPL, cambia ".zpl" por ".epl"
    const filePath = path.join(outDir, `mock_${Date.now()}.epl`);

    fs.writeFileSync(filePath, zpl, "utf8");

    console.log(`[MOCK] EPL guardado en: ${filePath}`);
    resolve({ filePath });
  });
}

module.exports = { printZpl };