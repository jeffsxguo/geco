#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

COMPOSE_FILE="${ROOT_DIR}/docker-compose.yaml"
ARTIFACTS_DIR="${ROOT_DIR}/artifacts"
CHANNEL_ARTIFACTS_DIR="${ARTIFACTS_DIR}/channel-artifacts"
CRYPTO_DIR="${ARTIFACTS_DIR}/crypto-config"

FABRIC_TAG="${FABRIC_TAG:-2.5}"
CHANNEL_NAME="${CHANNEL_NAME:-mychannel}"
CHAINCODE_NAME="${CHAINCODE_NAME:-smallbank}"
CHAINCODE_LABEL="${CHAINCODE_LABEL:-smallbank_1.0}"
CHAINCODE_VERSION="${CHAINCODE_VERSION:-1.0}"
CHAINCODE_SEQUENCE="${CHAINCODE_SEQUENCE:-1}"

function compose() {
  docker compose -f "${COMPOSE_FILE}" "$@"
}

function require_docker() {
  command -v docker >/dev/null 2>&1 || { echo "docker not found"; exit 1; }
  docker compose version >/dev/null 2>&1 || { echo "docker compose not available"; exit 1; }
}

function ensure_dirs() {
  mkdir -p "${CHANNEL_ARTIFACTS_DIR}"
}

function rm_artifacts_as_docker_root() {
  if [[ ! -d "${ARTIFACTS_DIR}" ]]; then
    return 0
  fi

  docker run --rm \
    -v "${ROOT_DIR}:/work" \
    -w /work \
    "hyperledger/fabric-tools:${FABRIC_TAG}" \
    bash -lc "rm -rf /work/artifacts"
}

function generate() {
  require_docker
  ensure_dirs

  if compose ps -q >/dev/null 2>&1; then
    local running
    running="$(compose ps -q 2>/dev/null | wc -l | tr -d ' ')"
    if [[ "${running}" != "0" ]]; then
      echo "Warning: Fabric containers appear to be running."
      echo "If you regenerate crypto/materials while containers are running, TLS handshakes can fail."
      echo "Recommended: ./network.sh down && ./network.sh up after generate."
    fi
  fi

  rm_artifacts_as_docker_root
  mkdir -p "${CHANNEL_ARTIFACTS_DIR}"

  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "${ROOT_DIR}:/work" \
    -w /work \
    "hyperledger/fabric-tools:${FABRIC_TAG}" \
    cryptogen generate --config=/work/config/crypto-config.yaml --output=/work/artifacts/crypto-config

  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "${ROOT_DIR}:/work" \
    -w /work \
    -e FABRIC_CFG_PATH=/work/configtx \
    "hyperledger/fabric-tools:${FABRIC_TAG}" \
    configtxgen -profile OneOrgOrdererGenesis -channelID system-channel -outputBlock /work/artifacts/channel-artifacts/genesis.block

  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "${ROOT_DIR}:/work" \
    -w /work \
    -e FABRIC_CFG_PATH=/work/configtx \
    "hyperledger/fabric-tools:${FABRIC_TAG}" \
    configtxgen -profile OneOrgChannel -outputCreateChannelTx "/work/artifacts/channel-artifacts/${CHANNEL_NAME}.tx" -channelID "${CHANNEL_NAME}"

  echo "Generated:"
  echo "- ${CRYPTO_DIR}"
  echo "- ${CHANNEL_ARTIFACTS_DIR}/genesis.block"
  echo "- ${CHANNEL_ARTIFACTS_DIR}/${CHANNEL_NAME}.tx"
}

function up() {
  require_docker
  if [[ ! -f "${CHANNEL_ARTIFACTS_DIR}/genesis.block" ]]; then
    echo "Missing genesis.block; run: ./network.sh generate"
    exit 1
  fi
  if [[ "${FORCE_RECREATE:-0}" == "1" ]]; then
    compose up -d --force-recreate orderer.example.com peer0.org1.example.com
  else
    compose up -d orderer.example.com peer0.org1.example.com
  fi
}

function down() {
  require_docker
  compose down -v --remove-orphans
}

function clean() {
  down || true
  rm_artifacts_as_docker_root
  echo "Removed ${ARTIFACTS_DIR} (if it existed)"
}

function create_channel() {
  require_docker
  compose up -d --force-recreate cli

  local orderer_ca="/etc/hyperledger/fabric/crypto-config/ordererOrganizations/example.com/orderers/orderer.example.com/tls/ca.crt"
  local channel_block="/tmp/${CHANNEL_NAME}.block"

  compose exec -T cli bash -lc \
    "peer channel create \
      -o orderer.example.com:7050 \
      --ordererTLSHostnameOverride orderer.example.com \
      -c ${CHANNEL_NAME} \
      -f /etc/hyperledger/fabric/channel-artifacts/${CHANNEL_NAME}.tx \
      --outputBlock ${channel_block} \
      --tls --cafile ${orderer_ca}"

  compose exec -T cli bash -lc \
    "peer channel join -b ${channel_block}"

  echo "Channel ready: ${CHANNEL_NAME}"
}

