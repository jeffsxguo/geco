package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/hyperledger/fabric-chaincode-go/shim"
	"github.com/hyperledger/fabric-protos-go/peer"
	"github.com/tuneinsight/lattigo/v5/core/rlwe"
	"github.com/tuneinsight/lattigo/v5/schemes/bfv"
)

type fheContext struct {
	params    bfv.Parameters
	encoder   *bfv.Encoder
	evaluator *bfv.Evaluator
	encryptor *rlwe.Encryptor
	encryptMu sync.Mutex

	t uint64
}

var (
	fheMu  sync.Mutex
	fheCtx *fheContext
)

func fheParamSetName() string {
	name := os.Getenv("GECO_FHE_PARAM_SET")
	if name == "" {
		return "insecure"
	}
	return name
}

func fheProfilingEnabled() bool {
	return strings.TrimSpace(os.Getenv("GECO_PROFILE_P")) == "1"
}

func getOrInitFHEContext() (*fheContext, error) {
	fheMu.Lock()
	defer fheMu.Unlock()

	if fheCtx != nil {
		return fheCtx, nil
	}

	// NOTE: For the baseline we keep parameters fixed/hard-coded to reduce
	// orchestration complexity. This is sufficient for measuring overhead of
	// ciphertext state + homomorphic add/sub on Fabric.
	//
	// If you later want to sweep FHE parameters, add a chaincode function to
	// set params and/or accept them in InitLedgerFHE, then cache them here.
	var paramsLiteral bfv.ParametersLiteral
	switch fheParamSetName() {
	case "secure128", "secure":
		paramsLiteral = bfv.ExampleParameters128BitLogN14LogQP438
	default:
		// Insecure (small) parameters for quick baseline runs.
		// PlaintextModulus=65537 satisfies t = 1 mod 2N for N=2^10.
		paramsLiteral = bfv.ParametersLiteral{
			LogN:             10,
			Q:                []uint64{0x3fffffa8001, 0x1000090001, 0x10000c8001, 0x10000f0001, 0xffff00001},
			P:                []uint64{0x7fffffd8001},
			PlaintextModulus: 65537,
		}
	}

	params, err := bfv.NewParametersFromLiteral(paramsLiteral)
	if err != nil {
		return nil, err
	}

	pk, err := loadPublicKeyFromEnv(params)
	if err != nil {
		return nil, err
	}
	if pk == nil {
		kgen := bfv.NewKeyGenerator(params)
		sk, freshPk := kgen.GenKeyPairNew()
		pk = freshPk
		_ = sk // secret key not needed for on-chain add/sub evaluation baseline
	}

	encoder := bfv.NewEncoder(params)
	encryptor := bfv.NewEncryptor(params, pk)
	evaluator := bfv.NewEvaluator(params, rlwe.NewMemEvaluationKeySet(nil))

	fheCtx = &fheContext{
		params:    params,
		encoder:   encoder,
		evaluator: evaluator,
		encryptor: encryptor,
		t:         params.PlaintextModulus(),
	}

	return fheCtx, nil
}

func loadPublicKeyFromEnv(params bfv.Parameters) (*rlwe.PublicKey, error) {
	b64 := strings.TrimSpace(os.Getenv("GECO_FHE_PUBKEY_B64"))
	if b64 == "" {
		return nil, nil
	}
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, fmt.Errorf("decode GECO_FHE_PUBKEY_B64: %w", err)
	}
	pk := rlwe.NewPublicKey(params)
	if err := pk.UnmarshalBinary(raw); err != nil {
		return nil, fmt.Errorf("unmarshal GECO_FHE_PUBKEY_B64: %w", err)
	}
	return pk, nil
}

func (c *SmallBankChaincode) initLedgerFHE(stub shim.ChaincodeStubInterface, args []string) peer.Response {
	if len(args) != 2 {
		return shim.Error("InitLedgerFHE expects 2 args: numAccounts, initialBalance")
	}

	numAccounts, err := strconv.Atoi(args[0])
	if err != nil || numAccounts <= 0 {
		return shim.Error("numAccounts must be a positive integer")
	}

	initialBalance, err := strconv.ParseInt(args[1], 10, 64)
	if err != nil || initialBalance < 0 {
		return shim.Error("initialBalance must be an integer >= 0")
	}

	ctx, err := getOrInitFHEContext()
	if err != nil {
		return shim.Error(fmt.Sprintf("init FHE context: %v", err))
	}

	// Encode a single integer in the first slot only.
	pt := bfv.NewPlaintext(ctx.params, ctx.params.MaxLevel())
	if err := ctx.encoder.Encode([]uint64{uint64(initialBalance) % ctx.t}, pt); err != nil {
		return shim.Error(fmt.Sprintf("encode initial balance: %v", err))
	}

	for i := 1; i <= numAccounts; i++ {
		id := fmt.Sprintf("acct%08d", i)
		key := accountFHEKey(id)

		existsBytes, err := stub.GetState(key)
		if err != nil {
			return shim.Error(err.Error())
		}
		if existsBytes != nil {
			continue
		}

		ct, err := ctx.encryptor.EncryptNew(pt)
		if err != nil {
			return shim.Error(fmt.Sprintf("encrypt initial balance: %v", err))
		}
		ctBytes, err := ct.MarshalBinary()
		if err != nil {
			return shim.Error(fmt.Sprintf("marshal ciphertext: %v", err))
		}

		if err := stub.PutState(key, ctBytes); err != nil {
			return shim.Error(err.Error())
		}
	}

	return shim.Success(nil)
}

