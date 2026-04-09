/**
 * ============================================================
 *  Blog de Recetas Kitchen — Servidor Backend v3.0
 *  Tecnología: Node.js + Express + SQLite (better-sqlite3)
 * ============================================================
 * Mejoras v3.0:
 *  ✔ Múltiples administradores
 *  ✔ Flujo de aprobación: recetas y categorías pendientes
 *  ✔ Favoritos y Ver más tarde por usuario
 *  ✔ Expiración automática de recetas sin favoritos
 *  ✔ SSE para actualizaciones en tiempo real
 *  ✔ Estadísticas avanzadas (por usuario, categoría, temporada)
 *  ✔ Anti-duplicados con normalización de texto
 *  ✔ Seguridad mejorada (rate limiting, sanitización)
 * ============================================================
 */

const express  = require('express');
const cors     = require('cors');
const Database = require('better-sqlite3');
const path     = require('path');
const crypto   = require('crypto');

const app    = express();
const PORT   = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'recetario.db');
const ADMIN_SECRET_KEY = process.env.ADMIN_KEY || 'PALMA-ADMIN-2025';

// ─── SSE: clientes conectados ─────────────────────────────────
const sseClients = new Set();

function broadcastSSE(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => {
    try { client.write(msg); } catch (_) {}
  });
}

// ─── Rate limiting simple ─────────────────────────────────────
const requestCounts = new Map();
function rateLimiter(maxReq = 100, windowMs = 60000) {
  return (req, res, next) => {
    const ip  = req.ip || req.connection.remoteAddress;
    const key = `${ip}:${Math.floor(Date.now() / windowMs)}`;
    const cnt = (requestCounts.get(key) || 0) + 1;
    requestCounts.set(key, cnt);
    if (cnt > maxReq) {
      return res.status(429).json({ ok: false, error: 'Demasiadas peticiones. Espera un momento.' });
    }
    next();
  };
}
setInterval(() => requestCounts.clear(), 120000);

// ─── Middlewares ──────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(rateLimiter(200));
app.use(express.static(path.join(__dirname)));

