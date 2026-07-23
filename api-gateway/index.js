const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const axios = require('axios');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const bcrypt = require('bcrypt');


const app = express();
app.use(express.json());
app.use(cors({
//  origin: [
//    'http://localhost:3000'
//  ],
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
});

const JWT_SECRET = process.env.JWT_SECRET;
const NIK_SALT = process.env.NIK_SALT;

const verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Akses ditolak. Token tidak ditemukan.' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Token tidak valid atau kedaluwarsa' });
  }
};

function generateHash(data) {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

// ------------------- API ENDPOINTS -------------------

// Endpoint: Ambil semua data master benih (batch)
app.get('/api/seeds', async (req, res) => {
  try {
    const query = `
      SELECT 
        b.id AS seed_id,
        b.variety_id,
        v.name AS variety_name,
        b.lot_number,
        b.certificate_number,
        b.current_status,
        b.created_at,
        u.username AS producer_name,
        h.username AS current_holder_name,
        (SELECT blockchain_hash FROM seed_history sh WHERE sh.batch_id = b.id ORDER BY sh.created_at DESC LIMIT 1) AS latest_hash
      FROM seed_batches b
      LEFT JOIN varieties v ON b.variety_id = v.id
      LEFT JOIN users u ON b.producer_id = u.id
      LEFT JOIN users h ON b.current_holder_id = h.id
      ORDER BY b.created_at DESC
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Gagal mengambil data benih: " + err.message });
  }
});

// Endpoint: Ambil semua data master varietas
app.get('/api/varieties', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, description FROM varieties ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Gagal mengambil data varietas: " + err.message });
  }
});

// Endpoint: Verifikasi Petani (klaim final) + Catat GPS ke Audit Trail
app.post('/api/public/verify-batch', async (req, res) => {
  // 1. Tangkap latitude dan longitude dari payload frontend
  const { batch_id, token, latitude, longitude } = req.body;
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const batch = await client.query(
      'SELECT current_status, claim_token FROM seed_batches WHERE id = $1 FOR UPDATE',
      [batch_id]
    );
    if (batch.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Batch tidak ditemukan' });
    }
    if (batch.rows[0].current_status === 'CLAIMED') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'BARCODE HANGUS' });
    }
    if (batch.rows[0].claim_token !== token) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Token Salah' });
    }

    // Ubah status batch menjadi CLAIMED
    await client.query('UPDATE seed_batches SET current_status = $1 WHERE id = $2', ['CLAIMED', batch_id]);

    // 2. Siapkan data koordinat GPS
    const locationData = (latitude && longitude) ? { lat: latitude, lng: longitude } : null;
    
    // 3. Buat hash blockchain untuk aksi klaim
    const hash = generateHash({ batch_id, action: 'CLAIMED', location: locationData, ts: Date.now() });

    // 4. INSERT riwayat ke tabel seed_history agar muncul di timeline frontend
    await client.query(
      `INSERT INTO seed_history(batch_id, actor_id, action_type, blockchain_hash, metadata)
       VALUES ($1, NULL, 'CLAIMED', $2, $3)`,
      [
        batch_id,
        hash,
        JSON.stringify({ location: locationData }) // Menyimpan koordinat GPS petani
      ]
    );

    await client.query('COMMIT');
    res.status(200).json({ message: 'Sertifikasi Valid' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Endpoint: Lacak Riwayat Perjalanan Batch
app.get('/api/batches/:id/history', async (req, res) => {
  try {
    const batch = await pool.query(
      `SELECT b.id, b.lot_number, b.current_status, v.name AS variety_name
       FROM seed_batches b
       LEFT JOIN varieties v ON b.variety_id = v.id
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (batch.rows.length === 0) return res.status(404).json({ error: "Batch tidak ditemukan" });

    const history = await pool.query(
      `SELECT h.action_type, h.blockchain_hash, h.created_at, h.metadata, u.username AS actor_name, u.role AS actor_role
       FROM seed_history h
       LEFT JOIN users u ON h.actor_id = u.id
       WHERE h.batch_id = $1
       ORDER BY h.created_at ASC`,
      [req.params.id]
    );
    res.json({ batch_info: batch.rows[0], tracking_history: history.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint: Registrasi Batch Benih (PRODUSEN only)

app.post('/api/register-batch', verifyToken, async (req, res) => {
  if (req.user.role !== 'PRODUSEN') return res.status(403).json({ error: "Hanya PRODUSEN" });
  const { variety_id, lot_number, certificate_number, jumlah_kecambah } = req.body;
  const claim_token = crypto.randomBytes(3).toString('hex').toUpperCase();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO seed_batches(variety_id, lot_number, certificate_number, claim_token, producer_id, current_holder_id, jumlah_kecambah) 
       VALUES($1, $2, $3, $4, $5, $5, $6) RETURNING id`,
      [variety_id, lot_number, certificate_number, claim_token, req.user.id, jumlah_kecambah || 1000]
    );
    const batchId = result.rows[0].id;
    await client.query(
      `INSERT INTO seed_history(batch_id, actor_id, action_type, blockchain_hash)
       VALUES($1, $2, 'PRODUCTION', $3)`,
      [batchId, req.user.id, generateHash({ batch_id: batchId, lot_number })]
    );
    await client.query('COMMIT');
    res.status(201).json({ message: 'Batch terdaftar', batch_id: batchId, secret_claim_token: claim_token });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Endpoint: Transfer Custody (PRODUSEN/DISTRIBUTOR)
app.post('/api/ship-batch', verifyToken, async (req, res) => {
  if (!['PRODUSEN', 'DISTRIBUTOR'].includes(req.user.role)) {
    return res.status(403).json({ error: "Hanya PRODUSEN atau DISTRIBUTOR yang dapat mengirim" });
  }

  // 1. Tangkap latitude dan longitude dari payload frontend
  const { batch_id, to_username, notes, latitude, longitude } = req.body;
  if (!batch_id || !to_username) {
    return res.status(400).json({ error: "batch_id dan to_username wajib diisi" });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const batchResult = await client.query(
      'SELECT current_status, current_holder_id FROM seed_batches WHERE id = $1 FOR UPDATE',
      [batch_id]
    );
    if (batchResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Batch tidak ditemukan' });
    }
    if (batchResult.rows[0].current_status === 'CLAIMED') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Batch sudah diklaim petani, tidak bisa dikirim' });
    }
    if (batchResult.rows[0].current_status === 'SHIPPED') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Batch sedang dalam pengiriman, menunggu konfirmasi penerima' });
    }
    if (batchResult.rows[0].current_holder_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Anda bukan pemegang custody batch ini saat ini' });
    }

    const recipientResult = await client.query('SELECT id, role FROM users WHERE username = $1', [to_username]);
    if (recipientResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User penerima tidak ditemukan' });
    }
    const recipient = recipientResult.rows[0];

    // Validasi Logistik (Mencegah kirim ke Regulator atau Produsen)
    if (recipient.role === 'REGULATOR') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Pelanggaran Logistik: Aset fisik tidak dapat didistribusikan ke REGULATOR.' });
    }
    if (recipient.role === 'PRODUSEN') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Pelanggaran Logistik: Alur distribusi tidak dapat mundur kembali ke PRODUSEN.' });
    }

    await client.query(
      `UPDATE seed_batches SET current_status = 'SHIPPED', pending_recipient_id = $1 WHERE id = $2`,
      [recipient.id, batch_id]
    );

    // 2. Sertakan data koordinat GPS ke dalam hash dan metadata
    const locationData = (latitude && longitude) ? { lat: latitude, lng: longitude } : null;
    
    const hash = generateHash({ batch_id, from: req.user.id, to: recipient.id, notes, location: locationData, ts: Date.now() });
    
    await client.query(
      `INSERT INTO seed_history(batch_id, actor_id, action_type, blockchain_hash, metadata)
       VALUES ($1, $2, 'SHIPPED', $3, $4)`,
      [
        batch_id, 
        req.user.id, 
        hash, 
        JSON.stringify({ 
          to_username, 
          to_role: recipient.role, 
          notes: notes || null,
          location: locationData // Disimpan rapi dalam JSONB metadata
        })
      ]
    );

    await client.query('COMMIT');
    res.status(201).json({
      message: `Batch dikirim ke ${to_username}, menunggu konfirmasi penerimaan`,
      batch_id,
      current_status: 'SHIPPED',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/users', verifyToken, async (req, res) => {
  if (req.user.role !== 'REGULATOR') {
    return res.status(403).json({ error: "Hanya REGULATOR" });
  }
  try {
    const result = await pool.query(
      'SELECT id, username, email, role, created_at FROM users ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/lookup', verifyToken, async (req, res) => {
  const { username } = req.query;

  if (!username) {
    return res.status(400).json({ error: "Parameter username wajib diisi" });
  }

  try {
    const query = 'SELECT username, role FROM users WHERE username = $1';
    const result = await pool.query(query, [username]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Pengguna tidak ditemukan" });
    }

    res.status(200).json({
      username: result.rows[0].username,
      role: result.rows[0].role
    });
  } catch (err) {
    res.status(500).json({ error: "Kesalahan server saat memvalidasi pengguna: " + err.message });
  }
});

// Endpoint: Konfirmasi Penerimaan — langkah 2, penerima yang panggil (mirip kurir "diterima")
app.post('/api/confirm-receipt', verifyToken, async (req, res) => {
  // Tangkap latitude dan longitude saat penerima menekan tombol terima
  const { batch_id, latitude, longitude } = req.body;
  if (!batch_id) return res.status(400).json({ error: "batch_id wajib diisi" });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const batchResult = await client.query(
      'SELECT current_status, pending_recipient_id FROM seed_batches WHERE id = $1 FOR UPDATE',
      [batch_id]
    );
    if (batchResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Batch tidak ditemukan' });
    }
    if (batchResult.rows[0].current_status !== 'SHIPPED') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Batch tidak sedang dalam status dikirim' });
    }
    if (batchResult.rows[0].pending_recipient_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Anda bukan penerima yang dituju untuk batch ini' });
    }

    await client.query(
      `UPDATE seed_batches SET current_status = 'IN_TRANSIT', current_holder_id = $1, pending_recipient_id = NULL WHERE id = $2`,
      [req.user.id, batch_id]
    );

    const locationData = (latitude && longitude) ? { lat: latitude, lng: longitude } : null;
    const hash = generateHash({ batch_id, confirmed_by: req.user.id, location: locationData, ts: Date.now() });
    
    await client.query(
      `INSERT INTO seed_history(batch_id, actor_id, action_type, blockchain_hash, metadata)
       VALUES ($1, $2, 'RECEIPT_CONFIRMED', $3, $4)`,
      [
        batch_id, 
        req.user.id, 
        hash, 
        JSON.stringify({ location: locationData }) // Menyimpan koordinat GPS saat konfirmasi
      ]
    );

    await client.query('COMMIT');
    res.status(200).json({ message: 'Penerimaan dikonfirmasi', batch_id, current_status: 'IN_TRANSIT' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Endpoint: Tolak Penerimaan (opsional, mirip kurir gagal antar/dikembalikan)
app.post('/api/reject-receipt', verifyToken, async (req, res) => {
  const { batch_id, reason } = req.body;
  if (!batch_id) return res.status(400).json({ error: "batch_id wajib diisi" });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const batchResult = await client.query(
      'SELECT current_status, pending_recipient_id FROM seed_batches WHERE id = $1 FOR UPDATE',
      [batch_id]
    );
    if (batchResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Batch tidak ditemukan' });
    }
    if (batchResult.rows[0].current_status !== 'SHIPPED') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Batch tidak sedang dalam status dikirim' });
    }
    if (batchResult.rows[0].pending_recipient_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Anda bukan penerima yang dituju untuk batch ini' });
    }

    // Kembalikan status ke IN_TRANSIT (tetap dipegang pengirim, batal dikirim)
    await client.query(
      `UPDATE seed_batches SET current_status = 'IN_TRANSIT', pending_recipient_id = NULL WHERE id = $1`,
      [batch_id]
    );

    const hash = generateHash({ batch_id, rejected_by: req.user.id, reason, ts: Date.now() });
    await client.query(
      `INSERT INTO seed_history(batch_id, actor_id, action_type, blockchain_hash, metadata)
       VALUES ($1, $2, 'RECEIPT_REJECTED', $3, $4)`,
      [batch_id, req.user.id, hash, JSON.stringify({ reason: reason || null })]
    );

    await client.query('COMMIT');
    res.status(200).json({ message: 'Penerimaan ditolak, batch dikembalikan ke pengirim', batch_id });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Endpoint: Lihat batch yang menunggu konfirmasi saya (mirip "paket masuk" kurir)
app.get('/api/incoming-shipments', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.id AS batch_id, b.lot_number, v.name AS variety_name, u.username AS sender_name
       FROM seed_batches b
       LEFT JOIN varieties v ON b.variety_id = v.id
       LEFT JOIN users u ON b.current_holder_id = u.id
       WHERE b.pending_recipient_id = $1 AND b.current_status = 'SHIPPED'
       ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint: Registrasi User Baru — HANYA REGULATOR yang dapat menerbitkan akun
// (Sesuai proposal: registrasi akun tidak dibuka untuk publik)
app.post('/api/auth/register', verifyToken, async (req, res) => {
  if (req.user.role !== 'REGULATOR') {
    return res.status(403).json({ error: "Hanya REGULATOR yang dapat menerbitkan akun baru" });
  }

  const { username, email, password, role } = req.body;

  if (!['PRODUSEN', 'DISTRIBUTOR'].includes(role)) {
    return res.status(400).json({ error: "Role harus 'PRODUSEN' atau 'DISTRIBUTOR'" });
  }

  try {
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);

    const query = 'INSERT INTO users(username, email, password_hash, role) VALUES($1, $2, $3, $4) RETURNING id, username, role';
    const result = await pool.query(query, [username, email, password_hash, role]);

    res.status(201).json({ message: "User berhasil didaftarkan", user: result.rows[0] });
  } catch (err) {
    res.status(400).json({ error: "Gagal mendaftar. Username/Email mungkin sudah digunakan." });
  }
});

// Endpoint: Login & Dapatkan JWT
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const query = 'SELECT * FROM users WHERE username = $1';
    const result = await pool.query(query, [username]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Username tidak ditemukan" });
    }

    const user = result.rows[0];

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: "Password salah" });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ message: "Login berhasil", token, role: user.role });
  } catch (err) {
    res.status(500).json({ error: "Kesalahan internal server: " + err.message });
  }
});

// Endpoint: Ambil daftar user (REGULATOR only — untuk lihat siapa saja yang sudah terdaftar)
app.get('/api/users', verifyToken, async (req, res) => {
  if (req.user.role !== 'REGULATOR') {
    return res.status(403).json({ error: "Hanya REGULATOR" });
  }
  try {
    const result = await pool.query(
      'SELECT id, username, email, role, created_at FROM users ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------- SWAGGER SETUP -------------------

const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Smart Certification API',
      version: '1.0.0',
      description: 'API terpusat untuk validasi benih, model prediktif, dan audit trail blockchain',
    },
    paths: {
      '/api/auth/register': {
        post: {
          summary: 'Registrasi User Baru (REGULATOR only)',
          tags: ['Auth'],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    username: { type: 'string', example: 'balai_benih_ppks' },
                    email: { type: 'string', example: 'ppks@iopri.org' },
                    password: { type: 'string', example: 'password123' },
                    role: { type: 'string', example: 'PRODUSEN' }
                  }
                }
              }
            }
          },
          responses: {
            201: { description: 'User berhasil didaftarkan' },
            403: { description: 'Hanya REGULATOR yang dapat menerbitkan akun' }
          }
        }
      },
      '/api/auth/login': {
        post: {
          summary: 'Login User & Dapatkan JWT',
          tags: ['Auth'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    username: { type: 'string', example: 'editor_pkm' },
                    password: { type: 'string', example: 'password123' }
                  }
                }
              }
            }
          },
          responses: { 200: { description: 'Login berhasil' } }
        }
      },
      '/api/users': {
        get: {
          summary: 'Daftar semua user terdaftar (REGULATOR only)',
          tags: ['Auth'],
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'Berhasil' } }
        }
      },
      '/api/register-batch': {
        post: {
          summary: 'Registrasi Batch Benih',
          tags: ['Sertifikasi'],
          security: [{ bearerAuth: [] }],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    variety_id: { type: 'string', example: 'PPKS540' },
                    lot_number: { type: 'string', example: 'LOT-2026-001' },
                    certificate_number: { type: 'string', example: 'CERT-2026-001' }
                  }
                }
              }
            }
          },
          responses: { 201: { description: 'Sukses' } }
        }
      },

'/api/ship-batch': {
  post: {
    summary: 'Kirim Batch ke Penerima (langkah 1 — menunggu konfirmasi)',
    tags: ['Sertifikasi'],
    security: [{ bearerAuth: [] }],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              batch_id: { type: 'integer', example: 1 },
              to_username: { type: 'string', example: 'distributor_jaya' },
              notes: { type: 'string', example: 'Serah terima gudang transit' }
            }
          }
        }
      }
    },
    responses: { 201: { description: 'Batch dikirim, menunggu konfirmasi' } }
  }
},
'/api/confirm-receipt': {
  post: {
    summary: 'Konfirmasi Penerimaan Batch (langkah 2)',
    tags: ['Sertifikasi'],
    security: [{ bearerAuth: [] }],
    requestBody: {
      content: {
        'application/json': {
          schema: { type: 'object', properties: { batch_id: { type: 'integer', example: 1 } } }
        }
      }
    },
    responses: { 200: { description: 'Penerimaan dikonfirmasi' } }
  }
},
'/api/reject-receipt': {
  post: {
    summary: 'Tolak Penerimaan Batch',
    tags: ['Sertifikasi'],
    security: [{ bearerAuth: [] }],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { batch_id: { type: 'integer', example: 1 }, reason: { type: 'string' } }
          }
        }
      }
    },
    responses: { 200: { description: 'Penerimaan ditolak' } }
  }
},
'/api/incoming-shipments': {
  get: {
    summary: 'Daftar kiriman yang menunggu konfirmasi saya',
    tags: ['Sertifikasi'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Berhasil' } }
  }
},
      '/api/seeds': {
        get: { summary: 'Ambil semua data master benih', tags: ['Sertifikasi'], responses: { 200: { description: 'Berhasil' } } }
      },
      '/api/varieties': {
        get: { summary: 'Ambil semua data master varietas', tags: ['Sertifikasi'], responses: { 200: { description: 'Berhasil' } } }
      },
      '/api/public/verify-batch': {
        post: {
          summary: 'Verifikasi Petani',
          tags: ['Sertifikasi Publik'],
          requestBody: {
            content: {
              'application/json': {
                schema: { type: 'object', properties: { batch_id: { type: 'integer' }, token: { type: 'string' } } }
              }
            }
          },
          responses: { 200: { description: 'Sukses' } }
        }
      },
      '/api/batches/{id}/history': {
        get: {
          summary: 'Lacak Riwayat Perjalanan Batch',
          tags: ['Sertifikasi Publik'],
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' }, description: 'ID batch' }],
          responses: { 200: { description: 'Data riwayat ditemukan' } }
        }
      }
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }
      }
    }
  },
  apis: []
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
}, swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ------------------- SERVER INIT -------------------
app.listen(3000, () => console.log('API Gateway running on port 3000'));
