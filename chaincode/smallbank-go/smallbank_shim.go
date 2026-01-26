package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"

	"github.com/hyperledger/fabric-chaincode-go/shim"
	"github.com/hyperledger/fabric-protos-go/peer"
)

type SmallBankChaincode struct{}

type Account struct {
	ID      string `json:"id"`
	Balance int64  `json:"balance"`
}

type Transfer struct {
	From   string `json:"from"`
	To     string `json:"to"`
	Amount int64  `json:"amount"`
}

func accountKey(id string) string {
	return "acct:" + id
}

func bookKey(id string) string {
	return "book:" + id
}

func shareKey(id string) string {
	return "share:" + id
}

func accountFHEKey(id string) string {
	// Separate namespaces per parameter set, to allow switching between
	// "insecure" and "secure" presets without wiping the ledger.
	return "acct_fhe:" + fheParamSetName() + ":" + id
}

func (c *SmallBankChaincode) Init(stub shim.ChaincodeStubInterface) peer.Response {
	return shim.Success(nil)
}

func (c *SmallBankChaincode) Invoke(stub shim.ChaincodeStubInterface) peer.Response {
	function, args := stub.GetFunctionAndParameters()
	switch function {
	case "InitLedger":
		return c.initLedger(stub, args)
	case "ResetLedger":
		return c.resetLedger(stub, args)
	case "InitLedgerFHE":
		return c.initLedgerFHE(stub, args)
	case "ResetLedgerFHE":
		return c.resetLedgerFHE(stub, args)
	case "InitLedgerFHEBatch":
		return c.initLedgerFHEBatch(stub, args)
	case "ResetLedgerFHEBatch":
		return c.resetLedgerFHEBatch(stub, args)
	case "InitBookLedger":
		return c.initBookLedger(stub, args)
	case "InitShareLedger":
		return c.initShareLedger(stub, args)
	case "Transfer":
		return c.transfer(stub, args)
	case "TransferFHE":
		return c.transferFHE(stub, args)
	case "TransferFHECipher":
		return c.transferFHECipher(stub, args)
	case "Trade":
		return c.trade(stub, args)
	case "AccountTxn":
		return c.accountTxn(stub, args)
	case "BatchTransfer":
		return c.batchTransfer(stub, args)
	case "ApplyDeltas":
		return c.applyDeltas(stub, args)
	case "ReadAccount":
		return c.readAccount(stub, args)
	case "AccountExists":
		return c.accountExists(stub, args)
	default:
		return shim.Error(fmt.Sprintf("unknown function: %s", function))
	}
}

func (c *SmallBankChaincode) initLedger(stub shim.ChaincodeStubInterface, args []string) peer.Response {
	if len(args) != 2 {
		return shim.Error("InitLedger expects 2 args: numAccounts, initialBalance")
	}

	numAccounts, err := strconv.Atoi(args[0])
	if err != nil || numAccounts <= 0 {
		return shim.Error("numAccounts must be a positive integer")
	}

	initialBalance, err := strconv.ParseInt(args[1], 10, 64)
	if err != nil || initialBalance < 0 {
		return shim.Error("initialBalance must be an integer >= 0")
	}

	for i := 1; i <= numAccounts; i++ {
		id := fmt.Sprintf("acct%08d", i)
		key := accountKey(id)

		existsBytes, err := stub.GetState(key)
		if err != nil {
			return shim.Error(err.Error())
		}
		if existsBytes != nil {
			continue
		}

		acct := Account{ID: id, Balance: initialBalance}
		b, err := json.Marshal(acct)
		if err != nil {
			return shim.Error(err.Error())
		}
		if err := stub.PutState(key, b); err != nil {
			return shim.Error(err.Error())
		}
	}

	return shim.Success(nil)
}

func (c *SmallBankChaincode) resetLedger(stub shim.ChaincodeStubInterface, args []string) peer.Response {
	if len(args) != 2 {
		return shim.Error("ResetLedger expects 2 args: numAccounts, initialBalance")
	}

	numAccounts, err := strconv.Atoi(args[0])
	if err != nil || numAccounts <= 0 {
		return shim.Error("numAccounts must be a positive integer")
	}

	initialBalance, err := strconv.ParseInt(args[1], 10, 64)
	if err != nil || initialBalance < 0 {
		return shim.Error("initialBalance must be an integer >= 0")
	}

	for i := 1; i <= numAccounts; i++ {
		id := fmt.Sprintf("acct%08d", i)
		key := accountKey(id)

		acct := Account{ID: id, Balance: initialBalance}
		b, err := json.Marshal(acct)
		if err != nil {
			return shim.Error(err.Error())
		}
		if err := stub.PutState(key, b); err != nil {
			return shim.Error(err.Error())
		}
	}

	return shim.Success(nil)
}