func (c *SmallBankChaincode) resetLedgerFHE(stub shim.ChaincodeStubInterface, args []string) peer.Response {
	if len(args) != 2 {
		return shim.Error("ResetLedgerFHE expects 2 args: numAccounts, initialBalance")
	}

	numAccounts, err := strconv.Atoi(args[0])
	if err != nil || numAccounts <= 0 {
		return shim.Error("numAccounts must be a positive integer")
	}

	initialBalance, err := strconv.ParseInt(args[1], 10, 64)
	if err != nil || initialBalance < 0 {
		return shim.Error("initialBalance must be an integer >= 0")
	}

	ctx, err := getOrInitFHEContext()
	if err != nil {
		return shim.Error(fmt.Sprintf("init FHE context: %v", err))
	}

	pt := bfv.NewPlaintext(ctx.params, ctx.params.MaxLevel())
	if err := ctx.encoder.Encode([]uint64{uint64(initialBalance) % ctx.t}, pt); err != nil {
		return shim.Error(fmt.Sprintf("encode initial balance: %v", err))
	}

	for i := 1; i <= numAccounts; i++ {
		id := fmt.Sprintf("acct%08d", i)
		key := accountFHEKey(id)

		ct, err := ctx.encryptor.EncryptNew(pt)
		if err != nil {
			return shim.Error(fmt.Sprintf("encrypt initial balance: %v", err))
		}
		ctBytes, err := ct.MarshalBinary()
		if err != nil {
			return shim.Error(fmt.Sprintf("marshal ciphertext: %v", err))
		}

		if err := stub.PutState(key, ctBytes); err != nil {
			return shim.Error(err.Error())
		}
	}

	return shim.Success(nil)
}

func (c *SmallBankChaincode) initLedgerFHEBatch(stub shim.ChaincodeStubInterface, args []string) peer.Response {
	if len(args) != 3 {
		return shim.Error("InitLedgerFHEBatch expects 3 args: startAccount, count, initialBalance")
	}

	startAccount, err := strconv.Atoi(args[0])
	if err != nil || startAccount <= 0 {
		return shim.Error("startAccount must be a positive integer")
	}

	count, err := strconv.Atoi(args[1])
	if err != nil || count <= 0 {
		return shim.Error("count must be a positive integer")
	}

	initialBalance, err := strconv.ParseInt(args[2], 10, 64)
	if err != nil || initialBalance < 0 {
		return shim.Error("initialBalance must be an integer >= 0")
	}

	ctx, err := getOrInitFHEContext()
	if err != nil {
		return shim.Error(fmt.Sprintf("init FHE context: %v", err))
	}

	pt := bfv.NewPlaintext(ctx.params, ctx.params.MaxLevel())
	if err := ctx.encoder.Encode([]uint64{uint64(initialBalance) % ctx.t}, pt); err != nil {
		return shim.Error(fmt.Sprintf("encode initial balance: %v", err))
	}

	endAccount := startAccount + count - 1
	for i := startAccount; i <= endAccount; i++ {
		id := fmt.Sprintf("acct%08d", i)
		key := accountFHEKey(id)

		existsBytes, err := stub.GetState(key)
		if err != nil {
			return shim.Error(err.Error())
		}
		if existsBytes != nil {
			continue
		}

		ct, err := ctx.encryptor.EncryptNew(pt)
		if err != nil {
			return shim.Error(fmt.Sprintf("encrypt initial balance: %v", err))
		}
		ctBytes, err := ct.MarshalBinary()
		if err != nil {
			return shim.Error(fmt.Sprintf("marshal ciphertext: %v", err))
		}

		if err := stub.PutState(key, ctBytes); err != nil {
			return shim.Error(err.Error())
		}
	}

	return shim.Success(nil)
}

