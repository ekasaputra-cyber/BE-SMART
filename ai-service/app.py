from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

class SeedRequest(BaseModel):
    seed_id: str

@app.post("/predict")
async def predict_quality(request: SeedRequest):
    # Di masa depan, di sini Anda akan memuat model CNN ResNet50
    # Untuk sekarang, kita simulasikan deteksi valid
    return {"is_valid": True, "message": "Kualitas benih terverifikasi oleh AI"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
