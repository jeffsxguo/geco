package main

import (
	"log"
	"os"

	"github.com/hyperledger/fabric-chaincode-go/shim"
)

func main() {
	ccid := os.Getenv("CHAINCODE_ID")
	if ccid == "" {
		ccid = os.Getenv("CORE_CHAINCODE_ID_NAME")
	}

	addr := os.Getenv("CHAINCODE_SERVER_ADDRESS")
	if addr == "" {
		addr = "0.0.0.0:9999"
	}

	server := &shim.ChaincodeServer{
		CCID:     ccid,
		Address:  addr,
		CC:       new(SmallBankChaincode),
		TLSProps: shim.TLSProperties{Disabled: true},
	}

	if err := server.Start(); err != nil {
		log.Fatalf("chaincode server start failed: %v", err)
	}
}