// ─── Base de datos ────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Creación de tablas ───────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS configuracion (
    clave TEXT PRIMARY KEY,
    valor TEXT
  );

  CREATE TABLE IF NOT EXISTS usuarios (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre        TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password      TEXT NOT NULL,
    rol           TEXT NOT NULL DEFAULT 'observador'
                    CHECK(rol IN ('administrador','contribuyente','observador')),
    activo        INTEGER DEFAULT 1,
    creado_en     TEXT DEFAULT (datetime('now','localtime')),
    ultimo_acceso TEXT
  );

  CREATE TABLE IF NOT EXISTS sesiones (
    token       TEXT PRIMARY KEY,
    usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    creado_en   TEXT DEFAULT (datetime('now','localtime')),
    expira_en   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS categorias (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre       TEXT NOT NULL UNIQUE,
    icono        TEXT DEFAULT '🍽️',
    estado       TEXT DEFAULT 'aprobada'
                   CHECK(estado IN ('pendiente','aprobada','rechazada')),
    creado_por   INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    creado_en    TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS recetas (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    titulo         TEXT NOT NULL,
    descripcion    TEXT,
    categoria_id   INTEGER REFERENCES categorias(id) ON DELETE SET NULL,
    dificultad     TEXT DEFAULT 'Media'
                     CHECK(dificultad IN ('Fácil','Media','Difícil')),
    tiempo_prep    INTEGER DEFAULT 0,
    tiempo_coccion INTEGER DEFAULT 0,
    porciones      INTEGER DEFAULT 4,
    imagen_url     TEXT,
    imagen_base64  TEXT,
    ingredientes   TEXT NOT NULL,
    instrucciones  TEXT NOT NULL,
    notas          TEXT,
    autor_id       INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    estado         TEXT DEFAULT 'pendiente'
                     CHECK(estado IN ('pendiente','aprobada','rechazada')),
    destacada      INTEGER DEFAULT 0,
    temporada      TEXT DEFAULT 'Todo el año'
                     CHECK(temporada IN ('Primavera','Verano','Otoño','Invierno','Todo el año')),
    creado_en      TEXT DEFAULT (datetime('now','localtime')),
    actualizado_en TEXT DEFAULT (datetime('now','localtime')),
    expira_en      TEXT
  );

  CREATE TABLE IF NOT EXISTS calificaciones (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    receta_id   INTEGER NOT NULL REFERENCES recetas(id) ON DELETE CASCADE,
    usuario_id  INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    estrellas   INTEGER NOT NULL CHECK(estrellas BETWEEN 1 AND 5),
    comentario  TEXT,
    autor       TEXT DEFAULT 'Anónimo',
    creado_en   TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(receta_id, usuario_id)
  );

  CREATE TABLE IF NOT EXISTS favoritos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    receta_id  INTEGER NOT NULL REFERENCES recetas(id) ON DELETE CASCADE,
    creado_en  TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(usuario_id, receta_id)
  );

  CREATE TABLE IF NOT EXISTS ver_mas_tarde (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    receta_id  INTEGER NOT NULL REFERENCES recetas(id) ON DELETE CASCADE,
    creado_en  TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(usuario_id, receta_id)
  );

  CREATE TABLE IF NOT EXISTS notificaciones (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    mensaje    TEXT NOT NULL,
    leida      INTEGER DEFAULT 0,
    tipo       TEXT DEFAULT 'info',
    receta_id  INTEGER REFERENCES recetas(id) ON DELETE SET NULL,
    creado_en  TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_calificaciones_receta ON calificaciones(receta_id);
  CREATE INDEX IF NOT EXISTS idx_recetas_categoria     ON recetas(categoria_id);
  CREATE INDEX IF NOT EXISTS idx_sesiones_token        ON sesiones(token);
  CREATE INDEX IF NOT EXISTS idx_favoritos_usuario     ON favoritos(usuario_id);
  CREATE INDEX IF NOT EXISTS idx_ver_mas_tarde_usuario ON ver_mas_tarde(usuario_id);
  CREATE INDEX IF NOT EXISTS idx_recetas_estado        ON recetas(estado);
  CREATE INDEX IF NOT EXISTS idx_notif_usuario         ON notificaciones(usuario_id);
`);

// Migración segura: agregar columnas si no existen
const addColIfMissing = (table, col, def) => {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  } catch (_) {}
};
addColIfMissing('recetas',   'estado',    "TEXT DEFAULT 'aprobada' CHECK(estado IN ('pendiente','aprobada','rechazada'))");
addColIfMissing('recetas',   'destacada', 'INTEGER DEFAULT 0');
addColIfMissing('recetas',   'temporada', "TEXT DEFAULT 'Todo el año'");
addColIfMissing('recetas',   'expira_en', 'TEXT');
addColIfMissing('categorias','estado',    "TEXT DEFAULT 'aprobada' CHECK(estado IN ('pendiente','aprobada','rechazada'))");
addColIfMissing('categorias','creado_por','INTEGER REFERENCES usuarios(id) ON DELETE SET NULL');
addColIfMissing('usuarios',  'activo',    'INTEGER DEFAULT 1');

// ─── Seed inicial ─────────────────────────────────────────────
const cfgCount = db.prepare('SELECT COUNT(*) as c FROM configuracion').get().c;
if (cfgCount === 0) {
  const ins = db.prepare('INSERT OR IGNORE INTO configuracion (clave, valor) VALUES (?, ?)');
  ins.run('nombre_recetario', 'Blog de Recetas Kitchen');
  ins.run('logo_url', '');
  ins.run('logo_base64', '');
  ins.run('dias_expiracion', '60');
}

const catCount = db.prepare('SELECT COUNT(*) as c FROM categorias').get().c;
if (catCount === 0) {
  const insCat = db.prepare("INSERT OR IGNORE INTO categorias (nombre, icono, estado) VALUES (?, ?, 'aprobada')");
  [
    ['Desayunos','🍳'],['Sopas','🍲'],['Carnes','🥩'],
    ['Pastas','🍝'],['Mariscos','🦐'],['Vegetariano','🥗'],
    ['Postres','🍰'],['Bebidas','🥤'],['Ensaladas','🥙'],
    ['Panadería','🍞'],
  ].forEach(([n, i]) => insCat.run(n, i));

  const insRec = db.prepare(`
    INSERT INTO recetas
      (titulo, descripcion, categoria_id, dificultad,
       tiempo_prep, tiempo_coccion, porciones,
       ingredientes, instrucciones, notas, estado, temporada)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'aprobada', ?)
  `);
  [
    { titulo:'Tacos al Pastor', descripcion:'Los clásicos tacos al pastor con carne marinada y piña fresca.', cat:3, dif:'Media', tp:30, tc:45, por:6, ing:['1 kg carne de cerdo','4 chiles guajillo','1/4 piña natural','3 dientes de ajo','Tortillas de maíz','Cilantro y cebolla al gusto'], ins:['Hidrata los chiles en agua caliente 20 min.','Licúa chiles con ajo, achiote y especias.','Marina la carne mínimo 4 horas.','Asa la carne en comal a fuego alto.','Sirve en tortillas con cilantro, cebolla y piña.'], notas:'La clave está en el marinado.', temp:'Todo el año' },
    { titulo:'Pozole Rojo', descripcion:'Sopa tradicional mexicana de maíz cacahuazintle.', cat:2, dif:'Difícil', tp:60, tc:120, por:8, ing:['1 kg maíz cacahuazintle','1 kg espaldilla de cerdo','6 chiles guajillo','3 chiles ancho','1 cebolla','Orégano y sal al gusto'], ins:['Cuece el maíz hasta que florezca (~2h).','Cuece la carne con cebolla y sal.','Licúa y fríe la salsa de chile.','Mezcla caldo, maíz y salsa.','Sirve con tostadas, lechuga y rábanos.'], notas:'Puedes usar maíz precocido de lata.', temp:'Invierno' },
    { titulo:'Guacamole Clásico', descripcion:'Guacamole auténtico estilo mexicano.', cat:6, dif:'Fácil', tp:10, tc:0, por:4, ing:['3 aguacates maduros','1 jitomate sin semillas','½ cebolla blanca','1-2 chiles serranos','Jugo de 1 limón','¼ taza de cilantro','Sal al gusto'], ins:['Extrae la pulpa del aguacate.','Aplasta con tenedor o molcajete.','Agrega jugo de limón de inmediato.','Incorpora los demás ingredientes.','Sirve con totopos.'], notas:'Usa molcajete para la versión más auténtica.', temp:'Verano' },
    { titulo:'Pastel de Chocolate', descripcion:'Pastel húmedo y esponjoso de chocolate oscuro.', cat:7, dif:'Media', tp:20, tc:35, por:10, ing:['2 tazas de harina','2 tazas de azúcar','¾ taza de cacao en polvo','2 cdtas bicarbonato','2 huevos','1 taza de leche','1 taza de aceite vegetal','200 ml de crema','250 g de chocolate semiamargo'], ins:['Precalienta horno a 175°C.','Mezcla ingredientes secos.','Agrega huevos, leche y aceite. Bate 2 min.','Hornea 35 min.','Cubre con ganache de chocolate.'], notas:'Agrega una taza de café negro para intensificar el sabor.', temp:'Todo el año' },
  ].forEach(r => insRec.run(r.titulo, r.descripcion, r.cat, r.dif, r.tp, r.tc, r.por, JSON.stringify(r.ing), JSON.stringify(r.ins), r.notas, r.temp));

  const insRating = db.prepare('INSERT INTO calificaciones (receta_id, estrellas, comentario, autor) VALUES (?, ?, ?, ?)');
  [[1,5,'¡Increíbles! Exactamente como los de la taquería.','María G.'],[1,4,'Muy sabrosos, la próxima le pongo más piña.','Carlos M.'],[2,5,'El pozole quedó perfecto para la posada.','Ana R.'],[3,5,'Facilísimo de preparar y delicioso.','Sofía T.'],[4,5,'El mejor pastel de chocolate que he hecho.','Laura S.']].forEach(([rid,s,c,a]) => insRating.run(rid,s,c,a));
}

// ─── Expiración automática de recetas ────────────────────────
function verificarExpiracion() {
  const dias = parseInt(db.prepare("SELECT valor FROM configuracion WHERE clave='dias_expiracion'").get()?.valor || '60');
  const limite = new Date();
  limite.setDate(limite.getDate() - dias);
  const limitStr = limite.toISOString().replace('T', ' ').slice(0, 19);

  // Recetas sin favoritos, aprobadas y creadas hace más de N días
  const expiradas = db.prepare(`
    SELECT r.id FROM recetas r
    WHERE r.estado = 'aprobada'
      AND r.creado_en < ?
      AND NOT EXISTS (SELECT 1 FROM favoritos f WHERE f.receta_id = r.id)
  `).all(limitStr);

  expiradas.forEach(({ id }) => {
    // Notificar al autor
    const receta = db.prepare('SELECT titulo, autor_id FROM recetas WHERE id = ?').get(id);
    if (receta?.autor_id) {
      db.prepare(`INSERT INTO notificaciones (usuario_id, mensaje, tipo, receta_id) VALUES (?, ?, 'expiracion', ?)`).run(receta.autor_id, `Tu receta "${receta.titulo}" fue eliminada por inactividad (sin favoritos).`, id);
    }
    db.prepare("DELETE FROM recetas WHERE id = ?").run(id);
    broadcastSSE('receta_expirada', { id });
  });

  if (expiradas.length > 0) {
    console.log(`[Expiracion] ${expiradas.length} receta(s) eliminada(s) por inactividad.`);
  }
}
setInterval(verificarExpiracion, 3600000); // cada hora
setTimeout(verificarExpiracion, 5000);    // al inicio

// ─── Helpers ─────────────────────────────────────────────────
function safeJson(str, fb) { try { return JSON.parse(str); } catch { return fb; } }

function hashPwd(password) {
  return crypto.createHash('sha256').update(password + 'kitchen_salt_2025').digest('hex');
}
function genToken() { return crypto.randomBytes(32).toString('hex'); }

function normalizar(str) {
  return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

function getUser(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  const sesion = db.prepare("SELECT * FROM sesiones WHERE token = ? AND expira_en > datetime('now')").get(token);
  if (!sesion) return null;
  return db.prepare('SELECT * FROM usuarios WHERE id = ? AND activo = 1').get(sesion.usuario_id);
}

function requireAuth(req, res, next) {
  const user = getUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Debes iniciar sesión.' });
  req.user = user;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    const user = getUser(req);
    if (!user) return res.status(401).json({ ok: false, error: 'No has iniciado sesión.' });
    if (!roles.includes(user.rol)) return res.status(403).json({ ok: false, error: 'Sin permiso para esta acción.' });
    req.user = user;
    next();
  };
}

// ─── SSE Endpoint ─────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');

  const interval = setInterval(() => {
    try { res.write(':ping\n\n'); } catch (_) {}
  }, 25000);

  sseClients.add(res);
  req.on('close', () => {
    clearInterval(interval);
    sseClients.delete(res);
  });
});

// ─── Config ───────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  const rows = db.prepare('SELECT * FROM configuracion').all();
  const cfg = {};
  rows.forEach(r => { cfg[r.clave] = r.valor; });
  res.json({ ok: true, data: cfg });
});

app.put('/api/config', requireRole('administrador'), (req, res) => {
  const { nombre_recetario, logo_url, logo_base64, dias_expiracion } = req.body;
  const upd = db.prepare('INSERT OR REPLACE INTO configuracion (clave, valor) VALUES (?, ?)');
  if (nombre_recetario !== undefined) upd.run('nombre_recetario', nombre_recetario.trim());
  if (logo_url         !== undefined) upd.run('logo_url', logo_url);
  if (logo_base64      !== undefined) upd.run('logo_base64', logo_base64);
  if (dias_expiracion  !== undefined) upd.run('dias_expiracion', String(parseInt(dias_expiracion)));
  const rows = db.prepare('SELECT * FROM configuracion').all();
  const cfg = {};
  rows.forEach(r => { cfg[r.clave] = r.valor; });
  res.json({ ok: true, data: cfg });
});

// ─── Auth ─────────────────────────────────────────────────────
app.post('/api/auth/registro', rateLimiter(10, 60000), (req, res) => {
  const { nombre, email, password, rol = 'observador', admin_key } = req.body;

  if (!nombre?.trim() || !email?.trim() || !password) {
    return res.status(400).json({ ok: false, error: 'Nombre, email y contraseña son obligatorios.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ ok: false, error: 'La contraseña debe tener al menos 6 caracteres.' });
  }
  if (!['administrador','contribuyente','observador'].includes(rol)) {
    return res.status(400).json({ ok: false, error: 'Rol no válido.' });
  }
  if (rol === 'administrador') {
    if (!admin_key || admin_key !== ADMIN_SECRET_KEY) {
      return res.status(403).json({ ok: false, error: 'Clave de administrador incorrecta.' });
    }
    // Sin límite de administradores — se permiten varios
  }

  const emailNorm = email.toLowerCase().trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(emailNorm)) {
    return res.status(400).json({ ok: false, error: 'El correo electrónico no es válido.' });
  }

  try {
    const result = db.prepare('INSERT INTO usuarios (nombre, email, password, rol) VALUES (?, ?, ?, ?)')
      .run(nombre.trim(), emailNorm, hashPwd(password), rol);
    const nu = db.prepare('SELECT id, nombre, email, rol, creado_en FROM usuarios WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ ok: true, data: nu, message: '¡Cuenta creada! Ya puedes iniciar sesión.' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ ok: false, error: 'Ese correo ya está registrado.' });
    }
    res.status(500).json({ ok: false, error: 'Error interno.' });
  }
});

app.post('/api/auth/login', rateLimiter(15, 60000), (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ ok: false, error: 'Email y contraseña requeridos.' });

  const usuario = db.prepare('SELECT * FROM usuarios WHERE email = ? AND activo = 1').get(email.toLowerCase().trim());
  if (!usuario || usuario.password !== hashPwd(password)) {
    return res.status(401).json({ ok: false, error: 'Correo o contraseña incorrectos.' });
  }

  const token  = genToken();
  const expira = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().replace('T',' ').slice(0,19);
  db.prepare('INSERT INTO sesiones (token, usuario_id, expira_en) VALUES (?, ?, ?)').run(token, usuario.id, expira);
  db.prepare("UPDATE usuarios SET ultimo_acceso = datetime('now','localtime') WHERE id = ?").run(usuario.id);

  // Contar notificaciones no leídas
  const notifs = db.prepare('SELECT COUNT(*) as c FROM notificaciones WHERE usuario_id = ? AND leida = 0').get(usuario.id).c;

  res.json({ ok: true, data: { token, notificaciones_pendientes: notifs, usuario: { id: usuario.id, nombre: usuario.nombre, email: usuario.email, rol: usuario.rol } } });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ','').trim();
  db.prepare('DELETE FROM sesiones WHERE token = ?').run(token);
  res.json({ ok: true, message: 'Sesión cerrada.' });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const u = req.user;
  const notifs = db.prepare('SELECT COUNT(*) as c FROM notificaciones WHERE usuario_id = ? AND leida = 0').get(u.id).c;
  res.json({ ok: true, data: { id: u.id, nombre: u.nombre, email: u.email, rol: u.rol, notificaciones_pendientes: notifs } });
});

// ─── Notificaciones ───────────────────────────────────────────
app.get('/api/notificaciones', requireAuth, (req, res) => {
  const notifs = db.prepare('SELECT * FROM notificaciones WHERE usuario_id = ? ORDER BY creado_en DESC LIMIT 50').all(req.user.id);
  res.json({ ok: true, data: notifs });
});

app.put('/api/notificaciones/leer-todas', requireAuth, (req, res) => {
  db.prepare('UPDATE notificaciones SET leida = 1 WHERE usuario_id = ?').run(req.user.id);
  res.json({ ok: true });
});

app.delete('/api/notificaciones/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM notificaciones WHERE id = ? AND usuario_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ─── Usuarios ─────────────────────────────────────────────────
app.get('/api/usuarios', requireRole('administrador'), (req, res) => {
  const usuarios = db.prepare('SELECT id, nombre, email, rol, activo, creado_en, ultimo_acceso FROM usuarios ORDER BY creado_en DESC').all();
  // Agregar conteo de recetas por usuario
  usuarios.forEach(u => {
    u.total_recetas = db.prepare("SELECT COUNT(*) as c FROM recetas WHERE autor_id = ? AND estado = 'aprobada'").get(u.id).c;
    u.recetas_pendientes = db.prepare("SELECT COUNT(*) as c FROM recetas WHERE autor_id = ? AND estado = 'pendiente'").get(u.id).c;
  });
  res.json({ ok: true, data: usuarios });
});

app.get('/api/usuarios/:id/recetas', requireRole('administrador'), (req, res) => {
  const recetas = db.prepare(`
    SELECT r.*, c.nombre AS categoria_nombre,
      ROUND(AVG(cal.estrellas),1) AS promedio_calificacion,
      COUNT(cal.id) AS total_calificaciones
    FROM recetas r
    LEFT JOIN categorias c ON r.categoria_id = c.id
    LEFT JOIN calificaciones cal ON cal.receta_id = r.id
    WHERE r.autor_id = ?
    GROUP BY r.id
    ORDER BY r.creado_en DESC
  `).all(req.params.id);
  recetas.forEach(r => {
    r.ingredientes  = safeJson(r.ingredientes, []);
    r.instrucciones = safeJson(r.instrucciones, []);
  });
  res.json({ ok: true, data: recetas });
});

app.put('/api/usuarios/:id/rol', requireRole('administrador'), (req, res) => {
  if (parseInt(req.params.id) === req.user.id) {
    return res.status(400).json({ ok: false, error: 'No puedes cambiar tu propio rol.' });
  }
  const { rol } = req.body;
  if (!['administrador','contribuyente','observador'].includes(rol)) {
    return res.status(400).json({ ok: false, error: 'Rol no válido.' });
  }
  db.prepare('UPDATE usuarios SET rol = ? WHERE id = ?').run(rol, req.params.id);
  res.json({ ok: true, message: 'Rol actualizado.' });
});

app.put('/api/usuarios/:id/activo', requireRole('administrador'), (req, res) => {
  if (parseInt(req.params.id) === req.user.id) {
    return res.status(400).json({ ok: false, error: 'No puedes desactivar tu propia cuenta.' });
  }
  const { activo } = req.body;
  db.prepare('UPDATE usuarios SET activo = ? WHERE id = ?').run(activo ? 1 : 0, req.params.id);
  res.json({ ok: true, message: activo ? 'Usuario activado.' : 'Usuario desactivado.' });
});

app.delete('/api/usuarios/:id', requireRole('administrador'), (req, res) => {
  if (parseInt(req.params.id) === req.user.id) {
    return res.status(400).json({ ok: false, error: 'No puedes eliminar tu propia cuenta.' });
  }
  db.prepare('DELETE FROM usuarios WHERE id = ?').run(req.params.id);
  res.json({ ok: true, message: 'Usuario eliminado.' });
});

// ─── Categorías ───────────────────────────────────────────────
app.get('/api/categorias', (req, res) => {
  const { todas } = req.query;
  let sql = "SELECT c.*, u.nombre AS creador_nombre FROM categorias c LEFT JOIN usuarios u ON c.creado_por = u.id";
  const params = [];
  if (!todas) { sql += " WHERE c.estado = 'aprobada'"; }
  sql += " ORDER BY c.nombre";
  const categorias = db.prepare(sql).all(...params);
  // Agregar conteo de recetas por categoría
  categorias.forEach(cat => {
    cat.total_recetas = db.prepare("SELECT COUNT(*) as c FROM recetas WHERE categoria_id = ? AND estado = 'aprobada'").get(cat.id).c;
  });
  res.json({ ok: true, data: categorias });
});

app.post('/api/categorias', requireRole('administrador','contribuyente'), (req, res) => {
  const { nombre, icono = '🍽️' } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ ok: false, error: 'El nombre no puede estar vacío.' });

  // Anti-duplicados: normalizar nombre
  const nombreNorm = normalizar(nombre.trim());
  const existentes = db.prepare('SELECT nombre FROM categorias').all();
  const duplicado  = existentes.some(c => normalizar(c.nombre) === nombreNorm);
  if (duplicado) return res.status(409).json({ ok: false, error: 'Ya existe una categoría similar.' });

  // Contribuyentes crean en estado pendiente; admins en aprobada
  const estado = req.user.rol === 'administrador' ? 'aprobada' : 'pendiente';

  try {
    const result = db.prepare('INSERT INTO categorias (nombre, icono, estado, creado_por) VALUES (?, ?, ?, ?)')
      .run(nombre.trim(), icono, estado, req.user.id);
    const nueva = db.prepare('SELECT * FROM categorias WHERE id = ?').get(result.lastInsertRowid);

    if (estado === 'pendiente') {
      // Notificar a admins
      const admins = db.prepare("SELECT id FROM usuarios WHERE rol = 'administrador' AND activo = 1").all();
      admins.forEach(a => {
        db.prepare("INSERT INTO notificaciones (usuario_id, mensaje, tipo) VALUES (?, ?, 'categoria_pendiente')").run(a.id, `El contribuyente "${req.user.nombre}" propuso la categoría "${nombre.trim()}". Requiere tu aprobación.`);
      });
      broadcastSSE('categoria_pendiente', { id: nueva.id, nombre: nueva.nombre });
    } else {
      broadcastSSE('categoria_nueva', { id: nueva.id, nombre: nueva.nombre });
    }

    res.status(201).json({ ok: true, data: nueva, message: estado === 'pendiente' ? 'Categoría enviada para aprobación.' : 'Categoría creada.' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ ok: false, error: 'Ya existe esa categoría.' });
    res.status(500).json({ ok: false, error: 'Error al crear la categoría.' });
  }
});

app.put('/api/categorias/:id/aprobar', requireRole('administrador'), (req, res) => {
  const { accion } = req.body; // 'aprobar' | 'rechazar'
  const cat = db.prepare('SELECT * FROM categorias WHERE id = ?').get(req.params.id);
  if (!cat) return res.status(404).json({ ok: false, error: 'Categoría no encontrada.' });

  const estado = accion === 'aprobar' ? 'aprobada' : 'rechazada';
  db.prepare('UPDATE categorias SET estado = ? WHERE id = ?').run(estado, req.params.id);

  if (cat.creado_por) {
    const msg = accion === 'aprobar'
      ? `✅ Tu categoría "${cat.nombre}" fue aprobada y ya está disponible.`
      : `❌ Tu categoría "${cat.nombre}" fue rechazada por el administrador.`;
    db.prepare("INSERT INTO notificaciones (usuario_id, mensaje, tipo) VALUES (?, ?, ?)").run(cat.creado_por, msg, accion === 'aprobar' ? 'info' : 'rechazo');
  }

  broadcastSSE('categoria_actualizada', { id: cat.id, estado });
  res.json({ ok: true, message: `Categoría ${estado}.` });
});

app.delete('/api/categorias/:id', requireRole('administrador'), (req, res) => {
  db.prepare('DELETE FROM categorias WHERE id = ?').run(req.params.id);
  broadcastSSE('categoria_eliminada', { id: req.params.id });
  res.json({ ok: true, message: 'Categoría eliminada.' });
});

// ─── Recetas ──────────────────────────────────────────────────
const QUERY_BASE = `
  SELECT r.*,
    c.nombre AS categoria_nombre,
    c.icono  AS categoria_icono,
    u.nombre AS autor_nombre,
    ROUND(AVG(cal.estrellas),1) AS promedio_calificacion,
    COUNT(cal.id) AS total_calificaciones
  FROM recetas r
  LEFT JOIN categorias     c   ON r.categoria_id = c.id
  LEFT JOIN usuarios       u   ON r.autor_id     = u.id
  LEFT JOIN calificaciones cal ON cal.receta_id  = r.id
`;

function enrichRecetas(rows, userId = null) {
  rows.forEach(r => {
    r.ingredientes  = safeJson(r.ingredientes, []);
    r.instrucciones = safeJson(r.instrucciones, []);
    if (userId) {
      r.es_favorito    = !!db.prepare('SELECT 1 FROM favoritos WHERE usuario_id=? AND receta_id=?').get(userId, r.id);
      r.es_ver_despues = !!db.prepare('SELECT 1 FROM ver_mas_tarde WHERE usuario_id=? AND receta_id=?').get(userId, r.id);
    } else {
      r.es_favorito    = false;
      r.es_ver_despues = false;
    }
  });
  return rows;
}

app.get('/api/recetas', (req, res) => {
  const { buscar='', categoria, dificultad, orden='reciente', estado, temporada, autor_id, destacadas, mis_recetas, pagina=1, por_pagina=24 } = req.query;
  const user = getUser(req);

  let where = 'WHERE 1=1';
  const params = [];

  // Por defecto solo mostrar aprobadas (salvo admin que ve todas, o contribuyente sus propias)
  if (estado) {
    where += ' AND r.estado = ?'; params.push(estado);
  } else if (user?.rol === 'administrador') {
    // admin ve todas
  } else if (user?.rol === 'contribuyente' && mis_recetas) {
    where += ' AND r.autor_id = ?'; params.push(user.id);
  } else {
    where += " AND r.estado = 'aprobada'"; 
  }

  if (mis_recetas && user) {
    where += ' AND r.autor_id = ?'; params.push(user.id);
  }
  if (buscar) {
    where += ' AND (r.titulo LIKE ? OR r.descripcion LIKE ?)';
    params.push(`%${buscar}%`, `%${buscar}%`);
  }
  if (categoria) { where += ' AND r.categoria_id = ?'; params.push(Number(categoria)); }
  if (dificultad) { where += ' AND r.dificultad = ?'; params.push(dificultad); }
  if (temporada)  { where += ' AND r.temporada = ?'; params.push(temporada); }
  if (destacadas) { where += ' AND r.destacada = 1'; }
  if (autor_id)   { where += ' AND r.autor_id = ?'; params.push(Number(autor_id)); }

  const ordenMap = {
    reciente    : 'r.creado_en DESC',
    nombre      : 'r.titulo ASC',
    calificacion: 'promedio_calificacion DESC',
    tiempo      : '(r.tiempo_prep + r.tiempo_coccion) ASC',
    nuevas      : 'r.creado_en DESC',
  };
  const orderBy = ordenMap[orden] || 'r.creado_en DESC';

  try {
    const sql = `${QUERY_BASE} ${where} GROUP BY r.id ORDER BY ${orderBy}`;
    let rows = db.prepare(sql).all(...params);
    const total = rows.length;

    // Paginación
    const pg = Math.max(1, parseInt(pagina));
    const pp = Math.min(48, Math.max(6, parseInt(por_pagina)));
    rows = rows.slice((pg-1)*pp, pg*pp);

    enrichRecetas(rows, user?.id);
    res.json({ ok: true, data: rows, total, pagina: pg, por_pagina: pp, paginas: Math.ceil(total/pp) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Error al consultar recetas.' });
  }
});

app.get('/api/recetas/nuevas', (req, res) => {
  const user = getUser(req);
  const rows = db.prepare(`${QUERY_BASE} WHERE r.estado='aprobada' GROUP BY r.id ORDER BY r.creado_en DESC LIMIT 8`).all();
  enrichRecetas(rows, user?.id);
  res.json({ ok: true, data: rows });
});

app.get('/api/recetas/destacadas', (req, res) => {
  const user = getUser(req);
  const rows = db.prepare(`${QUERY_BASE} WHERE r.estado='aprobada' AND (r.destacada=1 OR promedio_calificacion>=4) GROUP BY r.id ORDER BY promedio_calificacion DESC LIMIT 8`).all();
  enrichRecetas(rows, user?.id);
  res.json({ ok: true, data: rows });
});

app.get('/api/recetas/pendientes', requireRole('administrador'), (req, res) => {
  const rows = db.prepare(`${QUERY_BASE} WHERE r.estado='pendiente' GROUP BY r.id ORDER BY r.creado_en ASC`).all();
  enrichRecetas(rows);
  res.json({ ok: true, data: rows });
});

app.get('/api/recetas/:id', (req, res) => {
  const user = getUser(req);
  try {
    const receta = db.prepare(`${QUERY_BASE} WHERE r.id = ? GROUP BY r.id`).get(req.params.id);
    if (!receta) return res.status(404).json({ ok: false, error: 'Receta no encontrada.' });

    // Solo el autor o admin puede ver recetas pendientes
    if (receta.estado !== 'aprobada') {
      if (!user || (user.rol !== 'administrador' && user.id !== receta.autor_id)) {
        return res.status(403).json({ ok: false, error: 'Esta receta aún no está publicada.' });
      }
    }

    receta.ingredientes  = safeJson(receta.ingredientes, []);
    receta.instrucciones = safeJson(receta.instrucciones, []);
    receta.calificaciones = db.prepare('SELECT * FROM calificaciones WHERE receta_id = ? ORDER BY creado_en DESC').all(receta.id);

    if (user) {
      receta.es_favorito    = !!db.prepare('SELECT 1 FROM favoritos WHERE usuario_id=? AND receta_id=?').get(user.id, receta.id);
      receta.es_ver_despues = !!db.prepare('SELECT 1 FROM ver_mas_tarde WHERE usuario_id=? AND receta_id=?').get(user.id, receta.id);
      receta.mi_calificacion = db.prepare('SELECT estrellas FROM calificaciones WHERE usuario_id=? AND receta_id=?').get(user.id, receta.id)?.estrellas || null;
    }

    res.json({ ok: true, data: receta });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error al obtener la receta.' });
  }
});

app.post('/api/recetas', requireRole('administrador','contribuyente'), (req, res) => {
  const {
    titulo, descripcion='', categoria_id, dificultad='Media',
    tiempo_prep=0, tiempo_coccion=0, porciones=4,
    imagen_url='', imagen_base64='',
    ingredientes=[], instrucciones=[], notas='', temporada='Todo el año'
  } = req.body;

  if (!titulo?.trim()) return res.status(400).json({ ok: false, error: 'El título es obligatorio.' });
  if (!ingredientes.length) return res.status(400).json({ ok: false, error: 'Agrega al menos un ingrediente.' });
  if (!instrucciones.length) return res.status(400).json({ ok: false, error: 'Agrega al menos un paso.' });

  // Anti-duplicados por título normalizado
  const tituloNorm = normalizar(titulo.trim());
  const existentes = db.prepare('SELECT titulo FROM recetas').all();
  const duplicado  = existentes.some(r => normalizar(r.titulo) === tituloNorm);
  if (duplicado) return res.status(409).json({ ok: false, error: 'Ya existe una receta con un título muy similar.' });

  // Estado según rol
  const estado = req.user.rol === 'administrador' ? 'aprobada' : 'pendiente';

  try {
    const result = db.prepare(`
      INSERT INTO recetas
        (titulo, descripcion, categoria_id, dificultad,
         tiempo_prep, tiempo_coccion, porciones,
         imagen_url, imagen_base64, ingredientes, instrucciones,
         notas, autor_id, estado, temporada)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      titulo.trim(), descripcion, categoria_id || null, dificultad,
      tiempo_prep, tiempo_coccion, porciones,
      imagen_url, imagen_base64,
      JSON.stringify(ingredientes), JSON.stringify(instrucciones),
      notas, req.user.id, estado, temporada
    );

    const nueva = db.prepare(`${QUERY_BASE} WHERE r.id = ? GROUP BY r.id`).get(result.lastInsertRowid);
    nueva.ingredientes  = safeJson(nueva.ingredientes, []);
    nueva.instrucciones = safeJson(nueva.instrucciones, []);
    nueva.calificaciones = [];

    if (estado === 'pendiente') {
      // Notificar a todos los administradores
      const admins = db.prepare("SELECT id FROM usuarios WHERE rol = 'administrador' AND activo = 1").all();
      admins.forEach(a => {
        db.prepare("INSERT INTO notificaciones (usuario_id, mensaje, tipo, receta_id) VALUES (?, ?, 'receta_pendiente', ?)").run(a.id, `📋 Nueva receta pendiente: "${titulo.trim()}" de ${req.user.nombre}.`, result.lastInsertRowid);
      });
      broadcastSSE('receta_pendiente', { id: nueva.id, titulo: nueva.titulo });
    } else {
      broadcastSSE('receta_nueva', { id: nueva.id, titulo: nueva.titulo });
    }

    res.status(201).json({ ok: true, data: nueva, message: estado === 'pendiente' ? '¡Receta enviada! Espera la aprobación del administrador.' : 'Receta publicada.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Error al guardar la receta.' });
  }
});

