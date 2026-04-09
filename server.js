const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());

// Base de datos
const DB_PATH = './database.sqlite';

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Error al conectar con la base de datos:', err.message);
  } else {
    console.log('Conectado a SQLite');

    // Crear tabla si no existe
    db.run(`
      CREATE TABLE IF NOT EXISTS recetas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT,
        ingredientes TEXT,
        pasos TEXT
      )
    `);
  }
});


// 🔹 RUTA PRINCIPAL
app.get('/', (req, res) => {
  res.send('Servidor funcionando 🚀');
});


// 🔹 OBTENER TODAS LAS RECETAS
app.get('/recetas', (req, res) => {
  db.all("SELECT * FROM recetas", [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});


// 🔹 AGREGAR RECETA
app.post('/recetas', (req, res) => {
  const { nombre, ingredientes, pasos } = req.body;

  db.run(
    "INSERT INTO recetas (nombre, ingredientes, pasos) VALUES (?, ?, ?)",
    [nombre, ingredientes, pasos],
    function (err) {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      res.json({
        id: this.lastID,
        nombre,
        ingredientes,
        pasos
      });
    }
  );
});


// 🔹 ELIMINAR RECETA
app.delete('/recetas/:id', (req, res) => {
  const { id } = req.params;

  db.run("DELETE FROM recetas WHERE id = ?", [id], function (err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ mensaje: "Receta eliminada" });
  });
});


// 🔹 INICIAR SERVIDOR
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});