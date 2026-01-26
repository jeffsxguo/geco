package main

import (
	"encoding/base64"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/tuneinsight/lattigo/v5/core/rlwe"
	"github.com/tuneinsight/lattigo/v5/schemes/bfv"
)

func fheParamSetName() string {
	name := os.Getenv("GECO_FHE_PARAM_SET")
	if name == "" {
		return "insecure"
	}
	return name
}

func loadParams() (bfv.Parameters, error) {
	var paramsLiteral bfv.ParametersLiteral
	switch fheParamSetName() {
	case "secure128", "secure":
		paramsLiteral = bfv.ExampleParameters128BitLogN14LogQP438
	default:
		paramsLiteral = bfv.ParametersLiteral{
			LogN:             10,
			Q:                []uint64{0x3fffffa8001, 0x1000090001, 0x10000c8001, 0x10000f0001, 0xffff00001},
			P:                []uint64{0x7fffffd8001},
			PlaintextModulus: 65537,
		}
	}
	return bfv.NewParametersFromLiteral(paramsLiteral)
}

func keygen() error {
	params, err := loadParams()
	if err != nil {
		return err
	}

	kgen := bfv.NewKeyGenerator(params)
	_, pk := kgen.GenKeyPairNew()
	pkBytes, err := pk.MarshalBinary()
	if err != nil {
		return err
	}
	fmt.Println(base64.StdEncoding.EncodeToString(pkBytes))
	return nil
}

func encryptAmount(amountStr, pubkeyB64 string) error {
	amount, err := strconv.ParseInt(amountStr, 10, 64)
	if err != nil || amount <= 0 {
		return fmt.Errorf("invalid amount: %s", amountStr)
	}

	params, err := loadParams()
	if err != nil {
		return err
	}

	pubkeyB64 = strings.TrimSpace(pubkeyB64)
	if pubkeyB64 == "" {
		return fmt.Errorf("missing public key (use -pubkey-b64 or GECO_FHE_PUBKEY_B64)")
	}

	raw, err := base64.StdEncoding.DecodeString(pubkeyB64)
	if err != nil {
		return fmt.Errorf("decode public key: %w", err)
	}
	pk := rlwe.NewPublicKey(params)
	if err := pk.UnmarshalBinary(raw); err != nil {
		return fmt.Errorf("unmarshal public key: %w", err)
	}

	encoder := bfv.NewEncoder(params)
	encryptor := bfv.NewEncryptor(params, pk)

	pt := bfv.NewPlaintext(params, params.MaxLevel())
	if err := encoder.Encode([]uint64{uint64(amount) % params.PlaintextModulus()}, pt); err != nil {
		return fmt.Errorf("encode amount: %w", err)
	}

	ct, err := encryptor.EncryptNew(pt)
	if err != nil {
		return fmt.Errorf("encrypt amount: %w", err)
	}
	ctBytes, err := ct.MarshalBinary()
	if err != nil {
		return fmt.Errorf("marshal ciphertext: %w", err)
	}
	fmt.Println(base64.StdEncoding.EncodeToString(ctBytes))
	return nil
}

func main() {
	mode := flag.String("mode", "keygen", "keygen or encrypt")
	amount := flag.String("amount", "", "amount to encrypt (for encrypt mode)")
	pubkeyB64 := flag.String("pubkey-b64", "", "public key in base64 (default: GECO_FHE_PUBKEY_B64)")
	pubkeyFile := flag.String("pubkey-file", "", "path to public key base64 file (overrides -pubkey-b64)")
	flag.Parse()

	switch *mode {
	case "keygen":
		if err := keygen(); err != nil {
			fmt.Fprintf(os.Stderr, "keygen error: %v\n", err)
			os.Exit(1)
		}
	case "encrypt":
		pk := *pubkeyB64
		if *pubkeyFile != "" {
			raw, err := os.ReadFile(*pubkeyFile)
			if err != nil {
				fmt.Fprintf(os.Stderr, "encrypt error: read public key file: %v\n", err)
				os.Exit(1)
			}
			pk = string(raw)
		}
		if pk == "" {
			pk = os.Getenv("GECO_FHE_PUBKEY_B64")
		}
		if *amount == "" {
			fmt.Fprintln(os.Stderr, "encrypt error: missing -amount")
			os.Exit(1)
		}
		if err := encryptAmount(*amount, pk); err != nil {
			fmt.Fprintf(os.Stderr, "encrypt error: %v\n", err)
			os.Exit(1)
		}
	default:
		fmt.Fprintf(os.Stderr, "unknown mode: %s\n", *mode)
		os.Exit(1)
	}
}
