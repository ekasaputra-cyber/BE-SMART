const { Pool } = require('pg');

const pool = new Pool({
  user: 'user',
  host: 'smart-certification-db-1', // Sesuaikan dengan nama container db Anda
  database: 'smart_cert_db',
  password: 'password',
  port: 5432,
});

module.exports = pool;
