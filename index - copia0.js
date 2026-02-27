// index.js
const express = require("express");
const cors = require("cors");

const { port, apiToken } = require("./config/env");
const { getFirstProducto } = require("./services/pos.service");
const { printEtiquetaOferta } = require("./services/zebra.service");
const mesonRoutes = require('./routes/meson.routes');

const app = express();
app.use(cors());
app.use(express.json());
app.use(mesonRoutes);

// --- Auth sencilla por token (opcional pero recomendable)
app.use((req, res, next) => {
  // Frontend enviará este header
  const token = req.headers["x-api-token"];
  if (!apiToken) return next(); // si no definiste API_TOKEN, no valida nada

  if (token !== apiToken) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
});

// Healthcheck
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// 1) Demo: obtener primer producto del DBF
app.get("/api/pos/producto-demo", async (_req, res) => {
  try {
    const producto = await getFirstProducto(); // [pos.service.js](https://farmaciasahumadacl-my.sharepoint.com/personal/ronald_quiroga_ahumada_cl/Documents/Archivos%20de%20Microsoft%C2%A0Copilot%20Chat/pos.service.js?EntityRepresentationId=f0d55951-a6f8-44af-bb6d-d9d0e482351b) [1](https://farmaciasahumadacl-my.sharepoint.com/personal/ronald_quiroga_ahumada_cl/Documents/Archivos%20de%20Microsoft%C2%A0Copilot%20Chat/pos.service.js)
    if (!producto) {
      return res.status(404).json({ message: "No se encontraron productos" });
    }
    res.json({ producto });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error leyendo DBF" });
  }
});

// 2) Demo: imprimir etiqueta de oferta para el primer producto
app.post("/api/pos/print-demo", async (_req, res) => {
  try {
    const producto = await getFirstProducto(); // [pos.service.js](https://farmaciasahumadacl-my.sharepoint.com/personal/ronald_quiroga_ahumada_cl/Documents/Archivos%20de%20Microsoft%C2%A0Copilot%20Chat/pos.service.js?EntityRepresentationId=f0d55951-a6f8-44af-bb6d-d9d0e482351b) [1](https://farmaciasahumadacl-my.sharepoint.com/personal/ronald_quiroga_ahumada_cl/Documents/Archivos%20de%20Microsoft%C2%A0Copilot%20Chat/pos.service.js)
    if (!producto) {
      return res.status(404).json({ message: "No se encontraron productos" });
    }

    // genera EPL y envía a Zebra (TCP o windows-raw)
    await printEtiquetaOferta(producto); // [zebra.service.js](https://farmaciasahumadacl-my.sharepoint.com/personal/ronald_quiroga_ahumada_cl/Documents/Archivos%20de%20Microsoft%C2%A0Copilot%20Chat/zebra.service.js?EntityRepresentationId=1076987f-e434-467d-8019-1a21ebad56f1) [2](https://farmaciasahumadacl-my.sharepoint.com/personal/ronald_quiroga_ahumada_cl/Documents/Archivos%20de%20Microsoft%C2%A0Copilot%20Chat/zebra.service.js)

    res.status(201).json({ status: "printed", producto });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error imprimiendo etiqueta" });
  }
});

app.listen(port, () => {
  console.log(`Backend POS escuchando en puerto ${port}`);
});