function deploy_smallbank() {
  require_docker
  compose up -d --force-recreate cli

  local orderer_ca="/etc/hyperledger/fabric/crypto-config/ordererOrganizations/example.com/orderers/orderer.example.com/tls/ca.crt"
  local peer_tls_root="/etc/hyperledger/fabric/crypto-config/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt"
  local package_path="/tmp/${CHAINCODE_NAME}.tar.gz"
  local ccaas_dir="/tmp/${CHAINCODE_NAME}.ccaas"
  local sequence="${CHAINCODE_SEQUENCE}"

  compose exec -T cli bash -lc \
    "set -euo pipefail
     rm -f ${package_path}
     rm -rf \"${ccaas_dir}\" && mkdir -p \"${ccaas_dir}\"
     cat > \"${ccaas_dir}/connection.json\" <<'JSON'
{
  \"address\": \"smallbank-ccaas:9999\",
  \"dial_timeout\": \"10s\",
  \"tls_required\": false
}
JSON
     cat > \"${ccaas_dir}/metadata.json\" <<'JSON'
{
  \"type\": \"ccaas\",
  \"label\": \"${CHAINCODE_LABEL}\"
}
JSON
     (cd \"${ccaas_dir}\" && tar -czf code.tar.gz connection.json)
     (cd \"${ccaas_dir}\" && tar -czf ${package_path} metadata.json code.tar.gz)"

  compose exec -T cli bash -lc \
    "peer lifecycle chaincode install ${package_path}"

  local package_id
  package_id="$(compose exec -T cli bash -lc "peer lifecycle chaincode queryinstalled | sed -n 's/^Package ID: \\(.*\\), Label: ${CHAINCODE_LABEL}$/\\1/p' | head -n1")"
  if [[ -z "${package_id}" ]]; then
    echo "Failed to determine package_id (queryinstalled did not match label ${CHAINCODE_LABEL})"
    exit 1
  fi

  # Auto-bump sequence if the chaincode is already committed on this channel.
  local committed_seq
  committed_seq="$(compose exec -T cli bash -lc "peer lifecycle chaincode querycommitted -C ${CHANNEL_NAME} -n ${CHAINCODE_NAME} 2>/dev/null | sed -n 's/.*Sequence: \\([0-9]\\+\\).*/\\1/p' | head -n1" || true)"
  if [[ -n "${committed_seq}" ]]; then
    sequence="$((committed_seq + 1))"
  fi

  compose exec -T cli bash -lc \
    "peer lifecycle chaincode approveformyorg \
      -o orderer.example.com:7050 \
      --ordererTLSHostnameOverride orderer.example.com \
      --channelID ${CHANNEL_NAME} \
      --name ${CHAINCODE_NAME} \
      --version ${CHAINCODE_VERSION} \
      --package-id ${package_id} \
      --sequence ${sequence} \
      --tls --cafile ${orderer_ca}"

  compose exec -T cli bash -lc \
    "peer lifecycle chaincode commit \
      -o orderer.example.com:7050 \
      --ordererTLSHostnameOverride orderer.example.com \
      --channelID ${CHANNEL_NAME} \
      --name ${CHAINCODE_NAME} \
      --version ${CHAINCODE_VERSION} \
      --sequence ${sequence} \
      --peerAddresses peer0.org1.example.com:7051 \
      --tlsRootCertFiles ${peer_tls_root} \
      --tls --cafile ${orderer_ca}"

  # Start the external chaincode service container with the computed package ID.
  echo "SMALLBANK_CCID=${package_id}" > "${ROOT_DIR}/.env"
  compose up -d --build smallbank-ccaas

  echo "Chaincode deployed:"
  echo "- channel=${CHANNEL_NAME}"
  echo "- name=${CHAINCODE_NAME}"
  echo "- label=${CHAINCODE_LABEL}"
}

function print_admin_key() {
  local key_dir="${CRYPTO_DIR}/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp/keystore"
  if [[ ! -d "${key_dir}" ]]; then
    echo "Missing ${key_dir}. Run: ./network.sh generate"
    exit 1
  fi
  local key_file
  key_file="$(ls -1 "${key_dir}" 2>/dev/null | head -n1 || true)"
  if [[ -z "${key_file}" ]]; then
    echo "No key found under ${key_dir}"
    exit 1
  fi
  echo "${key_dir}/${key_file}"
}

cmd="${1:-}"
case "${cmd}" in
  generate) generate ;;
  up) up ;;
  down) down ;;
  clean) clean ;;
  create-channel) create_channel ;;
  deploy-smallbank) deploy_smallbank ;;
  print-admin-key) print_admin_key ;;
  *)
    cat <<EOF
Usage: ./network.sh <command>

Commands:
  generate          Generate crypto + channel artifacts
  up                Start orderer + peer
  create-channel    Create channel and join peer
  deploy-smallbank  Deploy chaincode/smallbank-go as "${CHAINCODE_NAME}"
  print-admin-key   Print cryptogen-generated admin private key path
  down              Stop and remove containers/volumes
  clean             Also remove generated artifacts/

Env vars (optional):
  FABRIC_TAG=${FABRIC_TAG}
  CHANNEL_NAME=${CHANNEL_NAME}
  CHAINCODE_NAME=${CHAINCODE_NAME}
EOF
    exit 1
    ;;
esac