app.put('/api/recetas/:id/aprobar', requireRole('administrador'), (req, res) => {
  const { accion, destacada } = req.body; // accion: 'aprobar' | 'rechazar'
  const receta = db.prepare('SELECT * FROM recetas WHERE id = ?').get(req.params.id);
  if (!receta) return res.status(404).json({ ok: false, error: 'Receta no encontrada.' });

  const estado = accion === 'aprobar' ? 'aprobada' : 'rechazada';
  db.prepare('UPDATE recetas SET estado = ?, destacada = ? WHERE id = ?').run(estado, destacada ? 1 : 0, req.params.id);

  if (receta.autor_id) {
    const msg = accion === 'aprobar'
      ? `✅ Tu receta "${receta.titulo}" fue aprobada y ya está publicada en el recetario.`
      : `❌ Tu receta "${receta.titulo}" fue rechazada. Puedes editarla y volver a enviarla.`;
    db.prepare("INSERT INTO notificaciones (usuario_id, mensaje, tipo, receta_id) VALUES (?, ?, ?, ?)").run(receta.autor_id, msg, accion === 'aprobar' ? 'info' : 'rechazo', receta.id);
  }

  broadcastSSE('receta_actualizada', { id: receta.id, estado, titulo: receta.titulo });
  res.json({ ok: true, message: `Receta ${estado}.` });
});

