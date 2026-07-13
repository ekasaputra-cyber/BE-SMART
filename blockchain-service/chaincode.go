package main

import (
    "fmt"
    "github.com/hyperledger/fabric-contract-api-go/contractapi"
)

type SmartContract struct {
    contractapi.Contract
}

// RecordCertification menyimpan hash data benih ke ledger
func (s *SmartContract) RecordCertification(ctx contractapi.TransactionContextInterface, seedID string, hash string) error {
    // Mengecek apakah ID sudah ada
    existing, _ := ctx.GetStub().GetState(seedID)
    if existing != nil {
        return fmt.Errorf("data untuk benih %s sudah ada", seedID)
    }

    // Menyimpan hash ke ledger
    return ctx.GetStub().PutState(seedID, []byte(hash))
}

func main() {
    // (Konfigurasi main untuk menjalankan contract)
}
