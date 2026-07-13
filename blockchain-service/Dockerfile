FROM python:3.9-slim
WORKDIR /app
# Install dependensi untuk menjalankan script jembatan API
RUN pip install flask
COPY . .
# Menjalankan script mock yang akan memanggil logika Go Anda
CMD ["python", "blockchain_mock.py"]
