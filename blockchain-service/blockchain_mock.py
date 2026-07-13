from flask import Flask, request, jsonify

app = Flask(__name__)

# Simulasi Ledger (In-memory storage)
ledger = {}

@app.route('/record', methods=['POST'])
def record_certification():
    data = request.json
    seed_id = data.get('seed_id')
    hash_val = data.get('hash')
    
    # Simulasi simpan ke blockchain
    ledger[seed_id] = hash_val
    print(f"[BLOCKCHAIN] Data tersimpan: {seed_id} -> {hash_val}")
    
    return jsonify({"status": "success", "message": "Hash recorded in ledger"})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=9000)
