-- 1. Tabel untuk menyimpan data user
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Tabel untuk menyimpan riwayat sertifikasi
CREATE TABLE sertifikasi (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    seed_id VARCHAR(50) NOT NULL,
    ai_status BOOLEAN DEFAULT FALSE,
    blockchain_hash VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
