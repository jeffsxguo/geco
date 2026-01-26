const fs = require('node:fs');
const crypto = require('node:crypto');

const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');

function newGrpcConnection({ peerEndpoint, tlsCertPath, peerHostAlias }) {
  const tlsRootCert = fs.readFileSync(tlsCertPath);
  const tlsCredentials = grpc.credentials.createSsl(tlsRootCert);

  const options = {};
  if (peerHostAlias && peerHostAlias.trim().length > 0) {
    options['grpc.ssl_target_name_override'] = peerHostAlias;
    options['grpc.default_authority'] = peerHostAlias;
  }

  // For ciphertext-heavy workloads, Fabric gateway responses (endorsement payloads / RW sets)
  // can exceed gRPC's default max message size (4 MiB).
  //
  // Set `GECO_GRPC_MAX_MSG_BYTES` to bump both send/receive limits.
  // Example: export GECO_GRPC_MAX_MSG_BYTES=$((128*1024*1024))
  const maxMsgBytes = Number(process.env.GECO_GRPC_MAX_MSG_BYTES ?? 0);
  if (Number.isFinite(maxMsgBytes) && maxMsgBytes > 0) {
    options['grpc.max_receive_message_length'] = maxMsgBytes;
    options['grpc.max_send_message_length'] = maxMsgBytes;
  }

  return new grpc.Client(peerEndpoint, tlsCredentials, options);
}

function newIdentity({ mspId, certPath }) {
  return {
    mspId,
    credentials: fs.readFileSync(certPath)
  };
}

function newSigner({ keyPath }) {
  const privateKeyPem = fs.readFileSync(keyPath);
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  return signers.newPrivateKeySigner(privateKey);
}

async function connectFabricGateway(fabricConfig, timeouts) {
  const client = newGrpcConnection(fabricConfig);
  const identity = newIdentity(fabricConfig);
  const signer = newSigner(fabricConfig);

  const gateway = connect({
    client,
    identity,
    signer,
    evaluateOptions: () => ({ deadline: Date.now() + (timeouts?.evaluateTimeoutMs ?? 15000) }),
    endorseOptions: () => ({ deadline: Date.now() + (timeouts?.endorseTimeoutMs ?? 15000) }),
    submitOptions: () => ({ deadline: Date.now() + (timeouts?.submitTimeoutMs ?? 15000) }),
    commitStatusOptions: () => ({ deadline: Date.now() + (timeouts?.commitStatusTimeoutMs ?? 15000) })
  });

  const network = gateway.getNetwork(fabricConfig.channelName);
  const contract = network.getContract(fabricConfig.chaincodeName);

  return {
    client,
    gateway,
    network,
    contract,
    close: async () => {
      gateway.close();
      client.close();
    }
  };
}

module.exports = { connectFabricGateway };