app.put('/api/recetas/:id/destacar', requireRole('administrador'), (req, res) => {
  const { destacada } = req.body;
  db.prepare('UPDATE recetas SET destacada = ? WHERE id = ?').run(destacada ? 1 : 0, req.params.id);
  broadcastSSE('receta_actualizada', { id: req.params.id, destacada });
  res.json({ ok: true });
});

app.put('/api/recetas/:id', requireRole('administrador','contribuyente'), (req, res) => {
  const recetaActual = db.prepare('SELECT * FROM recetas WHERE id = ?').get(req.params.id);
  if (!recetaActual) return res.status(404).json({ ok: false, error: 'Receta no encontrada.' });
  if (req.user.rol === 'contribuyente' && recetaActual.autor_id !== req.user.id) {
    return res.status(403).json({ ok: false, error: 'Solo puedes editar tus propias recetas.' });
  }

  const { titulo, descripcion, categoria_id, dificultad, tiempo_prep, tiempo_coccion, porciones, imagen_url, imagen_base64, ingredientes, instrucciones, notas, temporada } = req.body;

  // Si contribuyente edita → vuelve a pendiente
  const nuevoEstado = req.user.rol === 'contribuyente' ? 'pendiente' : undefined;

  try {
    db.prepare(`
      UPDATE recetas SET
        titulo         = COALESCE(?, titulo),
        descripcion    = COALESCE(?, descripcion),
        categoria_id   = COALESCE(?, categoria_id),
        dificultad     = COALESCE(?, dificultad),
        tiempo_prep    = COALESCE(?, tiempo_prep),
        tiempo_coccion = COALESCE(?, tiempo_coccion),
        porciones      = COALESCE(?, porciones),
        imagen_url     = COALESCE(?, imagen_url),
        imagen_base64  = COALESCE(?, imagen_base64),
        ingredientes   = COALESCE(?, ingredientes),
        instrucciones  = COALESCE(?, instrucciones),
        notas          = COALESCE(?, notas),
        temporada      = COALESCE(?, temporada),
        ${nuevoEstado ? "estado = 'pendiente'," : ''}
        actualizado_en = datetime('now','localtime')
      WHERE id = ?
    `).run(
      titulo?.trim() || null, descripcion || null,
      categoria_id || null, dificultad || null,
      tiempo_prep ?? null, tiempo_coccion ?? null, porciones ?? null,
      imagen_url || null, imagen_base64 || null,
      ingredientes ? JSON.stringify(ingredientes) : null,
      instrucciones ? JSON.stringify(instrucciones) : null,
      notas || null, temporada || null,
      req.params.id
    );

    const actualizada = db.prepare(`${QUERY_BASE} WHERE r.id = ? GROUP BY r.id`).get(req.params.id);
    actualizada.ingredientes  = safeJson(actualizada.ingredientes, []);
    actualizada.instrucciones = safeJson(actualizada.instrucciones, []);

    if (nuevoEstado) {
      const admins = db.prepare("SELECT id FROM usuarios WHERE rol='administrador' AND activo=1").all();
      admins.forEach(a => db.prepare("INSERT INTO notificaciones (usuario_id, mensaje, tipo, receta_id) VALUES (?, ?, 'receta_pendiente', ?)").run(a.id, `📝 Receta editada pendiente de revisión: "${actualizada.titulo}".`, actualizada.id));
      broadcastSSE('receta_pendiente', { id: actualizada.id });
    } else {
      broadcastSSE('receta_actualizada', { id: actualizada.id });
    }

    res.json({ ok: true, data: actualizada, message: nuevoEstado ? 'Receta actualizada y enviada para re-aprobación.' : 'Receta actualizada.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error al actualizar.' });
  }
});