func (c *SmallBankChaincode) resetLedgerFHEBatch(stub shim.ChaincodeStubInterface, args []string) peer.Response {
	if len(args) != 3 {
		return shim.Error("ResetLedgerFHEBatch expects 3 args: startAccount, count, initialBalance")
	}

	startAccount, err := strconv.Atoi(args[0])
	if err != nil || startAccount <= 0 {
		return shim.Error("startAccount must be a positive integer")
	}

	count, err := strconv.Atoi(args[1])
	if err != nil || count <= 0 {
		return shim.Error("count must be a positive integer")
	}

	initialBalance, err := strconv.ParseInt(args[2], 10, 64)
	if err != nil || initialBalance < 0 {
		return shim.Error("initialBalance must be an integer >= 0")
	}

	ctx, err := getOrInitFHEContext()
	if err != nil {
		return shim.Error(fmt.Sprintf("init FHE context: %v", err))
	}

	pt := bfv.NewPlaintext(ctx.params, ctx.params.MaxLevel())
	if err := ctx.encoder.Encode([]uint64{uint64(initialBalance) % ctx.t}, pt); err != nil {
		return shim.Error(fmt.Sprintf("encode initial balance: %v", err))
	}

	endAccount := startAccount + count - 1
	for i := startAccount; i <= endAccount; i++ {
		id := fmt.Sprintf("acct%08d", i)
		key := accountFHEKey(id)

		ct, err := ctx.encryptor.EncryptNew(pt)
		if err != nil {
			return shim.Error(fmt.Sprintf("encrypt initial balance: %v", err))
		}
		ctBytes, err := ct.MarshalBinary()
		if err != nil {
			return shim.Error(fmt.Sprintf("marshal ciphertext: %v", err))
		}

		if err := stub.PutState(key, ctBytes); err != nil {
			return shim.Error(err.Error())
		}
	}

	return shim.Success(nil)
}

func (c *SmallBankChaincode) transferFHECipher(stub shim.ChaincodeStubInterface, args []string) peer.Response {
	if len(args) != 3 {
		return shim.Error("TransferFHECipher expects 3 args: from, to, amountCipherB64")
	}

	from := args[0]
	to := args[1]
	amountCipherB64 := args[2]

	if from == to {
		return shim.Error("from and to must be different")
	}

	ctx, err := getOrInitFHEContext()
	if err != nil {
		return shim.Error(fmt.Sprintf("init FHE context: %v", err))
	}

	amountBytes, err := base64.StdEncoding.DecodeString(amountCipherB64)
	if err != nil {
		return shim.Error(fmt.Sprintf("decode amount ciphertext: %v", err))
	}
	amountCt := bfv.NewCiphertext(ctx.params, 1, ctx.params.MaxLevel())
	if err := amountCt.UnmarshalBinary(amountBytes); err != nil {
		return shim.Error(fmt.Sprintf("decode amount ciphertext: %v", err))
	}

	fromKey := accountFHEKey(from)
	toKey := accountFHEKey(to)

	fromBytes, err := stub.GetState(fromKey)
	if err != nil {
		return shim.Error(err.Error())
	}
	toBytes, err := stub.GetState(toKey)
	if err != nil {
		return shim.Error(err.Error())
	}
	if fromBytes == nil || toBytes == nil {
		return shim.Error("FHE account not found")
	}

	fromCt := bfv.NewCiphertext(ctx.params, 1, ctx.params.MaxLevel())
	if err := fromCt.UnmarshalBinary(fromBytes); err != nil {
		return shim.Error(fmt.Sprintf("decode from ciphertext: %v", err))
	}
	toCt := bfv.NewCiphertext(ctx.params, 1, ctx.params.MaxLevel())
	if err := toCt.UnmarshalBinary(toBytes); err != nil {
		return shim.Error(fmt.Sprintf("decode to ciphertext: %v", err))
	}

	if err := ctx.evaluator.Sub(fromCt, amountCt, fromCt); err != nil {
		return shim.Error(fmt.Sprintf("sub amount: %v", err))
	}
	if err := ctx.evaluator.Add(toCt, amountCt, toCt); err != nil {
		return shim.Error(fmt.Sprintf("add amount: %v", err))
	}

	updatedFrom, err := fromCt.MarshalBinary()
	if err != nil {
		return shim.Error(fmt.Sprintf("marshal from ciphertext: %v", err))
	}
	updatedTo, err := toCt.MarshalBinary()
	if err != nil {
		return shim.Error(fmt.Sprintf("marshal to ciphertext: %v", err))
	}

	if err := stub.PutState(fromKey, updatedFrom); err != nil {
		return shim.Error(err.Error())
	}
	if err := stub.PutState(toKey, updatedTo); err != nil {
		return shim.Error(err.Error())
	}

	if fheProfilingEnabled() {
		payload, err := json.Marshal(map[string]float64{
			"p_encode_ms": 0,
			"p_encrypt_ms": 0,
		})
		if err != nil {
			return shim.Error(fmt.Sprintf("marshal profiling payload: %v", err))
		}
		return shim.Success(payload)
	}

	return shim.Success(nil)
}

