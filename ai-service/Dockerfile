# Gunakan image base python yang ringan
FROM python:3.9-slim

# Set direktori kerja di dalam container
WORKDIR /app

# Install dependency sistem yang mungkin dibutuhkan oleh TensorFlow
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Salin requirements.txt terlebih dahulu untuk memanfaatkan Docker Cache
COPY requirements.txt .

# Install pustaka Python (menggunakan --no-cache-dir agar image lebih kecil)
RUN pip install --no-cache-dir -r requirements.txt

# Salin sisa kode aplikasi ke dalam container
COPY . .

# Mengekspos port 8000 yang digunakan oleh FastAPI
EXPOSE 8000

# Perintah untuk menjalankan aplikasi
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