app.delete('/api/recetas/:id', requireRole('administrador','contribuyente'), (req, res) => {
  const receta = db.prepare('SELECT * FROM recetas WHERE id = ?').get(req.params.id);
  if (!receta) return res.status(404).json({ ok: false, error: 'Receta no encontrada.' });
  if (req.user.rol === 'contribuyente' && receta.autor_id !== req.user.id) {
    return res.status(403).json({ ok: false, error: 'Solo puedes eliminar tus propias recetas.' });
  }
  db.prepare('DELETE FROM recetas WHERE id = ?').run(req.params.id);
  broadcastSSE('receta_eliminada', { id: req.params.id });
  res.json({ ok: true, message: 'Receta eliminada.' });
});

// ─── Calificaciones ───────────────────────────────────────────
app.post('/api/recetas/:id/calificaciones', (req, res) => {
  const { estrellas, comentario='', autor='Anónimo' } = req.body;
  const stars = parseInt(estrellas, 10);
  if (!stars || stars < 1 || stars > 5) return res.status(400).json({ ok: false, error: 'Calificación inválida (1-5).' });

  const receta = db.prepare("SELECT id FROM recetas WHERE id = ? AND estado = 'aprobada'").get(req.params.id);
  if (!receta) return res.status(404).json({ ok: false, error: 'Receta no disponible.' });

  const usuario = getUser(req);
  try {
    const result = db.prepare(`
      INSERT INTO calificaciones (receta_id, usuario_id, estrellas, comentario, autor)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(receta_id, usuario_id) DO UPDATE SET estrellas=excluded.estrellas, comentario=excluded.comentario
    `).run(req.params.id, usuario?.id || null, stars, comentario.trim(), usuario?.nombre || autor.trim() || 'Anónimo');

    broadcastSSE('calificacion_nueva', { receta_id: req.params.id });
    // Auto-destacar si promedio ≥ 4.5 con mínimo 3 votos
    const stats = db.prepare('SELECT AVG(estrellas) as avg, COUNT(*) as cnt FROM calificaciones WHERE receta_id=?').get(req.params.id);
    if (stats.avg >= 4.5 && stats.cnt >= 3) {
      db.prepare('UPDATE recetas SET destacada=1 WHERE id=?').run(req.params.id);
    }
    res.status(201).json({ ok: true, message: 'Calificación guardada.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error al guardar la calificación.' });
  }
});