func (c *SmallBankChaincode) initBookLedger(stub shim.ChaincodeStubInterface, args []string) peer.Response {
	if len(args) != 2 {
		return shim.Error("InitBookLedger expects 2 args: numAccounts, initialValue")
	}

	numAccounts, err := strconv.Atoi(args[0])
	if err != nil || numAccounts <= 0 {
		return shim.Error("numAccounts must be a positive integer")
	}

	initialValue, err := strconv.ParseInt(args[1], 10, 64)
	if err != nil {
		return shim.Error("initialValue must be an integer")
	}

	for i := 1; i <= numAccounts; i++ {
		id := fmt.Sprintf("acct%08d", i)
		key := bookKey(id)

		existsBytes, err := stub.GetState(key)
		if err != nil {
			return shim.Error(err.Error())
		}
		if existsBytes != nil {
			continue
		}

		b := []byte(strconv.FormatInt(initialValue, 10))
		if err := stub.PutState(key, b); err != nil {
			return shim.Error(err.Error())
		}
	}

	return shim.Success(nil)
}

func (c *SmallBankChaincode) initShareLedger(stub shim.ChaincodeStubInterface, args []string) peer.Response {
	if len(args) != 2 {
		return shim.Error("InitShareLedger expects 2 args: numAccounts, initialShares")
	}

	numAccounts, err := strconv.Atoi(args[0])
	if err != nil || numAccounts <= 0 {
		return shim.Error("numAccounts must be a positive integer")
	}

	initialShares, err := strconv.ParseInt(args[1], 10, 64)
	if err != nil {
		return shim.Error("initialShares must be an integer")
	}

	for i := 1; i <= numAccounts; i++ {
		id := fmt.Sprintf("acct%08d", i)
		key := shareKey(id)

		existsBytes, err := stub.GetState(key)
		if err != nil {
			return shim.Error(err.Error())
		}
		if existsBytes != nil {
			continue
		}

		b := []byte(strconv.FormatInt(initialShares, 10))
		if err := stub.PutState(key, b); err != nil {
			return shim.Error(err.Error())
		}
	}

	return shim.Success(nil)
}

func (c *SmallBankChaincode) accountExists(stub shim.ChaincodeStubInterface, args []string) peer.Response {
	if len(args) != 1 {
		return shim.Error("AccountExists expects 1 arg: id")
	}
	id := args[0]
	b, err := stub.GetState(accountKey(id))
	if err != nil {
		return shim.Error(err.Error())
	}
	if b == nil {
		return shim.Success([]byte("false"))
	}
	return shim.Success([]byte("true"))
}

func (c *SmallBankChaincode) readAccount(stub shim.ChaincodeStubInterface, args []string) peer.Response {
	if len(args) != 1 {
		return shim.Error("ReadAccount expects 1 arg: id")
	}
	id := args[0]
	b, err := stub.GetState(accountKey(id))
	if err != nil {
		return shim.Error(err.Error())
	}
	if b == nil {
		return shim.Error(fmt.Sprintf("account not found: %s", id))
	}
	return shim.Success(b)
}