func (c *SmallBankChaincode) transferFHE(stub shim.ChaincodeStubInterface, args []string) peer.Response {
	if len(args) != 3 {
		return shim.Error("TransferFHE expects 3 args: from, to, amount")
	}

	from := args[0]
	to := args[1]
	amountStr := args[2]

	if from == to {
		return shim.Error("from and to must be different")
	}

	amount, err := strconv.ParseInt(amountStr, 10, 64)
	if err != nil || amount <= 0 {
		return shim.Error(fmt.Sprintf("invalid amount: %s", amountStr))
	}

	ctx, err := getOrInitFHEContext()
	if err != nil {
		return shim.Error(fmt.Sprintf("init FHE context: %v", err))
	}

	fromKey := accountFHEKey(from)
	toKey := accountFHEKey(to)

	fromBytes, err := stub.GetState(fromKey)
	if err != nil {
		return shim.Error(err.Error())
	}
	toBytes, err := stub.GetState(toKey)
	if err != nil {
		return shim.Error(err.Error())
	}
	if fromBytes == nil || toBytes == nil {
		return shim.Error("FHE account not found")
	}

	fromCt := bfv.NewCiphertext(ctx.params, 1, ctx.params.MaxLevel())
	if err := fromCt.UnmarshalBinary(fromBytes); err != nil {
		return shim.Error(fmt.Sprintf("decode from ciphertext: %v", err))
	}
	toCt := bfv.NewCiphertext(ctx.params, 1, ctx.params.MaxLevel())
	if err := toCt.UnmarshalBinary(toBytes); err != nil {
		return shim.Error(fmt.Sprintf("decode to ciphertext: %v", err))
	}

	encodeStart := time.Now()
	ptPlus := bfv.NewPlaintext(ctx.params, ctx.params.MaxLevel())
	if err := ctx.encoder.Encode([]uint64{uint64(amount) % ctx.t}, ptPlus); err != nil {
		return shim.Error(fmt.Sprintf("encode amount: %v", err))
	}

	// Encode (-amount) mod t for subtraction without decryption.
	neg := (ctx.t - (uint64(amount) % ctx.t)) % ctx.t
	ptMinus := bfv.NewPlaintext(ctx.params, ctx.params.MaxLevel())
	if err := ctx.encoder.Encode([]uint64{neg}, ptMinus); err != nil {
		return shim.Error(fmt.Sprintf("encode -amount: %v", err))
	}
	encodeMs := float64(time.Since(encodeStart).Nanoseconds()) / 1e6

	encryptStart := time.Now()
	ctx.encryptMu.Lock()
	ctMinus, err := ctx.encryptor.EncryptNew(ptMinus)
	if err != nil {
		ctx.encryptMu.Unlock()
		return shim.Error(fmt.Sprintf("encrypt -amount: %v", err))
	}
	ctPlus, err := ctx.encryptor.EncryptNew(ptPlus)
	ctx.encryptMu.Unlock()
	if err != nil {
		return shim.Error(fmt.Sprintf("encrypt amount: %v", err))
	}
	encryptMs := float64(time.Since(encryptStart).Nanoseconds()) / 1e6

	if err := ctx.evaluator.Add(fromCt, ctMinus, fromCt); err != nil {
		return shim.Error(fmt.Sprintf("add -amount: %v", err))
	}
	if err := ctx.evaluator.Add(toCt, ctPlus, toCt); err != nil {
		return shim.Error(fmt.Sprintf("add +amount: %v", err))
	}

	updatedFrom, err := fromCt.MarshalBinary()
	if err != nil {
		return shim.Error(fmt.Sprintf("marshal from ciphertext: %v", err))
	}
	updatedTo, err := toCt.MarshalBinary()
	if err != nil {
		return shim.Error(fmt.Sprintf("marshal to ciphertext: %v", err))
	}

	if err := stub.PutState(fromKey, updatedFrom); err != nil {
		return shim.Error(err.Error())
	}
	if err := stub.PutState(toKey, updatedTo); err != nil {
		return shim.Error(err.Error())
	}

	if fheProfilingEnabled() {
		payload, err := json.Marshal(map[string]float64{
			"p_encode_ms":  encodeMs,
			"p_encrypt_ms": encryptMs,
		})
		if err != nil {
			return shim.Error(fmt.Sprintf("marshal profiling payload: %v", err))
		}
		return shim.Success(payload)
	}

	return shim.Success(nil)
}