app.delete('/api/calificaciones/:id', requireRole('administrador'), (req, res) => {
  db.prepare('DELETE FROM calificaciones WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── Favoritos ────────────────────────────────────────────────
app.get('/api/favoritos', requireAuth, (req, res) => {
  const rows = db.prepare(`
    ${QUERY_BASE}
    JOIN favoritos f ON f.receta_id = r.id
    WHERE f.usuario_id = ? AND r.estado = 'aprobada'
    GROUP BY r.id ORDER BY f.creado_en DESC
  `).all(req.user.id);
  enrichRecetas(rows, req.user.id);
  res.json({ ok: true, data: rows });
});

app.post('/api/favoritos/:id', requireAuth, (req, res) => {
  try {
    db.prepare('INSERT OR IGNORE INTO favoritos (usuario_id, receta_id) VALUES (?, ?)').run(req.user.id, req.params.id);
    res.json({ ok: true, favorito: true });
  } catch { res.status(500).json({ ok: false, error: 'Error.' }); }
});

app.delete('/api/favoritos/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM favoritos WHERE usuario_id=? AND receta_id=?').run(req.user.id, req.params.id);
  res.json({ ok: true, favorito: false });
});

// ─── Ver más tarde ────────────────────────────────────────────
app.get('/api/ver-mas-tarde', requireAuth, (req, res) => {
  const rows = db.prepare(`
    ${QUERY_BASE}
    JOIN ver_mas_tarde v ON v.receta_id = r.id
    WHERE v.usuario_id = ? AND r.estado = 'aprobada'
    GROUP BY r.id ORDER BY v.creado_en DESC
  `).all(req.user.id);
  enrichRecetas(rows, req.user.id);
  res.json({ ok: true, data: rows });
});

app.post('/api/ver-mas-tarde/:id', requireAuth, (req, res) => {
  try {
    db.prepare('INSERT OR IGNORE INTO ver_mas_tarde (usuario_id, receta_id) VALUES (?, ?)').run(req.user.id, req.params.id);
    res.json({ ok: true, ver_despues: true });
  } catch { res.status(500).json({ ok: false, error: 'Error.' }); }
});

app.delete('/api/ver-mas-tarde/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM ver_mas_tarde WHERE usuario_id=? AND receta_id=?').run(req.user.id, req.params.id);
  res.json({ ok: true, ver_despues: false });
});