func (c *SmallBankChaincode) transfer(stub shim.ChaincodeStubInterface, args []string) peer.Response {
	if len(args) != 3 {
		return shim.Error("Transfer expects 3 args: from, to, amount")
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

	accts, err := loadAccounts(stub, []string{from, to})
	if err != nil {
		return shim.Error(err.Error())
	}

	fromAcct := accts[from]
	toAcct := accts[to]

	if fromAcct.Balance < amount {
		return shim.Error(fmt.Sprintf("insufficient funds: from=%s balance=%d amount=%d", from, fromAcct.Balance, amount))
	}

	fromAcct.Balance -= amount
	toAcct.Balance += amount

	if err := storeAccounts(stub, accts); err != nil {
		return shim.Error(err.Error())
	}

	return shim.Success(nil)
}

func (c *SmallBankChaincode) trade(stub shim.ChaincodeStubInterface, args []string) peer.Response {
	if len(args) != 3 {
		return shim.Error("Trade expects 3 args: from, to, amount")
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

	fromKey := shareKey(from)
	toKey := shareKey(to)

	fromBytes, err := stub.GetState(fromKey)
	if err != nil {
		return shim.Error(err.Error())
	}
	toBytes, err := stub.GetState(toKey)
	if err != nil {
		return shim.Error(err.Error())
	}
	if fromBytes == nil || toBytes == nil {
		return shim.Error("share account not found")
	}

	fromShares, err := strconv.ParseInt(string(fromBytes), 10, 64)
	if err != nil {
		return shim.Error("invalid share balance encoding")
	}
	toShares, err := strconv.ParseInt(string(toBytes), 10, 64)
	if err != nil {
		return shim.Error("invalid share balance encoding")
	}

	if fromShares < amount {
		return shim.Error(fmt.Sprintf("insufficient shares: from=%s balance=%d amount=%d", from, fromShares, amount))
	}

	fromShares -= amount
	toShares += amount

	if err := stub.PutState(fromKey, []byte(strconv.FormatInt(fromShares, 10))); err != nil {
		return shim.Error(err.Error())
	}
	if err := stub.PutState(toKey, []byte(strconv.FormatInt(toShares, 10))); err != nil {
		return shim.Error(err.Error())
	}

	return shim.Success(nil)
}

func (c *SmallBankChaincode) accountTxn(stub shim.ChaincodeStubInterface, args []string) peer.Response {
	if len(args) != 2 {
		return shim.Error("AccountTxn expects 2 args: id, delta")
	}

	id := args[0]
	deltaStr := args[1]
	if id == "" {
		return shim.Error("id must be non-empty")
	}

	delta, err := strconv.ParseInt(deltaStr, 10, 64)
	if err != nil {
		return shim.Error(fmt.Sprintf("invalid delta: %s", deltaStr))
	}

	key := bookKey(id)
	b, err := stub.GetState(key)
	if err != nil {
		return shim.Error(err.Error())
	}
	if b == nil {
		// Allow creating new book entries on demand.
		b = []byte("0")
	}

	cur, err := strconv.ParseInt(string(b), 10, 64)
	if err != nil {
		return shim.Error("invalid book value encoding")
	}

	next := cur + delta
	if err := stub.PutState(key, []byte(strconv.FormatInt(next, 10))); err != nil {
		return shim.Error(err.Error())
	}

	return shim.Success(nil)
}

func (c *SmallBankChaincode) batchTransfer(stub shim.ChaincodeStubInterface, args []string) peer.Response {
	if len(args) != 1 {
		return shim.Error("BatchTransfer expects 1 arg: transfersJson")
	}

	var transfers []Transfer
	if err := json.Unmarshal([]byte(args[0]), &transfers); err != nil {
		return shim.Error(fmt.Sprintf("invalid transfersJson: %v", err))
	}

	if len(transfers) == 0 {
		return shim.Success(nil)
	}

	keysSet := make(map[string]struct{})
	for _, t := range transfers {
		if t.From == "" || t.To == "" {
			return shim.Error("transfer from/to must be non-empty")
		}
		if t.From == t.To {
			return shim.Error("transfer from/to must be different")
		}
		if t.Amount <= 0 {
			return shim.Error("transfer amount must be > 0")
		}
		keysSet[t.From] = struct{}{}
		keysSet[t.To] = struct{}{}
	}

	ids := make([]string, 0, len(keysSet))
	for id := range keysSet {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	accts, err := loadAccounts(stub, ids)
	if err != nil {
		return shim.Error(err.Error())
	}

	for _, t := range transfers {
		fromAcct := accts[t.From]
		toAcct := accts[t.To]
		if fromAcct.Balance < t.Amount {
			return shim.Error(fmt.Sprintf("insufficient funds: from=%s balance=%d amount=%d", t.From, fromAcct.Balance, t.Amount))
		}
		fromAcct.Balance -= t.Amount
		toAcct.Balance += t.Amount
	}

	if err := storeAccounts(stub, accts); err != nil {
		return shim.Error(err.Error())
	}

	return shim.Success(nil)
}

func (c *SmallBankChaincode) applyDeltas(stub shim.ChaincodeStubInterface, args []string) peer.Response {
	if len(args) != 1 {
		return shim.Error("ApplyDeltas expects 1 arg: deltasJson")
	}

	deltas := make(map[string]int64)
	if err := json.Unmarshal([]byte(args[0]), &deltas); err != nil {
		return shim.Error(fmt.Sprintf("invalid deltasJson: %v", err))
	}

	if len(deltas) == 0 {
		return shim.Success(nil)
	}

	ids := make([]string, 0, len(deltas))
	for id := range deltas {
		if id == "" {
			return shim.Error("account id must be non-empty")
		}
		ids = append(ids, id)
	}
	sort.Strings(ids)

	accts, err := loadAccounts(stub, ids)
	if err != nil {
		return shim.Error(err.Error())
	}

	for _, id := range ids {
		delta := deltas[id]
		acct := accts[id]
		newBalance := acct.Balance + delta
		if newBalance < 0 {
			return shim.Error(fmt.Sprintf("negative balance after delta: id=%s balance=%d delta=%d", id, acct.Balance, delta))
		}
		acct.Balance = newBalance
	}

	if err := storeAccounts(stub, accts); err != nil {
		return shim.Error(err.Error())
	}

	return shim.Success(nil)
}

func loadAccounts(stub shim.ChaincodeStubInterface, ids []string) (map[string]*Account, error) {
	accts := make(map[string]*Account, len(ids))
	for _, id := range ids {
		b, err := stub.GetState(accountKey(id))
		if err != nil {
			return nil, err
		}
		if b == nil {
			return nil, fmt.Errorf("account not found: %s", id)
		}
		var acct Account
		if err := json.Unmarshal(b, &acct); err != nil {
			return nil, err
		}
		accts[id] = &acct
	}
	return accts, nil
}

func storeAccounts(stub shim.ChaincodeStubInterface, accts map[string]*Account) error {
	ids := make([]string, 0, len(accts))
	for id := range accts {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	for _, id := range ids {
		acct := accts[id]
		b, err := json.Marshal(acct)
		if err != nil {
			return err
		}
		if err := stub.PutState(accountKey(id), b); err != nil {
			return err
		}
	}
	return nil
}
