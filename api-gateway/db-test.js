const { Client } = require('pg');

const client = new Client({
  host: 'db', // Nama service di docker-compose.yml
  user: 'user',
  password: 'password',
  database: 'smart_cert_db',
  port: 5432,
});

client.connect()
  .then(() => {
    console.log('Berhasil terhubung ke database PostgreSQL!');
    client.end();
  })
  .catch(err => {
    console.error('Gagal terhubung:', err.message);
  });
