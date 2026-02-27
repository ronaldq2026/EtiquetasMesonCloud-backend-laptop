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

// --- Auth por token (si definiste API_TOKEN)
app.use((req, res, next) => {
  const token = req.headers["x-api-token"];
  if (!apiToken) return next();         // si no hay token configurado, no valida
  if (token !== apiToken) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
});

// Rutas de negocio (mesón + excel)
app.use(mesonRoutes);

// Healthcheck
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Demos
app.get("/api/pos/producto-demo", async (_req, res) => {
  try {
    const producto = await getFirstProducto();
    if (!producto) return res.status(404).json({ message: "No se encontraron productos" });
    res.json({ producto });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error leyendo DBF" });
  }
});

app.post("/api/pos/print-demo", async (_req, res) => {
  try {
    const producto = await getFirstProducto();
    if (!producto) return res.status(404).json({ message: "No se encontraron productos" });
    await printEtiquetaOferta(producto);
    res.status(201).json({ status: "printed", producto });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error imprimiendo etiqueta" });
  }
});

app.listen(port, () => {
  console.log(`Backend POS escuchando en puerto ${port}`);
});