// ─── Estadísticas ─────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  try {
    const totalRecetas        = db.prepare("SELECT COUNT(*) as c FROM recetas WHERE estado='aprobada'").get().c;
    const totalPendientes     = db.prepare("SELECT COUNT(*) as c FROM recetas WHERE estado='pendiente'").get().c;
    const totalCategorias     = db.prepare("SELECT COUNT(*) as c FROM categorias WHERE estado='aprobada'").get().c;
    const totalCalificaciones = db.prepare('SELECT COUNT(*) as c FROM calificaciones').get().c;
    const totalUsuarios       = db.prepare("SELECT COUNT(*) as c FROM usuarios WHERE activo=1").get().c;
    const promedioGeneral     = db.prepare('SELECT ROUND(AVG(estrellas),1) as p FROM calificaciones').get().p;

    const topRecetas = db.prepare(`
      SELECT r.titulo, r.id,
        ROUND(AVG(cal.estrellas),1) AS promedio, COUNT(cal.id) AS total
      FROM recetas r
      JOIN calificaciones cal ON cal.receta_id = r.id
      WHERE r.estado = 'aprobada'
      GROUP BY r.id HAVING COUNT(cal.id) >= 1
      ORDER BY promedio DESC LIMIT 5
    `).all();

    const porCategoria = db.prepare(`
      SELECT c.nombre, c.icono, COUNT(r.id) AS total
      FROM categorias c LEFT JOIN recetas r ON r.categoria_id=c.id AND r.estado='aprobada'
      WHERE c.estado='aprobada'
      GROUP BY c.id ORDER BY total DESC
    `).all();

    const porTemporada = db.prepare(`
      SELECT temporada, COUNT(*) as total
      FROM recetas WHERE estado='aprobada'
      GROUP BY temporada ORDER BY total DESC
    `).all();

    const porDificultad = db.prepare(`
      SELECT dificultad, COUNT(*) as total
      FROM recetas WHERE estado='aprobada'
      GROUP BY dificultad
    `).all();

    const topContribuyentes = db.prepare(`
      SELECT u.nombre, u.id, COUNT(r.id) as total_recetas,
        ROUND(AVG(cal.estrellas),1) as promedio
      FROM usuarios u
      LEFT JOIN recetas r ON r.autor_id=u.id AND r.estado='aprobada'
      LEFT JOIN calificaciones cal ON cal.receta_id=r.id
      WHERE u.rol IN ('contribuyente','administrador')
      GROUP BY u.id
      HAVING total_recetas > 0
      ORDER BY total_recetas DESC LIMIT 5
    `).all();

    const recienteMes = db.prepare(`
      SELECT COUNT(*) as c FROM recetas
      WHERE estado='aprobada' AND creado_en >= date('now','-30 days')
    `).get().c;

    res.json({ ok: true, data: {
      totalRecetas, totalPendientes, totalCategorias, totalCalificaciones,
      totalUsuarios, promedioGeneral, topRecetas, porCategoria,
      porTemporada, porDificultad, topContribuyentes, recienteMes
    }});
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Error en estadísticas.' });
  }
});

// ─── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║    Blog de Recetas Kitchen v3.0              ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  URL     : http://localhost:${PORT}              ║`);
  console.log(`║  BD      : ${DB_PATH}`);
  console.log(`║  Admin key: ${ADMIN_SECRET_KEY}             ║`);
  console.log('╚══════════════════════════════════════════════╝');
});
